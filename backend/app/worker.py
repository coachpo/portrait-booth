"""生命周期 worker（SAV-011/§9.2）。
到期 → access-revoked + 撤销下载能力；purge 物理删除；orphan sweep 清理无引用 staging 对象。

调度方式：随 API 进程内的后台任务运行（见 main.py 的 lifespan）。
之前这个模块只有 __main__ 入口，而 Dockerfile 的 CMD 只有 uvicorn、compose 也没有第二个服务——
清理逻辑写好了却从不执行：到期照片永远不被撤销，用户点了删除也只是标记，
磁盘上的原件继续留到 TTL 结束。
"""

import asyncio
import contextlib
import os
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
        purge_photo(conn, storage, row["id"], row["object_key"], now)
        purged += 1
    conn.commit()
    return purged


def purge_due(conn: sqlite3.Connection, storage: Storage, now: str | None = None) -> int:
    """用户主动删除后待清理的照片（purge_due_at 已到）。"""
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
    """撤销下载能力 → 退役 KEY → 物理删除字节 → 标 purged。"""
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
    """删除无数据库引用的 staging 对象（§8.2）。默认带 15 分钟年龄门限。"""
    if min_age_seconds is None:
        min_age_seconds = get_settings().orphan_min_age_seconds
    rows = conn.execute("SELECT object_key FROM photo_records").fetchall()
    known = {r["object_key"] for r in rows}
    return storage.sweep_orphans(known, min_age_seconds=min_age_seconds)


def run_once() -> int:
    cfg = get_settings()
    init_schema(cfg.db_path)
    conn = connect(cfg.db_path)
    storage = Storage()
    try:
        purged = purge_expired(conn, storage)
        purged += purge_due(conn, storage)
        swept = sweep_orphans(conn, storage)
        return purged + swept
    finally:
        conn.close()


def inline_worker_enabled() -> bool:
    """进程内调度开关。独立部署 worker 时设 PORTRAIT_DISABLE_INLINE_WORKER=1。"""
    return os.environ.get("PORTRAIT_DISABLE_INLINE_WORKER", "").strip() not in {"1", "true"}


async def run_periodically(interval_seconds: float | None = None) -> None:
    """随 API 进程运行的清理循环。取消时安静退出。"""
    interval = interval_seconds or get_settings().purge_interval_seconds
    while True:
        try:
            await asyncio.to_thread(run_once)
        except asyncio.CancelledError:
            raise
        except Exception:
            # 清理失败不能拖垮 API 进程；下一轮重试
            pass
        await asyncio.sleep(interval)


@contextlib.asynccontextmanager
async def lifecycle_worker():
    """在 FastAPI lifespan 中托管清理循环。"""
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


if __name__ == "__main__":  # 供 cron/systemd timer 调用
    print(f"purged+swept: {run_once()}")
