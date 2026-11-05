# ViktorychApp

How to work on this repo, for the next person or agent: [docs/STATUS.md](docs/STATUS.md#how-to-work-on-this-repo).

<!--
# ViktorychApp

An X-style home for posts from X, Threads, Instagram, YouTube, VK, and other RSS sources. The page is a static site (`index.html`, `styles.css`, `app.js`). GitHub Actions builds the timeline and publishes it. The repository keeps the code, the config, and a small `feeds.json` seed. X replies and YouTube comments load in the browser when a post opens.

The preview snapshot in this repo is real public posts converted by the adapters (about six to eight newest items per configured account). X images stay on `pbs.twimg.com`. Instagram and Threads images stay on the Meta CDN, with each URL's expiry stored next to it.

VK's official community (`vk.com/vk`) is a followed account. Sync calls `wall.get` for that public wall. A `VK_SERVICE_TOKEN` repository secret is used when it is set. Otherwise the sync reads the anonymous client id and secret from the JavaScript vk.com already ships to browsers, exchanges them for a short-lived token, and discards it. The token is not written into the site. Recent comments are stored with the other synced replies. The browser shows those saved posts on the profile, because `api.vk.com` does not allow this page to read the API directly.

Stories are a separate `stories.json`. Every platform that has items shares one tray under the Home tabs: unseen accounts first, then the newest. The viewer moves from one account to the next across platforms. The tray is hidden when that file has no unexpired items. Checked live on 21 Oct 2026:

| Platform | 24-hour stories |
| --- | --- |
| Instagram | RSSHub `/instagram/stories/:user` needs `INSTAGRAM_COOKIE` (`sessionid` and `ds_user_id`). Public viewers (Picuki and the rest) are unofficial scrapers and are not used. The sync calls Instagram's own story query only when `IG_SESSION` is set. A session from GitHub Actions can be checkpointed or disabled. Leave the secret unset to keep stories off. |
| Telegram | Does not work without a user session. Public `t.me/laneharbor`, `t.me/foxglen`, `t.me/s/…`, and `t.me/<user>/s/1` return the channel preview or a profile card. The image is the avatar. There is no story file. Listing stories is `stories.getPeerStories`, and Telegram only allows a logged-in user to call it. |
| VK | Off unless a spare-account secret is set. The sync signs in at vk.com with `VK_LOGIN`, `VK_PASSWORD`, and optional `VK_TOTP_SECRET`, then reads the feed once. If that page is only the site shell, Chromium opens the feed once in the same run. Cookies are reused from an encrypted Actions cache, so it signs in again only when that session is dead. A captcha, SMS or call code, suspicious-login check, block, or 401/403 stops immediately and updates the Sync problem issue. `VK_SESSION` (a Cookie-Editor export) is the fallback. `VK_USER_TOKEN` is the API alternative (`stories.get` and `stories.getById` only). Nothing is marked seen. Photo and video stories use the 24-hour expiry and the VK badge. Steps: [docs/vk-session.md](docs/vk-session.md). |
| X | No stories. Fleets ended in 2021. |
| YouTube | Stories ended on 26 June 2023. Shorts are permanent videos and stay in the feed. |
| Threads, Discord, RSS | No 24-hour story document on the free paths this sync already uses. |

The file is not part of `feeds.json`. Pages serves it, and the data branch stores the same document when the list changes. Items older than 24 hours are dropped. Seen and unseen stay on this device.

## Run it

```bash
python3 -m http.server 8080
```

Open `http://127.0.0.1:8080/`. Hash routes keep the back button working on GitHub Pages. The manifest `id`, `scope`, and `start_url` are relative (`./`), so the installable app is the directory that serves it. On GitHub Pages that directory is the repository name, currently `/ViktorychApp/`. More and the mobile menu include Install app. `sw.js` is registered as `sw.js` with no extra scope, caches the shell, refreshes `feeds.json` and archive shards in the background, and keeps bookmarked images for offline reading. Notifications stay off until that setting is tapped.

| Route | Page |
| --- | --- |
| `#/` | Home, For you |
| `#/following` | Home, Following |
| `#/tab/<listId>` | Home tab for a pinned List |
| `#/@handle` | X profile |
| `#/@handle/status/<id>` | Post |
| `#/threads/<handle>` | Threads profile |
| `#/instagram/<handle>` | Instagram profile |
| `#/rss/<handle>` | Other RSS profile |
| `#/vk/<handle>` | VK profile from the synced wall |
| `#/u/vk/<handle>` | VK profile, with the synced posts when the browser cannot call VK |
| `#/explore?q=` | Search posts and accounts |
| `#/lists` | Your Lists |
| `#/lists/<id>` | List timeline |
| `#/bookmarks` | Bookmarked posts |
| `#/feeds` | Every account in the snapshot |
| `#/settings` | Export / import |
| `#/notifications`, `#/messages` | Empty X-style states |
| `/s/<platform>-<id>.html` | Share preview for a post. Crawlers read this file. People are sent to the post. |
| `/s/watch-<youtubeId>.html` | Share preview for a YouTube watch page |
| `/u/<platform>-<handle>.html` | Share preview for a profile in the snapshot |

`?empty=1` shows the empty timeline. `?error=1` shows the load-failure state.

Share and Copy link use the `/s/` and `/u/` pages under the site origin. The origin is `https://<owner>.github.io/<repo>/`, from `github.repository` in Actions and from the page location in the browser. Each deploy rebuilds them from the current `feeds.json` posts, archive stubs, and accounts, and the previous set is deleted. Those files are not stored in git. Canonical and `og:url` tags use that same origin. A comment, a streamed profile, or any other post that is not in that snapshot shares the original platform URL instead, and the share sheet says why.

## What the page does

Everything below is stored in `localStorage` under `viktorychapp-settings-v1` for a single reader on this browser. The first load copies a value saved under `superintelapp-settings-v1`, then the older key.

- **For you** shows every post, newest first (`sortDate`, otherwise `date`). **Following** shows posts from accounts you follow. **Pinned Lists** appear as extra tabs. The row scrolls sideways with momentum, fading the edge that still has tabs. On a desktop hover, a round chevron on that fade moves about one screen of tabs. The selected tab starts in view. The manage-tabs button stays pinned at the end. The selected tab has the blue underline and a chevron. At the top of the timeline that chevron opens a sheet (a dropdown on a wide screen) for Recent or Popular (Following and Lists) or Show reposts and Show replies (For you). Each of those menus also chooses Show: All posts or Reposts only, and Manage tabs opens the tab editor. Reposts only keeps retweets, reposts, and forwards, newest first by the repost time, and says “No reposts yet” when there are none. The choice is kept on this device, per tab, and in the tab’s URL. Tapping the selected tab, the current section’s nav icon, or the phone header while scrolled down returns to the top first. A further tap on the nav icon at the top loads new posts. Each tab and section keeps its own scroll position, including when you come back from a post.
- **Follow** is a light pill. **Following** is an outline pill that turns into a red **Unfollow** on hover. On the first visit every configured account is followed. Accounts discovered inside posts are not. They show up in **Who to follow**.
- **Lists** can be created, edited, deleted, pinned, and filled from the accounts in `feeds.json`. A pinned list is a Home tab. Its page shows that list’s banner, name, description, member count, and the members’ posts. The chevron on the selected Home tab chooses Recent or Popular, and All posts or Reposts only; a List tab can also be edited or unpinned there. There is no pin cap: the row scrolls sideways, and Manage tabs reorders the full list.
- **Explore** matches post text and account names.
- The bookmark icon saves a post (filled blue). The heart likes it locally (filled pink, count +1). Reposts toggle the same way (green, count +1). None of these leave the browser.
- **Settings** exports and imports that JSON (follows, lists, likes, bookmarks, reposts).

The composer is visual only. This reader does not publish.

## `feeds.json`

```json
{
  "updated": "2026-10-20T19:33:30Z",
  "preview": true,
  "feeds": [],
  "posts": []
}
```

### Account (`feeds[]`)

| Field | Meaning |
| --- | --- |
| `id` | `platform:handle`, for example `x:copperlane` |
| `platform` | `x`, `threads`, `instagram`, or `rss` |
| `handle`, `name` | Public identity |
| `avatar`, `banner` | Image URLs, or paths under `media/` |
| `bio`, `location`, `website`, `url`, `joined` | Profile text. `url` is the profile link |
| `followers`, `following`, `postsCount` | Numbers when the source has them. Omitted otherwise |
| `verifiedType` | `blue`, `business` (gold), `government` (gray), or omitted |
| `configured` | `true` for accounts listed in `feeds.config.json` |

### Post (`posts[]`)

One shape for every platform. The card layout does not change with the source. A small badge and the “View on …” link are the only platform-specific bits.

| Field | Meaning |
| --- | --- |
| `id` | Timeline item id. For a repost this is the repost wrapper |
| `statusId` | The original post id, used in the status URL |
| `feedId` | Account whose timeline this item came from |
| `platform` | `x`, `threads`, `instagram`, or `rss` |
| `kind` | `post`, `repost`, `quote`, or `reply` |
| `author`, `handle`, `avatar`, `verifiedType` | The account shown on the card. For a repost this is the original author |
| `repostedBy` | `{name, handle, avatar}` when `kind` is `repost` |
| `quoted` | Embedded post: author, handle, text, date, media, verifiedType |
| `replyingTo` | `{name, handle, avatar, id}` when this is a reply and the target is known. `id` is the parent status id |
| `text` | Plain text, line breaks kept. Long X notes are the full note text |
| `date` | Display time of the original post |
| `sortDate` | Timeline order. Set when a repost should sort by the repost time |
| `url` | Original post URL |
| `links` | `[{expanded, display, anchorText}]` for real URLs. Media and quote `t.co` links are already removed |
| `media` | `[{type, url, poster, width, height, alt, expires, fallback}]`. `type` is `photo`, `video`, or `animated_gif`. `expires` is the Meta CDN `oe=` time. `fallback` is a second URL tried when the first image fails |
| `images` | Photo URLs, a convenience copy of `media` |
| `stats` | `{replies, reposts, quotes, likes, views, bookmarks}`. A missing stat is omitted, not zero. The icon still shows; the number is hidden when the stat is missing or zero |

Counts under 10,000 use commas. Larger counts use `1.2K`, `24K`, `6.1M`. Times under a day are `5s`, `12m`, `3h`. Same-year dates are `Oct 18`. Older dates include the year. The status page uses `5:56 PM · Oct 20, 2026`.

## Refreshing posts

`feeds.config.json` lists each added account: platform, handle, adapter, and `source_url` with fallbacks. Each added account also stores a permanent id next to the handle. When the account changes its handle, the next sync keeps the same account, and an older link still opens it. These placeholders are filled from the top of the config:

- `{rsshubBase}` — default `http://localhost:1200`
- `{fxtwitterBase}` — default `https://api.fxtwitter.com`
- `{base}` — the feed’s own base, when set
- `{handle}`

```bash
python3 scripts/update_feeds.py              # live sources
python3 scripts/update_feeds.py --fixtures   # rebuild the preview from scripts/fixtures
python3 scripts/selftest.py
python3 scripts/x_to_feed.py response.json --feeds feeds.json --feed x:copperlane --handle copperlane
```

`update_feeds.py` dedupes on platform + id, sorts newest first, and keeps about 300 posts. If a source fails, that feed’s previous posts stay. A post that drops out of the latest RSS page stays in the file until the cap, so its media URL can be refreshed later. Adapters live in `scripts/adapters/`:

| Adapter | Source |
| --- | --- |
| `x_api_v2` | Offline for timelines. Parses a saved X API v2 payload (`data`, `includes.tweets`, `includes.users`, `includes.media`), including the fixture files. A tool header line and a trailing note are ignored. The build does not call `api.x.com` or `api.twitter.com` |
| `fxtwitter` | `api.fxtwitter.com` profile statuses. This is the live X source |
| `nitter_rss` | Nitter RSS (`RT by @…`, blockquote quotes). Fallback when fxtwitter fails |
| `rsshub_threads` | RSSHub `/threads/<user>` |
| `rsshub_instagram` | RSSHub `/instagram/user/<user>` |
| `generic_rss` | RSS or Atom: title, description, `content:encoded`, enclosures |
| `youtube_rss` | YouTube’s official channel feed, `https://www.youtube.com/feeds/videos.xml?channel_id=<UC…>`. No API key. That feed has no CORS header, so the build fetches it. `channelId` is copied onto the profile so the browser can ask for subscribers. Durations and subscriber counts are not fetched during the build. Thumbnails stay on `i.ytimg.com`. The live feed is North Lamp (`UCsyntheticmaple00001000`). Marques Brownlee and Goldthistle exist only as files under `scripts/fixtures/` |
| `youtube_community` | Community posts for a YouTube channel (text, images, polls, shared videos). There is no official feed. The build tries Invidious `/api/v1/channels/<id>/community`, then RSSHub `/youtube/community/<handle>` on the sync container, then Piped if that channel payload has posts, then the public `/posts` page. When that page has fewer than 20 posts, or names the posts tab but the HTML has none, the build sends that tab’s browse id and params to `youtubei/v1/browse` and follows one continuation if it adds posts. Posts already read from the HTML stay. Images stay on `yt3.ggpht.com` / `googleusercontent`. Comments load in the browser from Invidious `/api/v1/post/<id>/comments?ucid=<channelId>`, then `fallback/ytpost_<id>.json` written at sync from the public post page. A failed fetch keeps the previous community posts |

Each adapter strips HTML while keeping line breaks, unescapes entities, drops trailing media links, and fills the same post and profile fields. The configured profile in `feeds.config.json` wins over a thinner profile parsed from a post.

X images stay hotlinked (`pbs.twimg.com`, `video.twimg.com`). Instagram and Threads images stay hotlinked too. A Meta CDN URL carries `oe=`, a hex unix timestamp about five days out, and that time is stored as `expires` on the media object (`posterExpires` when the poster is a different URL). Posts in the latest feed take their URLs from that feed. Older posts whose URLs expire within 36 hours are refreshed from `https://www.instagram.com/p/<code>/embed/` or the Threads post page. When the embed page has no image, Instagram falls through to its public oembed thumbnail and `https://www.instagram.com/p/<code>/media/?size=l`. If a Threads page has no image URL, the current URL stays. A second URL, when one comes back, is stored as `fallback`. The page tries that URL if the first image errors, then shows the gray media tile (`#333639`) with no broken-image icon. Avatars hotlink the same way. A file under `media/` is kept only when no CDN URL could be found. `--download-media` no longer copies files.

Live X accounts use fxtwitter, then Nitter RSS (`nitter.meowing.monster`, `nitter.kareem.one`, `nitter.jaydenha.uk`). `TWITTER_AUTH_TOKEN`, if you set it, is sent only as an `auth_token` cookie on those Nitter requests and on RSSHub `/twitter` or `/x` routes. It is not sent anywhere else. `x_to_feed.py` only merges a JSON file you already have.

## Storage

The browser loads whatever a public CORS API will give it. The build stores only what the browser cannot fetch. A half-hour sync does not commit. Archive stubs are published once a day on the orphan `data` branch. Existing Internet Archive copies stay readable, and new files are not uploaded there.

| Data | Where it comes from | Stored in the site artifact? |
| --- | --- | --- |
| X replies, nested replies, and fresh counts | `api.fxtwitter.com` `/2/conversation/<id>` and `/2/status/<id>`, from the browser, when a post page opens | No. A `comments/<id>.json` file is used only if that call fails |
| YouTube comments | Invidious, rotating hosts from `api.invidious.io`, then `fallback/yt_<id>.json` for a video or `fallback/ytpost_<id>.json` for a community post, then the matching file under `comments/` | The fallback file is written at sync. The comment stub is used only if both of those miss |
| Photos and video | Hotlinked, or loaded by the browser from a permanent URL or an embed | No binaries |
| Timelines | Build: fxtwitter or Nitter for X, RSSHub for Instagram and Threads, YouTube’s RSS feed, other RSS | Yes, in `feeds.json`, about 300 posts |
| Older posts | Append-only stubs in `archive/YYYY-MM.json` on the `data` branch. Existing Internet Archive copies stay read-only | The half-hour artifact includes them. Text only, about 200 bytes each. No media and no comments |
| Meta CDN URL refresh | Build, for posts still in `feeds.json`, because those URLs expire | Yes, as URLs on the post |
| Threads and Instagram comments | Build. The browser cannot call those endpoints without a cookie | Yes, and only for posts under 7 days old. Not copied into the archive |

## Archive

Posts that fall out of the 300-post `feeds.json` window stay on the timeline as stubs. A stub is `p` (platform), `id`, `h` (handle), `d` (date), `k` (kind, omitted for a normal post), and `t` (text, whitespace collapsed, at most 280 characters). Nothing else is stored. `archive/index.json` lists the shard names newest first. The page loads that index and the newest shard with `feeds.json`. Older shards load when the bottom of Home, a profile, or a List scrolls into view.

The seed built from the current `feeds.json` is 35 stubs. Each stub averages **213 bytes** (smallest 106, largest 388, because a 280-character snippet plus the keys can pass 300 bytes). Those 35 posts run from 10 Aug 2026 through 20 Oct 2026, 71 days, which is about 180 posts a year:

`180 × 213 bytes ≈ 38 KB a year`

The 300 KB/year figure is the same stub at a busier pace: `1400 × 213 bytes ≈ 298 KB`, about four posts a day. At the volume in this seed, a year of shards is a few dozen kilobytes.

The browser reads the `data` branch. On a `github.io` host it takes the repository name from the first path segment, so `archive/index.json`, the current UTC month, and the newest shard are requested from `https://raw.githubusercontent.com/<owner>/<repo>/data/archive/<file>` first, because jsDelivr keeps a branch name cached for about 12 hours. Older months start at `https://cdn.jsdelivr.net/gh/<owner>/<repo>@data/archive/<file>`. The owner and repository in those URLs are the ones from the page location, not a name stored in the script. After that host, the page tries the other GitHub URL, then the download URL stored for that file in `archive/ia-manifest.json`. The page loads the manifest before the index, so those archive.org links are available for the index and the shards. Archive.org allows every origin.

Each sync merges a complete archive from the live site, then from the raw `data` branch, then from the shard URLs in that manifest. Stubs already stored keep their first text. A partial download leaves the local files alone, and a source that omits a month leaves that month in place. The half-hour run copies `archive/` into the Pages artifact and does not push the `data` branch. A post that drops out of `feeds.json` between daily updates is in that artifact, and the next build merges it when the live site still has the file. The shards the browser reads change when the daily `data` push lands.

Once a day, at 06:17 UTC, the workflow force-pushes one squashed commit onto the orphan `data` branch. That branch contains only `archive/`. Squashing keeps it at a single commit so the history stays small. It does not upload those shards to archive.org. Existing archive.org links already stored in `archive/ia-manifest.json` stay readable. `IA_ACCESS_KEY` and `IA_SECRET_KEY` may still be set. Uploads stay off unless `IA_UPLOADS_ENABLED` is the word `true`, and no workflow sets it that way. A push made with `GITHUB_TOKEN` does not start another run. The keys are never written to the repo or printed in the log.

When a stub scrolls into view, the browser fills it in and keeps a successful result in IndexedDB (`viktorychapp-live`, key `arch:`) for about 24 hours. A failed request is not stored as a deleted post.

- **X.** `https://api.fxtwitter.com/2/status/<id>` allows every origin and returns the full text, media, counts, and quotes. A 404, or fxtwitter code 404 or 144, is the tombstone below. A network miss keeps the stored snippet.
- **YouTube.** The card uses `https://i.ytimg.com/vi/<id>/hqdefault.jpg` immediately. That host sends `Cross-Origin-Resource-Policy: cross-origin`, so the image loads in an `<img>`. Title, duration, and view count come from Invidious or Piped when the card is on screen. Comments still load on the watch page.
- **Instagram.** Checked in Chrome on 20 Oct 2026. `https://www.instagram.com/p/<shortcode>/media/?size=l` does redirect to a fresh `cdninstagram.com` JPEG, and curl can download it. The browser cannot show that image: the JPEG is sent with `Cross-Origin-Resource-Policy: same-origin`, so the `<img>` errors (`naturalWidth` 0) even with `referrerpolicy="no-referrer"`. The embed `https://www.instagram.com/p/<shortcode>/embed/` does load in an iframe from another origin. The photo inside that frame was 500×666 for `DeZgzTEggQe`. Archive cards use the embed, plus the stored caption and an Open original link. The embed covers video as well as photos.
- **Threads.** There is no `/media` redirect. `https://www.threads.com/t/<code>/media` is 404, and `https://www.instagram.com/p/<threads code>/media/?size=l` is not that post. `https://graph.threads.net/oembed` allows every origin, but the HTML is a “View on Threads” blockquote plus `embed.js`, and inserting it in the page did not produce an image. The post page’s `og:image` is a signed CDN URL with an `oe=` expiry, and the page itself has no CORS header, so the browser cannot read it. `https://www.threads.net/t/<code>/embed` does load in an iframe: the photo post `DeZtp-TkQHh` rendered a 2160×3260 image and the caption, and a text-only post rendered the text. Archive cards use that embed, the stored snippet, and Open original. Newest Threads posts that are still in `feeds.json` keep the Meta CDN refresh. Those URLs are not copied into the archive. If the embed is blocked later, the snippet and the Open original link remain; the gray media tile (`#333639`) is what an image shows when its URL fails.

Comments stay on demand. X and YouTube load them in the browser. Instagram and Threads are fetched during sync only while the post is under 7 days old, and those files are deleted after that. The archive does not keep them.

A post the source says is gone uses X’s tombstone, including the sentence **This post is unavailable.** A network miss does not.

Live responses sit in memory, then `sessionStorage`, then IndexedDB (`viktorychapp-live`) when that quota is full. The cache lasts about 12 minutes. `fetchedAt` is not shown.

X reply order matches the old stored list: the author’s self-thread first, then `likes + replies*2 + reposts`, with a bump for a verified account. Giveaway, link-only, duplicate, and new-account replies sit behind **Show probable spam**. The number on the post stays the source count. Opening a post also loads replies for about 10 of its busiest replies, about 20 each, and stops there. Opening one of those replies loads the next level the same way. A failed live call, with no snapshot, is “Replies aren’t available for this post.”

YouTube comments use the same loader on the permalink, the watch page, a community post, and a comment thread. A live Invidious result says it was updated just now. A fallback file keeps the time stored in that file. A community post reads `fallback/ytpost_<id>.json` after Invidious. The count on the card is the source comment count, not the length of the stored list.

## Replies

Replies are not inlined on the home timeline. The reply count on a post opens `#/@handle/status/<id>` (or the platform equivalent). That page shows the post, a read-only reply row, then replies. A missing thread is “Replies aren’t available for this post.” An empty list is “No replies yet.” Counts and reply text are never invented.

```json
{
  "postId": "2112600761762717997",
  "platform": "x",
  "source": "fxtwitter",
  "fetchedAt": "2026-10-20T18:00:00Z",
  "replies": []
}
```

`fetchedAt` is when that file was last written. The page uses it only to hide a stale file. It is not shown in the interface.

Each reply uses the same post shape, with `kind` set to `reply` and `replyingTo` filled in. X keeps about 50 replies in Relevant order: the author’s own self-thread first, with the vertical line between those avatars, then other replies by `likes + replies*2 + reposts`. A verified account is scored a bit higher. Giveaway, link-only, duplicate, and new-account bot replies are flagged and sit behind **Show probable spam**. The number on the post stays the source’s reply count, not the length of this list.

Every reply is a post of its own. Clicking it opens `#/@handle/status/<replyId>` (or `#/<platform>/<handle>/status/<replyId>`). That page shows the posts above it, connected by the thread line, with **Replying to** on each one. A chain longer than three starts with the first post, **Show more**, and the post it is directly under. Replies to the focused post are listed below it. In that list, a direct reply from the same author, or one from the original poster, is shown under the reply with the thread line. **Show replies** opens that reply’s page when none of those are shown and the reply has replies. **Show more replies** does the same when some are already shown and more exist.

For X, that second level is loaded in the browser for the post you are looking at. Threads and Instagram store one extra level next to the post when the build can see those replies. Opening a reply that neither the live call nor a stored file can fill shows “Replies aren’t available for this post.” The page does not invent replies.

Home, Following, and List timelines hide `kind: reply`, except a self-reply that has another self-reply pointing at it. That post shows **Show this thread**. A profile’s **Replies** tab lists replies from that account.

The build writes comment files only for Instagram, Threads, and `commentRss` posts that have a date and are under 7 days old. Older files are deleted. X and YouTube comment files are deleted even when the post is still in `feeds.json`. A failed comment fetch keeps the file pulled from the last published site. On a successful fetch the new replies replace the file, and a reply id that was already stored keeps the new like count when a field is missing on the new copy. `--fixtures` reads `scripts/fixtures/replies/<statusId>.json` (fxtwitter conversation JSON) or `<statusId>.html` (Nitter status HTML) and does not call the network.

| Platform | How replies are fetched |
| --- | --- |
| X | The browser calls `https://api.fxtwitter.com/2/conversation/<statusId>` (`replies`, one page). A reply is kept only when `replying_to.status` or the conversation id is this post. Replies to a reply are kept only when `replying_to.status` is that reply. Duplicate ids collapse. Deleted or unavailable replies are dropped. Missing text, handle, date, or target is filled from `https://api.fxtwitter.com/2/status/<id>`, up to about 15 lookups. The parent’s `status.replies` updates the count on the post. The browser does not call Nitter or `api.twitter.com`. If the live call fails, the page tries `comments/<id>.json` |
| Threads | Logged-out `threads.net` / `threads.com` post HTML. Replies are read from embedded `direct_replies`, `reply_threads`, or `thread_items`, and `direct_reply_count` is written to `stats.replies`. A reply’s own `direct_replies` are stored under that reply’s id. When the page did not include them, the reply’s own Threads page is fetched for about 10 replies that have replies. Then RSSHub `/threads/post/<code>` when that route is up. `THREADS_COOKIE` is only used if those have no reply text. The cookie is never written to disk |
| Instagram | Logged-out GraphQL, in order: `PolarisPostActionLoadPostQuery` (`doc_id` 8845758582119845), then the current post query `PolarisPostRootQuery` (`doc_id` 29336004576007686) with the shortcode. Then `https://www.instagram.com/p/<shortcode>/embed/captioned/`. Then public viewers (picuki, imginn, dumpor, anonyig). Then RSSHub `/instagram/comments/<shortcode>` and `/instagram/post/<shortcode>/comments` when RSSHub is up. `edge_media_to_parent_comment.count` or `comment_count` is written to `stats.replies`. Child replies come from `edge_threaded_comments` or `preview_child_comments` on that same payload and are stored under the comment id. There is no separate request per comment. `INSTAGRAM_COOKIE` (`sessionid`) calls `/api/v1/media/<id>/comments/` only after the public sources miss. The cookie is never written to disk |
| Other RSS | `wfw:commentRss` is fetched and normalized. `slash:comments` is only the count on the post |
| YouTube | The permalink, the watch page, a community post, and a comment thread all use one loader. It calls Invidious `/api/v1/comments/<id>` (top, then one continuation for about 10 comments that have replies, 20 replies each, no third level). Community posts use `/api/v1/post/<id>/comments?ucid=<channel id>`. Hosts come from `https://api.invidious.io/instances.json` when that directory allows the page origin, otherwise a short built-in list starting with `https://invidious.f5.si`. If that returns nothing, a video reads `fallback/yt_<id>.json` and a community post reads `fallback/ytpost_<id>.json`. The page keeps that file’s `fetchedAt` on the “Updated” label. If the fallback is missing, it reads `comments/yt_<id>.json` or `comments/ytpost_<id>.json`. Sync writes a community file from the public post page: the comment continuation next to the comments section, then `youtubei/v1/browse` (or `next` when the page names that) on www.youtube.com and, if needed, m.youtube.com. One reply page is stored for a few threads. The card count is the header total. A comment thread looks up its video the same way, then the replies stored on that comment. Durations try Invidious `/api/v1/videos/<id>`, then Piped `/streams/<id>`. Subscriber counts try Invidious `/api/v1/channels/<channelId>`, then Piped `/channel/<channelId>`. A missing thread is “Comments aren’t available.” An empty list is “No comments yet.” |

Media inside X replies stays on `pbs.twimg.com` / `video.twimg.com`.

A followed account opens its synced profile (`#/youtube/<handle>` and the same shape on every platform), including from the watch page, a comment, a community post, Subscriptions, and a hover card. That page uses the stored banner, avatar, bio, and posts, and fills a missing subscriber count from Invidious or Piped. Leaving the watch page pauses the player, leaves picture-in-picture, and scrolls to the top. A channel that is not in the catalog stays on `#/u/youtube/<id>`. If Invidious misses, that page reads the public Piped channel (header, then a video search on the same host when the channel payload has no videos). Piped’s trending list is a JSON array, and a host that returns one stays available for that channel page. `youtubei` browse answers 403 and does not allow this site to read it, so the page does not call it. The profile’s external link is the platform name (`YouTube`) so the header stays one line.

Subscriptions (`#/subscriptions`) lists videos from accounts you follow: YouTube channels, plus video posts from X, Instagram, and Threads. A channel chip opens that account’s profile. A video opens `#/watch/<platform>:<id>`. On a wide screen a card previews muted while the pointer is over it. On a phone the card nearest the center of the screen previews muted after you scroll. The same player is used on the timeline, on a profile, on a community post, and on the watch page. A timeline video stays on its poster until you scroll it at least halfway into view. Then one clip, the most visible, plays muted and inline. It pauses when it leaves. GIFs loop and stay muted. A speaker button on the card remembers unmute for this visit, and the remaining time sits at the lower left. A tap opens the watch page, or the media viewer for a file that is not a YouTube video, with sound. Settings → Accessibility has Autoplay videos: On cellular and Wi-Fi (the default), Wi-Fi only, or Never. Reduced motion and Save-Data keep the poster up. The file is not requested until the card is near the screen. YouTube plays in the official `youtube-nocookie` player. The in-feed preview uses `autoplay=1&mute=1&playsinline=1&controls=0` and the thumbnail stays until that player reports playback. The watch page keeps YouTube’s own controls. A direct file is optional, only when playback is set to the device, and any failure returns to the official player. An expired Instagram, Threads, or VK file is requested again; otherwise the poster stays.

The page sends no referrer, which is what `video.twimg.com` and the Meta CDNs require before they will hand a file to another site. X video plays the highest original mp4 on `video.twimg.com`, or the HLS playlist when that is the only file. The file is not re-encoded. Direct, Smart Auto, and Max still choose a direct connection or the media relay, and a relayed X video is not stored in Cloudflare’s cache. The video element sends no referrer to `video.twimg.com`, plays inline, allows picture-in-picture, and requests ranges. If the file errors or stalls for about 3 seconds before the first frame, the card tries the media relay, then the backup APIs. If those fail, or the post has no file in our data at all, the player looks the file up again: fxtwitter in the browser, then the Worker's `GET /v1/xv?id=<id>` (X's public syndication data read on the edge, then fxtwitter and vxtwitter; small JSON with only `video.twimg.com` variants, edge-cached 15 minutes, nothing stored), then vxtwitter in the browser. The highest-bitrate mp4 wins, else the HLS playlist, and it plays in our own player, direct first and relayed second. Only when all of that fails does the card swap to `https://platform.twitter.com/embed/Tweet.html?id=<id>` with `theme=dark` and `dnt=true`. That frame is created in the same turn when the miss is already known, and it is not covered by a click shield. If the embed fails, the card shows **Open on X** (`https://x.com/i/status/<id>`). GIFs loop and stay muted. A Space or broadcast link stays an Open on X link, because the page does not strip `X-Frame-Options`. An m3u8 playlist loads through hls.js. A post with no file resolves its file first (see above) and opens the official embed, behind a tap, only when no file comes back. An X post that arrives as an embed item also plays in our player. Instagram and Threads never store `/media?size=l` as the video file (that URL is a JPEG). Sync reads a real `video_url` from the embed page or oembed when one is published, probes each file with a range request, and writes misses to `status.json` under `videos`. A signed mp4 whose `oe=` time has passed is resolved again in the browser. If no file comes back, the poster stays up with **Watch on Instagram** or **Watch on Threads**, plus Retry. YouTube opens the official `youtube-nocookie` iframe in the same turn as the click, with `referrerpolicy="strict-origin-when-cross-origin"`, `playsinline`, and picture-in-picture where the browser allows it. The page’s own no-referrer policy stays, because `video.twimg.com` and the Meta CDNs still need it; the iframe sets its own policy. A direct combined file (progressive mp4, never a video-only track, never re-encoded) is tried only after the official player reports a player error and only when `settings.playbackSource` is `device` (also read from `settings.devicePerformance.playback`, `settings.performance.playback`, or `viktorychapp-device-playback`). `server` means YouTube’s own player, not a relay. Those file bytes are not requested from `/v1/yt/` and are not stored in the Cloudflare cache. A file that fails is replaced by the official player again. Embedding disabled or a missing video opens the original watch link and is not scraped. Separate DASH audio and video tracks are not played. YouTube comments, durations, and subscriber counts still load when you open the watch page. Share on a post, reply, profile, or the watch page opens X’s menu: a dropdown on a wide screen and a bottom sheet on a phone. Copy link and Share post via… use this site’s permalink (`#/@handle/status/id`, or the profile or watch route). Copy original link and Open original on the platform use the source URL. Share via… is hidden when the browser has no share sheet. Crawlers only see the generic preview in `index.html`, because each post is a hash route.

## Adding an account

Edit `feeds.config.json` and add an object under `feeds`. A push to `main` runs the sync workflow.

```json
{
  "id": "x:someone",
  "platform": "x",
  "handle": "someone",
  "adapter": "fxtwitter",
  "source_urls": ["{fxtwitterBase}/2/profile/someone/statuses"],
  "fallbacks": [
    {
      "adapter": "nitter_rss",
      "source_urls": [
        "https://nitter.meowing.monster/{handle}/rss",
        "https://nitter.kareem.one/{handle}/rss",
        "https://nitter.jaydenha.uk/{handle}/rss"
      ]
    }
  ],
  "limit": 8,
  "profile": { "name": "Someone", "url": "https://x.com/someone" }
}
```

`id` is what Follow stores (`platform:handle`). `adapter` is one of the names in the table above. Instagram uses `rsshub_instagram` and `{rsshubBase}/instagram/user/{handle}`. Threads uses `rsshub_threads` and `{rsshubBase}/threads/{handle}`. Other sites use `generic_rss` and the feed URL. `limit` is how many new items to keep from each fetch. The configured `profile` fills in name, avatar, and bio when the feed is thin.

The new account is followed in a fresh browser. An existing browser keeps its saved follow list until you follow the account from the Feeds page.

Add account on the Feeds page is owner-only. The signed-in owner pastes a profile URL or @handle. The Worker detects the source, checks that it can be read through the existing public fetchers, shows a preview, then stores the row in the private R2 catalog. A sync starts without putting the account in the workflow inputs or in a GitHub issue. Anonymous callers get 404. Any other account gets 403. Facebook has no public feed without a paid API, and Discord still needs the bot already configured for that server, so those two cannot be added from the paste box.

Subscription groups are saved on this device immediately. **Save groups to the site** opens a prefilled issue titled `Subscription groups`. The same owner-only workflow writes the `groups` field in the private catalog and starts a sync, so the groups show up on every device. Edits on this device win until the published list matches. Issues from anyone else are ignored.

## Handle guard

`.github/workflows/handle-guard.yml` runs on pull requests and on pushes to `main`. It reads the private catalog from R2 with the same Cloudflare credentials the catalog job and the site job already use, and builds the comparison list in memory: every followed account handle, plus owner handles, owner ids, and the tracked and unlocked TikTok lists. The list is not printed, saved, or uploaded. Each kept value is hashed with sha256, and the tree is compared by hash. A match is a path and a count.

A platform name, an ordinary English or code word, a token shorter than four characters, or a numeric id shorter than eight digits is left out, so a handle that is only a common word does not flag the source. Those skip rules apply to every list. `HANDLE_ALLOWLIST` is an optional secret of extra words to skip, one per line. `HANDLE_DENYLIST` and `OWNER_IDS` are optional extra lists and are merged in when they are set. None of these three secrets has to exist.

A pull request from a fork, or a run without those R2 credentials, uses the optional lists when they are present and otherwise skips the comparison. The structural self-test still passes. A push to `main`, and a pull request opened from this repository, read the R2 catalog and fail if it cannot be read.

## Discord

Discord is read from the channels listed in the config. The default is a bot you create, using Discord’s official HTTP API. The bot token lives only in the Actions secret `DISCORD_BOT_TOKEN`. It is sent as `Authorization: Bot …` to `discord.com` and is never written into the repo, the site, or the log. If that secret is missing, or Discord rejects it, bot servers are skipped and the rest of the sync continues. Previous Discord posts stay in `feeds.json`. Message files already on the site are copied forward when they can be downloaded.

A server can opt in with `"auth": "user"`. That mode uses the separate secret `DISCORD_USER_TOKEN` and is described below. The sync does not bypass a block, a captcha, or a rate limit.

Anything these reads return is published on this public site. Point them at channels you are willing to show.

`feeds.config.json` has a `discord` list next to `feeds`. Ids are strings, because a snowflake is larger than a JavaScript number. An empty list syncs nothing.

```json
"discord": [
  {
    "id": "123456789012345678",
    "name": "My Server",
    "invite": "https://discord.gg/yourCode",
    "channels": [
      { "id": "234567890123456789", "name": "announcements", "mode": "posts", "limit": 30 },
      { "id": "345678901234567890", "name": "general", "mode": "messages", "limit": 40 }
    ]
  },
  {
    "id": "456789012345678901",
    "name": "A server my account joined",
    "auth": "user",
    "channels": [
      { "id": "567890123456789012", "name": "general", "mode": "posts" }
    ]
  }
]
```

`invite` is optional. It can be a code or a `discord.gg` URL. `limit` defaults to 30 for posts and 40 for messages, and is capped at 100. It is how many messages to ask for on a sync. `window` is how many rows a message file keeps. It defaults to `limit` and is capped at 500. A channel `mode` is `posts` or `messages`. Any other mode is ignored. `"auth"` defaults to `"bot"`. `"user"` is the opt-in account mode. `discord/index.json` repeats that `auth` value on the server. `category` is optional and is copied into the index so the Messages page can group channels.

**posts.** Each message becomes one post in `feeds.json`, on the feed `discord:<guildId>`. The author name and avatar are the person who sent it. The id is `discord:<channelId>:<messageId>` and does not change. `date` is Discord’s `timestamp`, never `edited_timestamp` and never the time the sync ran. Replies and messages in a thread started from one of those messages are nested on `replies` (oldest first) and are not also separate timeline rows. A thread keeps its latest 20 messages, and at most 8 threads per channel are read.

**messages.** A channel is a conversation for the Messages page, not a timeline post. The file is `discord/messages/<channelId>.json`. Author records are stored once. Photos, videos, and other files stay on Discord’s CDN; nothing is downloaded. Attachment URLs are signed and are replaced on the next successful sync. Avatar, server icon, and custom emoji URLs are not signed.

`discord/index.json` lists every configured server and channel. `discord/state.json` stores the newest snowflake per channel so the next run can ask for messages `after` that id. The first request for a channel omits `after` and returns Discord’s newest page, which refreshes those signed URLs. Further pages pass `after` set to the newest id in the previous page. That is the direction this endpoint pages. `X-RateLimit-Remaining: 0` waits `X-RateLimit-Reset-After`. HTTP 429 waits `Retry-After` and tries the same request again. It does not send faster.

The server header comes from the public widget and invite when the server exposes them, then from `GET /guilds/<id>?with_counts=true` for an icon or member count those two left blank. Widget `presence_count` is `online`, not the member count. Member count is `followers`.

### What the page can render

Posts use the same card as every other platform, plus the Discord fields below. The Messages page is `discord-ui.js` and `discord-ui.css`. `#/messages` is the channel list. `#/messages/discord/<channelId>` is one transcript. The page reads `feeds.config.json` for the channel list, then `discord/index.json` and the `file` path on each messages channel. Those paths are relative, like `feeds.json`. A `?fixture=1` query on the hash draws sample messages in the browser and does not write `discord/`. While the tab is in the foreground the page also listens to the public ntfy topic `superintelmusic-discord-th-7f3a91c2`. `.github/workflows/discord-live.yml` is the reader: one job under 5 hours 50 minutes, a cron every 5 minutes that starts only when none is running, and read-only `GET /channels/<id>/messages` at least 1.5 seconds apart. Busy channels are checked about every 10–15 seconds and quiet ones every 2–5 minutes. A channel Missing Access is skipped. A 401, a captcha, a verification challenge, or any other 403 stops the job and writes that status on `discord/index.json`. New messages are posted to that same ntfy topic as JSON (`v`, `ch`, `m`). About every 10 minutes the newest history is deployed with the site. Paths stay relative. If `DISCORD_USER_TOKEN` is missing, the job exits without calling Discord and records `waiting for token`. A message is applied only when its channel id is one of the configured channels, its media URLs are on `cdn.discordapp.com` or `media.discordapp.net`, and the payload is under the length cap. Anyone can publish to that topic, so anything else is ignored.

A Discord post in `feeds.json`:

| Field | Meaning |
| --- | --- |
| `id`, `statusId` | `discord:<channelId>:<messageId>`. Stable. The message id is the same after an edit |
| `feedId` | `discord:<guildId>` |
| `platform` | `discord` |
| `guildId`, `channelId`, `channelName` | Server and the configured channel. The permalink `url` uses the message’s own channel, so a thread link opens the thread |
| `kind` | `post` or `reply` |
| `author`, `handle`, `avatar` | `global_name` or username, the username, and `cdn.discordapp.com/avatars/…` (or an embed default avatar) |
| `bot` | `true` when the author is a bot. Omitted otherwise |
| `text` | Plain text. Mentions are `@Name`, channels are `#name`, custom emoji are `:name:`, markdown markers are removed, spoilers are visible. A Discord `<t:…:R>` relative time is an absolute UTC time so a later sync does not rewrite it. Inline code is left alone |
| `emojis` | Custom emoji in the order of `:name:` in `text`: `{id, name, animated, url}`. The URL is `cdn.discordapp.com/emojis/<id>.png` or `.gif` |
| `date` | Original `timestamp` (`2024-05-01T15:30:00.000Z`). There is no `sortDate` unless some other step added one |
| `url` | `https://discord.com/channels/<guildId>/<channelId>/<messageId>` |
| `links` | The usual `{expanded, display, anchorText}` list. Embed URLs and non-image files are included |
| `media` | Attachments the player already understands: `{type, url, poster, width, height, alt}`. `type` is `photo`, `animated_gif`, or `video`. The URL is the attachment URL Discord returned. A Lottie sticker is omitted |
| `cards` | Link cards from embeds: `{url, title, description, image, author, site}` |
| `replyingTo` | `{id, name, handle, avatar}` on a reply. `id` is the parent post id |
| `replies` | Nested replies and thread messages, same shape, oldest first |
| `threadId`, `threadName` | Present on a message that started a thread |
| `stats` | `likes` is the sum of reaction counts. `replies` is the thread’s `message_count` when Discord sent one |

`discord/index.json`:

```json
{
  "fetchedAt": "2026-10-21T15:00:00Z",
  "servers": [
    {
      "id": "123456789012345678",
      "name": "My Server",
      "handle": "123456789012345678",
      "icon": "https://cdn.discordapp.com/icons/123456789012345678/hash.png?size=128",
      "members": 500,
      "online": 12,
      "invite": "https://discord.gg/yourCode",
      "url": "https://discord.gg/yourCode",
      "channels": [
        { "id": "234567890123456789", "name": "announcements", "mode": "posts" },
        { "id": "345678901234567890", "name": "general", "mode": "messages", "file": "discord/messages/345678901234567890.json" }
      ]
    }
  ]
}
```

`fetchedAt` is when the file was written. It is not a message time. The same profile is merged into `feeds.json` (`id` `discord:<guildId>`, `platform` `discord`, `followers` from the member count, `online` from the presence count, `configured` true).

`discord/messages/<channelId>.json`:

```json
{
  "platform": "discord",
  "guildId": "123456789012345678",
  "channelId": "345678901234567890",
  "name": "general",
  "fetchedAt": "2026-10-21T15:00:00Z",
  "authors": {
    "42": { "name": "Ada Lovelace", "handle": "ada", "avatar": "https://cdn.discordapp.com/avatars/42/abc.png?size=128" }
  },
  "messages": [
    {
      "id": "200",
      "author": "42",
      "text": "Hello @Bob",
      "date": "2024-05-01T15:30:00.000Z",
      "reply": "199",
      "thread": "198",
      "attachments": [{ "type": "photo", "url": "https://cdn.discordapp.com/attachments/…/pic.png", "width": 100, "height": 80 }],
      "cards": [{ "url": "https://example.com", "title": "Example" }],
      "emojis": [{ "id": "99", "name": "wave", "animated": false, "url": "https://cdn.discordapp.com/emojis/99.png" }]
    }
  ]
}
```

`author` on a message is a key in `authors`. `reply` is the parent message id in this channel. `replyAuthor` and `replyText` are a short quote when Discord included the parent. `thread` is the starter message id when this row was read from a thread. `reactions` is `{emoji, count}` and, for a custom emoji, `id` and a `cdn.discordapp.com` URL. An author `color` is `#rrggbb` when Discord sent one. Empty fields are omitted. The list is newest first, capped at the channel `window`.

### Set up the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Open **Bot** and add a bot. Copy the token once. This is the bot token, not a token from the browser’s logged-in client.
3. On that Bot page, turn on the privileged **Message Content Intent** and save. Discord uses that intent for bots that read message text. `GET /channels/{id}/messages` returns `content` for channels this bot can view; the intent is still the switch the portal asks you to enable, and Discord’s message search refuses content without it.
4. Invite the bot with read-only permissions. In **OAuth2 → URL Generator**, choose the `bot` scope and only **View Channels** and **Read Message History**. Or open this URL with your application id:

   `https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=66560&scope=bot`

   `66560` is View Channels (`1024`) plus Read Message History (`65536`). Do not grant Administrator, Send Messages, or Manage Messages.
5. Add the bot to a server you manage. It can only read channels that role can see.
6. In the Discord app, turn on **Settings → Advanced → Developer Mode**. Right-click the server icon and choose **Copy Server ID**. Right-click a channel and choose **Copy Channel ID**. Paste those strings into `feeds.config.json`.
7. On GitHub, open **Settings → Secrets and variables → Actions** and create `DISCORD_BOT_TOKEN` with the bot token. Do not commit it, do not put it in `feeds.config.json`, and do not print it in a workflow command.
8. Push the config. The next sync reads the channels. `--fixtures` does not call Discord.

### Servers your own account has joined

Discord’s Terms of Service and Developer Policy prohibit automating a user account. Discord can ban the account for it. This mode is off unless a server sets `"auth": "user"` and the secret below exists. Use a separate spare account, not the account you use every day.

The token is the full session for that account. Anyone who has it can act as you. It must live only in the Actions secret `DISCORD_USER_TOKEN`. Do not commit it, paste it into `feeds.config.json`, or print it. The workflow masks it in the Actions log. A `token` or `userToken` field in the config is ignored.

The sync only sends GET requests for the configured channels: channel messages, the channel itself, the guild (or the guild preview), and the public widget. It does not send messages, add reactions, join servers, accept invites, or change anything. With both secrets set, a channel the bot can see is read with the bot. The user token is used only for the rest. Requests are at least 1.5 seconds apart, pages are 25 messages, and each later sync continues from the stored snowflake instead of re-reading the whole channel. The first read, when nothing is stored yet, also walks `before` until `limit` messages are in hand. A 429 waits `Retry-After`. A second 429, a 401, a captcha, or an account-verification response stops Discord for that run. The log and `sourceHealth.discord` in `feeds.json` / `sync-report.json` say why, and the run does not try another Discord request. A 403 on one channel means that channel is not visible. It is skipped and the other channels are still read. If `DISCORD_USER_TOKEN` is missing, user-auth servers are skipped and the rest of the sync continues.

1. Log into the spare account at [discord.com/app](https://discord.com/app) in a desktop browser.
2. Open Developer Tools, then the Network tab, and reload. Click a request whose URL is under `https://discord.com/api/`.
3. In the request headers, copy the `Authorization` value. That whole value is the token. It does not start with `Bot `.
4. On GitHub, open **Settings → Secrets and variables → Actions** and create `DISCORD_USER_TOKEN` with that value.
5. On each server you want read this way, set `"auth": "user"` and list only the channel ids you want published. Push the config.

Changing the account password resets the token. To revoke it: change the password, open **User Settings → Devices** and log out of the sessions, delete the `DISCORD_USER_TOKEN` secret, and remove `"auth": "user"` from the config.

### Announcement channels you do not run

Discord will not give this bot the history of a server it has not joined, and joining someone else’s server is their decision. For a public announcement channel, use Discord’s own Follow:

1. In your server, create a channel the bot can view (an announcement channel or a normal text channel).
2. Open the public server’s announcement channel while logged into your own user account.
3. Use that channel’s **Follow** button and pick the channel in your server. Discord copies new announcements into it.
4. Put your channel’s id in the `discord` list. The bot reads the copies from your server. It does not join the public server and it does not scrape the website.

### Server icon and member count

In the server, open **Server Settings → Widget** (Engagement → Server Widget on current clients) and enable the widget. The sync then reads `https://discord.com/api/guilds/<guild id>/widget.json` with no token. That file has the server name, an invite, and the number of people online. The sync resolves the invite with `GET /invites/<code>?with_counts=true`, also with no token, for the icon and the member count. If the widget is off, the guild request still fills the icon and the member count while the bot or the account is a member. Those calls are skipped when Discord itself is skipped.

## Optional secrets

The sync runs without any secrets. Add these only as repository Actions secrets (Settings → Secrets and variables → Actions). They are passed to the job as environment variables when the secret exists, and the workflow never prints them.

| Secret | Used for |
| --- | --- |
| `INSTAGRAM_COOKIE` | Last resort for Instagram comments, after the public sources miss. A `sessionid` value or a full cookie header. Not used for stories |
| `IG_SESSION` | Optional Instagram session for stories only (`sessionid` and `ds_user_id`). Off when unset. A datacenter session can be checkpointed or disabled. Never printed or stored |
| `VK_LOGIN` | Optional phone or email for the spare VK account. With `VK_PASSWORD`, the sync signs in through vk.com. Masked, never printed or committed. Off when unset. Steps: [docs/vk-session.md](docs/vk-session.md) |
| `VK_PASSWORD` | Password for that spare account. Masked. Used to sign in, and to encrypt the cookie cache when `VK_SESSION_KEY` is unset |
| `VK_TOTP_SECRET` | Optional base32 setup key from VK's authenticator-app 2FA. The sync generates the 6-digit code. Recommended so VK does not ask for SMS |
| `VK_SESSION` | Optional Cookie-Editor JSON (or a raw Cookie header) for `vk.com` and `login.vk.com`. Fallback when `VK_LOGIN` is unset. Masked, never printed or committed |
| `VK_SESSION_KEY` | Optional passphrase for the encrypted cookie cache. When unset, the cache key is derived from `VK_PASSWORD` |
| `VK_USER_TOKEN` | Optional VK user access token for stories only, used when `VK_LOGIN` and `VK_SESSION` are unset. Read in the sync for `stories.get` and `stories.getById`, masked, and never printed or stored. Errors 5, 15, and 17 update the Sync problem issue and are not retried. Steps: [docs/vk-stories-token.md](docs/vk-stories-token.md) |
| `THREADS_COOKIE` | Last resort for Threads replies, after the public page and RSSHub miss |
| `TWITTER_AUTH_TOKEN` | Optional `auth_token` cookie sent only to Nitter and to RSSHub `/twitter` or `/x` routes during the build |
| `IA_ACCESS_KEY` | S3 access key. Uploads stay off while `IA_UPLOADS_ENABLED` is not `true`, even when this secret is set. Create both keys at <https://archive.org/account/s3.php> |
| `IA_SECRET_KEY` | S3 secret key. Same guard as `IA_ACCESS_KEY`. The value is never printed |
| `DISCORD_BOT_TOKEN` | Bot token for Discord servers whose `auth` is `bot` (the default). The sync skips those servers when this is unset. Never a user token |
| `DISCORD_USER_TOKEN` | Optional token from a spare Discord account, used only for servers with `"auth": "user"`. Masked in the Actions log. Discord’s terms say automating a user account can get that account banned. Changing the password resets it |

The build refuses `api.x.com` and `api.twitter.com`. X replies are loaded by the browser from fxtwitter, which needs no token. Do not put a bearer token in the page.

## Grayjay

The no-login YouTube requests above follow ideas from FUTO Grayjay’s plugins ([gitlab.futo.org/videostreaming/plugins](https://gitlab.futo.org/videostreaming/plugins)), reimplemented here. None of that source is copied.

Licenses checked on 21 Oct 2026:

| Source | License | Used how |
| --- | --- | --- |
| Grayjay app | FUTO Source First License 1.1 (non-commercial, no sublicensing) | Not copied |
| Official YouTube, Odysee, PeerTube, and Rumble plugins | GNU AGPL-3.0 | Not copied. AGPL would cover this repo if the code were included |
| Community Instagram plugin `b-risk/Grayjay-Instagram` | GPL-3.0 | Not copied |
| grayjay-sources.github.io index | Public domain / Unlicense | The index only. Plugin code is separate |

What was worth reimplementing, and what landed:

- Playback tries the reliable client first. In those plugins that is one of several signed clients. Here the reliable client is the official iframe, which needs no CORS workaround. A combined audio+video file is the optional second step, and only in device mode. Live video stays on the official embed, because a progressive file does not play a live stream. Chapters, captions, and picture-in-picture stay inside that player. SponsorBlock is not called. Checked again on 27 Oct 2026: the public GitHub mirror `futo-org/grayjay-plugin-youtube` is GNU AGPL-3.0, and `futo-org/grayjay-plugin-peertube` is GNU AGPL-3.0. None of that source is in this repo.
- The watch page’s comment continuation is the token whose payload names `engagement-panel-comments-section` (or `comments-section`). Current pages omit `CONTINUATION_REQUEST_TYPE_WATCH_NEXT`, which the old matcher required, so the public `next` call never started. The token is read either way.
- `youtubei/v1/next` is called with the WEB client and the key from that page. If `www.youtube.com` returns no comments, the same body is sent to `m.youtube.com`. One more comment page is loaded when the first page is short. One reply page is loaded for up to four threads that have a reply count and no inline replies. Both `commentEntityPayload` and the older `commentRenderer` shape are read. There is no third level.
- Community posts use the posts tab’s `browseEndpoint` from the channel HTML when `ytInitialData` has no posts, and when that page has fewer than 20. One browse continuation is followed when it adds posts. A shared video title is read from either a string or the public text runs.

What was not taken:

- Bot attestation (`jnn-pa.googleapis.com` / botguard) is a bot check. This build does not solve it, and it does not embed another client’s API key.
- The Instagram plugin rotates Kittygram frontends. On 21 Oct 2026 those hosts were down, empty, or behind a proof-of-work challenge. This build does not solve that challenge. Instagram comments stay on logged-out GraphQL, the captioned embed, and the public viewers already listed above.
- Grayjay has no official plugin for X, Threads, or VK. X replies stay on fxtwitter, then Nitter. Threads stays on the public mobile post page. VK stays on the public wall API. A VK Video plugin is only an open request there.

Worth adding later, against each site’s own public API (their Grayjay plugins are AGPL, so only the API is of interest):

- **PeerTube.** `GET /api/v1/videos` and `GET /api/v1/videos/:id/comment-threads` on an instance. No login.
- **Odysee.** Public claim and comment endpoints.
- **Rumble.** Public pages and embeds.

## GitHub Actions

`.github/workflows/sync.yml` runs every 30 minutes and on **Run workflow**. It refreshes feeds and calls the reusable `.github/workflows/publish-app.yml` publisher in parallel. A non-data push to `main` starts **Publish app** directly without running a feed refresh. The job starts RSSHub (`diygod/rsshub` on port 1200) and RSS-Bridge (`rssbridge/rss-bridge` on port 8080). It downloads the last published `feeds.json` (and Instagram/Threads comment files under 7 days old) so a failed source can keep the previous data. Instagram and Threads try the local RSSHub container, then the public RSSHub mirrors in `feeds.config.json`, then RSS-Bridge. X timelines try fxtwitter, then the Nitter mirrors. One failed source keeps that feed’s previous posts and does not fail the run.

If the sync fails or a followed source returns nothing for six hours, **Sync feeds** opens one **Sync problem** issue. A publishing failure opens a separate **App publish problem** issue. A later run edits that issue when the failure changes, and closes it with “Sync is healthy again.” once the next sync is healthy. GitHub emails that to the repository owner. A source that is merely quiet still counts as healthy when its fetch returns posts.

The half-hour job does not commit `feeds.json`. It copies `index.html`, `app.js`, `styles.css`, `favicon.svg`, `favicon.ico`, `manifest.webmanifest`, `sw.js`, `icons/`, `splash/`, `screenshots/`, `.nojekyll`, `feeds.json`, `archive/*.json`, any `comments/*.json`, and `discord/**/*.json` into `_site`, stamps the commit SHA into `_site/sw.js`, prints the artifact size, and fails if that directory is over 200 MB. `actions/upload-pages-artifact` and `actions/deploy-pages` publish `_site`. `comments/`, `media/`, and `archive/` are gitignored, so `main` keeps the code and the `feeds.json` seed. At 06:17 UTC the workflow force-pushes one squashed commit to the orphan `data` branch and does not upload to archive.org. It prints Cloudflare R2 usage and warns at 8 GB. See Archive above.

## Internet Archive backup

New uploads to archive.org are off. `.github/workflows/ia-backup.yml` is manual only, in its own `ia-backup` group, so it does not cancel a Pages deploy. The 07:47 UTC schedule is gone. The script still receives `IA_ACCESS_KEY` and `IA_SECRET_KEY` when those secrets exist, and it exits 0 before any archive.org request because `IA_UPLOADS_ENABLED` is not `true`. Workflows set that variable to `false`. The default, when the variable is unset, is the same. The key values are never written to the log or the repo. Nothing is deleted, and no existing item is modified.

The page still reads `archive/ia-manifest.json` from the relative `archive/` path. When a live image or video fails, it tries the private R2 copy served by the accounts worker at `/v1/archive/<sha256>.<ext>`, then the old `https://archive.org/download/…` URL, then `https://cors.archive.org/cors/…`. The R2 object stays in the private bucket `viktorych-data`. A new post has no archive.org copy, so it stays on its source URL. The one-off empty job deletes the files this account uploaded. The page uses the R2 copy, and that job does not send email.

Cloudflare R2 is the storage already in place. The private bucket `viktorych-data` holds account avatars and banners, a few hundred kilobytes at most. The public music and radio bucket holds those streams. A video or other file larger than 1 MiB is not copied onto R2. The 06:17 UTC job runs `scripts/r2_usage.py`, prints account R2 usage when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set, and warns in the log at 8 GB of the 10 GB free tier. It does not upload the feed to R2 or to archive.org.

The code that used to upload is still default-deny: only a credential-free public source in `ia_public_sources` could pass, TikTok stays off an empty `ia_tiktok_allow`, and Discord, VK, Nitter, generic RSS, private accounts, DMs, account data, music, and radio stay out. That filter is not reached while `IA_UPLOADS_ENABLED` is off. A copy already on Internet Archive that fails the filter is left in place. The private copy is the Google Drive folder described in [docs/gdrive-backup.md](docs/gdrive-backup.md). The Drive job does not delete anything from Internet Archive.

`.github/workflows/ia-retire.yml` no longer starts from a push. Its copy, publish, and delete steps are turned off (`if: false`). A manual run does not contact archive.org. `scripts/ia_retire.py` also returns 0 before any request unless `IA_UPLOADS_ENABLED=true`. Anonymous items are not deleted. The keys are not printed.

## Google Drive backup

`.github/workflows/gdrive-backup.yml` runs at 09:17 UTC and from **Run workflow**. It uploads to the owner's Google Drive with rclone and a user OAuth token, `GDRIVE_RCLONE_TOKEN`, scope `drive.file`. A missing secret skips the job and exits 0. The token is not printed. Service accounts are not used.

The folder is `ViktorychApp-backup/`. `music/` and `covers/` are ViktorychMusic songs and covers. `radio/` is the loop audio. `tiktok/` is TikTok that is not on `ia_tiktok_allow`. `media/` is video the Internet Archive rule rejects, largest first. Files already stored are skipped by SHA-256. One run uploads at most 400 MB and 500 new files, and it stops after 40 minutes. ViktorychApp account data is not uploaded. The Windows steps that create the token are in [docs/gdrive-backup.md](docs/gdrive-backup.md).

## Telegram backup

`.github/workflows/telegram-backup.yml` runs at 11:17 UTC, after Sync feeds, and from **Run workflow**. It copies private R2 media into a private Telegram channel with `TELEGRAM_BOT_TOKEN`. A missing `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHANNEL_ID` skips the job and exits 0. The token is not printed. Files of at most 19 MB are one document the site can play through the accounts Worker at `/tg/<key>`. Larger video and long audio, other than radio, become short HLS segments the Worker can play. Larger archives are backup parts only. Songs, covers, radio, every loop version, and story, avatar, and banner media are mirrored to Telegram and stay on R2. The player uses that copy only when R2 fails. TikTok videos, posters, and photo carousels, plus other synced media from X, Instagram, Threads, VK, Facebook, and YouTube thumbnails, play from `/tg` first and are removed from R2 after the sha256 check. `.github/workflows/media-extract.yml` downloads new public originals for added accounts (cuentas añadidas, добавленные аккаунты) every 3 hours and after Sync feeds, remuxes videos to mp4, saves full-size photos with gallery-dl, and uploads them for `/tg`. TikTok LIVE is not recorded. The song AES key, owner files, backup internals, live JSON, and account data stay off Telegram. Account data is uploaded only as ciphertext when `TG_BACKUP_KEY` is set, and it is not played and not deleted. `/tg` still requires a signed-in session except the public radio loop, and Shorts stay owner-only. The setup steps are in [docs/telegram-backup.md](docs/telegram-backup.md).

## Installed app

A long-press on the icon opens Search, Bookmarks, Subscriptions, and Notifications. The manifest has a description, richer-install phone and desktop screenshots (real UI frames), shortcuts, Share Target, file handlers, protocol handlers, window-controls-overlay, a maskable icon, and a monochrome icon. iOS startup images cover the common iPhone and iPad sizes. The theme color follows the appearance setting: white, dim (`#15202b`), or black.

Sharing a link or a file into the app is a POST multipart share target. An X, Threads, Instagram, YouTube, VK, or RSS link opens the post when this site already has it, the YouTube watch page for a video id, or the live profile with Follow. Anything else opens the add-account screen.

The app badge is the number of new posts from accounts you follow since the app was last open. It clears when the app comes to the foreground. Chromium can also set it from periodic background sync.

Home keeps a separate scroll position for For you and Following. A horizontal swipe moves between those two tabs. A swipe from the left edge goes back. Timeline and post changes use the View Transitions API when the browser has it. Photos open in a viewer: pinch to zoom, swipe between images, swipe down to close. Videos keep playing in the background with the system media controls, and the watch page can go picture-in-picture. A short vibration fires on taps where `navigator.vibrate` exists. Buttons use `touch-action: manipulation`, chrome does not select text, and the page contains overscroll. The first load shows skeleton rows, then the last timeline saved on this device, then the fresh feed.

Offline, that saved timeline and the posts you opened stay readable. A banner says you’re offline. A bookmark made offline is stored immediately, and its images are fetched the next time the device is online. The service worker also keeps the shell and a capped media cache.

When a deploy activates a new service worker, the page shows **New version available** and Refresh.

Periodic background sync is registered only after notifications are turned on, and only in browsers that implement it (Chromium). It refetches `feeds.json` about every 30 minutes and can raise the badge. iOS does not run that API. There is no push server in this repo. Web Push would need a VAPID private key in an Actions secret and a place to store each browser’s subscription endpoint. Those endpoints are credentials. GitHub Pages cannot accept the subscription POST, and writing the endpoints into this public repo would publish them. A repository secret cannot be updated by the page. Building that would need a new account or a private store, so it is not built. The in-app notification toggle and periodic sync stay the free path.

## GitHub Pages

Pages has to be built by GitHub Actions (Settings → Pages → Build and deployment → Source: GitHub Actions). A deploy-from-branch source will not pick up this workflow. `.nojekyll` is in the artifact so Pages does not run Jekyll. Paths are relative (`feeds.json`, `styles.css`), so the site works at `/` or under the repository directory. The published path follows the repository: `https://<owner>.github.io/<repo>/`. `404.html` sends a missing file under that directory back to the matching hash route. Saved settings stay under `viktorychapp-settings-v1` and the other `viktorychapp-` keys. The first load copies `superintelapp-` keys, then the older keys, so a rename does not drop them.
-->
