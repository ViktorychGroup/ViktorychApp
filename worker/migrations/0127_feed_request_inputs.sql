-- Pending source requests filed with a pasted profile URL keep the parsed
-- handle; their input becomes the same platform:handle id new requests use,
-- so the owner's Allow re-reads them the same way. The Worker normalizes
-- anything this can't (Reddit, YouTube channels, fediverse) when the queue loads.
UPDATE feed_requests
   SET input = platform || ':' || handle
 WHERE state = 'pending'
   AND kind = 'feed'
   AND (input LIKE 'http://%' OR input LIKE 'https://%')
   AND handle != ''
   AND platform IN ('x', 'threads', 'instagram', 'tiktok', 'vk', 'telegram', 'bluesky', 'youtube')
   AND source_key = lower(platform || ':' || handle);
