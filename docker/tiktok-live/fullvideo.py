#!/usr/bin/env python3
"""Turn a finished live into full-length videos in the Telegram backup channel.

The recorder keeps a local copy of every fMP4 piece it stored (see
``keep_folder`` in scripts/tiktok_record.py). After the live ends, the
pieces of each ffmpeg start are joined by bytes (init + fragments is a
valid MP4), remuxed with ``-c copy`` and joined across restarts and parts.
Nothing is re-encoded. A result over the Telegram limit is cut with
``-c copy`` at keyframes into pieces under the limit.

Two senders:

* MTProto (Telethon) with the same bot token, when TELEGRAM_API_ID and
  TELEGRAM_API_HASH are set: up to 2 GB per file, so most lives are one
  message.
* Bot API sendVideo otherwise: 50 MB per file, so a long live is many
  messages. Still lossless and still in order.

The app's HLS playback does not depend on this: the per-segment copy and
its D1 rows are written by the recorder exactly as before.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

MTPROTO_LIMIT = 1900 * 1024 * 1024
BOT_LIMIT = 48 * 1024 * 1024
SEG_RE = re.compile(r"^seg(\d{5,})\.m4s$")
ROOM_RE = re.compile(r"^[1-9][0-9]{5,24}$")
PART_RE = re.compile(r"^[1-9][0-9]{0,3}$")


def run_dirs(room_dir: Path, skip_parts: set | None = None) -> list:
    """(part, run folder) in recording order. A run needs an init and a fragment."""
    rows = []
    skip = {str(item) for item in (skip_parts or set())}
    if not room_dir.is_dir():
        return rows
    for part in room_dir.iterdir():
        if not part.is_dir() or not PART_RE.fullmatch(part.name) or part.name in skip:
            continue
        for run in part.iterdir():
            if not run.is_dir() or not (run / "init.mp4").is_file():
                continue
            if not any(SEG_RE.match(item.name) for item in run.iterdir()):
                continue
            rows.append((int(part.name), run.name, run))
    rows.sort(key=lambda row: (row[0], row[1]))
    return [(part, run) for part, _name, run in rows]


def pieces(run: Path) -> list:
    found = []
    for item in run.iterdir():
        match = SEG_RE.match(item.name)
        if match:
            found.append((int(match.group(1)), item))
    found.sort()
    return [item for _n, item in found]


def has_gap(room_dir: Path) -> bool:
    return any(room_dir.rglob(".gap"))


def newest_mtime(room_dir: Path) -> float:
    newest = 0.0
    for item in room_dir.rglob("*"):
        try:
            newest = max(newest, item.stat().st_mtime)
        except OSError:
            continue
    return newest


def copy_only(args: list) -> bool:
    """Every ffmpeg call here copies streams. No encoder, no filter on video or audio."""
    joined = " ".join(str(item) for item in args)
    if "-c" not in args or args[args.index("-c") + 1] != "copy":
        return False
    banned = ("-c:v ", "-vcodec", "-acodec", "-crf", "-b:v", "-vf ", "-af ", "-filter", "libx26", "-preset")
    return not any(word in joined for word in banned)


def remux_run_args(dest: Path) -> list:
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "mp4", "-i", "pipe:0",
        "-map", "0", "-c", "copy",
        "-movflags", "+faststart",
        str(dest),
    ]


def concat_args(listing: Path, dest: Path) -> list:
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", str(listing),
        "-map", "0", "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",
        str(dest),
    ]


def split_args(src: Path, pattern: Path, seconds: int) -> list:
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(src),
        "-map", "0", "-c", "copy",
        "-f", "segment", "-segment_time", str(max(2, int(seconds))),
        "-reset_timestamps", "1",
        "-segment_format_options", "movflags=+faststart",
        str(pattern),
    ]


def _run(args: list, timeout: int = 6 * 3600, stdin=None) -> bool:
    if not copy_only(args):
        raise RuntimeError("refusing a command that is not a stream copy")
    try:
        proc = subprocess.run(args, stdin=stdin, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0


def remux_run(run: Path, dest: Path) -> bool:
    """init.mp4 + fragments, piped into ffmpeg so no joined copy lands on disk."""
    args = remux_run_args(dest)
    if not copy_only(args) or shutil.which("ffmpeg") is None:
        return False
    try:
        proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        return False
    ok = True
    try:
        for item in [run / "init.mp4"] + pieces(run):
            with item.open("rb") as handle:
                shutil.copyfileobj(handle, proc.stdin, 1024 * 1024)
    except (OSError, BrokenPipeError):
        ok = False
    finally:
        try:
            proc.stdin.close()
        except (OSError, BrokenPipeError):
            pass
    try:
        code = proc.wait(timeout=6 * 3600)
    except subprocess.TimeoutExpired:
        proc.kill()
        return False
    return ok and code == 0 and dest.is_file() and dest.stat().st_size > 0


def probe(path: Path) -> dict:
    if shutil.which("ffprobe") is None:
        return {}
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", str(path)],
            capture_output=True, timeout=120, check=False,
        )
        doc = json.loads(proc.stdout.decode("utf-8", "replace") or "{}")
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return {}
    out = {"duration": 0.0, "width": 0, "height": 0}
    try:
        out["duration"] = float((doc.get("format") or {}).get("duration") or 0)
    except (TypeError, ValueError):
        pass
    for stream in doc.get("streams") or []:
        if stream.get("codec_type") == "video":
            out["width"] = int(stream.get("width") or 0)
            out["height"] = int(stream.get("height") or 0)
            break
    return out


def split_to_limit(src: Path, work: Path, limit: int) -> list:
    """Cut at keyframes into files under the limit. One file when it already fits."""
    size = src.stat().st_size
    if size <= limit:
        return [src]
    duration = probe(src).get("duration") or 0.0
    if duration <= 0:
        return []
    ratio = 0.9
    for _attempt in range(4):
        seconds = int(duration * (limit / float(size)) * ratio)
        out_dir = work / ("split-%d" % int(ratio * 100))
        shutil.rmtree(out_dir, ignore_errors=True)
        out_dir.mkdir(parents=True, exist_ok=True)
        if not _run(split_args(src, out_dir / "piece%03d.mp4", seconds)):
            return []
        made = sorted(out_dir.glob("piece*.mp4"))
        if made and all(item.stat().st_size <= limit for item in made):
            return made
        ratio *= 0.7
    return []


def build(room_dir: Path, work: Path, limit: int, skip_parts: set | None = None) -> dict:
    """Stitch every kept run into files under ``limit``. Returns files and the parts used."""
    runs = run_dirs(room_dir, skip_parts)
    if not runs:
        return {"files": [], "parts": []}
    work.mkdir(parents=True, exist_ok=True)
    joined = []
    parts = sorted({part for part, _run in runs})
    for number, (_part, run) in enumerate(runs):
        dest = work / ("run%04d.mp4" % number)
        if remux_run(run, dest):
            joined.append(dest)
    if not joined:
        raise RuntimeError("the kept pieces did not join")
    outputs = joined
    if len(joined) > 1:
        listing = work / "concat.txt"
        listing.write_text("".join("file '%s'\n" % str(item).replace("'", "'\\''") for item in joined), encoding="utf-8")
        whole = work / "full.mp4"
        if _run(concat_args(listing, whole)) and whole.is_file() and whole.stat().st_size > 0:
            for item in joined:
                item.unlink(missing_ok=True)
            outputs = [whole]
    files = []
    for item in outputs:
        cut = split_to_limit(item, work / item.stem, limit)
        if not cut:
            raise RuntimeError("the joined video did not split under the limit")
        if cut != [item]:
            item.unlink(missing_ok=True)
        files.extend(cut)
    return {"files": files, "parts": parts}


def thumbnail(src: Path, dest: Path) -> bool:
    """A small JPEG still for the Telegram preview. The video itself is never touched."""
    if shutil.which("ffmpeg") is None:
        return False
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", str(src), "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", str(dest)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0 and dest.is_file() and dest.stat().st_size < 200 * 1024


def fmt_duration(seconds: float) -> str:
    total = int(seconds or 0)
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return "%dh%02dm" % (hours, minutes)
    return "%dm%02ds" % (minutes, secs)


def caption_for(handle: str, info: dict, index: int, count: int, duration: float, partial: bool) -> str:
    title = str(info.get("title") or "").strip()[:200]
    started = str(info.get("startedAt") or "").replace("T", " ")[:16]
    bits = ["@%s LIVE" % handle]
    if started:
        bits.append(started + " UTC")
    if duration:
        bits.append(fmt_duration(duration))
    if count > 1:
        bits.append("%d/%d" % (index, count))
    if partial:
        bits.append("partial")
    text = " · ".join(bits)
    if title:
        text += "\n" + title
    return text[:1000]


def channel_peer(channel: str):
    text = str(channel or "").strip()
    if not re.fullmatch(r"-100\d{4,16}", text):
        raise ValueError("channel id must be a private -100 id")
    from telethon.tl.types import PeerChannel

    return PeerChannel(int(text[4:]))


class MtprotoSender:
    """One bot login per process; the session string stays in memory only."""

    limit = MTPROTO_LIMIT
    name = "mtproto"

    def __init__(self, api_id: int, api_hash: str, bot_token: str):
        self.api_id = int(api_id)
        self.api_hash = api_hash
        self.bot_token = bot_token
        self.session = ""

    def send(self, channel: str, path: Path, caption: str, meta: dict, thumb: Path | None) -> int:
        import asyncio

        return asyncio.run(self._send(channel, path, caption, meta, thumb))

    async def _send(self, channel, path, caption, meta, thumb) -> int:
        from telethon import TelegramClient
        from telethon.sessions import StringSession
        from telethon.tl.types import DocumentAttributeVideo

        client = TelegramClient(StringSession(self.session), self.api_id, self.api_hash)
        await client.start(bot_token=self.bot_token)
        try:
            self.session = client.session.save()
            entity = await client.get_input_entity(channel_peer(channel))
            attrs = [DocumentAttributeVideo(
                duration=int(meta.get("duration") or 0),
                w=int(meta.get("width") or 0),
                h=int(meta.get("height") or 0),
                supports_streaming=True,
            )]
            message = await client.send_file(
                entity, str(path), caption=caption, attributes=attrs,
                supports_streaming=True, thumb=str(thumb) if thumb else None,
                part_size_kb=512, force_document=False,
            )
            return int(getattr(message, "id", 0) or 0)
        finally:
            await client.disconnect()


class BotApiSender:
    """sendVideo through curl; the token goes in a config on stdin, never argv."""

    limit = BOT_LIMIT
    name = "bot-api"

    def __init__(self, bot_token: str, api_base: str = "https://api.telegram.org"):
        self.bot_token = bot_token
        self.api_base = api_base.rstrip("/")

    def send(self, channel: str, path: Path, caption: str, meta: dict, thumb: Path | None) -> int:
        for _attempt in range(6):
            config = 'url = "%s/bot%s/sendVideo"\n' % (self.api_base, self.bot_token)
            args = [
                "curl", "-sS", "--max-time", "900", "-K", "-",
                "-F", "chat_id=" + channel,
                "-F", "supports_streaming=true",
                "-F", "duration=%d" % int(meta.get("duration") or 0),
                "-F", "width=%d" % int(meta.get("width") or 0),
                "-F", "height=%d" % int(meta.get("height") or 0),
            ]
            # The caption is read from a file, so its text is not in argv either.
            cap_file = path.with_suffix(".caption.txt")
            cap_file.write_text(caption, encoding="utf-8")
            args += ["-F", "caption=<" + str(cap_file), "-F", "video=@" + str(path)]
            if thumb:
                args += ["-F", "thumbnail=@" + str(thumb)]
            try:
                proc = subprocess.run(args, input=config.encode("utf-8"), capture_output=True, timeout=960, check=False)
                doc = json.loads(proc.stdout.decode("utf-8", "replace") or "{}")
            except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
                doc = {}
            finally:
                cap_file.unlink(missing_ok=True)
            if doc.get("ok"):
                return int(((doc.get("result") or {}).get("message_id")) or 0)
            retry = int(((doc.get("parameters") or {}).get("retry_after")) or 0)
            if retry:
                time.sleep(min(120, retry + 1))
                continue
            raise RuntimeError("telegram rejected the video (%s)" % int(doc.get("error_code") or 0))
        raise RuntimeError("telegram rate limit did not clear")


def pick_sender(bot_token: str, env: dict | None = None):
    source = os.environ if env is None else env
    raw_id = str(source.get("TELEGRAM_API_ID") or "").strip()
    api_hash = str(source.get("TELEGRAM_API_HASH") or "").strip()
    if raw_id.isdigit() and re.fullmatch(r"[0-9a-f]{32}", api_hash):
        try:
            import telethon  # noqa: F401
            return MtprotoSender(int(raw_id), api_hash, bot_token)
        except ImportError:
            pass
    return BotApiSender(bot_token)


def send_room(room_dir: Path, work: Path, sender, channel: str, handle: str, info: dict, skip_parts: set | None = None) -> dict:
    """Build and send one live. Raises on a failed send so the caller retries later."""
    built = build(room_dir, work, sender.limit, skip_parts)
    files = built["files"]
    if not files:
        return {"messages": [], "parts": built["parts"], "bytes": 0, "files": 0}
    partial = has_gap(room_dir) or bool(info.get("partial"))
    messages = []
    total = 0
    for index, item in enumerate(files, start=1):
        meta = probe(item)
        thumb = work / ("thumb%03d.jpg" % index)
        if not thumbnail(item, thumb):
            thumb = None
        caption = caption_for(handle, info, index, len(files), meta.get("duration") or 0, partial)
        messages.append(sender.send(channel, item, caption, meta, thumb))
        total += item.stat().st_size
        time.sleep(3)
    return {"messages": messages, "parts": built["parts"], "bytes": total, "files": len(files), "partial": partial}
