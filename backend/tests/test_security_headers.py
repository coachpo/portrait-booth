"""安全响应头（B4/§9.4）。CI 跑 pytest，因此这就是「CSP 的 CI 验证」。"""

import pytest
from fastapi.testclient import TestClient

from app.main import CONTENT_SECURITY_POLICY


@pytest.fixture()
def client():
    from app.main import app

    return TestClient(app)


class TestContentSecurityPolicy:
    def test_every_response_carries_a_policy(self, client):
        # 回归：全站曾只返回 referrer-policy 与 permissions-policy
        resp = client.get("/api/v1/health")
        assert resp.headers["Content-Security-Policy"] == CONTENT_SECURITY_POLICY

    def test_allows_wasm_but_not_the_whole_eval_family(self, client):
        """MediaPipe 需要 instantiateStreaming；放宽到 'unsafe-eval' 会把 eval 一起打开。"""
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
        # 明文连接上发 HSTS 没有任何效果，只会掩盖「这条链路其实没加密」
        assert "Strict-Transport-Security" not in client.get("/api/v1/health").headers

    def test_present_on_https(self):
        from app.main import app

        with TestClient(app, base_url="https://testserver") as https_client:
            header = https_client.get("/api/v1/health").headers["Strict-Transport-Security"]
        assert "max-age=" in header
        assert "includeSubDomains" in header


class TestCacheScoping:
    def test_photo_and_retrieval_responses_are_never_cached(self, client):
        """作用域陷阱：长缓存一旦进全局中间件，照片与取回响应也会被缓存。"""
        resp = client.post("/api/v1/retrievals/resolve", json={"key": "ZZZZZZ"})
        assert resp.headers["Cache-Control"] == "no-store, private"

    def test_api_responses_do_not_get_the_immutable_cache(self, client):
        assert "immutable" not in client.get("/api/v1/health").headers.get("Cache-Control", "")
