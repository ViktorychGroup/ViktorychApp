# Instagram and Threads

Public posts from Instagram and Threads land in the same timeline as every other source. The sync does not log in, does not solve a captcha, and does not call a paid API. A photo or video is copied as the file the source already published. Nothing is re-encoded.

## How a timeline is read

Each owner-added account is probed by the Worker on its minute cron, one account at a time, with backoff when a source answers 429. The Feeds page shows that result as Feed OK, Feed slow, or Feed failing, plus **Last updated** and the error text.

The half-hour sync then reads the private catalog and tries these sources in order. The first one that returns real posts wins. A bridge error page is not a post, and the previous posts stay.

1. Local RSSHub, `{rsshubBase}/instagram/user/{handle}` or `{rsshubBase}/threads/{handle}`. Sync starts this container.
2. The public RSSHub mirrors `rsshub.app`, `rsshub.pseudoyu.com`, and `rsshub.rss.tips`.
3. Local RSS-Bridge on port 8080 (`InstagramBridge` or `ThreadsBridge`, Atom).
4. The public RSS-Bridge at `rss-bridge.org`.

RSS and Atom are both accepted. The post id is the shortcode in the permalink. A numeric media id and the full post URL are the same post, so they do not both appear. A caption that the bridge repeated, or a play-icon title, is stored once.

A 429 or a dropped connection is retried with backoff. The last good response is reused when the server answers 304. The source health row records the check time even when the fetch fails.

## Media

Meta CDN addresses expire. The sync asks the public embed for a fresh address when a stored file is expired, close to expiry, or only the `/media` redirect (that JPEG is sent with `Cross-Origin-Resource-Policy: same-origin`, so the page cannot show it).

| Platform | Page the sync reads | Official oEmbed |
| --- | --- | --- |
| Instagram | `/reel/{code}/embed/captioned/` and `/p/{code}/embed/captioned/` | `https://www.instagram.com/api/v1/oembed/` |
| Threads | `/t/{code}/embed` | `https://graph.threads.net/v1.0/oembed` |

The oEmbed thumbnail is only a fallback when the embed page has no file. The original address is the one stored. Checked again on 6 Nov 2026: the Instagram embed document is an error page and sends `X-Frame-Options: DENY`, so the card does not frame it. A `cdninstagram.com` file is sent with `Cross-Origin-Resource-Policy: same-origin` unless the referrer is Instagram, which this site cannot send, so the browser cannot paint that file directly. The card loads it through the existing public media proxy. When the stored file is expired or is only the `/media` redirect, the proxy follows `https://www.instagram.com/p/<code>/media/?size=l` (or `/reel/` or `/tv/` when that is the permalink) and shows that image. If that image is not available, the card keeps the caption and an Open original link. Threads still uses its embed when the stored file is expired. Opening the original still goes to Instagram or Threads.

The extract job and the backup loop mirror those files onto Telegram and R2. Video is remuxed to MP4 (`bv*+ba/b`, `-c copy`). Photos are the original download. Threads video is included. A 403, 429, or captcha skips that file and the next run tries again. Bytes are not re-encoded.

## Limits

- There is no official free timeline API. A logged-out profile page is a shell, so the sync does not scrape it.
- RSSHub and RSS-Bridge are unofficial bridges. They rate-limit, and Instagram often answers them with a login redirect. Several mirrors are tried. When all of them fail, the last good posts stay and the Feeds page shows the error.
- Embed and oEmbed describe one post that is already known. They do not list a profile.
- Comments for these two platforms are fetched during sync only while the post is under 7 days old.
- Stories are separate and stay off unless `IG_SESSION` is set. A session from GitHub Actions is often checkpointed. Leave it unset to keep stories off. See the stories section in the README.
- The Worker cron refreshes one source per minute. A rate limit backs that source off (5 minutes, then 15, 60, up to 6 hours) and honors `Retry-After`.

## What the owner configures

No new secret is required for public posts. Set these only when you want the optional path. Values stay in GitHub or Worker secrets and are not printed.

| Name | Required | What it does |
| --- | --- | --- |
| `IG_SESSION` | no | Instagram stories only. Public posts do not use it. |
| Connected key `instagram` | no | Optional cookie for the extract job. A 401 or a challenge retries once without it. |
| Connected key `threads` | no | Same, for Threads. |
| `TELEGRAM_BOT_TOKEN` | no | With `TELEGRAM_CHANNEL_ID`, the extract job can store original files. |
| `CLOUDFLARE_API_TOKEN` | no | With `CLOUDFLARE_ACCOUNT_ID`, originals can be written to R2. |

Add the account from the Feeds page (a profile URL). The catalog stays in private R2. Handles are not written into this repository.
