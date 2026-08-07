"""Portrait Booth API entry point. Security headers and unified errors
(§9.4/§6.5); whitelisted log fields.
In single-container deployments it also hosts the frontend build (dist/)."""

import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import get_settings
from app.db import init_schema
from app.hmac_utils import require_secret_key_base
from app.http_utils import error_response
from app.routers import retrievals, saves, sessions, templates
from app.worker import lifecycle_worker


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Refuse to enter the running state when the root secret is missing:
    # starting with a random key would silently invalidate every KEY issued
    # before the restart.
    require_secret_key_base()
    init_schema(get_settings().db_path)
    # Lifecycle cleanup must actually be scheduled: when only written in
    # worker.py with nobody running it, expired photos are never revoked and
    # clicking delete leaves the original bytes on disk.
    async with lifecycle_worker():
        yield


app = FastAPI(title="Portrait Booth API", version="0.1.0", lifespan=lifespan)

app.include_router(templates.router)
app.include_router(sessions.router)
app.include_router(saves.router)
app.include_router(retrievals.router)

_DIST = Path(os.environ.get("PORTRAIT_FRONTEND_DIST", "../frontend/dist")).resolve()


def _error_body(code: str, message: str, request_id: str) -> dict:
    return {"error": {"code": code, "message": message, "requestId": request_id}}


def resolve_static_target(dist: Path, path: str) -> Path | None:
    """Map an SPA request path to a real file inside dist; anything out of
    bounds returns None.

    uvicorn percent-decodes first, so %2e%2e%2f arrives here already as ../.
    Plain ../ is eaten by URL normalization, the encoded form is not - without
    a containment check after resolve, this path can read any file inside the
    container (the database and all photo objects), bypassing every control of
    KEY, rate limiting, download tokens, expiry, and deletion.
    """
    if not path:
        return None
    # NUL bytes: uvicorn decodes %00 into the path, and os.path.realpath throws
    # ValueError on it, letting any unauthenticated GET turn it into a 500.
    # Block it here to keep the "out of bounds always None" contract.
    if "\x00" in path:
        return None
    try:
        candidate = (dist / path).resolve()
    except (OSError, ValueError):
        return None
    if not candidate.is_relative_to(dist) or not candidate.is_file():
        return None
    return candidate


def _mount_frontend() -> None:
    if not _DIST.exists():
        return  # Backend-only deployment (local dev): the frontend is served by vite dev server
    assets = _DIST / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa_fallback(path: str):
        # Unimplemented or misspelled API paths must be 404, not masked as a 200
        # index.html by the SPA fallback
        if path.startswith("api/"):
            resp = JSONResponse(
                status_code=404,
                content=_error_body("NOT_FOUND", "API endpoint does not exist", uuid.uuid4().hex),
            )
            resp.headers["Cache-Control"] = "no-store, private"
            return resp
        target = resolve_static_target(_DIST, path)
        if target is not None:
            return FileResponse(target)
        return FileResponse(_DIST / "index.html")


@app.get("/api/v1/health")
def health() -> dict:
    return {"status": "ok"}


_mount_frontend()


"""Content security policy (§9.4).

'wasm-unsafe-eval' is required by MediaPipe's WebAssembly.instantiateStreaming
and is deliberately not widened to 'unsafe-eval' - the latter would open up the
whole eval family. style-src keeps 'unsafe-inline': Vite-injected style tags
have no nonce, and removing it would strip all styling from the page (this
entry should be tightened once a build-time nonce is introduced).
"""
CONTENT_SECURITY_POLICY = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "worker-src 'self'",
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ]
)

_SECURITY_HEADERS = {
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy": "camera=(self), microphone=()",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Frame-Options": "DENY",
}


class SecurityHeadersMiddleware:
    """Pure-ASGI send-side security header injection (§9.4).
    BaseHTTPMiddleware triggers uvicorn's Content-Length validation error when
    forwarding streaming responses (download/FileResponse), so headers are
    attached directly on the send message without re-wrapping the body."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        path: str = scope.get("path", "")
        is_https = scope.get("scheme") == "https"

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                # ASGI header names are bytes. Previously k.lower() fed str into
                # a set compared against str, so it never matched - the
                # "don't override existing headers" guard was dead code and the
                # middleware appended unconditionally. One consequence: a 404
                # under /assets/ carried both no-store and immutable
                # Cache-Control, two semantics fighting each other.
                existing = {k.decode("latin-1").lower() for k, _ in message["headers"]}
                headers = dict(_SECURITY_HEADERS)
                if is_https:
                    # HSTS only makes sense over HTTPS; on a plaintext
                    # connection sending it has no effect
                    headers["Strict-Transport-Security"] = (
                        f"max-age={get_settings().hsts_max_age_seconds}; includeSubDomains"
                    )
                if path.startswith("/assets/"):
                    # Long caching only for build artifacts. Applied globally it
                    # would pollute photo and retrieval responses, which §9.4
                    # requires to be no-store.
                    headers["Cache-Control"] = "public, max-age=31536000, immutable"
                for name, value in headers.items():
                    if name.lower() not in existing:
                        message["headers"].append((name.encode(), value.encode()))
            await send(message)

        await self.app(scope, receive, send_wrapper)


app.add_middleware(SecurityHeadersMiddleware)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    # FastAPI's default is {"detail": [...]}, incompatible with this API's error
    # envelope: the client would receive two incompatible error shapes and can
    # only guess.
    return error_response("VALIDATION_FAILED", "invalid request parameters", 422)


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    detail = exc.detail if isinstance(exc.detail, str) else "request failed"
    code = detail if detail.isupper() or "_" in detail else "HTTP_ERROR"
    return error_response(code, detail, exc.status_code)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    # Logs record only the route template, status category, and a random
    # requestId, never path/query/body (§9.4)
    return error_response("INTERNAL", "internal server error", 500)
