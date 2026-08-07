"""SQLite metadata storage (SPEC §7). WAL, short-lived per-request connections,
and synchronous endpoints go through a thread pool."""

import sqlite3
from pathlib import Path

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS key_registry (
  key_fingerprint TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('reserved','active','retired')),
  issued_at TEXT NOT NULL,
  photo_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_key_registry_state ON key_registry(state);

CREATE TABLE IF NOT EXISTS photo_records (
  id TEXT PRIMARY KEY,
  key_fingerprint TEXT NOT NULL UNIQUE REFERENCES key_registry(key_fingerprint),
  retrieval_mode TEXT NOT NULL,
  security_policy_version INTEGER NOT NULL,
  delete_digest TEXT NOT NULL,
  delete_digest_version INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  template_revision_id TEXT NOT NULL,
  template_content_hash TEXT NOT NULL,
  mime TEXT NOT NULL,
  width_px INTEGER NOT NULL,
  height_px INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  object_integrity_mac TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
  ('validating','active','access-revoked','purging','purged')),
  revocation_epoch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  access_revoked_at TEXT,
  purge_due_at TEXT,
  purge_started_at TEXT,
  purged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_photo_status_expires ON photo_records(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_photo_status_purge ON photo_records(status, purge_due_at);

CREATE TABLE IF NOT EXISTS download_grants (
  token_digest TEXT PRIMARY KEY,
  token_digest_version INTEGER NOT NULL,
  photo_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  revocation_epoch INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS save_idempotency_records (
  anonymous_save_session_digest TEXT NOT NULL,
  idempotency_key_digest TEXT NOT NULL,
  request_digest TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing','completed','failed')),
  photo_id TEXT,
  encrypted_response_envelope TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (anonymous_save_session_digest, idempotency_key_digest)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON save_idempotency_records(created_at);

CREATE TABLE IF NOT EXISTS rate_limit_counts (
  scope TEXT NOT NULL,
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (scope, bucket, window_start)
);
"""


def connect(db_path: str | Path) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_schema(db_path: str | Path) -> None:
    conn = connect(db_path)
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()
