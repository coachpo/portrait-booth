"""域隔离、版本化 HMAC（§6.2/§7/§9.3）。
密钥指纹、secret 摘要、幂等键摘要、下载 token 摘要与对象 MAC 全部使用独立命名空间，
不产生可跨域关联的普通内容哈希。"""

import hashlib
import hmac
import os
from collections.abc import Callable

DigestFn = Callable[[bytes], bytes]

# 服务端启动时生成的生命周期密钥（重启即失效；生产应注入持久密钥）
_LIFETIME_KEY = os.environ.get("PORTRAIT_LIFETIME_KEY", "").encode("utf-8") or os.urandom(32)
_REQUEST_KEY = os.environ.get("PORTRAIT_REQUEST_KEY", "").encode("utf-8") or os.urandom(32)
_OBJECT_KEY = os.environ.get("PORTRAIT_OBJECT_KEY", "").encode("utf-8") or os.urandom(32)
_TOKEN_KEY = os.environ.get("PORTRAIT_TOKEN_KEY", "").encode("utf-8") or os.urandom(32)
_RATE_KEY = os.environ.get("PORTRAIT_RATE_KEY", "").encode("utf-8") or os.urandom(32)


def _hmac(key: bytes, namespace: str, value: bytes) -> bytes:
    return hmac.new(key, namespace.encode("utf-8") + b"\x00" + value, hashlib.sha256).digest()


def key_fingerprint(normalized_key: str) -> str:
    return _hmac(_LIFETIME_KEY, "key-fingerprint-v1", normalized_key.encode("utf-8")).hex()


def secret_digest(secret: str) -> str:
    return _hmac(_LIFETIME_KEY, "secret-digest-v1", secret.encode("utf-8")).hex()


def idempotency_key_digest(idempotency_key: str) -> str:
    return _hmac(_LIFETIME_KEY, "idempotency-v1", idempotency_key.encode("utf-8")).hex()


def session_digest(session_id: str) -> str:
    return _hmac(_LIFETIME_KEY, "session-v1", session_id.encode("utf-8")).hex()


def token_digest(token: str) -> str:
    return _hmac(_TOKEN_KEY, "download-token-v1", token.encode("utf-8")).hex()


def object_integrity_mac(object_name: str, byte_length: int) -> str:
    payload = f"{object_name}\x00{byte_length}".encode()
    return _hmac(_OBJECT_KEY, "object-integrity-v1", payload).hex()


def rate_fingerprint(scope: str, value: str) -> str:
    """限速用短期指纹（§9.3）：独立每日轮换密钥，不复用 Key Registry digest。"""
    return _hmac(_RATE_KEY, f"rate-{scope}-v1", value.encode("utf-8")).hex()


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
    return _hmac(_REQUEST_KEY, "save-request-v1", b"".join(parts)).hex()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
