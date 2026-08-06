"""私有对象存储（SPEC §8.2）：随机对象名、私有目录、不进入备份清单。"""

import contextlib
import os
import shutil
from pathlib import Path

from .config import get_settings
from .keygen import random_object_name


class Storage:
    def __init__(self, base_dir: Path | None = None, rng=None):
        self.base = Path(base_dir or get_settings().storage_path)
        self.base.mkdir(parents=True, exist_ok=True)
        os.chmod(self.base, 0o700)
        self._rng = rng

    def _path(self, object_name: str) -> Path:
        if not object_name or "/" in object_name or object_name.startswith("."):
            raise ValueError("invalid object name")
        return self.base / object_name

    def write(self, data: bytes) -> str:
        """写入随机命名对象（staging 语义：无数据库引用前不视为可达）。"""
        name = random_object_name(self._rng)
        path = self._path(name)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
        except BaseException:
            self.delete(name)
            raise
        return name

    def read(self, object_name: str) -> bytes | None:
        path = self._path(object_name)
        if not path.exists():
            return None
        return path.read_bytes()

    def delete(self, object_name: str) -> None:
        with contextlib.suppress(FileNotFoundError):
            self._path(object_name).unlink()

    def sweep_orphans(self, known_names: set[str]) -> int:
        """删除无数据库引用的 staging 对象（§8.2 orphan sweep）。"""
        removed = 0
        for entry in self.base.iterdir():
            if entry.is_file() and entry.name not in known_names:
                with contextlib.suppress(FileNotFoundError):
                    entry.unlink()
                    removed += 1
        return removed

    def clear_all(self) -> None:
        shutil.rmtree(self.base, ignore_errors=True)
        self.base.mkdir(parents=True, exist_ok=True)
