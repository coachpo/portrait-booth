"""SPEC §6.3: resolve retrieval and download. Unified PHOTO_UNAVAILABLE 404;
download tokens consumed atomically."""

import hmac
import sqlite3
import time
import uuid

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse, Response

from .. import hmac_utils
from ..config import get_settings
from ..db import connect, init_schema
from ..http_utils import same_origin_violation
from ..keygen import normalize_key, random_token
from ..rate_limit import RateLimiter
from ..storage import Storage

router = APIRouter(prefix="/api/v1/retrievals")


def _db() -> sqlite3.Connection:
    init_schema(get_settings().db_path)
    return connect(get_settings().db_path)


def _request_id() -> str:
    return uuid.uuid4().hex


def _unavailable(request_id: str) -> JSONResponse:
    resp = JSONResponse(
        status_code=404,
        content={
            "error": {
                "code": "PHOTO_UNAVAILABLE",
                "message": "photo unavailable; the KEY/access credential may be "
                "invalid, expired, or deleted.",
                "requestId": request_id,
            }
        },
    )
    resp.headers["Cache-Control"] = "no-store, private"
    return resp


@router.post("/resolve")
def resolve(request: Request, body: dict) -> JSONResponse:
    """§6.5: KEY missing/expired/deleted/inactive all yield 404 PHOTO_UNAVAILABLE;
    rate limited (§9.3)."""
    rejected = same_origin_violation(request)
    if rejected is not None:
        return rejected
    cfg = get_settings()
    conn = _db()
    request_id = _request_id()
    raw_key = body.get("key", "")
    client_ip = request.client.host if request.client else "unknown"

    limiter = RateLimiter(conn)
    if not limiter.check(
        "resolve-ip", client_ip, cfg.resolve_ip_window_seconds, cfg.resolve_ip_limit
    ):
        return _unavailable(request_id)

    try:
        normalized = normalize_key(raw_key)
    except ValueError:
        # Invalid format is also treated as unavailable and counted against the
        # failure rate limit
        limiter.check(
            "resolve-fail",
            hmac_utils.rate_fingerprint("k", raw_key[:8]),
            cfg.resolve_fail_window_seconds,
            cfg.resolve_fail_limit,
        )
        return _unavailable(request_id)

    fp = hmac_utils.key_fingerprint(normalized)
    row = conn.execute(
        "SELECT p.id, p.status, p.expires_at, p.revocation_epoch, p.object_key, p.mime, "
        "p.width_px, p.height_px, p.byte_length, p.template_id, p.template_version "
        "FROM photo_records p JOIN key_registry k ON k.key_fingerprint = p.key_fingerprint "
        "WHERE k.key_fingerprint=? AND k.state='active'",
        (fp,),
    ).fetchone()

    now = time.gmtime()
    now_str = time.strftime("%Y-%m-%dT%H:%M:%SZ", now)
    if row is None or row["status"] != "active" or row["expires_at"] <= now_str:
        # Failure outcomes consume the failure quota: record missing / not active / expired
        limiter.check("resolve-fail", fp, cfg.resolve_fail_window_seconds, cfg.resolve_fail_limit)
        return _unavailable(request_id)

    # Gate: refuse issuance once the same KEY fingerprint has failed up to the
    # limit in this window; the success path never writes the failure bucket
    if limiter.peek("resolve-fail", fp, cfg.resolve_fail_window_seconds) >= cfg.resolve_fail_limit:
        return _unavailable(request_id)

    token = random_token()
    token_expires = time.strftime(
        "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + cfg.download_token_ttl_seconds)
    )
    conn.execute(
        "INSERT INTO download_grants(token_digest, token_digest_version, photo_id, purpose, "
        "revocation_epoch, expires_at) VALUES (?,1,?,?,?,?)",
        (
            hmac_utils.token_digest(token),
            row["id"],
            "download",
            row["revocation_epoch"],
            token_expires,
        ),
    )
    conn.commit()

    resp = JSONResponse(
        content={
            # The digest must report the real size: the retrieve page needs to
            # tell the user which photo this is before downloading
            "photo": {
                "width": row["width_px"],
                "height": row["height_px"],
                "mime": row["mime"],
                "byteLength": row["byte_length"],
                "expiresAt": row["expires_at"],
            },
            "template": {"id": row["template_id"], "version": row["template_version"]},
            "downloadToken": token,
            "tokenExpiresAt": token_expires,
        }
    )
    resp.headers["Cache-Control"] = "no-store, private"
    return resp


@router.post("/download")
def download(request: Request, authorization: str | None = Header(default=None)) -> Response:
    """§6.3: Bearer token consumed atomically; re-check the photo is active,
    unexpired, and revocationEpoch matches."""
    conn = _db()
    if not authorization or not authorization.startswith("Bearer "):
        return _unavailable(_request_id())
    token = authorization[len("Bearer ") :]
    digest = hmac_utils.token_digest(token)

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    row = conn.execute(
        "SELECT g.photo_id, g.revocation_epoch, g.expires_at, g.consumed_at "
        "FROM download_grants g WHERE g.token_digest=?",
        (digest,),
    ).fetchone()
    if row is None or row["consumed_at"] is not None or row["expires_at"] <= now:
        return _unavailable(_request_id())

    photo = conn.execute(
        "SELECT p.status, p.expires_at, p.revocation_epoch, p.object_key, p.mime, p.byte_length, "
        "p.object_integrity_mac FROM photo_records p WHERE p.id=?",
        (row["photo_id"],),
    ).fetchone()
    if (
        photo is None
        or photo["status"] != "active"
        or photo["expires_at"] <= now
        or photo["revocation_epoch"] != row["revocation_epoch"]
    ):
        return _unavailable(_request_id())

    # Atomic consumption: put "unconsumed" in the WHERE clause and let the
    # database decide who wins.
    # SELECT-then-unconditional-UPDATE is check-then-act: two concurrent
    # requests both pass the checks above and both get the same photo, making
    # the single-use credential effectively reusable.
    cursor = conn.execute(
        "UPDATE download_grants SET consumed_at=? WHERE token_digest=? AND consumed_at IS NULL",
        (now, digest),
    )
    conn.commit()
    if cursor.rowcount != 1:
        return _unavailable(_request_id())

    data = Storage().read(photo["object_key"])
    if data is None or len(data) != photo["byte_length"]:
        return _unavailable(_request_id())

    # §8.2 object integrity: the MAC must actually be verified after writing,
    # otherwise this layer of protection is meaningless.
    # Comparing only the object name and length is also insufficient - an
    # equal-length swap is invisible, so the MAC binds the content digest.
    expected_mac = hmac_utils.object_integrity_mac(
        photo["object_key"], len(data), hmac_utils.sha256_hex(data)
    )
    if not hmac.compare_digest(expected_mac, photo["object_integrity_mac"]):
        return _unavailable(_request_id())

    resp = Response(content=data, media_type=photo["mime"])
    resp.headers["Content-Length"] = str(len(data))
    resp.headers["Content-Disposition"] = 'attachment; filename="portrait-photo.jpg"'
    resp.headers["Cache-Control"] = "no-store, private"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    return resp
