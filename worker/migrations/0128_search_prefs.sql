-- "Let others find me in search" (default on). Off keeps an account out of People
-- search for everyone except the site owner, whose views are audit-logged.
CREATE TABLE IF NOT EXISTS search_prefs (public_id TEXT PRIMARY KEY, searchable INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
