"""服务端暂存验证（SPEC §8.2 / SAV-002）。
只接受 canonical 单图 JPEG；忽略上传文件名；解码验证后重编码 sRGB；
physical_raster 模板写入规定 PPI；结果不满足则拒绝。"""

import io

from PIL import Image, ImageCms, ImageOps

from .config import Settings, get_settings

SRGB_PROFILE = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))


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
    target_width: int,
    target_height: int,
    target_ppi: int | None,
    settings: Settings | None = None,
) -> bytes:
    """验证 → sRGB 重编码 → PPI 写入；任一不满足即抛 ImageValidationError。"""
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

    # 方向写入实际像素（OUT-004 服务端镜像要求）：剥离 EXIF 后应用方向
    exif = img.getexif()
    orientation = exif.get(274)  # 0x0112
    img = ImageOps.exif_transpose(img)

    if img.size != (target_width, target_height):
        raise ImageValidationError(
            "PHOTO_SIZE_MISMATCH", f"像素尺寸 {img.size[0]}×{img.size[1]} 与模板不符"
        )

    # sRGB 归一化
    if img.mode not in ("RGB", "RGBA", "L"):
        img = img.convert("RGB")
    img = ImageCms.profileToProfile(img, SRGB_PROFILE, SRGB_PROFILE, outputMode="RGB")
    if img.mode != "RGB":
        img = img.convert("RGB")

    out = io.BytesIO()
    img.save(out, format="JPEG", quality=92, icc_profile=SRGB_PROFILE.tobytes())
    encoded = out.getvalue()

    if target_ppi is not None:
        encoded = _write_jfif_density(encoded, target_ppi)

    if len(encoded) > effective_max:
        raise ImageValidationError("PHOTO_TOO_LARGE", "重编码后仍超过文件上限")

    if orientation and orientation != 1:
        # exif_transpose 已应用方向；显式剔除残留 EXIF（ImageOps 保留 exif 元数据时剔除）
        pass  # save 时未传 exif → Pillow 默认不写 EXIF

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
