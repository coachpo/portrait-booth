"""服务端暂存验证（SPEC §8.2 / SAV-002）。
只接受 canonical 单图 JPEG；忽略上传文件名；解码验证后重编码 sRGB；
physical_raster 模板写入规定 PPI；结果不满足则拒绝。"""

import io
from dataclasses import dataclass

from PIL import Image, ImageCms, ImageOps

from .config import Settings, get_settings

SRGB_PROFILE = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))

# A2：与前端 frontend/src/render/final-artifact.ts:82-85 的 MIN_QUALITY/MAX_QUALITY
# （0.4–0.95，PIL 换算成整数 40–95）共享同一质量区间。带体积上限模板的
# 成品由两端各按实际字节搜一次，区间两端改动必须同步。
MAX_REENCODE_QUALITY = 92
MIN_REENCODE_QUALITY = 40


def _encode_at(img: Image.Image, quality: int) -> bytes:
    """按给定质量重编码为 sRGB JPEG；ICC profile 固定开销必须计入候选长度。"""
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=quality, icc_profile=SRGB_PROFILE.tobytes())
    return out.getvalue()


@dataclass(frozen=True)
class SizeConstraint:
    """模板输出尺寸约束（P6）：exact 与 bounds 二选一。

    exact: exact_pixels / physical_raster 的精确尺寸。
    bounds: (min_w, min_h, max_w, max_h) + aspect 宽高比 + allowed 白名单，
    ranged_pixels 用；allowed 为 None 时不校验白名单。
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
    """验证 → sRGB 重编码 → PPI 写入；返回 (字节, 实际宽, 实际高)。"""
    cfg = settings or get_settings()
    # §8.2：模板 maxBytes 与全局上限取交集——模板只是候选之一，不能再抬高全局值
    effective_max = (
        cfg.max_upload_bytes if max_bytes is None else min(max_bytes, cfg.max_upload_bytes)
    )
    if len(data) > effective_max:
        raise ImageValidationError("PHOTO_TOO_LARGE", "文件超过上传上限")

    try:
        img = Image.open(io.BytesIO(data))
        img.verify()
        img = Image.open(io.BytesIO(data))  # verify 后需重开
    except Exception as e:
        raise ImageValidationError("PHOTO_INVALID", "无法解码图片") from e

    if img.format != "JPEG" or getattr(img, "n_frames", 1) != 1:
        raise ImageValidationError("PHOTO_INVALID", "仅接受单图 JPEG")

    width, height = img.size
    if width * height > max_pixels:
        raise ImageValidationError("PHOTO_TOO_LARGE", "像素超过上限")
    if max(width, height) > max_edge_px:
        raise ImageValidationError("PHOTO_TOO_LARGE", "边长超过上限")

    # 方向写入实际像素（OUT-004 服务端镜像要求）：剥离 EXIF 后应用方向，
    # 尺寸校验必须发生在转置之后（旋转图存储尺寸 ≠ 实际方向尺寸）
    img = ImageOps.exif_transpose(img)
    width, height = img.size

    if constraint.exact is not None:
        if (width, height) != constraint.exact:
            raise ImageValidationError(
                "PHOTO_SIZE_MISMATCH",
                f"像素尺寸 {width}×{height} 与模板不符",
            )
    else:
        # ranged_pixels：范围 + 宽高比 + 白名单（allowed 为空时跳过）
        min_w, min_h, max_w, max_h = constraint.bounds
        if not (min_w <= width <= max_w and min_h <= height <= max_h):
            raise ImageValidationError(
                "PHOTO_SIZE_MISMATCH",
                f"像素尺寸 {width}×{height} 不在模板允许范围 {min_w}×{min_h}–{max_w}×{max_h} 内",
            )
        aspect_w, aspect_h = constraint.aspect
        if width * aspect_h != height * aspect_w:
            raise ImageValidationError(
                "PHOTO_SIZE_MISMATCH",
                f"像素尺寸 {width}×{height} 不符合模板宽高比 {aspect_w}:{aspect_h}",
            )
        if constraint.allowed is not None and (width, height) not in constraint.allowed:
            raise ImageValidationError(
                "PHOTO_SIZE_MISMATCH",
                f"像素尺寸 {width}×{height} 不在模板可选尺寸内",
            )

    # sRGB 归一化
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
    """重编码；必要时向下搜索质量档以满足体积上限（A2）。

    与前端 searchQuality 同一契约：判据一律是实际编码出来的字节长度，
    不用体积模型估算；从 92 起每次 -4（逼近下界改 -1）下行，直到不超限
    或降到下界 40。max_bytes 为 None（无体积上限模板）时保持固定 92 的
    既有行为不变。
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
            raise ImageValidationError("PHOTO_TOO_LARGE", "重编码后仍超过文件上限")

    if target_ppi is not None:
        encoded = _write_jfif_density(encoded, target_ppi)
    return encoded


def _write_jfif_density(data: bytes, ppi: int) -> bytes:
    """改写 JFIF APP0 density（OUT-006 服务端路径：不信任上传元数据）。"""
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        raise ImageValidationError("PHOTO_INVALID", "JPEG 头损坏")
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
    raise ImageValidationError("PHOTO_INVALID", "JPEG 缺少 JFIF APP0，无法写入打印密度")
