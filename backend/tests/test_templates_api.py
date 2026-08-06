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
    assert resp.headers["cache-control"] == "public, max-age=300"
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
    resp = client.get("/api/v1/templates/nope@9")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "TEMPLATE_NOT_FOUND"
