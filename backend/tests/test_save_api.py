"""暂存/取回/删除端到端（SPEC §6.2~§6.5）。"""

import io
import json
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.worker import purge_expired, sweep_orphans

# DB、对象目录与根密钥由 conftest.py 的 isolated_runtime fixture 逐用例隔离


@pytest.fixture()
def client():
    from app.main import app

    return TestClient(app)


def make_jpeg(width=500, height=653, quality=92) -> bytes:
    img = Image.new("RGB", (width, height), (60, 120, 200))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def save_flow(client) -> dict:
    """建会话 → 保存 → 返回响应 JSON。"""
    session = client.post("/api/v1/save-sessions")
    assert session.status_code == 204
    cookie = session.cookies["pb_save_session"]
    resp = client.post(
        "/api/v1/saves",
        files={"photo": ("p.jpg", make_jpeg(), "image/jpeg")},
        data={"templateId": "fi-police-digital", "templateVersion": 1},
        headers={"Idempotency-Key": "test-idem-key-0001"},
        cookies={"pb_save_session": cookie},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestSaveFlow:
    def test_save_returns_key_and_delete_secret(self, client):
        body = save_flow(client)
        assert len(body["key"]) == 6
        assert body["keyDisplay"] == f"{body['key'][:3]} {body['key'][3:]}"
        assert len(body["deleteSecret"]) >= 22
        assert body["template"] == {"id": "fi-police-digital", "version": 1}
        assert body["photo"]["mime"] == "image/jpeg"

    def test_save_requires_session(self, client):
        resp = client.post(
            "/api/v1/saves",
            files={"photo": ("p.jpg", make_jpeg(), "image/jpeg")},
            data={"templateId": "fi-police-digital", "templateVersion": 1},
            headers={"Idempotency-Key": "test-idem-key-0002"},
        )
        assert resp.status_code == 403

    def test_save_requires_idempotency_key(self, client):
        session = client.post("/api/v1/save-sessions")
        cookie = session.cookies["pb_save_session"]
        resp = client.post(
            "/api/v1/saves",
            files={"photo": ("p.jpg", make_jpeg(), "image/jpeg")},
            data={"templateId": "fi-police-digital", "templateVersion": 1},
            cookies={"pb_save_session": cookie},
        )
        assert resp.status_code == 400

    def test_save_rejects_wrong_size(self, client):
        session = client.post("/api/v1/save-sessions")
        cookie = session.cookies["pb_save_session"]
        resp = client.post(
            "/api/v1/saves",
            files={"photo": ("p.jpg", make_jpeg(100, 100), "image/jpeg")},
            data={"templateId": "fi-police-digital", "templateVersion": 1},
            headers={"Idempotency-Key": "test-idem-key-0003"},
            cookies={"pb_save_session": cookie},
        )
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "PHOTO_SIZE_MISMATCH"

    def test_save_rejects_inactive_template(self, client):
        session = client.post("/api/v1/save-sessions")
        cookie = session.cookies["pb_save_session"]
        resp = client.post(
            "/api/v1/saves",
            files={"photo": ("p.jpg", make_jpeg(), "image/jpeg")},
            data={"templateId": "cn-visa-digital-ma-rabat", "templateVersion": 1},
            headers={"Idempotency-Key": "test-idem-key-0004"},
            cookies={"pb_save_session": cookie},
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "TEMPLATE_UNAVAILABLE"

    def test_save_rejects_non_jpeg(self, client):
        session = client.post("/api/v1/save-sessions")
        cookie = session.cookies["pb_save_session"]
        resp = client.post(
            "/api/v1/saves",
            files={"photo": ("p.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 100, "image/png")},
            data={"templateId": "fi-police-digital", "templateVersion": 1},
            headers={"Idempotency-Key": "test-idem-key-0005"},
            cookies={"pb_save_session": cookie},
        )
        assert resp.status_code == 422

    def test_save_idempotent_replay_returns_same_envelope(self, client):
        session = client.post("/api/v1/save-sessions")
        cookie = session.cookies["pb_save_session"]
        kwargs = dict(
            files={"photo": ("p.jpg", make_jpeg(), "image/jpeg")},
            data={"templateId": "fi-police-digital", "templateVersion": 1},
            headers={"Idempotency-Key": "test-idem-key-0006"},
            cookies={"pb_save_session": cookie},
        )
        first = client.post("/api/v1/saves", **kwargs)
        second = client.post("/api/v1/saves", **kwargs)
        assert first.status_code == second.status_code == 201
        assert first.json() == second.json()

    def test_same_idempotency_key_different_payload_conflicts(self, client):
        session = client.post("/api/v1/save-sessions")
        cookie = session.cookies["pb_save_session"]
        common = dict(
            data={"templateId": "fi-police-digital", "templateVersion": 1},
            headers={"Idempotency-Key": "test-idem-key-0007"},
            cookies={"pb_save_session": cookie},
        )
        client.post(
            "/api/v1/saves", files={"photo": ("p.jpg", make_jpeg(), "image/jpeg")}, **common
        )
        resp = client.post(
            "/api/v1/saves",
            files={"photo": ("p.jpg", make_jpeg(quality=70), "image/jpeg")},
            **common,
        )
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"


class TestRetrieveFlow:
    def test_resolve_and_download(self, client):
        body = save_flow(client)
        key = body["key"]

        resolved = client.post("/api/v1/retrievals/resolve", json={"key": f"{key[:3]} {key[3:]}"})
        assert resolved.status_code == 200
        token = resolved.json()["downloadToken"]

        download = client.post(
            "/api/v1/retrievals/download", headers={"Authorization": f"Bearer {token}"}
        )
        assert download.status_code == 200
        assert download.headers["Content-Type"] == "image/jpeg"
        assert download.headers["Cache-Control"] == "no-store, private"
        assert download.headers["X-Robots-Tag"].startswith("noindex")

        # token 单次用途：二次消费 404
        again = client.post(
            "/api/v1/retrievals/download", headers={"Authorization": f"Bearer {token}"}
        )
        assert again.status_code == 404

    def test_resolve_unknown_key_is_uniform_404(self, client):
        resp = client.post("/api/v1/retrievals/resolve", json={"key": "ZZZZZZ"})
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "PHOTO_UNAVAILABLE"

    def test_resolve_normalizes_key(self, client):
        body = save_flow(client)
        resp = client.post("/api/v1/retrievals/resolve", json={"key": body["key"].lower() + " "})
        assert resp.status_code == 200

    def test_resolve_after_delete_is_unavailable(self, client):
        body = save_flow(client)
        client.request(
            "DELETE",
            "/api/v1/saves",
            content=json.dumps({"key": body["key"], "deleteSecret": body["deleteSecret"]}),
            headers={"Content-Type": "application/json"},
        )
        resp = client.post("/api/v1/retrievals/resolve", json={"key": body["key"]})
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "PHOTO_UNAVAILABLE"


class TestDeleteFlow:
    def test_delete_is_idempotent_and_authorized_by_delete_secret(self, client):
        body = save_flow(client)
        resp = client.request(
            "DELETE",
            "/api/v1/saves",
            content=json.dumps({"key": body["key"], "deleteSecret": body["deleteSecret"]}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 204
        # 重复删除同样 204
        again = client.request(
            "DELETE",
            "/api/v1/saves",
            content=json.dumps({"key": body["key"], "deleteSecret": body["deleteSecret"]}),
            headers={"Content-Type": "application/json"},
        )
        assert again.status_code == 204

    def test_delete_with_wrong_secret_does_not_disclose(self, client):
        body = save_flow(client)
        resp = client.request(
            "DELETE",
            "/api/v1/saves",
            content=json.dumps({"key": body["key"], "deleteSecret": "wrong-secret-000000000000"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 204
        # 照片仍可解析
        resolved = client.post("/api/v1/retrievals/resolve", json={"key": body["key"]})
        assert resolved.status_code == 200


class TestWorker:
    def test_purge_expired_removes_photo_and_object(self, client):
        from app import db
        from app.config import get_settings
        from app.storage import Storage

        save_flow(client)
        cfg = get_settings()
        conn = db.connect(cfg.db_path)
        storage = Storage()
        try:
            row = conn.execute(
                "SELECT p.id, p.object_key FROM photo_records p "
                "JOIN key_registry k ON k.key_fingerprint=p.key_fingerprint "
                "WHERE k.state='active'"
            ).fetchone()
            assert row is not None
            assert storage.read(row["object_key"]) is not None

            # 强制到期后 purge
            conn.execute(
                "UPDATE photo_records SET expires_at='2000-01-01T00:00:00Z' WHERE id=?",
                (row["id"],),
            )
            conn.commit()
            purged = purge_expired(conn, storage, now="2001-01-01T00:00:00Z")
            assert purged == 1
            assert storage.read(row["object_key"]) is None
            state = conn.execute(
                "SELECT state FROM key_registry WHERE photo_id IS NULL AND state='retired'"
            ).fetchone()
            assert state is not None  # retired 项永久保留
        finally:
            conn.close()

    def test_orphan_sweep_spares_objects_younger_than_the_age_gate(self, client):
        """回归：没有年龄门限时，这一趟清理会删掉进行中请求刚写下的字节。"""
        import os

        from app import db
        from app.config import get_settings
        from app.storage import Storage

        save_flow(client)
        cfg = get_settings()
        conn = db.connect(cfg.db_path)
        storage = Storage()
        try:
            fresh = storage.write(b"in-flight-staging-bytes")
            assert sweep_orphans(conn, storage) == 0
            assert storage.read(fresh) is not None

            # 把它改老到超过门限，再扫一次
            old = time.time() - cfg.orphan_min_age_seconds - 60
            os.utime(storage.base / fresh, (old, old))
            assert sweep_orphans(conn, storage) == 1
            assert storage.read(fresh) is None
        finally:
            conn.close()

    def test_orphan_sweep_keeps_referenced_objects(self, client):
        from app import db
        from app.config import get_settings
        from app.storage import Storage

        body = save_flow(client)
        cfg = get_settings()
        conn = db.connect(cfg.db_path)
        storage = Storage()
        try:
            row = conn.execute(
                "SELECT object_key FROM photo_records WHERE status='active'"
            ).fetchone()
            assert row is not None
            # 引用中的对象无论多老都不能被扫掉
            assert sweep_orphans(conn, storage, min_age_seconds=0) == 0
            assert storage.read(row["object_key"]) is not None
            assert body["key"]
        finally:
            conn.close()

    def test_user_delete_removes_the_bytes_immediately(self, client):
        """回归：删除曾只标记状态，照片原件继续留到 30 天 TTL 结束。"""
        from app import db
        from app.config import get_settings
        from app.storage import Storage

        body = save_flow(client)
        cfg = get_settings()
        conn = db.connect(cfg.db_path)
        storage = Storage()
        try:
            row = conn.execute(
                "SELECT id, object_key FROM photo_records WHERE status='active'"
            ).fetchone()
            assert storage.read(row["object_key"]) is not None
        finally:
            conn.close()

        resp = client.request(
            "DELETE",
            "/api/v1/saves",
            content=json.dumps({"key": body["key"], "deleteSecret": body["deleteSecret"]}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 204
        assert Storage().read(row["object_key"]) is None

        conn = db.connect(cfg.db_path)
        try:
            after = conn.execute(
                "SELECT status, purged_at FROM photo_records WHERE id=?", (row["id"],)
            ).fetchone()
            assert after["status"] == "purged"
            assert after["purged_at"] is not None
            retired = conn.execute(
                "SELECT state FROM key_registry WHERE photo_id IS NULL AND state='retired'"
            ).fetchone()
            assert retired is not None
        finally:
            conn.close()


class TestRateLimit:
    def test_resolve_failures_are_rate_limited(self, client):
        for _ in range(3):
            resp = client.post("/api/v1/retrievals/resolve", json={"key": "ZZZZZZ"})
            assert resp.status_code == 404
        # 超过限额后仍统一 404（不泄露原因）
        resp = client.post("/api/v1/retrievals/resolve", json={"key": "ZZZZZZ"})
        assert resp.status_code == 404
