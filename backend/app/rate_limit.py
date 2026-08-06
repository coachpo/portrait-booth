"""限速（§9.3）：计数存 SQLite，窗口与桶由服务端 HMAC 短期指纹决定。"""

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
        """记录一次尝试并返回是否仍在限额内。"""
        now = int(time.time())
        window_start = now - (now % window_seconds)
        count = self._record(scope, bucket, window_start)
        return count <= limit

    def peek(self, scope: str, bucket: str, window_seconds: int) -> int:
        """只读当前窗口计数：不自增、不提交，供成功路径做签发闸门。"""
        now = int(time.time())
        window_start = now - (now % window_seconds)
        fp = rate_fingerprint(scope, bucket)
        row = self.conn.execute(
            "SELECT count FROM rate_limit_counts WHERE scope=? AND bucket=? AND window_start=?",
            (scope, fp, window_start),
        ).fetchone()
        return int(row["count"]) if row is not None else 0
