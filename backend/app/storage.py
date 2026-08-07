"""Private object storage (SPEC §8.2): random object names, private directory,
not part of any backup manifest."""

import contextlib
import os
import shutil
import time
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
        """Write a randomly named object (staging semantics: not reachable until
        a database reference exists)."""
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

    def sweep_orphans(
        self,
        known_names: set[str],
        min_age_seconds: float = 0.0,
        now: float | None = None,
    ) -> int:
        """Delete staging objects with no database reference (§8.2 orphan sweep).

        min_age_seconds is required: a save writes the object before committing
        the transaction, and without the age gate this sweep would delete bytes
        just written by an in-flight request - the user gets a KEY whose photo
        is no longer on disk.
        """
        cutoff = (now if now is not None else time.time()) - min_age_seconds
        removed = 0
        for entry in self.base.iterdir():
            if not entry.is_file() or entry.name in known_names:
                continue
            with contextlib.suppress(FileNotFoundError):
                if entry.stat().st_mtime > cutoff:
                    continue  # Too new; may belong to an in-flight save
                entry.unlink()
                removed += 1
        return removed

    def clear_all(self) -> None:
        shutil.rmtree(self.base, ignore_errors=True)
        self.base.mkdir(parents=True, exist_ok=True)
