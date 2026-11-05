# AGENTS.md: ViktorychApp guide for AI coding agents

This is the single source of truth for any AI agent working in this repository (Google Antigravity, Gemini, Codex, Cursor, Claude Code or anything else). Read it fully before you change anything. Then read `docs/HANDOFF.md` (history and merge queue), `docs/STATUS.md` (what is live and open right now) and `docs/LOW-USAGE.md` (how to keep usage low). If this file and another doc disagree, the stricter rule wins; tell the owner about the conflict.

The repository is public and will be opened to contributors. Write every commit, PR text, log line and doc as if a stranger reads it.

## 1. What the project is

ViktorychApp is an X.com clone shipped as a PWA. It mixes its own accounts and posts with posts streamed from other networks (X, Reddit, TikTok, Telegram, VK, Discord, forums such as NZlay, Nostr and more), normalized into one post shape.

| Piece | Where | Notes |
| --- | --- | --- |
| Front end (static PWA) | repo root (`index.html`, `app.js`, `*.js`, `*.css`, `i18n/`, `shared/`, `vendor/`) | Served by GitHub Pages (`https://viktorychgroup.github.io/ViktorychApp/`) and mirrored to Cloudflare Pages (`viktorychapp.pages.dev`). No build step for code; `scripts/assemble_site.py` assembles `_site`. |
| Service worker | `sw.js` | Line 7 is the cache stamp: `// cache-bust: <ISO time>-<label>`. See section 5. |
| Live version marker | `version.json` (written by `scripts/write_version.py` in `publish-app.yml`) | Published only after the `verify-live` job passes. Installed apps use it to update. |
| Accounts / API Worker | `worker/` (`viktorych-accounts`, `worker/src/index.js`, `worker/wrangler.toml`) | Cloudflare Worker with D1 (SQL, migrations in `worker/migrations/NNNN_name.sql`, numbers unique, latest is in `docs/STATUS.md`) and R2 (media/objects). Cron every minute plus an hourly watchdog (`worker/src/watchdog.js`). |
| Feature switches | `worker/src/feature-flags.js` (server) and `SERVER_FEATURES` in `app.js` (client labels) | Owner-only kill switches stored in D1. Off = endpoints answer empty fast, cron skips, clients do not load it. |
| Backup API | `backup-server/` (Render free web service, `render.yaml`) | Runs the same Worker code. Part of the client origin pool (see `accounts.js`, `scripts/origin_pool_test.mjs`): reads move off the main Worker near its free quota; writes stay on it. Kept warm by the Worker cron (`worker/src/render-warm.js`), with quiet hours. |
| Gate / config | `accounts.config.js` | Closed in the repo; the sync workflow rewrites the copy in the Pages artifact. |
| Data | Deployed as a Pages artifact by `sync.yml` every 30 minutes, never committed | Repo history must not grow with data. `data/` holds only small static catalogs. |
| Own backup fetchers | `.github/workflows/*.yml` + `scripts/*.py` (reddit, media extract, discord, telegram, TikTok, IA, gdrive backups) | So nothing depends only on third-party instances. TikTok fetch workflows stay enabled. |
| Android TV app (ViktorychTV) | `android-tv/` (Gradle), built APK in `tv/ViktorychTV.apk`, `tv/version.json` | Signing key and `keystore.properties`/`signing.properties` are git-ignored and must never be committed. Docs: `docs/TV*.md`, `docs/SEND-TO-TV.md`. |
| Tests | `scripts/*_test.*`, `scripts/selftest.py`, `worker/test/` | See section 3. |

Owner-facing ops guide (secrets, watchdog, free limits): `docs/RUNNING-WITHOUT-BOT.md`. Security model: `SECURITY.md`, `docs/security.md`. Contributor rules: `CONTRIBUTING.md`.

## 2. Run it locally

- Static app: `python3 scripts/assemble_site.py --site _site` then serve `_site` (for example `python3 -m http.server -d _site 8080`) and open `http://localhost:8080/`. Use `localhost`, not `127.0.0.1`, when testing passkeys.
- Worker: `cd worker && npm ci && npx wrangler dev` (local D1/R2 via Miniflare; no production secrets needed for tests).
- Backup server: `cd backup-server && npm ci && node test.mjs`.
- Browser tests need Playwright: `npm install --prefix /tmp/pw playwright` then `PLAYWRIGHT_CORE=/tmp/pw/node_modules/playwright-core/index.js node scripts/<test>.mjs`.

## 3. Test before you push

Quick checks (the same ones CI runs first; run them on every change):

```sh
python3 scripts/check_i18n.py
python3 scripts/assemble_site.py --selftest
python3 scripts/handle_guard.py --selftest
python3 scripts/secret_scan.py --staged      # also installed as a pre-commit hook: sh scripts/install_git_hooks.sh
python3 scripts/migration_numbers.py         # when you add a D1 migration
```

Then the tests for what you touched: `python3 scripts/selftest.py` for scripts, `cd worker && npm test` for the Worker, and the matching `scripts/*_test.mjs` / `*_test.js` for UI work (the full list is in `.github/workflows/smoke.yml`). A typical green PR shows about 10 successful and 6 skipped checks.

## 4. Ship: one PR at a time

1. Branch from fresh `origin/main` (`git fetch origin main && git switch -c <topic> origin/main`). Use a separate `git worktree` per task when several tasks run at once.
2. Small, focused commits. One feature or fix per PR. PR text says what changed for a user and how it was tested. No handles, IDs or secrets.
3. Push early, open the PR with `gh pr create`. Never post PR comments; put updates in the PR description or new commits.
4. Wait for CI. If a check fails, read the log (`gh run view <id> --log-failed`), fix the cause, push. A known flake may be re-run once with `gh run rerun <id> --failed`. Never leave a red PR or a failed Action abandoned.
5. Merge only when the PR is `CLEAN` and every check is success or skipped: `gh pr merge <n> --squash --match-head-commit <head sha>`. Exactly one merge in flight; if another agent or person is mid-merge, wait.
6. Verify live after the merge (skill `/verify-live`): the Accounts and Publish app runs for the new main commit succeed, `https://viktorychgroup.github.io/ViktorychApp/version.json` shows main's commit, and `https://viktorych-accounts.viktorych-accounts.workers.dev/v1/watchdog` returns HTTP 200. Only then merge the next PR.
7. If main's own smoke check is red, fix main first with a tiny PR at the top of the queue.
8. Merge order: small fixes, then features, then large or risky work. Dependabot PRs, anything touching `.github/workflows/` or dependencies, payments, data deletion and migrations that collide go to the owner.

Detailed merge-queue rules (DIRTY PRs, leases, deploy window): `docs/HANDOFF.md`, section "Merge queue: one coordinator".

## 5. The `sw.js` stamp rule

- Bump the stamp only when your PR changes files the service worker caches. Keep one line `// cache-bust: <UTC ISO time>-<label>` at line 7.
- The new stamp must sort above main's current stamp (use the current UTC time, later than main's).
- On a conflict in `sw.js`: take main's copy of the file, re-apply only your PR's own lines, and set the stamp above main's. Never keep two stamp lines. Also keep the copies of the stamp in `update.js` and the tests in step if they changed.
- `i18n/*.js` and `scripts/i18n_allow.txt` conflicts: keep both sides (main's entries first, then yours) and fix the comma between them.

## 6. i18n

Every new user-facing string goes into all four locales: `en`, `es`, `ru`, `hi` (`i18n/`). Use `tr("...")` in UI code. Real translations, not English copies. `python3 scripts/check_i18n.py` must pass.

## 7. Design rules: match X.com 1:1

- Timeline, post cards, profiles, compose, notifications, messages and settings look and behave like X.com. When unsure, copy what X does.
- Settings: each subpage has X's back-arrow header and divided rows. Use native X-style sliders/toggles.
- Phones get X's mobile web layout; desktop gets X's three-column shell (left nav, main column, sticky right rail with no blank space). Black theme by default.
- Tabs and pills are thin and never grow. Long text scrolls slowly (marquee). Names have no length limits.
- Onboarding is minimal: one title, at most one line of text, one button per screen, no pyramid text; a stepped setup like iPhone or Windows 11 first-run.
- iOS must work, including older iPhones and older Safari.

## 8. Speed is the top priority

- Local-first: show the cached copy instantly, refresh in the background. No spinners when a cache exists. The UI never locks up while loading; every network call has a timeout and a calm error with Retry.
- Do work on the device where possible (filtering, merging, ranking); keep the server light.

## 9. Storage and services

- Stream as much as possible; store minimal data. Hotlink media; never re-encode; keep original quality.
- Deploy data as a Pages artifact; the repo history never grows with data.
- Everything stays free. Add free services on top as backups; never replace what works. No new hosts, services or Cloudflare accounts without the owner's OK.
- Own backup fetchers run in Actions so nothing depends only on third-party instances.

## 10. Every new feature has its own switch

Add the feature to `worker/src/feature-flags.js` (with `defaultOff: true` when it needs keys or an owner decision) and its name to `SERVER_FEATURES` in `app.js` plus a label pair in the labels map beside it. Clients must check the server-off list before loading the feature. Paid or key-dependent features ship switched off. Skill: `/add-feature-with-switch`.

## 11. Hard rules (never break these)

Security and privacy
- Secrets live only in GitHub Actions secrets and Cloudflare Worker secrets. The owner adds them from exact steps you write. Never ask for a secret in chat, never print, log or echo one, never commit `.env` files, keystores or signing keys (`android-tv` keys stay git-ignored). Secret names are fine.
- Never put usernames, handles, display names, account IDs, emails, phone numbers or profile links of real people anywhere in the repo: code, data, tests, commits, PR text, issues, logs, artifacts or screenshots. Fixtures use made-up names and `example.com`/`*.test`. `scripts/handle_guard.py` and `scripts/secret_scan.py` enforce part of this; your judgment covers the rest. User data stays in private storage or secrets.

Git
- Never edit `.github/` (workflows especially) without the owner's explicit approval; hand the owner a ready patch instead (see `docs/owner-patches/`).
- Never use `git stash` (it is shared across worktrees). Use a WIP commit on your branch.
- No force-push or history rewrite without asking. `--force-with-lease` only on your own branch. Never force-push `main`.
- Never merge an old `main` back into a branch; merge the current `origin/main`.
- No PR comments.

Discord
- Keys are the user's own spare-account keys, kept only on their device, encrypted. No shared key pool.
- Joins happen only when the user taps. Captchas are shown to the user and never solved automatically.
- Sending is only for a message a person typed and sent themselves. Never automated, scheduled or bulk.

ReGone / NZlay
- Do not touch the ReGone websocket. No anti-AFK, no input automation, nothing that keeps an account logged in in the background.
- NZlay login is relayed by the Worker with no storage and no logging; the session cookie stays encrypted on the user's device.

Other
- TikTok Actions workflows stay enabled. Do not disable them. A viewer cap can pause one live; it does not turn the workflows off.
- Messages, emails or posts to other people are only drafted for the owner to send. Never send on the owner's behalf.
- Never delete accounts or user data without an explicit owner go-ahead and a full backup.
- Spend little: no polling loops, read only the files you need, no extra cloud agents unless the owner asks (`docs/LOW-USAGE.md`).

## 12. Owner product preferences (how to decide when unsure)

- X.com fidelity first, speed second only to correctness, simplicity in onboarding.
- Features are never abandoned: a failed Action or a red PR is investigated, fixed and re-run.
- Prefer one neat X-style place for a feature over scattering it (for example ReGone lives in a profile Games tab; joined communities sit in one row on Home).
- Keep the owner informed in short plain language. Send before/after screenshots when UI changes go live (no personal data in them).

## 13. Where things live

| Topic | File |
| --- | --- |
| History, merge queue, gotchas | `docs/HANDOFF.md` |
| Current snapshot and open PRs | `docs/STATUS.md` |
| Opening the repo in Antigravity | `docs/ANTIGRAVITY.md` |
| Running unattended, secrets table, free limits | `docs/RUNNING-WITHOUT-BOT.md` |
| Low usage | `docs/LOW-USAGE.md` |
| Post schema | `docs/POST-SCHEMA.md`, `docs/post.schema.json` |
| TV app | `docs/TV.md`, `docs/TV-SIGN-IN.md`, `docs/TV-CONTROLLER.md`, `docs/SEND-TO-TV.md` |
| NZlay forum | `docs/NZLAY-FORUM.md` |
| Inbox SMS / mail relay | `docs/sms-codes.md`, `docs/INBOX-MAIL.md` |
| Backups | `docs/d1-backup.md`, `docs/free-cloud-backup.md`, `docs/gdrive-backup.md`, `docs/telegram-backup.md` |
| Agent rules (Antigravity) | `.agents/rules/*.md` |
| Agent skills / slash commands | `.agents/skills/*/SKILL.md` |
