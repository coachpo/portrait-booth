"""Lifecycle worker (SAV-011/§9.2).
Expiry → access-revoked + download capability revoked; purge does physical
deletion; orphan sweep removes unreferenced staging objects.

Scheduling: runs as a background task inside the API process (see the lifespan
in main.py).
Previously this module only had a __main__ entry, while the Dockerfile CMD
ran only uvicorn and compose had no second service - the cleanup logic was
written but never executed: expired photos were never revoked, clicking
delete only marked them, and the original bytes on disk stayed until TTL.
"""

import asyncio
import contextlib
import os
import sqlite3
import time

from .config import get_settings
from .db import connect, init_schema
from .save_service import purge_expired_idempotency
from .storage import Storage


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def purge_expired(conn: sqlite3.Connection, storage: Storage, now: str | None = None) -> int:
    """Photos past expiry or access-revoked expiry: mark access-revoked →
    physically delete → purged."""
    now = now or _now()
    conn.execute(
        "UPDATE photo_records SET status='access-revoked', "
        "access_revoked_at=COALESCE(access_revoked_at, ?), "
        "revocation_epoch=revocation_epoch+1 WHERE status='active' AND expires_at <= ?",
        (now, now),
    )
    rows = conn.execute(
        "SELECT id, object_key FROM photo_records "
        "WHERE status IN ('access-revoked','purging') AND expires_at <= ?",
        (now,),
    ).fetchall()
    purged = 0
    for row in rows:
        purge_photo(conn, storage, row["id"], row["object_key"], now)
        purged += 1
    conn.commit()
    return purged


def purge_due(conn: sqlite3.Connection, storage: Storage, now: str | None = None) -> int:
    """Photos awaiting cleanup after user-initiated delete (purge_due_at reached)."""
    now = now or _now()
    rows = conn.execute(
        "SELECT id, object_key FROM photo_records "
        "WHERE status IN ('access-revoked','purging') AND purge_due_at IS NOT NULL "
        "AND purge_due_at <= ?",
        (now,),
    ).fetchall()
    for row in rows:
        purge_photo(conn, storage, row["id"], row["object_key"], now)
    conn.commit()
    return len(rows)


def purge_photo(
    conn: sqlite3.Connection,
    storage: Storage,
    photo_id: str,
    object_key: str,
    now: str,
) -> None:
    """Revoke download capability → retire KEY → physically delete bytes → mark
    purged."""
    conn.execute(
        "UPDATE photo_records SET status='purging', purge_started_at=? WHERE id=?",
        (now, photo_id),
    )
    conn.execute(
        "UPDATE download_grants SET consumed_at=COALESCE(consumed_at, ?) "
        "WHERE photo_id=? AND consumed_at IS NULL",
        (now, photo_id),
    )
    conn.execute(
        "UPDATE key_registry SET state='retired', photo_id=NULL WHERE photo_id=?", (photo_id,)
    )
    storage.delete(object_key)
    conn.execute(
        "UPDATE photo_records SET status='purged', purged_at=? WHERE id=?",
        (now, photo_id),
    )


def sweep_orphans(
    conn: sqlite3.Connection,
    storage: Storage,
    min_age_seconds: float | None = None,
) -> int:
    """Delete staging objects with no database reference (§8.2). Defaults to a
    15-minute age gate."""
    if min_age_seconds is None:
        min_age_seconds = get_settings().orphan_min_age_seconds
    rows = conn.execute("SELECT object_key FROM photo_records").fetchall()
    known = {r["object_key"] for r in rows}
    return storage.sweep_orphans(known, min_age_seconds=min_age_seconds)


def purge_consumed_grants(conn: sqlite3.Connection, now: str | None = None) -> int:
    """Delete consumed or expired download grants (SPEC:740: at most 60 seconds
    or deleted after first atomic consumption).

    retrievals.py returns exactly the same response for "row missing" and
    "consumed", so physical deletion is externally unobservable.
    """
    now = now or _now()
    cur = conn.execute(
        "DELETE FROM download_grants WHERE consumed_at IS NOT NULL OR expires_at <= ?",
        (now,),
    )
    conn.commit()
    return cur.rowcount


def purge_purged_photo_records(conn: sqlite3.Connection) -> int:
    """Delete photo metadata rows whose bytes are confirmed physically cleared
    (SPEC:738: delete associated records after clear confirmation).

    Deletes only status='purged' rows: purge_photo calls storage.delete first
    and sets purged only when it did not raise, so a row reaching purged means
    the bytes are no longer on disk; sweep_orphans treats the full
    photo_records.object_key set as known references, and deleting
    'purging'/'access-revoked' rows would orphan objects still on disk.
    key_registry retired rows are an audit requirement (SPEC:739) and are
    never deleted.
    """
    cur = conn.execute("DELETE FROM photo_records WHERE status='purged' AND purged_at IS NOT NULL")
    conn.commit()
    return cur.rowcount


def run_once() -> int:
    cfg = get_settings()
    init_schema(cfg.db_path)
    conn = connect(cfg.db_path)
    storage = Storage()
    try:
        purged = purge_expired(conn, storage)
        purged += purge_due(conn, storage)
        swept = sweep_orphans(conn, storage)
        # The three record cleanups must run after the photo cleanup: the
        # earlier purge_photo is a multi-statement sequence committed as one,
        # and inserting in the middle would commit half a purge early (ticket 5)
        purge_expired_idempotency(conn, time.time(), cfg.idempotency_window_seconds)
        purge_consumed_grants(conn)
        purge_purged_photo_records(conn)
        return purged + swept
    finally:
        conn.close()


def inline_worker_enabled() -> bool:
    """In-process scheduling switch. Set PORTRAIT_DISABLE_INLINE_WORKER=1 when
    deploying a standalone worker."""
    return os.environ.get("PORTRAIT_DISABLE_INLINE_WORKER", "").strip() not in {"1", "true"}


async def run_periodically(interval_seconds: float | None = None) -> None:
    """Cleanup loop running inside the API process. Exits quietly on cancel."""
    interval = interval_seconds or get_settings().purge_interval_seconds
    while True:
        try:
            await asyncio.to_thread(run_once)
        except asyncio.CancelledError:
            raise
        except Exception:
            # A cleanup failure must not take down the API process; retry next
            # round
            pass
        await asyncio.sleep(interval)


@contextlib.asynccontextmanager
async def lifecycle_worker():
    """Host the cleanup loop inside the FastAPI lifespan."""
    if not inline_worker_enabled():
        yield
        return
    task = asyncio.create_task(run_periodically())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


if __name__ == "__main__":  # For cron/systemd timer invocations
    print(f"purged+swept: {run_once()}")
