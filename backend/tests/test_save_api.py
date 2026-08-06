"""暂存/取回/删除端到端（SPEC §6.2~§6.5）。"""

import io
import json
import random
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import get_settings
from app.db import connect
from app.image_validate import ImageValidationError, validate_and_reencode
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


def noise_image(width=600, height=600) -> Image.Image:
    """每像素独立均匀随机 RGB 噪声（固定种子，保证可重复）。"""
    rng = random.Random(20260805)
    img = Image.new("RGB", (width, height))
    img.putdata(
        [
            (rng.randrange(256), rng.randrange(256), rng.randrange(256))
            for _ in range(width * height)
        ]
    )
    return img


def search_quality_bytes(img: Image.Image, max_bytes: int) -> bytes:
    """镜像前端 searchQuality（final-artifact.ts:208-241）：二分取最大可行 q。

    lo=0.40 / hi=0.95 / 10 步 / eps=0.005；浏览器 toBlob 不写 ICC，故不带
    icc_profile；全不可行时补试一次 q=40。
    """
    lo, hi = 0.40, 0.95
    best, best_q = None, -1.0
    for _ in range(10):
        q = (lo + hi) / 2
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=round(q * 100))
        data = buf.getvalue()
        if len(data) <= max_bytes:
            if q > best_q:
                best, best_q = data, q
            lo = q
        else:
            hi = q
        if hi - lo <= 0.005:
            break
    if best is None:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=40)
        best = buf.getvalue()
    return best


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

    def test_save_accepts_client_searched_photo_within_limit(self, client):
        """A2 正向：客户端已按体积搜索压到上限内的成品，服务端不得以固定 q92 拒收。"""
        img = noise_image()
        client_blob = search_quality_bytes(img, 240000)
        assert len(client_blob) <= 240000

        session = client.post("/api/v1/save-sessions")
        assert session.status_code == 204
        cookie = session.cookies["pb_save_session"]
        resp = client.post(
            "/api/v1/saves",
            files={"photo": ("p.jpg", client_blob, "image/jpeg")},
            data={"templateId": "us-visa-digital", "templateVersion": 1},
            headers={"Idempotency-Key": "test-idem-key-a2-0001"},
            cookies={"pb_save_session": cookie},
        )
        assert resp.status_code == 201, resp.text

        # 落库字节仍在上限内（走 test_contract.py 的 DB 直读模式）
        conn = connect(get_settings().db_path)
        try:
            row = conn.execute("SELECT byte_length FROM photo_records").fetchone()
        finally:
            conn.close()
        assert row is not None and row["byte_length"] <= 240000

    def test_reencode_rejects_when_below_floor_still_over_limit(self, client):
        """A2 反向：直调 validate_and_reencode，降到下界 40 仍超限必须拒绝。"""
        img = noise_image()
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=20)  # 高熵但远低于下界的入参
        data = buf.getvalue()
        settings = get_settings()
        assert len(data) <= 90000  # 入参长度门（image_validate.py:33-34）不被触发

        with pytest.raises(ImageValidationError) as exc:
            validate_and_reencode(
                data,
                max_bytes=90000,
                max_pixels=settings.max_pixels,
                max_edge_px=settings.max_edge_px,
                target_width=600,
                target_height=600,
                target_ppi=None,
                settings=settings,
            )
        assert exc.value.code == "PHOTO_TOO_LARGE"

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

    def test_global_upload_limit_caps_template_max_bytes(self, client, monkeypatch):
        """回归：模板 maxBytes 曾整体压过全局上限，调小全局值后上传仍被拒。"""
        photo = make_jpeg()
        monkeypatch.setenv("PORTRAIT_MAX_UPLOAD_BYTES", str(len(photo) - 1))
        session = client.post("/api/v1/save-sessions")
        cookie = session.cookies["pb_save_session"]
        resp = client.post(
            "/api/v1/saves",
            files={"photo": ("p.jpg", photo, "image/jpeg")},
            data={"templateId": "fi-police-digital", "templateVersion": 1},
            headers={"Idempotency-Key": "test-idem-key-0009"},
            cookies={"pb_save_session": cookie},
        )
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "PHOTO_TOO_LARGE"

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

    def test_new_session_same_idempotency_key_is_a_new_save(self, client):
        """不变量：会话摘要参与幂等主键，换会话即换命名空间，同幂等键也是全新保存。"""
        session_a = client.post("/api/v1/save-sessions")
        cookie_a = session_a.cookies["pb_save_session"]
        first = client.post(
            "/api/v1/saves",
            files={"photo": ("p.jpg", make_jpeg(), "image/jpeg")},
            data={"templateId": "fi-police-digital", "templateVersion": 1},
            headers={"Idempotency-Key": "test-idem-key-0008"},
            cookies={"pb_save_session": cookie_a},
        )
        assert first.status_code == 201
        key1 = first.json()["key"]

        session_b = client.post("/api/v1/save-sessions")
        cookie_b = session_b.cookies["pb_save_session"]
        second = client.post(
            "/api/v1/saves",
            files={"photo": ("p.jpg", make_jpeg(), "image/jpeg")},
            data={"templateId": "fi-police-digital", "templateVersion": 1},
            headers={"Idempotency-Key": "test-idem-key-0008"},
            cookies={"pb_save_session": cookie_b},
        )
        assert second.status_code == 201
        assert second.json()["key"] != key1


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
        """未知 KEY 的每次失败都写失败桶（回归：旧断言恒真，删掉自增也不会红）。"""
        for _ in range(3):
            resp = client.post("/api/v1/retrievals/resolve", json={"key": "ZZZZZZ"})
            assert resp.status_code == 404

        from app.config import get_settings
        from app.db import connect

        conn = connect(get_settings().db_path)
        try:
            row = conn.execute(
                "SELECT COALESCE(SUM(count), 0) AS total FROM rate_limit_counts "
                "WHERE scope='resolve-fail'"
            ).fetchone()
        finally:
            conn.close()
        assert row["total"] == 3

    def test_successful_resolves_do_not_burn_the_failure_budget(self, client):
        """回归：同一合法 KEY 在窗口内可反复取回，成功路径一次都不写 resolve-fail 桶。"""
        key = save_flow(client)["key"]
        for _ in range(6):
            resp = client.post("/api/v1/retrievals/resolve", json={"key": key})
            assert resp.status_code == 200
            assert resp.json()["downloadToken"]

        from app.config import get_settings
        from app.db import connect

        conn = connect(get_settings().db_path)
        try:
            row = conn.execute(
                "SELECT COALESCE(SUM(count), 0) AS total FROM rate_limit_counts "
                "WHERE scope='resolve-fail'"
            ).fetchone()
        finally:
            conn.close()
        assert row["total"] == 0

    def test_resolve_fail_budget_gates_issuance_after_limit(self, client, monkeypatch):
        """闸门：同一 KEY 指纹本窗口失败满额后，记录恢复有效也拒绝签发（指纹/窗口对齐）。"""
        monkeypatch.setenv("PORTRAIT_RESOLVE_FAIL_LIMIT", "2")
        key = save_flow(client)["key"]

        from app import hmac_utils
        from app.config import get_settings
        from app.db import connect

        conn = connect(get_settings().db_path)
        try:
            # 先让记录过期，制造失败结局
            conn.execute(
                "UPDATE photo_records SET expires_at='2000-01-01T00:00:00Z' "
                "WHERE id IN (SELECT photo_id FROM key_registry WHERE key_fingerprint=?)",
                (hmac_utils.key_fingerprint(key),),
            )
            conn.commit()
        finally:
            conn.close()

        for _ in range(2):
            resp = client.post("/api/v1/retrievals/resolve", json={"key": key})
            assert resp.status_code == 404

        conn = connect(get_settings().db_path)
        try:
            # 恢复有效；失败额度已耗尽，闸门必须仍然拒绝签发
            conn.execute(
                "UPDATE photo_records SET expires_at='2099-01-01T00:00:00Z' "
                "WHERE id IN (SELECT photo_id FROM key_registry WHERE key_fingerprint=?)",
                (hmac_utils.key_fingerprint(key),),
            )
            conn.commit()
        finally:
            conn.close()

        resp = client.post("/api/v1/retrievals/resolve", json={"key": key})
        assert resp.status_code == 404
