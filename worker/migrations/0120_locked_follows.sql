-- Locked follows: people you follow that stay hidden everywhere until you
-- unlock them on this device. The Worker also creates these on demand.
CREATE TABLE IF NOT EXISTS locked_follows (owner_id TEXT NOT NULL, target_id TEXT NOT NULL, follow_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (owner_id, target_id));
CREATE INDEX IF NOT EXISTS locked_follows_owner ON locked_follows(owner_id, created_at DESC);
CREATE TABLE IF NOT EXISTS locked_follow_prefs (public_id TEXT PRIMARY KEY, code_hash TEXT NOT NULL DEFAULT '', code_salt TEXT NOT NULL DEFAULT '', code_rounds INTEGER NOT NULL DEFAULT 0, hide_entry INTEGER NOT NULL DEFAULT 0, relock_secs INTEGER NOT NULL DEFAULT 60, fails INTEGER NOT NULL DEFAULT 0, fail_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS locked_follow_keys (credential_id TEXT PRIMARY KEY, public_id TEXT NOT NULL, rp_id TEXT NOT NULL, public_key TEXT NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS locked_follow_keys_owner ON locked_follow_keys(public_id);
CREATE TABLE IF NOT EXISTS locked_follow_grants (grant_hash TEXT PRIMARY KEY, public_id TEXT NOT NULL, session_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS locked_follow_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, owner_id TEXT NOT NULL, subject_id TEXT NOT NULL, action TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS locked_follow_audit_at ON locked_follow_audit(at DESC);
CREATE TABLE IF NOT EXISTS locked_follow_challenges (id TEXT PRIMARY KEY, public_id TEXT NOT NULL, kind TEXT NOT NULL, challenge TEXT NOT NULL, origin TEXT NOT NULL, rp_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
