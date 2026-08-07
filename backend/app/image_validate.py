"""Server-side staging validation (SPEC §8.2 / SAV-002).
Only canonical single-image JPEGs are accepted; the upload filename is
ignored; after decode-validation the image is re-encoded to sRGB;
physical_raster templates get the specified PPI written; results that do not
meet the constraints are rejected."""

import io
from dataclasses import dataclass

from PIL import Image, ImageCms, ImageOps

from .config import Settings, get_settings

SRGB_PROFILE = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))

# A2: shares the same quality range as the frontend's
# frontend/src/render/final-artifact.ts:82-85 MIN_QUALITY/MAX_QUALITY
# (0.4–0.95, converted to integers 40–95 for PIL). Size-capped templates'
# artifacts are searched once per side by actual bytes; changing either end of
# the range requires updating both sides.
MAX_REENCODE_QUALITY = 92
MIN_REENCODE_QUALITY = 40


def _encode_at(img: Image.Image, quality: int) -> bytes:
    """Re-encode as sRGB JPEG at the given quality; the ICC profile fixed
    overhead must be counted in candidate lengths."""
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=quality, icc_profile=SRGB_PROFILE.tobytes())
    return out.getvalue()


@dataclass(frozen=True)
class SizeConstraint:
    """Template output size constraint (P6): exact or bounds, one of the two.

    exact: exact_pixels / physical_raster exact dimensions.
    bounds: (min_w, min_h, max_w, max_h) + aspect ratio + allowed whitelist,
    used by ranged_pixels; when allowed is None the whitelist is not checked.
    """

    exact: tuple[int, int] | None
    bounds: tuple[int, int, int, int] | None
    aspect: tuple[int, int] | None
    allowed: list[tuple[int, int]] | None


class ImageValidationError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def validate_and_reencode(
    data: bytes,
    *,
    max_bytes: int | None,
    max_pixels: int,
    max_edge_px: int,
    constraint: SizeConstraint,
    target_ppi: int | None,
    settings: Settings | None = None,
) -> tuple[bytes, int, int]:
    """Validate → sRGB re-encode → PPI write; returns (bytes, actual width, actual height)."""
    cfg = settings or get_settings()
    # §8.2: template maxBytes and the global cap intersect - the template is only
    # a candidate and can no longer raise the global value
    effective_max = (
        cfg.max_upload_bytes if max_bytes is None else min(max_bytes, cfg.max_upload_bytes)
    )
    if len(data) > effective_max:
        raise ImageValidationError("PHOTO_TOO_LARGE", "file exceeds the upload limit")

    try:
        img = Image.open(io.BytesIO(data))
        img.verify()
        img = Image.open(io.BytesIO(data))  # must reopen after verify
    except Exception as e:
        raise ImageValidationError("PHOTO_INVALID", "image cannot be decoded") from e

    if img.format != "JPEG" or getattr(img, "n_frames", 1) != 1:
        raise ImageValidationError("PHOTO_INVALID", "only single-image JPEG is accepted")

    width, height = img.size
    if width * height > max_pixels:
        raise ImageValidationError("PHOTO_TOO_LARGE", "pixel count exceeds the limit")
    if max(width, height) > max_edge_px:
        raise ImageValidationError("PHOTO_TOO_LARGE", "edge length exceeds the limit")

    # Orientation is written into actual pixels (OUT-004 server-side mirror
    # requirement): strip EXIF and apply orientation; size validation must
    # happen after transposition (a rotated image's stored size ≠ its actual
    # oriented size)
    img = ImageOps.exif_transpose(img)
    width, height = img.size

    if constraint.exact is not None:
        if (width, height) != constraint.exact:
            raise ImageValidationError(
                "PHOTO_SIZE_MISMATCH",
                f"pixel size {width}x{height} does not match the template",
            )
    else:
        # ranged_pixels: range + aspect ratio + whitelist (skipped when allowed is empty)
        min_w, min_h, max_w, max_h = constraint.bounds
        if not (min_w <= width <= max_w and min_h <= height <= max_h):
            raise ImageValidationError(
                "PHOTO_SIZE_MISMATCH",
                f"pixel size {width}x{height} is outside the template's allowed "
                f"range {min_w}x{min_h}-{max_w}x{max_h}",
            )
        aspect_w, aspect_h = constraint.aspect
        if width * aspect_h != height * aspect_w:
            raise ImageValidationError(
                "PHOTO_SIZE_MISMATCH",
                f"pixel size {width}x{height} does not match the template "
                f"aspect ratio {aspect_w}:{aspect_h}",
            )
        if constraint.allowed is not None and (width, height) not in constraint.allowed:
            raise ImageValidationError(
                "PHOTO_SIZE_MISMATCH",
                f"pixel size {width}x{height} is not among the template's selectable sizes",
            )

    # sRGB normalization
    if img.mode not in ("RGB", "RGBA", "L"):
        img = img.convert("RGB")
    img = ImageCms.profileToProfile(img, SRGB_PROFILE, SRGB_PROFILE, outputMode="RGB")
    if img.mode != "RGB":
        img = img.convert("RGB")

    return _encode_within(img, effective_max, target_ppi), width, height


def _encode_within(
    img: Image.Image,
    effective_max: int | None,
    target_ppi: int | None,
) -> bytes:
    """Re-encode; when needed, search quality downward to satisfy the size cap
    (A2).

    Same contract as the frontend searchQuality: judged strictly by the actual
    encoded byte length, never by a size model; steps down from 92 by -4
    (switching to -1 near the lower bound) until within limit or at the lower
    bound 40. When max_bytes is None (uncapped template) the existing fixed-92
    behavior is unchanged.
    """
    if effective_max is None:
        encoded = _encode_at(img, MAX_REENCODE_QUALITY)
    else:
        quality = MAX_REENCODE_QUALITY
        encoded = _encode_at(img, quality)
        while len(encoded) > effective_max and quality > MIN_REENCODE_QUALITY:
            quality = max(
                MIN_REENCODE_QUALITY,
                quality - (4 if quality - 4 >= MIN_REENCODE_QUALITY else 1),
            )
            encoded = _encode_at(img, quality)
        if len(encoded) > effective_max:
            raise ImageValidationError(
                "PHOTO_TOO_LARGE", "still exceeds the file limit after re-encoding"
            )

    if target_ppi is not None:
        encoded = _write_jfif_density(encoded, target_ppi)
    return encoded


def _write_jfif_density(data: bytes, ppi: int) -> bytes:
    """Rewrite the JFIF APP0 density (OUT-006 server-side path: upload metadata
    is not trusted)."""
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        raise ImageValidationError("PHOTO_INVALID", "corrupt JPEG header")
    off = 2
    while off + 4 <= len(data):
        if data[off] != 0xFF:
            break
        marker = data[off + 1]
        if marker in (0xD9, 0xDA):
            break
        seg_len = (data[off + 2] << 8) | data[off + 3]
        if seg_len < 2 or off + 2 + seg_len > len(data):
            break
        if marker == 0xE0 and seg_len >= 14 and data[off + 4 : off + 9] == b"JFIF\x00":
            p = off + 4
            out = bytearray(data)
            out[p + 7] = 1  # units = dpi
            out[p + 8 : p + 10] = ppi.to_bytes(2, "big")
            out[p + 10 : p + 12] = ppi.to_bytes(2, "big")
            return bytes(out)
        off += 2 + seg_len
    raise ImageValidationError(
        "PHOTO_INVALID", "JPEG has no JFIF APP0; print density cannot be written"
    )
