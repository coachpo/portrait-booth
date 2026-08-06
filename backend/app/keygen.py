"""KEY 与 secret 生成（SAV-003/006）与 KEY 归一化（SAV-004）。"""

import base64
import os
import re
import secrets
from collections.abc import Callable

from .config import Settings, get_settings

Rng = Callable[[int], int]

KEY_RE = re.compile(r"^[A-Z0-9]{6}$")


def normalize_key(raw: str) -> str:
    """SAV-004：去空格/ASCII 连字符、字母转大写；保留前导 0；非法字符不静默映射。"""
    cleaned = re.sub(r"[\s-]", "", raw).upper()
    if not KEY_RE.match(cleaned):
        raise ValueError("invalid key format")
    return cleaned


def generate_key(rng: Rng | None = None, settings: Settings | None = None) -> str:
    """SAV-003：CSPRNG 拒绝采样，无模偏差；每位置独立取值，不强制字母/数字配比。"""
    cfg = settings or get_settings()
    charset = cfg.key_charset
    n = len(charset)
    r = rng or secrets.randbelow
    # 拒绝采样：拒绝 randbelow(2^k) >= n 的样本
    k = n.bit_length()
    limit = (1 << k) - (1 << k) % n
    chars: list[str] = []
    for _ in range(cfg.key_length):
        while True:
            v = r(1 << k)
            if v < limit:
                break
        chars.append(charset[v % n])
    return "".join(chars)


def generate_secret(rng: Rng | None = None, settings: Settings | None = None) -> str:
    """SAV-006：独立 ≥128 比特删除密钥，base64url 编码。"""
    cfg = settings or get_settings()
    raw = bytearray()
    for _ in range(cfg.secret_bytes):
        raw.append((rng or secrets.randbelow)(256))
    return base64.urlsafe_b64encode(bytes(raw)).rstrip(b"=").decode("ascii")


def key_display(key: str) -> str:
    """显示分组 `A7C 2F9`；规范值仍是 `A7C2F9`（SAV-004）。"""
    return f"{key[:3]} {key[3:]}"


def random_session_id(rng: Rng | None = None) -> str:
    """保存会话 ID（≥128 比特随机）。"""
    return secrets.token_hex(16) if rng is None else f"{rng(1 << 128):032x}"


def random_object_name(rng: Rng | None = None) -> str:
    """对象存储随机路径名，与 KEY 无关（SPEC §8.2）。"""
    return secrets.token_hex(16) if rng is None else f"{rng(1 << 128):032x}"


def random_token(rng: Rng | None = None) -> str:
    """下载 token（≥128 比特，单次用途）。"""
    return secrets.token_urlsafe(16) if rng is None else f"tok-{rng(1 << 128):032x}"


if os.environ.get("PORTRAIT_DEV_RNG") == "1":  # pragma: no cover - 测试直接注入
    pass
