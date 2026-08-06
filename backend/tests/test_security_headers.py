"""安全响应头（B4/§9.4）。CI 跑 pytest，因此这就是「CSP 的 CI 验证」。"""

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

    def test_middleware_does_not_append_a_second_copy_of_an_existing_header(self, client):
        """回归：existing 收的是 ASGI 的 bytes 头名，却拿 str 去比对，永远不相等——
        「不覆盖已有响应头」的守卫是死代码，中间件会无条件追加第二个同名头。"""
        resp = client.post("/api/v1/retrievals/resolve", json={"key": "ZZZZZZ"})
        raw = [v for k, v in resp.headers.raw if k.lower() == b"cache-control"]
        assert raw == [b"no-store, private"], f"Cache-Control 被追加成了 {raw}"


class TestProxyHeaderTrust:
    """回归：Dockerfile 曾用 --forwarded-allow-ips "*"。

    那让 uvicorn 信任任意直连客户端的 X-Forwarded-For，request.client.host 变成
    攻击者可控的字符串，§9.3 的单 IP 限速随之失效——每次换一个伪造 IP 就换一个
    新的限速桶，30 次/小时的限额永远不触发，6 位取回码可以被无限速枚举。
    """

    DOCKERFILE = Path(__file__).resolve().parents[2] / "Dockerfile"

    def test_dockerfile_does_not_trust_arbitrary_forwarded_headers(self):
        text = self.DOCKERFILE.read_text(encoding="utf-8")
        cmd = " ".join(
            line
            for line in text.splitlines()
            if line.startswith("CMD") and not line.lstrip().startswith("#")
        )
        assert cmd, "Dockerfile 必须有 CMD"
        assert "--forwarded-allow-ips" not in cmd, (
            "不要在镜像里写死可信代理；用 FORWARDED_ALLOW_IPS 环境变量指定具体地址或 CIDR"
        )

    def test_ip_rate_limit_buckets_by_client(self, client):
        """限速必须真的按客户端分桶——这是取回码枚举的唯一屏障。"""
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
        # 同一个客户端的三次请求必须落进同一个桶并累加，而不是各开一个新桶
        assert row["buckets"] == 1
        assert row["top"] == 3
