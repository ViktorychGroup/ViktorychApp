-- Notification tabs, one row per tab, so there is no cap on how many tabs an
-- account keeps and two devices never overwrite each other: each row merges
-- on its own updated_at / deleted_at. The notifications module also creates
-- this table on first use; this keeps the schema in the migration history.
CREATE TABLE IF NOT EXISTS notification_tabs (
  public_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (public_id, tab_id)
);
