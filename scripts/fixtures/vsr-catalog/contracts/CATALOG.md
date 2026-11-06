# Recorder catalog and retrieval

This is the contract the ViktorychApp Storage page did not have. It is not a second playback format. Playback stays `vsr-playback-2` in `manifest.age`. The published parser accepts that manifest only after age decrypt, and it treats `telegram_getfile` as a boolean size flag. The page does not call Telegram.

`vsr-sealed-export` version 1, `sealed: "catalog"`, is the owner catalog. `parsePlainCatalog` in the app rejects plaintext catalogs. Read this document only after `catalog.age` decrypts in the tab. The identity is not sent to a server.

## Retrieval

The Worker already holds `TELEGRAM_BOT_TOKEN` and serves `/tg/…` with `getFile`. That route selects `telegram_files` rows where `encrypted = 0`. Age rows must not use that query.

| Field | Value |
|---|---|
| Route to add | `GET /tg/vsr/{object_name}` |
| Auth | Signed-in owner session. Same owner gate as other owner media. |
| Token in the browser | No. The response is ciphertext bytes only. |
| Worker secret | `TELEGRAM_BOT_TOKEN` (already the Worker secret name) |
| Destination | `TELEGRAM_CHANNEL_ID` (the existing Actions secret). The recorder also reads it as `TELEGRAM_CHAT_ID`. |
| Table | existing `telegram_files` |
| `kind` | `age` |
| `encrypted` | `1` |
| `serve` | `1` |
| `mime` | `application/octet-stream` |
| `object_key` | `vsr/` plus `manifest.age` or `<sha256>.age` |
| `part_index` | `0` manifest, `-1` init, media `index` |
| `sha256` | sha256 of the ciphertext object |
| `size` | ciphertext byte length |
| `file_id` | empty until a confirmed upload. Never a bot token. |

The browser decrypts the bytes with the age identity it already holds. It does not receive `file_id` from an unauthenticated response, and it does not call `api.telegram.org`.

A row with an empty `file_id` is not uploaded. Do not invent a file id.

## Package

The playback directory contains only `manifest.age` and `<sha256>.age`. `catalog.age` stays outside that directory. `telegram_getfile: true` means the ciphertext is within the 19 MiB Bot API margin. It does not mean the page should download it.

Whole-file age backups stay whole-file age backups.
