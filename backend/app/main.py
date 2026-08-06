"""Portrait Booth API 入口。安全头与统一错误（§9.4/§6.5）；日志字段白名单。
单容器部署时同时托管前端构建产物（dist/）。"""

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
    # 根密钥缺失时拒绝进入运行态：带随机密钥启动会静默作废重启前的全部 KEY。
    require_secret_key_base()
    init_schema(get_settings().db_path)
    # 生命周期清理必须真的被调度：只写在 worker.py 里没人执行时，
    # 到期照片不会撤销，用户点了删除磁盘上的原件也还在。
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
    """把 SPA 请求路径映射到 dist 内的真实文件；越界一律返回 None。

    uvicorn 会先做 percent-decode，因此 %2e%2e%2f 到达这里时已经是 ../。
    明文 ../ 被 URL 规范化吃掉，编码形式不会——没有 resolve 后的归属校验，
    这条路径可以读到容器内任意文件（数据库与全部照片对象），
    绕过 KEY、限速、下载 token、到期与删除的全部控制。
    """
    if not path:
        return None
    # NUL 字节：uvicorn 会把 %00 解码进 path，而 os.path.realpath 对它抛 ValueError，
    # 任何未认证 GET 都能把它变成 500。这里先挡掉，保持「越界一律 None」的契约。
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
        return  # 仅后端部署（本地开发）：前端由 vite dev server 提供
    assets = _DIST / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa_fallback(path: str):
        # 未实现或写错的 API 路径必须是 404，不能被 SPA 兜底伪装成 200 index.html
        if path.startswith("api/"):
            resp = JSONResponse(
                status_code=404,
                content=_error_body("NOT_FOUND", "接口不存在", uuid.uuid4().hex),
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


"""内容安全策略（§9.4）。

'wasm-unsafe-eval' 是 MediaPipe 的 WebAssembly.instantiateStreaming 必需的，
且严格不放宽到 'unsafe-eval'——后者会把整个 eval 家族一起打开。
style-src 保留 'unsafe-inline'：Vite 注入的样式标签没有 nonce，
去掉它会让页面完全失去样式（这一条在引入构建期 nonce 后应收紧）。
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
    """纯 ASGI send 注入安全头（§9.4）。
    BaseHTTPMiddleware 在流式响应（download/FileResponse）转发时会触发 uvicorn 的
    Content-Length 校验错误，因此直接在 send 消息上附加头，不重包装 body。"""

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
                # ASGI 的头名是 bytes。此前直接 k.lower() 收进集合再拿 str 去比对，
                # 永远不相等——「不覆盖已有响应头」的守卫是死代码，中间件会无条件追加。
                # 后果之一：/assets/ 下的 404 会同时带上 no-store 与 immutable 两个
                # Cache-Control，语义互相打架。
                existing = {k.decode("latin-1").lower() for k, _ in message["headers"]}
                headers = dict(_SECURITY_HEADERS)
                if is_https:
                    # HSTS 只在 HTTPS 上有意义；在明文连接上发它没有任何效果
                    headers["Strict-Transport-Security"] = (
                        f"max-age={get_settings().hsts_max_age_seconds}; includeSubDomains"
                    )
                if path.startswith("/assets/"):
                    # 长缓存只挂构建产物。放进全局会污染照片与取回响应，
                    # 而 §9.4 要求那些响应必须 no-store。
                    headers["Cache-Control"] = "public, max-age=31536000, immutable"
                for name, value in headers.items():
                    if name.lower() not in existing:
                        message["headers"].append((name.encode(), value.encode()))
            await send(message)

        await self.app(scope, receive, send_wrapper)


app.add_middleware(SecurityHeadersMiddleware)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    # FastAPI 默认返回 {"detail": [...]}，与本 API 的 error envelope 不兼容：
    # 客户端会拿到两种互不相同的错误形状，只能靠猜。
    return error_response("VALIDATION_FAILED", "请求参数不合法", 422)


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    detail = exc.detail if isinstance(exc.detail, str) else "请求失败"
    code = detail if detail.isupper() or "_" in detail else "HTTP_ERROR"
    return error_response(code, detail, exc.status_code)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    # 日志只记录路由模板、状态类别与随机 requestId，不记录 path/query/body（§9.4）
    return error_response("INTERNAL", "服务器内部错误", 500)
