"""生命周期 worker（SAV-011/§9.2）。
到期 → access-revoked + 撤销下载能力；purge 物理删除；orphan sweep 清理无引用 staging 对象。"""

import sqlite3
import time

from .config import get_settings
from .db import connect, init_schema
from .storage import Storage


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def purge_expired(conn: sqlite3.Connection, storage: Storage, now: str | None = None) -> int:
    """到期或 access-revoked 到期的照片：标 access-revoked → 物理删除 → purged。"""
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
        conn.execute(
            "UPDATE photo_records SET status='purging', purge_started_at=? WHERE id=?",
            (now, row["id"]),
        )
        conn.execute(
            "UPDATE download_grants SET consumed_at=COALESCE(consumed_at, ?) "
            "WHERE photo_id=? AND consumed_at IS NULL",
            (now, row["id"]),
        )
        conn.execute(
            "UPDATE key_registry SET state='retired', photo_id=NULL WHERE photo_id=?", (row["id"],)
        )
        storage.delete(row["object_key"])
        conn.execute(
            "UPDATE photo_records SET status='purged', purged_at=? WHERE id=?",
            (now, row["id"]),
        )
        purged += 1
    conn.commit()
    return purged


def sweep_orphans(conn: sqlite3.Connection, storage: Storage) -> int:
    """删除无数据库引用的 staging 对象（§8.2 15 分钟兜底）。"""
    rows = conn.execute("SELECT object_key FROM photo_records").fetchall()
    known = {r["object_key"] for r in rows}
    return storage.sweep_orphans(known)


def run_once() -> int:
    cfg = get_settings()
    init_schema(cfg.db_path)
    conn = connect(cfg.db_path)
    storage = Storage()
    try:
        purged = purge_expired(conn, storage)
        swept = sweep_orphans(conn, storage)
        return purged + swept
    finally:
        conn.close()


if __name__ == "__main__":  # 供 cron/systemd timer 调用
    print(f"purged+swept: {run_once()}")
