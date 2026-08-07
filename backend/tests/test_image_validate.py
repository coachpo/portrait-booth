"""image_validate unit regressions (P9): the global upload cap intersects
with template maxBytes.

No HTTP, no DB: validate_and_reencode is called directly with injected
Settings.
"""

import io
import random

import pytest
from PIL import Image

from app.config import Settings
from app.image_validate import (
    ImageValidationError,
    SizeConstraint,
    validate_and_reencode,
)


def make_jpeg(width=500, height=653, quality=92, noise=False) -> bytes:
    if noise:
        # The noise image widens the byte window between "input" and the
        # "q92 artifact": the recheck gate becomes independently testable
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
        constraint=SizeConstraint(exact=(width, height), bounds=None, aspect=None, allowed=None),
        target_ppi=None,
        settings=settings,
    )


class TestEffectiveByteLimit:
    def test_global_limit_caps_template_max_bytes(self):
        """Regression: template maxBytes used to override the global cap
        entirely; no declared value could stop it."""
        photo = make_jpeg()
        # Template declares 64 MB while the global cap is 1024 bytes - the
        # effective cap must be min = 1024
        with pytest.raises(ImageValidationError) as excinfo:
            encode(photo, max_bytes=64 * 1024 * 1024, settings=Settings(max_upload_bytes=1024))
        assert excinfo.value.code == "PHOTO_TOO_LARGE"

    def test_template_stricter_than_global_still_rejects(self):
        """Reverse pin: a smaller template value must still reject per the
        template value and must not degenerate to global-only."""
        photo = make_jpeg()
        with pytest.raises(ImageValidationError) as excinfo:
            encode(photo, max_bytes=1024, settings=Settings())
        assert excinfo.value.code == "PHOTO_TOO_LARGE"

    def test_reencoded_size_is_checked_unconditionally(self):
        """Recheck gate: after the inbound release, still over at the lower
        bound 40 must reject (post-A2 semantics), and the message distinguishes
        the two gates."""
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
        # Recheck-gate semantics (post-A2): inbound just released, still over at
        # the lower bound 40 must reject. The server runs sRGB
        # profileToProfile first, so the direct-encode size differs from the
        # search artifact; the cap is therefore not derived from a direct
        # encode but set to "input length + 1" - the q40 artifact (~450KB)
        # is always over, only the recheck gate can catch it.
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
        assert "still exceeds the file limit after re-encoding" in str(excinfo.value)
