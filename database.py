"""SQLite storage for field interaction events."""

import os
import sqlite3
from datetime import datetime, timezone

from flask import current_app, g

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    event_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_uid        TEXT    NOT NULL UNIQUE,  -- random id from the browser; makes retries idempotent
    session_token    TEXT    NOT NULL,         -- random per test journey, never derived from personal data
    form_id          TEXT    NOT NULL,
    field_id         TEXT,                     -- NULL for form-level events
    event_type       TEXT    NOT NULL,
    event_ts         INTEGER NOT NULL,         -- client time, epoch milliseconds
    device_category  TEXT,
    browser_category TEXT,
    error_category   TEXT,
    created_at       TEXT    NOT NULL          -- server receive time, ISO 8601 UTC
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_token, event_ts);
CREATE INDEX IF NOT EXISTS idx_events_field   ON events (field_id, event_type);
"""

COLUMNS = (
    "event_uid", "session_token", "form_id", "field_id", "event_type", "event_ts",
    "device_category", "browser_category", "error_category",
)


def get_db():
    if "db" not in g:
        path = current_app.config["DATABASE"]
        g.db = sqlite3.connect(path)
        g.db.row_factory = sqlite3.Row
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db(path):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.executescript(SCHEMA)


def insert_events(events):
    """Insert validated events in one transaction. Returns the number of new rows."""
    created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = [tuple(e.get(c) for c in COLUMNS) + (created_at,) for e in events]
    db = get_db()
    before = db.total_changes
    with db:  # commits on success, rolls back on error
        db.executemany(
            f"INSERT OR IGNORE INTO events ({', '.join(COLUMNS)}, created_at) "
            f"VALUES ({', '.join('?' * (len(COLUMNS) + 1))})",
            rows,
        )
    return db.total_changes - before


def fetch_events(device=None, browser=None, since_ms=None):
    """Return events ordered for session reconstruction, optionally filtered."""
    clauses, params = [], []
    if device:
        clauses.append("device_category = ?")
        params.append(device)
    if browser:
        clauses.append("browser_category = ?")
        params.append(browser)
    if since_ms is not None:
        clauses.append("event_ts >= ?")
        params.append(since_ms)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    sql = f"SELECT * FROM events {where} ORDER BY session_token, event_ts, event_id"
    return [dict(r) for r in get_db().execute(sql, params)]


def recent_events(limit=50):
    """Latest stored rows, exactly as persisted - used to prove no values are kept."""
    sql = "SELECT * FROM events ORDER BY event_id DESC LIMIT ?"
    return [dict(r) for r in get_db().execute(sql, (limit,))]


def distinct_values(column):
    if column not in ("device_category", "browser_category"):
        raise ValueError(column)
    sql = f"SELECT DISTINCT {column} FROM events WHERE {column} IS NOT NULL ORDER BY 1"
    return [r[0] for r in get_db().execute(sql)]


def count_events():
    return get_db().execute("SELECT COUNT(*) FROM events").fetchone()[0]


def clear_events():
    db = get_db()
    with db:
        db.execute("DELETE FROM events")
