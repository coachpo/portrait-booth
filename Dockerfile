# 单容器：前端构建 → FastAPI 托管 + SQLite + 磁盘对象存储
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.14-slim AS backend
WORKDIR /app
COPY backend/requirements.txt backend/uv.lock ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app/ app/
COPY templates/ templates/
COPY --from=frontend /app/frontend/dist/ frontend/dist/
ENV PORTRAIT_FRONTEND_DIST=/app/frontend/dist \
    PORTRAIT_DB_PATH=/app/data/portrait.db \
    PORTRAIT_STORAGE_DIR=/app/data/objects \
    PYTHONUNBUFFERED=1

# 以非 root 运行：容器内的任意代码执行不该直接等于对镜像的写权限
RUN useradd --system --uid 10001 --home-dir /app portrait \
    && mkdir -p /app/data \
    && chown -R portrait:portrait /app
USER portrait

VOLUME ["/app/data"]
EXPOSE 8000

# /api/v1/health 一直存在却没人用；编排器需要它来判断容器是否真的可服务
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=2).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
