# Storage recordings contract

Contract id: `viktorych.storage.recordings/1`.

The recorder repository `ViktorychBackup/ViktorychStream-Recorder` pull request 1 (`cursor/tiktok-live-recorder-41c0`) and its `docs/APP-STORAGE.md` were not readable from this change. Unauthenticated GitHub and this app's token both received HTTP 404, and a repository search returned no public copy. This document is the format the app implements. It does not claim the recorder package is ready to stream.

## What the page does

Storage stays one page (`#/storage`, with `#/drive` redirected here). The sidebar row stays the existing cloud icon and is labelled Storage. Recordings, provider rows and recorder status sit inside that page. Vault stays its own page. The existing encrypted files and photos stay as they are.

Decryption uses age-encryption 0.3.1 (Filippo Valsorda, BSD-3-Clause), vendored as `vendor/age-0.3.1.min.js`. The release file hash is `112306e7bc83bf28f47e45f632c5989c0ea979cdc7d0e5c71823b3eae7f086ae`. The age identity is held in the tab's memory only. It is not sent to the Worker, not written to localStorage, sessionStorage, IndexedDB or cookies, and not written to logs or analytics. Lock drops the reference. The owner switch is `storage_recordings` (on by default, no server route).

Nothing on this page signs in to Telegram, Google Drive, OneDrive or Cryptomator. Those rows say not connected and have no connect button. Google Drive and Telegram backups that already run as owner jobs are unchanged and are not a browser session. No live credential, private file or real recording is used.

## Package

A catalog is JSON the person opens on this device, or files they pick with it. The page does not fetch a remote recording URL.

```json
{
  "v": 1,
  "contract": "viktorych.storage.recordings/1",
  "kind": "age-byte-chunks",
  "id": "example-clip",
  "title": "Example recording",
  "bytes": 12,
  "media": { "container": "file", "mime": "", "duration": 0 },
  "recorder": { "state": "idle", "detail": "" },
  "chunks": [
    { "name": "000.age", "index": 0, "plainBytes": 12, "sha256": "<sha256 of the age ciphertext>" }
  ]
}
```

`kind`:

| Kind | Meaning | Playback |
| --- | --- | --- |
| `age-byte-chunks` | Ordered slices of one file. Not independently playable media. | No segmented player. Whole-file decrypt and download when the plaintext is within 32 MB. A file within 8 MB whose type the browser can play can be played only after the whole file is decrypted. The page says these are not video segments. |
| `age-file` | One legacy age ciphertext. | Same whole-file path. No re-encoding. |
| `age-media-segments` | One init chunk plus timed media chunks (`start`, `duration`) in `fmp4`, `mpegts` or `webm`. | Media Source only when `MediaSource.isTypeSupported` accepts `media.mime`. Otherwise the page says the format cannot play here and offers whole-file decrypt. Nothing is transcoded. |

Each chunk's `sha256` is the ciphertext. Age then authenticates the payload. A hash mismatch is shown as a changed file. A matching hash with the wrong identity is shown as the wrong key. At most two decrypted pieces are kept while a segmented player is running (the init piece and the piece for the current time). A segment larger than 8 MB is not appended. Seeking loads the piece that covers that time when the package really has timed media segments.

`recorder.state` may be `idle`, `recording`, `stopped` or `unknown`. With no catalog the status is not linked.

Code: `shared/storage-contract.js`, `shared/storage-age.js`, `storage-recordings.js`. Tests: `scripts/storage_recordings_test.mjs`, `scripts/storage_page_test.mjs`.
