# Storage recordings

Playback follows the producer contract in `scripts/fixtures/vsr-playback-2/contracts/`. That copy is the `vsr-playback-2` document from recorder commit `ee8fb93e9c8945d6668911d694c3740ee2fb615a`. `vsr-playback-1` plaintext byte-chunk catalogs are withdrawn.

On disk a package has `manifest.age` and one `<sha256>.age` object per init segment and media fragment. `manifest.json` is ignored. The age identity stays in the tab and is not stored or sent.

After `manifest.age` decrypts, every media chunk must have `requires_init: true` and `independently_playable: false`. Seeking decrypts the init object and the one fragment whose `duration_ms` window covers that time, then appends those two plaintext buffers, init first. The manifest leaves `codecs_parameter` as `not probed`. The SourceBuffer codecs string is read from the init segment's avcC and esds. It is not taken from the JSON and it is not a stand-in value. If those boxes are not H.264 and AAC-LC, or the browser will not play that exact string, nothing plays and nothing is re-encoded.

A single age file that is not this package is a download. It is not played. `telegram_getfile` is not a connection: this page does not fetch those objects.

The disposable fixture key under `scripts/fixtures/vsr-playback-2/` is for that test package only. It is not a user key and it is not used for anything else.

Tests: `scripts/storage_recordings_test.mjs`, `scripts/storage_page_test.mjs`.
