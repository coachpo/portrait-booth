"""Staging/retrieval/delete end-to-end (SPEC §6.2~§6.5)."""

import io
import json
import random
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import get_settings
from app.db import connect
from app.image_validate import (
    ImageValidationError,
    SizeConstraint,
    validate_and_reencode,
)
from app.worker import purge_expired, sweep_orphans

# DB, object dir, and root secret are isolated per test case by conftest.py's
# isolated_runtime fixture


@pytest.fixture()
def client():
    from app.main import app

    return TestClient(app)


def make_jpeg(width=500, height=653, quality=92) -> bytes:
    img = Image.new("RGB", (width, height), (60, 120, 200))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def textured_jpeg(width=600, height=600, seed=7) -> bytes:
    """Lightly textured image: closer to a real photo's scale than a solid
    color, but still compressible into 240 KB."""
    rng = random.Random(seed)
    img = Image.new("RGB", (width, height))
    img.putdata(
        [
            (
                max(0, min(255, 60 + rng.randint(-18, 18))),
                max(0, min(255, 120 + rng.randint(-18, 18))),
                max(0, min(255, 200 + rng.randint(-18, 18))),
            )
            for _ in range(width * height)
        ]
    )
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=60)  # input bytes themselves must be ≤ cap (inbound gate)
    return buf.getvalue()


def save_us_visa(client, photo: bytes, key: str):
    """us-visa-digital-specific save (P6): save_flow hard-codes the fi
    template and cannot be reused."""
    session = client.post("/api/v1/save-sessions")
    assert session.status_code == 204
    cookie = session.cookies["pb_save_session"]
    return client.post(
        "/api/v1/saves",
        files={"photo": ("p.jpg", photo, "image/jpeg")},
        data={"templateId": "us-visa-digital", "templateVersion": 1},
        headers={"Idempotency-Key": key},
        cookies={"pb_save_session": cookie},
    )


def noise_image(width=600, height=600) -> Image.Image:
    """Per-pixel independent uniform random RGB noise (fixed seed for
    reproducibility)."""
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
    """Mirror of the frontend searchQuality (final-artifact.ts:208-241):
    binary search for the max feasible q.

    lo=0.40 / hi=0.95 / 10 steps / eps=0.005; the browser toBlob does not
    write ICC, so no icc_profile; when nothing is feasible, try q=40 once.
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
    """Create session → save → return the response JSON."""
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
        """A2 positive: once the client searched its artifact under the size
        cap, the server must not reject it with a fixed q92."""
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

        # Stored bytes still within the cap (via test_contract.py's DB-direct mode)
        conn = connect(get_settings().db_path)
        try:
            row = conn.execute("SELECT byte_length FROM photo_records").fetchone()
        finally:
            conn.close()
        assert row is not None and row["byte_length"] <= 240000

    def test_reencode_rejects_when_below_floor_still_over_limit(self, client):
        """A2 negative: direct validate_and_reencode must reject when even the
        lower bound 40 is still over."""
        img = noise_image()
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=20)  # high entropy but well below the floor
        data = buf.getvalue()
        settings = get_settings()
        assert len(data) <= 90000  # the inbound length gate (image_validate.py:33-34) is not hit

        with pytest.raises(ImageValidationError) as exc:
            validate_and_reencode(
                data,
                max_bytes=90000,
                max_pixels=settings.max_pixels,
                max_edge_px=settings.max_edge_px,
                constraint=SizeConstraint(exact=(600, 600), bounds=None, aspect=None, allowed=None),
                target_ppi=None,
                settings=settings,
            )
        assert exc.value.code == "PHOTO_TOO_LARGE"

    def test_us_visa_accepts_1200x1200_within_limit(self, client):
        """P6: the ranged template's upper band can be saved; the response
        reports the actual size 1200."""
        resp = save_us_visa(client, textured_jpeg(1200, 1200), "test-idem-key-p6-1200")
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["photo"]["width"] == 1200
        assert body["photo"]["height"] == 1200

    def test_us_visa_accepts_default_600x600(self, client):
        """P6: default band behavior unchanged."""
        resp = save_us_visa(client, textured_jpeg(600, 600), "test-idem-key-p6-0600")
        assert resp.status_code == 201, resp.text
        assert resp.json()["photo"]["width"] == 600

    def test_us_visa_rejects_out_of_range_1300(self, client):
        """P6: a band outside the template's range must 422, and the input is
        not oversized (1300² is under the pixel gate)."""
        resp = save_us_visa(client, textured_jpeg(1300, 1300), "test-idem-key-p6-1300")
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "PHOTO_SIZE_MISMATCH"

    def test_us_visa_rejects_off_aspect_1200x600(self, client):
        """P6: a size breaking the 1:1 aspect ratio must 422."""
        resp = save_us_visa(client, textured_jpeg(1200, 600), "test-idem-key-p6-1206")
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "PHOTO_SIZE_MISMATCH"

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
        """Regression: template maxBytes used to override the global cap
        entirely; lowering the global value must still reject the upload."""
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
        """Invariant: the session digest participates in the idempotency primary
        key; switching sessions switches namespaces, so the same idempotency key
        is a brand-new save."""
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

        # token is single-use: second consumption is 404
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
        # Repeated delete is also 204
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
        # The photo is still resolvable
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

            # Force expiry then purge
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
            assert state is not None  # retired items are kept forever
        finally:
            conn.close()

    def test_orphan_sweep_spares_objects_younger_than_the_age_gate(self, client):
        """Regression: without the age gate this sweep deletes bytes just
        written by an in-flight request."""
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

            # Age it past the gate, then sweep again
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
            # Referenced objects must not be swept no matter how old
            assert sweep_orphans(conn, storage, min_age_seconds=0) == 0
            assert storage.read(row["object_key"]) is not None
            assert body["key"]
        finally:
            conn.close()

    def test_user_delete_removes_the_bytes_immediately(self, client):
        """Regression: delete used to only mark status, leaving the original
        bytes on disk until the 30-day TTL."""
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
        """Every failure of an unknown KEY writes the failure bucket
        (regression: the old assertion was tautological and would stay green if
        the increment were deleted)."""
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
        """Regression: a legitimate KEY can be retrieved repeatedly within the
        window; the success path never writes the resolve-fail bucket."""
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
        """Gate: once the same KEY fingerprint has failed up to the limit in
        this window, issuance is refused even after the record is restored
        (fingerprint/window alignment)."""
        monkeypatch.setenv("PORTRAIT_RESOLVE_FAIL_LIMIT", "2")
        key = save_flow(client)["key"]

        from app import hmac_utils
        from app.config import get_settings
        from app.db import connect

        conn = connect(get_settings().db_path)
        try:
            # First expire the record to manufacture failure outcomes
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
            # Restore validity; the failure budget is exhausted, so the gate
            # must still refuse issuance
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
