-- Private custom names a viewer gives to accounts from other networks
-- (X, Reddit, YouTube, forums, RSS...) or to people merged across networks.
-- source_key is "<platform>:<handle or id>" or "person:<merged id>", lower case.
-- Only the viewer ever reads their own rows.
CREATE TABLE IF NOT EXISTS ext_nicknames (
  viewer_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (viewer_id, source_key)
);
