"""SPEC §6.2/§6.4：暂存与删除。"""

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
    # §9.4：状态改变请求先过同源校验，再碰任何数据
    rejected = same_origin_violation(request)
    if rejected is not None:
        return rejected
    conn = _db()
    try:
        if not idempotency_key or len(idempotency_key) < 16:
            return error_response("IDEMPOTENCY_KEY_REQUIRED", "缺少幂等键", 400)
        session_id = request.cookies.get("pb_save_session")
        if not session_id:
            return error_response("SESSION_REQUIRED", "需要先建立保存会话", 403)

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
        # 409 IDEMPOTENCY_IN_PROGRESS 必须带 Retry-After，客户端才知道等多久
        return error_response(e.code, str(e), e.status, retry_after=e.retry_after)
    except Exception:  # 内部错误不泄露细节
        return error_response("INTERNAL", "服务器内部错误", 500)


@router.delete("")
def delete_save(request: Request, body: dict) -> Response:
    """§6.4：幂等 204；key 只定址，deleteSecret 授权；不披露对象先前是否存在。"""
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
            # 第一步只做撤销，事务尽可能小：提交成功后照片立刻取不回，
            # 这是「已删除」对用户唯一有意义的承诺。
            conn.execute(
                "UPDATE photo_records SET status='access-revoked', access_revoked_at=?, "
                "revocation_epoch=revocation_epoch+1, purge_due_at=? WHERE id=?",
                (now, now, row["id"]),
            )
            conn.commit()
        except sqlite3.Error:
            conn.rollback()
            # 撤销没能落地时不能报成功。UI 说「已删除」而照片仍可取回是直接的隐私事故；
            # 这里返回 503 确实让「该 key 存在」在数据库故障期间可被区分（不存在的 key
            # 在上面就已经 204 返回），但那要求攻击者先制造出锁竞争，
            # 代价远高于误报删除成功的后果。
            return error_response("DELETE_UNAVAILABLE", "暂时无法处理删除，请稍后重试", 503)

        # 第二步物理删除。只标记状态的话，UI 说「已删除」而照片原件继续留在卷里，
        # 最长滞留到 30 天 TTL。这一步失败不改变已提交的撤销语义——
        # worker 的 purge_due 会在下一轮补上字节清理。
        try:
            purge_photo(conn, _storage(), row["id"], row["object_key"], now)
            conn.commit()
        except (sqlite3.Error, OSError):
            conn.rollback()
        return _no_store(Response(status_code=204))
    except Exception:  # 幂等 204；不披露对象先前是否存在
        return _no_store(Response(status_code=204))
