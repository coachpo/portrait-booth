"""Startup contract for config and the root secret (A1): not frozen,
refuses to start when missing, sample file consistent with code."""

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
        """Regression: db_path/storage_dir used to be dataclass field defaults
        evaluated at import time.

        Under that approach monkeypatch/tmp_path had no effect on already
        imported modules, all tests shared one database, and concurrency and
        cleanup behavior could not be verified credibly.
        """
        monkeypatch.setenv("PORTRAIT_DB_PATH", str(tmp_path / "a.db"))
        assert get_settings().db_path == str(tmp_path / "a.db")
        monkeypatch.setenv("PORTRAIT_DB_PATH", str(tmp_path / "b.db"))
        assert get_settings().db_path == str(tmp_path / "b.db")

    def test_numeric_settings_follow_environment(self, monkeypatch):
        monkeypatch.setenv("PORTRAIT_TTL_SECONDS", "600")
        assert get_settings().temporary_storage_ttl_seconds == 600

    def test_idempotency_window_follows_environment(self, monkeypatch):
        monkeypatch.setenv("PORTRAIT_IDEMPOTENCY_WINDOW_SECONDS", "60")
        assert get_settings().idempotency_window_seconds == 60
        monkeypatch.delenv("PORTRAIT_IDEMPOTENCY_WINDOW_SECONDS", raising=False)
        assert get_settings().idempotency_window_seconds == 600

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
        with pytest.raises(ConfigError, match="at least"):
            require_secret_key_base()

    def test_malformed_root_key_is_rejected(self, monkeypatch):
        monkeypatch.setenv(SECRET_KEY_BASE_ENV, "!!!not-base64!!!")
        with pytest.raises(ConfigError, match="base64url"):
            require_secret_key_base()

    def test_same_root_key_survives_process_restart(self, monkeypatch):
        """A1's core acceptance: the same root key must derive the same KEY
        fingerprint.

        The old implementation fell back to os.urandom(32), so every container
        restart rotated the key, invalidating every previously issued KEY and
        delete secret while photos stayed for the TTL.
        """
        root = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
        monkeypatch.setenv(SECRET_KEY_BASE_ENV, root)
        first = key_fingerprint("ABC123")

        # Simulate a restart: switch the root key and switch back, forcing
        # re-derivation
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
        """.env.example used to be entirely out of sync with the code:
        configuring per it had no effect at all."""
        example = (REPO_ROOT / ".env.example").read_text(encoding="utf-8")
        documented = set(re.findall(r"^([A-Z][A-Z0-9_]*)=", example, flags=re.MULTILINE))
        assert documented, ".env.example must list the configurable variables"

        sources = "\n".join(
            p.read_text(encoding="utf-8") for p in (REPO_ROOT / "backend" / "app").rglob("*.py")
        )
        unread = sorted(name for name in documented if name not in sources)
        assert not unread, f"these .env.example variables are read by no code: {unread}"

    def test_compose_passes_the_root_key(self):
        compose = (REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        assert SECRET_KEY_BASE_ENV in compose
        # Missing must fail compose outright, not pass an empty string through
        assert f"{SECRET_KEY_BASE_ENV}:?" in compose


class TestTemplatesDirectory:
    """The templates root used to be derived from the module's own location.
    That is correct for the source layout and wrong for the image, where the
    code sits at /app/app and the derived root becomes "/" - every template
    request answered 500 while the healthcheck still reported healthy."""

    def test_environment_overrides_the_derived_root(self, monkeypatch, tmp_path):
        from app.template_store import (
            default_publications_file,
            default_revisions_dir,
            templates_dir,
        )

        monkeypatch.setenv("PORTRAIT_TEMPLATES_DIR", str(tmp_path))
        assert templates_dir() == tmp_path
        assert default_revisions_dir() == tmp_path / "revisions"
        assert default_publications_file() == tmp_path / "publications.json"

    def test_blank_value_falls_back_to_the_derived_root(self, monkeypatch):
        from app.template_store import templates_dir

        monkeypatch.setenv("PORTRAIT_TEMPLATES_DIR", "   ")
        assert (templates_dir() / "publications.json").is_file()

    def test_default_still_resolves_inside_the_repository(self, monkeypatch):
        from app.template_store import load_template_catalog, templates_dir

        monkeypatch.delenv("PORTRAIT_TEMPLATES_DIR", raising=False)
        assert templates_dir() == REPO_ROOT / "templates"
        assert load_template_catalog()

    def test_catalog_loads_from_an_image_style_layout(self, monkeypatch, tmp_path):
        """Reproduces the container layout: templates live somewhere the module
        path cannot derive, reachable only through the environment variable."""
        import shutil

        from app.template_store import load_template_catalog

        relocated = tmp_path / "opt" / "portrait-templates"
        shutil.copytree(REPO_ROOT / "templates", relocated)
        monkeypatch.setenv("PORTRAIT_TEMPLATES_DIR", str(relocated))
        assert load_template_catalog()

    def test_image_pins_the_templates_directory(self):
        """A Dockerfile that copies templates to /app/templates without pinning
        the variable reintroduces the 500."""
        dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")
        assert "PORTRAIT_TEMPLATES_DIR=" in dockerfile
        copy_target = re.search(r"^COPY templates/ (\S+)", dockerfile, flags=re.MULTILINE)
        assert copy_target, "Dockerfile must copy the templates directory"
        pinned = re.search(r"PORTRAIT_TEMPLATES_DIR=(\S+)", dockerfile)
        assert pinned
        # WORKDIR is /app, so a relative COPY target lands under it
        target = copy_target.group(1).rstrip("/")
        expected = target if target.startswith("/") else f"/app/{target}"
        assert pinned.group(1).rstrip("/") == expected
