"""Common isolation for backend tests: each test case gets its own root
secret, DB, and object directory.

Settings and HMAC subkeys are read from environment variables at call time,
so monkeypatch is enough for isolation.
If they ever regress to import-time constants, the isolation in this file
silently stops working - the regressions in test_config.py are responsible for
making that regression fail directly.
"""

import base64
import secrets

import pytest


@pytest.fixture(autouse=True)
def isolated_runtime(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "PORTRAIT_SECRET_KEY_BASE",
        base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii"),
    )
    monkeypatch.setenv("PORTRAIT_DB_PATH", str(tmp_path / "portrait.db"))
    monkeypatch.setenv("PORTRAIT_STORAGE_DIR", str(tmp_path / "objects"))
    yield
