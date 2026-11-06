# vsr-playback-2

This directory is the sanitized contract for the ViktorychApp agent. It is not a recording and it contains no key.

`vsr-playback-2.manifest.example.json` is the plaintext shape **after** a local age decrypt of `manifest.age`. On disk the package has:

- `manifest.age` only. Do not read a `manifest.json` if one appears. It is not authenticated.
- one `<sha256>.age` object for the init segment (`ftyp`, not playable as a movie)
- one `<sha256>.age` object per media fragment (`styp` or `moof`)

A fragment is not independently playable. Seek to time T by decrypting the init object and the one media object whose duration window covers T. Then append those two plaintext buffers, init first, to a `video/mp4` SourceBuffer when `capability.browser_mse_likely` is true. Do not invent an avc1 codec string. Do not request a byte range inside an age file. Do not transcode.

Whole-file age backups are a different object and stay that way.

`vsr-playback-1` put arbitrary bytes in cleartext `manifest.json` and treated each blob as its own playable file. That format is withdrawn.

`vsr-sealed-export.example.json` is a separate owner export (`watches.age`, `state.age`, `catalog.age`). It is not a playback manifest. The published player reads `manifest.age` only. The catalog lists package directories and `telegram_files` rows for age objects. Retrieval is `contracts/CATALOG.md`: the Worker uses its existing `TELEGRAM_BOT_TOKEN`, and the browser does not receive it.
