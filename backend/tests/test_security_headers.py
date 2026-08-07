"""Security response headers (B4/§9.4). CI runs pytest, so this is the "CI
verification of CSP"."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import CONTENT_SECURITY_POLICY


@pytest.fixture()
def client():
    from app.main import app

    return TestClient(app)


class TestContentSecurityPolicy:
    def test_every_response_carries_a_policy(self, client):
        # Regression: the whole site used to send only referrer-policy and
        # permissions-policy
        resp = client.get("/api/v1/health")
        assert resp.headers["Content-Security-Policy"] == CONTENT_SECURITY_POLICY

    def test_allows_wasm_but_not_the_whole_eval_family(self, client):
        """MediaPipe needs instantiateStreaming; widening to 'unsafe-eval'
        would open the whole eval family."""
        policy = client.get("/api/v1/health").headers["Content-Security-Policy"]
        assert "'wasm-unsafe-eval'" in policy
        assert "'unsafe-eval'" not in policy.replace("'wasm-unsafe-eval'", "")

    @pytest.mark.parametrize(
        "directive",
        [
            "default-src 'self'",
            "worker-src 'self'",
            "img-src 'self' blob: data:",
            "media-src 'self' blob:",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "base-uri 'none'",
        ],
    )
    def test_baseline_directives_are_present(self, client, directive):
        assert directive in client.get("/api/v1/health").headers["Content-Security-Policy"]

    def test_other_hardening_headers(self, client):
        headers = client.get("/api/v1/health").headers
        assert headers["X-Content-Type-Options"] == "nosniff"
        assert headers["Referrer-Policy"] == "no-referrer"
        assert headers["X-Frame-Options"] == "DENY"
        assert headers["Cross-Origin-Opener-Policy"] == "same-origin"


class TestStrictTransportSecurity:
    def test_absent_on_plain_http(self, client):
        # Sending HSTS over a plaintext connection has no effect and only
        # masks that this link is not actually encrypted
        assert "Strict-Transport-Security" not in client.get("/api/v1/health").headers

    def test_present_on_https(self):
        from app.main import app

        with TestClient(app, base_url="https://testserver") as https_client:
            header = https_client.get("/api/v1/health").headers["Strict-Transport-Security"]
        assert "max-age=" in header
        assert "includeSubDomains" in header


class TestCacheScoping:
    def test_photo_and_retrieval_responses_are_never_cached(self, client):
        """Scoping trap: once the long cache lands in the global middleware,
        photo and retrieval responses get cached too."""
        resp = client.post("/api/v1/retrievals/resolve", json={"key": "ZZZZZZ"})
        assert resp.headers["Cache-Control"] == "no-store, private"

    def test_api_responses_do_not_get_the_immutable_cache(self, client):
        assert "immutable" not in client.get("/api/v1/health").headers.get("Cache-Control", "")

    def test_middleware_does_not_append_a_second_copy_of_an_existing_header(self, client):
        """Regression: existing held ASGI bytes header names but was compared as
        str, so it never matched - the "don't override existing headers" guard
        was dead code and the middleware appended a second same-name header
        unconditionally."""
        resp = client.post("/api/v1/retrievals/resolve", json={"key": "ZZZZZZ"})
        raw = [v for k, v in resp.headers.raw if k.lower() == b"cache-control"]
        assert raw == [b"no-store, private"], f"Cache-Control was appended into {raw}"


class TestProxyHeaderTrust:
    """Regression: the Dockerfile used --forwarded-allow-ips "*".

    It made uvicorn trust X-Forwarded-For from any directly connected client,
    turning request.client.host into an attacker-controlled string and
    silently defeating §9.3's per-IP rate limit - each forged IP got a fresh
    bucket, the 30/hour cap never triggered, and the 6-character retrieval
    code space could be enumerated without limit.
    """

    DOCKERFILE = Path(__file__).resolve().parents[2] / "Dockerfile"

    def test_dockerfile_does_not_trust_arbitrary_forwarded_headers(self):
        text = self.DOCKERFILE.read_text(encoding="utf-8")
        cmd = " ".join(
            line
            for line in text.splitlines()
            if line.startswith("CMD") and not line.lstrip().startswith("#")
        )
        assert cmd, "Dockerfile must have a CMD"
        assert "--forwarded-allow-ips" not in cmd, (
            "do not hard-code trusted proxies in the image; use the FORWARDED_ALLOW_IPS "
            "environment variable to specify a concrete address or CIDR"
        )

    def test_ip_rate_limit_buckets_by_client(self, client):
        """Rate limiting must actually bucket by client - this is the only
        barrier against retrieval-code enumeration."""
        from app.config import get_settings
        from app.db import connect

        for _ in range(3):
            client.post("/api/v1/retrievals/resolve", json={"key": "ZZZZZZ"})

        conn = connect(get_settings().db_path)
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS buckets, MAX(count) AS top FROM rate_limit_counts "
                "WHERE scope='resolve-ip'"
            ).fetchone()
        finally:
            conn.close()
        # The same client's three requests must land in one bucket and
        # accumulate, not each open a new bucket
        assert row["buckets"] == 1
        assert row["top"] == 3
