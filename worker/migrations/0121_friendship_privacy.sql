-- Privacy for each friendship (worker/src/friend-privacy.js creates the same
-- tables on demand). One row per (account, friend) with a rule other than
-- "Same as my friend list".
CREATE TABLE IF NOT EXISTS friendship_privacy (
    public_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'inherit',
    audience TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (public_id, friend_id)
);
CREATE INDEX IF NOT EXISTS friendship_privacy_friend ON friendship_privacy(friend_id);
