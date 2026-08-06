"""SPEC §6.0：服务政策与保存会话。"""

import secrets
import uuid

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from ..config import RETRIEVAL_MODE, get_settings

router = APIRouter(prefix="/api/v1")


@router.get("/service-policy")
def get_service_policy() -> dict:
    cfg = get_settings()
    return {
        "temporaryStorageTtlSeconds": cfg.temporary_storage_ttl_seconds,
        "retrievalMode": RETRIEVAL_MODE,
        "maxUploadBytes": cfg.max_upload_bytes,
        "policyVersion": cfg.policy_version,
    }


@router.post("/save-sessions", status_code=204)
def create_save_session(request: Request):
    """§6.0/§9.4：同源 Origin 校验；设置 Secure; HttpOnly; SameSite=Strict; 会话 Cookie。"""
    origin = request.headers.get("origin")
    if origin:
        from urllib.parse import urlparse

        if urlparse(origin).netloc != request.headers.get("host", ""):
            return JSONResponse(
                status_code=403,
                content={
                    "error": {
                        "code": "CROSS_ORIGIN_REJECTED",
                        "message": "跨站请求被拒绝",
                        "requestId": uuid.uuid4().hex,
                    }
                },
            )
    cfg = get_settings()
    session_id = secrets.token_hex(16)
    resp = Response(status_code=204)
    resp.set_cookie(
        key="pb_save_session",
        value=session_id,
        max_age=cfg.save_session_cookie_max_age,
        secure=True,
        httponly=True,
        samesite="strict",
        path="/api/v1/saves",
    )
    # 会话 ID 只出现在 Cookie 中，不进入 URL/日志
    resp.headers["Cache-Control"] = "no-store, private"
    return resp
