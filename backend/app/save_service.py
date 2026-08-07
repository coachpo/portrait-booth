"""Staging service (SPEC §6.2/§7).
Atomic commit boundary: object write (staging) → KEY/secret generation → within a
single transaction: KeyRegistry + PhotoRecord(active) + SaveIdempotencyRecord
(completed + encrypted envelope).
The envelope is AES-GCM encrypted with a server key; only the same anonymous
session + idempotency key can replay it."""

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
    """The envelope key is derived from the root secret: no per-process randomness,
    and old envelopes stay decryptable after a restart."""
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
        # The lease must be released, otherwise the same idempotency key stays
        # locked until the lease expires and every retry hits 409
        _mark_failed(conn, session_d, idem_d, now_ts)
        raise


def _decrypt_envelope(encrypted: str | None) -> SaveResult:
    if not encrypted:
        raise SaveError("IDEMPOTENCY_UNAVAILABLE", "response envelope missing", 409)
    try:
        return _save_result_from_envelope(
            json.loads(_envelope_fernet().decrypt(encrypted.encode()))
        )
    except InvalidToken:
        raise SaveError(
            "IDEMPOTENCY_UNAVAILABLE", "response envelope cannot be decrypted", 409
        ) from None


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
    # Template: pinned immutable version + current publication must be active
    # (TMP-004 / §6.1)
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
        raise SaveError(
            "TEMPLATE_UNAVAILABLE", "template version does not exist or is unavailable", 404
        )
    if entry.publication["status"] != "active":
        raise SaveError("TEMPLATE_UNAVAILABLE", "template version is not active", 404)
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

    # Write the staging object (before the transaction; crash leftovers are
    # cleaned by the orphan sweep)
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
        # The lease was already written by _acquire_lease; move it to completed
        # here. upsert (O5): background cleanup may have deleted the lease row
        # (created_at is not refreshed), so a plain UPDATE would match 0 rows - a
        # completed save must leave a replayable completed record, otherwise a
        # same-key retry would create another photo and KEY.
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
    """Hold this save (§6.2/§11).

    SELECT-then-decide is the classic check-then-act: two concurrent requests
    both read "no record", then both run the full save flow, producing two
    photos and two KEYs; the second commit then hits the primary key and
    returns 500.
    This instead grabs the slot with a primary-key INSERT first, letting the
    database decide who wins.
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
    if row is None:  # Narrow race: the record was just cleaned up; retry
        raise SaveError(
            "SAVE_PROCESSING", "save still in progress, please retry", 409, retry_after=1
        )

    if row["request_digest"] is not None and row["request_digest"] != req_d:
        raise SaveError(
            "IDEMPOTENCY_CONFLICT", "same idempotency key carried different content", 409
        )

    if row["status"] == "completed":
        raise _ReplayCompleted(row["encrypted_response_envelope"])

    if row["status"] == "processing":
        held_for = now_ts - _parse_iso(row["updated_at"])
        if held_for < cfg.idempotency_lease_seconds:
            raise SaveError(
                "IDEMPOTENCY_IN_PROGRESS",
                "the previous save with this idempotency key is still in progress, "
                "please retry later",
                409,
                retry_after=max(1, int(cfg.idempotency_lease_seconds - held_for)),
            )

    # failed or lease expired: take over this save
    conn.execute(
        "UPDATE save_idempotency_records SET status='processing', request_digest=?, updated_at=? "
        "WHERE anonymous_save_session_digest=? AND idempotency_key_digest=?",
        (req_d, now_iso, session_d, idem_d),
    )
    conn.commit()


class _ReplayCompleted(Exception):
    """Internal signal: this request hit a completed idempotency record."""

    def __init__(self, envelope: str | None):
        super().__init__("replay")
        self.envelope = envelope


def _parse_iso(value: str) -> float:
    """Timestamps are always parsed as UTC.

    mktime minus time.timezone is off by a full hour in DST zones, making every
    lease look already expired - concurrency protection becomes meaningless and
    duplicate submissions each create a photo.
    """
    return calendar.timegm(time.strptime(value, "%Y-%m-%dT%H:%M:%SZ"))


def _mark_failed(conn: sqlite3.Connection, session_d: str, idem_d: str, now_ts: float) -> None:
    """Make a failed lease immediately retryable instead of locking the
    idempotency key until the lease expires."""
    with contextlib.suppress(sqlite3.Error):
        # The failure path may leave uncommitted writes; roll back first, then
        # flip the lease state
        conn.rollback()
        conn.execute(
            "UPDATE save_idempotency_records SET status='failed', updated_at=? "
            "WHERE anonymous_save_session_digest=? AND idempotency_key_digest=? "
            "AND status='processing'",
            (_iso(now_ts), session_d, idem_d),
        )
        conn.commit()


def purge_expired_idempotency(conn: sqlite3.Connection, now_ts: float, window: int) -> int:
    """Clean up expired idempotency records (§6.2).

    The envelope holds the plaintext KEY and the delete-secret ciphertext;
    keeping it forever equals making them replayable indefinitely.
    """
    cutoff = _iso(now_ts - window)
    cursor = conn.execute(
        "DELETE FROM save_idempotency_records WHERE created_at <= ? AND updated_at <= ?",
        (cutoff, cutoff),
    )
    conn.commit()
    return cursor.rowcount


def _reserve_key(conn: sqlite3.Connection, rng=None, settings: Settings | None = None) -> str:
    """SAV-003/005: allocation and mapping in the same transaction; resample on
    collision."""
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
    raise SaveError("KEY_EXHAUSTED", "KEY allocation failed, please retry", 503)


def _size_constraint(rev) -> SizeConstraint:
    """Template output size constraint (P6): the exact and ranged families."""
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
    raise SaveError("TEMPLATE_UNAVAILABLE", "template has no local render size", 404)


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
        raise SaveError("PHOTO_UNAVAILABLE", "photo unavailable", 404) from None
