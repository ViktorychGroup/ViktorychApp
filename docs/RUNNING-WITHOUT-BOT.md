# Running the site with no assistant

This is the plain-language guide for keeping ViktorychApp alive for months with nobody (and no AI assistant) working on it. Written 2026-10-29.

The short version: **the site runs itself.** GitHub Actions refreshes the feeds and republishes the site every 30 minutes; app-code pushes also publish directly through **Publish app**. The Cloudflare Worker serves accounts and data, and once an hour its watchdog checks everything and repairs what it can. When something needs you, you get a GitHub email, a red pill at the top of the app (owner only), and optionally a Telegram message.

## 1. What runs on its own

| Piece | Where | What keeps it alive |
| --- | --- | --- |
| The app (static files) | GitHub Pages, plus a copy on Cloudflare Pages | A live deploy never expires. It stays up even if every workflow stops. |
| Feed refresh and scheduled redeploy | GitHub Actions, `sync.yml` + `publish-app.yml`, every 30 minutes | The Worker watchdog turns workflows back on if GitHub switches them off. |
| Accounts, posts, media, data | Cloudflare Worker `viktorych-accounts`, D1, R2 | Cloudflare never switches off a free Worker or its cron. |
| Backup accounts API | Render free web service | The Worker cron pings `/backup/health` every 10 minutes except 21:00–00:59 UTC (`worker/src/render-warm.js`). |
| Watchdog | Worker cron, minute 7 of every hour | `worker/src/watchdog.js` |

### What the watchdog does every hour

1. **Keeps scheduled workflows on.** GitHub turns off scheduled workflows in a public repo after 60 days without commits. The watchdog finds any workflow in the `disabled_inactivity` state and turns it back on through the GitHub API. A workflow you turned off by hand is left alone (it is only listed).
2. **Unsticks the deploy.** If the live `version.json` still shows an older commit than `main` two hours after the commit, it re-runs `publish-app.yml`. It tries again every three hours. From the third try it asks for a "force" run (see section 5).
3. **Watches every workflow that runs on its own.** Three failed runs in a row are reported. That is almost always an expired secret.
4. **Checks the front doors:** GitHub Pages, the Cloudflare Pages mirror, the Render backup (only while it is awake, so no free hours are wasted) and D1.
5. **Checks keys and tokens:** the GitHub token the Worker uses (warns 21 days before it expires), the Cloudflare analytics token, and every key in Settings > Connected keys.
6. **Checks free-tier usage:** Worker requests, D1 reads, writes and size, R2 operations and storage. It warns at 80%. At 90% of a daily limit it pauses optional cron work (the TikTok live watcher and the Discord dispatch) until the usage drops.

The source sync also heals itself: each request is retried with backoff, every feed falls back to its other mirrors and the built-in fetchers, and a host that failed three runs in a row is paused for 2, 4, 8 then 24 hours (`scripts/source_breaker.py`) instead of eating the sync's time. A feed whose sources are all down keeps its last posts. When TikTok reads fail and the pinned yt-dlp is more than three weeks old, the sync installs the newest yt-dlp for that run.

### How you hear about problems

- **GitHub email.** The "Sync feeds" workflow opens one issue titled **Site health problem** (and one titled **Sync problem** for feed trouble) as the GitHub Actions bot, so GitHub emails you. The issue is edited as things change and closes itself when they are fixed. Make sure your GitHub notification email works: github.com → Settings → Notifications → "Email" is ticked for "Issues" on watched repositories, and you are watching this repository.
- **If GitHub Actions itself stopped**, the Worker opens **Site health: GitHub Actions stopped** with its own token. GitHub does not email you about an issue your own token opened, so also set up the Telegram alert (step 3 in section 2) if you want a push message.
- **In the app**, signed in as the owner: a red pill at the top ("Site health: N problems need you"). Tap it, or open Settings > Connected keys, to see the list. "Check now" runs the watchdog straight away.
- **Anyone** can read the short public summary at `https://viktorych-accounts.viktorych-accounts.workers.dev/v1/watchdog`. It holds problem descriptions only, never a secret.

## 2. Do these once before you stop paying

1. **Give the Worker's GitHub token Issues access and a long life.**
   1. Open github.com → your avatar → Settings → Developer settings → Personal access tokens → Fine-grained tokens.
   2. Open the token you saved as the repository secret `WORKER_DISPATCH_TOKEN` (the one with access to ViktorychGroup/ViktorychApp and Actions: Read and write).
   3. Look at its expiry date. If it ends within the time you plan to be away, click **Regenerate token**, pick the longest expiry offered ("No expiration" if your organization allows it, otherwise the maximum), and copy the new value.
   4. Under Repository permissions make sure these are set: **Actions: Read and write**, **Contents: Read-only**, **Issues: Read and write**, **Metadata: Read-only**. Click **Update**.
   5. If you regenerated it: open the repository → Settings → Secrets and variables → Actions → `WORKER_DISPATCH_TOKEN` → Update secret → paste → Update. Within 30 minutes `worker-dispatch-secret.yml` copies it into the Worker as `GITHUB_DISPATCH_TOKEN`. To copy it at once instead: Actions tab → "Worker dispatch secret" → Run workflow.
   6. Put a calendar reminder two weeks before the expiry date. The watchdog also warns 21 days before.
2. **Optional: let a forced run publish past a flaky live check.** The bot token cannot edit workflow files, so this one-line change is yours. In the repository on github.com, open `.github/workflows/publish-app.yml` → pencil icon → find the step `- name: Fail if the live page is black or a script is missing` (in the `verify-live` job) and add this line directly under it, indented like `env:`:
   ```yaml
           continue-on-error: ${{ github.event.inputs.source == 'watchdog-force' }}
   ```
   Commit to `main`. The exact diff is in `docs/owner-patches/sync-verify-live.patch`. Without it, a stuck `version.json` is still re-tried and reported; it just cannot force itself through.
3. **Optional: Telegram alerts.** The Worker already has the Telegram bot token.
   1. In Telegram, open your bot and send it any message.
   2. In a browser, open `https://api.telegram.org/bot<YOUR BOT TOKEN>/getUpdates` (use the token from where you keep it; do not paste it anywhere public). Find `"chat":{"id":` followed by a number. That number is your chat id.
   3. In `worker/`: `npx wrangler secret put OWNER_ALERT_CHAT_ID --name viktorych-accounts` and paste the number. Or Cloudflare dashboard → Workers & Pages → viktorych-accounts → Settings → Variables and Secrets → Add → type Secret, name `OWNER_ALERT_CHAT_ID`.
   The Worker sends at most one message per day for the same serious problem.
4. **Check the Cloudflare API token never expires.** dash.cloudflare.com → My Profile → API Tokens. The token used for `CLOUDFLARE_API_TOKEN` (GitHub secret, and the same name on Render) should say no expiry. If it has a date, note it in your calendar.
5. **Close or leave open PRs.** Nothing merges without someone. Open PRs do no harm.

## 3. Renewing each secret

Never paste a secret into an issue, a commit, or chat. GitHub secrets: repository → Settings → Secrets and variables → Actions. Worker secrets: in `worker/`, `npx wrangler secret put NAME --name viktorych-accounts`, or the Cloudflare dashboard (Workers & Pages → viktorych-accounts → Settings → Variables and Secrets).

| Secret | Lives in | Lasts | Symptom when it dies | How to renew |
| --- | --- | --- | --- | --- |
| `WORKER_DISPATCH_TOKEN` → `GITHUB_DISPATCH_TOKEN` | GitHub secret, copied to the Worker | Until its expiry date | Watchdog: "GitHub rejected GITHUB_DISPATCH_TOKEN"; workflows no longer re-enabled; TikTok and Discord dispatches stop | Section 2, step 1 |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub secrets **and** Render env vars | No expiry unless you set one | `accounts.yml` and the Pages mirror fail; the Render backup reports data down | Cloudflare → My Profile → API Tokens → Roll. Paste it in the GitHub secret, then Render dashboard → viktorych-backup → Environment → `CLOUDFLARE_API_TOKEN` → Save (Render redeploys) |
| `CF_ANALYTICS_TOKEN`, `CF_ACCOUNT_ID` | Worker secrets | Until rolled | Watchdog: "CF_ANALYTICS_TOKEN no longer works"; usage alerts go blind | Cloudflare → API Tokens → Create Token → Custom → Account Analytics: Read → create, then `npx wrangler secret put CF_ANALYTICS_TOKEN` |
| `DISCORD_USER_TOKEN` | GitHub secret | Until you sign out of that Discord account, change its password, or Discord resets it | `discord-live.yml` fails three times → watchdog warning; the Discord mirror stops updating | Sign in to the spare account in a browser, copy the token the same way you did before, update the secret. Never sign that account out everywhere |
| VK keys (`VK_*` secrets, VK in Connected keys) | GitHub secrets / Connected keys | Sessions expire after weeks to months | "VK needs a new key" in the app; VK feed empty for 6 h → Sync problem issue | `docs/vk-session.md`, `docs/vk-stories-token.md` |
| Cookies: `IG_SESSION`, `INSTAGRAM_COOKIE`, `THREADS_COOKIE`, `TWITTER_AUTH_TOKEN` | GitHub secrets | Weeks to months | That platform's feeds go empty → Sync problem issue | Sign in in your own browser, copy the cookie the same way as before (`docs/instagram-threads.md`), update the secret |
| `TG_STORIES_SESSION`, `TG_API_ID`, `TG_API_HASH` | GitHub secrets | Until the Telegram session is ended in Telegram → Settings → Devices | Telegram stories stop → Sync problem issue | `docs/telegram-stories.md` |
| `TELEGRAM_BOT_TOKEN(S)`, `TELEGRAM_CHANNEL_ID` | GitHub + Worker secrets | Forever, unless revoked in BotFather | Telegram backup fails three times → watchdog warning | BotFather → /token, update both places |
| `GDRIVE_RCLONE_TOKEN` | GitHub secret | Google refresh tokens can expire (after 6 months unused, or after 7 days for an unpublished OAuth app) | `gdrive-backup.yml` fails three times → watchdog warning | `docs/gdrive-backup.md` |
| `REDDIT_CLIENT_ID`/`SECRET`, `IA_ACCESS_KEY`/`SECRET_KEY` | GitHub secrets | No expiry | That workflow fails | Re-create in the service's settings |

## 4. "No successful Sync feeds run for over six hours"

GitHub Actions is not running the sync. Check in this order:

1. Repository → Actions tab. If a yellow banner says workflows are disabled, click **Enable**. Open "Sync feeds"; if it says "This scheduled workflow is disabled", click **Enable workflow**.
2. Repository → Settings → Actions → General: "Allow all actions" must be selected.
3. github.com/settings/billing: public repositories get free standard runners. If GitHub flagged the account, the Actions tab shows a notice; follow it.
4. Run "Sync feeds" by hand (Actions → Sync feeds → Run workflow). If it fails, open the red job and read the last lines.

The site itself stays up the whole time. Only new posts stop arriving.

## 5. "The live site has been behind main"

`version.json` tells installed apps to update. It is published only after the live check (`verify-live`) passes. That check can flake. The watchdog re-runs the deploy every three hours. If it keeps failing:

1. Actions → Publish app → the latest run → `verify-live` → read the problem lines.
2. If the problem is a flake (it says "exception" once and passes elsewhere), apply the change in section 2, step 2. The next forced run publishes.
3. If the live page is really broken, roll back: open the merged pull request that caused it → click **Revert** (bottom of the PR page) → merge the new revert PR. The next app publish deploys the old code.

GitHub Pages keeps serving the last deployment indefinitely, so the site never goes dark because a deploy failed.

## 6. Render backup

Render's free plan sleeps after 15 minutes idle and allows 750 instance hours a month. The Worker ping keeps it awake about 620 hours a month. The watchdog checks it only in those warm hours, so the checks cost no extra instance hours. The app's account calls now time out (reads 15–20 s, writes 30 s, uploads 2 min) and move to the other server, so a stalled server never hangs the app. Sign-in uses the Worker first, so Render being down only matters when the Worker is over its daily limit.

- Down: dashboard.render.com → viktorych-backup → Logs. "Suspended" means the month's hours ran out (it comes back on the 1st) or Render changed its free plan.
- Manual redeploy: Manual Deploy → Deploy latest commit.

## 7. Free-tier limits

| Limit | Free amount | What happens at the limit |
| --- | --- | --- |
| Worker requests | 100,000 a day | Requests fail until 00:00 UTC; the app falls back to Render for sign-in |
| D1 | 5 M rows read, 100 k rows written a day; 500 MB per database | Queries fail until 00:00 UTC |
| R2 | 10 GB stored; 1 M writes, 10 M reads a month | Above 10 GB Cloudflare bills the card on file |
| Render | 750 hours a month | Service suspended until the 1st |
| GitHub Actions | Free for public repos; 20 jobs at a time | Queues; never billed for a public repo |

On 2026-10-29 R2 held well under 1 GB, so storage is years away from the limit at the current rate. The owner usage panel (Settings) shows today's numbers.

## 8. Things that will need a person eventually

- **Third-party sites change.** X, TikTok, Instagram, VK, Reddit and Discord change their pages and APIs. The fallbacks, the breaker and the yt-dlp self-update buy time, but a feed can go quiet for good until someone updates an adapter. You will see a Sync problem issue.
- **Unpinned helper images.** The sync runs the latest `diygod/rsshub` and `rssbridge/rss-bridge` images. A bad release can break some feeds for a while; the breaker keeps the rest of the sync healthy.
- **GitHub action versions.** Workflows use `actions/*@v4` (and `upload-pages-artifact@v3`). GitHub keeps old major versions working for a long time and announces removals by email months ahead. If one is retired, bump the version in the workflow file.
- **Tokens with an expiry date** (section 3).

## 9. Monthly five-minute check (optional)

1. Open the app as the owner. No red pill = fine.
2. Open the repository's Issues tab. No open "Site health problem" or "Sync problem" = fine.
3. Open `/v1/watchdog` (link in section 1). `"ok": true` = fine.
