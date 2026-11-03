-- Owner account inspector: one row each time the owner opens an account's
-- private details (worker/src/owner-inspector.js creates the same table on demand).
-- Only ids and times are stored here, never the details themselves.
CREATE TABLE IF NOT EXISTS owner_access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    owner_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'view'
);
CREATE INDEX IF NOT EXISTS owner_access_log_at ON owner_access_log (at);
CREATE INDEX IF NOT EXISTS owner_access_log_target ON owner_access_log (target_id, at);
