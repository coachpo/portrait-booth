"""暂存服务（SPEC §6.2/§7）。
原子提交边界：对象写入（staging）→ KEY/secret 生成 → 单事务内完成
KeyRegistry + PhotoRecord(active) + SaveIdempotencyRecord(completed + 加密 envelope)。
envelope 用服务端密钥 AES-GCM 加密；仅同一匿名会话 + 幂等键可重放。"""

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
from .image_validate import ImageValidationError, validate_and_reencode
from .keygen import generate_key, generate_secret, key_display, normalize_key
from .storage import Storage
from .template_store import load_template_catalog


def _envelope_fernet(settings: Settings) -> Fernet:
    import os

    raw = os.environ.get("PORTRAIT_ENVELOPE_KEY", "")
    if not raw:
        raw = Fernet.generate_key().decode("ascii")
        os.environ["PORTRAIT_ENVELOPE_KEY"] = raw
    return Fernet(raw.encode("ascii"))


class SaveError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


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

    row = conn.execute(
        "SELECT status, request_digest, photo_id, encrypted_response_envelope "
        "FROM save_idempotency_records WHERE anonymous_save_session_digest=? AND "
        "idempotency_key_digest=?",
        (session_d, idem_d),
    ).fetchone()
    if row is not None:
        if row["request_digest"] is not None and row["request_digest"] != req_d:
            raise SaveError("IDEMPOTENCY_CONFLICT", "同一幂等键携带了不同内容", 409)
        if row["status"] == "completed" and row["encrypted_response_envelope"]:
            try:
                envelope = json.loads(
                    _envelope_fernet(cfg).decrypt(row["encrypted_response_envelope"].encode())
                )
                return _save_result_from_envelope(envelope)
            except InvalidToken:
                raise SaveError("IDEMPOTENCY_UNAVAILABLE", "响应 envelope 不可解密", 409) from None
        raise SaveError("SAVE_PROCESSING", "保存仍在处理中，请重试", 409)

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
    target_size = _output_size(rev)
    try:
        encoded = validate_and_reencode(
            photo_bytes,
            max_bytes=rev["outputFile"]["sizeLimit"]["maxBytes"]
            if rev.get("outputFile") and rev["outputFile"].get("sizeLimit")
            else None,
            max_pixels=cfg.max_pixels,
            max_edge_px=cfg.max_edge_px,
            target_width=target_size[0],
            target_height=target_size[1],
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
            "photo": {"width": target_size[0], "height": target_size[1], "mime": "image/jpeg"},
        }
        encrypted = _envelope_fernet(cfg).encrypt(json.dumps(envelope).encode()).decode()

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
                target_size[0],
                target_size[1],
                len(encoded),
                hmac_utils.object_integrity_mac(object_name, len(encoded)),
                "active",
                time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_ts)),
                expires_at,
            ),
        )
        conn.execute(
            "UPDATE key_registry SET state='active', photo_id=? WHERE key_fingerprint=?",
            (photo_id, fingerprint),
        )
        conn.execute(
            "INSERT INTO save_idempotency_records(anonymous_save_session_digest, "
            "idempotency_key_digest, "
            "request_digest, status, photo_id, encrypted_response_envelope, "
            "created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (
                session_d,
                idem_d,
                req_d,
                "completed",
                photo_id,
                encrypted,
                time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_ts)),
                time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_ts)),
            ),
        )
        conn.commit()
    except BaseException:
        conn.rollback()
        storage.delete(object_name)
        raise

    return _save_result_from_envelope(envelope)


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


def _output_size(rev) -> tuple[int, int]:
    out = rev["output"]
    if out["kind"] == "exact_pixels":
        return out["widthPx"], out["heightPx"]
    if out["kind"] == "ranged_pixels":
        return out["defaultWidthPx"], out["defaultHeightPx"]
    if out["kind"] == "physical_raster":
        return out["widthPx"], out["heightPx"]
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
