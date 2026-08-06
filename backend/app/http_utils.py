"""统一错误契约与同源校验（SPEC §6.5/§9.4）。

错误响应的形状在整个 API 里必须一致：客户端按 error.code 分支，
按 requestId 报障。之前 requestId 恒为空串，422 与模板 404 还会漏出
FastAPI 原生的 {"detail": ...}，客户端拿到两种互不兼容的形状。
"""

from __future__ import annotations

import uuid
from urllib.parse import urlparse

from fastapi import Request
from fastapi.responses import JSONResponse

from .config import get_settings


def new_request_id() -> str:
    return uuid.uuid4().hex


def error_body(code: str, message: str, request_id: str) -> dict:
    return {"error": {"code": code, "message": message, "requestId": request_id}}


def error_response(
    code: str,
    message: str,
    status: int,
    request_id: str | None = None,
    retry_after: int | None = None,
) -> JSONResponse:
    resp = JSONResponse(
        status_code=status,
        content=error_body(code, message, request_id or new_request_id()),
    )
    # 错误响应绝不能被缓存：它们常常携带限速与可用性状态
    resp.headers["Cache-Control"] = "no-store, private"
    if retry_after is not None:
        resp.headers["Retry-After"] = str(retry_after)
    return resp


def same_origin_violation(request: Request) -> JSONResponse | None:
    """状态改变请求的同源校验（§9.4）。

    两条独立信号：
    - Origin：存在就必须与 Host 相同；
    - Sec-Fetch-Site：浏览器一定会带（识别标志是 Sec-Fetch-Mode），
      因此对浏览器请求可以强制要求 same-origin，而不影响 curl 一类没有这些头的客户端。

    只看 Origin 是不够的：同站导航式的跨站提交可以完全不带 Origin。
    """
    if not get_settings().require_same_origin:
        return None

    origin = request.headers.get("origin")
    host = request.headers.get("host", "")
    if origin and urlparse(origin).netloc != host:
        return error_response("CROSS_ORIGIN_REJECTED", "跨站请求被拒绝", 403)

    fetch_site = request.headers.get("sec-fetch-site")
    is_browser = request.headers.get("sec-fetch-mode") is not None
    if is_browser and fetch_site not in (None, "same-origin", "none"):
        return error_response("CROSS_ORIGIN_REJECTED", "跨站请求被拒绝", 403)
    return None
