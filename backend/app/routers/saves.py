"""SPEC §6.2/§6.4：暂存与删除。"""

import hmac
import sqlite3
import time
import uuid

from fastapi import APIRouter, Form, Header, Request, UploadFile
from fastapi.responses import JSONResponse, Response

from .. import hmac_utils
from ..config import get_settings
from ..db import connect, init_schema
from ..save_service import SaveError, save_photo
from ..storage import Storage

router = APIRouter(prefix="/api/v1/saves")


def _db() -> sqlite3.Connection:
    cfg = get_settings()
    init_schema(cfg.db_path)
    return connect(cfg.db_path)


def _storage() -> Storage:
    return Storage()


def _request_id() -> str:
    return uuid.uuid4().hex


def _no_store(resp: JSONResponse) -> JSONResponse:
    resp.headers["Cache-Control"] = "no-store, private"
    return resp


@router.post("")
async def create_save(
    request: Request,
    photo: UploadFile,
    templateId: str = Form(...),
    templateVersion: int = Form(...),
    idempotency_key: str | None = Header(default=None),
) -> JSONResponse:
    conn = _db()
    try:
        if not idempotency_key or len(idempotency_key) < 16:
            return _no_store(
                JSONResponse(
                    status_code=400,
                    content=_err("IDEMPOTENCY_KEY_REQUIRED", "缺少幂等键", _request_id()),
                )
            )
        session_id = request.cookies.get("pb_save_session")
        if not session_id:
            return _no_store(
                JSONResponse(
                    status_code=403,
                    content=_err("SESSION_REQUIRED", "需要先建立保存会话", _request_id()),
                )
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
        resp = JSONResponse(status_code=201, content=payload)
        return _no_store(resp)
    except SaveError as e:
        return _no_store(
            JSONResponse(status_code=e.status, content=_err(e.code, str(e), _request_id()))
        )
    except Exception:  # 内部错误不泄露细节
        return _no_store(
            JSONResponse(status_code=500, content=_err("INTERNAL", "服务器内部错误", _request_id()))
        )


@router.delete("")
def delete_save(request: Request, body: dict) -> JSONResponse:
    """§6.4：幂等 204；key 只定址，deleteSecret 授权；不披露对象先前是否存在。"""
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
        conn.execute(
            "UPDATE photo_records SET status='access-revoked', access_revoked_at=?, "
            "revocation_epoch=revocation_epoch+1, purge_due_at=? WHERE id=?",
            (now, now, row["id"]),
        )
        conn.execute(
            "UPDATE download_grants SET consumed_at=COALESCE(consumed_at, ?) "
            "WHERE photo_id=? AND consumed_at IS NULL",
            (now, row["id"]),
        )
        conn.commit()
        return _no_store(Response(status_code=204))
    except Exception:  # 幂等 204；不披露对象先前是否存在
        return _no_store(Response(status_code=204))


def _err(code: str, message: str, request_id: str) -> dict:
    return {"error": {"code": code, "message": message, "requestId": request_id}}
