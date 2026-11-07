#!/usr/bin/env python3
"""Record a public TikTok live and copy it to Telegram.

One Actions job captures one live. The capture is a stream copy of the origin
variant (ffmpeg -c copy). It is never re-encoded. Segments land in R2 first
and the local file is removed, so a slow Telegram channel cannot drop them
or fill the runner disk. The same job offers each segment to Telegram and
checks its sha256. One uploader job drains anything that offer left behind.
Extra channels are an owner-only list; the same bot posts to each of them.

An owner cookie is sent on the first pull when Connected keys has one.
A 401, 403, or captcha marks that key and the pull continues once without
it. No proxy and no captcha bypass. The copy stays lossless (`ffmpeg -c copy`).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from tiktok_sync import (  # noqa: E402
    BLOCKED,
    HANDLE_RE,
    UA,
    challenge_kind,
    cloudflare_env,
    http_get,
    load_added_accounts,
    node_json,
    r2_get,
    r2_put,
)

BUCKET = "viktorych-data"
INDEX_KEY = "owner/tiktok-recordings.json"
JOB_PREFIX = "owner/live-jobs/"
PUBLIC_PREFIX = "owner/recording-public/"
ACTIVE_PREFIX = "owner/live-active/"
BUF_PREFIX = "live-buf/"
CHANNELS_KEY = "owner/tiktok-backup-channels.json"
UPLOAD_PREFIX = "owner/live-upload/"
SMALL_BYTES = 19 * 1024 * 1024
TARGET_BYTES = 18 * 1024 * 1024
CAP_LIMIT = 16
MESSAGES_PER_MINUTE = 20
HIGH_SEGMENTS_PER_MINUTE = 3
PART_SECONDS = 5 * 60 * 60 + 30 * 60
# Stop this job before the Actions six-hour cap. The next part starts after
# this job exits, because the per-handle queue will not run two at once.
HANDOFF_LEAD = 15 * 60
DISK_FLOOR = 2 * 1024 * 1024 * 1024
HEARTBEAT_SECONDS = 8 * 60
DISPATCH_SECONDS = 3 * 60
BACKOFF_SECONDS = 15 * 60
TRANSIENT_LIMIT = 5
URL_RE = re.compile(r"https?://\S+")
CHANNEL_RE = re.compile(r"^-100\d{4,16}$")
KEY_RE = re.compile(r"^tiktok/[A-Za-z0-9._]{2,24}/[1-9][0-9]{5,24}/live$")
RANK = ["origin", "origion", "uhd", "full_hd1", "hd", "hd1", "sd", "sd2", "ld", "sd1"]
ROOM_URL = "https://webcast.tiktok.com/webcast/room/info/?aid=1988&room_id="
# The always-on recorder (docker/tiktok-live, for example a Hugging Face
# Space) writes this heartbeat. While it is fresh, the Actions poller,
# recorder and uploader leave the work to it, so the two never copy or
# send the same live twice. Actions takes over again when it goes quiet.
RUNNER_KEY = "owner/live-runner.json"
RUNNER_FRESH_SECONDS = 5 * 60
ALWAYS_ON = "always-on"


def env_seconds(name: str, default: int, low: int, high: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = int(raw) if raw else int(default)
    except ValueError:
        value = int(default)
    return max(int(low), min(int(high), value))


# Actions stops a job at six hours, so a part ends at five and a half.
# An always-on host has no such cap and may set TIKTOK_PART_SECONDS higher.
PART_SECONDS = env_seconds("TIKTOK_PART_SECONDS", PART_SECONDS, 30 * 60, 48 * 60 * 60)


def log(message: str) -> None:
    text = CHANNEL_RE.sub("-100…", str(message))
    print("[tiktok-record] " + text, flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_stamp(value: str) -> datetime | None:
    text = str(value or "")
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def fresh_iso(value: str, now: str, seconds: int) -> bool:
    left = parse_stamp(value)
    right = parse_stamp(now)
    if left is None or right is None:
        return False
    return (right - left).total_seconds() < seconds


def run_identity() -> str:
    return str(os.environ.get("TIKTOK_RUN_ID") or os.environ.get("GITHUB_RUN_ID") or "")


def is_always_on() -> bool:
    return (os.environ.get("TIKTOK_RUNNER") or "").strip().lower() == ALWAYS_ON


def runner_fresh(doc: dict | None, now: str, seconds: int = RUNNER_FRESH_SECONDS) -> bool:
    row = doc if isinstance(doc, dict) else {}
    if str(row.get("runner") or "") != ALWAYS_ON:
        return False
    return fresh_iso(str(row.get("at") or ""), now, seconds)


def yield_to_always_on(what: str) -> bool:
    """True when an always-on recorder is running and this Actions step should stand down."""
    if is_always_on():
        return False
    try:
        doc = load_json_bytes(r2_get(RUNNER_KEY))
    except Exception:
        return False
    if runner_fresh(doc, now_iso()):
        log("always-on recorder is running; %s left to it" % what)
        return True
    return False


def recording_allowed(job: dict | None, pref: dict | None) -> bool:
    """The Worker rule in worker/src/live-watch.js: server recording is opt-in."""
    if isinstance(pref, dict) and pref.get("server") is True:
        return True
    if not isinstance(job, dict):
        return False
    if job.get("auto") is True or job.get("record") is True:
        return True
    active = job.get("active") if isinstance(job.get("active"), dict) else {}
    return active.get("manual") is True


def gate_lives(lives: list, jobs: dict, pref: dict | None, record_all: bool = False) -> list:
    """Lives the owner allowed, plus any handle whose capture is already underway."""
    kept = []
    for item in lives or []:
        if not isinstance(item, dict):
            continue
        handle = str(item.get("handle") or "").lower()
        job = (jobs or {}).get(handle)
        active = job.get("active") if isinstance(job, dict) and isinstance(job.get("active"), dict) else {}
        if record_all or active or recording_allowed(job, pref):
            kept.append(item)
    return kept


def cap_of() -> int:
    raw = (os.environ.get("TIKTOK_RECORD_CAP") or str(CAP_LIMIT)).strip()
    try:
        value = int(raw)
    except ValueError:
        value = CAP_LIMIT
    return max(1, min(value, CAP_LIMIT))


def capacity(channels: int, cap: int | None = None) -> dict:
    count = max(1, int(channels or 1))
    jobs = CAP_LIMIT if cap is None else max(1, min(int(cap), CAP_LIMIT))
    per = MESSAGES_PER_MINUTE // HIGH_SEGMENTS_PER_MINUTE
    return {
        "recordingJobs": jobs,
        "messagesPerMinute": MESSAGES_PER_MINUTE,
        "highSegmentsPerMinute": HIGH_SEGMENTS_PER_MINUTE,
        "livesPerChannel": per,
        "channels": count,
        "highLivesKeptUp": per * count,
    }


def quality_rank(name: str) -> int:
    try:
        return RANK.index(str(name or "").lower())
    except ValueError:
        return len(RANK)


def segment_seconds(bitrate: int) -> int:
    """Seconds of stream-copy that stay near 18 MiB and under 19 MiB."""
    rate = int(bitrate or 0)
    if rate <= 0:
        return 6
    seconds = int((TARGET_BYTES * 8) / rate)
    return max(2, min(30, seconds))


def record_source(picked: dict | None) -> dict:
    """The top rung TikTok offered. FLV stays open until the live ends.

    A live HLS window ends, or the CDN answers 504, and the copy stops.
    HLS is the fallback when that room has no FLV pull.
    """
    row = picked if isinstance(picked, dict) else {}
    hls = str(row.get("hls") or "")
    flv = str(row.get("flv") or "")
    quality = str(row.get("quality") or "")
    note = str(row.get("qualityNote") or "")
    if flv:
        url, kind, alt = flv, "flv", hls
    elif hls:
        url, kind, alt = hls, "hls", ""
    else:
        url, kind, alt = "", "", ""
    top = quality.lower() in {"origin", "origion"}
    if top:
        note = ""
    elif quality and not note:
        note = "best available"
    return {"url": url, "kind": kind, "alt": alt, "quality": quality, "qualityNote": note}


def prefer_cached(cached: dict | None, fresh: dict | None) -> dict:
    """A cached URL is returned only when it is origin and the fresh one is lower or missing.

    A fresh origin always replaces a cached lower URL. A cached HD URL is never kept.
    """
    old = cached if isinstance(cached, dict) else {}
    new = fresh if isinstance(fresh, dict) else {}
    old_url = str(old.get("url") or "")
    new_url = str(new.get("url") or "")
    old_top = quality_rank(str(old.get("quality") or "")) <= 1 and bool(old_url)
    if new_url:
        if old_top and quality_rank(str(old.get("quality") or "")) < quality_rank(str(new.get("quality") or "")):
            return old
        return new
    if old_top:
        return old
    return {"url": "", "quality": ""}


def ffmpeg_args(url: str, dest: Path, seconds: int, start: int = 0) -> list:
    """Stream-copy video and audio. TikTok FLV leads with a text stream the HLS muxer rejects."""
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if str(url).startswith(("http://", "https://")):
        args += [
            "-user_agent", UA,
            "-referer", "https://www.tiktok.com/",
            "-reconnect", "1",
            "-reconnect_streamed", "1",
            "-reconnect_delay_max", "4",
            "-rw_timeout", "15000000",
        ]
        try:
            from owner_keys import stream_cookie
            cookie = stream_cookie("tiktok")
        except Exception:
            cookie = ""
        if cookie:
            args += ["-headers", "Cookie: " + cookie.replace("\r", "").replace("\n", "") + "\r\n"]
    args += [
        "-probesize", "5000000",
        "-analyzeduration", "3000000",
        "-fflags", "+genpts+discardcorrupt",
        "-i", url,
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-sn",
        "-dn",
        "-c", "copy",
        "-f", "hls",
        "-hls_time", str(int(seconds)),
        "-hls_segment_type", "fmp4",
        "-hls_fmp4_init_filename", "init.mp4",
        "-hls_flags", "independent_segments+temp_file",
        "-hls_list_size", "0",
        "-start_number", str(int(start)),
        "-hls_segment_filename", str(dest / "seg%05d.m4s"),
        str(dest / "index.m3u8"),
    ]
    return args


def split_args(src: Path, dest: Path, seconds: int) -> list:
    """Shorter stream-copy pieces. No encoder flags."""
    return ffmpeg_args(str(src), dest, seconds, 0)


def keyframe_args(src: Path, dest: Path) -> list:
    """Copy the first video packet into a tiny file. The recording itself is not re-encoded."""
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(src),
        "-map", "0:v:0",
        "-an",
        "-sn",
        "-c", "copy",
        "-frames:v", "1",
        str(dest),
    ]


def grab_keyframe(src: Path, dest: Path) -> bool:
    args = keyframe_args(src, dest)
    if not copy_only(args) or shutil.which("ffmpeg") is None or not src.is_file():
        return False
    try:
        proc = subprocess.run(args, capture_output=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0 and dest.is_file() and dest.stat().st_size > 0


def store_keyframe(src: Path, meta: dict) -> None:
    if meta.get("thumbDone"):
        return
    handle = str(meta.get("handle") or "")
    room = str(meta.get("room") or "")
    if not HANDLE_RE.fullmatch(handle) or not re.fullmatch(r"[1-9][0-9]{5,24}", room):
        return
    dest = src.parent / "thumb.mp4"
    if not grab_keyframe(src, dest):
        return
    key = "owner/live-thumbs/%s/%s.mp4" % (handle.lower(), room)
    if not r2_put_file(key, dest, "video/mp4"):
        return
    meta["thumbDone"] = True
    meta["thumbKey"] = key
    mirror_thumb_b2(key, dest)
    try:
        dest.unlink()
    except OSError:
        pass


def b2_configured() -> bool:
    return bool(os.environ.get("B2_KEY_ID") and os.environ.get("B2_APP_KEY") and os.environ.get("B2_BUCKET"))


def mirror_thumb_b2(key: str, path: Path) -> bool:
    """Best-effort copy of the keyframe. A missing account does nothing."""
    if not b2_configured() or not path.is_file():
        return False
    try:
        token = (os.environ["B2_KEY_ID"] + ":" + os.environ["B2_APP_KEY"]).encode("utf-8")
        req = urllib.request.Request(
            "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
            headers={"Authorization": "Basic " + base64.b64encode(token).decode("ascii")},
        )
        with urllib.request.urlopen(req, timeout=20) as res:
            auth = json.loads(res.read().decode("utf-8"))
        bucket_id = str((auth.get("allowed") or {}).get("bucketId") or "")
        if not bucket_id or not auth.get("authorizationToken") or not auth.get("apiUrl"):
            return False
        slot_req = urllib.request.Request(
            auth["apiUrl"] + "/b2api/v2/b2_get_upload_url",
            data=json.dumps({"bucketId": bucket_id}).encode("utf-8"),
            headers={"Authorization": auth["authorizationToken"], "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(slot_req, timeout=20) as res:
            slot = json.loads(res.read().decode("utf-8"))
        blob = path.read_bytes()
        put = urllib.request.Request(
            slot["uploadUrl"],
            data=blob,
            method="POST",
            headers={
                "Authorization": slot["authorizationToken"],
                "X-Bz-File-Name": urllib.parse.quote(key, safe="/"),
                "Content-Type": "video/mp4",
                "X-Bz-Content-Sha1": hashlib.sha1(blob).hexdigest(),
            },
        )
        with urllib.request.urlopen(put, timeout=60):
            return True
    except (urllib.error.URLError, TimeoutError, OSError, KeyError, ValueError):
        return False


def copy_only(args: list) -> bool:
    banned = {"libx264", "libx265", "libsvtav1", "crf", "preset", "-c:v", "-c:a", "concurrent", "http_multiple"}
    if any(str(item) in banned for item in args):
        return False
    if args.count("-i") != 1:
        return False
    try:
        return args[args.index("-c") + 1] == "copy"
    except (ValueError, IndexError):
        return False


def channel_slot(room_id: str, channels: int) -> int:
    count = max(1, int(channels or 1))
    if count == 1:
        return 0
    return zlib.crc32(str(room_id or "").encode("utf-8")) % count


def channel_ok(value: str) -> bool:
    return CHANNEL_RE.fullmatch(str(value or "").strip()) is not None


def sort_key(handle: str, added: list, started: str) -> tuple:
    """Earliest start takes a free slot. The handle is only a tie break."""
    del added
    name = str(handle or "").lower()
    return (started or "9999-12-31T00:00:00Z", name)


def blank_job(handle: str) -> dict:
    return {"handle": handle.lower(), "active": {}, "saved": []}


def key_base(handle: str, room: str) -> str:
    base = "tiktok/%s/%s/live" % (str(handle or "").lower(), str(room or ""))
    return base if KEY_RE.fullmatch(base) else ""


def public_view(job: dict | None) -> dict:
    row = job if isinstance(job, dict) else {}
    active = row.get("active") if isinstance(row.get("active"), dict) else {}
    saved = [item for item in (row.get("saved") or []) if isinstance(item, dict)]
    newest = saved[-1] if saved else {}
    state = ""
    source = {}
    if active.get("state") in {"recording", "queued", "blocked"}:
        state = str(active.get("state"))
        source = active
    elif newest:
        state = "saved"
        source = newest
    base = str(source.get("key") or "")
    playable = state == "saved" and KEY_RE.fullmatch(base) is not None
    return {
        "state": state,
        "quality": str(source.get("quality") or ""),
        "qualityNote": str(source.get("qualityNote") or ""),
        "title": str(source.get("title") or ""),
        "cover": str(source.get("cover") or ""),
        "startedAt": str(source.get("startedAt") or ""),
        "endedAt": str(source.get("endedAt") or ""),
        "duration": int(source.get("duration") or 0),
        "roomId": str(source.get("roomId") or ""),
        "parts": int(source.get("parts") or (1 if playable else 0)) if playable or state == "saved" else int(source.get("part") or 0),
        "key": base if playable else "",
        "blocked": state == "blocked",
        "bytes": int(source.get("bytes") or 0),
        "thumb": str(source.get("thumb") or ""),
    }


def ready_to_save(active: dict | None, pending: int) -> bool:
    row = active if isinstance(active, dict) else {}
    if row.get("state") != "recording":
        return False
    if row.get("capturing") or row.get("needsPart") or not row.get("captureDone"):
        return False
    if int(pending or 0) > 0:
        return False
    return int(row.get("segments") or 0) > 0


def live_blocked(row: dict | None, now: str) -> bool:
    item = row if isinstance(row, dict) else {}
    if str(item.get("detail") or "") == BLOCKED:
        return True
    left = parse_stamp(now)
    right = parse_stamp(str(item.get("backoffUntil") or ""))
    return left is not None and right is not None and right > left


def occupies(active: dict, now: str) -> bool:
    if not isinstance(active, dict) or active.get("state") != "recording":
        return False
    if active.get("captureDone") and not active.get("needsPart") and not active.get("capturing"):
        return False
    if active.get("needsPart") or active.get("capturing"):
        return fresh_iso(str(active.get("heartbeat") or active.get("dispatchedAt") or ""), now, HEARTBEAT_SECONDS) or bool(active.get("needsPart"))
    return fresh_iso(str(active.get("heartbeat") or ""), now, HEARTBEAT_SECONDS) or fresh_iso(str(active.get("dispatchedAt") or ""), now, DISPATCH_SECONDS)


def plan(lives: list, added: list, jobs: dict, now: str, cap: int = CAP_LIMIT, channels: int = 1) -> dict:
    """Choose which lives capture now and which wait.

    The earliest start time gets a slot. A live already being captured is not
    started twice. Anything past the cap stays queued.
    """
    cap = max(1, min(int(cap or CAP_LIMIT), CAP_LIMIT))
    channels = max(1, int(channels or 1))
    state = {str(name).lower(): json.loads(json.dumps(job)) for name, job in (jobs or {}).items() if isinstance(job, dict)}
    rows = []
    for item in lives or []:
        if not isinstance(item, dict):
            continue
        handle = str(item.get("handle") or "").lower()
        if not HANDLE_RE.fullmatch(handle):
            continue
        rows.append(item)
    by_handle = {str(item.get("handle") or "").lower(): item for item in rows}

    for handle, item in by_handle.items():
        job = state.setdefault(handle, blank_job(handle))
        active = job.get("active") if isinstance(job.get("active"), dict) else {}
        job["active"] = active
        shelve_finished(job)
        active = job.get("active") if isinstance(job.get("active"), dict) else {}
        if not item.get("live"):
            if active.get("state") == "queued":
                job["active"] = {}
            elif active.get("state") == "recording" and not (active.get("capturing") and fresh_iso(str(active.get("heartbeat") or ""), now, HEARTBEAT_SECONDS)):
                active["capturing"] = False
                active["needsPart"] = False
                active["captureDone"] = True
                shelve_finished(job)
            continue
        if live_blocked(item, now) and not (active.get("capturing") and occupies(active, now)):
            active.clear()
            active.update({
                "state": "blocked",
                "roomId": str(item.get("roomId") or ""),
                "title": str(item.get("title") or ""),
                "quality": str(item.get("quality") or ""),
                "qualityNote": str(item.get("qualityNote") or ""),
                "blocked": True,
            })

    occupants = []
    dispatch = []
    for handle, job in state.items():
        active = job.get("active") if isinstance(job.get("active"), dict) else {}
        if not occupies(active, now):
            continue
        occupants.append(handle)
        if active.get("needsPart") and not fresh_iso(str(active.get("dispatchedAt") or ""), now, DISPATCH_SECONDS):
            part = int(active.get("part") or 1)
            dispatch.append({"handle": handle, "part": part, "room": str(active.get("roomId") or "")})
            active["dispatchedAt"] = now

    candidates = []
    for handle, item in by_handle.items():
        if not item.get("live") or live_blocked(item, now):
            continue
        room = str(item.get("roomId") or "")
        if not room:
            continue
        job = state.setdefault(handle, blank_job(handle))
        active = job.get("active") if isinstance(job.get("active"), dict) else {}
        saved = [row for row in (job.get("saved") or []) if isinstance(row, dict) and str(row.get("roomId") or "") == room]
        finished = [row for row in saved if not row.get("partial")]
        if finished and not active.get("needsPart"):
            continue
        backoff_until = parse_stamp(str(job.get("backoffUntil") or ""))
        now_dt = parse_stamp(now)
        if backoff_until and now_dt and backoff_until > now_dt and not active.get("needsPart"):
            continue
        if str(active.get("roomId") or "") == room and active.get("captureDone") and not active.get("needsPart"):
            # The recorder finished. The uploader has not marked the room saved
            # yet; starting another capture would overwrite the same segments.
            continue
        if occupies(active, now) and str(active.get("roomId") or "") == room:
            continue
        started = str((active or {}).get("startedAt") or item.get("startedAt") or item.get("lastLiveAt") or "")
        candidates.append((sort_key(handle, added, started), handle, item, started))
    candidates.sort(key=lambda row: row[0])

    slots = cap - len(occupants)
    queued = []
    for _key, handle, item, started in candidates:
        job = state[handle]
        room = str(item.get("roomId") or "")
        active = job.get("active") if isinstance(job.get("active"), dict) else {}
        saved = [row for row in (job.get("saved") or []) if isinstance(row, dict) and str(row.get("roomId") or "") == room]
        finished = [row for row in saved if not row.get("partial")]
        cover = str(item.get("cover") or active.get("cover") or "")
        resume = 1
        for row in saved:
            resume = max(resume, int(row.get("parts") or 0) + 1)
        part_no = int(active.get("part") or 0) or resume
        if saved and not finished:
            part_no = max(part_no, resume)
        fields = {
            "roomId": room,
            "title": str(item.get("title") or ""),
            "cover": cover,
            "quality": str(item.get("quality") or ""),
            "qualityNote": str(item.get("qualityNote") or ""),
            "key": key_base(handle, room),
            "startedAt": started or now,
            "channelSlot": channel_slot(room, channels),
            "part": part_no or 1,
        }
        if slots > 0:
            fields.update({
                "state": "recording",
                "capturing": False,
                "captureDone": False,
                "needsPart": False,
                "dispatchedAt": now,
                "segments": int(active.get("segments") or 0),
            })
            job["active"] = fields
            dispatch.append({"handle": handle, "part": fields["part"], "room": room})
            slots -= 1
        else:
            fields.update({"state": "queued", "capturing": False, "captureDone": False, "needsPart": False})
            job["active"] = fields
            queued.append(handle)

    active_count = sum(1 for job in state.values() if isinstance(job.get("active"), dict) and job["active"].get("state") == "recording" and not job["active"].get("captureDone"))
    return {
        "jobs": state,
        "dispatch": dispatch,
        "queued": queued,
        "active": active_count,
        "cap": cap,
        "channels": channels,
    }


def plan_uploads(jobs: dict, heartbeats: dict, slots: int, now: str) -> list:
    need = False
    for job in (jobs or {}).values():
        active = job.get("active") if isinstance(job, dict) and isinstance(job.get("active"), dict) else {}
        if not active:
            continue
        if active.get("settled") or str(active.get("state") or "") == "blocked":
            continue
        segments = int(active.get("segments") or 0) > 0
        capturing = bool(active.get("capturing")) and fresh_iso(str(active.get("heartbeat") or ""), now, 8 * 60)
        if capturing or (segments and (active.get("captureDone") or active.get("needsPart"))):
            need = True
    if not need:
        return []
    start = []
    for slot in range(max(0, int(slots or 0))):
        seen = str((heartbeats or {}).get(slot) or (heartbeats or {}).get(str(slot)) or "")
        if not fresh_iso(seen, now, DISPATCH_SECONDS):
            start.append(slot)
    return start


def job_key(handle: str) -> str:
    return JOB_PREFIX + str(handle or "").lower() + ".json"


def load_json_bytes(blob: bytes | None) -> dict:
    if not blob:
        return {}
    try:
        parsed = json.loads(blob.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def load_job(handle: str) -> dict:
    job = load_json_bytes(r2_get(job_key(handle)))
    if not job:
        return blank_job(handle)
    job["handle"] = str(handle).lower()
    if not isinstance(job.get("active"), dict):
        job["active"] = {}
    if not isinstance(job.get("saved"), list):
        job["saved"] = []
    return job


def slot_held(active: dict | None) -> bool:
    row = active if isinstance(active, dict) else {}
    if row.get("state") != "recording":
        return False
    if row.get("captureDone") and not row.get("needsPart"):
        return False
    return True


def save_job(job: dict) -> None:
    """Write this live only. Parallel recorders never share a file."""
    handle = str(job.get("handle") or "").lower()
    job["handle"] = handle
    view = public_view(job)
    job["public"] = view
    job["updatedAt"] = now_iso()
    r2_put(job_key(handle), json.dumps(job, ensure_ascii=False).encode("utf-8"))
    if view.get("state"):
        r2_put(PUBLIC_PREFIX + handle + ".json", json.dumps(view, ensure_ascii=False).encode("utf-8"))
    else:
        r2_delete(PUBLIC_PREFIX + handle + ".json")
    active = job.get("active") if isinstance(job.get("active"), dict) else {}
    if slot_held(active):
        marker = {"handle": handle, "roomId": str(active.get("roomId") or ""), "at": job["updatedAt"]}
        r2_put(ACTIVE_PREFIX + handle + ".json", json.dumps(marker).encode("utf-8"))
    else:
        r2_delete(ACTIVE_PREFIX + handle + ".json")


def write_index(jobs: dict, cap: int) -> None:
    items = {}
    active = 0
    for handle, job in jobs.items():
        view = public_view(job)
        if not view.get("state"):
            continue
        items[handle] = view
        if view["state"] == "recording":
            active += 1
    payload = {"cap": cap, "active": active, "items": items}
    r2_put(INDEX_KEY, json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def dispatch_ref() -> str:
    name = (os.environ.get("GITHUB_REF_NAME") or "main").strip()
    if not re.fullmatch(r"[A-Za-z0-9._/-]{1,120}", name):
        return "main"
    return name


def github_dispatch(workflow: str, inputs: dict) -> bool:
    repo = (os.environ.get("GITHUB_REPOSITORY") or "").strip()
    token = (os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or "").strip()
    if not repo or not token:
        log("dispatch skipped")
        return False
    url = "https://api.github.com/repos/%s/actions/workflows/%s/dispatches" % (repo, workflow)
    body = json.dumps({"ref": dispatch_ref(), "inputs": {key: str(value) for key, value in inputs.items()}}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "User-Agent": "tiktok-record",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return 200 <= int(getattr(res, "status", 204)) < 300
    except urllib.error.HTTPError as err:
        log("dispatch failed %s" % err.code)
        return False
    except (urllib.error.URLError, TimeoutError, OSError):
        log("dispatch failed")
        return False


def extra_channel_count() -> int:
    doc = load_json_bytes(r2_get(CHANNELS_KEY))
    rows = doc.get("channels") if isinstance(doc.get("channels"), list) else []
    return sum(1 for item in rows if channel_ok(str(item)))


def cover_for(handle: str, accounts: dict) -> str:
    for row in accounts.get("added") or []:
        if isinstance(row, dict) and str(row.get("handle") or "").lower() == handle:
            return str(row.get("avatar") or "")
    return ""


def lives_from_doc(doc: dict, accounts: dict) -> list:
    live = doc.get("live") if isinstance(doc.get("live"), dict) else {}
    rows = []
    for name, item in live.items():
        if not isinstance(item, dict):
            continue
        handle = str(item.get("handle") or name).lower()
        rows.append({
            "handle": handle,
            "live": bool(item.get("live")),
            "roomId": str(item.get("roomId") or ""),
            "title": str(item.get("title") or ""),
            "cover": cover_for(handle, accounts),
            "quality": str(item.get("quality") or ""),
            "qualityNote": str(item.get("qualityNote") or ""),
            "startedAt": str(item.get("startedAt") or item.get("lastLiveAt") or ""),
            "lastLiveAt": str(item.get("lastLiveAt") or ""),
            "detail": str(item.get("detail") or ""),
            "backoffUntil": str(item.get("backoffUntil") or ""),
        })
    return rows


def load_jobs(handles: list) -> dict:
    found = {}
    for handle in handles:
        name = str(handle or "").lower()
        if not HANDLE_RE.fullmatch(name):
            continue
        blob = r2_get(job_key(name))
        if blob:
            found[name] = load_job(name)
    index = load_json_bytes(r2_get(INDEX_KEY))
    for name in (index.get("items") or {}):
        if name not in found and HANDLE_RE.fullmatch(str(name)):
            blob = r2_get(job_key(str(name)))
            if blob:
                found[str(name)] = load_job(str(name))
    return found


def upload_heartbeats(slots: int) -> dict:
    found = {}
    for slot in range(slots):
        doc = load_json_bytes(r2_get(UPLOAD_PREFIX + str(slot) + ".json"))
        if doc.get("at"):
            found[slot] = str(doc.get("at"))
    return found


def plan_once(gated: bool = False, record_all: bool = False, use_local: bool = True) -> dict:
    """One planning pass. Saves job state and returns what should start.

    The Actions poller dispatches workflows from the result. The always-on
    recorder starts local processes from the same result instead, and
    passes gated=True so it follows the owner's server-recording switch
    the same way the Worker watcher does.
    """
    local = ROOT / "owner" / "tiktok.json"
    if use_local and local.is_file():
        doc = load_json_bytes(local.read_bytes())
    else:
        doc = load_json_bytes(r2_get("owner/tiktok.json"))
    accounts = load_added_accounts()
    added = [str(row.get("handle") or "") for row in (accounts.get("added") or []) if isinstance(row, dict)]
    lives = lives_from_doc(doc, accounts)
    jobs = load_jobs([item["handle"] for item in lives])
    if gated:
        pref = load_json_bytes(r2_get("owner/live-record.json"))
        lives = gate_lives(lives, jobs, pref, record_all)
    channels = 1 + extra_channel_count()
    cap = cap_of()
    moment = now_iso()
    decided = plan(lives, added, jobs, moment, cap, channels)
    for handle, job in decided["jobs"].items():
        if job != jobs.get(handle):
            save_job(job)
    write_index(decided["jobs"], cap)
    beats = upload_heartbeats(channels)
    uploads = plan_uploads(decided["jobs"], beats, channels, moment)
    numbers = capacity(channels, cap)
    log("cap %s active %s queued %s channels %s kept-up %s" % (
        cap, decided["active"], len(decided["queued"]), channels, numbers["highLivesKeptUp"]))
    return {
        "dispatch": decided["dispatch"],
        "upload": uploads,
        "capacity": numbers,
        "active": decided["active"],
        "queued": len(decided["queued"]),
        "channels": channels,
        "lives": sum(1 for item in lives if item.get("live")),
    }


def cmd_plan(dispatch: bool) -> int:
    token, account = cloudflare_env()
    if not token or not account:
        log("Cloudflare credentials are not set; skipping")
        return 0
    if dispatch and yield_to_always_on("dispatch"):
        return 0
    result = plan_once()
    decided = {"dispatch": result["dispatch"]}
    uploads = result["upload"][:1]
    numbers = result["capacity"]
    if not dispatch:
        print(json.dumps({"dispatch": decided["dispatch"], "upload": uploads, "capacity": numbers}, ensure_ascii=False))
        return 0
    for item in decided["dispatch"]:
        ok = github_dispatch("tiktok-record.yml", {"handle": item["handle"], "part": item["part"], "room": item["room"]})
        log("dispatch %s part %s %s" % (item["handle"], item["part"], "ok" if ok else "failed"))
    for slot in uploads:
        ok = github_dispatch("tiktok-live-upload.yml", {"slot": slot})
        log("uploader %s %s" % (slot, "ok" if ok else "failed"))
    return 0


def room_pick(room: str) -> tuple[dict, str]:
    status, body, _retry = http_get(ROOM_URL + urllib.parse.quote(str(room)))
    kind = challenge_kind(status, body)
    if kind or status == 0:
        return {}, kind or "0"
    picked = node_json("pick", body)
    return picked if isinstance(picked, dict) else {}, ""


def pick_retry(room: str, picker=None, attempts: int = 3, pause: int = 4) -> tuple:
    """Short retries of one room pick.

    The webcast room API answers most single 403/503 bursts and node
    hiccups, so the recorder must not mark a live blocked on the first
    failed pick. The outcome is "ok", "hard" when the room API itself is
    blocked (a 403, 429, 503, or captcha), or "network" when the answer
    says nothing about the live at all.
    """
    pick = picker or room_pick
    kind = ""
    for attempt in range(max(1, int(attempts))):
        try:
            picked, kind = pick(str(room))
        except Exception:
            picked, kind = {}, ""
        if not kind and picked:
            return picked, "", "ok"
        if attempt + 1 < max(1, int(attempts)):
            time.sleep(max(0, int(pause)))
    return {}, str(kind or ""), "hard" if str(kind or "") not in ("0", "") else "network"


def probe_bitrate(url: str) -> int:
    if not url or shutil.which("ffprobe") is None:
        return 0
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-user_agent", UA, "-probesize", "1000000", "-analyzeduration", "1000000",
             "-show_entries", "format=bit_rate", "-of", "default=nw=1:nk=1", url],
            capture_output=True, timeout=8, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return 0
    try:
        return int((proc.stdout or b"").decode("utf-8", "replace").strip() or "0")
    except ValueError:
        return 0


def r2_put_file(key: str, path: Path, content_type: str) -> bool:
    token, account = cloudflare_env()
    if not token or not account:
        return False
    quoted = urllib.parse.quote(key, safe="/")
    url = "https://api.cloudflare.com/client/v4/accounts/%s/r2/buckets/%s/objects/%s" % (account, BUCKET, quoted)
    req = urllib.request.Request(url, data=path.read_bytes(), method="PUT", headers={
        "Authorization": "Bearer " + token,
        "content-type": content_type,
    })
    try:
        with urllib.request.urlopen(req, timeout=120):
            return True
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def r2_delete(key: str) -> None:
    token, account = cloudflare_env()
    if not token or not account:
        return
    quoted = urllib.parse.quote(key, safe="/")
    url = "https://api.cloudflare.com/client/v4/accounts/%s/r2/buckets/%s/objects/%s" % (account, BUCKET, quoted)
    req = urllib.request.Request(url, method="DELETE", headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=60):
            return
    except (urllib.error.URLError, TimeoutError, OSError):
        return


def list_prefix(prefix: str) -> list:
    token, account = cloudflare_env()
    if not token or not account:
        return []
    found = []
    cursor = ""
    seen = set()
    while True:
        query = "?prefix=%s&per_page=1000" % urllib.parse.quote(prefix)
        if cursor:
            query += "&cursor=" + urllib.parse.quote(cursor)
        url = "https://api.cloudflare.com/client/v4/accounts/%s/r2/buckets/%s/objects%s" % (account, BUCKET, query)
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                body = json.loads(res.read().decode("utf-8") or "{}")
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
            break
        for row in body.get("result") or []:
            if isinstance(row, dict) and row.get("key"):
                found.append(str(row.get("key")))
        info = body.get("result_info") or {}
        cursor = str(info.get("cursor") or "")
        truncated = info.get("is_truncated")
        if truncated in (False, None, 0, "0", "false", "False") or not cursor or cursor in seen:
            break
        seen.add(cursor)
    return found


def durations_from_playlist(path: Path) -> dict:
    found = {}
    if not path.is_file():
        return found
    pending = None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("#EXTINF:"):
            try:
                pending = float(line.split(":", 1)[1].split(",", 1)[0])
            except ValueError:
                pending = None
            continue
        if line.startswith("#") or not line.strip():
            continue
        if pending is not None:
            found[Path(line.strip()).name] = pending
        pending = None
    return found


_OFFERS = None
_OFFER_LOCK = threading.Lock()


def queue_offer(buf_key: str, meta: dict) -> None:
    """Hand a stored segment to Telegram without stopping the copy."""
    bot = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    channel = (os.environ.get("TELEGRAM_CHANNEL_ID") or "").strip()
    if not bot or not channel:
        return
    global _OFFERS
    with _OFFER_LOCK:
        if _OFFERS is None:
            _OFFERS = queue.Queue()
            threading.Thread(target=_offer_loop, name="tiktok-offer", daemon=True).start()
    _OFFERS.put((buf_key, dict(meta)))


def _offer_loop() -> None:
    while True:
        buf_key, meta = _OFFERS.get()
        try:
            offer_segment(buf_key, meta)
        except Exception:
            log("telegram offer failed")


def object_key_from_buf(buf_key: str) -> str:
    match = re.match(r"^live-buf/\d+/([A-Za-z0-9._]{2,24})/([1-9][0-9]{5,24})/([1-9][0-9]{0,3})/", str(buf_key or ""))
    if not match:
        return ""
    return "tiktok/%s/%s/live/%s" % (match.group(1).lower(), match.group(2), match.group(3))


def offer_segment(buf_key: str, meta: dict) -> None:
    """Upload one buffered piece and check its sha256. Leave R2 in place on failure."""
    bot = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    channel = (os.environ.get("TELEGRAM_CHANNEL_ID") or "").strip()
    token, account = cloudflare_env()
    if not bot or not channel or not token or not account:
        return
    if meta.get("oversize") or int(meta.get("size") or 0) >= SMALL_BYTES:
        return
    blob = r2_get(buf_key)
    if not blob or not piece_matches(blob, meta):
        return
    from telegram_backup import d1_id, d1_rows, remember_d1, send_document

    database = d1_id(token, account)
    object_key = str(meta.get("objectKey") or "") or object_key_from_buf(buf_key)
    if not object_key:
        return
    role = "init" if meta.get("role") == "init" else "segment"
    part_index = int(meta.get("index") if meta.get("index") is not None else 0)
    kind = "init" if role == "init" else "segment"
    if role == "init" and not init_ready(blob):
        log("init skipped")
        return
    digest = hashlib.sha256(blob).hexdigest()
    local = Path(tempfile.mkdtemp(prefix="tiktok-offer-")) / Path(buf_key).name
    try:
        local.write_bytes(blob)
        existing = d1_rows(token, account, database, "SELECT file_id FROM telegram_files WHERE object_key = ? AND kind = ? AND part_index = ? LIMIT 1", [object_key, kind, part_index])
        if not existing:
            sent = send_document("https://api.telegram.org", bot, channel, local, object_key, {"last": 0.0})
            remember_d1(token, account, database, {
                "serve": True,
                "bucket": BUCKET,
                "key": object_key,
                "encrypted": False,
            }, {
                "role": role,
                "index": part_index,
                "file_id": sent["file_id"],
                "message_id": sent["message_id"],
                "size": int(sent.get("file_size") or local.stat().st_size),
                "sha256": digest,
                "mime": "video/mp4",
                "duration": float(meta.get("duration") or 0),
            }, True, object_key)
        r2_delete(buf_key)
        r2_delete(buf_key + ".json")
        log("offered %s #%s %s" % (object_key, part_index, digest[:12]))
    finally:
        shutil.rmtree(local.parent, ignore_errors=True)


def store_piece(local: Path, buf_key: str, meta: dict) -> bool:
    sidecar = dict(meta)
    sidecar["size"] = local.stat().st_size
    sidecar["sha256"] = hashlib.sha256(local.read_bytes()).hexdigest()
    if not r2_put_file(buf_key, local, "video/mp4"):
        return False
    if not r2_put(buf_key + ".json", json.dumps(sidecar).encode("utf-8")):
        return False
    queue_offer(buf_key, sidecar)
    return True


def split_oversize(local: Path, dest: Path) -> list:
    """Stream-copy a segment that is still at least 19 MiB. Empty when copy cannot shrink it."""
    if shutil.which("ffmpeg") is None:
        return []
    seconds = 2
    args = split_args(local, dest, seconds)
    if not copy_only(args):
        return []
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(args, capture_output=True, timeout=180, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return []
    if proc.returncode != 0:
        return []
    pieces = sorted(dest.glob("seg*.m4s"))
    if not pieces or any(piece.stat().st_size >= SMALL_BYTES for piece in pieces):
        return []
    return pieces


def init_ready(blob: bytes) -> bool:
    """A fragment is not playable until this fMP4 init exists. An empty file is not one."""
    data = blob if isinstance(blob, (bytes, bytearray)) else b""
    if len(data) < 32 or len(data) >= SMALL_BYTES:
        return False
    ftyp = data.find(b"ftyp")
    return 0 <= ftyp <= 32 and data.find(b"moov") > ftyp


def keep_folder(meta: dict) -> Path | None:
    """Where an always-on host keeps a local copy for the full-length Telegram video.

    Unset (the Actions default) keeps nothing. Low disk stops the copy and
    leaves a gap marker, so the full video is labelled partial instead of
    filling the disk.
    """
    root = (os.environ.get("TIKTOK_KEEP_DIR") or "").strip()
    if not root:
        return None
    handle = str(meta.get("handle") or "").lower()
    room = str(meta.get("room") or "")
    part = str(meta.get("objectKey") or "").rsplit("/", 1)[-1]
    run = str(meta.get("keepRun") or "0")
    if not HANDLE_RE.fullmatch(handle) or not re.fullmatch(r"[1-9][0-9]{5,24}", room):
        return None
    if not re.fullmatch(r"[1-9][0-9]{0,3}", part) or not re.fullmatch(r"[0-9]{1,20}", run):
        return None
    folder = Path(root) / handle / room / part / run
    try:
        folder.mkdir(parents=True, exist_ok=True)
        free = shutil.disk_usage(str(folder)).free
    except OSError:
        return None
    if free < DISK_FLOOR * 2:
        try:
            (folder / ".gap").write_text(now_iso(), encoding="utf-8")
        except OSError:
            pass
        return None
    return folder


def keep_copy(meta: dict, path: Path, name: str, move: bool) -> None:
    folder = keep_folder(meta)
    if folder is None:
        if move:
            try:
                path.unlink()
            except OSError:
                pass
        return
    try:
        if move:
            shutil.move(str(path), str(folder / name))
        else:
            shutil.copyfile(str(path), str(folder / name))
    except OSError:
        if move:
            try:
                path.unlink()
            except OSError:
                pass


def publish_local(dest: Path, sent: set, meta: dict, closed: bool = False) -> int:
    """Store finished segments and drop the local files.

    The newest segment stays on disk while ffmpeg still has it open.
    A segment is removed only after R2 has accepted every piece.
    """
    stored = 0
    meta["addedBytes"] = 0
    playlist = durations_from_playlist(dest / "index.m3u8")
    init = dest / "init.mp4"
    if init.is_file() and "init.mp4" not in sent:
        try:
            blob = init.read_bytes()
        except OSError:
            blob = b""
        if init_ready(blob):
            snap = dest / "init-stable.mp4"
            snap.write_bytes(blob)
            piece = {
                "objectKey": meta["objectKey"],
                "role": "init",
                "index": -1,
                "duration": 0,
                "channelSlot": meta["channelSlot"],
                "oversize": False,
            }
            if store_piece(snap, meta["buf"] + "/init.mp4", piece):
                sent.add("init.mp4")
                stored += 1
                keep_copy(meta, snap, "init.mp4", move=False)
    paths = sorted(dest.glob("seg*.m4s"))
    if not closed and paths:
        paths = paths[:-1]
    for path in paths:
        if path.name in sent:
            continue
        index = int(path.stem.replace("seg", "") or "0")
        piece_bytes = path.stat().st_size
        if not meta.get("thumbDone"):
            store_keyframe(path, meta)
        pieces = [path]
        oversize = False
        if path.stat().st_size >= SMALL_BYTES:
            smaller = split_oversize(path, dest / ("split-" + path.stem))
            if smaller:
                pieces = smaller
            else:
                oversize = True
                log("oversize %s" % path.name)
        wrote = 0
        for offset, piece_path in enumerate(pieces):
            piece = {
                "objectKey": meta["objectKey"],
                "role": "segment",
                "index": index if len(pieces) == 1 else index * 100 + offset,
                "duration": playlist.get(path.name) or meta.get("seconds") or 6,
                "channelSlot": meta["channelSlot"],
                "oversize": oversize,
            }
            buf_name = piece_path.name if len(pieces) == 1 else ("seg%05d.m4s" % piece["index"])
            if store_piece(piece_path, meta["buf"] + "/" + buf_name, piece):
                wrote += 1
        if wrote != len(pieces):
            continue
        meta["addedBytes"] = int(meta.get("addedBytes") or 0) + piece_bytes
        stored += wrote
        sent.add(path.name)
        keep_copy(meta, path, path.name, move=True)
        shutil.rmtree(dest / ("split-" + path.stem), ignore_errors=True)
    return stored


def redact(text: str) -> str:
    return URL_RE.sub("<url>", str(text or ""))


def iso_after(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=max(0, int(seconds)))).strftime("%Y-%m-%dT%H:%M:%SZ")


def pull_failure(tail: str) -> str:
    text = redact(tail).lower()
    if any(word in text for word in ("403", "401", "forbidden", "captcha")):
        return "blocked"
    return "transient"


def record_decision(still_live: bool, gained: int, reason: str, failure: str) -> str:
    """What one ffmpeg attempt should do next. Pure, so the pipeline can be tested."""
    if not still_live:
        return "save" if int(gained or 0) > 0 else "drop"
    if reason == "overcap":
        return "save" if int(gained or 0) > 0 else "drop"
    if reason in {"deadline", "chain", "handoff"}:
        return "chain"
    if failure == "blocked" and int(gained or 0) <= 0:
        return "backoff"
    return "retry"


def piece_matches(blob: bytes, meta: dict | None) -> bool:
    if not blob or len(blob) >= SMALL_BYTES:
        return False
    row = meta if isinstance(meta, dict) else {}
    expected = str(row.get("sha256") or "")
    digest = hashlib.sha256(blob).hexdigest()
    if expected and expected != digest:
        return False
    size = int(row.get("size") or 0)
    if size and size != len(blob):
        return False
    return True


def past_entries(job: dict | None) -> list:
    row = job if isinstance(job, dict) else {}
    found = []
    active = row.get("active") if isinstance(row.get("active"), dict) else {}
    if active.get("state") in {"recording", "queued"} and not active.get("captureDone"):
        found.append({
            "state": str(active.get("state")),
            "handle": str(row.get("handle") or ""),
            "title": str(active.get("title") or ""),
            "startedAt": str(active.get("startedAt") or ""),
            "endedAt": "",
            "duration": int(active.get("duration") or 0),
            "viewers": int(active.get("viewers") or 0),
            "cover": str(active.get("cover") or ""),
            "quality": str(active.get("quality") or ""),
            "qualityNote": str(active.get("qualityNote") or ""),
            "roomId": str(active.get("roomId") or ""),
            "parts": int(active.get("part") or 1),
            "key": str(active.get("key") or "") if int(active.get("segments") or 0) > 0 else "",
            "bytes": int(active.get("bytes") or 0),
            "thumb": str(active.get("thumb") or ""),
        })
    for item in row.get("saved") or []:
        if not isinstance(item, dict):
            continue
        found.append({
            "state": "saved",
            "handle": str(row.get("handle") or ""),
            "title": str(item.get("title") or ""),
            "startedAt": str(item.get("startedAt") or ""),
            "endedAt": str(item.get("endedAt") or ""),
            "duration": int(item.get("duration") or 0),
            "viewers": int(item.get("viewers") or 0),
            "cover": str(item.get("cover") or ""),
            "quality": str(item.get("quality") or ""),
            "qualityNote": str(item.get("qualityNote") or ""),
            "roomId": str(item.get("roomId") or ""),
            "parts": int(item.get("parts") or 1),
            "key": str(item.get("key") or ""),
            "bytes": int(item.get("bytes") or 0),
            "thumb": str(item.get("thumb") or ""),
        })
    found.sort(key=lambda item: str(item.get("startedAt") or ""), reverse=True)
    return found


def run_ffmpeg(url: str, dest: Path, seconds: int, start: int, deadline: float, on_tick) -> tuple:
    if shutil.which("ffmpeg") is None:
        log("ffmpeg is not installed")
        return "error", ""
    dest.mkdir(parents=True, exist_ok=True)
    err_path = dest / "ffmpeg.err"
    err_fh = err_path.open("wb")
    proc = subprocess.Popen(ffmpeg_args(url, dest, seconds, start), stdout=subprocess.DEVNULL, stderr=err_fh)
    reason = "ended"
    try:
        while proc.poll() is None:
            if time.time() >= deadline:
                reason = "deadline"
                proc.send_signal(signal.SIGINT)
                break
            stop = on_tick()
            if stop:
                reason = stop
                proc.send_signal(signal.SIGINT)
                break
            time.sleep(1)
        try:
            proc.wait(timeout=25)
        except subprocess.TimeoutExpired:
            proc.kill()
    finally:
        if proc.poll() is None:
            proc.kill()
        err_fh.close()
    tail = ""
    try:
        tail = redact(err_path.read_text(encoding="utf-8", errors="replace")[-1500:])
    except OSError:
        tail = ""
    return reason, tail


def shelve_finished(job: dict) -> None:
    """A finished capture with bytes belongs in Past lives, not only on the active slot."""
    active = job.get("active") if isinstance(job.get("active"), dict) else {}
    if not active.get("captureDone") or active.get("needsPart") or active.get("capturing"):
        return
    if int(active.get("segments") or 0) <= 0:
        return
    if not KEY_RE.fullmatch(str(active.get("key") or "")):
        return
    mark_saved_room(job)


def mark_saved_room(job: dict) -> None:
    active = job.get("active") if isinstance(job.get("active"), dict) else {}
    if not active:
        return
    room = str(active.get("roomId") or "")
    base = str(active.get("key") or "")
    saved = [item for item in (job.get("saved") or []) if isinstance(item, dict)]
    current = None
    for item in saved:
        if str(item.get("roomId") or "") == room:
            current = item
    if current is None:
        current = {"roomId": room, "key": base}
        saved.append(current)
    current.update({
        "key": base,
        "roomId": room,
        "parts": max(int(current.get("parts") or 0), int(active.get("part") or 1)),
        "quality": active.get("quality") or current.get("quality") or "",
        "qualityNote": active.get("qualityNote") or "",
        "title": active.get("title") or current.get("title") or "",
        "cover": active.get("cover") or current.get("cover") or "",
        "startedAt": active.get("startedAt") or current.get("startedAt") or "",
        "endedAt": active.get("endedAt") or now_iso(),
        "duration": int(active.get("duration") or current.get("duration") or 0),
        "viewers": max(int(active.get("viewers") or 0), int(current.get("viewers") or 0)),
        "partial": bool(active.get("partial")),
        "bytes": max(int(active.get("bytes") or 0), int(current.get("bytes") or 0)),
        "thumb": active.get("thumb") or current.get("thumb") or "",
    })
    job["saved"] = saved
    job["active"] = {}
    write_manifest(job, current)


def write_manifest(job: dict, row: dict) -> None:
    handle = str(job.get("handle") or "").lower()
    room = str(row.get("roomId") or "")
    if not HANDLE_RE.fullmatch(handle) or not re.fullmatch(r"[1-9][0-9]{5,24}", room):
        return
    payload = {
        "handle": handle,
        "roomId": room,
        "title": str(row.get("title") or ""),
        "startedAt": str(row.get("startedAt") or ""),
        "endedAt": str(row.get("endedAt") or ""),
        "duration": int(row.get("duration") or 0),
        "viewers": int(row.get("viewers") or 0),
        "cover": str(row.get("cover") or ""),
        "quality": str(row.get("quality") or ""),
        "qualityNote": str(row.get("qualityNote") or ""),
        "parts": int(row.get("parts") or 0),
        "key": str(row.get("key") or ""),
        "partial": bool(row.get("partial")),
        "bytes": int(row.get("bytes") or 0),
        "thumb": str(row.get("thumb") or ""),
    }
    r2_put("owner/live-manifests/%s/%s.json" % (handle, room), json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def cmd_record(handle: str, part: str, room: str) -> int:
    token, account = cloudflare_env()
    if not token or not account:
        log("Cloudflare credentials are not set; skipping")
        return 0
    name = str(handle or "").lower()
    if not HANDLE_RE.fullmatch(name):
        log("bad handle")
        return 0
    if yield_to_always_on("recording"):
        return 0
    job = load_job(name)
    active = job.get("active") if isinstance(job.get("active"), dict) else {}
    part_n = int(part or active.get("part") or 1)
    room_id = str(room or active.get("roomId") or "")
    if room_id and str(active.get("roomId") or "") == room_id:
        # A queued duplicate must not restart at part 1 after the first part
        # already wrote its segments.
        part_n = max(part_n, int(active.get("part") or 1))
    run_id = run_identity()
    if active.get("capturing") and str(active.get("runId") or "") not in {"", run_id} and fresh_iso(str(active.get("heartbeat") or ""), now_iso(), HEARTBEAT_SECONDS):
        # The per-handle queue starts the next part only after this job
        # exits. A second runner must not copy the same live.
        log("already recording %s" % name)
        return 0
    if not room_id:
        doc = load_json_bytes(r2_get("owner/tiktok.json"))
        live = (doc.get("live") or {}).get(name) if isinstance(doc.get("live"), dict) else {}
        room_id = str((live or {}).get("roomId") or "")
    if not room_id:
        log("no room %s" % name)
        return 0
    picked, kind, outcome = pick_retry(room_id)
    started = str(active.get("startedAt") or now_iso())

    def finish_blocked(why: str) -> int:
        until = iso_after(BACKOFF_SECONDS)
        job["backoffUntil"] = until
        active["blockedUntil"] = until
        active["capturing"] = False
        active["needsPart"] = False
        active["heartbeat"] = ""
        active["roomId"] = room_id
        if int(active.get("segments") or 0) > 0:
            # needsUpload ignores a blocked row. Bytes already copied stay a
            # finished partial so the uploader can send them once.
            active["state"] = "recording"
            active["blocked"] = False
            active["captureDone"] = True
            active["partial"] = True
            active["endedAt"] = now_iso()
            log("blocked %s after %s segments (%s)" % (name, active.get("segments"), why))
        else:
            active["state"] = "blocked"
            active["blocked"] = True
            active["captureDone"] = False
            active["partial"] = False
            log("blocked %s (%s)" % (name, why))
        job["active"] = active
        save_job(job)
        return 0

    def finish_save(partial: bool = False) -> int:
        ended = now_iso()
        try:
            duration = int((parse_stamp(ended) - parse_stamp(started)).total_seconds())
        except (TypeError, AttributeError):
            duration = 0
        active.update({
            "state": "recording",
            "captureDone": True,
            "needsPart": False,
            "capturing": False,
            "blocked": False,
            "partial": bool(partial),
            "heartbeat": "",
            "endedAt": ended,
            "duration": max(0, int(active.get("duration") or 0), duration),
            "part": part_n,
            "parts": part_n,
        })
        job["active"] = active
        shelve_finished(job)
        save_job(job)
        log("capture done %s" % name)
        return 0

    def chain_part() -> int:
        active.update({
            "needsPart": True,
            "part": part_n + 1,
            "captureDone": False,
            "capturing": False,
            "blocked": False,
            "partial": False,
            "dispatchedAt": now_iso(),
            "heartbeat": "",
            "segmentPart": 0,
            "segmentSeq": 0,
        })
        job["active"] = active
        save_job(job)
        github_dispatch("tiktok-record.yml", {"handle": name, "part": part_n + 1, "room": room_id})
        log("part %s %s" % (name, part_n + 1))
        return 0

    if outcome == "hard":
        return finish_blocked(kind or "room")
    if outcome != "ok":
        # A dropped call says nothing about the live. Leave the job alone.
        log("pick %s did not answer %s" % (name, kind or "empty"))
        return 0
    source = record_source(picked)
    if not picked.get("live") or not source["url"]:
        if int(active.get("segments") or 0) > 0:
            return finish_save()
        log("ended %s" % name)
        return 0
    base = key_base(name, room_id)
    if not base:
        log("bad room %s" % name)
        return 0
    try:
        accounts = load_added_accounts()
    except Exception:
        accounts = {"added": []}
    seq = 0 if int(active.get("segmentPart") or 0) != part_n else int(active.get("segmentSeq") or 0)
    if str(active.get("roomId") or "") != str(room_id or ""):
        active["thumb"] = ""
        active["bytes"] = 0
    active.update({
        "state": "recording",
        "roomId": room_id,
        "part": part_n,
        "parts": part_n,
        "key": base,
        "quality": source["quality"],
        "qualityNote": source["qualityNote"],
        "title": str(picked.get("title") or active.get("title") or ""),
        "cover": str(active.get("cover") or "") or cover_for(name, accounts),
        "viewers": max(int(active.get("viewers") or 0), int(picked.get("viewers") or 0)),
        "startedAt": started,
        "capturing": True,
        "captureDone": False,
        "needsPart": False,
        "blocked": False,
        "partial": False,
        "runId": run_id,
        "heartbeat": now_iso(),
        "channelSlot": int(active.get("channelSlot") or channel_slot(room_id, 1 + extra_channel_count())),
        "segments": int(active.get("segments") or 0),
        "segmentPart": part_n,
        "segmentSeq": seq,
    })
    job["active"] = active
    save_job(job)
    note = (" note=" + source["qualityNote"]) if source["qualityNote"] else ""
    log("record %s quality %s via %s%s" % (name, source["quality"] or "unknown", source["kind"] or "?", note))
    seconds = segment_seconds(probe_bitrate(source["url"]))
    deadline = time.time() + PART_SECONDS
    chain_at = deadline - HANDOFF_LEAD
    fails = 0
    tried_alt = False

    while True:
        dest = Path(tempfile.mkdtemp(prefix="tiktok-live-"))
        sent = set()
        meta = {
            "objectKey": base + "/" + str(part_n),
            "buf": "%s%s/%s/%s/%s" % (BUF_PREFIX, active["channelSlot"], name, room_id, part_n),
            "channelSlot": active["channelSlot"],
            "seconds": seconds,
            "handle": name,
            "room": room_id,
            # One folder per ffmpeg start: a restart writes a new init.mp4.
            "keepRun": "%013d" % int(time.time() * 1000),
        }
        before = int(active.get("segments") or 0)
        last_live = 0.0
        last_beat = 0.0
        still = {"live": True}

        def on_tick(dest=dest, sent=sent, meta=meta):
            nonlocal last_live, last_beat, seq
            now = time.time()
            stored = publish_local(dest, sent, meta, closed=False)
            if stored:
                active["segments"] = int(active.get("segments") or 0) + stored
                active["bytes"] = int(active.get("bytes") or 0) + int(meta.get("addedBytes") or 0)
            if meta.get("thumbKey"):
                active["thumb"] = meta["thumbKey"]
            try:
                free = shutil.disk_usage(str(dest)).free
            except OSError:
                free = DISK_FLOOR
            if free < DISK_FLOOR:
                log("disk low")
                return "chain"
            if now >= chain_at:
                return "chain"
            if now - last_beat > 20:
                last_beat = now
                active["heartbeat"] = now_iso()
                active["segmentSeq"] = seq
                active["segmentPart"] = part_n
                job["active"] = active
                save_job(job)
            if now - last_live < 30:
                return ""
            last_live = now
            check, blocked = room_pick(room_id)
            if blocked:
                return ""
            viewers = int(check.get("viewers") or 0)
            if viewers > int(active.get("viewers") or 0):
                active["viewers"] = viewers
            try:
                from viewer_cap import step_cap
                pref = load_json_bytes(r2_get("owner/live-viewer-cap.json"))
                cap = pref.get("cap") if isinstance(pref, dict) else None
                auto = bool(isinstance(pref, dict) and pref.get("autoRestart") is True)
                stepped = step_cap(active.get("capState"), viewers, cap, wanted=True, auto_restart=auto)
                active["capState"] = stepped
                if stepped.get("paused"):
                    job["holdRecord"] = not auto
                    return "overcap"
            except Exception:
                pass
            if check.get("title") and not active.get("title"):
                active["title"] = str(check.get("title") or "")
            if not check.get("live"):
                still["live"] = False
                return "ended"
            return ""

        tail = ""
        try:
            reason, tail = run_ffmpeg(source["url"], dest, seconds, seq, deadline, on_tick)
            stored = publish_local(dest, sent, meta, closed=True)
            if stored:
                active["segments"] = int(active.get("segments") or 0) + stored
                active["bytes"] = int(active.get("bytes") or 0) + int(meta.get("addedBytes") or 0)
            if meta.get("thumbKey"):
                active["thumb"] = meta["thumbKey"]
            for path in dest.glob("seg*.m4s"):
                try:
                    seq = max(seq, int(path.stem.replace("seg", "")) + 1)
                except ValueError:
                    continue
            active["segmentSeq"] = seq
        finally:
            shutil.rmtree(dest, ignore_errors=True)
        gained = int(active.get("segments") or 0) - before
        failure = ""
        if gained <= 0 and reason not in {"deadline", "ended", "handoff", "chain"}:
            failure = pull_failure(tail)
            if tail.strip():
                log("ffmpeg %s %s" % (name, tail.strip().splitlines()[-1][:180]))
        if failure == "blocked":
            try:
                from owner_keys import drop_for_attention
                if drop_for_attention("tiktok", "forbidden"):
                    log("owner key needs attention; continuing without it")
                    failure = ""
                    continue
            except Exception:
                pass
        decision = record_decision(still["live"], gained, reason, failure)
        if decision == "save":
            return finish_save()
        if decision == "drop":
            if int(active.get("segments") or 0) > 0:
                return finish_save()
            job["active"] = {}
            save_job(job)
            log("ended %s" % name)
            return 0
        if decision == "chain":
            return chain_part()
        if decision == "backoff":
            alt = str(source.get("alt") or "")
            if not tried_alt and alt:
                tried_alt = True
                source = {"url": alt, "kind": "hls" if source.get("kind") == "flv" else "flv", "alt": "", "quality": source.get("quality") or "", "qualityNote": source.get("qualityNote") or ""}
                log("retry %s via %s" % (name, source["kind"]))
                continue
            return finish_blocked(failure or "stream")
        if gained > 0:
            fails = 0
        else:
            fails += 1
            if fails >= TRANSIENT_LIMIT:
                log("stream unavailable %s" % name)
                if int(active.get("segments") or 0) > 0:
                    return finish_save(partial=True)
                active.update({"capturing": False, "captureDone": False, "needsPart": False, "heartbeat": "", "state": "recording"})
                job["active"] = active
                save_job(job)
                return 0
            time.sleep(min(60, 5 * fails))
        picked, kind, outcome = pick_retry(room_id, attempts=2, pause=2)
        if outcome == "hard":
            return finish_blocked(kind or "room")
        if outcome == "ok":
            if not picked.get("live"):
                if int(active.get("segments") or 0) > 0:
                    return finish_save()
                job["active"] = {}
                save_job(job)
                log("ended %s" % name)
                return 0
            fresh = record_source(picked)
            if fresh.get("url"):
                source = fresh
                tried_alt = False
            viewers = int(picked.get("viewers") or 0)
            if viewers > int(active.get("viewers") or 0):
                active["viewers"] = viewers
        active["capturing"] = True
        active["heartbeat"] = now_iso()
        job["active"] = active
        save_job(job)
        log("retry %s via %s" % (name, source.get("kind") or ""))


def channel_list() -> list:
    primary = (os.environ.get("TELEGRAM_CHANNEL_ID") or "").strip()
    doc = load_json_bytes(r2_get(CHANNELS_KEY))
    rows = []
    if channel_ok(primary):
        rows.append(primary)
    elif primary:
        log("primary channel id is not usable")
    for item in doc.get("channels") or []:
        text = str(item or "").strip()
        if channel_ok(text) and text not in rows:
            rows.append(text)
    return rows


def touch_upload(slot: int) -> None:
    r2_put(UPLOAD_PREFIX + str(slot) + ".json", json.dumps({"at": now_iso()}).encode("utf-8"))


def cmd_upload(slot: str) -> int:
    token, account = cloudflare_env()
    bot = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if not token or not account or not bot:
        log("upload credentials are not set; skipping")
        return 0
    if yield_to_always_on("upload"):
        return 0
    try:
        index = int(slot or "0")
    except ValueError:
        index = 0
    channels = channel_list()
    if index < 0 or index >= len(channels):
        log("no channel for slot %s" % index)
        return 0
    from telegram_backup import d1_id, d1_rows, remember_d1, send_document

    database = d1_id(token, account)
    channel = channels[index]
    pace = {"last": 0.0}
    idle_since = 0.0
    # The workflow allows one uploader. Leave before the job timeout so a
    # queued run can take the rest of the buffer instead of waiting for hours.
    deadline = time.time() + (15 * 60)
    dead = set()
    retry = {}
    slot_prefix = BUF_PREFIX + str(index) + "/"

    def handle_prefixes(handle: str) -> list:
        # New buffers carry the channel slot in the key so one uploader does
        # not list every other channel's backlog. Old flat keys still drain.
        return [slot_prefix + handle + "/", BUF_PREFIX + handle + "/"]

    while time.time() < deadline:
        touch_upload(index)
        names = [key for key in list_prefix(slot_prefix) if key.endswith(".json")]
        if not names:
            names = [key for key in list_prefix(BUF_PREFIX) if key.endswith(".json") and not re.match(r"^" + re.escape(BUF_PREFIX) + r"\d+/", key)]
        pending = []
        for key in names:
            meta = load_json_bytes(r2_get(key))
            if int(meta.get("channelSlot") or 0) != index:
                continue
            if meta.get("held"):
                dead.add(key)
                continue
            if retry.get(key, 0.0) > time.time():
                continue
            pending.append((key, meta))
        pending.sort(key=lambda item: (str(item[1].get("objectKey") or ""), int(item[1].get("index") or 0)))
        if not pending:
            jobs = load_jobs([])
            index_doc = load_json_bytes(r2_get(INDEX_KEY))
            names_known = list((index_doc.get("items") or {}).keys())
            jobs.update(load_jobs(names_known))
            changed = False
            for handle, job in jobs.items():
                active = job.get("active") if isinstance(job.get("active"), dict) else {}
                prefixes = handle_prefixes(handle)
                left = [key for key in names if any(key.startswith(prefix) for prefix in prefixes) and key not in dead]
                if ready_to_save(active, len(left)):
                    mark_saved_room(job)
                    save_job(job)
                    changed = True
                elif active.get("captureDone") and not active.get("needsPart") and int(active.get("segments") or 0) <= 0 and not left:
                    job["active"] = {}
                    save_job(job)
                    changed = True
            if changed:
                write_index(jobs, cap_of())
            if not idle_since:
                idle_since = time.time()
            if time.time() - idle_since > 30:
                log("upload idle")
                return 0
            time.sleep(5)
            continue
        idle_since = 0.0
        key, meta = pending[0]
        media_key = key[:-5]
        if meta.get("oversize") or int(meta.get("size") or 0) >= SMALL_BYTES:
            meta["held"] = True
            r2_put(key, json.dumps(meta).encode("utf-8"))
            dead.add(key)
            log("oversize held")
            continue
        local = Path(tempfile.mkdtemp(prefix="tiktok-up-")) / Path(media_key).name
        try:
            blob = r2_get(media_key)
            if not blob:
                continue
            digest = hashlib.sha256(blob).hexdigest()
            if not piece_matches(blob, meta):
                attempts = int(meta.get("attempts") or 0) + 1
                meta["attempts"] = attempts
                if attempts >= 3:
                    meta["held"] = True
                    dead.add(key)
                    log("sha256 mismatch held")
                else:
                    log("sha256 mismatch")
                r2_put(key, json.dumps(meta).encode("utf-8"))
                continue
            meta["sha256"] = digest
            local.write_bytes(blob)
            object_key = str(meta.get("objectKey") or "") or object_key_from_buf(media_key)
            if not object_key:
                meta["held"] = True
                dead.add(key)
                r2_put(key, json.dumps(meta).encode("utf-8"))
                continue
            role = "init" if meta.get("role") == "init" else "segment"
            part_index = int(meta.get("index") if meta.get("index") is not None else 0)
            kind = "init" if role == "init" else "segment"
            if role == "init" and not init_ready(blob):
                meta["held"] = True
                dead.add(key)
                r2_put(key, json.dumps(meta).encode("utf-8"))
                log("init skipped")
                continue
            existing = d1_rows(token, account, database, "SELECT file_id FROM telegram_files WHERE object_key = ? AND kind = ? AND part_index = ? LIMIT 1", [object_key, kind, part_index])
            if not existing:
                sent = send_document("https://api.telegram.org", bot, channel, local, object_key, pace, max_time=90, max_wait=20)
                remember_d1(token, account, database, {
                    "serve": True,
                    "bucket": BUCKET,
                    "key": object_key,
                    "encrypted": False,
                }, {
                    "role": role,
                    "index": part_index,
                    "file_id": sent["file_id"],
                    "message_id": sent["message_id"],
                    "size": int(sent.get("file_size") or local.stat().st_size),
                    "sha256": digest,
                    "mime": "video/mp4",
                    "duration": float(meta.get("duration") or 0),
                }, True, object_key)
            r2_delete(media_key)
            r2_delete(key)
            log("uploaded %s #%s %s %s" % (object_key, part_index, digest[:12], len(blob)))
        except RuntimeError:
            attempts = int(meta.get("attempts") or 0) + 1
            meta["attempts"] = attempts
            if attempts >= 20:
                meta["held"] = True
                dead.add(key)
                log("segment held after %s attempts" % attempts)
            r2_put(key, json.dumps(meta).encode("utf-8"))
            # Move on instead of retrying the same head forever. A bad channel
            # or one rejected file must not stop the rest of the live.
            retry[key] = time.time() + 300
            log("upload failed; trying the next buffered segment")
            time.sleep(2)
        finally:
            shutil.rmtree(local.parent, ignore_errors=True)
    log("upload paused")
    return 0


def rehearse_parallel(count: int = 16) -> bool:
    """Dry run. No streams. Parallel recorders must not share a key."""
    store = {}
    locks = {}
    guard = threading.Lock()
    errors = []

    def lock_for(key: str) -> threading.Lock:
        with guard:
            found = locks.get(key)
            if found is None:
                found = threading.Lock()
                locks[key] = found
            return found

    def put(key: str, blob: bytes) -> None:
        with lock_for(key):
            store[key] = blob

    def merge(handle: str, view: dict) -> None:
        with lock_for(INDEX_KEY):
            current = json.loads(store.get(INDEX_KEY, b'{"items":{}}').decode("utf-8"))
            current.setdefault("items", {})[handle] = view
            store[INDEX_KEY] = json.dumps(current).encode("utf-8")

    def work(index: int) -> None:
        handle = "h%02d" % index
        room = "7699647509498711%03d" % index
        base = key_base(handle, room)
        if not base:
            errors.append("key " + handle)
            return
        body = ("bytes-" + handle).encode("utf-8")
        seg = "%s0/%s/%s/1/seg00000.m4s" % (BUF_PREFIX, handle, room)
        own = (
            job_key(handle),
            ACTIVE_PREFIX + handle + ".json",
            PUBLIC_PREFIX + handle + ".json",
            seg,
        )
        for key in own:
            put(key, body)
        merge(handle, {"state": "recording", "roomId": room, "key": base})
        for key in own:
            if store.get(key) != body or handle.encode("utf-8") not in store.get(key, b""):
                errors.append(key)

    threads = [threading.Thread(target=work, args=(index,)) for index in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    if errors:
        return False
    items = json.loads(store.get(INDEX_KEY, b"{}").decode("utf-8")).get("items") or {}
    owned = [key for key in store if key != INDEX_KEY]
    if len(items) != count or len(owned) != count * 4:
        return False
    for index in range(count):
        handle = "h%02d" % index
        body = ("bytes-" + handle).encode("utf-8")
        room = "7699647509498711%03d" % index
        seg = "%s0/%s/%s/1/seg00000.m4s" % (BUF_PREFIX, handle, room)
        for key in (job_key(handle), ACTIVE_PREFIX + handle + ".json", PUBLIC_PREFIX + handle + ".json", seg):
            if store.get(key) != body:
                return False
        view = items.get(handle) or {}
        if view.get("roomId") != room or view.get("key") != key_base(handle, room):
            return False
        for other in range(count):
            if other == index:
                continue
            foreign = ("h%02d" % other).encode("utf-8")
            if foreign in body:
                return False
    return True


def selftest() -> int:
    failed = 0

    def check(ok: bool, message: str) -> None:
        nonlocal failed
        if not ok:
            failed += 1
            print("FAIL " + message)
        else:
            print("ok " + message)

    numbers = capacity(1)
    check(numbers["recordingJobs"] == 16, "sixteen recording jobs is the cap")
    check(numbers["livesPerChannel"] == 6, "one channel keeps up with six high-bitrate lives")
    check(numbers["messagesPerMinute"] == 20 and numbers["highSegmentsPerMinute"] == 3, "the pace is twenty messages and three segments a minute")
    check(capacity(2)["highLivesKeptUp"] == 12, "two channels keep up with twelve high-bitrate lives")
    saved_cap = os.environ.get("TIKTOK_RECORD_CAP")
    os.environ["TIKTOK_RECORD_CAP"] = "99"
    check(cap_of() == 16, "the cap cannot exceed sixteen")
    if saved_cap is None:
        os.environ.pop("TIKTOK_RECORD_CAP", None)
    else:
        os.environ["TIKTOK_RECORD_CAP"] = saved_cap

    check(segment_seconds(0) == 6, "an unknown bitrate uses a short safe segment")
    check(segment_seconds(8_000_000) == 18, "eight megabits a second is an eighteen second copy")
    check(segment_seconds(40_000_000) >= 2, "a very high bitrate stays at least two seconds")
    check(segment_seconds(1_000_000) == 30, "a low bitrate does not make a segment longer than thirty seconds")

    origin = record_source({"hls": "https://cdn.example/origin.m3u8", "flv": "https://cdn.example/origin.flv", "quality": "origin", "qualityNote": ""})
    check(origin["url"].endswith("origin.flv") and origin["qualityNote"] == "" and origin["kind"] == "flv", "origin FLV is the recording source")
    check(origin["alt"].endswith("origin.m3u8"), "HLS stays as the fallback when FLV is blocked")
    flv = record_source({"hls": "", "flv": "https://cdn.example/origin.flv", "quality": "origion", "qualityNote": ""})
    check(flv["kind"] == "flv" and flv["qualityNote"] == "", "origin FLV is used when HLS is missing")
    hls_only = record_source({"hls": "https://cdn.example/origin.m3u8", "flv": "", "quality": "origin", "qualityNote": ""})
    check(hls_only["kind"] == "hls" and hls_only["url"].endswith("origin.m3u8"), "HLS is used when the room has no FLV")
    hd = record_source({"hls": "https://cdn.example/hd.m3u8", "quality": "hd", "qualityNote": "best available"})
    check(hd["url"].endswith("hd.m3u8") and hd["qualityNote"] == "best available", "a missing origin keeps the best available URL and notes it")
    check("libx264" not in hd["url"], "the recording URL is the one TikTok offered")

    calls = {"n": 0}
    def flaky(room):
        calls["n"] += 1
        if calls["n"] < 3:
            return {}, "503"
        return {"live": True, "quality": "origin"}, ""
    retried = pick_retry("7699647509498710800", picker=flaky, attempts=3, pause=0)
    check(retried[2] == "ok" and retried[0].get("live") is True, "a transient block is retried instead of marking the live blocked")
    stuck = pick_retry("7699647509498710800", picker=lambda room: ({}, "403"), attempts=2, pause=0)
    check(stuck[2] == "hard" and stuck[1] == "403", "a persistently blocked room API still ends as blocked")
    net = pick_retry("7699647509498710800", picker=lambda room: ({}, "0"), attempts=2, pause=0)
    check(net[2] == "network", "a network miss stays out of the blocked state")

    cached_hd = {"url": "https://cdn.example/old-hd.m3u8", "quality": "hd"}
    fresh_origin = {"url": "https://cdn.example/new-origin.m3u8", "quality": "origin"}
    check(prefer_cached(cached_hd, fresh_origin)["quality"] == "origin", "a fresh origin replaces a cached HD URL")
    cached_origin = {"url": "https://cdn.example/old-origin.m3u8", "quality": "origin"}
    fresh_hd = {"url": "https://cdn.example/new-hd.m3u8", "quality": "hd"}
    check(prefer_cached(cached_origin, fresh_hd)["quality"] == "origin", "a cached origin is not replaced by a lower fresh URL")
    check(prefer_cached(cached_hd, {})["url"] == "", "a cached HD URL is not served when nothing fresh arrived")
    check(prefer_cached(cached_origin, {})["quality"] == "origin", "a cached origin is kept when the fresh body is missing")
    check(prefer_cached(cached_origin, fresh_origin)["url"].endswith("new-origin.m3u8"), "a fresh origin URL replaces an older origin URL")

    dest = Path("out")
    args = ffmpeg_args("https://cdn.example/origin.m3u8", dest, 6, 0)
    check(copy_only(args), "ffmpeg stream-copies with one input")
    check(args[args.index("-map") + 1] == "0:v:0" and "0:a:0?" in args and "-sn" in args, "ffmpeg copies video and audio and drops the text stream")
    check(UA in args and "-user_agent" in args, "ffmpeg uses the Chrome user agent")
    check("concurrent" not in " ".join(args) and args.count("-i") == 1, "ffmpeg opens one connection and does not split ranges")
    check(init_ready(b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00moov" + b"\x00" * 16), "a finished init is what gets stored")
    check(not init_ready(b"") and not init_ready(b"\x00" * 64), "an empty init is not stored")
    check(copy_only(split_args(Path("big.m4s"), dest, 2)), "an oversize segment is split with stream copy")
    frame = keyframe_args(Path("seg00000.m4s"), Path("thumb.mp4"))
    check(copy_only(frame), "a card thumbnail is one copied video packet")
    check(frame[frame.index("-frames:v") + 1] == "1" and "-an" in frame, "the thumbnail keeps a single video frame")
    saved_b2 = {name: os.environ.pop(name, None) for name in ("B2_KEY_ID", "B2_APP_KEY", "B2_BUCKET")}
    check(b2_configured() is False, "thumbnail mirror stays off without B2 secrets")
    for name, value in saved_b2.items():
        if value is not None:
            os.environ[name] = value

    now = "2026-10-23T01:00:00Z"
    added = ["b_name", "a_name", "c_name"]
    lives = []
    for index, handle in enumerate(["a_name", "b_name", "c_name", "z_name"]):
        lives.append({
            "handle": handle,
            "live": True,
            "roomId": "769964750949871080%d" % index,
            "startedAt": "2026-10-23T00:%02d:00Z" % index,
            "quality": "origin",
            "qualityNote": "",
            "title": handle,
        })
    # a started a minute before b. The earlier start takes the only slot.
    first = plan(lives[:2], added, {}, now, cap=1, channels=1)
    check(first["dispatch"][0]["handle"] == "a_name", "the earlier live starts first")
    check(first["queued"] == ["b_name"], "a later live waits")
    many = []
    order = []
    for index in range(17):
        handle = "h%02d" % index
        order.append(handle)
        many.append({
            "handle": handle,
            "live": True,
            "roomId": "7699647509498711%03d" % index,
            "startedAt": "2026-10-23T00:10:%02dZ" % index,
            "quality": "origin",
        })
    wide = plan(many, order, {}, now, cap=16, channels=2)
    check(len(wide["dispatch"]) == 16 and wide["queued"] == ["h16"], "the seventeenth live queues and sixteen capture")
    check(all(0 <= job["active"].get("channelSlot", 0) <= 1 for job in wide["jobs"].values() if job.get("active")), "recordings spread across the channels")
    again = plan(many, order, wide["jobs"], "2026-10-23T01:01:00Z", cap=16, channels=2)
    check(not any(item["handle"] == "h00" and item["part"] == 1 for item in again["dispatch"]), "a fresh dispatch is not started twice")

    saved_job = blank_job("b_name")
    saved_job["saved"] = [{"roomId": "7699647509498710801", "key": key_base("b_name", "7699647509498710801"), "parts": 1, "quality": "origin"}]
    skipped = plan([lives[1]], added, {"b_name": saved_job}, now, cap=12, channels=1)
    check(skipped["dispatch"] == [], "a room that is already saved is not recorded again")
    partial_saved = blank_job("b_name")
    partial_saved["saved"] = [{"roomId": "7699647509498710801", "key": key_base("b_name", "7699647509498710801"), "parts": 1, "partial": True, "quality": "hd"}]
    partial_saved["backoffUntil"] = "2026-10-23T02:00:00Z"
    held = plan([lives[1]], added, {"b_name": partial_saved}, now, cap=12, channels=1)
    check(held["dispatch"] == [], "a partial save waits out the backoff")
    resumed = plan([lives[1]], added, {"b_name": partial_saved}, "2026-10-23T02:01:00Z", cap=12, channels=1)
    check(resumed["dispatch"] and resumed["dispatch"][0]["part"] == 2, "a partial save resumes at the next part")
    waiting_job = blank_job("b_name")
    waiting_job["active"] = {
        "state": "recording",
        "roomId": "7699647509498710801",
        "captureDone": True,
        "needsPart": False,
        "capturing": False,
        "segments": 4,
        "part": 1,
    }
    waiting = plan([lives[1]], added, {"b_name": waiting_job}, now, cap=12, channels=1)
    check(waiting["dispatch"] == [], "a finished capture waits for its upload instead of recording again")
    blocked = plan([{
        "handle": "a_name",
        "live": True,
        "roomId": "7699647509498710800",
        "detail": BLOCKED,
        "quality": "hd",
        "qualityNote": "best available",
    }], added, {}, now, cap=12, channels=1)
    check(blocked["dispatch"] == [] and blocked["jobs"]["a_name"]["active"]["state"] == "blocked", "a blocked live is not dispatched")
    view = public_view(blocked["jobs"]["a_name"])
    check(view["blocked"] is True and view["key"] == "" and "channel" not in view, "the public row has no playback key and no channel id while blocked")
    saved_view = public_view(saved_job)
    check(saved_view["state"] == "saved" and saved_view["key"].endswith("/live") and saved_view["quality"] == "origin", "a saved live exposes the Telegram key and the origin quality")
    note_job = blank_job("a_name")
    note_job["saved"] = [{"roomId": "7699647509498710800", "key": key_base("a_name", "7699647509498710800"), "parts": 1, "quality": "hd", "qualityNote": "best available"}]
    check(public_view(note_job)["qualityNote"] == "best available", "a saved fallback notes that origin was missing")

    ended = plan([{
        "handle": "a_name", "live": False, "roomId": "7699647509498710800",
    }], added, {"a_name": {"handle": "a_name", "active": {"state": "queued", "roomId": "7699647509498710800"}, "saved": []}}, now, cap=12, channels=1)
    check(ended["jobs"]["a_name"]["active"] == {}, "a queued live that ended does not stay queued")

    partial = {"handle": "a_name", "active": {"state": "recording", "captureDone": True, "needsPart": False, "capturing": False, "segments": 4, "roomId": "1", "part": 1, "key": key_base("a_name", "7699647509498710800")}, "saved": []}
    check(ready_to_save(partial["active"], 0), "a finished capture with no buffer left can be marked saved")
    check(not ready_to_save(partial["active"], 2), "buffered segments are not dropped before they upload")
    check(not ready_to_save({"state": "recording", "capturing": True, "segments": 3}, 0), "an open capture is not marked saved")

    moment = "2026-10-23T01:00:00Z"
    quiet = {"a_name": {"active": {"state": "recording", "captureDone": True, "segments": 0, "capturing": False}}}
    check(plan_uploads(quiet, {}, 1, moment) == [], "a finished capture with no segments does not start an uploader")
    buffered = {"a_name": {"active": {"state": "recording", "captureDone": True, "segments": 4, "capturing": False}}}
    check(plan_uploads(buffered, {}, 1, moment) == [0], "buffered segments start an uploader")
    live_cap = {"a_name": {"active": {"capturing": True, "segments": 0, "heartbeat": "2026-10-23T00:56:00Z"}}}
    check(plan_uploads(live_cap, {}, 1, moment) == [0], "an open capture with a fresh heartbeat starts an uploader")
    stale_cap = {"a_name": {"active": {"capturing": True, "segments": 0, "heartbeat": "2026-10-23T00:00:00Z"}}}
    check(plan_uploads(stale_cap, {}, 1, moment) == [], "a stale capture does not start an uploader")
    stuck = {"a_name": {"active": {"state": "recording", "segments": 4, "capturing": False, "captureDone": False}}}
    check(plan_uploads(stuck, {}, 1, moment) == [], "a dead row with a segment count does not start an uploader")
    blocked_count = {"a_name": {"active": {"state": "blocked", "segments": 4, "captureDone": True, "capturing": False}}}
    check(plan_uploads(blocked_count, {}, 1, moment) == [], "a blocked row does not start an uploader")
    check(record_decision(True, 0, "error", "blocked") == "backoff", "a blocked pull with no bytes backs off")
    check(record_decision(True, 0, "error", "transient") == "retry", "a transient pull stays in the same job")
    check(record_decision(True, 4, "ended", "transient") == "retry", "a dropped copy that already wrote segments reconnects")
    check(record_decision(True, 4, "deadline", "") == "chain", "the time cap chains the next part")
    check(record_decision(False, 4, "ended", "") == "save", "the end of the live saves what was copied")
    check(record_decision(False, 0, "ended", "") == "drop", "an empty ended live is not saved")
    check(record_decision(True, 1, "handoff", "") == "chain", "a handoff chains the next part after this job stops")
    check(record_decision(True, 1, "chain", "") == "chain", "the next part waits until this job exits")
    check(record_decision(True, 3, "overcap", "") == "save", "a viewer cap keeps the segments already copied")
    check(record_decision(True, 0, "overcap", "") == "drop", "a viewer cap with no bytes does not invent a file")
    from viewer_cap import allow_record, step_cap
    spike = step_cap(None, 40, 20)
    check(spike["paused"] is False and spike["over"] == 1, "one viewer spike does not pause")
    held = step_cap(spike, 40, 20, wanted=True)
    check(held["paused"] is True and held["holdRecord"] is True, "two checks over the cap pause and hold recording")
    back = step_cap(held, 10, 20, wanted=True, auto_restart=False)
    clear = step_cap(back, 10, 20, wanted=True, auto_restart=False)
    check(clear["paused"] is False and allow_record(clear, False, True) is False, "playback can return without restarting the recording")
    resumed = step_cap(held, 10, 20, wanted=True, auto_restart=True)
    resumed = step_cap(resumed, 10, 20, wanted=True, auto_restart=True)
    check(allow_record(resumed, True, True) is True, "auto-restart records again only when the owner opted in")
    check(step_cap(held, 80, "off")["paused"] is False, "off disables the cap")
    check(rehearse_parallel(16), "sixteen recorders keep separate files, state, and the capture index")
    record_yml = (ROOT / ".github/workflows/tiktok-record.yml").read_text(encoding="utf-8")
    upload_yml = (ROOT / ".github/workflows/tiktok-live-upload.yml").read_text(encoding="utf-8")
    check("tiktok-record-${{ inputs.handle }}" in record_yml and "cancel-in-progress: false" in record_yml, "one recorder waits per handle and is not cancelled")
    check("group: tiktok-live-upload\n" in upload_yml and "tiktok-upload-${{" not in upload_yml, "one uploader runs at a time")
    check("timeout-minutes: 20" in upload_yml and "max_time=90" in Path(__file__).read_text(encoding="utf-8"), "a stuck upload releases the runner")
    blob = b"segment-bytes"
    matched = {"sha256": hashlib.sha256(blob).hexdigest(), "size": len(blob)}
    check(piece_matches(blob, matched), "a segment matches its sha256")
    check(not piece_matches(b"other-bytes", matched), "a different segment is rejected")
    listed = past_entries({
        "handle": "a_name",
        "active": {"state": "recording", "captureDone": False, "roomId": "7699647509498710809", "startedAt": "2026-10-27T04:00:00Z", "title": "now", "part": 1, "segments": 2, "key": key_base("a_name", "7699647509498710809"), "viewers": 3},
        "saved": [{"roomId": "7699647509498710800", "key": key_base("a_name", "7699647509498710800"), "parts": 1, "startedAt": "2026-10-27T01:00:00Z", "title": "earlier", "quality": "origin", "viewers": 9}],
    })
    check(len(listed) == 2 and listed[0]["state"] == "recording" and listed[1]["state"] == "saved", "past lives list the open recording before the saved one")
    finished_live = plan([{
        "handle": "a_name", "live": False, "roomId": "7699647509498710800",
    }], added, {"a_name": {"handle": "a_name", "active": {
        "state": "recording", "captureDone": False, "capturing": False, "needsPart": False,
        "segments": 4, "roomId": "7699647509498710800", "part": 1, "parts": 1,
        "key": key_base("a_name", "7699647509498710800"), "startedAt": "2026-10-27T01:00:00Z",
    }, "saved": []}}, now, cap=12, channels=1)
    shelved = finished_live["jobs"]["a_name"]
    check(shelved["active"] == {} and shelved["saved"] and shelved["saved"][0]["key"].endswith("/live"), "a finished capture is saved when the live ends")
    check(listed[0]["viewers"] == 3 and listed[1]["key"].endswith("/live"), "a past live keeps its peak and playback key")

    check(channel_slot("7100000000000000002", 2) == channel_slot("7100000000000000002", 2), "a room stays on the same channel")
    check(channel_ok("-1004242") and not channel_ok("4242"), "a backup channel id is a private -100 id")

    if shutil.which("ffmpeg"):
        folder = Path(tempfile.mkdtemp(prefix="tiktok-copy-"))
        try:
            sample = folder / "sample.mp4"
            made = subprocess.run(
                ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=15:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest", "-c:v", "libx264", "-c:a", "aac", str(sample)],
                capture_output=True, check=False,
            )
            out = folder / "hls"
            out.mkdir(parents=True, exist_ok=True)
            copied = subprocess.run(ffmpeg_args(str(sample), out, 2, 0), capture_output=True, check=False)
            pieces = list(out.glob("seg*.m4s"))
            check(made.returncode == 0 and copied.returncode == 0 and (out / "init.mp4").is_file() and bool(pieces), "a file stream-copies to fMP4 HLS")
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", str(out / "init.mp4")],
                capture_output=True, check=False,
            )
            check(probe.stdout.decode("utf-8", "replace").strip() == "h264", "the copied init keeps the source codec")
        finally:
            shutil.rmtree(folder, ignore_errors=True)
    else:
        check(True, "ffmpeg is not installed here; the copy command was still checked")

    # Always-on host: heartbeat, owner switch and local keep copies.
    beat = {"runner": ALWAYS_ON, "at": "2026-01-01T00:00:00Z"}
    check(runner_fresh(beat, "2026-01-01T00:04:00Z"), "a fresh always-on heartbeat is honoured")
    check(not runner_fresh(beat, "2026-01-01T00:06:00Z"), "a stale heartbeat lets Actions record again")
    check(not runner_fresh({"runner": "other", "at": "2026-01-01T00:00:00Z"}, "2026-01-01T00:01:00Z"), "only the always-on runner counts")
    saved_env = {name: os.environ.get(name) for name in ("TIKTOK_RUNNER", "TIKTOK_KEEP_DIR", "TIKTOK_PART_SECONDS")}
    try:
        os.environ["TIKTOK_RUNNER"] = ALWAYS_ON
        check(yield_to_always_on("recording") is False, "the always-on host never yields to itself")
        os.environ["TIKTOK_PART_SECONDS"] = "60"
        check(env_seconds("TIKTOK_PART_SECONDS", 100, 1800, 3600) == 1800, "the part length cannot go below its floor")
        os.environ["TIKTOK_PART_SECONDS"] = "43200"
        check(env_seconds("TIKTOK_PART_SECONDS", 100, 1800, 172800) == 43200, "an always-on host can run long parts")
        os.environ["TIKTOK_PART_SECONDS"] = "x"
        check(env_seconds("TIKTOK_PART_SECONDS", 100, 1, 200) == 100, "a bad part length falls back to the default")
        check(recording_allowed({}, {"server": True}), "the owner's server switch allows recording")
        check(not recording_allowed({}, {}), "server recording stays opt-in")
        check(recording_allowed({"auto": True}, {}) and recording_allowed({"active": {"manual": True}}, None), "per-account and manual recording are allowed")
        lives = [{"handle": "demo.one"}, {"handle": "demo.two"}, {"handle": "demo.three"}]
        jobs = {"demo.two": {"record": True}, "demo.three": {"active": {"roomId": "7000000000000000003"}}}
        check([row["handle"] for row in gate_lives(lives, jobs, {})] == ["demo.two", "demo.three"], "only allowed or running lives are planned")
        check(len(gate_lives(lives, jobs, {}, True)) == 3, "record-all plans every live")
        os.environ.pop("TIKTOK_KEEP_DIR", None)
        meta = {"handle": "demo.one", "room": "7000000000000000001", "objectKey": "tiktok/demo.one/7000000000000000001/live/1", "keepRun": "0000000000001"}
        check(keep_folder(meta) is None, "nothing is kept when no keep folder is set")
        keep_root = Path(tempfile.mkdtemp(prefix="tiktok-keep-"))
        try:
            os.environ["TIKTOK_KEEP_DIR"] = str(keep_root)
            folder = keep_folder(meta)
            check(folder == keep_root / "demo.one" / "7000000000000000001" / "1" / "0000000000001", "a kept copy goes to handle/room/part/run")
            check(keep_folder(dict(meta, handle="../x")) is None and keep_folder(dict(meta, keepRun="../1")) is None, "keep paths are validated")
            sample = keep_root / "piece.m4s"
            sample.write_bytes(b"demo")
            keep_copy(meta, sample, "seg00001.m4s", True)
            check(not sample.exists() and (folder / "seg00001.m4s").is_file(), "a published segment is moved into the keep folder")
        finally:
            shutil.rmtree(keep_root, ignore_errors=True)
    finally:
        for name, value in saved_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    live_test = Path(__file__).resolve().parents[1] / "docker" / "tiktok-live" / "tiktok_live_selftest.py"
    if live_test.is_file():
        ran = subprocess.run([sys.executable, str(live_test)], capture_output=True, check=False, timeout=600)
        if ran.returncode != 0:
            print(ran.stdout.decode("utf-8", "replace")[-4000:])
        check(ran.returncode == 0, "the always-on recorder package passes its own checks")

    if failed:
        print("%s failed" % failed)
        return 1
    print("tiktok record selftest passed")
    return 0


def cmd_status() -> int:
    """Counts only. No stream URLs, tokens, or channel ids."""
    token, account = cloudflare_env()
    if not token or not account:
        log("Cloudflare credentials are not set; skipping")
        return 0
    doc = load_json_bytes(r2_get("owner/tiktok.json"))
    live = doc.get("live") if isinstance(doc.get("live"), dict) else {}
    live_now = 0
    detected = set()
    for name, item in live.items():
        if not isinstance(item, dict):
            continue
        room = str(item.get("roomId") or "")
        if item.get("live") and room:
            live_now += 1
            detected.add((str(item.get("handle") or name).lower(), room))
    accounts = load_added_accounts()
    recorded = set()
    saved_n = 0
    recording = 0
    blocked = 0
    for key in list_prefix(JOB_PREFIX):
        if not key.endswith(".json"):
            continue
        job = load_json_bytes(r2_get(key))
        handle = str(job.get("handle") or "")
        active = job.get("active") if isinstance(job.get("active"), dict) else {}
        if active.get("roomId"):
            detected.add((handle, str(active.get("roomId"))))
        if str(active.get("state") or "") == "blocked":
            blocked += 1
        if str(active.get("state") or "") == "recording" and not active.get("captureDone"):
            recording += 1
        if int(active.get("segments") or 0) > 0 and active.get("roomId"):
            recorded.add((handle, str(active.get("roomId"))))
        for item in job.get("saved") or []:
            if not isinstance(item, dict) or not item.get("roomId"):
                continue
            pair = (handle, str(item.get("roomId")))
            detected.add(pair)
            recorded.add(pair)
            saved_n += 1
    segments = 0
    inits = 0
    try:
        from telegram_backup import d1_id, d1_rows
        database = d1_id(token, account)
        rows = d1_rows(token, account, database, "SELECT kind, COUNT(*) AS n FROM telegram_files WHERE object_key LIKE ? GROUP BY kind", ["tiktok/%/live/%"])
        for row in rows:
            if row.get("kind") == "segment":
                segments = int(row.get("n") or 0)
            elif row.get("kind") == "init":
                inits = int(row.get("n") or 0)
    except Exception as err:
        log("d1 status unavailable %s" % type(err).__name__)
    log("status accounts %s live_now %s detected %s recorded %s saved %s recording %s blocked %s uploaded_segments %s uploaded_inits %s" % (
        len(accounts.get("added") or []), live_now, len(detected), len(recorded), saved_n, recording, blocked, segments, inits))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if "--selftest" in args:
        return selftest()
    if "--status" in args:
        return cmd_status()
    if "--plan" in args:
        return cmd_plan("--dispatch" in args)
    if "--record" in args:
        handle = ""
        part = "1"
        room = ""
        for index, item in enumerate(args):
            if item == "--handle" and index + 1 < len(args):
                handle = args[index + 1]
            elif item == "--part" and index + 1 < len(args):
                part = args[index + 1]
            elif item == "--room" and index + 1 < len(args):
                room = args[index + 1]
        return cmd_record(handle, part, room)
    if "--upload" in args:
        slot = "0"
        for index, item in enumerate(args):
            if item == "--slot" and index + 1 < len(args):
                slot = args[index + 1]
        return cmd_upload(slot)
    print("usage: tiktok_record.py --selftest | --status | --plan [--dispatch] | --record | --upload")
    return 2


if __name__ == "__main__":
    try:
        from log_redact import auto as _redact_logs

        _redact_logs()
    except ImportError:
        pass
    sys.exit(main())
