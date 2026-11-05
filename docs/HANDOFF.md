# ViktorychApp handoff

A takeover guide for the next assistant or coding agent. Written from the state of the project on 2026-10-28. Anything marked "unverified" was not re-checked, so check it before you rely on it.

> **Keep usage low:** read [LOW-USAGE.md](LOW-USAGE.md) before doing any work.

> **AI agents start here:** [`AGENTS.md`](../AGENTS.md) is the single source of truth for rules, architecture and shipping. Current snapshot: [STATUS.md](STATUS.md). Opening the repo in Google Antigravity, with starter prompts: [ANTIGRAVITY.md](ANTIGRAVITY.md). Antigravity rules are in `.agents/rules/` and slash-command skills in `.agents/skills/`.

## 0. Running with nobody

If no assistant is working on the project, read `docs/RUNNING-WITHOUT-BOT.md`. The Worker watchdog (`worker/src/watchdog.js`) keeps workflows on, re-runs a stuck deploy and reports health.

## 1. What the project is

ViktorychApp is an X.com-clone PWA. The front end is static and served from GitHub Pages. The back end is a Cloudflare Worker with D1 (SQL) and R2 (object storage). Coding agents open PRs, and the owner's assistant reviews and merges them.

## 2. Standing rules from the owner

- Spend as little agent and assistant usage as possible. No cloud agent runs unless the owner asks. Do not poll.
- The UI must match X.com closely, including on mobile.
- Free services only.
- Never put handles, usernames or account IDs in the public repo. Never print secrets. Secret names are fine.
- Media keeps its original quality and is never re-encoded.
- Ask the owner before any history rewrite or force-push.
- Every new UI string goes in every locale.
- Bump the service worker cache stamp in `sw.js` (and the copies in `update.js` and the tests) above main's current stamp.
- D1 migration numbers must be unique.
- Tabs and pills are thin. Long text scrolls slowly (marquee). Names have no length limits. Pills never grow.
- iOS must work flawlessly, including iPhone 11 and older Safari.

## 3. Merge procedure

1. Squash-merge only when the PR is `clean` and every check is `success` or `skipped` (handle guard, migration numbers, smoke, nav, selftests; a typical green run is 10 success and 6 skipped).
2. Merge with the exact head sha (`gh pr merge --squash --match-head-commit <sha>`).
3. One PR at a time. Each merge moves main's stamp, so merge main into the next branch with a normal merge commit, bump the stamp, and wait for green.
4. A token without the `workflow` scope cannot push a commit that creates a new version of a file under `.github/workflows/`. It also cannot re-run Actions. Push an empty commit to re-trigger checks.

## 4. State on 2026-10-28

Merged today: #265 (online in the menu), #267 (requests tab), #268 (affiliation badges), #271 (community posts on Home), #272 (Explore on mobile), #273 (public landing page), #266 (merit badges in About me), #275 (this handoff), #276 (community posts and replies on Home as normal post cards).

Still open:
- #269 (composer collapse on scroll): overlaps #264, which already shipped a different composer collapse. It still adds a collapse-on-scroll setting and a "draft stays on this device" note. The owner decides whether to rebuild it on top of #264 or close it.
- #274 (status emoji store): conflicts with the presence privacy rework now on main (seen lists, reciprocal last seen, a different privacy list). It needs a careful rebuild on main.
- #145 (Worker cron backup) is excluded from automated work.

Queued work, in order:
1. (In progress after #276.) The owner's own new post must show at the top of Home (For you and Following) and on their profile, survive a refresh, and the "Your post was sent" toast gets a View link. Cover replies and quotes too.
2. Desktop right rail: `position: sticky`, with `top = viewport height − rail height` when the rail is taller than the viewport, otherwise `top: 0`. No blank space below it.
3. Several usernames per account. Each is unique and reserved. One is primary. All are listed in About me and all resolve to the same profile. A cap, a change rate limit and release rules apply.
4. Replace the floating "new posts" pill with an inline "Show N posts" row with avatars at the top of Home. Clicking it inserts the posts in place and does not scroll.

## 5. Owner setup still needed

- Telegram stories secrets: `TG_API_ID`, `TG_API_HASH`, `TG_STORIES_SESSION` (see `docs/telegram-stories.md`).
- Optional TURN secrets for Go live: `LIVE_TURN_URLS`, `LIVE_TURN_USERNAME`, `LIVE_TURN_CREDENTIAL` (see `docs/live-p2p.md`).
- Real-iPhone testing (see `docs/ios-support.md`).
- Instagram/Threads optional secret names are in `docs/instagram-threads.md` (`IG_SESSION` is for stories only).
- Optional: Turnstile, VAPID keys, uptime monitoring.
- The owner tests the password-manager prompt and Notifications on a phone.
- Cleanup and account deletion only with an explicit owner go-ahead and a full backup.

## Merge queue: one coordinator

Why things stall: about twenty workers push PRs at once. Every PR bumps the `// cache-bust:` stamp line in `sw.js` and appends strings to the end of the `i18n/*.js` packs, so each merge makes most other open PRs conflict (DIRTY). Every rebase starts a new CI run, the Actions concurrency limit lets only a few run at a time, and the queue grows faster than it drains. Main does not require branches to be up to date, so only real conflicts block a merge.

Rules:
1. One coordinator merges. Workers push commits to their own PR branch and stop; they never run `ship.sh`, auto-ship loops or `gh pr merge` themselves. The coordinator stops leftover per-PR loops by their exact PID and takes those PRs into its queue.
2. Cancel only superseded queued runs: a queued run whose branch has a newer commit and whose workflow already has a newer run on that branch. Never cancel the newest run of a branch or workflow. A cancelled run on an old commit is normal, not a failure.
3. Merge order: small fixes first, then features, then large or risky work. Leave Dependabot PRs and anything touching `.github/workflows/` or dependencies for the owner. A PR whose checks take a long time goes in a quiet window when nothing else will merge.
4. Merge one PR at a time with `/workspace/ship.sh <pr>` (squash, `--match-head-commit`). Only PRs that are green and not DIRTY merge.
5. Rebasing a DIRTY PR: work in a separate worktree. Fetch the branch first and note its head sha, rebase onto `origin/main`, and keep both sides' intent.
   - `sw.js`: start from main's file and re-apply only that PR's own lines. For the stamp line, keep one `// cache-bust:` line with a fresh time and the PR's label.
   - `i18n/*.js` and `scripts/i18n_allow.txt`: keep both sides (main's entries first, then the PR's) and fix the comma between them.
   - Every new English string needs `ru`, `es` and `hi` entries; run `python3 scripts/check_i18n.py`.
   - Run the quick checks from the smoke workflow (`check_i18n.py`, `assemble_site.py --selftest`, `handle_guard.py --selftest`) before you push.
6. Never drop anyone's commits. Push with `git push --force-with-lease=refs/heads/<branch>:<sha you started from>` to that PR branch only. If the push is rejected, a worker pushed: fetch, rebase again on top of their commits, and retry. Do not refresh the lease by fetching just before the push, since that silently drops the worker's new commits.
7. Deploy window: after each merge (or a batch of at most 2 or 3), stop merging until the Accounts and Publish app runs for the newest main commit have finished successfully. Then check that the live `version.json` shows main's commit and that the Worker's `/v1/watchdog` answers. A merge while a deploy is still queued starves it: runners pick jobs oldest first, and PR checks fill them. Queued Accounts or Publish app runs for older main commits may be cancelled (use force-cancel if a plain cancel leaves a queued job stuck), never the newest one.
8. If main's own smoke check fails, every PR fails it too. Fix main first in a tiny PR at the top of the queue.
9. Never edit `.github/workflows/`, never force-push main, never merge old main back into a branch, never use `git stash`. No account handles or IDs in commits, PR text or logs.

## TV sign-in

Short address for people: `viktorychapp.pages.dev` (`SHORT_ORIGIN` in `shared/short-link.js`; `/tv`, `/p/CODE`, `/join`, `/go` via `_redirects`, and `404.html` on GitHub Pages).
A signed-out TV opens "Sign in with your phone" by itself: a QR code for `/p/CODE` plus a 6-character code, ten minutes, one use, renewed by itself, through `/v1/tv-pair/*`.
A signed-in phone confirms with one tap; a signed-out phone signs in or up and the TV finishes right after.
The TV can also ask an account by username: the Worker sends an "Approve sign-in on TV?" notification (Approve / Deny) to that account's devices; the TV never learns whether the name exists; limited per TV, per name and per IP (`tv_pair_asks`, migration 0085). On a computer, the code box takes paste and sends itself at 6 characters. See [TV-SIGN-IN.md](TV-SIGN-IN.md).

## TV controller play

The TV app 1.2.0 (versionCode 3) plays ReGone with a controller in its own WebView screen (`GameActivity`, `viktorychtv://game/regone`); controller input becomes real key presses and touches. Design, layout, limits and the device test checklist: [TV-CONTROLLER.md](TV-CONTROLLER.md). Still needs a real-TV test: whether ReGone reads keys while its touch controls are on (fallback: Menu > Move with > On-screen joystick). After the PR merges, upload `tv/ViktorychTV.apk` to the latest GitHub release as `ViktorychTV.apk`.

## NZlay Forums community

The NZlay forum (`nzlay.com`, SocialEngine) is in the Communities tab as an X-style Community: live reads through the Worker, and post/reply after the user signs in on their own device (session stored encrypted on-device only, like the Discord local keys; a no-storage/no-logging Worker relay carries the cookie). ReGone links (online + Play header, author rank/stats badges, room-join chips, Games link-back) each sit behind their own switch. Flags `nzlay_forum`, `nzlay_forum_post`, `nzlay_forum_regone` (all default on). Live posting is **not yet verified against a real NZlay account** (signing up / posting was not authorized). Details: [NZLAY-FORUM.md](NZLAY-FORUM.md).

## 6. Gotchas

- `scripts/handle_guard.py` rejects any token from the private owner catalog, including product and assistant names used as handles. Keep docs neutral.
- The Home button once vanished on mobile because a saved layout hid it. Home is now locked, and a saved bar keeps items added later hidden until the user turns them on.
- Some Playwright checks ride along inside other test scripts (for example `home_reach_test.mjs` runs `explore_nav_test.mjs`, and `compose_page_test.mjs` runs `community_home_test.mjs`), because the workflow files could not be edited.
- An overnight routine named "Overnight ship check" merges green, clean PRs, oldest first. Check what it has merged before you act.

## Post schema

Every source is normalized to one canonical post shape before it ships. See [POST-SCHEMA.md](POST-SCHEMA.md) and `docs/post.schema.json`; tests: `python3 scripts/normalize_test.py` (also run by `handle_guard.py --selftest` in CI).

## Short TV address (owner step, free)

To give TVs a short address, create the org Pages site once. It is free and stays on GitHub Pages:

1. On GitHub, create a new public repository in the ViktorychGroup organization named exactly `viktorychgroup.github.io`.
2. Add one file `index.html` with:
   ```html
   <!doctype html><meta charset="utf-8"><title>Viktorych</title>
   <meta name="description" content="Viktorych: open the app.">
   <link rel="canonical" href="https://viktorychgroup.github.io/ViktorychApp/">
   <meta http-equiv="refresh" content="0; url=/ViktorychApp/">
   <script>location.replace("/ViktorychApp/" + location.search + location.hash);</script>
   <a href="/ViktorychApp/">Open Viktorych</a>
   ```
3. Settings > Pages: Source "Deploy from a branch", branch `main`, folder `/ (root)`. Save.
4. After a minute, `https://viktorychgroup.github.io/` opens the app. TV mode still turns on by itself on TV browsers.
5. Then ask the assistant to switch `DEFAULT_HOST` in `send-tv.js` to `viktorychgroup.github.io` so Send to my TV shows the new address.

Send to my TV (`#/send-to-tv`) and what really works per TV brand: [SEND-TO-TV.md](SEND-TO-TV.md).
