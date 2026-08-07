"""API contract hardening (B1/B2/B5/B6)."""

import io
import json
import threading

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import get_settings
from app.db import connect
from app.storage import Storage


@pytest.fixture()
def client():
    from app.main import app

    return TestClient(app)


def make_jpeg(width=500, height=653, quality=92) -> bytes:
    img = Image.new("RGB", (width, height), (60, 120, 200))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def new_session(client) -> str:
    session = client.post("/api/v1/save-sessions")
    assert session.status_code == 204
    return session.cookies["pb_save_session"]


def post_save(client, cookie: str, idem: str, photo: bytes | None = None):
    return client.post(
        "/api/v1/saves",
        files={"photo": ("p.jpg", photo or make_jpeg(), "image/jpeg")},
        data={"templateId": "fi-police-digital", "templateVersion": 1},
        headers={"Idempotency-Key": idem},
        cookies={"pb_save_session": cookie},
    )


def save_once(client, idem="contract-key-000000001", cookie: str | None = None) -> dict:
    """The idempotency scope is (anonymous session × idempotency key): replays
    must use the same session cookie."""
    resp = post_save(client, cookie or new_session(client), idem)
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestDownloadTokenIsAtomic:
    def test_concurrent_downloads_consume_the_token_once(self, client):
        """Regression: SELECT-then-unconditional-UPDATE is check-then-act; both
        concurrent requests pass the check and the single-use credential
        becomes effectively reusable."""
        body = save_once(client)
        token = client.post("/api/v1/retrievals/resolve", json={"key": body["key"]}).json()[
            "downloadToken"
        ]

        results: list[int] = []
        lock = threading.Lock()

        def download():
            resp = client.post(
                "/api/v1/retrievals/download", headers={"Authorization": f"Bearer {token}"}
            )
            with lock:
                results.append(resp.status_code)

        threads = [threading.Thread(target=download) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert results.count(200) == 1, (
            f"the single-use credential was consumed {results.count(200)} times"
        )
        assert results.count(404) == len(results) - 1

    def test_sequential_second_download_is_rejected(self, client):
        body = save_once(client)
        token = client.post("/api/v1/retrievals/resolve", json={"key": body["key"]}).json()[
            "downloadToken"
        ]
        headers = {"Authorization": f"Bearer {token}"}
        assert client.post("/api/v1/retrievals/download", headers=headers).status_code == 200
        assert client.post("/api/v1/retrievals/download", headers=headers).status_code == 404


class TestIdempotencyLease:
    def test_replay_returns_the_same_envelope(self, client):
        cookie = new_session(client)
        first = save_once(client, "lease-key-00000000001", cookie)
        second = save_once(client, "lease-key-00000000001", cookie)
        assert first == second

    def test_in_progress_lease_answers_409_with_retry_after(self, client):
        """A concurrent save must be 409 + Retry-After, not two full runs
        colliding on the primary key and returning 500."""
        cookie = new_session(client)
        assert save_once(client, "lease-key-00000000002", cookie)["key"]

        # Manually flip the lease back to processing to simulate another
        # request holding it
        conn = connect(get_settings().db_path)
        try:
            conn.execute(
                "UPDATE save_idempotency_records SET status='processing', "
                "encrypted_response_envelope=NULL"
            )
            conn.commit()
        finally:
            conn.close()

        resp = post_save(client, cookie, "lease-key-00000000002")
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "IDEMPOTENCY_IN_PROGRESS"
        assert int(resp.headers["Retry-After"]) >= 1

    def test_a_failed_attempt_releases_the_lease(self, client):
        """A failure must release the lease, otherwise the user cannot even
        retry before the lease expires."""
        cookie = new_session(client)
        bad_photo = make_jpeg(100, 100)
        first = post_save(client, cookie, "lease-key-00000000003", bad_photo)
        assert first.status_code == 422

        conn = connect(get_settings().db_path)
        try:
            row = conn.execute("SELECT status FROM save_idempotency_records").fetchone()
        finally:
            conn.close()
        assert row["status"] == "failed", (
            "a failed lease left in processing would lock the idempotency key"
        )

        # Retry with the same content: the real reason comes back instead of
        # 409 IDEMPOTENCY_IN_PROGRESS
        retry = post_save(client, cookie, "lease-key-00000000003", bad_photo)
        assert retry.status_code == 422
        assert retry.json()["error"]["code"] == "PHOTO_SIZE_MISMATCH"

    def test_changing_the_payload_under_one_key_is_a_conflict(self, client):
        """The idempotency key binds content: changing the photo is no longer
        the same save."""
        cookie = new_session(client)
        assert post_save(client, cookie, "lease-key-00000000006").status_code == 201
        resp = post_save(client, cookie, "lease-key-00000000006", make_jpeg(quality=60))
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"

    def test_only_one_photo_survives_a_concurrent_double_submit(self, client):
        cookie = new_session(client)
        photo = make_jpeg()
        statuses: list[int] = []
        lock = threading.Lock()

        def submit():
            resp = post_save(client, cookie, "lease-key-00000000004", photo)
            with lock:
                statuses.append(resp.status_code)

        threads = [threading.Thread(target=submit) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert 500 not in statuses, f"concurrent duplicate submits must not produce 500: {statuses}"
        conn = connect(get_settings().db_path)
        try:
            count = conn.execute("SELECT COUNT(*) AS n FROM photo_records").fetchone()["n"]
        finally:
            conn.close()
        assert count == 1, f"the same idempotency key must produce exactly one photo, got {count}"

    def test_expired_records_are_purged(self, client):
        from app.save_service import purge_expired_idempotency

        save_once(client, "lease-key-00000000005")
        conn = connect(get_settings().db_path)
        try:
            # The envelope holds the plaintext KEY and the delete-secret
            # ciphertext; keeping it forever equals replaying it indefinitely
            removed = purge_expired_idempotency(conn, now_ts=2_000_000_000, window=600)
            assert removed == 1
            left = conn.execute("SELECT COUNT(*) AS n FROM save_idempotency_records").fetchone()
            assert left["n"] == 0
        finally:
            conn.close()

    def test_lease_row_purged_mid_save_still_replays_once(self, client, monkeypatch):
        """O5: after a background cleanup deletes the lease row, a completed
        save still leaves a replayable completed record."""
        import app.save_service as save_service

        real = save_service.validate_and_reencode

        def hook(data, **kwargs):
            result = real(data, **kwargs)
            # Simulate the cleanup loop deleting the lease row while the save
            # is in progress (_acquire_lease already committed)
            conn = connect(get_settings().db_path)
            conn.execute("DELETE FROM save_idempotency_records")
            conn.commit()
            conn.close()
            return result

        monkeypatch.setattr(save_service, "validate_and_reencode", hook)
        cookie = new_session(client)
        first = post_save(client, cookie, "o5-lease-key-0000000001")
        assert first.status_code == 201, first.text
        replay = post_save(client, cookie, "o5-lease-key-0000000001")
        assert replay.status_code == 201, replay.text
        conn = connect(get_settings().db_path)
        try:
            count = conn.execute("SELECT COUNT(*) AS n FROM photo_records").fetchone()["n"]
            completed = conn.execute(
                "SELECT COUNT(*) AS n FROM save_idempotency_records WHERE status='completed'"
            ).fetchone()["n"]
        finally:
            conn.close()
        assert count == 1, "same-key replay must not create a second photo"
        assert completed == 1


class TestSameOrigin:
    def test_rejects_a_cross_origin_save_session(self, client):
        resp = client.post(
            "/api/v1/save-sessions",
            headers={"Origin": "https://evil.example", "Host": "testserver"},
        )
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "CROSS_ORIGIN_REJECTED"

    def test_rejects_a_cross_site_browser_request_without_origin(self, client):
        """Origin alone is not enough: same-site-navigation-style cross-site
        submissions can omit Origin entirely."""
        resp = client.post(
            "/api/v1/retrievals/resolve",
            json={"key": "ZZZZZZ"},
            headers={"Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "cross-site"},
        )
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "CROSS_ORIGIN_REJECTED"

    def test_allows_a_same_origin_browser_request(self, client):
        resp = client.post(
            "/api/v1/save-sessions",
            headers={"Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin"},
        )
        assert resp.status_code == 204

    def test_allows_non_browser_clients(self, client):
        # Clients like curl have no Sec-Fetch-* and must not be collateral damage
        assert client.post("/api/v1/save-sessions").status_code == 204


class TestErrorContract:
    def test_validation_errors_use_the_error_envelope(self, client):
        session = client.post("/api/v1/save-sessions")
        resp = client.post(
            "/api/v1/saves",
            data={"templateVersion": "not-an-int"},
            headers={"Idempotency-Key": "contract-key-000000009"},
            cookies={"pb_save_session": session.cookies["pb_save_session"]},
        )
        assert resp.status_code == 422
        body = resp.json()
        assert "detail" not in body
        assert body["error"]["code"] == "VALIDATION_FAILED"
        assert body["error"]["requestId"]

    def test_every_error_carries_a_request_id(self, client):
        resp = client.post("/api/v1/retrievals/resolve", json={"key": "ZZZZZZ"})
        assert resp.status_code == 404
        assert len(resp.json()["error"]["requestId"]) >= 8

    def test_request_ids_are_unique_per_response(self, client):
        ids = {
            client.post("/api/v1/retrievals/resolve", json={"key": "ZZZZZZ"}).json()["error"][
                "requestId"
            ]
            for _ in range(3)
        }
        assert len(ids) == 3


class TestObjectIntegrity:
    def test_download_rejects_bytes_that_do_not_match_the_record(self, client):
        """Regression: objectIntegrityMac bound only name and length and was
        never verified after writing."""
        body = save_once(client, "contract-key-000000010")
        conn = connect(get_settings().db_path)
        try:
            row = conn.execute("SELECT object_key, byte_length FROM photo_records").fetchone()
        finally:
            conn.close()

        storage = Storage()
        original = storage.read(row["object_key"])
        assert original is not None
        # Equal-length swap: the length check cannot see it
        (storage.base / row["object_key"]).write_bytes(b"\x00" * len(original))

        token = client.post("/api/v1/retrievals/resolve", json={"key": body["key"]}).json()[
            "downloadToken"
        ]
        resp = client.post(
            "/api/v1/retrievals/download", headers={"Authorization": f"Bearer {token}"}
        )
        assert resp.status_code == 404
        assert json.loads(resp.content)["error"]["code"] == "PHOTO_UNAVAILABLE"


class TestDeleteReportsFailureHonestly:
    """Regression: the whole delete_save was swallowed into a 204 by
    except Exception.

    When the revocation transaction did not commit, the endpoint still
    reported success: the UI said "deleted" while the photo stayed active and
    retrievable.
    """

    @staticmethod
    def _delete(client, body):
        return client.request(
            "DELETE",
            "/api/v1/saves",
            content=json.dumps({"key": body["key"], "deleteSecret": body["deleteSecret"]}),
            headers={"Content-Type": "application/json"},
        )

    def test_a_failed_revocation_is_not_reported_as_success(self, client, monkeypatch):
        import sqlite3

        from app.routers import saves as saves_router

        body = save_once(client, "contract-key-000000011")
        real_db = saves_router._db

        class LockedConn:
            """Simulate the revocation UPDATE hitting a write lock."""

            def __init__(self, inner):
                self._inner = inner

            def execute(self, sql, *args, **kwargs):
                if "access-revoked" in sql:
                    raise sqlite3.OperationalError("database is locked")
                return self._inner.execute(sql, *args, **kwargs)

            def __getattr__(self, name):
                return getattr(self._inner, name)

        # Use context instead of undo(): the conftest environment isolation
        # shares the same monkeypatch instance, and undo() would also revoke
        # the root secret key
        with monkeypatch.context() as m:
            m.setattr(saves_router, "_db", lambda: LockedConn(real_db()))
            resp = self._delete(client, body)
        assert resp.status_code == 503
        assert resp.json()["error"]["code"] == "DELETE_UNAVAILABLE"

        # The photo really is still there - so reporting failure is correct
        assert (
            client.post("/api/v1/retrievals/resolve", json={"key": body["key"]}).status_code == 200
        )

    def test_a_failed_byte_purge_still_counts_as_deleted(self, client, monkeypatch):
        """After the revocation has committed, a physical-delete failure must
        not take back "deleted" - the photo is already unretrievable, and the
        worker's purge_due completes the byte cleanup."""
        from app.routers import saves as saves_router

        body = save_once(client, "contract-key-000000012")

        def boom(*_args, **_kwargs):
            raise OSError("volume unavailable")

        with monkeypatch.context() as m:
            m.setattr(saves_router, "purge_photo", boom)
            assert self._delete(client, body).status_code == 204

        resolved = client.post("/api/v1/retrievals/resolve", json={"key": body["key"]})
        assert resolved.status_code == 404
        assert resolved.json()["error"]["code"] == "PHOTO_UNAVAILABLE"

    def test_a_normal_delete_still_returns_204(self, client):
        body = save_once(client, "contract-key-000000013")
        assert self._delete(client, body).status_code == 204
        assert self._delete(client, body).status_code == 204
