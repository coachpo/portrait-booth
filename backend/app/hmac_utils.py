"""域隔离、版本化 HMAC（§6.2/§7/§9.3）。
密钥指纹、secret 摘要、幂等键摘要、下载 token 摘要与对象 MAC 全部使用独立命名空间，
不产生可跨域关联的普通内容哈希。

全部子密钥由单一根密钥 PORTRAIT_SECRET_KEY_BASE 经 HKDF-SHA256 派生。
根密钥缺失即拒绝启动：进程随机密钥会让重启前发出的每个 KEY 与删除密钥同时失效，
而照片仍按 TTL 留存，用户既取不回也删不掉。
"""

import base64
import binascii
import hashlib
import hmac
import os
from collections.abc import Callable

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .config import ConfigError

DigestFn = Callable[[bytes], bytes]

SECRET_KEY_BASE_ENV = "PORTRAIT_SECRET_KEY_BASE"
MIN_KEY_BASE_BYTES = 32

_GENERATE_HINT = (
    'python -c "import secrets,base64;'
    'print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"'
)

# 按根密钥原文缓存派生结果：根密钥变化（测试隔离、轮换）时整体失效。
_derived: dict[str, bytes] = {}
_derived_for: str | None = None


def _decode_key_base(raw: str) -> bytes:
    padded = raw + "=" * (-len(raw) % 4)
    try:
        return base64.urlsafe_b64decode(padded)
    except (binascii.Error, ValueError):
        raise ConfigError(
            f"{SECRET_KEY_BASE_ENV} 不是合法的 base64url。生成方式：{_GENERATE_HINT}"
        ) from None


def require_secret_key_base() -> bytes:
    """校验根密钥并返回其字节。缺失或过短时抛 ConfigError，供启动期 fail-fast。"""
    raw = os.environ.get(SECRET_KEY_BASE_ENV, "").strip()
    if not raw:
        raise ConfigError(
            f"缺少 {SECRET_KEY_BASE_ENV}：没有持久根密钥时，重启会让此前发出的全部 KEY "
            f"与删除密钥失效，而照片仍按 TTL 留存。生成方式：{_GENERATE_HINT}"
        )
    key = _decode_key_base(raw)
    if len(key) < MIN_KEY_BASE_BYTES:
        raise ConfigError(
            f"{SECRET_KEY_BASE_ENV} 解码后为 {len(key)} 字节，"
            f"至少需要 {MIN_KEY_BASE_BYTES} 字节。生成方式：{_GENERATE_HINT}"
        )
    return key


def _subkey(label: str) -> bytes:
    global _derived_for
    raw = os.environ.get(SECRET_KEY_BASE_ENV, "").strip()
    if raw != _derived_for:
        _derived.clear()
        _derived_for = raw
    cached = _derived.get(label)
    if cached is None:
        cached = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=f"portrait-booth/{label}".encode(),
        ).derive(require_secret_key_base())
        _derived[label] = cached
    return cached


def envelope_key() -> bytes:
    """幂等响应 envelope 的 Fernet 密钥（urlsafe base64 的 32 字节）。"""
    return base64.urlsafe_b64encode(_subkey("envelope"))


def _hmac(key: bytes, namespace: str, value: bytes) -> bytes:
    return hmac.new(key, namespace.encode("utf-8") + b"\x00" + value, hashlib.sha256).digest()


def key_fingerprint(normalized_key: str) -> str:
    return _hmac(_subkey("lifetime"), "key-fingerprint-v1", normalized_key.encode("utf-8")).hex()


def secret_digest(secret: str) -> str:
    return _hmac(_subkey("lifetime"), "secret-digest-v1", secret.encode("utf-8")).hex()


def idempotency_key_digest(idempotency_key: str) -> str:
    return _hmac(_subkey("lifetime"), "idempotency-v1", idempotency_key.encode("utf-8")).hex()


def session_digest(session_id: str) -> str:
    return _hmac(_subkey("lifetime"), "session-v1", session_id.encode("utf-8")).hex()


def token_digest(token: str) -> str:
    return _hmac(_subkey("token"), "download-token-v1", token.encode("utf-8")).hex()


def object_integrity_mac(object_name: str, byte_length: int, content_sha256: str) -> str:
    """对象完整性 MAC（§8.2）：绑定对象名、字节长度与内容摘要。

    只绑定名字与长度时，同长度的任意字节替换都不会被发现。
    """
    payload = f"{object_name}\x00{byte_length}\x00{content_sha256}".encode()
    return _hmac(_subkey("object"), "object-integrity-v2", payload).hex()


def rate_fingerprint(scope: str, value: str) -> str:
    """限速用短期指纹（§9.3）：独立每日轮换密钥，不复用 Key Registry digest。"""
    return _hmac(_subkey("rate"), f"rate-{scope}-v1", value.encode("utf-8")).hex()


def request_digest(photo_bytes: bytes, template_id: str, template_version: int) -> str:
    """§6.2 请求摘要：长度前缀编码，不包含 boundary/filename/MIME。"""
    parts = [
        b"save-v1",
        len(photo_bytes).to_bytes(8, "big"),
        photo_bytes,
        len(template_id.encode("utf-8")).to_bytes(8, "big"),
        template_id.encode("utf-8"),
        template_version.to_bytes(8, "big"),
    ]
    return _hmac(_subkey("request"), "save-request-v1", b"".join(parts)).hex()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
