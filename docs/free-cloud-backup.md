# Free Cloud Scaling & Speed Multiplier for Viktorych Telegram Backup

This guide explains how to scale the ViktorychApp media and comments backup to maximum speed **100% for free ($0)** by combining:
1. **Free Telegram Bot Pooling**: Multiply upload throughput by 3x–5x by pooling free bots created with `@BotFather`.
2. **Deterministic Parallel Sharding**: Partition media workloads across multiple concurrent runners with `--shard K/N`.
3. **Turnkey 24/7 Free Cloud Workers**: Deploy background workers with 16 GB RAM on **Hugging Face Spaces** or **Oracle Cloud Always Free** at zero cost, without burning GitHub Actions minutes.

---

## 1. Telegram Multi-Bot Pooling (3x–5x Speedup for $0)

### Why this is needed
Telegram limits any single bot in a channel to about 20 messages per minute (roughly 1 message every 3 seconds, enforced by `MIN_INTERVAL = 3.0s`). If you upload with a single bot, 100 media files take at least 300 seconds (5 minutes).

### The Solution: Multi-Bot Round-Robin
Telegram allows you to create up to **20 bots per account for free**. ViktorychApp's backup engine supports `TELEGRAM_BOT_TOKENS`. The engine monitors per-bot cooldown timestamps independently:
- **1 bot**: 1 file every 3.0s (~20 files/min)
- **3 bots**: 1 file every 1.0s (~60 files/min, **3x speedup**)
- **5 bots**: 1 file every 0.6s (~100 files/min, **5x speedup**)

### Setup Instructions
1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Run `/newbot` and create 2, 3, or more bots (e.g. `ViktorychBackupBot1`, `ViktorychBackupBot2`, `ViktorychBackupBot3`).
3. Add **all** created bots as administrators to your private Telegram backup channel with permission to post messages.
4. Copy each bot token.
5. In your GitHub repository settings (**Settings > Secrets and variables > Actions > New repository secret**), add:
   - **Name**: `TELEGRAM_BOT_TOKENS`
   - **Value**: A comma-separated list of your bot tokens:
     ```
     123456789:ABCdefGHIjklMNOpqrSTUvwxYZ,987654321:ZYXwvuTSRqpoNMLkjIHGfedCBA,111222333:AAAABBBBCCCCDDDDEEEEFFFFGGGG
     ```
6. ViktorychApp will automatically detect the pool, log `multi-bot pool active (3 bots)`, and dynamically route uploads to whichever bot is idle. Every bot token is automatically redacted from logs.

---

## 2. Parallel Sharding (`--shard K/N`)

You can run multiple instances of `telegram_backup.py` concurrently across multiple machines or workflow matrix runners without race conditions.

ViktorychApp deterministically partitions R2 keys using hash modulo:
$$\text{shard} = \text{MD5}(\text{key}) \pmod N$$

### Usage
- Runner 1: `python3 scripts/telegram_backup.py --shard 0/2`
- Runner 2: `python3 scripts/telegram_backup.py --shard 1/2`

Both runners process completely disjoint file sets in parallel. When uploading manifests, `save_manifest` atomically fetches the remote manifest from R2, merges new entries (`merge_manifest`), and updates Cloudflare D1 with atomic upserts.

In GitHub Actions, you can trigger a specific shard via **Run workflow** by entering `0/2` or `1/2` in the `shard` input.

---

## 3. Turnkey 24/7 Cloud Background Worker on Hugging Face Spaces (Free 16 GB RAM)

Hugging Face Spaces offers **Docker Spaces** that are **100% free forever** with:
- **2 vCPUs**
- **16 GB RAM**
- **50 GB Disk**
- Unmetered network connectivity
- Continuous 24/7 uptime without idle shutdowns when serving an open HTTP port

A ready-to-run Dockerfile and lightweight server are provided in `docker/telegram-backup/`.

### Deployment Steps (5 Minutes)
1. Sign up for free at [huggingface.co](https://huggingface.co).
2. Click your profile icon > **New Space**.
3. Configure the Space:
   - **Space name**: `viktorych-backup`
   - **License**: `mit`
   - **Space SDK**: **Docker**
   - **Docker template**: **Blank**
   - **Space hardware**: **Free (2 vCPU · 16 GB RAM)**
4. Clone your new Hugging Face Space repository locally, or push `ViktorychApp` to it as a git remote:
   ```sh
   git remote add hf https://huggingface.co/spaces/<your-username>/viktorych-backup
   git push hf main
   ```
5. In your Space's **Settings > Variables and secrets > New secret**, add your secrets:
   - `TELEGRAM_BOT_TOKENS`: your comma-separated bot tokens
   - `TELEGRAM_CHANNEL_ID`: your `-100...` channel ID
   - `CLOUDFLARE_API_TOKEN`: your Cloudflare API token
   - `CLOUDFLARE_ACCOUNT_ID`: your Cloudflare Account ID
   - `TG_INTERVAL`: `120` (runs backup every 2 minutes)
   - `TG_SHARD`: optional shard (e.g. `0/2`) if running multiple Spaces
6. The Space will automatically build the container and start `docker/telegram-backup/server.py`.
7. You can check the live status at `https://<your-space-name>.hf.space/health` which outputs:
   ```json
   {
     "status": "idle",
     "runs_total": 4,
     "errors_total": 0,
     "service": "viktorych-telegram-backup",
     "bots_configured": 3,
     "time": 1761400000
   }
   ```
8. To immediately trigger an out-of-band backup run at any time, send a POST request:
   ```sh
   curl -X POST https://<your-space-name>.hf.space/run
   ```

---

## 4. Alternative: Oracle Cloud Always Free (24 GB RAM, 4 vCPUs)

Oracle Cloud Infrastructure (OCI) provides a permanent **Always Free Tier** (not a 30-day trial) that includes:
- **4 Ampere A1 ARM vCPUs**
- **24 GB RAM**
- **200 GB NVMe Storage**
- **10 TB / month** outbound data transfer

### Quick Docker Run on Oracle Cloud
SSH into your free ARM instance and run:
```sh
git clone https://github.com/ViktorychGroup/ViktorychApp.git
cd ViktorychApp

docker build -t viktorych-backup -f docker/telegram-backup/Dockerfile .

docker run -d \
  --name viktorych-backup \
  --restart unless-stopped \
  -e TELEGRAM_BOT_TOKENS="123:ABC,456:DEF,789:GHI" \
  -e TELEGRAM_CHANNEL_ID="-1001234567890" \
  -e CLOUDFLARE_API_TOKEN="..." \
  -e CLOUDFLARE_ACCOUNT_ID="..." \
  -e TG_INTERVAL=120 \
  -p 7860:7860 \
  viktorych-backup
```

---

## 5. Always-on TikTok LIVE recorder (`docker/tiktok-live/`)

This container watches the tracked TikTok accounts around the clock and records every live as soon as it starts. It replaces the hourly `tiktok-live.yml` poll and the per-minute Worker dispatch for recording, so a live is caught within about 30 seconds instead of minutes, and a part can run 12 hours instead of the 5.5-hour Actions limit.

What it does:

- It polls the same sources as the Actions poller: the `TIKTOK_TRACKED` handles, the accounts added in the app (`owner/added-accounts.json`) and the live index (`owner/tiktok.json`). `scripts/tiktok_sync.py --live-only` runs every 10 minutes, and the watcher reads the index from R2 every 30 seconds.
- It records with the same `scripts/tiktok_record.py --record`: origin quality, `ffmpeg -c copy`, never re-encoded. The same R2 buffer, `owner/live-jobs/`, `owner/tiktok-recordings.json`, manifests and D1 `telegram_files` rows are written, so Shorts and `/tg` playback work exactly as with Actions recordings.
- The same `--upload` drains segments to the Telegram backup channel.
- New: when a live ends, it sends the **full-length video** to the backup channel. The kept segments are joined with `ffmpeg -c copy` (concat, no re-encode) and sent as a streamable MP4 with the account, start time, length and title in the caption. With `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` the bot sends files up to 1.9 GB each over MTProto, so most lives are one video. Without them it uses the Bot API, in 48 MB pieces. Longer lives are cut into numbered pieces (`1/3`, `2/3`…), also copy-only. A marker in R2 (`owner/live-full/<handle>/<room>.json`) stops a live being sent twice, and the local copy is deleted after it is sent (or after 3 days).
- It respects the owner's server-recording switch (`owner/live-record.json`) and per-account recording, the same rule the Worker uses. `TIKTOK_RECORD_ALL=1` records every tracked live.
- `GET /health` returns 200 while the loop is healthy and 503 otherwise. `GET /status` shows counts only (no handles, ids or secrets) and needs `Authorization: Bearer <TIKTOK_STATUS_TOKEN>` when that secret is set. `POST /poll` (token required) checks right away. Logs mask tokens, URLs and account names.

### Coexisting with GitHub Actions

While it runs, the container writes a heartbeat to R2 (`owner/live-runner.json`) every cycle. When that heartbeat is less than 5 minutes old, the Actions TikTok steps stand down: `--plan --dispatch`, `--record` and `--upload` log "always-on recorder is running" and exit without work. So the `tiktok-live.yml`, `tiktok-record.yml` and `tiktok-live-upload.yml` workflows **can stay off** once the container runs. If they are on, they do nothing while the container is up and take over again automatically within 5 minutes if it stops. Nothing in `.github/` or the Worker changed.

### Hugging Face Space setup

1. Sign in at huggingface.co. **New Space** → SDK **Docker**, template **Blank**, hardware **CPU basic**. Public is fine: the page serves only `/health`, `/status` is behind a token and nothing secret is in the image. (A private Space works too, but then an outside pinger needs a Hugging Face token.)
2. Put two files in the Space repository (web editor, **Files → Add file**, or `git push`):
   - `Dockerfile`: a copy of `docker/tiktok-live/Dockerfile`
   - `README.md`: a copy of `docker/tiktok-live/space/README.md` (its header sets `sdk: docker` and `app_port: 7860`)

   The image clones ViktorychApp `main` itself, and on every restart it pulls the newest `main` (set the variable `TIKTOK_AUTO_UPDATE=0` to pin it). You never copy the scripts by hand.
3. **Settings → Variables and secrets → New secret**:

   | Secret | Needed | What |
   |---|---|---|
   | `CLOUDFLARE_API_TOKEN` | yes | Same token as the Actions secret (R2 + D1) |
   | `CLOUDFLARE_ACCOUNT_ID` | yes | Same as the Actions secret |
   | `TELEGRAM_BOT_TOKEN` or `TELEGRAM_BOT_TOKENS` | yes | The backup bot; several bots comma separated |
   | `TELEGRAM_CHANNEL_ID` | yes | The `-100…` backup channel; the bot must be an admin |
   | `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | recommended | Free from my.telegram.org → API development tools; enables 1.9 GB full videos |
   | `TIKTOK_STATUS_TOKEN` | recommended | Any long random string; protects `/status` and `/poll` |
   | `TIKTOK_TRACKED` | optional | Extra handles, comma separated, same as the Actions secret |

   Optional variables: `TIKTOK_RECORD_ALL=1`, `TIKTOK_POLL_SECONDS` (30), `TIKTOK_SYNC_SECONDS` (600), `TIKTOK_FULL_VIDEO=0` to skip full videos, `TIKTOK_FULL_CHANNEL_ID` for a separate channel for full videos, `TIKTOK_PART_SECONDS` (43200). `docker/tiktok-live/env.example` lists them all.
4. The Space builds and starts. Open `https://<user>-<space>.hf.space/health`; it shows `"ok": true` after the first cycle.
5. Keep it awake: a free external monitor (for example cron-job.org or UptimeRobot) that requests `/health` every 10–30 minutes.
6. Turn off the Actions TikTok workflows if you like (see above). They are safe to leave on.

**Adding accounts.** Add the TikTok account in the app (added accounts) or to `TIKTOK_TRACKED`, then turn on server recording for it (the per-account record switch, or the owner's server auto-recording switch). Or set `TIKTOK_RECORD_ALL=1`. The container picks the change up on its next sync, within 10 minutes. No restart is needed.

### Same image on any Docker host (free alternatives)

The Dockerfile builds for x86-64 and ARM64, so Oracle Cloud Always Free (ARM), a home server, Koyeb or Fly run it unchanged:

```sh
cp docker/tiktok-live/env.example tiktok-live.env   # fill it in; never commit it
docker build -t viktorych-tiktok-live docker/tiktok-live
docker run -d --name viktorych-tiktok-live --restart unless-stopped \
  --env-file tiktok-live.env -p 7860:7860 viktorych-tiktok-live
```

On a host with a persistent disk, mount `/home/user/keep` so a restart does not lose a live that has not been sent as a full video yet.

### Free-tier caveats

- **Hugging Face now needs a PRO plan (about $9 a month) to create a Docker Space** on CPU basic; a free account gets HTTP 402. If you do not want PRO, use Oracle Always Free or another host above. The hardware itself (2 vCPU, 16 GB RAM, 50 GB disk) is unchanged.
- A Space sleeps after 48 hours without visits; the external ping in step 5 prevents that. A restart or rebuild interrupts a live in progress. When it is back up, the recorder picks a live that is still running up again as a new part within a few minutes; the gap in between is not recorded.
- The Space disk is not persistent. Segments already in R2/Telegram are safe; a full video that was not sent yet is lost on a restart (it is then marked partial or missing, the segments still play in the app).
- Hugging Face allows outbound traffic only on ports 80, 443 and 8080. TikTok, Cloudflare and Telegram use 443.
- TikTok may block or rate-limit data-center IPs. Then the job shows `blocked` and nothing is recorded from that host; there is no captcha or WAF bypass.
- Telegram limits: 20 messages a minute per bot in a channel (add bots to `TELEGRAM_BOT_TOKENS` for more lives at once), 50 MB per Bot API file, 2 GB per MTProto file.
- The Worker free tier (100,000 requests a day) still serves playback; the recorder itself only uses the Cloudflare API.

---

## Free Platform Comparison

| Platform | Cost | RAM | CPU | Storage | Best For |
|---|---|---|---|---|---|
| **GitHub Actions** | $0 (Free) | 7 GB | 2 vCPU | 14 GB | Scheduled cron runs every 30m |
| **Hugging Face Spaces** | Free hardware; creating a Docker Space needs PRO | 16 GB | 2 vCPU | 50 GB | 24/7 backup and the always-on TikTok LIVE recorder |
| **Oracle Cloud Always Free** | $0 (Free) | 24 GB | 4 ARM | 200 GB NVMe | Ultra high-performance continuous HLS remuxing |
| **Cloudflare Workers + D1** | $0 (Free) | 128 MB | Edge | 5 GB D1 | Instant API routing, metadata lookup, and streaming |

All of these options work together synchronously, ensuring your media and comment backups are redundant, fast, and 100% cost-free.
