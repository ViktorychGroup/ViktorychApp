-- People who dropped the owner follow on purpose (unfollow, or removed by
-- the owner). An owner-follow backfill never adds them back.
CREATE TABLE IF NOT EXISTS owner_follow_drops (
  follower_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- One line per backfill run: when it ran and how many follows it added.
CREATE TABLE IF NOT EXISTS owner_follow_backfills (
  ran_at INTEGER NOT NULL,
  added INTEGER NOT NULL
);

-- Passkey sign-ups never got the automatic owner follow every other
-- sign-up gets. Add it once, idempotently, for accounts that:
--   * signed up with a passkey (their first passkey was saved within ten
--     minutes of the account) since new accounts follow the owner (#280),
--   * do not follow the owner now and never dropped that follow,
--   * have no follow points history with the owner (a tap and an unfollow
--     leave one), no block either way, and no deletion under way.
INSERT INTO account_follows (follower_id, target_id, snapshot, created_at)
SELECT a.public_id, 'app:' || o.public_id, '', CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM accounts a
JOIN (SELECT public_id FROM accounts WHERE owner = 1 AND profile_less = 0 LIMIT 1) o
WHERE a.owner = 0
  AND a.public_id != o.public_id
  AND a.created_at >= 1793210670000
  AND EXISTS (
    SELECT 1 FROM webauthn_credentials w
    WHERE w.public_id = a.public_id AND w.created_at <= a.created_at + 600000
  )
  AND NOT EXISTS (
    SELECT 1 FROM account_follows f
    WHERE f.follower_id = a.public_id AND f.target_id = 'app:' || o.public_id
  )
  AND NOT EXISTS (SELECT 1 FROM owner_follow_drops d WHERE d.follower_id = a.public_id)
  AND NOT EXISTS (
    SELECT 1 FROM point_ledger p
    WHERE p.public_id = a.public_id AND p.reason = 'follow' AND (p.ref = o.public_id OR p.ref = 'claw:' || o.public_id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM account_blocks b
    WHERE (b.blocker_id = a.public_id AND b.blocked_id = o.public_id)
       OR (b.blocker_id = o.public_id AND b.blocked_id = a.public_id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM account_deletion_jobs j
    WHERE j.public_id = a.public_id AND j.status != 'done'
  )
ON CONFLICT(follower_id, target_id) DO NOTHING;

INSERT INTO owner_follow_backfills (ran_at, added)
VALUES (CAST(strftime('%s', 'now') AS INTEGER) * 1000, changes());
