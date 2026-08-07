# Single container: frontend build → FastAPI hosting + SQLite + on-disk object storage
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

# Run as non-root: arbitrary code execution inside the container should not
# directly equal write access to the image
RUN useradd --system --uid 10001 --home-dir /app portrait \
    && mkdir -p /app/data \
    && chown -R portrait:portrait /app
USER portrait

VOLUME ["/app/data"]
EXPOSE 8000

# /api/v1/health has always existed but nothing uses it; orchestrators need
# it to tell whether the container is actually serving
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=2).status == 200 else 1)"

# Never add --forwarded-allow-ips "*".
# It makes uvicorn trust X-Forwarded-For from any directly connected client,
# turning request.client.host into an attacker-controlled string and silently
# defeating §9.3's per-IP rate limit: each forged IP gets a fresh rate-limit
# bucket, the 30/hour cap never triggers, and the 6-character retrieval code
# space can be enumerated without limit - and the retrieval code is the only
# credential for retrieving a photo in key_only_ephemeral mode.
# uvicorn only trusts 127.0.0.1 by default. When the reverse proxy is not on
# the same host, use the FORWARDED_ALLOW_IPS environment variable to write the
# proxy's concrete address or CIDR instead of a wildcard; also make sure the
# proxy **overwrites** rather than appends X-Forwarded-For (nginx's
# $proxy_add_x_forwarded_for appends, so the leftmost value still comes from
# the client).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
