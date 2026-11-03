-- Who can see a custom status (emoji and text), separate from last seen.
-- Added at runtime by ensurePresenceColumns (duplicate columns would stop every later migration):
-- ALTER TABLE account_status ADD COLUMN audience TEXT NOT NULL DEFAULT 'everyone';
-- ALTER TABLE account_status ADD COLUMN audience_lists TEXT NOT NULL DEFAULT '';
-- Owned status emojis live in store_entitlements (pack_id 'emoji:<id>'), created by 0117_store.
SELECT 1;
