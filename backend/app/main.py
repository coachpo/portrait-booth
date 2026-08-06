"""Portrait Booth API 入口。安全头与统一错误（§9.4/§6.5）；日志字段白名单。
单容器部署时同时托管前端构建产物（dist/）。"""

import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.db import init_schema
from app.routers import retrievals, saves, sessions, templates

app = FastAPI(title="Portrait Booth API", version="0.1.0")

init_schema(get_settings().db_path)

app.include_router(templates.router)
app.include_router(sessions.router)
app.include_router(saves.router)
app.include_router(retrievals.router)

_DIST = Path(os.environ.get("PORTRAIT_FRONTEND_DIST", "../frontend/dist")).resolve()


def _mount_frontend() -> None:
    if not _DIST.exists():
        return  # 仅后端部署（本地开发）：前端由 vite dev server 提供
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa_fallback(path: str):
        candidate = _DIST / path
        if path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_DIST / "index.html")


@app.get("/api/v1/health")
def health() -> dict:
    return {"status": "ok"}


_mount_frontend()


_SECURITY_HEADERS = {
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy": "camera=(self), microphone=()",
}


class SecurityHeadersMiddleware:
    """纯 ASGI send 注入安全头（§9.4）。
    BaseHTTPMiddleware 在流式响应（download/FileResponse）转发时会触发 uvicorn 的
    Content-Length 校验错误，因此直接在 send 消息上附加头，不重包装 body。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                existing = {k.lower() for k, _ in message["headers"]}
                for name, value in _SECURITY_HEADERS.items():
                    if name.lower() not in existing:
                        message["headers"].append((name.encode(), value.encode()))
            await send(message)

        await self.app(scope, receive, send_wrapper)


app.add_middleware(SecurityHeadersMiddleware)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):

    # 日志只记录路由模板、状态类别与随机 requestId，不记录 path/query/body（§9.4）
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "INTERNAL", "message": "服务器内部错误", "requestId": ""}},
    )
