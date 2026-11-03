-- Shorts is on. A stored off flag from an earlier switch is cleared.
-- The owner can turn it off again afterwards.
CREATE TABLE IF NOT EXISTS feature_flags (name TEXT PRIMARY KEY, off INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO feature_flags (name, off, updated_at) VALUES ('shorts', 0, 0) ON CONFLICT(name) DO UPDATE SET off = 0;
