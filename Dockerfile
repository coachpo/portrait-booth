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
    PORTRAIT_STORAGE_DIR=/app/data/objects
VOLUME ["/app/data"]
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
