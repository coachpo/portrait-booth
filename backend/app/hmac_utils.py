"""Domain-isolated, versioned HMAC (§6.2/§7/§9.3).
Key fingerprints, secret digests, idempotency-key digests, download-token
digests, and object MACs each use an independent namespace, so no plain
content hash can be correlated across domains.

All subkeys are derived from the single root key PORTRAIT_SECRET_KEY_BASE via
HKDF-SHA256.
A missing root key means refusing to start: a per-process random key would
invalidate every previously issued KEY and delete secret on restart while
photos stay for the TTL, leaving users unable to retrieve or delete them.
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

# Cache derivation results keyed by the root key's raw text: the whole cache
# is invalidated when the root key changes (test isolation, rotation).
_derived: dict[str, bytes] = {}
_derived_for: str | None = None


def _decode_key_base(raw: str) -> bytes:
    padded = raw + "=" * (-len(raw) % 4)
    try:
        return base64.urlsafe_b64decode(padded)
    except (binascii.Error, ValueError):
        raise ConfigError(
            f"{SECRET_KEY_BASE_ENV} is not valid base64url. Generate with: {_GENERATE_HINT}"
        ) from None


def require_secret_key_base() -> bytes:
    """Validate the root key and return its bytes. Raises ConfigError when
    missing or too short; used for startup fail-fast."""
    raw = os.environ.get(SECRET_KEY_BASE_ENV, "").strip()
    if not raw:
        raise ConfigError(
            f"{SECRET_KEY_BASE_ENV} is missing: without a persistent root key, a restart "
            f"invalidates every previously issued KEY and delete secret while photos stay "
            f"for the TTL. Generate with: {_GENERATE_HINT}"
        )
    key = _decode_key_base(raw)
    if len(key) < MIN_KEY_BASE_BYTES:
        raise ConfigError(
            f"{SECRET_KEY_BASE_ENV} decodes to {len(key)} bytes, "
            f"at least {MIN_KEY_BASE_BYTES} bytes are required. Generate with: {_GENERATE_HINT}"
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
    """Fernet key for the idempotency response envelope (urlsafe base64 of 32
    bytes)."""
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
    """Object integrity MAC (§8.2): binds object name, byte length, and content
    digest.

    Binding only name and length would leave any equal-length byte swap
    undetected.
    """
    payload = f"{object_name}\x00{byte_length}\x00{content_sha256}".encode()
    return _hmac(_subkey("object"), "object-integrity-v2", payload).hex()


def rate_fingerprint(scope: str, value: str) -> str:
    """Short-lived fingerprint for rate limiting (§9.3): independent
    daily-rotated key, not reusing the Key Registry digest."""
    return _hmac(_subkey("rate"), f"rate-{scope}-v1", value.encode("utf-8")).hex()


def request_digest(photo_bytes: bytes, template_id: str, template_version: int) -> str:
    """§6.2 request digest: length-prefixed encoding, no boundary/filename/MIME."""
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
