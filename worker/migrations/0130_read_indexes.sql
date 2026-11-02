-- Fewer D1 rows read. These indexes let the hot reads stop after the rows
-- they return instead of sorting every row of the account first.
-- Notifications list (ORDER BY at DESC, note_id ASC LIMIT 200).
CREATE INDEX IF NOT EXISTS notifications_recent ON notifications(public_id, at DESC, note_id);
-- Notifications polling (updated_at > ? and MAX(updated_at)).
CREATE INDEX IF NOT EXISTS notifications_updated ON notifications(public_id, updated_at);
-- Following list pages (ORDER BY created_at DESC, target_id ASC).
CREATE INDEX IF NOT EXISTS account_follows_recent ON account_follows(follower_id, created_at DESC, target_id);
