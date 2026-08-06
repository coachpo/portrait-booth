"""服务政策与运行配置（SPEC §6.0）。到期时间只由服务端政策决定。"""

import os
from dataclasses import dataclass
from pathlib import Path

RETRIEVAL_MODE = "key_only_ephemeral"


@dataclass(frozen=True)
class Settings:
    temporary_storage_ttl_seconds: int = 30 * 24 * 3600  # §1.2.1 产品确认 30 天
    max_upload_bytes: int = 15 * 1024 * 1024
    max_pixels: int = 24_000_000
    max_edge_px: int = 8000
    policy_version: int = 1
    security_policy_version: int = 1

    save_session_cookie_max_age: int = 600
    idempotency_window_seconds: int = 600
    download_token_ttl_seconds: int = 60

    key_length: int = 6
    key_charset: str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    secret_bytes: int = 16  # >= 128 比特

    # 限速（§9.3）：同 KEY 指纹 15 分钟 5 次失败；同 IP 每小时 30 次
    resolve_fail_window_seconds: int = 900
    resolve_fail_limit: int = 5
    resolve_ip_window_seconds: int = 3600
    resolve_ip_limit: int = 30

    db_path: str = os.environ.get("PORTRAIT_DB_PATH", "data/portrait.db")
    storage_dir: str = os.environ.get("PORTRAIT_STORAGE_DIR", "data/objects")
    purge_interval_seconds: int = 300

    @property
    def storage_path(self) -> Path:
        return Path(self.storage_dir)


def get_settings() -> Settings:
    return Settings()
