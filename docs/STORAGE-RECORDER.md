# Storage recordings

Playback follows the producer contract in `scripts/fixtures/vsr-playback-2/contracts/`. That copy is the `vsr-playback-2` document from recorder commit `ee8fb93e9c8945d6668911d694c3740ee2fb615a`. `vsr-playback-1` plaintext byte-chunk catalogs are withdrawn.

On disk a package has `manifest.age` and one `<sha256>.age` object per init segment and media fragment. `manifest.json` is ignored. The age identity stays in the tab and is not stored or sent.

After `manifest.age` decrypts, every media chunk must have `requires_init: true` and `independently_playable: false`. Seeking decrypts the init object and the one fragment whose `duration_ms` window covers that time, then appends those two plaintext buffers, init first. The manifest leaves `codecs_parameter` as `not probed`. The SourceBuffer codecs string is read from the init segment's avcC and esds. It is not taken from the JSON and it is not a stand-in value. If those boxes are not H.264 and AAC-LC, or the browser will not play that exact string, nothing plays and nothing is re-encoded.

A single age file that is not this package is a download. It is not played. `telegram_getfile` is a field on the decrypted manifest. When it is true, Storage says so and does not download the object. There is no Telegram client on this page.

`BACKUP_RECIPIENT` in `shared/storage-contract.js` is the public age recipient. The private identity is typed into the tab and is not saved or sent. The page does not ask a server for it.

`catalog.age` is a `vsr-sealed-export` catalog. After it decrypts in the tab, each object is named `manifest.age` or `<sha256>.age`. Retrieval is `GET /tg/vsr/{object_name}` on the accounts Worker. The caller must be the signed-in owner. The response is ciphertext bytes only. `file_id` is not returned. The public `/tg` route still requires `encrypted = 0`, so an age row cannot be played as clear media.

An empty `file_id` answers `not_uploaded` and does not call Telegram. If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHANNEL_ID` is missing, a row that does have a `file_id` answers `not_configured` and does not call Telegram. This page does not upload, record, or schedule anything.

When those two Worker secrets are added later, use the existing names. The recorder reads the channel as `TELEGRAM_CHAT_ID`; that is an alias, not a second bot. From `worker/`:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN --name viktorych-accounts
npx wrangler secret put TELEGRAM_CHANNEL_ID --name viktorych-accounts
```

Do not paste the values into the repo, a log, or chat. Until a real upload writes a `file_id`, the catalog stays Not uploaded. The tests mock Telegram. They do not prove a live channel.

The disposable fixture key under `scripts/fixtures/vsr-playback-2/` is for that test package only. It is not a user key and it is not used for anything else.

Tests: `scripts/storage_recordings_test.mjs`, `scripts/storage_page_test.mjs`.
