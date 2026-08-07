"""Rate limiting (§9.3): counts live in SQLite; windows and buckets are
determined by server-side HMAC short-lived fingerprints."""

import sqlite3
import time

from .hmac_utils import rate_fingerprint


class RateLimiter:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def _record(self, scope: str, bucket: str, window_start: int) -> int:
        fp = rate_fingerprint(scope, bucket)
        self.conn.execute(
            "INSERT INTO rate_limit_counts(scope, bucket, window_start, count) VALUES (?,?,?,1) "
            "ON CONFLICT(scope, bucket, window_start) DO UPDATE SET count = count + 1",
            (scope, fp, window_start),
        )
        self.conn.commit()
        row = self.conn.execute(
            "SELECT count FROM rate_limit_counts WHERE scope=? AND bucket=? AND window_start=?",
            (scope, fp, window_start),
        ).fetchone()
        return int(row["count"])

    def check(self, scope: str, bucket: str, window_seconds: int, limit: int) -> bool:
        """Record one attempt and return whether it is still within the limit."""
        now = int(time.time())
        window_start = now - (now % window_seconds)
        count = self._record(scope, bucket, window_start)
        return count <= limit

    def peek(self, scope: str, bucket: str, window_seconds: int) -> int:
        """Read-only count of the current window: no increment, no commit; used
        as the issuance gate on the success path."""
        now = int(time.time())
        window_start = now - (now % window_seconds)
        fp = rate_fingerprint(scope, bucket)
        row = self.conn.execute(
            "SELECT count FROM rate_limit_counts WHERE scope=? AND bucket=? AND window_start=?",
            (scope, fp, window_start),
        ).fetchone()
        return int(row["count"]) if row is not None else 0
