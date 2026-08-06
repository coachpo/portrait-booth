"""配置与根密钥的启动期契约（A1）：不冻结、缺失即拒绝、示例文件与代码一致。"""

import base64
import re
import secrets
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import ConfigError, get_settings
from app.hmac_utils import SECRET_KEY_BASE_ENV, key_fingerprint, require_secret_key_base

REPO_ROOT = Path(__file__).resolve().parents[2]


class TestSettingsAreNotFrozenAtImport:
    def test_paths_follow_environment_changes(self, monkeypatch, tmp_path):
        """回归：db_path/storage_dir 曾是 dataclass 字段默认值，在 import 期求值。

        那种写法下 monkeypatch/tmp_path 对已导入的模块完全无效，
        所有用例共享同一个数据库，并发与清理行为无法被可信验证。
        """
        monkeypatch.setenv("PORTRAIT_DB_PATH", str(tmp_path / "a.db"))
        assert get_settings().db_path == str(tmp_path / "a.db")
        monkeypatch.setenv("PORTRAIT_DB_PATH", str(tmp_path / "b.db"))
        assert get_settings().db_path == str(tmp_path / "b.db")

    def test_numeric_settings_follow_environment(self, monkeypatch):
        monkeypatch.setenv("PORTRAIT_TTL_SECONDS", "600")
        assert get_settings().temporary_storage_ttl_seconds == 600

    def test_invalid_numeric_setting_is_rejected(self, monkeypatch):
        monkeypatch.setenv("PORTRAIT_TTL_SECONDS", "not-a-number")
        with pytest.raises(ConfigError):
            get_settings()

    def test_non_positive_numeric_setting_is_rejected(self, monkeypatch):
        monkeypatch.setenv("PORTRAIT_MAX_UPLOAD_BYTES", "0")
        with pytest.raises(ConfigError):
            get_settings()


class TestSecretKeyBase:
    def test_missing_root_key_refuses_startup(self, monkeypatch):
        monkeypatch.delenv(SECRET_KEY_BASE_ENV, raising=False)
        from app.main import app

        with pytest.raises(ConfigError, match=SECRET_KEY_BASE_ENV), TestClient(app):
            pass

    def test_short_root_key_is_rejected(self, monkeypatch):
        monkeypatch.setenv(
            SECRET_KEY_BASE_ENV, base64.urlsafe_b64encode(secrets.token_bytes(16)).decode("ascii")
        )
        with pytest.raises(ConfigError, match="至少需要"):
            require_secret_key_base()

    def test_malformed_root_key_is_rejected(self, monkeypatch):
        monkeypatch.setenv(SECRET_KEY_BASE_ENV, "!!!not-base64!!!")
        with pytest.raises(ConfigError, match="base64url"):
            require_secret_key_base()

    def test_same_root_key_survives_process_restart(self, monkeypatch):
        """A1 的核心验收：同一根密钥必须导出同一 KEY 指纹。

        旧实现用 os.urandom(32) 兜底，容器重启即换密钥，
        此前发出的每个 KEY 与删除密钥同时失效，而照片仍按 TTL 留存。
        """
        root = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
        monkeypatch.setenv(SECRET_KEY_BASE_ENV, root)
        first = key_fingerprint("ABC123")

        # 模拟重启：换一个根密钥再换回来，强制重新派生
        monkeypatch.setenv(
            SECRET_KEY_BASE_ENV, base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
        )
        assert key_fingerprint("ABC123") != first
        monkeypatch.setenv(SECRET_KEY_BASE_ENV, root)
        assert key_fingerprint("ABC123") == first

    def test_subkeys_are_domain_separated(self, monkeypatch):
        from app import hmac_utils

        root = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
        monkeypatch.setenv(SECRET_KEY_BASE_ENV, root)
        digests = {
            hmac_utils.key_fingerprint("SAME"),
            hmac_utils.secret_digest("SAME"),
            hmac_utils.idempotency_key_digest("SAME"),
            hmac_utils.session_digest("SAME"),
            hmac_utils.token_digest("SAME"),
        }
        assert len(digests) == 5


class TestEnvExample:
    def test_every_documented_variable_is_read_by_code(self):
        """.env.example 曾整份与代码对不上：照它配置得不到任何效果。"""
        example = (REPO_ROOT / ".env.example").read_text(encoding="utf-8")
        documented = set(re.findall(r"^([A-Z][A-Z0-9_]*)=", example, flags=re.MULTILINE))
        assert documented, ".env.example 必须列出可配置变量"

        sources = "\n".join(
            p.read_text(encoding="utf-8") for p in (REPO_ROOT / "backend" / "app").rglob("*.py")
        )
        unread = sorted(name for name in documented if name not in sources)
        assert not unread, f".env.example 中这些变量没有任何代码读取：{unread}"

    def test_compose_passes_the_root_key(self):
        compose = (REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        assert SECRET_KEY_BASE_ENV in compose
        # 缺失时必须让 compose 直接失败，而不是把空串传进去
        assert f"{SECRET_KEY_BASE_ENV}:?" in compose
