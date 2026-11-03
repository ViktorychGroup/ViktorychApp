# Canonical post schema

Every item we pull from another platform ends up as one **canonical post**. The timeline, the single-post page, profiles, search, P2P sharing and the archive all read only this shape. A platform changing its markup should change one adapter at most, never the renderer.

- Machine-readable schema: [`docs/post.schema.json`](post.schema.json) (JSON Schema 2020-12; extra keys are allowed, the listed keys are checked).
- Gate: [`scripts/normalize.py`](../scripts/normalize.py) validates, repairs or quarantines every post and profile right before `feeds.json` is written (`scripts/update_feeds.py`, after Discord is merged in).
- Tests: [`scripts/normalize_test.py`](../scripts/normalize_test.py) (golden fixtures per source; run by `handle_guard.py --selftest`, which both the `smoke` and `guard` checks run).

## Pipeline

```
fetch (Actions / Worker proxy / bridges)
  -> adapter per source (scripts/adapters/*.py, all build posts with common.post_shell)
       -> fallback on top: adapters/fallbacks.universal() if the adapter crashed or found nothing
  -> merge, dedupe (common.dedupe_posts), cross-post fold (people.dedupe_cross_posts)
  -> normalize.enforce_document(): repair or skip each item, count parse health
  -> feeds.json (+ parseHealth) -> sync-report.json -> "Sync problem" issue on drift
  -> client (app.js) renders; rich HTML only through the #369 allowlist sanitizer
```

Adapters: `x_api_v2`, `fxtwitter`, `nitter_rss`, `rsshub_x` (X); `rsshub_threads` (Threads); `rsshub_instagram` (Instagram); `youtube_rss`, `youtube_community` (YouTube); `telegram`; `vk`; `discord` (merged by `merge_discord`); `generic_rss` (RSS/Atom, newsletters, Reddit/Discourse feeds); `fallbacks.parse_json_feed` (JSON Feed). TikTok (`tiktok_sync.py`) also emits this shape. Its fetch workflows stay enabled.

## Post

| Key | Type | Notes |
|---|---|---|
| `id` | string, required | Source id. Made from a URL hash if a source gives none. Items with neither id nor URL are skipped. |
| `statusId` | string | The platform's own status id (defaults to `id`). |
| `ref` | string | Stable source identity, `platform:statusId`. |
| `cid` | string | Content id `c1-<32 hex>`: SHA-256 of ref, handle, text, media URLs (no query strings) and date. Same on every device; counts don't change it; edits do. Lets a P2P peer verify a copy. |
| `platform` | string | `x`, `threads`, `instagram`, `youtube`, `tiktok`, `telegram`, `vk`, `discord`, `reddit`, `rss`, ... Guessed from the URL when missing. |
| `feedId`, `iaSource` | string | Which configured feed and which adapter produced it. |
| `kind` | enum | `post`, `reply`, `repost`, `quote`, `community`, `article`, `short`, `live`, `story`. Unknown values become `post`. |
| `author`, `handle`, `avatar`, `verifiedType` | | Handle has no `@`. Missing author falls back to the handle, then the platform name. A missing or non-http avatar is `""`, and the client draws an initial avatar. |
| `text` | string | Plain text. HTML entities decoded once, NFC, control characters removed; emoji, ZWJ sequences, RTL text and marks, mentions, hashtags and URLs untouched. If a source starts sending HTML here, it is converted to text plus media. |
| `html` | string | Optional rich body (Discord, articles). Rendered only through the allowlist sanitizer from #369; there is no second sanitizer. |
| `links` | array | `{expanded, display, anchorText}` URL entities. |
| `link` | object | Link card `{url, site, title, description, image}`; dropped when the URL is unusable. |
| `date`, `sortDate` | string | UTC ISO `YYYY-MM-DDTHH:MM:SS.000Z`. Accepts ISO with offsets, RFC 822, unix s/ms, date-only, and "3 hours ago". Unreadable or more than 36 h in the future becomes `""` (sorted last, never a fake time). |
| `url` | string | http(s) only. |
| `media` | array | See below. |
| `images` | array | Photo URLs, always rebuilt from `media`. |
| `stats` | object | `replies`, `reposts`, `quotes`, `likes`, `views`, `bookmarks` as non-negative ints. `"1.2K"`, `"3,400"`, `"12 тыс."` parse; unknown counts are **omitted** (soft blank in the UI), never written as 0. |
| `poll` | object | `{question?, choices: [{text, percent?, votes?}], totalVotes?}`. `options` is accepted and renamed. No readable choice drops the poll. |
| `article` | object | Long-form body (X Articles, newsletters). |
| `repostedBy` | object or null | The person who reposted. The post itself is the original, so its own `ref`/`cid` identify it. |
| `quoted`, `replyingTo` | referenced item or null | See below. |

## Referenced items (quote, reply parent, repost)

A quoted or replied-to item is embedded **inside** the parent post, fully normalized (author, handle, avatar, text, media, counts, date), so it renders without fetching the referenced account's timeline and travels with the parent over P2P.

| Key | Notes |
|---|---|
| `embedded` | `true` when the item carries enough to render on its own; `false` when only its identity is known. |
| `ref` | `platform:statusId`, inherited platform from the parent when missing. |
| `cid` | Content id (only when `embedded`), same formula as posts, so a peer can check the embed matches. |
| ... | The usual post keys: `author`, `handle`, `avatar`, `text`, `media`, `stats`, `date`, `url`. |

When `embedded` is `false` the client fetches the item live on demand (`fillReferenced` in `app.js`, X via the fx status lookup, cached) and re-renders; if that fails the card still shows author, handle and an "open original" link. An unreadable quote is dropped and the parent still shows, as a normal post.

## Media

`{type, url, poster, width, height, alt, duration?}` plus source extras (`stream`, `fallback`, `expires`, `videoId`...).

- `type`: `photo`, `image`, `video`, `animated_gif`, `audio`, `embed`, `placeholder`, `file`. A known type is never rewritten. Missing or unknown types are detected from aliases (`gif`, `reel`, `hls`...), then MIME, then extension (`.mp4 .m3u8 .mpd .webm .mov` video, `.gif` animated, `.mp3 .m4a .ogg .opus` audio, YouTube/Vimeo hosts embed), else photo.
- `url` is kept byte for byte: original quality, hotlinked, never re-encoded or re-sized. Only http(s), protocol-relative (made https) and our own `media/...` paths are accepted.
- Video, GIF, embed and placeholder entries may have an empty `url` (the client uses the Meta embed, `videoId` or "Open original"). Other entries without a usable URL are dropped; duplicates are merged.

## Profile

`{id, platform, handle, name, avatar, banner?, bio?, url?, followers?, following?, postsCount?, verifiedType?}`. Counts follow the same rule: unknown means omitted, so the profile shows the last cached count or a soft blank, never 0.

## Defensive parsing

- Adapters keep their own strategies (API JSON, embedded JSON, HTML). `adapters/fallbacks.py` adds:
  - `universal()`: when an adapter crashes or returns nothing, the payload is sniffed and parsed as RSS, Atom or JSON Feed. HTML is never guessed into a post, so an error or login page cannot become a card. A truncated feed still fails the fetch, which keeps the last good posts.
  - `meta_from_html()`: JSON-LD (`SocialMediaPosting`, `Article`, `VideoObject`... including `@graph`) first, then Open Graph, Twitter card, `itemprop`, `<link rel=canonical>` and `<title>`; `post_from_meta()` turns it into one post.
  - `parse_json_feed()`: JSON Feed 1.0/1.1 with attachments.
- `generic_rss` prefers Atom `rel="alternate"` over `self`/`replies`, parses any date format, and hashes title+date when an entry has no id or link.
- Dedupe: by `(feedId, id)` at the gate, plus the existing repost/cross-post folding.

## Validation and quarantine

`enforce_document()` runs on every sync. Each post is repaired (logged as `[normalize] ...` with a reason) or skipped when it cannot render: no id and no URL, nothing to show, or still invalid after repair. Profiles are repaired the same way. The step is wrapped so a bug in it never stops the sync.

## Drift detection

Per `platform/adapter` (never per account), fresh items are counted as clean, repaired or skipped. `feeds.json` keeps `parseHealth` with the rate, the last six rates and the top reasons. A source is **drifting** after two runs in a row with at least 5 items and either under 80% usable or 20 points below its recent best. `sync_health.write_report` copies it into `sync-report.json`, and the existing "Sync problem" issue lists it ("x/fxtwitter parsed only 30% of 10 new items twice in a row...").

Check a document by hand: `python3 scripts/normalize.py --check feeds.json`.

## Adding or changing a source

1. Build posts with `post_shell(...)` in a new `scripts/adapters/<source>.py`, register it in `adapters/__init__.py`.
2. Add a fixture with made-up names only (no real handles, usernames or ids) and a row in `SOURCES` in `scripts/normalize_test.py`.
3. `python3 scripts/normalize_test.py --update` after an intended output change, and review the diff of `scripts/fixtures/normalize/golden.json`.
