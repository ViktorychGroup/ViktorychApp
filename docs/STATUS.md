# Status snapshot

Written 2026-11-03 (UTC). Main was `2dc8cf77` when this note was updated. Latest D1 migration is `0131_shorts_on.sql`. This is a snapshot: check `gh pr list` and `git log origin/main` before acting on it. Update this file at the end of every PR.

## Merged today

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

Page smoke skips pull requests and pushes to main that only touch `**/*.md` and `docs/**`. `smoke` is a required check. A skipped run counts as passing.

## Paused roadmap

Do not start these unless the owner asks.

- **PR 2.** 3D view, Join with my camera (including No frame), real-frames-only slow motion. No interpolation, no synthetic frames.
- **PR 3.** X-style Past recordings rebuild, shared player features, full screen, zoom preserved everywhere.

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

- Run the full check suite locally before every push.
- Stop after 2 failed CI rounds on a PR and report the check, the error and the diagnosis. Do not retry blindly.
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

- Rules and how to ship: `AGENTS.md`.
- History and merge-queue details: `docs/HANDOFF.md`.
- Opening the repo in Antigravity and starter prompts: `docs/ANTIGRAVITY.md`.
