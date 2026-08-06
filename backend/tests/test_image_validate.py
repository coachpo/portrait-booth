"""image_validate 单元回归（P9）：全局上传上限与模板 maxBytes 取交集。

不经过 HTTP、不需要 DB：直接调用 validate_and_reencode 注入 Settings。
"""

import io
import random

import pytest
from PIL import Image

from app.config import Settings
from app.image_validate import ImageValidationError, validate_and_reencode


def make_jpeg(width=500, height=653, quality=92, noise=False) -> bytes:
    if noise:
        # 噪声图拉开「输入 vs q92 产物」的字节窗口：复检门独立可测
        rng = random.Random(42)
        img = Image.new("RGB", (width, height))
        img.putdata(
            [
                (rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255))
                for _ in range(width * height)
            ]
        )
    else:
        img = Image.new("RGB", (width, height), (60, 120, 200))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def encode(photo, *, width=500, height=653, max_bytes=None, settings=None) -> bytes:
    return validate_and_reencode(
        photo,
        max_bytes=max_bytes,
        max_pixels=Settings().max_pixels,
        max_edge_px=Settings().max_edge_px,
        target_width=width,
        target_height=height,
        target_ppi=None,
        settings=settings,
    )


class TestEffectiveByteLimit:
    def test_global_limit_caps_template_max_bytes(self):
        """回归：模板 maxBytes 曾整体压过全局上限，写多大都拦不住。"""
        photo = make_jpeg()
        # 模板声明 64 MB，全局只剩 1024 字节——有效上限必须是 min = 1024
        with pytest.raises(ImageValidationError) as excinfo:
            encode(photo, max_bytes=64 * 1024 * 1024, settings=Settings(max_upload_bytes=1024))
        assert excinfo.value.code == "PHOTO_TOO_LARGE"

    def test_template_stricter_than_global_still_rejects(self):
        """反向钉死：模板值更小时必须仍按模板值拒绝，不得退化成只看全局。"""
        photo = make_jpeg()
        with pytest.raises(ImageValidationError) as excinfo:
            encode(photo, max_bytes=1024, settings=Settings())
        assert excinfo.value.code == "PHOTO_TOO_LARGE"

    def test_reencoded_size_is_checked_unconditionally(self):
        """复检门：入站放行、降到下界 40 仍超限也必须拒（A2 后语义），且用 message 区分两个门。"""
        rng = random.Random(42)
        img = Image.new("RGB", (1200, 1200))
        img.putdata(
            [
                (rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255))
                for _ in range(1200 * 1200)
            ]
        )
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=20)
        photo = buf.getvalue()
        # 复检门语义（A2 后）：入站刚放行、降到下界 40 仍超限就必须拒。
        # 服务端会先做 sRGB profileToProfile，直编尺寸与搜索产物不一致，
        # 所以上限不按直编推算，直接用「入参长度 + 1」——q40 产物（约 45 万字节）
        # 必然超限，只有复检门能拦。
        tight = len(photo) + 1
        with pytest.raises(ImageValidationError) as excinfo:
            encode(
                photo,
                width=1200,
                height=1200,
                max_bytes=None,
                settings=Settings(max_upload_bytes=tight),
            )
        assert excinfo.value.code == "PHOTO_TOO_LARGE"
        assert "重编码后仍超过文件上限" in str(excinfo.value)
