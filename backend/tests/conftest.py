"""后端测试的公共隔离：每个用例独立根密钥、DB 与对象目录。

Settings 与 HMAC 子密钥都在调用时读取环境变量，所以 monkeypatch 足以隔离。
一旦它们回退成 import 期常量，本文件的隔离会静默失效——
test_config.py 中的回归用例负责让这种回退直接失败。
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
