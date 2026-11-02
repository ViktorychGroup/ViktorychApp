-- Friends off: fast lookup of accounts with Friends off (People you may know, audiences, birthdays and games skip them).
CREATE INDEX IF NOT EXISTS idx_friend_prefs_enabled ON account_friend_prefs (enabled, public_id);
