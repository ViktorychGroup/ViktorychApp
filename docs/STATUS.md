# Status snapshot

Written 2026-11-04 (UTC). Main is `4dbba231`. Latest D1 migration is `0131_shorts_on.sql`. This is a snapshot: check `gh pr list` and `git log origin/main` before acting on it. Update this file at the end of every PR.

## How to work on this repo

Any person or agent can take over from this section. Rules for shipping, checks and merges are here. Longer history is in `docs/HANDOFF.md`. The agent guide is `AGENTS.md`.

**Shipping.** Ship the part that already passes. If one part keeps failing CI, drop it from the pull request and redo it later as its own pull request. Do not loop on the same red check. After a split, parts that already passed only need the quick checks: `node --check` on the scripts you touched, `python3 scripts/check_i18n.py`, `python3 scripts/assemble_site.py --selftest`, `python3 scripts/handle_guard.py --selftest`, and `python3 scripts/secret_scan.py --staged`.

**One change per pull request.** One fix per pull request. Do not bundle a doc change, a workflow change and a product fix in the same pull request.

**This file.** Every pull request updates `docs/STATUS.md`: what merged, what is live, the paused roadmap, the current plan, the working rules and the owner to-dos.

**CI.** Page smoke is sharded and finishes in about 2.5 minutes. Locally, `scripts/smoke-all.sh` runs those scripts in parallel (`--jobs` sets how many at once; `--shard` runs one job). A pull request that only touches `**/*.md` and `docs/**` does not run that suite. `.github/workflows/smoke-docs.yml` still reports the required check named `smoke` and succeeds, so the pull request can merge. A pull request that also changes code runs the real Page smoke workflow as well, and that result must pass. Fix the root cause of a failure. Never weaken a test, drop an assertion or skip a check to make CI green, except by moving a still-failing part into a later pull request as described above.

**Merge.** Squash-merge only when every check is success or skipped and the pull request is clean. Pin the merge to the head commit (`gh pr merge <n> --squash --match-head-commit <sha>`). After a merge to main, rebase or merge main into any open pull request whose state becomes dirty.

**Verify live.** After a merge, the published `version.json` shows main's commit, and the accounts watchdog returns HTTP 200. If a deploy fails on a transient Cloudflare API error (for example error 10013), the owner re-runs the failed jobs, Accounts first and then Sync feeds. Agent tokens cannot re-run Actions.

**Hard rules.** No usernames, handles, display names or account identifiers in the public repository, pull requests, commits or logs. Never weaken the handle guard. Secrets live only in GitHub Actions secrets and Cloudflare Worker secrets. Do not edit `.github/` without the owner's approval; put a ready patch in `docs/owner-patches/` instead. No force-push and no history rewrite without asking. No paid APIs. Do not bypass a block, a guard or a failed check.

**Current state.** Main is `4dbba231` (feed body reads and the storage permission stay off the scroll). This pull request starts a public media segment from a nearby peer at the same time as the CDN, and a copy already on the device is returned without waiting for that peer. Still open: the phone sign-up welcome step (`scripts/signup_flow_test.mjs`, no part flag and no assertion changes; it is not in the sharded jobs). The TikTok and Shorts roadmap stays paused. X-style replies and quotes wait for the owner's go.

## Speed log

Desktop, CPU slowed 4×, unless a row says otherwise. Each row is the change that landed.

| Change | Before | After |
| --- | --- | --- |
| Main tabs, return | Explore 69ms, Notifications 75ms, Messages 52ms, Profile 74ms, Following 235ms, Communities 330ms. Scroll from that visit was not kept. | Explore 44ms, Notifications 34ms, Messages 39ms, Profile 43ms, Following 64ms, Communities 108ms. Explore, Notifications, Messages and Communities came back at 420px. Profile and Following settle at 96px, as they did before. |
| Music code | `music.js` 125 KB, `ytm.js` 58 KB and `music.css` 27 KB (210 KB) download with every visit | Those files load when music is opened, or when a song is already queued so the mini player returns. The dock check passed on phone, desktop, tablet and landscape. Live at `f38acb31`. |
| Signed-out first paint | Phone, 4G, CPU slowed 4×, live site: first paint and largest text 2.0s, the landing paragraph, layout shift 0. `styles.css` (273 KB) finished at 1.8s and held that paint. | Live after: first paint and largest text 1.55s. `styles.css` finished at 2.3s, after the paint. Layout shift 0.015. Signed-in visits still wait for the sheet. Live at `6ac5caa8`. |
| Home scroll, next page | CPU slowed 4×, phone width. Loading the next posts rebuilt the whole shell inside the scroll observer: 226ms of script, frame 287ms (237ms blocking). | The new cards are inserted eight at a time on later frames. The longest app script in that scroll was 36ms. Feed clicks and community scroll still passed. |
| Like, repost, follow, compose | The new state waited for a full page redraw inside the tap. | The control flips (or presses) before that redraw. The redraw runs on the next frame. |
| Open a post or profile | A post was rebuilt on every return. A profile fetch started at the click. | Leaving a post keeps that page and puts it back, same as the main tabs. A profile link starts its fetch on hover or touch. Live at `93c99f1a`. |
| Saved home, per account | Phone, CPU slowed 4×. The last account's home was painted for the next account on the device (the restored screen included that home). Same-account warm open, feed held 3s: content at 203ms. | The other account does not get that screen. Same-account warm open, feed held 3s: content at 166ms. Route copies are stored per account. IndexedDB still fills them in and the page paints when that copy arrives. Sign-out still wipes the store. Likes, reposts, follows and posts still apply immediately and retry from the outbox when online. |
| Scroll, remaining long tasks | Phone, CPU slowed 4×. During a scroll the feed response body read took 112ms and persistent storage took about 80ms. Worst frame 118ms (58ms blocking). | Those two wait until scrolling is quiet or the thread is idle. Worst frame in the same scroll was 83ms (18ms blocking). Longest app script 25ms. Live at `4dbba231`. |
| Public media from a peer | A segment already saved on the device still waited for a peer reply before that copy was returned. The reply is given up to 700ms, and the CDN request started only after it. | The saved copy is returned without that wait. The CDN request starts while the peer is asked. The first good answer is used. Peer bytes stay the public segment files the page already checked by hash. A peer miss or a bad answer does not hold the CDN. |

## Version publish

Sync feeds on `d1e84bbd` deployed the service worker, then `pages-mirror` failed at `node scripts/smoke_page.mjs --site _mirror` with `Chrome did not open a debugger`. The log only had dbus noise after the old fixed wait, so `publish-version` was skipped. Installed apps keep the update screen because `version.json` still names `2fd7f0d` until a later deploy publishes. Each launch now uses a fresh profile, `--no-sandbox`, `--disable-dev-shm-usage`, and `--remote-debugging-port=0`. The check reads the port from Chrome's stderr (`DevTools listening on ws://…`) or from `DevToolsActivePort`, waits up to 30 seconds, and tries the launch at most three times. A page assertion that fails is not retried.

Main's Page smoke run 41735261194 failed `shard-ui-fast` on privacy. The log line is `locator.scrollIntoViewIfNeeded: Element is not attached to the DOM` at `scripts/external_following_test.mjs:170`, then `external following checks failed`. That failure is not part of the landing paint.

The phone signup flow was run five times locally on the 390×844 size after the static landing. The autoplay choice saved every time. A later CI run reported `phone full: autoplay choice did not save` once; the same shard had passed on the previous run of this change.

## App updates

The build the service worker is already running is the version on the device. `version.json` is published only after the live check, so it can lag that build when the check has not passed. A mismatch does not offer an update. The live loop was service worker `c2b9cb09` with `version.json` still `3a6f2de`: that difference does not reload the page or open the update screen, and each service-worker build reloads at most once. The next publish writes `version.json` from the sha already stamped into `sw.js`, and fails if those shas differ. A missing or unreadable `version.json` leaves the open copy alone. Each build is offered and applied at most once on a device, and the page reloads at most once for that build. The new files download in the background. While that download is ready, a small pill stays on the page (Update ready · Tap to refresh). A swipe or a tap outside does not remove it, and Later only means not right now: it does not skip that build. The pill goes away when the build is applied. Tap applies it immediately. Otherwise it applies the next time the app is hidden or opened again, or on the next navigation. An open composer, a modal, or typed text holds that apply until it closes. Each service-worker build still reloads at most once. Right after that build is applied, What's new appears once: a bottom sheet on a phone and a centered card on a desktop, with the changelog and Got it. It does not block the page, and it does not come back for that build. A full-screen step is only for a critical update or a failed one. Unchanged files already on the device, matched by hash, are not downloaded again. `skipWaiting` and `clients.claim` run once for a worker, so the page does not reload twice.

## Merged today

- **#542** Shorts still downloads with the app, and that arrival no longer repaints an open page. Squash merge `bfa052eb`.
- **#541** Shorts loads with the app so the owner page check can see it. Squash merge `b22d61e4`.
- **#535** Faster first load: signed-out visits load the landing set only. Squash merge `5b6f084d`. Live after its deploy.
- **#536** Page smoke is split into parallel jobs of about 2.5 minutes. Squash merge `2dc8cf77`.
- **#531** Shorts re-enabled (owner-only): viewer cap, on-device stream-copy recording, native frame grab, playback fallback, TikTok follow placement. Squash merge `904144017f5260ab140efdeee40cab1357e4f72f`. Live on both sites (`version.json` matched that sha, watchdog HTTP 200).
- **#532** A new community folder keeps its typed name when the page redraws, so Create still makes the folder. Squash merge `eb6cee2deb532bbf4f31f35e042fd9fe67277d39`. Its pull-request Page smoke passed. Main's own Page smoke for that commit was still running when this note was written.
- **#537** The blue toast stays fixed and moves above an open info or achievement alert, so Undo stays tappable. Squash merge `e4f38df3`.
- **#538** A phone route change attaches the new view. Settings is not left on Home, and Sign up reaches its welcome step. Squash merge `39623360`.

## Toast and alerts

The blue toast stays fixed, so it does not push the page. When an info or achievement alert is open, the toast moves up until it sits clear of that card, on every viewport. Undo and the other toast buttons stay tappable.

## Birthday reminders

A birthday note is sent only to someone who still follows the celebrant. Each follower has their own note key, so one person's push id cannot collide with another's and drop or mis-file the write. The birth year stays out of the note's words. The reminder test checks those words. It does not search the whole JSON, because the sync cursor is a millisecond timestamp and that clock sometimes contains the digits `1990`.

## Settings while the feed loads

A reload to `#/settings` could keep the Home heading, so Log out was missing. While the feed was loading, Settings was painted as the Home skeleton, and a Home frame that had already started could still be committed after the address moved. Every route uses the same rule, including the screen Sign up opens from. A commit whose route is not the current `location.hash` is discarded. After the document has loaded, the current address is built and committed once. Before `DOMContentLoaded` that second build does not run, because it kept the phone reload from finishing. One corrective render can follow, on a later frame, and only once for that hash change. A render is not dropped on the floor, so the new view still gets attached.

## Page smoke on docs-only changes

Page smoke skips pull requests and pushes to main that only touch `**/*.md`, `docs/**`, or `.github/workflows/smoke-docs.yml`. The required check is still named `smoke`. `.github/workflows/smoke-docs.yml` is the stub: it runs only on a pull request that changes `**/*.md` or `docs/**`, its job name is `smoke`, and it prints `docs-only: page smoke not needed` and succeeds. A docs-only diff does not start the real suite. A pull request that also changes code runs the real Page smoke workflow, and that result must pass. If a shard is cancelled because a newer push superseded the run, the `smoke` job does not fail that head.

## Paused roadmap

Do not start these unless the owner asks.

- **PR 2.** 3D view, Join with my camera (including No frame), real-frames-only slow motion. No interpolation, no synthetic frames.
- **PR 3.** X-style Past recordings rebuild, shared player features, full screen, zoom preserved everywhere.

## Cold first paint

Signed out, the landing text is in `index.html` with the critical layout in a style block, so the largest text does not wait for the app. The home skeleton (the two opening posts) is in the HTML too. The app replaces that shell when it is ready. Phone, 4G, CPU slowed 4×, signed out, gate on: largest text was 9.0s (the landing paragraph, after the app loaded). It is now 3.5s, the same moment as the first paint, and the layout shift score stayed 0. The music player and the update flow are unchanged.

## Music loads when it is opened

The music page, the mini player and playback are the same. The scripts and stylesheet stay out of the first load. Opening music, or reloading while a song is queued, fetches them and then paints. A visit that never opens music does not request them.

## Main tabs stay ready

Leaving Explore, Notifications, Messages, a profile, Following, or Communities keeps that page. Coming back puts the same page in place and restores the scroll position. A background refresh can follow. Home already worked this way.

Desktop, CPU slowed 4×. Before, the return built the page again. Time until the new title was showing: Explore 69ms, Notifications 75ms, Messages 52ms, Profile 74ms, Following 235ms, Communities 330ms. The scroll position from that visit was not kept.

After, the kept page is back: Explore 44ms, Notifications 34ms, Messages 39ms, Profile 43ms, Following 64ms, Communities 108ms. Explore, Notifications, Messages, and Communities came back at the scrolled position used in the check (420px). Profile and Following settle at 96px, which they also did before this change. Communities is a long list, about 40,000px tall, and putting that scroll position back is most of the 108ms. Following is a home tab: the click reaches the address change at about 41ms and the page is back at 64ms.

## Back to Home

Leaving Home keeps the page that was on screen. Coming back puts that page back immediately, then weaves in posts that arrived while you were away. A background refresh while Home is already showing waits for the next frame, so it does not block a click. Measured with the feed-load click check (desktop, CPU slowed 4×, feeds held for 3 seconds): back to Home was 32ms, 34ms and 29ms. Before the parked page, the same last click was about 310–340ms. The Following list, community scroll, and the music player still load the way they do on main.

## Shorts on the first load

The live site was serving the new build while `version.json` still named the previous one, because the owner page check never saw the Shorts module. Shorts waited on an idle preload that starts eight seconds after the app, and the check stops about eleven seconds after the load event. That preload now starts with the app. It still stays unloaded when the server switch is off. The YouTube embed helper is the same file as before this load change.

The first version of that preload repainted the whole page when Shorts arrived. On a phone, opening a corner drawer and then narrowing the window scrolled the timeline (the navigation check saw 783px). Shorts still downloads with the app, and that arrival no longer repaints. Opening the Shorts page still paints.

## Speed

Pull request #535 keeps the load-time work only. Phone profile 390×844, 4G, CPU slowed 4×.

| | Before | After |
| --- | --- | --- |
| Cold signed-out landing | LCP 7–10s, about 1.86 MB, 111 JS files (1,558 KB of JS), TTI about 10s | LCP 8.8s on the landing paragraph, FCP 3.6s, 21 JS files (1,083 KB of JS), about 1.5 MB |
| Warm landing | about 0.5s | LCP 564ms, FCP 412ms |
| CLS | 0.17 from the alert toast | 0 |

Signed-out visits load the landing set only. Only the active language pack downloads. The service worker registers from `index.html` and fills its cache after the first screen. Landing images reserve their size, and the alert toast is fixed so it does not push the page. `app.js` stays one file. Cold LCP is still the landing paragraph, which waits on `accounts.js` and the language pack.

Music, TV, Discord, gifts, Nostr and nearby chat load with the first page, the same way they do on main. Loading those later is a separate follow-up pull request. Parked pages, in-place list updates, and restoring scroll after a rebuild are also not in this pull request. Navigation, including the phone route commit, matches main.

## Working rules

- Shipping, CI and merge rules are in [How to work on this repo](#how-to-work-on-this-repo).
- Run the full check suite locally before every push. After a split, parts that already passed only need the quick checks listed above.
- Fix app bugs in the app. Do not weaken tests.
- The handle guard is never weakened. No usernames, handles or account IDs in the public repo.
- Do not edit `.github/`. Workflow changes go in `docs/owner-patches/`.
- Owner gate: confirm the site is live and main's checks are green before opening the next PR.
- Update `docs/STATUS.md` at the end of every PR.

## Owner TODO

Enable the four TikTok workflows by hand. Steps: `docs/owner-patches/tiktok-workflows-enable.md`.

- TikTok added accounts
- TikTok live
- TikTok record
- TikTok live upload

They stay `disabled_manually`. The watchdog warning for the live workflow being off is expected until then.

## Previous snapshot (2026-10-30)

Written 2026-10-30, about 10:00 CET (09:00 UTC). Main was at `f353f771` and the latest D1 migration on that day was `0102_regone_social.sql`. Recheck every open PR below before acting on it.

## Fast tests

This branch includes main through `#536`. Page smoke is split into parallel CI jobs. Each job runs its scripts one at a time, and viewport checks inside a script run one at a time. The service-worker update check has its own job and runs with nothing else. The required check is still named `smoke`; it passes only when every shard passes.

Follow-up: the phone sign-up viewport check (`scripts/signup_flow_test.mjs`, the same Sign-up and first-run step main's Page smoke runs, with no part flag and no assertion changes) is not in these shards. On a phone it still stops at "Sign up never opened the welcome step". That is a route bug for a separate pull request. `signup-flows` stays in this one. Locally, from the repo root:

```sh
scripts/smoke-all.sh
scripts/smoke-all.sh --jobs 4
scripts/smoke-all.sh --changed
```

`--jobs` is how many scripts run at once. A run that includes a timing check uses one script at a time, and that check runs after the others. `--changed` runs the scripts that cover files changed since `origin/main`. A file that is not in that map runs the full suite. CI does not use `--changed`. Worker tests run with `node --test` concurrency 4: `cd worker && npm test`.

## Live on main (recent)

- Newsletters as posts: follow Substack, Beehiiv, Buttondown, Ghost, Medium, Mailchimp archives or any RSS site (#359).
- Usage panel in Settings never sticks on "Loading" (#456).
- Profile Games tab: ReGone link/unlink, stats and rooms live in an X-style Games tab instead of the profile header (#457).
- Delete all data on this device, local data encrypted at rest, inactivity expiry (#395).
- Tab shortcut menus (#394), full-screen X-style video viewer (#405), X mobile timeline layout (#358), low-usage playbook (#373).
- Feeds add box keeps text and focus across redraws (#455).
- NZlay Forums as an X-style community with on-device login and ReGone links (#452; switches `nzlay_forum`, `nzlay_forum_post`, `nzlay_forum_regone`). Live posting has not been verified with a real NZlay account.
- Following and Followers lists of external accounts, browsable in full (#451).
- Connected keys: your own spare Discord key kept only on the device (#447), a page per service with the stepped "Get your key" guide (#448), and sending messages you type yourself (#449). Old server-side-key Discord servers stay read-only.
- ReGone social features (#431), TV sign-in with the phone, TV app with controller play (see `docs/TV*.md`).

## Open pull requests

| PR | State | What it needs |
| --- | --- | --- |
| #459 Desktop right column: unified Who to follow + People you may know; collapsed Friends shows who is online | In progress, DIRTY | Merge main, fix the stamp, green CI, then merge. |
| #458 For you: community posts from Reddit, forums and NZlay; titles on their own line; joined row fix | In progress, DIRTY | Finish the Communities rows (below), merge main, green CI. |
| #413 Gift NFTs (off by default) | DIRTY, old base | Owner decision (wallet/minting). Ships switched off. |
| #409 Link cards with inline official video players | DIRTY, old base | Merge main, fix the failing check. |
| #406 Dependabot npm group (wrangler, miniflare; dev tools) | CLEAN, green | Owner approval (dependency change). Low risk. |
| #376 Dependabot actions group (major bumps across about 30 workflows) | CLEAN, green | Owner approval (workflow change). Medium risk: artifact upload/download formats changed. |
| #367 Nearby chat (Bitchat) web fallback | DIRTY | Merge main, fix the failing check. |
| #365 Gifts and store with a payment adapter | DIRTY | Payment keys and owner decision; ships switched off; migration `0090_store.sql` must be renumbered above the latest. |
| #357 X video always in our own player | DIRTY | Merge main, fix the failing check. |
| #355 Messages servers phase 3 (voice, video, screen share) | DIRTY, 1 failing check | Renumber migrations 0082–0084 above the latest, merge main. |
| #352 Messages servers phase 2 (threads, forums, events, polls) | DIRTY, 2 failing checks | Renumber migration 0083, merge main. Ship before #355. |
| #274 Emoji status badges and store | DIRTY, very old | Rebuild on current main (presence privacy changed); migration 0040 collides. |
| #269 Collapse the home composer | DIRTY, very old | Overlaps the shipped composer collapse; rebuild or close (owner). |
| #145 Lives and new posts on a Worker schedule | DIRTY, very old | Recommend closing: main already runs a per-minute Worker cron; it also edits workflows and `wrangler.toml`. Owner decides. |

## Needs the owner

- Approve or decline Dependabot #406 (npm) and #376 (GitHub Actions).
- Close or keep #145 (obsolete; edits workflows).
- Payments: #365 and #413 stay switched off until payment keys are added and you decide.
- Migration renumbering for #365, #352, #355, #274 before they can merge.
- Keys still needed (set as Worker or GitHub secrets from the exact steps in each doc):
  - SMSPool (`SMSPOOL_API_KEY`, Inbox › SMS codes, `docs/sms-codes.md`).
  - IMAP mail relay (Inbox mail, `docs/INBOX-MAIL.md`).
  - SimpleLogin (email aliases).
  - YouTube API key (steps still to be written for you).
- Optional: Telegram alerts (`OWNER_ALERT_CHAT_ID`), TURN for Go live, Turnstile, the short TV address (`docs/HANDOFF.md`).
- A real-TV test of controller play in ReGone (`docs/TV-CONTROLLER.md`) and real-iPhone checks.
- Optional third origin on Deno Deploy (free) next to the Worker and Render; not set up.

## In progress

1. **Sign-up fix (top priority).** The Temporary account screen fails with "Something went wrong" and its title is not translated. Branch `fix/signup-temp-account`, no PR yet. Every sign-up path must work end to end on the live site (temporary account, username and number, passkey), and every title must be in en, es, ru and hi.
2. **Usage loading.** Fixed in #456; confirm on the live owner account that the panel loads.
3. **Profile Games tab.** Shipped in #457; owner wants before/after screenshots.
4. **For you and Communities (#458).**
   - Community posts from Reddit, forums and NZlay show in For you.
   - Forum posts show the title on its own bold line above the body, X style.
   - The Communities row on Home (Inicio) shows only communities the person joined, and all of them (Reddit sources they follow, NZlay once joined). It can be organized into folders: a folder is one tile the same size as a community tile, showing a small grid of its communities' pictures; tap opens it; create, rename, reorder, move communities between folders; folders are private to each person.
   - A new row in Explore (Explorar) shows all communities. The owner can pin featured communities, which appear first; only the owner can pin, reorder or unpin.
5. **Desktop right panel (#459).** "People you may know" merges permanently with "Who to follow" into one detailed panel (picture, name, short bio, why suggested, Follow, dismiss). The Friends panel shows green online dots and a count even when collapsed. Phones unchanged.
6. **Old PR queue.** Bring every open PR above to green and merge one at a time, except the owner items.

## Where to look next

- How to take over: [How to work on this repo](#how-to-work-on-this-repo).
- Rules and how to ship: `AGENTS.md`.
- History and merge-queue details: `docs/HANDOFF.md`.
- Opening the repo in Antigravity and starter prompts: `docs/ANTIGRAVITY.md`.
