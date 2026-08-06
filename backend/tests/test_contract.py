"""API 契约硬化（B1/B2/B5/B6）。"""

import io
import json
import threading

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import get_settings
from app.db import connect
from app.storage import Storage


@pytest.fixture()
def client():
    from app.main import app

    return TestClient(app)


def make_jpeg(width=500, height=653, quality=92) -> bytes:
    img = Image.new("RGB", (width, height), (60, 120, 200))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def new_session(client) -> str:
    session = client.post("/api/v1/save-sessions")
    assert session.status_code == 204
    return session.cookies["pb_save_session"]


def post_save(client, cookie: str, idem: str, photo: bytes | None = None):
    return client.post(
        "/api/v1/saves",
        files={"photo": ("p.jpg", photo or make_jpeg(), "image/jpeg")},
        data={"templateId": "fi-police-digital", "templateVersion": 1},
        headers={"Idempotency-Key": idem},
        cookies={"pb_save_session": cookie},
    )


def save_once(client, idem="contract-key-000000001", cookie: str | None = None) -> dict:
    """幂等作用域是（匿名会话 × 幂等键）：重放必须用同一个会话 cookie。"""
    resp = post_save(client, cookie or new_session(client), idem)
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestDownloadTokenIsAtomic:
    def test_concurrent_downloads_consume_the_token_once(self, client):
        """回归：先 SELECT 再无条件 UPDATE 是 check-then-act，
        两个并发请求都能通过检查，单次凭证事实上可重复使用。"""
        body = save_once(client)
        token = client.post("/api/v1/retrievals/resolve", json={"key": body["key"]}).json()[
            "downloadToken"
        ]

        results: list[int] = []
        lock = threading.Lock()

        def download():
            resp = client.post(
                "/api/v1/retrievals/download", headers={"Authorization": f"Bearer {token}"}
            )
            with lock:
                results.append(resp.status_code)

        threads = [threading.Thread(target=download) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert results.count(200) == 1, f"单次凭证被消费了 {results.count(200)} 次"
        assert results.count(404) == len(results) - 1

    def test_sequential_second_download_is_rejected(self, client):
        body = save_once(client)
        token = client.post("/api/v1/retrievals/resolve", json={"key": body["key"]}).json()[
            "downloadToken"
        ]
        headers = {"Authorization": f"Bearer {token}"}
        assert client.post("/api/v1/retrievals/download", headers=headers).status_code == 200
        assert client.post("/api/v1/retrievals/download", headers=headers).status_code == 404


class TestIdempotencyLease:
    def test_replay_returns_the_same_envelope(self, client):
        cookie = new_session(client)
        first = save_once(client, "lease-key-00000000001", cookie)
        second = save_once(client, "lease-key-00000000001", cookie)
        assert first == second

    def test_in_progress_lease_answers_409_with_retry_after(self, client):
        """并发保存必须是 409 + Retry-After，而不是跑完两遍再撞主键返回 500。"""
        cookie = new_session(client)
        assert save_once(client, "lease-key-00000000002", cookie)["key"]

        # 手工把租约改回 processing，模拟另一个请求正持有它
        conn = connect(get_settings().db_path)
        try:
            conn.execute(
                "UPDATE save_idempotency_records SET status='processing', "
                "encrypted_response_envelope=NULL"
            )
            conn.commit()
        finally:
            conn.close()

        resp = post_save(client, cookie, "lease-key-00000000002")
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "IDEMPOTENCY_IN_PROGRESS"
        assert int(resp.headers["Retry-After"]) >= 1

    def test_a_failed_attempt_releases_the_lease(self, client):
        """失败必须释放租约，否则用户在租约到期前连重试都做不到。"""
        cookie = new_session(client)
        bad_photo = make_jpeg(100, 100)
        first = post_save(client, cookie, "lease-key-00000000003", bad_photo)
        assert first.status_code == 422

        conn = connect(get_settings().db_path)
        try:
            row = conn.execute("SELECT status FROM save_idempotency_records").fetchone()
        finally:
            conn.close()
        assert row["status"] == "failed", "失败的租约留在 processing 会把幂等键锁死"

        # 同一份内容重试：拿到的是真实原因，而不是 409 IDEMPOTENCY_IN_PROGRESS
        retry = post_save(client, cookie, "lease-key-00000000003", bad_photo)
        assert retry.status_code == 422
        assert retry.json()["error"]["code"] == "PHOTO_SIZE_MISMATCH"

    def test_changing_the_payload_under_one_key_is_a_conflict(self, client):
        """幂等键绑定内容：换了照片就不再是同一次保存。"""
        cookie = new_session(client)
        assert post_save(client, cookie, "lease-key-00000000006").status_code == 201
        resp = post_save(client, cookie, "lease-key-00000000006", make_jpeg(quality=60))
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"

    def test_only_one_photo_survives_a_concurrent_double_submit(self, client):
        cookie = new_session(client)
        photo = make_jpeg()
        statuses: list[int] = []
        lock = threading.Lock()

        def submit():
            resp = post_save(client, cookie, "lease-key-00000000004", photo)
            with lock:
                statuses.append(resp.status_code)

        threads = [threading.Thread(target=submit) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert 500 not in statuses, f"并发重复提交不应产生 500：{statuses}"
        conn = connect(get_settings().db_path)
        try:
            count = conn.execute("SELECT COUNT(*) AS n FROM photo_records").fetchone()["n"]
        finally:
            conn.close()
        assert count == 1, f"同一幂等键只应产生一张照片，实际 {count}"

    def test_expired_records_are_purged(self, client):
        from app.save_service import purge_expired_idempotency

        save_once(client, "lease-key-00000000005")
        conn = connect(get_settings().db_path)
        try:
            # envelope 里是 KEY 与删除密钥的密文，长期保留等于让它们无限期可重放
            removed = purge_expired_idempotency(conn, now_ts=2_000_000_000, window=600)
            assert removed == 1
            left = conn.execute("SELECT COUNT(*) AS n FROM save_idempotency_records").fetchone()
            assert left["n"] == 0
        finally:
            conn.close()


class TestSameOrigin:
    def test_rejects_a_cross_origin_save_session(self, client):
        resp = client.post(
            "/api/v1/save-sessions",
            headers={"Origin": "https://evil.example", "Host": "testserver"},
        )
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "CROSS_ORIGIN_REJECTED"

    def test_rejects_a_cross_site_browser_request_without_origin(self, client):
        """只看 Origin 不够：同站导航式的跨站提交可以完全不带 Origin。"""
        resp = client.post(
            "/api/v1/retrievals/resolve",
            json={"key": "ZZZZZZ"},
            headers={"Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "cross-site"},
        )
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "CROSS_ORIGIN_REJECTED"

    def test_allows_a_same_origin_browser_request(self, client):
        resp = client.post(
            "/api/v1/save-sessions",
            headers={"Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin"},
        )
        assert resp.status_code == 204

    def test_allows_non_browser_clients(self, client):
        # curl 一类客户端没有 Sec-Fetch-*，不应被误伤
        assert client.post("/api/v1/save-sessions").status_code == 204


class TestErrorContract:
    def test_validation_errors_use_the_error_envelope(self, client):
        session = client.post("/api/v1/save-sessions")
        resp = client.post(
            "/api/v1/saves",
            data={"templateVersion": "not-an-int"},
            headers={"Idempotency-Key": "contract-key-000000009"},
            cookies={"pb_save_session": session.cookies["pb_save_session"]},
        )
        assert resp.status_code == 422
        body = resp.json()
        assert "detail" not in body
        assert body["error"]["code"] == "VALIDATION_FAILED"
        assert body["error"]["requestId"]

    def test_every_error_carries_a_request_id(self, client):
        resp = client.post("/api/v1/retrievals/resolve", json={"key": "ZZZZZZ"})
        assert resp.status_code == 404
        assert len(resp.json()["error"]["requestId"]) >= 8

    def test_request_ids_are_unique_per_response(self, client):
        ids = {
            client.post("/api/v1/retrievals/resolve", json={"key": "ZZZZZZ"}).json()["error"][
                "requestId"
            ]
            for _ in range(3)
        }
        assert len(ids) == 3


class TestObjectIntegrity:
    def test_download_rejects_bytes_that_do_not_match_the_record(self, client):
        """回归：objectIntegrityMac 只绑定名字与长度，且写入后从未被校验。"""
        body = save_once(client, "contract-key-000000010")
        conn = connect(get_settings().db_path)
        try:
            row = conn.execute("SELECT object_key, byte_length FROM photo_records").fetchone()
        finally:
            conn.close()

        storage = Storage()
        original = storage.read(row["object_key"])
        assert original is not None
        # 等长替换：长度检查完全看不出来
        (storage.base / row["object_key"]).write_bytes(b"\x00" * len(original))

        token = client.post("/api/v1/retrievals/resolve", json={"key": body["key"]}).json()[
            "downloadToken"
        ]
        resp = client.post(
            "/api/v1/retrievals/download", headers={"Authorization": f"Bearer {token}"}
        )
        assert resp.status_code == 404
        assert json.loads(resp.content)["error"]["code"] == "PHOTO_UNAVAILABLE"


class TestDeleteReportsFailureHonestly:
    """回归：整个 delete_save 被一个 except Exception 兜成 204。

    撤销事务没提交时接口也报成功：UI 说「已删除」，照片却仍是 active、仍可取回。
    """

    @staticmethod
    def _delete(client, body):
        return client.request(
            "DELETE",
            "/api/v1/saves",
            content=json.dumps({"key": body["key"], "deleteSecret": body["deleteSecret"]}),
            headers={"Content-Type": "application/json"},
        )

    def test_a_failed_revocation_is_not_reported_as_success(self, client, monkeypatch):
        import sqlite3

        from app.routers import saves as saves_router

        body = save_once(client, "contract-key-000000011")
        real_db = saves_router._db

        class LockedConn:
            """模拟撤销那条 UPDATE 撞上写锁。"""

            def __init__(self, inner):
                self._inner = inner

            def execute(self, sql, *args, **kwargs):
                if "access-revoked" in sql:
                    raise sqlite3.OperationalError("database is locked")
                return self._inner.execute(sql, *args, **kwargs)

            def __getattr__(self, name):
                return getattr(self._inner, name)

        # 用 context 而不是 undo()：conftest 的环境隔离用的是同一个 monkeypatch
        # 实例，undo() 会把根密钥一起撤销掉
        with monkeypatch.context() as m:
            m.setattr(saves_router, "_db", lambda: LockedConn(real_db()))
            resp = self._delete(client, body)
        assert resp.status_code == 503
        assert resp.json()["error"]["code"] == "DELETE_UNAVAILABLE"

        # 照片确实还在——所以接口报失败是对的
        assert (
            client.post("/api/v1/retrievals/resolve", json={"key": body["key"]}).status_code == 200
        )

    def test_a_failed_byte_purge_still_counts_as_deleted(self, client, monkeypatch):
        """撤销已经提交后，物理删除失败不该把「已删除」收回——
        照片此时已经取不回，worker 的 purge_due 会补上字节清理。"""
        from app.routers import saves as saves_router

        body = save_once(client, "contract-key-000000012")

        def boom(*_args, **_kwargs):
            raise OSError("volume unavailable")

        with monkeypatch.context() as m:
            m.setattr(saves_router, "purge_photo", boom)
            assert self._delete(client, body).status_code == 204

        resolved = client.post("/api/v1/retrievals/resolve", json={"key": body["key"]})
        assert resolved.status_code == 404
        assert resolved.json()["error"]["code"] == "PHOTO_UNAVAILABLE"

    def test_a_normal_delete_still_returns_204(self, client):
        body = save_once(client, "contract-key-000000013")
        assert self._delete(client, body).status_code == 204
        assert self._delete(client, body).status_code == 204
