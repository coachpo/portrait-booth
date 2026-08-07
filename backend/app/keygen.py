"""KEY and secret generation (SAV-003/006) and KEY normalization (SAV-004)."""

import base64
import os
import re
import secrets
from collections.abc import Callable

from .config import Settings, get_settings

Rng = Callable[[int], int]

KEY_RE = re.compile(r"^[A-Z0-9]{6}$")


def normalize_key(raw: str) -> str:
    """SAV-004: strip spaces/ASCII hyphens, uppercase letters; keep leading
    zeros; never silently map illegal characters."""
    cleaned = re.sub(r"[\s-]", "", raw).upper()
    if not KEY_RE.match(cleaned):
        raise ValueError("invalid key format")
    return cleaned


def generate_key(rng: Rng | None = None, settings: Settings | None = None) -> str:
    """SAV-003: CSPRNG rejection sampling without modulo bias; each position is
    drawn independently with no forced letter/digit mix."""
    cfg = settings or get_settings()
    charset = cfg.key_charset
    n = len(charset)
    r = rng or secrets.randbelow
    # Rejection sampling: reject samples where randbelow(2^k) >= n
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
    """SAV-006: independent ≥128-bit delete secret, base64url encoded."""
    cfg = settings or get_settings()
    raw = bytearray()
    for _ in range(cfg.secret_bytes):
        raw.append((rng or secrets.randbelow)(256))
    return base64.urlsafe_b64encode(bytes(raw)).rstrip(b"=").decode("ascii")


def key_display(key: str) -> str:
    """Display grouping `A7C 2F9`; the canonical value stays `A7C2F9` (SAV-004)."""
    return f"{key[:3]} {key[3:]}"


def random_session_id(rng: Rng | None = None) -> str:
    """Save session ID (≥128 bits of randomness)."""
    return secrets.token_hex(16) if rng is None else f"{rng(1 << 128):032x}"


def random_object_name(rng: Rng | None = None) -> str:
    """Random path name for object storage, unrelated to KEY (SPEC §8.2)."""
    return secrets.token_hex(16) if rng is None else f"{rng(1 << 128):032x}"


def random_token(rng: Rng | None = None) -> str:
    """Download token (≥128 bits, single use)."""
    return secrets.token_urlsafe(16) if rng is None else f"tok-{rng(1 << 128):032x}"


if os.environ.get("PORTRAIT_DEV_RNG") == "1":  # pragma: no cover - tests inject directly
    pass
