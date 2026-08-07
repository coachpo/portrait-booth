"""SPEC §6.2/§6.4: staging and deletion."""

import hmac
import sqlite3
import time

from fastapi import APIRouter, Form, Header, Request, UploadFile
from fastapi.responses import JSONResponse, Response

from .. import hmac_utils
from ..config import get_settings
from ..db import connect, init_schema
from ..http_utils import error_response, new_request_id, same_origin_violation
from ..save_service import SaveError, save_photo
from ..storage import Storage
from ..worker import purge_photo

router = APIRouter(prefix="/api/v1/saves")


def _db() -> sqlite3.Connection:
    cfg = get_settings()
    init_schema(cfg.db_path)
    return connect(cfg.db_path)


def _storage() -> Storage:
    return Storage()


def _request_id() -> str:
    return new_request_id()


def _no_store(resp: Response) -> Response:
    resp.headers["Cache-Control"] = "no-store, private"
    return resp


@router.post("")
async def create_save(
    request: Request,
    photo: UploadFile,
    templateId: str = Form(...),
    templateVersion: int = Form(...),
    idempotency_key: str | None = Header(default=None),
) -> Response:
    # §9.4: state-changing requests pass same-origin enforcement first, before
    # touching any data
    rejected = same_origin_violation(request)
    if rejected is not None:
        return rejected
    conn = _db()
    try:
        if not idempotency_key or len(idempotency_key) < 16:
            return error_response("IDEMPOTENCY_KEY_REQUIRED", "idempotency key is required", 400)
        session_id = request.cookies.get("pb_save_session")
        if not session_id:
            return error_response(
                "SESSION_REQUIRED", "a save session must be established first", 403
            )

        data = await photo.read()
        result = save_photo(
            conn=conn,
            storage=_storage(),
            photo_bytes=data,
            template_id=templateId,
            template_version=templateVersion,
            anonymous_session_id=session_id,
            idempotency_key=idempotency_key,
        )
        payload = {
            "key": result.key,
            "keyDisplay": result.key_display,
            "deleteSecret": result.delete_secret,
            "expiresAt": result.expires_at,
            "template": {"id": result.template_id, "version": result.template_version},
            "photo": {"width": result.width, "height": result.height, "mime": "image/jpeg"},
        }
        resp: Response = JSONResponse(status_code=201, content=payload)
        return _no_store(resp)
    except SaveError as e:
        # 409 IDEMPOTENCY_IN_PROGRESS must carry Retry-After so the client knows
        # how long to wait
        return error_response(e.code, str(e), e.status, retry_after=e.retry_after)
    except Exception:  # Internal errors leak no details
        return error_response("INTERNAL", "internal server error", 500)


@router.delete("")
def delete_save(request: Request, body: dict) -> Response:
    """§6.4: idempotent 204; key addresses only, deleteSecret authorizes; never
    discloses whether the object existed before."""
    rejected = same_origin_violation(request)
    if rejected is not None:
        return rejected
    conn = _db()
    try:
        key = body.get("key", "")
        delete_secret = body.get("deleteSecret", "")
        try:
            from ..keygen import normalize_key

            normalized = normalize_key(key)
        except ValueError:
            return _no_store(Response(status_code=204))
        fp = hmac_utils.key_fingerprint(normalized)
        row = conn.execute(
            "SELECT p.id, p.status, p.delete_digest, p.revocation_epoch, p.object_key "
            "FROM photo_records p JOIN key_registry k ON k.key_fingerprint = p.key_fingerprint "
            "WHERE k.key_fingerprint=?",
            (fp,),
        ).fetchone()
        if row is None or row["status"] == "purged":
            return _no_store(Response(status_code=204))
        if not hmac.compare_digest(row["delete_digest"], hmac_utils.secret_digest(delete_secret)):
            return _no_store(Response(status_code=204))
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            # Step one is revocation only, keeping the transaction as small as
            # possible: once it commits, the photo is immediately unretrievable,
            # which is the only promise of "deleted" that means anything to the
            # user.
            conn.execute(
                "UPDATE photo_records SET status='access-revoked', access_revoked_at=?, "
                "revocation_epoch=revocation_epoch+1, purge_due_at=? WHERE id=?",
                (now, now, row["id"]),
            )
            conn.commit()
        except sqlite3.Error:
            conn.rollback()
            # Reporting success when the revocation did not land is a direct
            # privacy incident: the UI says "deleted" while the photo stays
            # retrievable. Returning 503 here does make "this key exists"
            # distinguishable during database failures (a missing key already
            # returned 204 above), but that requires the attacker to first
            # manufacture lock contention - a far lower cost than falsely
            # reporting a successful delete.
            return error_response(
                "DELETE_UNAVAILABLE",
                "temporarily unable to process deletion, please retry later",
                503,
            )

        # Step two is the physical delete. Marking status only would leave the
        # UI saying "deleted" while the original bytes linger on the volume for
        # up to the 30-day TTL. A failure here does not change the already
        # committed revocation semantics - the worker's purge_due completes the
        # byte cleanup next round.
        try:
            purge_photo(conn, _storage(), row["id"], row["object_key"], now)
            conn.commit()
        except (sqlite3.Error, OSError):
            conn.rollback()
        return _no_store(Response(status_code=204))
    except Exception:  # Idempotent 204; never disclose whether the object existed
        return _no_store(Response(status_code=204))
