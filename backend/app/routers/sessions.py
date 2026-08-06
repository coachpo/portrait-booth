"""SPEC §6.0：服务政策与保存会话。"""

import secrets

from fastapi import APIRouter, Request, Response

from ..config import RETRIEVAL_MODE, get_settings
from ..http_utils import same_origin_violation

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
    """§6.0/§9.4：同源校验；设置 Secure; HttpOnly; SameSite=Strict; 会话 Cookie。"""
    rejected = same_origin_violation(request)
    if rejected is not None:
        return rejected
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
