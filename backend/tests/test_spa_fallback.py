"""Static hosting contract for single-container deployments (A2).

Two defects existed simultaneously in the old implementation:
1. `candidate = _DIST / path` had no containment check, so %2e%2e%2f encoded
   traversal could read any file inside the container;
2. every unmatched GET returned index.html 200, masking misspelled or
   unimplemented API paths as successful responses.
"""

import importlib

import pytest
from fastapi.testclient import TestClient

from app import main as main_module
from app.main import resolve_static_target


@pytest.fixture()
def dist(tmp_path):
    root = tmp_path / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html>app", encoding="utf-8")
    (root / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    # Sensitive file outside dist: in the Docker layout the data volume is a
    # sibling directory of dist
    (tmp_path / "portrait.db").write_bytes(b"SQLite format 3\x00SECRET")
    return root


class TestResolveStaticTarget:
    def test_serves_real_file_inside_dist(self, dist):
        assert resolve_static_target(dist, "assets/app.js") == dist / "assets" / "app.js"

    @pytest.mark.parametrize(
        "path",
        [
            "../portrait.db",
            "../../portrait.db",
            "assets/../../portrait.db",
            "./../portrait.db",
        ],
    )
    def test_rejects_traversal_out_of_dist(self, dist, path):
        assert resolve_static_target(dist, path) is None

    def test_rejects_absolute_path(self, dist):
        assert resolve_static_target(dist, "/etc/hosts") is None

    def test_rejects_directory(self, dist):
        assert resolve_static_target(dist, "assets") is None

    def test_rejects_empty_path(self, dist):
        assert resolve_static_target(dist, "") is None


class TestMountedApp:
    @pytest.fixture()
    def client(self, monkeypatch, dist):
        monkeypatch.setenv("PORTRAIT_FRONTEND_DIST", str(dist))
        reloaded = importlib.reload(main_module)
        yield TestClient(reloaded.app)
        monkeypatch.delenv("PORTRAIT_FRONTEND_DIST", raising=False)
        importlib.reload(main_module)

    def test_encoded_traversal_does_not_leak_database(self, client):
        resp = client.get("/%2e%2e%2fportrait.db")
        assert b"SQLite format 3" not in resp.content
        assert resp.text.startswith("<!doctype html>")

    def test_unknown_api_path_is_404_json(self, client):
        resp = client.get("/api/v1/does-not-exist")
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "NOT_FOUND"
        assert resp.json()["error"]["requestId"]
        assert resp.headers["Cache-Control"] == "no-store, private"

    def test_unknown_page_route_still_serves_the_spa(self, client):
        resp = client.get("/retrieve")
        assert resp.status_code == 200
        assert resp.text.startswith("<!doctype html>")

    def test_real_asset_is_served(self, client):
        assert client.get("/assets/app.js").text == "console.log(1)"

    def test_health_still_answers(self, client):
        assert client.get("/api/v1/health").json() == {"status": "ok"}


class TestMalformedPaths:
    """Out of bounds always returns None - including paths that would make the
    underlying calls raise directly."""

    def test_rejects_a_path_containing_a_nul_byte(self, dist):
        # uvicorn decodes %00 into the path and os.path.realpath throws
        # ValueError on it; any unauthenticated GET could turn it into a 500
        assert resolve_static_target(dist, "\x00") is None
        assert resolve_static_target(dist, "assets/\x00app.js") is None

    def test_serving_a_nul_path_does_not_500(self, monkeypatch, dist):
        import importlib

        from fastapi.testclient import TestClient

        monkeypatch.setenv("PORTRAIT_FRONTEND_DIST", str(dist))
        reloaded = importlib.reload(main_module)
        client = TestClient(reloaded.app, raise_server_exceptions=False)
        try:
            resp = client.get("/%00")
            assert resp.status_code == 200
            assert resp.text.startswith("<!doctype html>")
        finally:
            monkeypatch.delenv("PORTRAIT_FRONTEND_DIST", raising=False)
            importlib.reload(main_module)
