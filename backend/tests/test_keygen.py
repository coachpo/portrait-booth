"""KEY 生成与归一化（SAV-003/004）。"""

import pytest

from app.config import Settings
from app.keygen import generate_key, generate_secret, key_display, normalize_key


class Rng:
    """可控 RNG：返回固定值序列，用于拒绝采样边界验证。"""

    def __init__(self, values):
        self.values = list(values)
        self.calls = 0

    def __call__(self, n):
        self.calls += 1
        return self.values.pop(0) if self.values else 0


def test_generate_key_uses_rejection_sampling_without_bias():
    # charset 36 → k=6，limit=64-64%36=36；randbelow(64) 的 36..63 必须被拒绝
    rng = Rng([36, 63, 0])  # 36、63 越界被拒绝，0 → charset[0]
    key = generate_key(rng=rng, settings=Settings())
    assert key == "AAAAAA"
    # 第一位置拒绝 2 次 + 其余 5 位置各 1 次
    assert rng.calls == 8


def test_generate_key_covers_all_charset_positions():
    cfg = Settings()
    for i, ch in enumerate(cfg.key_charset[:6]):
        rng = Rng([i] * cfg.key_length)
        key = generate_key(rng=rng, settings=cfg)
        assert key == ch * cfg.key_length


def test_generate_key_allows_all_letters_and_all_digits():
    rng = Rng([0] * 6)
    assert generate_key(rng=rng, settings=Settings()) == "AAAAAA"
    rng = Rng([26] * 6)  # 数字从位置 26 开始
    assert generate_key(rng=rng, settings=Settings()) == "000000"


def test_generate_secret_is_at_least_128_bits():

    secret = generate_secret(settings=Settings())
    assert len(secret) >= 22  # 16 字节 base64url ≈ 22 字符


def test_normalize_key():
    assert normalize_key(" a7c 2f9 ") == "A7C2F9"
    assert normalize_key("a7c-2f9") == "A7C2F9"
    assert normalize_key("000000") == "000000"  # 保留前导 0
    assert normalize_key("a7c2f9") == "A7C2F9"  # 小写转大写


@pytest.mark.parametrize("bad", ["", "abc", "ABC1234", "A7C2F9X", "ＡＢＣ１２３", "a7c 2f!"])
def test_normalize_key_rejects_invalid(bad):
    with pytest.raises(ValueError):
        normalize_key(bad)


def test_key_display_groups():
    assert key_display("A7C2F9") == "A7C 2F9"
