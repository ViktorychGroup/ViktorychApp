# Storage recordings

Playback follows `vsr-playback-2`. Version 1, a plaintext catalog of arbitrary byte chunks with a hash the catalog declares itself, is withdrawn and is refused.

The recorder commit `bc57b92f616a97d175ab238cded81710bdb9a051` was not readable from this environment (the repository answers HTTP 404). The page therefore accepts only a decrypted `manifest.age` with this shape, and ignores `manifest.json`.

```json
{
  "format": "vsr-playback-2",
  "requires_init": true,
  "independently_playable": false,
  "init": "<sha256 of the init ciphertext>",
  "title": "Example clip",
  "fragments": [{ "sha256": "<sha256 of the fragment ciphertext>", "start": 0, "duration": 1 }]
}
```

`requires_init` must be true and `independently_playable` must be false. Each media object is an age file named `<sha256>.age`. The hash is of the ciphertext. A file whose bytes do not match its name is not decrypted.

The plaintext init segment is an ffmpeg `-c copy` fragmented MP4 init (`ftyp` and `moov`, no media data). Each fragment is `styp` plus `moof` and `mdat`, and has no `moov`. Seeking decrypts the init segment and the fragment that covers that time, then Media Source appends the init segment and that fragment. At most those two plaintext pieces are held.

The codec is read from the init segment. H.264 is `avc1` plus the three avcC bytes. AAC-LC is added only when the esds says so (`mp4a.40.2`). Anything else is not offered to the browser and is not re-encoded.

A single age file that is not this package is a download. It is not played.

The age identity stays in the tab. It is not stored or sent. No provider is connected from this page.

Code: `shared/storage-contract.js`, `shared/storage-mp4.js`, `shared/storage-age.js`, `storage-recordings.js`. Tests: `scripts/storage_recordings_test.mjs`, `scripts/storage_page_test.mjs`.
