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
        """复检门：入站放行、重编码产物超限也必须拒，且用 message 区分两个门。"""
        photo = make_jpeg(1200, 1200, quality=20, noise=True)
        # 先拿产物长度：输入与 q92 产物相差近 50 万字节，上限取「产物长度 - 1」
        encoded = encode(
            photo,
            width=1200,
            height=1200,
            max_bytes=None,
            settings=Settings(max_upload_bytes=16 * 1024 * 1024),
        )
        assert len(encoded) > len(photo), "噪声图应让重编码产物明显大于输入"

        tight = len(encoded) - 1
        assert tight > len(photo), "上限必须落在入站门放行、只有复检门能拦的窗口内"
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
