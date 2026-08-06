"""暂存服务（SPEC §6.2/§7）。
原子提交边界：对象写入（staging）→ KEY/secret 生成 → 单事务内完成
KeyRegistry + PhotoRecord(active) + SaveIdempotencyRecord(completed + 加密 envelope)。
envelope 用服务端密钥 AES-GCM 加密；仅同一匿名会话 + 幂等键可重放。"""

import calendar
import contextlib
import json
import sqlite3
import time
from collections.abc import Callable
from dataclasses import dataclass

from cryptography.fernet import Fernet, InvalidToken

from . import hmac_utils
from .config import Settings, get_settings
from .hmac_utils import (
    idempotency_key_digest,
    key_fingerprint,
    request_digest,
    secret_digest,
    session_digest,
)
from .image_validate import (
    ImageValidationError,
    SizeConstraint,
    validate_and_reencode,
)
from .keygen import generate_key, generate_secret, key_display, normalize_key
from .storage import Storage
from .template_store import load_template_catalog


def _envelope_fernet() -> Fernet:
    """envelope 密钥由根密钥派生：不再每进程随机，重启后旧 envelope 仍可解密。"""
    return Fernet(hmac_utils.envelope_key())


class SaveError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, retry_after: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.retry_after = retry_after


@dataclass
class SaveResult:
    key: str
    key_display: str
    delete_secret: str
    expires_at: str
    template_id: str
    template_version: int
    width: int
    height: int
    byte_length: int


def save_photo(
    *,
    conn: sqlite3.Connection,
    storage: Storage,
    photo_bytes: bytes,
    template_id: str,
    template_version: int,
    anonymous_session_id: str,
    idempotency_key: str,
    rng: Callable[[int], int] | None = None,
    settings: Settings | None = None,
    now: float | None = None,
    catalog=None,
) -> SaveResult:
    cfg = settings or get_settings()
    now_ts = now if now is not None else time.time()
    session_d = session_digest(anonymous_session_id)
    idem_d = idempotency_key_digest(idempotency_key)
    req_d = request_digest(photo_bytes, template_id, template_version)

    try:
        _acquire_lease(conn, session_d, idem_d, req_d, now_ts, cfg)
    except _ReplayCompleted as replay:
        return _decrypt_envelope(replay.envelope)

    try:
        return _do_save(
            conn=conn,
            storage=storage,
            photo_bytes=photo_bytes,
            template_id=template_id,
            template_version=template_version,
            session_d=session_d,
            idem_d=idem_d,
            req_d=req_d,
            rng=rng,
            cfg=cfg,
            now_ts=now_ts,
            catalog=catalog,
        )
    except BaseException:
        # 租约必须释放，否则同一幂等键会被锁到租约到期，重试全部撞 409
        _mark_failed(conn, session_d, idem_d, now_ts)
        raise


def _decrypt_envelope(encrypted: str | None) -> SaveResult:
    if not encrypted:
        raise SaveError("IDEMPOTENCY_UNAVAILABLE", "响应 envelope 缺失", 409)
    try:
        return _save_result_from_envelope(
            json.loads(_envelope_fernet().decrypt(encrypted.encode()))
        )
    except InvalidToken:
        raise SaveError("IDEMPOTENCY_UNAVAILABLE", "响应 envelope 不可解密", 409) from None


def _do_save(
    *,
    conn: sqlite3.Connection,
    storage: Storage,
    photo_bytes: bytes,
    template_id: str,
    template_version: int,
    session_d: str,
    idem_d: str,
    req_d: str,
    rng: Callable[[int], int] | None,
    cfg: Settings,
    now_ts: float,
    catalog,
) -> SaveResult:
    # 模板：固定不可变版本 + 当前 publication 必须 active（TMP-004 / §6.1）
    catalog = catalog or load_template_catalog()
    entry = next(
        (
            e
            for e in catalog
            if e.revision["id"] == template_id and e.revision["version"] == template_version
        ),
        None,
    )
    if entry is None:
        raise SaveError("TEMPLATE_UNAVAILABLE", "模板版本不存在或不可用", 404)
    if entry.publication["status"] != "active":
        raise SaveError("TEMPLATE_UNAVAILABLE", "模板版本未激活", 404)
    rev = entry.revision

    target_ppi = rev["output"]["printPpi"] if rev["output"]["kind"] == "physical_raster" else None
    constraint = _size_constraint(rev)
    try:
        encoded, actual_width, actual_height = validate_and_reencode(
            photo_bytes,
            max_bytes=rev["outputFile"]["sizeLimit"].get("maxBytes")
            if rev.get("outputFile") and rev["outputFile"].get("sizeLimit")
            else None,
            max_pixels=cfg.max_pixels,
            max_edge_px=cfg.max_edge_px,
            constraint=constraint,
            target_ppi=target_ppi,
            settings=cfg,
        )
    except ImageValidationError as e:
        raise SaveError(e.code, str(e), 422) from e

    # 写入 staging 对象（事务前；崩溃残留由 orphan sweep 清理）
    object_name = storage.write(encoded)

    try:
        key = _reserve_key(conn, rng=rng, settings=cfg)
        delete_secret = generate_secret(rng=rng, settings=cfg)
        fingerprint = key_fingerprint(key)
        photo_id = f"ph-{int(now_ts * 1000):x}-{fingerprint[:12]}"
        expires_at = time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_ts + cfg.temporary_storage_ttl_seconds)
        )

        envelope = {
            "key": key,
            "keyDisplay": key_display(key),
            "deleteSecret": delete_secret,
            "expiresAt": expires_at,
            "template": {"id": template_id, "version": template_version},
            "photo": {
                "width": actual_width,
                "height": actual_height,
                "mime": "image/jpeg",
            },
        }
        encrypted = _envelope_fernet().encrypt(json.dumps(envelope).encode()).decode()

        conn.execute(
            "INSERT INTO photo_records(id, key_fingerprint, retrieval_mode, "
            "security_policy_version, "
            "delete_digest, delete_digest_version, object_key, template_id, template_version, "
            "template_revision_id, template_content_hash, mime, width_px, height_px, byte_length, "
            "object_integrity_mac, status, revocation_epoch, created_at, expires_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)",
            (
                photo_id,
                fingerprint,
                "key_only_ephemeral",
                cfg.security_policy_version,
                secret_digest(delete_secret),
                1,
                object_name,
                template_id,
                template_version,
                entry.revision["revisionId"],
                entry.contentHash,
                "image/jpeg",
                actual_width,
                actual_height,
                len(encoded),
                hmac_utils.object_integrity_mac(
                    object_name, len(encoded), hmac_utils.sha256_hex(encoded)
                ),
                "active",
                time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_ts)),
                expires_at,
            ),
        )
        conn.execute(
            "UPDATE key_registry SET state='active', photo_id=? WHERE key_fingerprint=?",
            (photo_id, fingerprint),
        )
        # 租约在 _acquire_lease 里已经写好了，这里把它推进到 completed。
        # upsert（O5）：后台清理可能已把租约行删掉（created_at 不刷新），普通
        # UPDATE 会匹配 0 行——完成的保存必须留下可重放的 completed 记录，
        # 否则同键重试会再建一张照片和一个 KEY。
        conn.execute(
            "INSERT INTO save_idempotency_records("
            "anonymous_save_session_digest, idempotency_key_digest, request_digest, "
            "status, photo_id, encrypted_response_envelope, created_at, updated_at) "
            "VALUES (?,?,?,'completed',?,?,?,?) "
            "ON CONFLICT(anonymous_save_session_digest, idempotency_key_digest) "
            "DO UPDATE SET status='completed', photo_id=excluded.photo_id, "
            "encrypted_response_envelope=excluded.encrypted_response_envelope, "
            "request_digest=excluded.request_digest, updated_at=excluded.updated_at",
            (session_d, idem_d, req_d, photo_id, encrypted, _iso(now_ts), _iso(now_ts)),
        )
        conn.commit()
    except BaseException:
        conn.rollback()
        storage.delete(object_name)
        raise

    return _save_result_from_envelope(envelope)


def _iso(ts: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def _acquire_lease(
    conn: sqlite3.Connection,
    session_d: str,
    idem_d: str,
    req_d: str,
    now_ts: float,
    cfg: Settings,
) -> None:
    """占住这次保存（§6.2/§11）。

    先 SELECT 再决定要不要写，是典型的 check-then-act：
    两个并发请求都会读到「没有记录」，然后各自跑完整个保存流程，
    结果是两份照片、两个 KEY，第二次提交撞主键后返回 500。
    这里改成先用主键 INSERT 抢占，由数据库裁决谁赢。
    """
    now_iso = _iso(now_ts)
    try:
        conn.execute(
            "INSERT INTO save_idempotency_records(anonymous_save_session_digest, "
            "idempotency_key_digest, request_digest, status, created_at, updated_at) "
            "VALUES (?,?,?,'processing',?,?)",
            (session_d, idem_d, req_d, now_iso, now_iso),
        )
        conn.commit()
        return
    except sqlite3.IntegrityError:
        conn.rollback()

    row = conn.execute(
        "SELECT status, request_digest, encrypted_response_envelope, updated_at "
        "FROM save_idempotency_records WHERE anonymous_save_session_digest=? AND "
        "idempotency_key_digest=?",
        (session_d, idem_d),
    ).fetchone()
    if row is None:  # 极窄的竞态：记录刚被清理掉，重试即可
        raise SaveError("SAVE_PROCESSING", "保存仍在处理中，请重试", 409, retry_after=1)

    if row["request_digest"] is not None and row["request_digest"] != req_d:
        raise SaveError("IDEMPOTENCY_CONFLICT", "同一幂等键携带了不同内容", 409)

    if row["status"] == "completed":
        raise _ReplayCompleted(row["encrypted_response_envelope"])

    if row["status"] == "processing":
        held_for = now_ts - _parse_iso(row["updated_at"])
        if held_for < cfg.idempotency_lease_seconds:
            raise SaveError(
                "IDEMPOTENCY_IN_PROGRESS",
                "同一幂等键的上一次保存仍在处理中，请稍后重试",
                409,
                retry_after=max(1, int(cfg.idempotency_lease_seconds - held_for)),
            )

    # failed 或租约过期：接管这次保存
    conn.execute(
        "UPDATE save_idempotency_records SET status='processing', request_digest=?, updated_at=? "
        "WHERE anonymous_save_session_digest=? AND idempotency_key_digest=?",
        (req_d, now_iso, session_d, idem_d),
    )
    conn.commit()


class _ReplayCompleted(Exception):
    """内部信号：这次请求命中了已完成的幂等记录。"""

    def __init__(self, envelope: str | None):
        super().__init__("replay")
        self.envelope = envelope


def _parse_iso(value: str) -> float:
    """时间戳一律按 UTC 解析。

    用 mktime 减 time.timezone 在有夏令时的时区会差整整一小时，
    结果是每个租约看起来都已经过期——并发保护形同虚设，重复提交会各建一张照片。
    """
    return calendar.timegm(time.strptime(value, "%Y-%m-%dT%H:%M:%SZ"))


def _mark_failed(conn: sqlite3.Connection, session_d: str, idem_d: str, now_ts: float) -> None:
    """让失败的租约立刻可被重试，而不是把幂等键锁死到租约到期。"""
    with contextlib.suppress(sqlite3.Error):
        # 失败路径可能留下未提交的写，先回滚再改租约状态
        conn.rollback()
        conn.execute(
            "UPDATE save_idempotency_records SET status='failed', updated_at=? "
            "WHERE anonymous_save_session_digest=? AND idempotency_key_digest=? "
            "AND status='processing'",
            (_iso(now_ts), session_d, idem_d),
        )
        conn.commit()


def purge_expired_idempotency(conn: sqlite3.Connection, now_ts: float, window: int) -> int:
    """清理过期的幂等记录（§6.2）。

    envelope 里是明文 KEY 与删除密钥的密文，长期保留等于让它们无限期可重放。
    """
    cutoff = _iso(now_ts - window)
    cursor = conn.execute(
        "DELETE FROM save_idempotency_records WHERE created_at <= ? AND updated_at <= ?",
        (cutoff, cutoff),
    )
    conn.commit()
    return cursor.rowcount


def _reserve_key(conn: sqlite3.Connection, rng=None, settings: Settings | None = None) -> str:
    """SAV-003/005：分配与建图同一事务；碰撞时重新采样。"""
    cfg = settings or get_settings()
    for _ in range(50):
        key = generate_key(rng=rng, settings=cfg)
        fp = key_fingerprint(key)
        try:
            conn.execute(
                "INSERT INTO key_registry(key_fingerprint, state, issued_at) VALUES (?,?,?)",
                (fp, "reserved", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
            )
            return key
        except sqlite3.IntegrityError:
            continue
    raise SaveError("KEY_EXHAUSTED", "KEY 分配失败，请重试", 503)


def _size_constraint(rev) -> SizeConstraint:
    """模板输出尺寸约束（P6）：exact 与 ranged 两族。"""
    out = rev["output"]
    if out["kind"] == "ranged_pixels":
        allowed = out.get("allowedSizes")
        return SizeConstraint(
            exact=None,
            bounds=(
                out["minWidthPx"],
                out["minHeightPx"],
                out["maxWidthPx"],
                out["maxHeightPx"],
            ),
            aspect=(out["aspect"]["width"], out["aspect"]["height"]),
            allowed=([(s["widthPx"], s["heightPx"]) for s in allowed] if allowed else None),
        )
    if out["kind"] in ("exact_pixels", "physical_raster"):
        return SizeConstraint(
            exact=(out["widthPx"], out["heightPx"]),
            bounds=None,
            aspect=None,
            allowed=None,
        )
    raise SaveError("TEMPLATE_UNAVAILABLE", "模板无本地渲染尺寸", 404)


def _save_result_from_envelope(envelope: dict) -> SaveResult:
    return SaveResult(
        key=envelope["key"],
        key_display=envelope["keyDisplay"],
        delete_secret=envelope["deleteSecret"],
        expires_at=envelope["expiresAt"],
        template_id=envelope["template"]["id"],
        template_version=envelope["template"]["version"],
        width=envelope["photo"]["width"],
        height=envelope["photo"]["height"],
        byte_length=0,
    )


def normalize_key_or_raise(raw: str) -> str:
    try:
        return normalize_key(raw)
    except ValueError:
        raise SaveError("PHOTO_UNAVAILABLE", "照片不可用", 404) from None
