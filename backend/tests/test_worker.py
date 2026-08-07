"""Lifecycle worker scheduling contract (A13/B3).

Regression background: cleanup logic lived in worker.py, but the Dockerfile
CMD ran only uvicorn and compose had no second service, so
`if __name__ == "__main__"` never fired - expired photos were never revoked
or cleared, and clicking delete only marked them.
"""

import asyncio
import time

import pytest

from app import worker
from app.config import get_settings
from app.db import connect, init_schema


class TestInlineWorkerSwitch:
    def test_enabled_by_default(self, monkeypatch):
        monkeypatch.delenv("PORTRAIT_DISABLE_INLINE_WORKER", raising=False)
        assert worker.inline_worker_enabled() is True

    @pytest.mark.parametrize("value", ["1", "true"])
    def test_can_be_disabled_for_a_standalone_deployment(self, monkeypatch, value):
        monkeypatch.setenv("PORTRAIT_DISABLE_INLINE_WORKER", value)
        assert worker.inline_worker_enabled() is False


class TestLifecycleWorker:
    def test_runs_cleanup_while_the_app_is_up(self, monkeypatch):
        calls: list[int] = []
        monkeypatch.setattr(worker, "run_once", lambda: calls.append(1))

        async def scenario():
            async with worker.lifecycle_worker():
                await asyncio.sleep(0.05)

        asyncio.run(scenario())
        assert calls, "the cleanup loop must actually run once the app is up"

    def test_does_nothing_when_disabled(self, monkeypatch):
        calls: list[int] = []
        monkeypatch.setattr(worker, "run_once", lambda: calls.append(1))
        monkeypatch.setenv("PORTRAIT_DISABLE_INLINE_WORKER", "1")

        async def scenario():
            async with worker.lifecycle_worker():
                await asyncio.sleep(0.05)

        asyncio.run(scenario())
        assert calls == []

    def test_a_failing_sweep_does_not_take_down_the_loop(self, monkeypatch):
        calls: list[int] = []

        def boom():
            calls.append(1)
            raise RuntimeError("disk temporarily unavailable")

        monkeypatch.setattr(worker, "run_once", boom)

        async def scenario():
            async with worker.lifecycle_worker():
                await asyncio.sleep(0.05)

        asyncio.run(scenario())  # must not raise
        assert calls

    def test_stops_when_the_app_shuts_down(self, monkeypatch):
        monkeypatch.setattr(worker, "run_once", lambda: None)
        finished: list[str] = []

        async def scenario():
            async with worker.lifecycle_worker():
                await asyncio.sleep(0.01)
            finished.append("clean")

        asyncio.run(scenario())
        assert finished == ["clean"]


class TestRunOnceCleanup:
    """First end-to-end execution of run_once(): the three record classes are
    deleted by the cleanup loop (O5)."""

    def test_run_once_purges_expired_idempotency_records(self):
        init_schema(get_settings().db_path)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        conn = connect(get_settings().db_path)
        conn.execute(
            "INSERT INTO save_idempotency_records("
            "anonymous_save_session_digest, idempotency_key_digest, request_digest, "
            "status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
            (
                "old-session",
                "old-key",
                None,
                "completed",
                "2020-01-01T00:00:00Z",
                "2020-01-01T00:00:00Z",
            ),
        )
        conn.execute(
            "INSERT INTO save_idempotency_records("
            "anonymous_save_session_digest, idempotency_key_digest, request_digest, "
            "status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
            ("new-session", "new-key", None, "processing", now, now),
        )
        conn.commit()
        conn.close()

        worker.run_once()

        conn = connect(get_settings().db_path)
        try:
            left = conn.execute(
                "SELECT anonymous_save_session_digest FROM save_idempotency_records"
            ).fetchall()
        finally:
            conn.close()
        assert [r["anonymous_save_session_digest"] for r in left] == ["new-session"]

    def test_run_once_purges_consumed_and_expired_grants(self):
        init_schema(get_settings().db_path)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        conn = connect(get_settings().db_path)
        # A consumed; B unconsumed but expired; C unconsumed and unexpired
        for token, consumed, expires in (
            ("token-a", now, now),
            ("token-b", None, "2020-01-01T00:00:00Z"),
            ("token-c", None, "2099-01-01T00:00:00Z"),
        ):
            conn.execute(
                "INSERT INTO download_grants(token_digest, token_digest_version, photo_id, "
                "purpose, revocation_epoch, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?)",
                (token, 1, "ph-1", "download", 0, expires, consumed),
            )
        conn.commit()
        conn.close()

        worker.run_once()

        conn = connect(get_settings().db_path)
        try:
            left = conn.execute("SELECT token_digest FROM download_grants").fetchall()
        finally:
            conn.close()
        assert [r["token_digest"] for r in left] == ["token-c"]

    def test_run_once_purges_purged_photo_records_but_keeps_revoked(self):
        init_schema(get_settings().db_path)
        conn = connect(get_settings().db_path)
        # purged row: key_registry already retired (photo_id=NULL), purged_at
        # non-null
        conn.execute(
            "INSERT INTO key_registry(key_fingerprint, state, issued_at, photo_id) "
            "VALUES (?,?,?,?)",
            ("fp-purged", "retired", "2026-01-01T00:00:00Z", None),
        )
        # access-revoked row: expires_at in the future and purge_due_at empty,
        # otherwise the purge_expired/purge_due steps above would advance it to
        # purged first
        conn.execute(
            "INSERT INTO key_registry(key_fingerprint, state, issued_at, photo_id) "
            "VALUES (?,?,?,?)",
            ("fp-revoked", "active", "2026-01-01T00:00:00Z", "ph-revoked"),
        )
        for photo_id, fp, status, expires, purged_at in (
            ("ph-purged", "fp-purged", "purged", "2020-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
            ("ph-revoked", "fp-revoked", "access-revoked", "2099-01-01T00:00:00Z", None),
        ):
            conn.execute(
                "INSERT INTO photo_records(id, key_fingerprint, retrieval_mode, "
                "security_policy_version, delete_digest, delete_digest_version, object_key, "
                "template_id, template_version, template_revision_id, template_content_hash, "
                "mime, width_px, height_px, byte_length, object_integrity_mac, status, "
                "revocation_epoch, created_at, expires_at, purge_due_at, purged_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    photo_id,
                    fp,
                    "key_only_ephemeral",
                    1,
                    "digest",
                    1,
                    f"obj-{photo_id}",
                    "fi-police-digital",
                    1,
                    "fi@1",
                    "hash",
                    "image/jpeg",
                    500,
                    653,
                    1000,
                    "mac",
                    status,
                    0,
                    "2026-01-01T00:00:00Z",
                    expires,
                    None,
                    purged_at,
                ),
            )
        conn.commit()
        conn.close()

        worker.run_once()

        conn = connect(get_settings().db_path)
        try:
            left = conn.execute("SELECT id FROM photo_records").fetchall()
            retired = conn.execute(
                "SELECT COUNT(*) AS n FROM key_registry WHERE state='retired'"
            ).fetchone()["n"]
        finally:
            conn.close()
        assert [r["id"] for r in left] == ["ph-revoked"]
        assert retired == 1
