from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_templates_catalog():
    resp = client.get("/api/v1/templates")
    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "public, max-age=300, must-revalidate"
    payload = resp.json()
    assert payload["schemaVersion"] == 1
    assert len(payload["templates"]) == 6
    revision_ids = {t["revision"]["revisionId"] for t in payload["templates"]}
    assert revision_ids == {
        "generic-portrait-square@1",
        "us-passport-paper@1",
        "us-visa-digital@1",
        "fi-police-digital@1",
        "cn-visa-digital-ma-rabat@1",
        "jp-passport-paper@1",
    }


def test_templates_catalog_etag():
    resp = client.get("/api/v1/templates")
    etag = resp.headers["etag"]
    resp304 = client.get("/api/v1/templates", headers={"If-None-Match": etag})
    assert resp304.status_code == 304


def test_get_template_by_revision_id():
    resp = client.get("/api/v1/templates/fi-police-digital@1")
    assert resp.status_code == 200
    body = resp.json()
    assert body["revision"]["documentType"] == "id"
    assert body["publication"]["status"] == "active"
    assert body["contentHash"]


def test_get_template_unknown_returns_404():
    """回归：这里曾漏出 FastAPI 原生的 {"detail": ...}，与本 API 的 error envelope 不兼容。"""
    resp = client.get("/api/v1/templates/nope@9")
    assert resp.status_code == 404
    body = resp.json()
    assert body["error"]["code"] == "TEMPLATE_NOT_FOUND"
    assert body["error"]["requestId"]
    assert resp.headers["Cache-Control"] == "no-store, private"


class TestConditionalRequests:
    """C12：只做全等比较时，经 CDN 改写成弱 ETag 后条件请求永远不命中。"""

    def test_strong_etag_still_matches(self):
        etag = client.get("/api/v1/templates").headers["ETag"].strip('"')
        resp = client.get("/api/v1/templates", headers={"If-None-Match": f'"{etag}"'})
        assert resp.status_code == 304

    def test_weak_etag_matches(self):
        etag = client.get("/api/v1/templates").headers["ETag"].strip('"')
        resp = client.get("/api/v1/templates", headers={"If-None-Match": f'W/"{etag}"'})
        assert resp.status_code == 304

    def test_multi_value_header_matches(self):
        etag = client.get("/api/v1/templates").headers["ETag"].strip('"')
        resp = client.get(
            "/api/v1/templates", headers={"If-None-Match": f'"other", W/"{etag}", "more"'}
        )
        assert resp.status_code == 304

    def test_star_matches(self):
        assert client.get("/api/v1/templates", headers={"If-None-Match": "*"}).status_code == 304

    def test_unrelated_etag_does_not_match(self):
        resp = client.get("/api/v1/templates", headers={"If-None-Match": '"nope"'})
        assert resp.status_code == 200

    def test_catalog_forces_revalidation(self):
        """没有 must-revalidate，中间缓存可以在 300 秒里继续供应已停用的模板。"""
        cache_control = client.get("/api/v1/templates").headers["Cache-Control"]
        assert "must-revalidate" in cache_control


class TestFixedVersionEndpoint:
    def test_serves_a_template_by_id_and_version(self):
        resp = client.get("/api/v1/templates/fi-police-digital/versions/1")
        assert resp.status_code == 200
        assert resp.json()["revision"]["revisionId"] == "fi-police-digital@1"

    def test_unknown_version_is_404(self):
        resp = client.get("/api/v1/templates/fi-police-digital/versions/99")
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "TEMPLATE_NOT_FOUND"
