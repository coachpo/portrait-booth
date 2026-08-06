"""服务政策与运行配置（SPEC §6.0）。到期时间只由服务端政策决定。

配置在每次 get_settings() 调用时读取环境变量，不在 import 期冻结：
部署侧重启即换配置，测试侧 monkeypatch 可做到逐用例隔离。
"""

import os
from dataclasses import dataclass
from pathlib import Path

RETRIEVAL_MODE = "key_only_ephemeral"

DEFAULT_DB_PATH = "data/portrait.db"
DEFAULT_STORAGE_DIR = "data/objects"


class ConfigError(RuntimeError):
    """配置缺失或不合法。启动期抛出，不进入运行态。"""


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} 需要整数，收到 {raw!r}") from None
    if value <= 0:
        raise ConfigError(f"{name} 需要正整数，收到 {value}")
    return value


def _env_str(name: str, default: str) -> str:
    return os.environ.get(name, "").strip() or default


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
    # 一次保存的处理租约：超过它仍是 processing 就认为上一次请求已经死掉，可以接管
    idempotency_lease_seconds: int = 60
    download_token_ttl_seconds: int = 60

    key_length: int = 6
    key_charset: str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    secret_bytes: int = 16  # >= 128 比特

    # 限速（§9.3）：同 KEY 指纹 15 分钟 5 次失败；同 IP 每小时 30 次
    resolve_fail_window_seconds: int = 900
    resolve_fail_limit: int = 5
    resolve_ip_window_seconds: int = 3600
    resolve_ip_limit: int = 30
    resolve_ipv4_24_limit: int = 120

    db_path: str = DEFAULT_DB_PATH
    storage_dir: str = DEFAULT_STORAGE_DIR
    purge_interval_seconds: int = 300

    # staging 对象在被 orphan sweep 回收前的最小存活时间（§8.2）：
    # 保存请求先写对象再提交事务，门限过短会删掉进行中请求刚写入的对象。
    orphan_min_age_seconds: int = 900

    # 取回响应的目标恒定处理时间（§6.5 / SAV-008）
    resolve_constant_time_ms: int = 120

    require_same_origin: bool = True
    hsts_max_age_seconds: int = 63072000

    @property
    def storage_path(self) -> Path:
        return Path(self.storage_dir)


def get_settings() -> Settings:
    return Settings(
        temporary_storage_ttl_seconds=_env_int(
            "PORTRAIT_TTL_SECONDS", Settings.temporary_storage_ttl_seconds
        ),
        max_upload_bytes=_env_int("PORTRAIT_MAX_UPLOAD_BYTES", Settings.max_upload_bytes),
        max_pixels=_env_int("PORTRAIT_MAX_PIXELS", Settings.max_pixels),
        max_edge_px=_env_int("PORTRAIT_MAX_EDGE_PX", Settings.max_edge_px),
        resolve_fail_limit=_env_int("PORTRAIT_RESOLVE_FAIL_LIMIT", Settings.resolve_fail_limit),
        resolve_ip_limit=_env_int("PORTRAIT_RESOLVE_IP_LIMIT", Settings.resolve_ip_limit),
        resolve_ipv4_24_limit=_env_int(
            "PORTRAIT_RESOLVE_IPV4_24_LIMIT", Settings.resolve_ipv4_24_limit
        ),
        db_path=_env_str("PORTRAIT_DB_PATH", DEFAULT_DB_PATH),
        storage_dir=_env_str("PORTRAIT_STORAGE_DIR", DEFAULT_STORAGE_DIR),
        purge_interval_seconds=_env_int(
            "PORTRAIT_PURGE_INTERVAL_SECONDS", Settings.purge_interval_seconds
        ),
        orphan_min_age_seconds=_env_int(
            "PORTRAIT_ORPHAN_MIN_AGE_SECONDS", Settings.orphan_min_age_seconds
        ),
        require_same_origin=_env_str("PORTRAIT_REQUIRE_SAME_ORIGIN", "1") != "0",
    )
