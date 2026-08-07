"""Unified error contract and same-origin enforcement (SPEC §6.5/§9.4).

The shape of error responses must be identical across the whole API: clients
branch on error.code and file issues by requestId. Previously requestId was
always empty and 422/template-404 leaked FastAPI's native {"detail": ...},
leaving clients with two incompatible shapes.
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
    # Error responses must never be cached: they often carry rate-limit and
    # availability state
    resp.headers["Cache-Control"] = "no-store, private"
    if retry_after is not None:
        resp.headers["Retry-After"] = str(retry_after)
    return resp


def same_origin_violation(request: Request) -> JSONResponse | None:
    """Same-origin enforcement for state-changing requests (§9.4).

    Two independent signals:
    - Origin: when present, must equal Host;
    - Sec-Fetch-Site: browsers always send it (identified by Sec-Fetch-Mode),
      so browser requests can be strictly required to be same-origin without
      affecting clients like curl that lack these headers.

    Origin alone is not enough: same-site-navigation-style cross-site
    submissions can omit Origin entirely.
    """
    if not get_settings().require_same_origin:
        return None

    origin = request.headers.get("origin")
    host = request.headers.get("host", "")
    if origin and urlparse(origin).netloc != host:
        return error_response("CROSS_ORIGIN_REJECTED", "cross-site request rejected", 403)

    fetch_site = request.headers.get("sec-fetch-site")
    is_browser = request.headers.get("sec-fetch-mode") is not None
    if is_browser and fetch_site not in (None, "same-origin", "none"):
        return error_response("CROSS_ORIGIN_REJECTED", "cross-site request rejected", 403)
    return None
