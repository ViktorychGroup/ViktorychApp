#!/usr/bin/env python3
"""Copy private R2 media to a Telegram channel and make small files loadable.

The job runs in GitHub Actions. It does not need an assistant. When
TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID is missing it prints a skip line
and exits 0. Those values are never printed.

TELEGRAM_API_ID and TELEGRAM_API_HASH are optional. When both are set, a run
that has a non-video file larger than the single-document limit starts the
official telegram-bot-api server in --local mode and uploads that file in
parts of at most 1950 MiB. Those parts are a backup. The Worker cannot play
them, because api.telegram.org getFile only returns files of about 20 MB.

A file of at most 19 MiB (and at most TG_MAX_MB, default 19) is one public
Bot API document. Video and long audio, other than radio, are remuxed to HLS
with ffmpeg. Each segment stays under 19 MiB and is about 4 to 6 seconds.
The Worker plays that playlist. Codecs are copied when ffmpeg can do it.
A synced social video is never re-encoded. If a -c copy segment is still
over 19 MiB, the job retries at 2 seconds, then 1 second, then one segment
per keyframe. If that still cannot fit, the R2 original stays forever and
/tg/<key> streams it.

Music, covers, radio, and every loop version are copied as they already are
and are never deleted from R2. The song AES key is not uploaded. Account
data is uploaded only when TG_BACKUP_KEY is set, and then only as
ciphertext. It is not served and it is not deleted. Live JSON, owner files,
backup internals, and anything that carries a token stay on R2.

TikTok videos, posters, and photo carousels, and other synced social media,
are uploaded too. Videos from TikTok, Instagram, X, YouTube, VK, and Facebook
are the site's original, remuxed to mp4 with yt-dlp and never re-encoded.
Photo posts and carousels come from gallery-dl at full size. A video over
19 MB is split with ffmpeg -c copy. Those copies are deleted from R2 after
the sha256 check when an R2 object exists. A copy that still cannot fit
under 19 MB is kept on R2 and is not deleted. A TikTok 403 or captcha skips
that item. TikTok LIVE is recorded by scripts/tiktok_record.py, not here.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

UA = "viktorych-telegram-backup"
PUBLIC_API = "https://api.telegram.org"
LOCAL_API = "http://127.0.0.1:8081"
MANIFEST_KEY = "backup/telegram-manifest.json"
SMALL_BYTES = 19 * 1024 * 1024
PART_BYTES = 1950 * 1024 * 1024
MAX_NEW_BYTES = 4 * 1024 * 1024 * 1024
MAX_NEW_FILES = 300
LOOP_MAX_FILES = 2000
MIN_INTERVAL = 3.0
REQUIRED = ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID")
SECRET_NAMES = REQUIRED + (
    "TELEGRAM_BOT_TOKENS",
    "TELEGRAM_API_ID",
    "TELEGRAM_API_HASH",
    "TG_BACKUP_KEY",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
)
DATA_KEY = re.compile(
    r"^(?:feeds|stories|people|suggestions|status|feeds\.config)\.json$"
    r"|^data/music\.json$"
    r"|^(?:live|archive|comments|fallback)/[A-Za-z0-9._-]{1,120}\.json$"
    r"|^discord/(?:index|state)\.json$"
    r"|^discord/(?:messages|pins)/\d{1,22}\.json$"
    r"|^data/communities/(?:index|[a-z0-9_]{2,21})\.json$"
    r"|^data/communities/[a-z0-9_]{2,21}/\d{1,20}\.json$"
)
ACCOUNT_PREFIXES = (
    "accounts/",
    "account/",
    "profiles/",
    "profile/",
    "history/",
    "lists/",
    "settings/",
    "sync/",
    "users/",
    "user/",
    "d1/",
)
VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi", ".mpeg", ".mpg"}
AUDIO_EXT = {".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav", ".m4b"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"}
ARCHIVE_EXT = {".pdf", ".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".bin"}
MIME = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".m4v": "video/mp4",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".m4s": "video/iso.segment",
    ".ts": "video/mp2t",
    ".m3u8": "application/vnd.apple.mpegurl",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
}


def scrub(text: str, secrets) -> str:
    out = str(text or "")
    for secret in secrets or []:
        value = str(secret or "")
        if len(value) >= 4:
            out = out.replace(value, "[redacted]")
    return out


class OwnerKeyRejected(RuntimeError):
    """The owner-pasted token was rejected. The message does not include it."""


def owner_token_rejected(token: str, status: int) -> bool:
    try:
        from owner_keys import mark_attention, material, using
    except Exception:
        return False
    if not using("telegram") or material("telegram") != token:
        return False
    code = "unauthorized" if int(status) == 401 else "forbidden"
    mark_attention("telegram", code)
    return code == "unauthorized"


def get_bot_tokens() -> list[str]:
    raw = (os.environ.get("TELEGRAM_BOT_TOKENS") or "").strip()
    owned = ""
    try:
        from owner_keys import blocked, material
        if not blocked("telegram"):
            owned = material("telegram")
    except Exception:
        owned = ""
    tokens: list[str] = []
    if raw:
        for t in re.split(r"[\s,;]+", raw):
            t = t.strip()
            if ":" in t and len(t) >= 20 and "\n" not in t and "\r" not in t:
                if t not in tokens:
                    tokens.append(t)
    single = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if single and ":" in single and len(single) >= 20 and "\n" not in single and "\r" not in single:
        if single not in tokens:
            tokens.append(single)
    if owned and ":" in owned and len(owned) >= 20 and "\n" not in owned and "\r" not in owned:
        tokens = [owned] + [item for item in tokens if item != owned]
    return tokens


def current_secrets() -> list:
    secrets = [os.environ.get(name) or "" for name in SECRET_NAMES]
    for token in get_bot_tokens():
        if token and token not in secrets:
            secrets.append(token)
    return secrets


# Actions logs on a public repository are public. Handles and account ids in
# object keys are replaced with a short keyed hash before a line is printed.
# The hash key is the bot token, so the label cannot be reversed from a list
# of candidate handles, and the same name keeps the same label in one run.
REDACT_RULES = (
    re.compile(r"(tiktok/id/)(\d{5,22})(?=/)"),
    re.compile(r"(tiktok/)(?!id/)([A-Za-z0-9._]{2,24})(?=/)"),
    re.compile(r"(live-buf/\d{1,3}/)([A-Za-z0-9._]{2,24})(?=/)"),
    re.compile(r"((?:media/avatars|media/banners|stories/app|stories/library|highlights|uploads|exports)/)(\d{12})(?=/)"),
)


def redact_label(value: str) -> str:
    salt = (os.environ.get("TELEGRAM_BOT_TOKEN") or "viktorych").encode("utf-8")
    import hmac
    return "~" + hmac.new(salt, str(value).encode("utf-8"), hashlib.sha256).hexdigest()[:8]


def redact_names(text: str) -> str:
    out = str(text or "")
    for rule in REDACT_RULES:
        out = rule.sub(lambda m: m.group(1) + redact_label(m.group(2)), out)
    return out


def log(message: str) -> None:
    print(redact_names(scrub(message, current_secrets())), flush=True)


def parse_shard(arg: str | None = None) -> tuple[int, int] | None:
    raw = (arg or os.environ.get("TG_SHARD") or "").strip()
    if not raw:
        return None
    m = re.match(r"^(\d+)/(\d+)$", raw)
    if not m:
        return None
    k, n = int(m.group(1)), int(m.group(2))
    if n <= 1 or k < 0 or k >= n:
        return None
    return (k, n)


def shard_match(key: str, shard: tuple[int, int] | None) -> bool:
    if not shard:
        return True
    k, n = shard
    h = int(hashlib.md5(key.encode("utf-8")).hexdigest()[:8], 16)
    return (h % n) == k


def next_bot(cf: dict, state: dict) -> str:
    bots = cf.get("bots") or ([cf.get("bot")] if cf.get("bot") else [])
    if not bots:
        return ""
    if len(bots) == 1:
        return bots[0]
    bot_lasts = state.setdefault("bot_lasts", {})
    now = time.time()
    best_bot = bots[0]
    best_wait = gap_seconds(bot_lasts.get(best_bot) or 0, now)
    best_last = float(bot_lasts.get(best_bot) or 0)
    for b in bots[1:]:
        w = gap_seconds(bot_lasts.get(b) or 0, now)
        l = float(bot_lasts.get(b) or 0)
        if w < best_wait or (w == best_wait and l < best_last):
            best_bot = b
            best_wait = w
            best_last = l
    return best_bot


def max_mb() -> float:
    raw = (os.environ.get("TG_MAX_MB") or "").strip()
    if not raw:
        return 19.0
    try:
        value = float(raw)
    except ValueError:
        return 19.0
    if value <= 0:
        return 19.0
    return min(value, 1950.0)


def single_bytes() -> int:
    return int(max_mb() * 1024 * 1024)


def public_bytes() -> int:
    """Largest single document the public getFile method can hand back."""
    return min(single_bytes(), SMALL_BYTES)


def delete_enabled() -> bool:
    raw = (os.environ.get("TG_DELETE_FROM_R2") or "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def backup_key() -> str:
    value = os.environ.get("TG_BACKUP_KEY") or ""
    if len(value.strip()) < 16 or "\n" in value or "\r" in value:
        return ""
    return value


def has_local_credentials() -> bool:
    api_id = (os.environ.get("TELEGRAM_API_ID") or "").strip()
    api_hash = (os.environ.get("TELEGRAM_API_HASH") or "").strip()
    return bool(api_id) and bool(api_hash) and api_id.isdigit() and re.fullmatch(r"[0-9a-fA-F]{16,}", api_hash) is not None


def local_requested() -> bool:
    return (os.environ.get("TELEGRAM_LOCAL") or "").strip() == "1" and has_local_credentials()


def gap_seconds(last: float, now: float, minimum: float = MIN_INTERVAL) -> float:
    if last <= 0:
        return 0.0
    return max(0.0, float(minimum) - (now - last))


def retry_after(status: int, body) -> int | None:
    if not isinstance(body, dict):
        return None
    code = body.get("error_code")
    if status != 429 and code != 429:
        return None
    params = body.get("parameters") if isinstance(body.get("parameters"), dict) else {}
    raw = params.get("retry_after")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = 3
    return max(value, int(MIN_INTERVAL))


def suffix(key: str) -> str:
    name = key.rsplit("/", 1)[-1].lower()
    dot = name.rfind(".")
    if dot < 0:
        return ""
    return name[dot:]


def mime_for(key: str, content_type: str = "") -> str:
    raw = (content_type or "").split(";")[0].strip().lower()
    if raw and raw != "application/octet-stream":
        return raw
    return MIME.get(suffix(key), "application/octet-stream")


def is_video(key: str, content_type: str = "") -> bool:
    if suffix(key) in VIDEO_EXT:
        return True
    return mime_for(key, content_type).startswith("video/")


def is_audio(key: str, content_type: str = "") -> bool:
    if suffix(key) in AUDIO_EXT:
        return True
    return mime_for(key, content_type).startswith("audio/")


def is_media_key(key: str, content_type: str = "") -> bool:
    if suffix(key) in VIDEO_EXT | AUDIO_EXT | IMAGE_EXT | ARCHIVE_EXT:
        return True
    mime = mime_for(key, content_type)
    return mime.startswith("image/") or mime.startswith("video/") or mime.startswith("audio/")


GALLERY_PREFIXES = ("media/avatars/", "media/banners/", "stories/")
# Files people uploaded in the app, referenced from D1 rows. They cannot be
# downloaded again from anywhere else, so they are copied byte for byte and
# never deleted from R2. The Worker reads the Telegram copy when R2 fails.
UPLOAD_PREFIXES = ("post-media/", "srv/", "highlights/", "uploads/")
# Public catalogs copied to Telegram as a dated fallback. The Worker reads
# snap/<key> only after R2 and lastgood/<key> are both unusable.
SNAPSHOT_KEYS = (
    "feeds.json",
    "stories.json",
    "people.json",
    "suggestions.json",
    "data/music.json",
    "data/communities/index.json",
)
SNAPSHOT_BUCKET = "snap"
KEY_URI = re.compile(r'#EXT-X-KEY:[^\n]*URI="([^"]+)"', re.IGNORECASE)


def structural_role(key: str) -> str:
    lowered = str(key or "").lstrip("/")
    if not lowered or ".." in lowered.split("/"):
        return "keep"
    if lowered == MANIFEST_KEY or lowered.startswith("backup/"):
        return "manifest"
    if lowered.startswith("loop/") or lowered.startswith("radio/"):
        return "radio"
    if lowered.startswith("music/") or lowered.startswith("covers/"):
        return "catalog"
    if lowered.startswith("comments/"):
        return "comments"
    if lowered.startswith("owner/") or DATA_KEY.match(lowered):
        return "live"
    if any(lowered.startswith(prefix) for prefix in GALLERY_PREFIXES):
        return "gallery"
    if any(lowered.startswith(prefix) for prefix in UPLOAD_PREFIXES):
        return "upload"
    if any(lowered.startswith(prefix) for prefix in ACCOUNT_PREFIXES):
        return "account"
    return ""


def is_key_material(key: str, blocked=None) -> bool:
    """AES keys, key files, and names that carry a token or a secret."""
    lowered = str(key or "").lstrip("/")
    name = lowered.rsplit("/", 1)[-1].lower()
    if name in {"key.bin", "key"} or name.endswith(".key"):
        return True
    if lowered.startswith("music/") and name.endswith(".bin"):
        return True
    if "token" in name or "secret" in name:
        return True
    if re.search(r"(?:^|/)(?:secrets?|tokens?)(?:/|$)", lowered):
        return True
    if blocked and lowered in blocked:
        return True
    return False


def aes_key_refs(text: str, playlist_key: str) -> set:
    """Object keys named by EXT-X-KEY in one playlist. Those files stay on R2."""
    folder = str(playlist_key or "").lstrip("/").rsplit("/", 1)[0]
    found = set()
    for match in KEY_URI.finditer(text or ""):
        uri = match.group(1).split("?", 1)[0].strip()
        if not uri or ".." in uri.split("/"):
            continue
        if uri.startswith("https://") or uri.startswith("http://"):
            path = urllib.parse.urlparse(uri).path.lstrip("/")
            if path:
                found.add(path)
            continue
        name = uri.split("/")[-1]
        if name:
            found.add(folder + "/" + name if folder else name)
    return found


LOOP_PART = re.compile(
    r"^(loop/(?P<version>[A-Za-z0-9._-]{1,80})(?P<aac>/aac)?)/"
    r"(?P<name>index\.m3u8|init\.mp4|seg_(?P<index>\d{1,6})\.(?:m4s|ts))$"
)


def loop_part(key: str, loop_version: str = "") -> dict | None:
    """A segment of any published radio loop version, or None for other keys.

    loop_version is accepted so callers can pass the pointer from
    loop/current.json. Every version is mirrored, not only that one.
    """
    del loop_version
    match = LOOP_PART.match(str(key or "").lstrip("/"))
    if not match:
        return None
    name = match.group("name")
    group = "loop/" + match.group("version") + (match.group("aac") or "")
    if name == "index.m3u8":
        return {"group": group, "role": "playlist", "index": -2, "mime": "application/vnd.apple.mpegurl", "name": name}
    if name == "init.mp4":
        return {"group": group, "role": "init", "index": -1, "mime": "video/mp4", "name": name}
    mime = "video/mp2t" if name.endswith(".ts") else "video/iso.segment"
    return {"group": group, "role": "segment", "index": int(match.group("index")), "mime": mime, "name": name}


def segment_duration(mapping: dict, name: str) -> float:
    try:
        number = float((mapping or {}).get(Path(str(name or "")).name))
    except (TypeError, ValueError):
        return 10.0
    return number if number > 0 else 10.0


def plan_kind(key: str, size: int, content_type: str, local: bool, loop_version: str = "", blocked=None) -> str:
    """How this object is handled.

    Music, covers, radio, every loop version, and story, avatar, and banner
    media are copied as they are and stay on R2. The song AES key is not
    copied. Live JSON, owner files, and account rows stay off Telegram unless
    account data is encrypted with TG_BACKUP_KEY.
    """
    if is_key_material(key, blocked):
        return "keep-key"
    role = structural_role(key)
    if role == "radio":
        part = loop_part(key, loop_version)
        if part:
            if size <= public_bytes():
                return "loop"
            return "too-big"
        lowered = str(key or "").lstrip("/")
        if lowered == "loop/current.json" or lowered.startswith("loop/"):
            return "keep-radio"
        if size <= 0:
            return "keep-radio"
        if size <= public_bytes() and (is_media_key(key, content_type) or suffix(key) in {".m3u8", ".m4s", ".ts", ".mp4", ".m4a"}):
            return "mirror"
        return "too-big" if size > public_bytes() else "keep-radio"
    if role in {"catalog", "gallery"}:
        if size <= 0 or not (is_media_key(key, content_type) or suffix(key) in {".m3u8", ".m4s", ".ts", ".mp4", ".m4a"}):
            return "keep-other"
        if size <= public_bytes():
            return "mirror"
        return "too-big"
    if role == "upload":
        if size <= 0:
            return "keep-other"
        if size <= public_bytes():
            return "mirror"
        if local and size <= PART_BYTES * 64:
            return "archive"
        return "too-big"
    if role == "comments":
        if size <= 0:
            return "keep-other"
        if size <= public_bytes():
            return "mirror"
        return "too-big"
    if role in {"live", "manifest", "keep"}:
        return "keep-live"
    if role == "account":
        return "account" if backup_key() else "keep-account"
    if not is_media_key(key, content_type) or size <= 0:
        return "keep-other"
    if size <= public_bytes():
        return "small"
    if is_video(key, content_type) or is_audio(key, content_type):
        return "hls"
    if local and size <= PART_BYTES * 64:
        return "archive"
    return "too-big"


def part_spans(size: int, limit: int = PART_BYTES) -> list:
    spans = []
    offset = 0
    while offset < size:
        length = min(limit, size - offset)
        spans.append((offset, length))
        offset += length
    return spans


def empty_manifest() -> dict:
    return {"v": 1, "files": []}


def find_entry(manifest: dict, bucket: str, key: str) -> dict | None:
    for row in manifest.get("files") or []:
        if isinstance(row, dict) and row.get("bucket") == bucket and row.get("key") == key:
            return row
    return None


def file_identity(row: dict) -> tuple:
    return (str(row.get("bucket") or ""), str(row.get("key") or ""))


def merge_part(left: dict, right: dict) -> dict:
    """Keep the copy that Telegram already accepted."""
    if right.get("file_id") and not left.get("file_id"):
        return dict(right)
    if left.get("file_id"):
        return dict(left)
    return dict(right or left)


def merge_entry(left: dict, right: dict) -> dict:
    """Union two manifest rows for the same object. Parts already sent are kept."""
    if not left:
        return dict(right)
    if not right:
        return dict(left)
    parts: dict[tuple, dict] = {}
    for part in list(left.get("parts") or []) + list(right.get("parts") or []):
        if not isinstance(part, dict):
            continue
        ident = (str(part.get("role") or ""), int(part.get("index") or 0))
        parts[ident] = merge_part(parts.get(ident) or {}, part)
    merged = dict(left)
    for key, value in right.items():
        if key == "parts":
            continue
        if merged.get(key) in (None, "", False, 0) and value not in (None, "", False, 0):
            merged[key] = value
    if right.get("verified"):
        merged["verified"] = True
    merged["parts"] = [parts[ident] for ident in sorted(parts)]
    return merged


def merge_manifest(local: dict, remote: dict) -> dict:
    """Keep every file from both copies so a parallel run cannot drop a saved upload."""
    files: dict[tuple, dict] = {}
    order = []
    for row in list((remote or {}).get("files") or []) + list((local or {}).get("files") or []):
        if not isinstance(row, dict) or not row.get("key"):
            continue
        ident = file_identity(row)
        if ident not in files:
            order.append(ident)
            files[ident] = dict(row)
        else:
            files[ident] = merge_entry(files[ident], row)
    out = dict(local or {})
    out["v"] = 1
    out["files"] = [files[ident] for ident in order]
    return out


def manifest_covers(local: dict, remote: dict) -> bool:
    have: dict[tuple, set] = {}
    for row in (remote or {}).get("files") or []:
        if not isinstance(row, dict):
            continue
        ident = file_identity(row)
        known = have.setdefault(ident, set())
        for part in row.get("parts") or []:
            if isinstance(part, dict) and part.get("file_id"):
                known.add((str(part.get("role") or ""), int(part.get("index") or 0), str(part.get("file_id"))))
    for row in (local or {}).get("files") or []:
        if not isinstance(row, dict):
            continue
        known = have.get(file_identity(row)) or set()
        for part in row.get("parts") or []:
            if isinstance(part, dict) and part.get("file_id"):
                ident = (str(part.get("role") or ""), int(part.get("index") or 0), str(part.get("file_id")))
                if ident not in known:
                    return False
    return True


def part_from_saved(row: dict, role: str, index: int, sha: str) -> dict | None:
    """A D1 row is the upload. A different sha256 is a new file and is sent."""
    if not isinstance(row, dict) or not row.get("file_id"):
        return None
    saved = str(row.get("sha256") or "")
    if sha and saved and saved != sha:
        return None
    return {
        "role": role,
        "index": int(index),
        "sha256": saved or sha,
        "size": int(row.get("size") or 0),
        "message_id": int(row.get("message_id") or 0),
        "file_id": str(row.get("file_id")),
        "duration": float(row.get("duration") or 0),
        "mime": str(row.get("mime") or "application/octet-stream"),
        "name": "",
    }


def part_done(entry: dict | None, role: str, index: int) -> dict | None:
    if not entry:
        return None
    for part in entry.get("parts") or []:
        if not isinstance(part, dict):
            continue
        if part.get("role") == role and int(part.get("index") or 0) == int(index) and part.get("file_id"):
            return part
    return None


def upsert_part(entry: dict, part: dict) -> None:
    parts = [row for row in entry.get("parts") or [] if not (row.get("role") == part["role"] and int(row.get("index") or 0) == int(part["index"]))]
    parts.append(part)
    parts.sort(key=lambda row: (str(row.get("role")), int(row.get("index") or 0)))
    entry["parts"] = parts


SOCIAL_PLATFORMS = ("x", "instagram", "threads", "youtube", "vk", "telegram", "rss", "facebook")
ORIGINAL_VIDEO = ("tiktok", "instagram", "threads", "x", "youtube", "vk", "facebook")
ORIGINAL_PHOTO = ORIGINAL_VIDEO + ("threads",)
YTDLP_FORMAT = "bv*+ba/b"
TIKTOK_FALLBACK = "bv*[vcodec^=hev]+ba/bv*[vcodec^=h265]+ba/bv*[vcodec*=bytevc1]+ba/bv*[vcodec^=hvc1]+ba/" + YTDLP_FORMAT
ORIGINAL_CAP = 2 * 1024 * 1024 * 1024
PAGE_HOSTS = (
    "tiktok.com",
    "instagram.com",
    "x.com",
    "twitter.com",
    "youtube.com",
    "youtu.be",
    "vk.com",
    "vk.ru",
    "facebook.com",
    "fb.watch",
    "threads.net",
    "threads.com",
)
FORMAT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
CDN_HOSTS = (
    "pbs.twimg.com",
    "video.twimg.com",
    "i.ytimg.com",
    "ytimg.com",
    "ggpht.com",
    "googleusercontent.com",
    "cdninstagram.com",
    "fbcdn.net",
    "cdnthreads.net",
    "telesco.pe",
    "telegram-cdn.org",
    "userapi.com",
    "vkuser.net",
    "tiktokcdn.com",
    "tiktokcdn-us.com",
    "tiktokcdn-eu.com",
    "tiktokv.com",
    "bytefcdn.com",
    "muscdn.com",
    "ibytedtos.com",
    "ibyteimg.com",
)
CDN_CAP = 200 * 1024 * 1024
IDENT_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
CDN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


def clean_ident(value: str) -> str:
    raw = str(value or "").strip()
    return raw if IDENT_RE.fullmatch(raw) else ""


def stable_ident(post: dict) -> str:
    """Same id rules as shared/social-keys.js."""
    platform = str((post or {}).get("platform") or "").lower()
    status = str((post or {}).get("statusId") or "")
    ident = str((post or {}).get("id") or "")
    if platform == "tiktok":
        match = re.search(r"(\d{8,22})", status or ident)
        return match.group(1) if match else ""
    direct = clean_ident(status)
    if direct:
        return direct
    blob = " ".join(part for part in (str((post or {}).get("url") or ""), status, ident) if part)
    if platform == "facebook":
        match = re.search(r"(?:videos|reel)/(\d{5,20})|[?&]v=(\d{5,20})", blob)
        found = clean_ident(match.group(1) or match.group(2)) if match else ""
        if found:
            return found
    patterns = (
        r"instagram\.com/(?:p|reel|tv)/([A-Za-z0-9_-]{1,80})",
        r"threads\.(?:com|net)/(?:@[^/\s]+/)?(?:post|t)/([A-Za-z0-9_-]{1,80})",
        r"(?:youtube\.com/(?:watch\?v=|shorts/|embed/)|youtu\.be/|youtube-nocookie\.com/embed/)([A-Za-z0-9_-]{6,16})",
        r"video(-?\d+_\d+)",
    )
    for pattern in patterns:
        match = re.search(pattern, blob)
        found = clean_ident(match.group(1)) if match else ""
        if found:
            return found
    bare = ident.split(":", 1)[1] if ":" in ident else ident
    return clean_ident(bare)


def _tiktok_user_id(post: dict) -> str:
    raw = str((post or {}).get("permanentId") or (post or {}).get("userId") or "").strip()
    if re.fullmatch(r"\d{5,22}", raw):
        return raw
    return ""


def _tiktok_handles(post: dict) -> list:
    handles = []
    current = str((post or {}).get("handle") or "").lstrip("@")
    if re.fullmatch(r"[A-Za-z0-9._]{2,24}", current):
        handles.append(current)
    for item in (post or {}).get("previousHandles") or []:
        name = str(item or "").lstrip("@")
        if re.fullmatch(r"[A-Za-z0-9._]{2,24}", name) and name.lower() not in {row.lower() for row in handles}:
            handles.append(name)
    return handles


def _tiktok_suffix(role: str, index: int) -> str:
    if role == "video":
        return "/video"
    if role == "poster":
        return "/poster"
    if role == "photo":
        return "/photo/" + str(index)
    return ""


def social_key_candidates(post: dict, role: str, index: int = 0) -> list:
    """Id key first, then the current handle, then previous handles."""
    platform = str((post or {}).get("platform") or "").lower()
    if platform != "tiktok":
        key = social_object_key(post, role, index)
        return [key] if key else []
    ident = stable_ident(post)
    suffix = _tiktok_suffix(role, max(0, int(index or 0)))
    if re.fullmatch(r"\d{8,22}", ident) is None or not suffix:
        return []
    keys = []
    user_id = _tiktok_user_id(post)
    if user_id:
        keys.append("tiktok/id/" + user_id + "/" + ident + suffix)
    for handle in _tiktok_handles(post):
        keys.append("tiktok/" + handle + "/" + ident + suffix)
    return keys


def existing_social_key(post: dict, role: str, index: int, present) -> str:
    """Keep a file that is already stored. Otherwise use the permanent-id key."""
    found = set(present or ())
    candidates = social_key_candidates(post, role, index)
    for key in candidates:
        if key in found:
            return key
    return candidates[0] if candidates else ""


def social_object_key(post: dict, role: str, index: int = 0) -> str:
    """Same object keys as shared/social-keys.js."""
    platform = str((post or {}).get("platform") or "").lower()
    n = max(0, int(index or 0))
    if platform == "tiktok":
        handle = str((post or {}).get("handle") or "").lstrip("@")
        ident = stable_ident(post)
        if re.fullmatch(r"[A-Za-z0-9._]{2,24}", handle) is None or re.fullmatch(r"\d{8,22}", ident) is None:
            user_id = _tiktok_user_id(post)
            suffix = _tiktok_suffix(role, n)
            if user_id and suffix and re.fullmatch(r"\d{8,22}", ident or ""):
                return "tiktok/id/" + user_id + "/" + ident + suffix
            return ""
        user_id = _tiktok_user_id(post)
        if user_id and role == "video":
            return "tiktok/id/" + user_id + "/" + ident + "/video"
        if user_id and role == "poster":
            return "tiktok/id/" + user_id + "/" + ident + "/poster"
        if user_id and role == "photo":
            return "tiktok/id/" + user_id + "/" + ident + "/photo/" + str(n)
        if role == "video":
            return "tiktok/" + handle + "/" + ident + "/video"
        if role == "poster":
            return "tiktok/" + handle + "/" + ident + "/poster"
        if role == "photo":
            return "tiktok/" + handle + "/" + ident + "/photo/" + str(n)
        return ""
    if platform not in SOCIAL_PLATFORMS:
        return ""
    ident = stable_ident(post)
    if not ident:
        return ""
    if role == "thumb":
        return "social/" + platform + "/" + ident + "/thumb/" + str(n)
    if role == "video":
        return "social/" + platform + "/" + ident + "/video/" + str(n)
    if role == "poster":
        return "social/" + platform + "/" + ident + "/poster/" + str(n)
    if role == "photo":
        return "social/" + platform + "/" + ident + "/photo/" + str(n)
    return ""


def host_ok(url: str) -> bool:
    try:
        host = (urllib.parse.urlparse(str(url or "")).hostname or "").lower()
    except ValueError:
        return False
    if not host:
        return False
    return any(host == suffix or host.endswith("." + suffix) for suffix in CDN_HOSTS)


def page_host_ok(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(str(url or ""))
    except ValueError:
        return False
    if parsed.scheme != "https" or parsed.username or parsed.password:
        return False
    host = (parsed.hostname or "").lower()
    if not host or host_ok(url):
        return False
    query = (parsed.query or "").lower()
    if any(word in query for word in ("cookie", "sessionid", "access_token")):
        return False
    return any(host == suffix or host.endswith("." + suffix) for suffix in PAGE_HOSTS)


def public_page(post: dict) -> str:
    """Public page URL. No CDN host, no cookies, no live room."""
    if live_recording(post):
        return ""
    platform = str((post or {}).get("platform") or "").lower()
    ident = stable_ident(post)
    handle = str((post or {}).get("handle") or "").lstrip("@")
    if platform == "tiktok" and re.fullmatch(r"[A-Za-z0-9._]{2,24}", handle) and re.fullmatch(r"\d{8,22}", ident):
        return "https://www.tiktok.com/@" + handle + "/video/" + ident
    if platform == "youtube" and re.fullmatch(r"[A-Za-z0-9_-]{11}", ident or ""):
        return "https://www.youtube.com/watch?v=" + ident
    raw = str((post or {}).get("url") or "").strip()
    if platform in {"instagram", "x", "vk", "facebook", "threads"} and page_host_ok(raw):
        parsed = urllib.parse.urlparse(raw)
        return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))
    if platform == "instagram" and ident:
        return "https://www.instagram.com/p/" + ident + "/"
    if platform == "x" and ident.isdigit():
        if re.fullmatch(r"[A-Za-z0-9_]{1,30}", handle):
            return "https://x.com/" + handle + "/status/" + ident
        return "https://x.com/i/status/" + ident
    if platform == "vk" and re.fullmatch(r"-?\d+_\d+", ident or ""):
        return "https://vk.com/video" + ident
    if platform == "threads" and ident:
        return "https://www.threads.net/t/" + ident
    raw = str((post or {}).get("url") or "").strip()
    if page_host_ok(raw):
        parsed = urllib.parse.urlparse(raw)
        return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))
    return ""


def catalog_info(post: dict) -> dict:
    stats = post.get("stats") if isinstance(post.get("stats"), dict) else {}

    def num(*keys) -> int:
        for key in keys:
            if key not in stats:
                continue
            try:
                return int(stats.get(key) or 0)
            except (TypeError, ValueError):
                return 0
        return 0

    date = str((post or {}).get("date") or "")
    found = re.match(r"(\d{4})-(\d{2})-(\d{2})", date)
    return {
        "id": stable_ident(post),
        "views": num("views", "view_count"),
        "likes": num("likes", "like_count"),
        "comments": num("replies", "comments", "comment_count"),
        "shares": num("reposts", "shares", "share_count"),
        "upload_date": "".join(found.groups()) if found else "",
    }


def info_fields(raw: dict) -> dict:
    """Counts, date, and id from an info JSON. Download URLs are dropped."""
    if not isinstance(raw, dict):
        return {}

    def num(*keys):
        for key in keys:
            if key not in raw or raw.get(key) is None:
                continue
            try:
                return int(raw.get(key) or 0)
            except (TypeError, ValueError):
                continue
        return None

    out = {}
    ident = str(raw.get("id") or "")
    if ident and IDENT_RE.fullmatch(ident):
        out["id"] = ident
    for dest, keys in (
        ("views", ("view_count", "views")),
        ("likes", ("like_count", "likes")),
        ("comments", ("comment_count", "comments", "reply_count")),
        ("shares", ("repost_count", "share_count", "shares")),
    ):
        value = num(*keys)
        if value is not None:
            out[dest] = value
    upload = str(raw.get("upload_date") or "")
    if re.fullmatch(r"\d{8}", upload):
        out["upload_date"] = upload
    return out


def merge_info(base: dict, extra: dict) -> dict:
    out = dict(base or {})
    for key, value in (extra or {}).items():
        if value not in ("", None):
            out[key] = value
    return out


def runner_blocked(text: str) -> bool:
    low = (text or "").lower()
    if "captcha" in low:
        return True
    if "http error 403" in low or "403 forbidden" in low or "error 403" in low:
        return True
    if "verify you are human" in low or "sign in to confirm" in low:
        return True
    return False


def hevc_name(fmt: dict) -> bool:
    name = str((fmt or {}).get("vcodec") or "").lower()
    return any(marker in name for marker in ("h265", "hevc", "bytevc1", "hvc1", "hev1"))


def format_bitrate(fmt: dict) -> float:
    for key in ("tbr", "vbr", "bitrate"):
        try:
            value = float(fmt.get(key) or 0)
        except (TypeError, ValueError):
            value = 0.0
        if value > 0:
            return value
    return 0.0


def tiktok_selector(formats) -> str:
    """Top h265 or bytevc1, then bv*+ba/b. Format ids come from yt-dlp -J, the same list as -F."""
    videos = []
    audios = []
    for fmt in formats or []:
        if not isinstance(fmt, dict):
            continue
        fid = str(fmt.get("format_id") or "")
        if not FORMAT_ID_RE.fullmatch(fid):
            continue
        vcodec = str(fmt.get("vcodec") or "none")
        acodec = str(fmt.get("acodec") or "none")
        if vcodec not in {"", "none"} and acodec in {"", "none"}:
            videos.append(fmt)
        elif vcodec in {"", "none"} and acodec not in {"", "none"}:
            audios.append(fmt)
    hevc = [fmt for fmt in videos if hevc_name(fmt)]
    pool = hevc or []
    if not pool:
        return TIKTOK_FALLBACK
    pool.sort(key=lambda fmt: (format_bitrate(fmt), int(fmt.get("height") or 0)), reverse=True)
    best = pool[0]
    vid = str(best.get("format_id") or "")
    audios.sort(key=format_bitrate, reverse=True)
    audio = str(audios[0].get("format_id") or "") if audios else ""
    if audio:
        return vid + "+" + audio + "/" + YTDLP_FORMAT
    return vid + "+ba/" + YTDLP_FORMAT


def cdn_fallback_ok(role: str, source_url: str = "") -> bool:
    """A video stays on the yt-dlp remux. A resized photo is not the original."""
    if role == "video":
        return False
    if role == "photo" and "name=" in (source_url or "").lower() and "name=orig" not in (source_url or "").lower():
        return False
    return True


def video_format_arg(platform: str, formats=None) -> str:
    if platform == "tiktok":
        return tiktok_selector(formats or [])
    return YTDLP_FORMAT


def ytdlp_download_args(page: str, dest: Path, selector: str) -> list:
    return [
        "--ignore-config",
        "--no-cookies",
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--retries", "1",
        "--fragment-retries", "1",
        "--concurrent-fragments", "1",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "--socket-timeout", "30",
        "--match-filters", "!is_live",
        "-f", selector,
        "--merge-output-format", "mp4",
        "--remux-video", "mp4",
        "--max-filesize", "2G",
        "--write-info-json",
        "-o", str(dest / "media.%(ext)s"),
        page,
    ]


def gallery_download_args(page: str, dest: Path, ordinal: int) -> list:
    n = max(1, int(ordinal or 1))
    return [
        "--config-ignore",
        "--no-input",
        "-D", str(dest),
        "--range", "%s-%s" % (n, n),
        "--write-metadata",
        "--filename", "{num}.{extension}",
        page,
    ]


def live_recording(post: dict) -> bool:
    if str((post or {}).get("kind") or "").lower() == "live":
        return True
    url = str((post or {}).get("url") or "")
    return str((post or {}).get("platform") or "").lower() == "tiktok" and "/live" in url and "/video/" not in url


def walk_posts(doc: dict) -> list:
    rows = []

    def add(post: dict) -> None:
        if not isinstance(post, dict):
            return
        rows.append(post)
        quoted = post.get("quoted")
        if isinstance(quoted, dict):
            add(quoted)

    for post in (doc or {}).get("posts") or []:
        add(post)
    return rows


def media_candidates(post: dict, media: dict, index: int) -> list:
    del index
    platform = str((post or {}).get("platform") or "").lower()
    kind = str((media or {}).get("type") or "").lower()
    url = str((media or {}).get("url") or "").strip()
    poster = str((media or {}).get("poster") or "").strip()
    rows = []
    if platform == "youtube":
        ident = stable_ident(post)
        if kind in {"photo", "image"} and url:
            rows.append(("photo", url))
        elif re.fullmatch(r"[A-Za-z0-9_-]{11}", ident or ""):
            rows.append(("video", ""))
            if poster:
                rows.append(("thumb", poster))
        elif poster:
            rows.append(("thumb", poster))
        return rows
    if platform == "tiktok":
        if kind in {"photo", "image"} and url:
            rows.append(("photo", url))
        elif url:
            rows.append(("video", url))
        if poster and poster != url:
            rows.append(("poster", poster))
        return rows
    if kind in {"video", "animated_gif"} and url:
        rows.append(("video", url))
    elif kind in {"photo", "image"} and url:
        rows.append(("photo", url))
    if poster and poster != url:
        rows.append(("poster", poster))
    return rows


def plan_social(docs: list, present_keys) -> list:
    """Originals for videos and photos. Posters already on R2 stay with that pass."""
    items = []
    seen = set()
    present = set(present_keys or ())
    for doc in docs or []:
        for post in walk_posts(doc):
            if live_recording(post):
                continue
            platform = str(post.get("platform") or "").lower()
            if platform != "tiktok" and platform not in SOCIAL_PLATFORMS:
                continue
            page = public_page(post)
            info = catalog_info(post)
            photo_ordinal = 0
            for index, media in enumerate(post.get("media") or []):
                if not isinstance(media, dict):
                    continue
                for role, url in media_candidates(post, media, index):
                    key_index = 0 if platform == "tiktok" and role in {"video", "poster"} else index
                    key = existing_social_key(post, role, key_index, present)
                    if not key or key in seen:
                        continue
                    original = (role == "video" and platform in ORIGINAL_VIDEO) or (role == "photo" and platform in ORIGINAL_PHOTO)
                    if key in present and not original:
                        continue
                    source = url if host_ok(url) else ""
                    if not original and not source:
                        continue
                    if original and not page and not source:
                        continue
                    if role == "photo":
                        photo_ordinal += 1
                    seen.add(key)
                    items.append({
                        "bucket": "cdn",
                        "key": key,
                        "size": 0,
                        "etag": "",
                        "content_type": "",
                        "source_url": source,
                        "page_url": page if original else "",
                        "platform": platform,
                        "role": role,
                        "original": original,
                        "photo_ordinal": photo_ordinal if role == "photo" else 0,
                        "info": info,
                        "posted": str((post or {}).get("date") or ""),
                        "uploaded": "",
                    })
    return items


def sniff_type(path: Path, header: str) -> str:
    raw = (header or "").split(";")[0].strip().lower()
    if raw and raw != "application/octet-stream":
        return raw
    try:
        data = path.read_bytes()[:16]
    except OSError:
        data = b""
    if len(data) >= 8 and data[4:8] == b"ftyp":
        return "video/mp4"
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if data.startswith(b"GIF8"):
        return "image/gif"
    if data.startswith(b"RIFF") and b"WEBP" in data:
        return "image/webp"
    return raw or "application/octet-stream"


def fetch_allowed(url: str, dest: Path, limit: int = CDN_CAP):
    """GET an allowlisted CDN URL. No cookies and no extra headers."""
    if not host_ok(url):
        return None
    req = urllib.request.Request(url, headers={"User-Agent": CDN_UA, "Accept": "*/*"})
    digest = hashlib.sha256()
    total = 0
    try:
        with urllib.request.urlopen(req, timeout=60) as res, dest.open("wb") as out:
            if not host_ok(res.geturl()):
                return None
            while True:
                block = res.read(1024 * 1024)
                if not block:
                    break
                total += len(block)
                if total > limit:
                    return None
                out.write(block)
                digest.update(block)
            header = res.headers.get("Content-Type") or ""
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None
    if total <= 0:
        return None
    return {"sha256": digest.hexdigest(), "size": total, "content_type": sniff_type(dest, header)}


def tool_cmd(module: str, binary: str):
    if importlib.util.find_spec(module) is not None:
        return [sys.executable, "-m", module]
    found = shutil.which(binary)
    return [found] if found else None


def run_captured(cmd: list, timeout: int) -> tuple:
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return 1, "", "timeout"
    out = proc.stdout.decode("utf-8", "replace")
    err = proc.stderr.decode("utf-8", "replace")
    return proc.returncode, out, err


def load_info_files(directory: Path) -> dict:
    merged = {}
    for path in directory.rglob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeError):
            continue
        if isinstance(data, dict):
            merged = merge_info(merged, info_fields(data))
    return merged


def file_result(path: Path, header: str, info: dict) -> dict | None:
    if not path.is_file() or path.stat().st_size <= 0:
        return None
    if path.stat().st_size > ORIGINAL_CAP:
        return None
    digest = hash_file(path)
    return {
        "sha256": digest,
        "size": path.stat().st_size,
        "content_type": sniff_type(path, header),
        "info": info,
    }


def fetch_ytdlp(obj: dict, dest: Path, directory: Path):
    page = str(obj.get("page_url") or "")
    if not page_host_ok(page):
        return None
    base = tool_cmd("yt_dlp", "yt-dlp")
    if not base:
        return None
    platform = str(obj.get("platform") or "")
    code, out, err = (0, "", "")
    formats = []
    if platform == "tiktok":
        code, out, err = run_captured(base + [
            "--ignore-config", "--no-cookies", "--no-playlist", "--no-warnings",
            "--skip-download", "-J", page,
        ], 60)
        if runner_blocked(out + "\n" + err):
            return "blocked"
        try:
            parsed = json.loads(out) if out.strip().startswith("{") else {}
        except json.JSONDecodeError:
            parsed = {}
        if isinstance(parsed, dict):
            if parsed.get("is_live") or str(parsed.get("live_status") or "") in {"is_live", "is_upcoming"}:
                return "live"
            formats = parsed.get("formats") or []
    selector = video_format_arg(platform, formats)
    work = directory / "ytdlp"
    if work.exists():
        shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    code, out, err = run_captured(base + ytdlp_download_args(page, work, selector), 300)
    text = out + "\n" + err
    if runner_blocked(text):
        shutil.rmtree(work, ignore_errors=True)
        return "blocked"
    if "does not pass filter" in text.lower() or "live event" in text.lower():
        shutil.rmtree(work, ignore_errors=True)
        return "live"
    saved = [path for path in work.glob("media.mp4") if path.is_file() and path.stat().st_size > 0]
    if not saved:
        saved = [path for path in work.rglob("*.mp4") if path.is_file() and path.stat().st_size > 0 and ".part" not in path.name]
    if not saved:
        shutil.rmtree(work, ignore_errors=True)
        return None
    chosen = max(saved, key=lambda path: path.stat().st_size)
    info = merge_info(obj.get("info") or {}, load_info_files(work))
    if chosen.stat().st_size > ORIGINAL_CAP:
        shutil.rmtree(work, ignore_errors=True)
        return None
    shutil.move(str(chosen), dest)
    shutil.rmtree(work, ignore_errors=True)
    return file_result(dest, "video/mp4", info)


def fetch_gallery(obj: dict, dest: Path, directory: Path):
    page = str(obj.get("page_url") or "")
    if not page_host_ok(page):
        return None
    base = tool_cmd("gallery_dl", "gallery-dl")
    if not base:
        return None
    work = directory / "gallery"
    if work.exists():
        shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    ordinal = int(obj.get("photo_ordinal") or 1)
    code, out, err = run_captured(base + gallery_download_args(page, work, ordinal), 180)
    text = out + "\n" + err
    if runner_blocked(text):
        shutil.rmtree(work, ignore_errors=True)
        return "blocked"
    images = [
        path for path in work.rglob("*")
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".gif"} and path.stat().st_size > 0
    ]
    if not images:
        shutil.rmtree(work, ignore_errors=True)
        return None
    chosen = max(images, key=lambda path: path.stat().st_size)
    info = merge_info(obj.get("info") or {}, load_info_files(work))
    if chosen.stat().st_size > ORIGINAL_CAP:
        shutil.rmtree(work, ignore_errors=True)
        return None
    shutil.move(str(chosen), dest)
    shutil.rmtree(work, ignore_errors=True)
    return file_result(dest, "", info)


def fetch_original(obj: dict, dest: Path, directory: Path):
    role = str(obj.get("role") or "")
    platform = str(obj.get("platform") or "")
    if role == "video" and platform in ORIGINAL_VIDEO:
        return fetch_ytdlp(obj, dest, directory)
    if role == "photo" and platform in ORIGINAL_PHOTO:
        return fetch_gallery(obj, dest, directory)
    return None


def read_json_key(cf: dict, buckets: list, key: str, directory: Path):
    for bucket in buckets:
        dest = directory / ("cat-" + hashlib.sha256((bucket + "/" + key).encode("utf-8")).hexdigest()[:12] + ".json")
        try:
            download_object(cf["token"], cf["account"], bucket, key, dest)
            data = json.loads(dest.read_text(encoding="utf-8"))
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, RuntimeError, ValueError):
            continue
        if isinstance(data, dict):
            return data
    return None


def note_social(state: dict, key: str, files_before: int, bytes_before: int) -> None:
    added_files = int(state.get("files") or 0) - int(files_before)
    added_bytes = int(state.get("bytes") or 0) - int(bytes_before)
    if added_files <= 0 and added_bytes <= 0:
        return
    state["social_files"] = int(state.get("social_files") or 0) + max(added_files, 0)
    state["social_bytes"] = int(state.get("social_bytes") or 0) + max(added_bytes, 0)
    if str(key).startswith("tiktok/"):
        state["tiktok_files"] = int(state.get("tiktok_files") or 0) + max(added_files, 0)
        state["tiktok_bytes"] = int(state.get("tiktok_bytes") or 0) + max(added_bytes, 0)


def may_delete(kind: str, verified: bool, size: int) -> bool:
    if not delete_enabled() or not verified:
        return False
    if kind == "small":
        return size <= public_bytes()
    if kind == "hls":
        return True
    return False


def quote_key(key: str) -> str:
    return urllib.parse.quote(str(key or ""), safe="/")


def cf_json(method: str, url: str, token: str, payload: bytes | None = None, content_type: str | None = None) -> dict:
    headers = {"Authorization": "Bearer " + token, "User-Agent": UA, "Accept": "application/json"}
    if content_type:
        headers["Content-Type"] = content_type
    for attempt in range(4):
        req = urllib.request.Request(url, data=payload, headers=headers, method=method)
        raw = b""
        status = 0
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                raw = res.read()
                status = res.status
        except urllib.error.HTTPError as err:
            raw = err.read()
            status = err.code
        except (urllib.error.URLError, TimeoutError) as err:
            if attempt < 3:
                time.sleep(1.0 * (attempt + 1))
                continue
            raise RuntimeError(f"cloudflare network error: {err}")
        if status in (429, 500, 502, 503, 504) and attempt < 3:
            time.sleep(2.0 * (attempt + 1))
            continue
        if status >= 400:
            raise RuntimeError("cloudflare http " + str(status))
        if not raw:
            return {}
        data = json.loads(raw.decode("utf-8"))
        if isinstance(data, dict) and data.get("success") is False:
            raise RuntimeError("cloudflare request failed")
        return data if isinstance(data, dict) else {}
    raise RuntimeError("cloudflare request timed out")


def bucket_names(token: str, account: str) -> list:
    names = []
    cursor = ""
    seen = set()
    while True:
        query = "?per_page=1000"
        if cursor:
            query += "&cursor=" + urllib.parse.quote(cursor)
        body = cf_json("GET", f"https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets{query}", token)
        result = body.get("result")
        rows = []
        if isinstance(result, list):
            rows = result
        elif isinstance(result, dict):
            rows = result.get("buckets") or []
        for row in rows:
            if isinstance(row, dict) and row.get("name"):
                names.append(str(row["name"]))
            elif isinstance(row, str):
                names.append(row)
        info = body.get("result_info") or {}
        cursor = str(info.get("cursor") or "")
        if not cursor or cursor in seen or str(info.get("is_truncated")).lower() not in {"true", "1"}:
            break
        seen.add(cursor)
    return names


def list_objects(token: str, account: str, bucket: str) -> list:
    found = []
    cursor = ""
    seen = set()
    while True:
        query = "?per_page=1000"
        if cursor:
            query += "&cursor=" + urllib.parse.quote(cursor)
        url = f"https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/{urllib.parse.quote(bucket)}/objects{query}"
        body = cf_json("GET", url, token)
        for row in body.get("result") or []:
            if not isinstance(row, dict) or not row.get("key"):
                continue
            meta = row.get("http_metadata") or {}
            found.append({
                "bucket": bucket,
                "key": str(row.get("key")),
                "size": int(row.get("size") or 0),
                "etag": str(row.get("etag") or "").strip('"'),
                "uploaded": str(row.get("last_modified") or ""),
                "content_type": str(meta.get("contentType") or meta.get("content_type") or ""),
            })
        info = body.get("result_info") or {}
        cursor = str(info.get("cursor") or "")
        truncated = info.get("is_truncated")
        if truncated in (False, None, 0, "0", "false", "False") or not cursor or cursor in seen:
            break
        seen.add(cursor)
        if len(seen) > 100000:
            break
    return found


def download_object(token: str, account: str, bucket: str, key: str, dest: Path) -> str:
    local_src = ROOT / key
    if bucket == "local" or (local_src.is_file() and key.startswith("comments/")):
        if local_src.is_file():
            shutil.copy2(local_src, dest)
            return hash_file(dest)
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/{urllib.parse.quote(bucket)}/objects/{quote_key(key)}"
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token, "User-Agent": UA})
    digest = hashlib.sha256()
    with urllib.request.urlopen(req, timeout=120) as res, dest.open("wb") as out:
        if res.status >= 400:
            raise RuntimeError("download http " + str(res.status))
        while True:
            block = res.read(1024 * 1024)
            if not block:
                break
            out.write(block)
            digest.update(block)
    return digest.hexdigest()


def delete_object(token: str, account: str, bucket: str, key: str) -> None:
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/{urllib.parse.quote(bucket)}/objects/{quote_key(key)}"
    cf_json("DELETE", url, token)


def put_bytes(token: str, account: str, bucket: str, key: str, payload: bytes, content_type: str) -> None:
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/{urllib.parse.quote(bucket)}/objects/{quote_key(key)}"
    cf_json("PUT", url, token, payload, content_type)


def curl_reset(text: str) -> bool:
    raw = text or ""
    return "(35)" in raw or "connection reset by peer" in raw.lower()


def r2_backoff(attempt: int) -> float:
    return float(min(8, 2 ** max(0, attempt)))


def file_id_from_message(result: dict) -> tuple:
    """The file id Telegram put on the message, whichever media field holds it."""
    if not isinstance(result, dict):
        return "", 0
    for key in ("document", "video", "animation", "audio", "voice", "video_note"):
        media = result.get(key) or {}
        if isinstance(media, dict) and media.get("file_id"):
            return str(media["file_id"]), int(media.get("file_size") or 0)
    photos = result.get("photo") or []
    if isinstance(photos, list) and photos:
        last = photos[-1]
        if isinstance(last, dict) and last.get("file_id"):
            return str(last["file_id"]), int(last.get("file_size") or 0)
    return "", 0


def note_from_upload(parsed: dict, size: int) -> dict | None:
    if not isinstance(parsed, dict) or not parsed.get("ok"):
        return None
    result = parsed.get("result") or {}
    if not isinstance(result, dict):
        return None
    file_id, reported = file_id_from_message(result)
    if not file_id:
        return None
    return {
        "message_id": int(result.get("message_id") or 0),
        "file_id": file_id,
        "file_size": reported or size,
        "date": int(result.get("date") or 0),
    }


def object_size(token: str, account: str, bucket: str, key: str) -> int:
    """Bytes already stored at this key, or 0 when the object is missing."""
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/{urllib.parse.quote(bucket)}/objects/{quote_key(key)}"
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token, "User-Agent": UA}, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            if res.status != 200:
                return 0
            return int(res.headers.get("Content-Length") or 0)
    except Exception:
        return 0


def put_object_file(token: str, account: str, bucket: str, key: str, path: Path, content_type: str, run=None, head=None, sleep=None) -> None:
    """Store one original on R2. curl streams the file so a long video is not held in memory.

    A dropped connection is retried against the same key. If the first PUT
    already landed, the retry sees that size and does not write it again.
    """
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/{urllib.parse.quote(bucket)}/objects/{quote_key(key)}"
    if shutil.which("curl") is None and run is None:
        if path.stat().st_size > 80 * 1024 * 1024:
            raise RuntimeError("curl is required to store a large original")
        put_bytes(token, account, bucket, key, path.read_bytes(), content_type or "application/octet-stream")
        return
    pause = sleep or time.sleep
    look = head or (lambda: object_size(token, account, bucket, key))
    command = [
        "curl", "-sS", "--max-time", "3600",
        "-X", "PUT",
        "-H", "Authorization: Bearer " + token,
        "-H", "Content-Type: " + (content_type or "application/octet-stream"),
        "--data-binary", "@" + str(path),
        "-w", "\n%{http_code}",
        url,
    ]
    last = "r2 upload failed"
    for attempt in range(4):
        if attempt and look() == path.stat().st_size:
            return
        proc = run(command) if run else subprocess.run(command, capture_output=True)
        text = proc.stdout.decode("utf-8", "replace") if isinstance(proc.stdout, bytes) else str(proc.stdout or "")
        err = scrub(proc.stderr.decode("utf-8", "replace") if isinstance(proc.stderr, bytes) else str(proc.stderr or ""), current_secrets())
        status = 0
        if "\n" in text:
            _body, _, status_text = text.rpartition("\n")
            try:
                status = int(status_text.strip())
            except ValueError:
                status = 0
        if proc.returncode == 0 and 200 <= status < 300:
            return
        last = err or "r2 upload failed"
        if curl_reset(err) and attempt < 3:
            pause(r2_backoff(attempt))
            continue
        break
    raise RuntimeError(last)


def already_kept(prior: dict | None) -> bool:
    return bool(prior and prior.get("kept") and not prior.get("deleted"))


def remember_kept(src: Path, obj: dict, manifest: dict, cf: dict, state: dict, directory: Path, sha: str) -> bool:
    """Keep the full-quality original on R2. A later run must not delete it."""
    entry = ensure_entry(manifest, obj, "r2", sha, False, False)
    entry["kept"] = False
    entry["deleted"] = False
    entry["serve"] = False
    stored = False
    if str(obj.get("bucket") or "") == "cdn":
        bucket = str(obj.get("r2_bucket") or "")
        key = str(obj.get("r2_key") or "")
        if not bucket or not key:
            bucket = str(cf.get("manifest_bucket") or "")
            key = str(obj.get("key") or "")
            if bucket and key and src.is_file():
                try:
                    put_object_file(cf["token"], cf["account"], bucket, key, src, obj.get("content_type") or "video/mp4")
                except Exception as err:
                    log("[telegram-backup] kept_r2 upload failed %s" % obj.get("key"))
                    log(scrub(str(err), current_secrets()))
                    bucket = ""
        if bucket and key:
            entry["r2_bucket"] = bucket
            entry["r2_key"] = key
            stored = True
    else:
        entry["r2_bucket"] = obj.get("bucket") or ""
        entry["r2_key"] = obj.get("key") or ""
        stored = bool(entry["r2_bucket"] and entry["r2_key"])
    if not stored:
        save_manifest(cf, manifest, directory)
        return False
    entry["kept"] = True
    save_manifest(cf, manifest, directory)
    state["kept_r2"] = int(state.get("kept_r2") or 0) + 1
    log("[telegram-backup] kept_r2 %s/%s count %s" % (entry.get("r2_bucket"), entry.get("r2_key"), state["kept_r2"]))
    return True


def d1_id(token: str, account: str) -> str:
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database?name=viktorych-accounts"
    body = cf_json("GET", url, token)
    result = body.get("result") or []
    if isinstance(result, dict):
        result = [result]
    for row in result:
        if isinstance(row, dict) and (row.get("uuid") or row.get("id")):
            return str(row.get("uuid") or row.get("id"))
    raise RuntimeError("d1 database was not found")


def d1_exec(token: str, account: str, database: str, sql: str, params: list) -> None:
    d1_rows(token, account, database, sql, params)


def d1_rows(token: str, account: str, database: str, sql: str, params: list) -> list:
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}/query"
    payload = json.dumps({"sql": sql, "params": params}).encode("utf-8")
    body = cf_json("POST", url, token, payload, "application/json")
    result = body.get("result") or []
    if isinstance(result, list) and result and isinstance(result[0], dict):
        rows = result[0].get("results") or []
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, dict)]
    return []


D1_CREATE = (
    "CREATE TABLE IF NOT EXISTS telegram_files ("
    "object_key TEXT NOT NULL, kind TEXT NOT NULL, part_index INTEGER NOT NULL, "
    "bucket TEXT NOT NULL DEFAULT '', file_id TEXT NOT NULL, message_id INTEGER NOT NULL DEFAULT 0, "
    "size INTEGER NOT NULL, sha256 TEXT NOT NULL, mime TEXT NOT NULL DEFAULT 'application/octet-stream', "
    "duration REAL NOT NULL DEFAULT 0, serve INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, "
    "encrypted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, "
    "PRIMARY KEY (object_key, kind, part_index))"
)
D1_UPSERT = (
    "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
    "ON CONFLICT(object_key, kind, part_index) DO UPDATE SET "
    "bucket = excluded.bucket, file_id = excluded.file_id, message_id = excluded.message_id, "
    "size = excluded.size, sha256 = excluded.sha256, mime = excluded.mime, duration = excluded.duration, "
    "serve = excluded.serve, verified = excluded.verified, encrypted = excluded.encrypted, updated_at = excluded.updated_at"
)


def worker_api(token: str, account: str) -> str:
    override = (os.environ.get("TG_WORKER_URL") or "").strip().rstrip("/")
    if override:
        return override
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/subdomain"
    body = cf_json("GET", url, token)
    sub = str((body.get("result") or {}).get("subdomain") or "").strip()
    if not sub:
        return ""
    return f"https://viktorych-accounts.{sub}.workers.dev"


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_span(src: Path, dest: Path, offset: int, length: int) -> str:
    digest = hashlib.sha256()
    with src.open("rb") as inp, dest.open("wb") as out:
        inp.seek(offset)
        left = length
        while left:
            block = inp.read(min(1024 * 1024, left))
            if not block:
                break
            out.write(block)
            digest.update(block)
            left -= len(block)
    return digest.hexdigest()


def encrypt_file(src: Path, dest: Path) -> None:
    cmd = [
        "openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", "100000", "-salt",
        "-pass", "env:TG_BACKUP_KEY", "-in", str(src), "-out", str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0 or not dest.is_file():
        raise RuntimeError("encryption failed")


def decrypt_file(src: Path, dest: Path) -> None:
    cmd = [
        "openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "100000", "-salt",
        "-pass", "env:TG_BACKUP_KEY", "-in", str(src), "-out", str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError("decryption failed")


def parse_hls(text: str) -> tuple:
    duration = 0.0
    init = ""
    items = []
    for line in str(text or "").splitlines():
        row = line.strip()
        if row.startswith("#EXT-X-MAP"):
            match = re.search(r'URI="([^"]+)"', row)
            if match:
                init = match.group(1)
        elif row.startswith("#EXTINF:"):
            try:
                duration = float(row.split(":", 1)[1].split(",", 1)[0])
            except ValueError:
                duration = 0.0
        elif row and not row.startswith("#"):
            items.append((row, duration))
            duration = 0.0
    return init, items


def segments_under(directory: Path, names: list, limit: int) -> bool:
    for name in names:
        path = directory / name
        if not path.is_file() or path.stat().st_size >= limit or path.stat().st_size <= 0:
            return False
    return True


def has_video_stream(src: Path) -> bool:
    if shutil.which("ffprobe") is None:
        return True
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(src)],
        capture_output=True,
    )
    return b"video" in proc.stdout


def probe_saved(path: Path) -> dict:
    """Width, height, codec, and bitrate. Empty when ffprobe is missing."""
    if shutil.which("ffprobe") is None or not path.is_file():
        return {}
    proc = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "stream=codec_type,codec_name,width,height,bit_rate:format=bit_rate,duration",
            "-of", "json", str(path),
        ],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return {}
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return {}
    streams = data.get("streams") if isinstance(data, dict) else []
    streams = streams if isinstance(streams, list) else []
    video = next((row for row in streams if isinstance(row, dict) and row.get("codec_type") == "video"), None)
    stream = video or next((row for row in streams if isinstance(row, dict)), {})
    if not isinstance(stream, dict):
        return {}
    codec = str(stream.get("codec_name") or "")
    try:
        width = int(stream.get("width") or 0)
    except (TypeError, ValueError):
        width = 0
    try:
        height = int(stream.get("height") or 0)
    except (TypeError, ValueError):
        height = 0
    bitrate = 0
    container = data.get("format") if isinstance(data, dict) else {}
    for raw in (stream.get("bit_rate"), (container or {}).get("bit_rate") if isinstance(container, dict) else None):
        try:
            value = int(raw or 0)
        except (TypeError, ValueError):
            value = 0
        if value > 0:
            bitrate = value
            break
    if not codec and width <= 0:
        return {}
    duration = 0.0
    if isinstance(container, dict):
        try:
            duration = float(container.get("duration") or 0)
        except (TypeError, ValueError):
            duration = 0.0
    if duration < 0:
        duration = 0.0
    return {"width": width, "height": height, "codec": codec, "bitrate": bitrate, "duration": round(duration, 3)}


def log_probe(key: str, probe: dict) -> None:
    if not probe:
        log("[telegram-backup] probe %s unavailable" % key)
        return
    log("[telegram-backup] probe %s %sx%s %s %s %ss" % (
        key, probe.get("width") or 0, probe.get("height") or 0, probe.get("codec") or "",
        probe.get("bitrate") or 0, probe.get("duration") or 0,
    ))


def social_copy_key(key: str) -> bool:
    """Synced social video is stream-copied. It is never re-encoded."""
    text = str(key or "")
    if re.fullmatch(r"tiktok/(?:id/\d{5,22}/|[A-Za-z0-9._]{2,24}/)\d{8,22}/video", text):
        return True
    if re.fullmatch(r"social/[a-z0-9_]+/[A-Za-z0-9_-]{1,80}/video/\d{1,4}", text):
        return True
    return False


def hls_attempts(copy_only: bool) -> list:
    """(transcode, seconds, keyframes) in the order build_hls tries them.

    keyframes asks ffmpeg -c copy for one segment per GOP. Social video never
    sets transcode.
    """
    if copy_only:
        return [(False, 6, False), (False, 4, False), (False, 2, False), (False, 1, False), (False, 1, True)]
    return [
        (False, 5, False), (False, 4, False), (False, 2, False), (False, 1, False), (False, 1, True),
        (True, 5, False), (True, 4, False), (True, 2, False), (True, 1, False),
    ]


def hls_command(src: Path, dest: Path, seconds: int, transcode: bool, video: bool, keyframes: bool = False) -> list:
    cmd = ["ffmpeg", "-y", "-i", str(src)]
    target = "0.001" if keyframes and not transcode else str(seconds)
    if not video:
        cmd += ["-vn", "-c:a", "aac" if transcode else "copy"]
        cmd += ["-f", "hls", "-hls_time", target, "-hls_playlist_type", "vod", "-hls_segment_filename", str(dest / "seg%05d.ts"), str(dest / "index.m3u8")]
    else:
        if transcode:
            cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-c:a", "aac", "-b:a", "160k"]
        else:
            cmd += ["-c", "copy"]
        cmd += [
            "-f", "hls", "-hls_time", target, "-hls_playlist_type", "vod",
            "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
            "-hls_segment_filename", str(dest / "seg%05d.m4s"), str(dest / "index.m3u8"),
        ]
    return cmd


def ffmpeg_hls(src: Path, dest: Path, seconds: int, transcode: bool, video: bool, keyframes: bool = False) -> None:
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True)
    proc = subprocess.run(hls_command(src, dest, seconds, transcode, video, keyframes), capture_output=True)
    if proc.returncode != 0 or not (dest / "index.m3u8").is_file():
        raise RuntimeError("ffmpeg failed")


def build_hls(src: Path, dest: Path, copy_only: bool = False) -> tuple:
    """Return init name, segment rows, and whether a transcode was required.

    copy_only never re-encodes. It retries a shorter hls_time, then one
    segment per keyframe, and leaves a segment that still cannot fit for the
    caller to keep on R2.
    """
    video = has_video_stream(src)
    last = "ffmpeg failed"
    for transcode, seconds, keyframes in hls_attempts(copy_only):
        try:
            ffmpeg_hls(src, dest, seconds, transcode, video, keyframes)
            text = (dest / "index.m3u8").read_text(encoding="utf-8", errors="replace")
            init, items = parse_hls(text)
            names = []
            if init:
                names.append(Path(init).name)
            names.extend(Path(name).name for name, _duration in items)
            if items and segments_under(dest, names, SMALL_BYTES):
                return init, items, transcode
            last = "a segment was still at least 19 MiB"
        except RuntimeError as err:
            last = str(err)
    raise RuntimeError(last)


def curl_form(api_base: str, token: str, channel: str, path: Path, caption: str, max_time: int = 3600) -> dict:
    url = api_base.rstrip("/") + "/bot" + token + "/sendDocument"
    limit = max(15, min(int(max_time or 3600), 3600))
    cmd = [
        "curl", "-sS", "--max-time", str(limit),
        "-w", "\n%{http_code}",
        "-F", "chat_id=" + channel,
        "-F", "disable_notification=true",
        "-F", "document=@" + str(path) + ";filename=" + path.name,
        "-F", "caption=" + caption[:1024],
        url,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=limit + 15)
    except subprocess.TimeoutExpired:
        raise RuntimeError("telegram upload timed out")
    text = proc.stdout.decode("utf-8", "replace")
    err = scrub(proc.stderr.decode("utf-8", "replace"), current_secrets())
    if "\n" not in text:
        raise RuntimeError(err or "telegram upload failed")
    body, _, status_text = text.rpartition("\n")
    try:
        status = int(status_text.strip())
    except ValueError:
        status = 0
    try:
        parsed = json.loads(body) if body.strip() else {}
    except json.JSONDecodeError:
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    parsed["_status"] = status
    if status == 0 and proc.returncode != 0:
        raise RuntimeError(err or "telegram upload failed")
    return parsed


def bot_method(api_base: str, token: str, method: str, fields: dict) -> dict:
    url = api_base.rstrip("/") + "/bot" + token + "/" + method
    body = json.dumps(fields).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read()
    except Exception:
        return {}
    try:
        parsed = json.loads(raw.decode("utf-8", "replace"))
    except (json.JSONDecodeError, UnicodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def fetch_message_file(api_base: str, token: str, channel: str, message_id: int, caption: str) -> dict:
    """Ask Telegram for the message it already accepted, without sending it again."""
    parsed = bot_method(api_base, token, "editMessageCaption", {
        "chat_id": channel,
        "message_id": int(message_id),
        "caption": caption[:1024],
    })
    result = parsed.get("result") if isinstance(parsed, dict) else None
    return result if isinstance(result, dict) else {}


def send_document(api_base: str, token: str, channel: str, path: Path, caption: str, state: dict, max_time: int = 3600, max_wait: int | None = None) -> dict:
    bot_lasts = state.setdefault("bot_lasts", {})
    for _attempt in range(6):
        wait = gap_seconds(bot_lasts.get(token) or 0, time.time())
        if wait:
            time.sleep(wait)
        parsed = curl_form(api_base, token, channel, path, caption, max_time)
        now = time.time()
        bot_lasts[token] = now
        state["last"] = now
        delay = retry_after(int(parsed.get("_status") or 0), parsed)
        if delay is not None:
            if max_wait is not None and delay > int(max_wait):
                raise RuntimeError("telegram rate limit")
            time.sleep(delay)
            now = time.time()
            bot_lasts[token] = now
            state["last"] = now
            continue
        if not parsed.get("ok"):
            desc = scrub(str(parsed.get("description") or ""), current_secrets())
            code = parsed.get("error_code")
            status = int(code or parsed.get("_status") or 0)
            if status in (401, 403) and owner_token_rejected(token, status):
                raise OwnerKeyRejected("owner key needs attention")
            reason = f" ({code}: {desc})" if (code or desc) else ""
            raise RuntimeError("telegram rejected a document" + reason)
        noted = note_from_upload(parsed, path.stat().st_size)
        if noted:
            return noted
        result = parsed.get("result") if isinstance(parsed.get("result"), dict) else {}
        message_id = int(result.get("message_id") or 0)
        if message_id:
            fetched = fetch_message_file(api_base, token, channel, message_id, caption)
            noted = note_from_upload({"ok": True, "result": fetched}, path.stat().st_size) if fetched else None
            if noted:
                return noted
        raise RuntimeError("telegram returned no file id")
    raise RuntimeError("telegram rate limit did not clear")


def d1_kind(role: str) -> str:
    return {"file": "single", "segment": "segment", "init": "init", "playlist": "playlist", "part": "archive"}.get(role, role)


def remember_d1(token: str, account: str, database: str, entry: dict, part: dict, verified: bool, object_key: str = "") -> None:
    serve = 1 if entry.get("serve") and part["role"] in {"file", "segment", "init"} else 0
    d1_exec(token, account, database, D1_UPSERT, [
        object_key or entry["key"],
        d1_kind(part["role"]),
        int(part["index"]),
        entry["bucket"],
        part["file_id"],
        int(part["message_id"]),
        int(part["size"]),
        part["sha256"],
        part.get("mime") or "application/octet-stream",
        float(part.get("duration") or 0),
        serve,
        1 if verified else 0,
        1 if entry.get("encrypted") else 0,
        int(time.time()),
    ])


WORKER_LIMITED = False


def fetch_worker(url: str, token: str, dest: Path) -> int:
    global WORKER_LIMITED
    if WORKER_LIMITED:
        return 429
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token, "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
            status = res.status
            with dest.open("wb") as out:
                while True:
                    block = res.read(1024 * 1024)
                    if not block:
                        break
                    out.write(block)
            return status
    except urllib.error.HTTPError as err:
        if err.code == 429:
            WORKER_LIMITED = True
            log("[telegram-backup] Cloudflare worker daily request limit reached (429); pausing worker verifications")
        return err.code
    except (urllib.error.URLError, TimeoutError, OSError):
        # A stalled read used to abort the whole extract. The file stays stored
        # and the next run can verify it. This is not a daily-limit pause.
        log("[telegram-backup] worker read stopped")
        return 0


def verify_entry(entry: dict, worker: str, bot: str, directory: Path) -> bool:
    if not worker or not entry.get("serve"):
        return False
    key = quote_key(entry["key"])
    base = worker.rstrip("/") + "/tg/" + key
    if entry.get("kind") == "small":
        part = part_done(entry, "file", 0)
        if not part:
            return False
        dest = directory / "verify.bin"
        status = fetch_worker(base, bot, dest)
        if status != 200 or not dest.is_file():
            return False
        return hash_file(dest) == part["sha256"] and dest.stat().st_size == int(part["size"])
    if entry.get("kind") != "hls":
        return False
    playlist = directory / "playlist.m3u8"
    status = fetch_worker(base + "/index.m3u8", bot, playlist)
    if status != 200 or not playlist.is_file():
        return False
    text = playlist.read_text(encoding="utf-8", errors="replace")
    init = part_done(entry, "init", -1)
    if init:
        if "/init" not in text:
            return False
        dest = directory / "init.bin"
        if fetch_worker(base + "/init", bot, dest) != 200:
            return False
        if hash_file(dest) != init["sha256"] or dest.stat().st_size != int(init["size"]):
            return False
    segments = [part for part in entry.get("parts") or [] if part.get("role") == "segment"]
    if not segments:
        return False
    for part in segments:
        if ("/" + str(int(part["index"]))) not in text:
            return False
        dest = directory / ("seg-%s.bin" % part["index"])
        if fetch_worker(base + "/" + str(int(part["index"])), bot, dest) != 200:
            return False
        if hash_file(dest) != part["sha256"] or dest.stat().st_size != int(part["size"]):
            return False
    return True


def ensure_entry(manifest: dict, obj: dict, kind: str, sha: str, serve: bool, encrypted: bool) -> dict:
    entry = find_entry(manifest, obj["bucket"], obj["key"])
    if entry and entry.get("sha256") and sha and entry.get("sha256") != sha:
        manifest["files"] = [row for row in manifest["files"] if row is not entry]
        entry = None
    if entry is None:
        entry = {
            "bucket": obj["bucket"],
            "key": obj["key"],
            "etag": obj.get("etag") or "",
            "sha256": sha,
            "size": int(obj["size"]),
            "mime": mime_for(obj["key"], obj.get("content_type") or ""),
            "kind": kind,
            "serve": serve,
            "verified": False,
            "encrypted": encrypted,
            "deleted": False,
            "parts": [],
        }
        manifest["files"].append(entry)
    entry["etag"] = obj.get("etag") or entry.get("etag") or ""
    entry["sha256"] = sha or entry.get("sha256") or ""
    entry["size"] = int(obj["size"])
    entry["kind"] = kind
    entry["serve"] = serve
    entry["encrypted"] = encrypted
    return entry


def upload_path(api_base: str, token: str, channel: str, path: Path, caption: str, state: dict, entry: dict, role: str, index: int, sha: str, duration: float, mime: str, cf: dict, d1_key: str = "") -> None:
    existing = part_done(entry, role, index)
    stored_key = d1_key or entry["key"]
    if existing and existing.get("sha256") == sha:
        if cf.get("database"):
            remember_d1(cf["token"], cf["account"], cf["database"], entry, existing, bool(entry.get("verified")), stored_key)
        return
    if cf.get("database"):
        saved = None
        try:
            rows = d1_rows(
                cf["token"], cf["account"], cf["database"],
                "SELECT file_id, message_id, size, sha256, mime, duration FROM telegram_files WHERE object_key = ? AND kind = ? AND part_index = ? LIMIT 1",
                [stored_key, d1_kind(role), int(index)],
            )
            saved = part_from_saved(rows[0], role, index, sha) if rows else None
        except Exception as err:
            log("[telegram-backup] d1 lookup unavailable")
            log(scrub(str(err), current_secrets()))
        if saved:
            upsert_part(entry, saved)
            log("[telegram-backup] already saved %s" % stored_key)
            return
    active_token = next_bot(cf, state) or token
    try:
        sent = send_document(api_base, active_token, channel, path, caption, state)
    except OwnerKeyRejected:
        bots = [item for item in (cf.get("bots") or []) if item != active_token]
        cf["bots"] = bots
        if cf.get("bot") == active_token:
            cf["bot"] = bots[0] if bots else ""
        if not bots:
            raise RuntimeError("telegram rejected the owner key")
        active_token = next_bot(cf, state) or bots[0]
        sent = send_document(api_base, active_token, channel, path, caption, state)
    if int(sent.get("file_size") or 0) != path.stat().st_size:
        raise RuntimeError("telegram reported a different size")
    when = int(sent.get("date") or 0)
    if when > int(state.get("newest") or 0):
        state["newest"] = when
    part = {
        "role": role,
        "index": index,
        "sha256": sha,
        "size": path.stat().st_size,
        "message_id": sent["message_id"],
        "file_id": sent["file_id"],
        "duration": duration,
        "mime": mime,
        "name": path.name,
    }
    upsert_part(entry, part)
    if cf.get("database"):
        remember_d1(cf["token"], cf["account"], cf["database"], entry, part, False, stored_key)
    state["files"] = int(state.get("files") or 0) + 1
    state["bytes"] = int(state.get("bytes") or 0) + path.stat().st_size
    label = str(entry.get("kind") or "other")
    kinds = state.setdefault("kinds", {})
    sizes = state.setdefault("kind_bytes", {})
    kinds[label] = int(kinds.get(label) or 0) + 1
    sizes[label] = int(sizes.get(label) or 0) + path.stat().st_size


def loop_file_cap() -> int:
    raw = (os.environ.get("TG_LOOP_MAX_FILES") or str(LOOP_MAX_FILES)).strip()
    try:
        value = int(raw)
    except ValueError:
        value = LOOP_MAX_FILES
    return min(max(value, 1), 5000)


def loop_rank(key: str, version: str) -> tuple:
    text = str(key or "").lstrip("/")
    current = bool(version) and text.startswith("loop/" + version + "/")
    return (0 if current else 1, text)


def budget_ok(state: dict, size: int) -> bool:
    cap = int(state.get("file_cap") or MAX_NEW_FILES)
    return int(state.get("files") or 0) < cap and int(state.get("bytes") or 0) + size <= MAX_NEW_BYTES


def fetch_manifest(token: str, account: str, bucket: str, directory: Path) -> dict | None:
    """None means the read failed. An empty file list is a real manifest."""
    if not token or not account or not bucket:
        return None
    dest = directory / "merge-manifest.json"
    try:
        download_object(token, account, bucket, MANIFEST_KEY, dest)
        data = json.loads(dest.read_text(encoding="utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, RuntimeError):
        return None
    if isinstance(data, dict) and isinstance(data.get("files"), list):
        return data
    return None


def save_manifest(cf: dict, manifest: dict, directory: Path) -> None:
    bucket = str(cf.get("manifest_bucket") or "")
    token = str(cf.get("token") or "")
    account = str(cf.get("account") or "")
    for attempt in range(4):
        remote = fetch_manifest(token, account, bucket, directory) if bucket else {"v": 1, "files": []}
        if bucket and remote is None and attempt < 3:
            continue
        if remote is not None:
            merged = merge_manifest(manifest, remote)
            manifest["v"] = merged["v"]
            manifest["files"] = merged["files"]
        payload = (json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        path = directory / "telegram-manifest.json"
        path.write_bytes(payload)
        if not bucket:
            return
        put_bytes(token, account, bucket, MANIFEST_KEY, payload, "application/json")
        seen = fetch_manifest(token, account, bucket, directory)
        if seen is not None and manifest_covers(manifest, seen):
            return
    log("[telegram-backup] manifest merge incomplete")


def load_remote_manifest(token: str, account: str, buckets: list, directory: Path) -> tuple:
    target = "viktorych-data" if "viktorych-data" in buckets else (buckets[0] if buckets else "")
    if not target:
        return empty_manifest(), ""
    dest = directory / "remote-manifest.json"
    try:
        download_object(token, account, target, MANIFEST_KEY, dest)
        data = json.loads(dest.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("files"), list):
            return data, target
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, RuntimeError):
        pass
    return empty_manifest(), target


def sort_objects(rows: list, rank=None) -> list:
    def key(row):
        if rank:
            return rank(row)
        return (0, -int(row.get("size") or 0), str(row.get("uploaded") or ""), str(row.get("key") or ""))
    return sorted(rows, key=key)


def collect_blocked_keys(cf: dict, rows: list, directory: Path) -> set:
    """AES key object keys named by music, radio, and loop playlists."""
    blocked = set()
    for obj in rows:
        key = str(obj.get("key") or "").lstrip("/")
        if not key.endswith(".m3u8"):
            continue
        if not (key.startswith("music/") or key.startswith("radio/") or key.startswith("loop/")):
            continue
        dest = directory / ("keys-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:16] + ".m3u8")
        try:
            download_object(cf["token"], cf["account"], obj["bucket"], key, dest)
            blocked.update(aes_key_refs(dest.read_text(encoding="utf-8", errors="replace"), key))
        except (urllib.error.URLError, TimeoutError, OSError, RuntimeError, ValueError):
            continue
    return blocked


def upload_summary(state: dict) -> str:
    kinds = state.get("kinds") or {}
    sizes = state.get("kind_bytes") or {}
    parts = []
    for name in sorted(kinds):
        parts.append("%s %s/%s" % (name, kinds[name], sizes.get(name) or 0))
    detail = (", ".join(parts)) if parts else "none"
    line = "[telegram-backup] uploaded %s files, %s bytes (%s)" % (state.get("files") or 0, state.get("bytes") or 0, detail)
    newest = int(state.get("newest") or 0)
    if newest > 0:
        line += " newest " + time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(newest))
    return line


def log_d1_newest(cf: dict) -> None:
    """Count telegram_files and the newest updated_at. No ids or tokens."""
    database = str((cf or {}).get("database") or "")
    if not database:
        return
    try:
        url = "https://api.cloudflare.com/client/v4/accounts/%s/d1/database/%s/query" % (cf["account"], database)
        payload = json.dumps({
            "sql": "SELECT COUNT(*) AS n, MAX(updated_at) AS newest FROM telegram_files",
            "params": [],
        }).encode("utf-8")
        body = cf_json("POST", url, cf["token"], payload, "application/json")
    except Exception as err:
        log("[telegram-backup] d1 count unavailable")
        log(scrub(str(err), current_secrets()))
        return
    result = body.get("result") or []
    row = {}
    if isinstance(result, list) and result and isinstance(result[0], dict):
        rows = result[0].get("results") or []
        if isinstance(rows, list) and rows and isinstance(rows[0], dict):
            row = rows[0]
    newest = int(row.get("newest") or 0)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(newest)) if newest > 0 else "none"
    log("[telegram-backup] d1 files %s newest %s" % (int(row.get("n") or 0), stamp))


def needs_local(objects: list) -> bool:
    if not has_local_credentials():
        return False
    for obj in objects:
        kind = plan_kind(obj["key"], int(obj["size"]), obj.get("content_type") or "", True)
        if kind == "archive":
            return True
    return False


def missing_required() -> bool:
    has_tokens = bool(get_bot_tokens()) or bool((os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip())
    has_channel = bool((os.environ.get("TELEGRAM_CHANNEL_ID") or "").strip())
    return not (has_tokens and has_channel)


def validate_channel() -> bool:
    channel = (os.environ.get("TELEGRAM_CHANNEL_ID") or "").strip()
    tokens = get_bot_tokens()
    token = tokens[0] if tokens else (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if "\n" in channel or "\r" in token or "\n" in token or "\r" in channel:
        return False
    if re.fullmatch(r"-?\d{5,30}", channel) is None:
        return False
    return ":" in token and len(token) >= 20


def prepare_clients() -> dict | None:
    if missing_required():
        log("[telegram-backup] TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID is not set; skipping the upload")
        return None
    if not validate_channel():
        log("[telegram-backup] TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID is not usable")
        return {"error": True}
    token = (os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()
    account = (os.environ.get("CLOUDFLARE_ACCOUNT_ID") or "").strip()
    if not token or not account:
        log("[telegram-backup] CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID is not set; skipping the upload")
        return None
    return {"token": token, "account": account}


def collect_objects(cf: dict) -> list:
    buckets = bucket_names(cf["token"], cf["account"]) if cf.get("token") and cf.get("account") else []
    rows = []
    for bucket in buckets:
        rows.extend(list_objects(cf["token"], cf["account"], bucket))
    comments_dir = ROOT / "comments"
    if comments_dir.is_dir():
        for path in comments_dir.glob("*.json"):
            if path.name == "lookup.json" or not path.is_file():
                continue
            key = f"comments/{path.name}"
            if not any(r.get("key") == key for r in rows):
                rows.append({
                    "bucket": cf.get("manifest_bucket") or (buckets[0] if buckets else "local"),
                    "key": key,
                    "size": path.stat().st_size,
                    "content_type": "application/json",
                    "etag": "",
                    "uploaded": "",
                    "local_path": str(path),
                })
    return rows


def read_loop_version(token: str, account: str, buckets: list, directory: Path) -> str:
    """The version loop/current.json is publishing. Empty when it cannot be read."""
    for bucket in buckets:
        dest = directory / "loop-current.json"
        try:
            download_object(token, account, bucket, "loop/current.json", dest)
            data = json.loads(dest.read_text(encoding="utf-8"))
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, RuntimeError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        version = str(data.get("version") or "")
        if re.fullmatch(r"[A-Za-z0-9._-]{1,80}", version):
            return version
    return ""


def loop_duration_map(cf: dict, bucket: str, group: str, directory: Path) -> dict:
    cache = cf.setdefault("loop_duration_maps", {})
    if group in cache:
        return cache[group]
    mapping = {}
    dest = directory / ("loop-dur-" + hashlib.sha256(group.encode("utf-8")).hexdigest()[:16] + ".m3u8")
    try:
        download_object(cf["token"], cf["account"], bucket, group + "/index.m3u8", dest)
        _init, items = parse_hls(dest.read_text(encoding="utf-8", errors="replace"))
        for name, duration in items:
            mapping[Path(name).name] = float(duration) if duration and duration > 0 else 10.0
    except (urllib.error.URLError, TimeoutError, OSError, RuntimeError, ValueError):
        mapping = {}
    cache[group] = mapping
    return mapping


def preflight() -> int:
    cf = prepare_clients()
    if cf is None:
        _output("work", "false")
        _output("local", "false")
        return 0
    if cf.get("error"):
        return 1
    directory = Path(tempfile.mkdtemp(prefix="tg-preflight-"))
    try:
        rows = collect_objects(cf)
        version = read_loop_version(cf["token"], cf["account"], bucket_names(cf["token"], cf["account"]), directory)
    except Exception as err:
        log("[telegram-backup] could not list R2")
        log(scrub(str(err), current_secrets()))
        return 1
    finally:
        shutil.rmtree(directory, ignore_errors=True)
    local = needs_local(rows)
    work = False
    for obj in rows:
        kind = plan_kind(obj["key"], int(obj["size"]), obj.get("content_type") or "", local, version)
        if kind in {"small", "hls", "archive", "account", "loop", "mirror"}:
            work = True
            break
    _output("work", "true" if work else "false")
    _output("local", "true" if local and work else "false")
    if not work:
        log("[telegram-backup] nothing to upload")
    elif local:
        log("[telegram-backup] a non-video file needs the local Bot API server")
    return 0


def _output(name: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT") or ""
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(name + "=" + value + "\n")


def new_entry_state() -> dict:
    return {"last": 0.0, "files": 0, "bytes": 0}


def finish_verified(entry: dict, obj: dict, manifest: dict, cf: dict, directory: Path) -> None:
    if not (entry.get("serve") and entry.get("kind") in {"small", "hls"} and cf.get("worker")):
        return
    if not verify_entry(entry, cf["worker"], cf["bot"], directory):
        log("[telegram-backup] not verified %s/%s" % (obj["bucket"], obj["key"]))
        return
    entry["verified"] = True
    for part in entry.get("parts") or []:
        if cf.get("database"):
            remember_d1(cf["token"], cf["account"], cf["database"], entry, part, True)
    save_manifest(cf, manifest, directory)
    if obj.get("bucket") == "cdn":
        if obj.get("r2_bucket") and obj.get("r2_key") and may_delete(entry.get("kind") or "", True, int(entry.get("size") or 0)):
            delete_object(cf["token"], cf["account"], obj["r2_bucket"], obj["r2_key"])
            entry["deleted"] = True
            save_manifest(cf, manifest, directory)
            log("[telegram-backup] deleted %s/%s" % (obj["r2_bucket"], obj["r2_key"]))
        return
    if may_delete(entry.get("kind") or "", True, int(entry.get("size") or 0)):
        delete_object(cf["token"], cf["account"], obj["bucket"], obj["key"])
        entry["deleted"] = True
        save_manifest(cf, manifest, directory)
        log("[telegram-backup] deleted %s/%s" % (obj["bucket"], obj["key"]))


def store_loaded(src: Path, obj: dict, kind: str, manifest: dict, cf: dict, state: dict, directory: Path, sha: str, copy_only: bool = False) -> str:
    entry = ensure_entry(manifest, obj, kind, sha, True, False)
    if obj.get("info"):
        entry["info"] = obj["info"]
    if obj.get("probe"):
        entry["probe"] = obj["probe"]
    files_before = int(state.get("files") or 0)
    bytes_before = int(state.get("bytes") or 0)
    if kind == "small":
        if not budget_ok(state, src.stat().st_size):
            return "stop"
        upload_path(PUBLIC_API, cf["bot"], cf["channel"], src, obj["key"][:900], state, entry, "file", 0, sha, 0, entry["mime"], cf)
    else:
        hls_dir = directory / "hls"
        try:
            init, items, transcoded = build_hls(src, hls_dir, copy_only=copy_only)
        except RuntimeError:
            shutil.rmtree(hls_dir, ignore_errors=True)
            if copy_only:
                remember_kept(src, obj, manifest, cf, state, directory, sha)
                log("[telegram-backup] skipped_hls %s/%s (not re-encoded)" % (obj["bucket"], obj["key"]))
                return "oversize"
            log("[telegram-backup] skipped_hls %s/%s" % (obj["bucket"], obj["key"]))
            return "skip"
        if transcoded:
            log("[telegram-backup] transcoded %s/%s so every segment stays under 19 MiB" % (obj["bucket"], obj["key"]))
        queue = []
        if init:
            queue.append((-1, "init", hls_dir / Path(init).name, "video/mp4", 0))
        for index, (name, duration) in enumerate(items):
            path = hls_dir / Path(name).name
            mime = "video/mp2t" if path.suffix == ".ts" else "video/iso.segment"
            queue.append((index, "segment", path, mime, duration))
        queue.append((-2, "playlist", hls_dir / "index.m3u8", "application/vnd.apple.mpegurl", 0))
        for index, role, path, mime, duration in queue:
            if not budget_ok(state, path.stat().st_size):
                save_manifest(cf, manifest, directory)
                shutil.rmtree(hls_dir, ignore_errors=True)
                return "stop"
            digest = hash_file(path)
            upload_path(PUBLIC_API, cf["bot"], cf["channel"], path, "%s %s %s" % (obj["key"][:800], role, index), state, entry, role, index, digest, duration, mime, cf)
        shutil.rmtree(hls_dir, ignore_errors=True)
    save_manifest(cf, manifest, directory)
    finish_verified(entry, obj, manifest, cf, directory)
    if obj.get("bucket") == "cdn":
        note_social(state, obj["key"], files_before, bytes_before)
    log("[telegram-backup] stored %s/%s (%s)" % (obj["bucket"], obj["key"], kind))
    return "ok"


def process_cdn(obj: dict, manifest: dict, cf: dict, state: dict, directory: Path) -> str:
    prior = find_entry(manifest, obj["bucket"], obj["key"])
    if already_kept(prior):
        return "skip"
    if prior and prior.get("verified") and (prior.get("parts") or []):
        if obj.get("r2_bucket") and obj.get("r2_key") and not prior.get("deleted") and may_delete(prior.get("kind") or "", True, int(prior.get("size") or 0)):
            delete_object(cf["token"], cf["account"], obj["r2_bucket"], obj["r2_key"])
            prior["deleted"] = True
            save_manifest(cf, manifest, directory)
            log("[telegram-backup] deleted %s/%s" % (obj["r2_bucket"], obj["r2_key"]))
        return "skip"
    src = directory / "cdn.bin"
    src.unlink(missing_ok=True)
    fetched = None
    role = str(obj.get("role") or "")
    if obj.get("original"):
        outcome = fetch_original(obj, src, directory)
        if outcome == "live":
            src.unlink(missing_ok=True)
            log("[telegram-backup] skipped_live %s" % obj["key"])
            return "blocked"
        if outcome == "blocked" and role == "video":
            src.unlink(missing_ok=True)
            log("[telegram-backup] skipped_blocked %s" % obj["key"])
            return "blocked"
        if isinstance(outcome, dict):
            fetched = outcome
            if outcome.get("info"):
                obj["info"] = outcome["info"]
        elif outcome == "blocked":
            src.unlink(missing_ok=True)
            log("[telegram-backup] page_blocked %s" % obj["key"])
        else:
            log("[telegram-backup] original_unavailable %s" % obj["key"])
    if not fetched and cdn_fallback_ok(role, str(obj.get("source_url") or "")):
        fetched = fetch_allowed(str(obj.get("source_url") or ""), src)
    if not fetched:
        src.unlink(missing_ok=True)
        if role != "video":
            log("[telegram-backup] skipped_cdn %s" % obj["key"])
        return "skip"
    obj["size"] = int(fetched["size"])
    obj["content_type"] = fetched["content_type"]
    obj["etag"] = fetched["sha256"]
    probe = probe_saved(src)
    obj["probe"] = probe
    log_probe(obj["key"], probe)
    kind = plan_kind(obj["key"], obj["size"], obj["content_type"], False)
    if obj.get("role") == "video" and kind == "keep-other":
        obj["content_type"] = "video/mp4"
        kind = plan_kind(obj["key"], obj["size"], obj["content_type"], False)
    if kind not in {"small", "hls"}:
        src.unlink(missing_ok=True)
        log("[telegram-backup] skipped_too_big cdn/%s %s" % (obj["key"], obj["size"]))
        return "skip"
    copy_only = obj.get("role") == "video"
    try:
        return store_loaded(src, obj, kind, manifest, cf, state, directory, fetched["sha256"], copy_only=copy_only)
    finally:
        src.unlink(missing_ok=True)


def social_catalogs(cf: dict, directory: Path, buckets: list) -> list:
    docs = []
    for key in ("owner/tiktok.json", "feeds.json"):
        doc = read_json_key(cf, buckets, key, directory)
        if doc is None and key == "owner/tiktok.json":
            local = ROOT / "owner" / "tiktok.json"
            if local.is_file():
                try:
                    doc = json.loads(local.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    doc = None
        if doc is None and key == "feeds.json":
            local = ROOT / "feeds.json"
            if local.is_file():
                try:
                    doc = json.loads(local.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    doc = None
        if isinstance(doc, dict):
            docs.append(doc)
    return docs


def process(obj: dict, manifest: dict, cf: dict, state: dict, directory: Path) -> str:
    local = local_requested()
    kind = plan_kind(obj["key"], int(obj["size"]), obj.get("content_type") or "", local, cf.get("loop_version") or "", cf.get("blocked_keys"))
    if kind == "too-big":
        log("[telegram-backup] skipped_too_big %s/%s %s" % (obj["bucket"], obj["key"], obj["size"]))
        return "skip"
    if not kind.startswith(("small", "hls", "archive", "account", "loop", "mirror")):
        return "skip"
    prior = find_entry(manifest, obj["bucket"], obj["key"])
    if already_kept(prior):
        return "skip"
    if prior and prior.get("etag") and prior.get("etag") == obj.get("etag") and prior.get("sha256"):
        if kind == "loop":
            part = loop_part(obj["key"], cf.get("loop_version") or "")
            done = part_done(prior, part["role"], part["index"]) if part else None
            if done and done.get("sha256") == prior.get("sha256"):
                if cf.get("database"):
                    remember_d1(cf["token"], cf["account"], cf["database"], prior, done, bool(prior.get("verified")), part["group"])
                return "skip"
        elif kind == "mirror":
            done = part_done(prior, "file", 0)
            if done and done.get("sha256") == prior.get("sha256"):
                if cf.get("database"):
                    remember_d1(cf["token"], cf["account"], cf["database"], prior, done, bool(prior.get("verified")))
                return "skip"
        elif prior.get("verified"):
            if may_delete(prior.get("kind") or "", True, int(prior.get("size") or 0)) and not prior.get("deleted"):
                delete_object(cf["token"], cf["account"], obj["bucket"], obj["key"])
                prior["deleted"] = True
                save_manifest(cf, manifest, directory)
                log("[telegram-backup] deleted %s/%s" % (obj["bucket"], obj["key"]))
            return "skip"
    src = directory / "object.bin"
    sha = download_object(cf["token"], cf["account"], obj["bucket"], obj["key"], src)
    if kind == "account":
        cipher = directory / "object.enc"
        encrypt_file(src, cipher)
        src.unlink(missing_ok=True)
        if cipher.stat().st_size > public_bytes():
            cipher.unlink(missing_ok=True)
            log("[telegram-backup] skipped_too_big %s/%s %s" % (obj["bucket"], obj["key"], obj["size"]))
            return "skip"
        entry = ensure_entry(manifest, obj, "account", sha, False, True)
        digest = hash_file(cipher)
        try:
            if not budget_ok(state, cipher.stat().st_size):
                return "stop"
            upload_path(PUBLIC_API, cf["bot"], cf["channel"], cipher, obj["key"][:900], state, entry, "file", 0, digest, 0, "application/octet-stream", cf)
            save_manifest(cf, manifest, directory)
            log("[telegram-backup] stored %s/%s (account)" % (obj["bucket"], obj["key"]))
            return "ok"
        finally:
            cipher.unlink(missing_ok=True)
    if kind == "loop":
        part = loop_part(obj["key"], cf.get("loop_version") or "")
        if not part:
            src.unlink(missing_ok=True)
            return "skip"
        entry = ensure_entry(manifest, obj, "loop", sha, True, False)
        entry["group"] = part["group"]
        duration = 0.0
        if part["role"] == "segment":
            duration = segment_duration(loop_duration_map(cf, obj["bucket"], part["group"], directory), part["name"])
        if not budget_ok(state, src.stat().st_size):
            save_manifest(cf, manifest, directory)
            return "stop"
        if part["role"] == "segment":
            state["loop_segments"] = int(state.get("loop_segments") or 0) + 1
            state["loop_max"] = max(int(state.get("loop_max") or 0), src.stat().st_size)
        upload_path(
            PUBLIC_API, cf["bot"], cf["channel"], src, obj["key"][:900], state, entry,
            part["role"], part["index"], sha, duration, part["mime"], cf, part["group"],
        )
        save_manifest(cf, manifest, directory)
        src.unlink(missing_ok=True)
        log("[telegram-backup] stored %s/%s (loop %s)" % (obj["bucket"], obj["key"], part["group"]))
        return "ok"
    entry = ensure_entry(manifest, obj, kind, sha, kind in {"small", "hls", "mirror"}, False)
    if kind in {"small", "mirror"}:
        if not budget_ok(state, src.stat().st_size):
            return "stop"
        upload_path(PUBLIC_API, cf["bot"], cf["channel"], src, obj["key"][:900], state, entry, "file", 0, sha, 0, entry["mime"], cf)
    elif kind == "archive":
        api = LOCAL_API if local else ""
        if not api:
            log("[telegram-backup] skipped_too_big %s/%s %s" % (obj["bucket"], obj["key"], obj["size"]))
            return "skip"
        for index, (offset, length) in enumerate(part_spans(src.stat().st_size)):
            if not budget_ok(state, length):
                save_manifest(cf, manifest, directory)
                return "stop"
            part_path = directory / ("part-%04d.bin" % index)
            digest = write_span(src, part_path, offset, length)
            upload_path(api, cf["bot"], cf["channel"], part_path, "%s part %s" % (obj["key"][:800], index + 1), state, entry, "part", index, digest, 0, "application/octet-stream", cf)
            part_path.unlink(missing_ok=True)
    else:
        hls_dir = directory / "hls"
        copy_only = social_copy_key(obj["key"])
        try:
            init, items, transcoded = build_hls(src, hls_dir, copy_only=copy_only)
        except RuntimeError:
            shutil.rmtree(hls_dir, ignore_errors=True)
            if copy_only:
                remember_kept(src, obj, manifest, cf, state, directory, sha)
                src.unlink(missing_ok=True)
                log("[telegram-backup] skipped_hls %s/%s (not re-encoded)" % (obj["bucket"], obj["key"]))
                return "oversize"
            log("[telegram-backup] skipped_hls %s/%s" % (obj["bucket"], obj["key"]))
            return "skip"
        if transcoded:
            log("[telegram-backup] transcoded %s/%s so every segment stays under 19 MiB" % (obj["bucket"], obj["key"]))
        queue = []
        if init:
            queue.append((-1, "init", hls_dir / Path(init).name, "video/mp4", 0))
        for index, (name, duration) in enumerate(items):
            path = hls_dir / Path(name).name
            mime = "video/mp2t" if path.suffix == ".ts" else "video/iso.segment"
            queue.append((index, "segment", path, mime, duration))
        playlist = hls_dir / "index.m3u8"
        queue.append((-2, "playlist", playlist, "application/vnd.apple.mpegurl", 0))
        for index, role, path, mime, duration in queue:
            if not budget_ok(state, path.stat().st_size):
                save_manifest(cf, manifest, directory)
                return "stop"
            digest = hash_file(path)
            upload_path(PUBLIC_API, cf["bot"], cf["channel"], path, "%s %s %s" % (obj["key"][:800], role, index), state, entry, role, index, digest, duration, mime, cf)
        shutil.rmtree(hls_dir, ignore_errors=True)
    save_manifest(cf, manifest, directory)
    if entry.get("serve") and entry.get("kind") in {"small", "hls"} and cf.get("worker"):
        if verify_entry(entry, cf["worker"], cf["bot"], directory):
            entry["verified"] = True
            for part in entry.get("parts") or []:
                if cf.get("database"):
                    remember_d1(cf["token"], cf["account"], cf["database"], entry, part, True)
            save_manifest(cf, manifest, directory)
            if may_delete(entry.get("kind") or "", True, int(entry.get("size") or 0)):
                delete_object(cf["token"], cf["account"], obj["bucket"], obj["key"])
                entry["deleted"] = True
                save_manifest(cf, manifest, directory)
                log("[telegram-backup] deleted %s/%s" % (obj["bucket"], obj["key"]))
        else:
            log("[telegram-backup] not verified %s/%s" % (obj["bucket"], obj["key"]))
    src.unlink(missing_ok=True)
    log("[telegram-backup] stored %s/%s (%s)" % (obj["bucket"], obj["key"], kind))
    return "ok"


def delete_message(cf: dict, message_id: int) -> bool:
    """Best effort. A bot that is a channel admin can delete its posts."""
    bot = cf.get("bot") or ""
    channel = cf.get("channel") or ""
    if not bot or not channel or int(message_id or 0) <= 0:
        return False
    body = urllib.parse.urlencode({"chat_id": channel, "message_id": int(message_id)}).encode("utf-8")
    request = urllib.request.Request(PUBLIC_API + "/bot" + bot + "/deleteMessage", data=body, method="POST", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(request, timeout=30) as res:
            data = json.loads(res.read().decode("utf-8") or "{}")
            return bool(data.get("ok"))
    except Exception:
        return False


FORGET_PREFIX = "backup/tg-forget/"


def forget_deleted_accounts(rows: list, manifest: dict, cf: dict, directory: Path) -> int:
    """Deleted accounts: the Worker already dropped their telegram_files rows
    and wrote backup/tg-forget/<id>-<time>.json. Delete those channel
    messages, drop the manifest entries, then remove the queue object."""
    done = 0
    for obj in rows:
        key = str(obj.get("key") or "")
        if not key.startswith(FORGET_PREFIX) or not key.endswith(".json"):
            continue
        path = directory / "forget.json"
        try:
            download_object(cf["token"], cf["account"], obj["bucket"], key, path)
            doc = json.loads(path.read_text(encoding="utf-8") or "{}")
        except Exception:
            continue
        finally:
            path.unlink(missing_ok=True)
        gone = set(str(item) for item in (doc.get("keys") or []) if isinstance(item, str))
        messages = set(int(item) for item in (doc.get("messages") or []) if isinstance(item, int) and item > 0)
        for entry in manifest.get("files") or []:
            if entry.get("key") in gone:
                for part in entry.get("parts") or []:
                    if int(part.get("message_id") or 0) > 0:
                        messages.add(int(part["message_id"]))
        removed = sum(1 for mid in sorted(messages) if delete_message(cf, mid))
        manifest["files"] = [entry for entry in manifest.get("files") or [] if entry.get("key") not in gone]
        if cf.get("database") and gone:
            for item in gone:
                try:
                    d1_exec(cf["token"], cf["account"], cf["database"], "DELETE FROM telegram_files WHERE object_key = ?", [item])
                except Exception:
                    pass
        save_manifest(cf, manifest, directory)
        delete_object(cf["token"], cf["account"], obj["bucket"], key)
        done += 1
        log("[telegram-backup] forgot a deleted account: %s files, %s of %s messages removed" % (len(gone), removed, len(messages)))
    return done


def snapshot_data(rows: list, manifest: dict, cf: dict, state: dict, directory: Path) -> int:
    """Copy the public catalogs to Telegram as snap/<key>. Only a changed
    file is sent, and the previous snapshot message is deleted, so the
    channel holds one copy of each. The Worker reads it only after R2 and
    lastgood/ both fail."""
    if not cf.get("database"):
        return 0
    stored = 0
    for name in SNAPSHOT_KEYS:
        candidates = [row for row in rows if row.get("key") == name and int(row.get("size") or 0) > 0]
        candidates.sort(key=lambda row: (row.get("bucket") != cf.get("manifest_bucket"), str(row.get("bucket") or "")))
        if not candidates:
            continue
        obj = candidates[0]
        size = int(obj.get("size") or 0)
        if size > public_bytes():
            log("[telegram-backup] snapshot %s skipped_too_big %s" % (name, size))
            continue
        src = directory / "snapshot.json"
        try:
            sha = download_object(cf["token"], cf["account"], obj["bucket"], name, src)
            doc = json.loads(src.read_text(encoding="utf-8") or "null")
        except Exception:
            src.unlink(missing_ok=True)
            continue
        if not isinstance(doc, dict) or doc.get("catalogSeed") is True:
            src.unlink(missing_ok=True)
            continue
        key = "snap/" + name
        prior = find_entry(manifest, SNAPSHOT_BUCKET, key)
        if prior and prior.get("sha256") == sha and part_done(prior, "file", 0):
            src.unlink(missing_ok=True)
            continue
        old = [int(part.get("message_id") or 0) for part in (prior or {}).get("parts") or []]
        if not budget_ok(state, src.stat().st_size):
            src.unlink(missing_ok=True)
            break
        snap = {"bucket": SNAPSHOT_BUCKET, "key": key, "size": src.stat().st_size, "etag": sha, "content_type": "application/json"}
        entry = ensure_entry(manifest, snap, "mirror", sha, True, False)
        stamp = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())
        upload_path(PUBLIC_API, cf["bot"], cf["channel"], src, "snapshot %s %s" % (name, stamp), state, entry, "file", 0, sha, 0, "application/json", cf)
        entry["snapshot_at"] = int(time.time())
        save_manifest(cf, manifest, directory)
        src.unlink(missing_ok=True)
        for mid in old:
            delete_message(cf, mid)
        stored += 1
    log("[telegram-backup] snapshots stored %s" % stored)
    return stored


def backup(loop_only: bool = False, shard: tuple[int, int] | None = None) -> int:
    cf = prepare_clients()
    if cf is None:
        return 0
    if cf.get("error"):
        return 1
    if shard is None:
        shard = parse_shard()
    if shard:
        log("[telegram-backup] active shard %s/%s" % (shard[0], shard[1]))
    bots = get_bot_tokens()
    bot = bots[0] if bots else (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    channel = (os.environ.get("TELEGRAM_CHANNEL_ID") or "").strip()
    directory = Path(tempfile.mkdtemp(prefix="tg-backup-"))
    try:
        rows = collect_objects(cf)
        version = read_loop_version(cf["token"], cf["account"], bucket_names(cf["token"], cf["account"]), directory)
        if loop_only and not version:
            log("[telegram-backup] loop/current.json has no version; skipping the mirror")
            return 0
        local = local_requested() and needs_local(rows)
        manifest, manifest_bucket = load_remote_manifest(cf["token"], cf["account"], bucket_names(cf["token"], cf["account"]), directory)
        if not manifest_bucket:
            log("[telegram-backup] no R2 bucket is visible")
            return 1
        database = ""
        worker = ""
        try:
            database = d1_id(cf["token"], cf["account"])
            d1_exec(cf["token"], cf["account"], database, D1_CREATE, [])
        except Exception as err:
            log("[telegram-backup] D1 is not ready; files will not be served or deleted")
            log(scrub(str(err), current_secrets()))
            database = ""
        if database:
            try:
                worker = worker_api(cf["token"], cf["account"])
            except Exception:
                worker = ""
        blocked = collect_blocked_keys(cf, rows, directory)
        cf.update({
            "bot": bot,
            "bots": bots,
            "channel": channel,
            "database": database,
            "worker": worker,
            "manifest_bucket": manifest_bucket,
            "loop_version": version,
            "blocked_keys": blocked,
        })
        if len(bots) > 1:
            log("[telegram-backup] multi-bot pool active (%s bots)" % len(bots))
        state = new_entry_state()
        if loop_only:
            state["file_cap"] = loop_file_cap()
            log("[telegram-backup] mirroring loop %s" % version)

        def rank(obj):
            if loop_only:
                return loop_rank(str(obj.get("key") or ""), version)
            kind = plan_kind(obj["key"], int(obj["size"]), obj.get("content_type") or "", False, version, blocked)
            key = str(obj.get("key") or "")
            if structural_role(key) == "upload":
                first = -1
            elif key.startswith("comments/"):
                first = 0
            elif key.startswith("tiktok/"):
                first = 1
            elif key.startswith("social/") and "/video/" in key:
                first = 2
            elif key.startswith("social/"):
                first = 3
            elif kind in {"loop", "mirror"}:
                first = 4
            else:
                first = 5
            return (first, -int(obj.get("size") or 0), str(obj.get("uploaded") or ""), key)

        stopped = False
        failed_objects: list[str] = []
        if not loop_only and (not shard or shard[0] == 0):
            try:
                forget_deleted_accounts(rows, manifest, cf, directory)
            except Exception as err:
                log("[telegram-backup] forget queue failed")
                log(scrub(str(err), current_secrets()))
            try:
                snapshot_data(rows, manifest, cf, state, directory)
            except Exception as err:
                log("[telegram-backup] snapshots failed")
                log(scrub(str(err), current_secrets()))
        if not loop_only:
            log("[telegram-backup] social originals for added accounts are downloaded by media-extract")
        for obj in sort_objects(rows, rank):
            if stopped:
                break
            key_str = str(obj.get("key") or "")
            if shard and not shard_match(key_str, shard):
                continue
            owned = find_entry(manifest, "cdn", key_str)
            if owned and owned.get("parts") and key_str.startswith(("tiktok/", "social/")):
                continue
            if structural_role(obj["key"]) == "manifest":
                continue
            if loop_only and plan_kind(obj["key"], int(obj["size"]), obj.get("content_type") or "", False, version) != "loop":
                continue
            try:
                result = process(obj, manifest, cf, state, directory)
            except Exception as err:
                log("[telegram-backup] failed %s/%s" % (obj["bucket"], obj["key"]))
                log(scrub(str(err), current_secrets()))
                save_manifest(cf, manifest, directory)
                failed_objects.append(key_str)
                if len(failed_objects) >= 5:
                    log("[telegram-backup] aborting runner after %s object failures" % len(failed_objects))
                    return 1
                continue
            if result == "stop":
                log("[telegram-backup] reached the run cap")
                break
        log("[telegram-backup] social %s files, %s bytes; tiktok %s files, %s bytes" % (
            state.get("social_files") or 0,
            state.get("social_bytes") or 0,
            state.get("tiktok_files") or 0,
            state.get("tiktok_bytes") or 0,
        ))
        log(upload_summary(state))
        log("[telegram-backup] kept_r2 %s" % (state.get("kept_r2") or 0))
        log_d1_newest(cf)
        if loop_only:
            log("[telegram-backup] loop mirror stored %s segments, largest %s bytes" % (state.get("loop_segments") or 0, state.get("loop_max") or 0))
        if shard:
            log("[telegram-backup] shard %s/%s finished" % (shard[0], shard[1]))
        return 0
    except Exception as err:
        log("[telegram-backup] backup failed")
        log(scrub(str(err), current_secrets()))
        return 1
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def selftest() -> int:
    def check(cond, message):
        if not cond:
            raise SystemExit("FAIL: " + message)
        print("ok", message)

    env = {"PATH": os.environ.get("PATH", ""), "LANG": "C.UTF-8", "SYSTEMROOT": os.environ.get("SYSTEMROOT", "")}
    skipped = subprocess.run([sys.executable, str(ROOT / "scripts" / "telegram_backup.py")], capture_output=True, text=True, env=env, check=False)
    check(skipped.returncode == 0 and "skipping the upload" in skipped.stdout, "missing Telegram secrets skip the upload")
    env["TELEGRAM_BOT_TOKEN"] = "sentinel-secret-value"
    env["TELEGRAM_CHANNEL_ID"] = ""
    leaked = subprocess.run([sys.executable, str(ROOT / "scripts" / "telegram_backup.py")], capture_output=True, text=True, env=env, check=False)
    combined = leaked.stdout + leaked.stderr
    check(leaked.returncode == 0 and "sentinel-secret-value" not in combined, "a partial secret is not printed")

    os.environ.pop("TG_BACKUP_KEY", None)
    os.environ["TG_MAX_MB"] = "19"
    os.environ["TG_DELETE_FROM_R2"] = ""
    published = "v202610221300"
    check(plan_kind("loop/current.json", 100, "application/json", True) == "keep-radio", "radio stays on R2")
    check(plan_kind("loop/current.json", 100, "application/json", True, published) == "keep-radio", "current.json stays on R2")
    check(plan_kind("loop/" + published + "/seg_0000.m4s", 1000, "video/iso.segment", True, published) == "loop", "the published FLAC loop is mirrored")
    check(plan_kind("loop/" + published + "/aac/seg_0001.ts", 1000, "video/mp2t", True, published) == "loop", "the published AAC fallback is mirrored")
    check(plan_kind("loop/" + published + "/index.m3u8", 200, "application/vnd.apple.mpegurl", True, published) == "loop", "the loop playlist is mirrored")
    check(plan_kind("loop/" + published + "/init.mp4", 500, "video/mp4", True, published) == "loop", "the loop init segment is mirrored")
    check(plan_kind("loop/vOLD/seg_0000.m4s", 1000, "video/iso.segment", True, published) == "loop", "an older loop version is mirrored")
    check(plan_kind("radio/bed/index.m3u8", 400, "application/vnd.apple.mpegurl", True) == "mirror", "radio audio is mirrored")
    check(plan_kind("music/song/seg.m4s", 5000, "video/iso.segment", True) == "mirror", "a music segment is mirrored")
    check(plan_kind("music/song/index.m3u8", 800, "application/vnd.apple.mpegurl", True) == "mirror", "a music playlist is mirrored")
    check(plan_kind("music/song/init.mp4", 900, "video/mp4", True) == "mirror", "a music init file is mirrored")
    check(plan_kind("covers/" + ("ab" * 32) + ".png", 1000, "image/png", True) == "mirror", "a cover image is mirrored")
    check(plan_kind("music/song/key.bin", 16, "application/octet-stream", True) == "keep-key", "a song key file stays on R2")
    blocked = aes_key_refs('#EXT-X-KEY:METHOD=AES-128,URI="cf1373b0cf10db5ae3fe8dd7.bin",IV=0x1\n', "music/abc/index.m3u8")
    check(blocked == {"music/abc/cf1373b0cf10db5ae3fe8dd7.bin"}, "a playlist names its AES key")
    check(plan_kind("music/abc/cf1373b0cf10db5ae3fe8dd7.bin", 16, "application/octet-stream", True, "", blocked) == "keep-key", "the named AES key is not uploaded")
    check(plan_kind("music/abc/c099e79892e9b2f248f9.m4s", 5000, "video/iso.segment", True, "", blocked) == "mirror", "an encrypted music piece is still mirrored")
    check(plan_kind("media/avatars/123456789012/" + ("ab" * 32) + ".webp", 1000, "image/webp", True) == "mirror", "avatar media is mirrored")
    check(plan_kind("media/banners/123456789012/" + ("cd" * 32) + ".jpg", 1000, "image/jpeg", True) == "mirror", "banner media is mirrored")
    check(plan_kind("stories/card.jpg", 1000, "image/jpeg", True) == "mirror", "story media is mirrored")
    check(plan_kind("stories.json", 1000, "application/json", True) == "keep-live", "the stories catalog stays on R2")
    check(plan_kind("owner/tiktok.json", 1000, "application/json", True) == "keep-live", "owner files stay on R2")
    check(plan_kind("secrets/token.txt", 20, "text/plain", True) == "keep-key", "a token file stays on R2")
    check(structural_role("comments/2114074075845026215.json") == "comments", "comments get their own structural role")
    check(plan_kind("comments/2114074075845026215.json", 1000, "application/json", False) == "mirror", "comments are mirrored to Telegram")
    check(plan_kind("loop/" + published + "/seg_0000.m4s", SMALL_BYTES + 1, "video/iso.segment", True, published) == "too-big", "a loop segment of 19 MiB or more stays on R2")
    flac = loop_part("loop/" + published + "/seg_0003.m4s", published)
    aac = loop_part("loop/" + published + "/aac/seg_0001.ts", published)
    check(flac["group"] == "loop/" + published and flac["role"] == "segment" and flac["index"] == 3, "FLAC segments are recorded under the loop version")
    check(aac["group"] == "loop/" + published + "/aac" and aac["mime"] == "video/mp2t" and aac["index"] == 1, "AAC segments are recorded under the loop version")
    check(loop_part("loop/" + published + "/index.m3u8", published)["index"] == -2, "the playlist is a manifest row, not a served segment")
    check(loop_part("loop/" + published + "/init.mp4", published)["role"] == "init", "the init segment is part of the loop version")
    check(loop_part("loop/current.json", published) is None, "current.json is not a loop segment")
    check(segment_duration({"seg_0000.m4s": 10.031}, "seg_0000.m4s") == 10.031, "loop durations come from the playlist")
    check(segment_duration({}, "seg_0000.m4s") == 10.0, "a missing loop duration defaults to 10 seconds")
    check(plan_kind("feeds.json", 1000, "application/json", True) == "keep-live", "worker JSON stays on R2")
    check(plan_kind("history/1.json", 1000, "application/json", True) == "keep-account", "account data is excluded without a key")
    check(plan_kind("cold/a.jpg", 1000, "image/jpeg", False) == "small", "a small image is one document")
    check(plan_kind("cold/big.mp4", SMALL_BYTES + 1, "video/mp4", True) == "hls", "a video over 19 MiB becomes HLS")
    check(plan_kind("cold/big.zip", SMALL_BYTES + 1, "application/zip", True) == "archive", "a big archive uses the local server")
    check(plan_kind("cold/big.zip", SMALL_BYTES + 1, "application/zip", False) == "too-big", "a big archive is skipped without the local server")
    check(plan_kind("cold/clip.mp4", SMALL_BYTES, "video/mp4", True) == "small", "a video of 19 MiB stays one document")
    os.environ["TG_BACKUP_KEY"] = "test-passphrase-value"
    check(plan_kind("history/1.json", 1000, "application/json", True) == "account", "a backup key allows an encrypted account copy")
    check(plan_kind("media/avatars/123456789012/" + ("ab" * 32) + ".webp", 1000, "image/webp", True) == "mirror", "avatar media stays servable when the backup key is set")
    os.environ.pop("TG_BACKUP_KEY", None)

    check(part_spans(PART_BYTES, PART_BYTES) == [(0, PART_BYTES)], "a 1950 MiB archive is one part")
    check(part_spans(PART_BYTES + 10, PART_BYTES) == [(0, PART_BYTES), (PART_BYTES, 10)], "a larger archive is split at 1950 MiB")
    check(retry_after(429, {"ok": False, "error_code": 429, "parameters": {"retry_after": 9}}) == 9, "retry_after is honored")
    check(curl_reset("curl: (35) Recv failure: Connection reset by peer") and not curl_reset("curl: (22) The requested URL returned error: 404"), "only a dropped curl connection is retried")
    video = {"ok": True, "result": {"message_id": 9, "video": {"file_id": "vid", "file_size": 4}}}
    noted = note_from_upload(video, 4)
    check(noted and noted["file_id"] == "vid" and noted["message_id"] == 9, "a file id is read from the message, including a video")
    check(note_from_upload({"ok": True, "result": {"message_id": 3}}, 4) is None, "a message with no file id is not stored yet")
    with tempfile.TemporaryDirectory() as upload_dir:
        sample = Path(upload_dir) / "clip.bin"
        sample.write_bytes(b"clip")
        calls = {"n": 0, "urls": []}

        def run_once(cmd):
            calls["n"] += 1
            calls["urls"].append(cmd[-1])
            if calls["n"] == 1:
                return subprocess.CompletedProcess(cmd, 35, b"", b"curl: (35) Recv failure: Connection reset by peer")
            return subprocess.CompletedProcess(cmd, 0, b"{}\n200", b"")

        def missing(_url=None, _token=None):
            return 0

        put_object_file("token", "acct", "bucket", "cdn/social/x/1/video/0", sample, "video/mp4", run=run_once, head=lambda: missing(), sleep=lambda _s: None)
        check(calls["n"] == 2 and calls["urls"][0] == calls["urls"][1] and calls["urls"][0].endswith("cdn/social/x/1/video/0"), "a reset upload retries the same R2 key")
        calls["n"] = 0

        def already():
            return sample.stat().st_size

        put_object_file("token", "acct", "bucket", "cdn/social/x/1/video/0", sample, "video/mp4", run=run_once, head=already, sleep=lambda _s: None)
        check(calls["n"] == 1, "a reset upload is not written again when that key already has the file")
    check(retry_after(200, {"ok": True}) is None, "a normal response is not a rate limit")
    check(gap_seconds(10, 11) == 2, "messages stay at least 3 seconds apart")
    check(may_delete("small", True, 100) and may_delete("hls", True, 10**9) and not may_delete("archive", True, 100) and not may_delete("small", False, 100) and not may_delete("loop", True, 100) and not may_delete("mirror", True, 100) and not may_delete("r2", True, 10**9), "only a verified loadable file can leave R2, and music, covers, the radio loop, and a kept original never do")
    os.environ["TG_DELETE_FROM_R2"] = "false"
    check(not may_delete("small", True, 100), "TG_DELETE_FROM_R2=false keeps R2")
    os.environ["TG_DELETE_FROM_R2"] = ""
    passes = hls_attempts(True)
    check(passes == [(False, 6, False), (False, 4, False), (False, 2, False), (False, 1, False), (False, 1, True)] and all(not row[0] for row in passes), "copy-only HLS retries 2s, 1s, then keyframe splits and never re-encodes")
    check(social_copy_key("tiktok/lockclip/7695476356548660503/video") and social_copy_key("tiktok/id/123456789/7695476356548660503/video") and social_copy_key("social/youtube/xtrFOsncOeo/video/0") and not social_copy_key("cold/big.mp4"), "only a synced social video stays copy-only")
    with tempfile.TemporaryDirectory() as kept_dir:
        kept_root = Path(kept_dir)
        original = kept_root / "original.mp4"
        original.write_bytes(b"full-quality")
        kept_manifest = empty_manifest()
        kept_state = {}
        kept_obj = {"bucket": "viktorych-data", "key": "social/x/abc/video/0", "size": original.stat().st_size, "etag": "e", "content_type": "video/mp4"}
        kept_ok = remember_kept(original, kept_obj, kept_manifest, {}, kept_state, kept_root, "ab")
        kept_entry = find_entry(kept_manifest, "viktorych-data", "social/x/abc/video/0")
        check(kept_ok and already_kept(kept_entry) and kept_entry["kind"] == "r2" and kept_entry["deleted"] is False and kept_entry["serve"] is False and kept_state["kept_r2"] == 1, "an unsplittable copy stays on R2 and is not deleted")

    manifest = empty_manifest()
    entry = ensure_entry(manifest, {"bucket": "b", "key": "cold/a.jpg", "size": 4, "etag": "e", "content_type": "image/jpeg"}, "small", "ab", True, False)
    upsert_part(entry, {"role": "file", "index": 0, "sha256": "ab", "size": 4, "message_id": 7, "file_id": "fid", "duration": 0, "mime": "image/jpeg"})
    check(part_done(entry, "file", 0)["message_id"] == 7 and part_done(find_entry(manifest, "b", "cold/a.jpg"), "file", 0)["file_id"] == "fid", "the manifest records message_id, file_id, and sha256")
    check(scrub("token sentinel-secret-value", ["sentinel-secret-value"]) == "token [redacted]", "logs are scrubbed")

    init, items = parse_hls('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5.0,\nseg00000.m4s\n#EXTINF:4.5,\nseg00001.m4s\n')
    check(init == "init.mp4" and items == [("seg00000.m4s", 5.0), ("seg00001.m4s", 4.5)], "an HLS playlist lists the init segment and durations")

    if shutil.which("openssl"):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            plain = folder / "plain.bin"
            cipher = folder / "cipher.bin"
            back = folder / "back.bin"
            plain.write_bytes(b"UNIQUEPLAINTEXT-account")
            os.environ["TG_BACKUP_KEY"] = "test-passphrase-value"
            encrypt_file(plain, cipher)
            check(b"UNIQUEPLAINTEXT-account" not in cipher.read_bytes(), "account bytes are not stored in the clear")
            decrypt_file(cipher, back)
            check(back.read_bytes() == plain.read_bytes(), "the backup key decrypts the account copy")
            os.environ.pop("TG_BACKUP_KEY", None)

    if shutil.which("ffmpeg"):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            src = folder / "clip.mp4"
            made = subprocess.run([
                "ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10",
                "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(src),
            ], capture_output=True)
            check(made.returncode == 0 and src.is_file(), "ffmpeg can make a sample clip")
            init_name, segs, _transcoded = build_hls(src, folder / "out")
            names = [Path(init_name).name] + [Path(name).name for name, _duration in segs]
            check(bool(segs) and segments_under(folder / "out", names, SMALL_BYTES), "HLS segments stay under 19 MiB")
            check(all(4 <= duration <= 6 or duration <= 6 for _name, duration in segs), "sample segments are a few seconds")
            copied = hls_command(src, folder / "copy-cmd", 5, False, True)
            check(copied[copied.index("-c") + 1] == "copy" and "libx264" not in copied, "HLS copy uses -c copy and does not re-encode")
            split = hls_command(src, folder / "key-cmd", 1, False, True, True)
            check(split[split.index("-c") + 1] == "copy" and split[split.index("-hls_time") + 1] == "0.001" and "libx264" not in split, "keyframe splits stay -c copy")
            init_only, segs_only, transcoded = build_hls(src, folder / "copy", copy_only=True)
            names_only = [Path(init_only).name] + [Path(name).name for name, _duration in segs_only]
            check(transcoded is False and bool(segs_only) and segments_under(folder / "copy", names_only, SMALL_BYTES), "copy-only HLS keeps the original codecs")
            if shutil.which("ffprobe"):
                probed = probe_saved(src)
                check(probed.get("width") == 160 and probed.get("height") == 120 and probed.get("codec") == "h264" and int(probed.get("bitrate") or 0) > 0 and float(probed.get("duration") or 0) > 0, "ffprobe records width, height, codec, bitrate, and duration")

    doc = (ROOT / "docs" / "telegram-backup.md").read_text(encoding="utf-8")
    workflow = (ROOT / ".github" / "workflows" / "telegram-backup.yml").read_text(encoding="utf-8")
    worker = (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8")
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    for name in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID", "TELEGRAM_API_ID", "TELEGRAM_API_HASH"):
        check(name in doc and name in workflow, name + " is named in the docs and the workflow")
    check("https://github.com/ViktorychGroup/ViktorychApp/settings/secrets/actions/new" in doc, "the docs name the GitHub secret page")
    check("@BotFather" in doc and "/newbot" in doc and "https://my.telegram.org" in doc, "the docs include the bot and api_id steps")
    check("wrangler secret put TELEGRAM_BOT_TOKEN" in doc, "the docs include the Worker secret command")
    secret_workflow = (ROOT / ".github" / "workflows" / "telegram-worker-secret.yml").read_text(encoding="utf-8")
    check("wrangler secret put TELEGRAM_BOT_TOKEN" in secret_workflow and "printf '%s'" in secret_workflow, "the Worker secret is copied from stdin")
    check('echo "$TELEGRAM' not in secret_workflow and "echo ${{ secrets" not in secret_workflow, "the Worker secret workflow does not print secrets")
    check(".github/telegram-worker-secret" in secret_workflow and ".github/telegram-worker-secret" in doc, "pushing the marker copies the Worker secret")
    check('cron: "17 11 * * *"' in workflow and 'cron: "*/30 * * * *"' not in workflow and "workflow_dispatch" in workflow and "actions/cache@" in workflow and "--local" in workflow, "the workflow is scheduled, manual, cached, and can start the local server")
    check("cancel-in-progress: false" in workflow or "cancel-in-progress: ${{ github.event_name == 'pull_request' }}" in workflow, "an upload that is already running is not cancelled")
    sync_workflow = (ROOT / ".github" / "workflows" / "sync.yml").read_text(encoding="utf-8")
    check("telegram-backup.yml" in sync_workflow and "media-extract.yml" in sync_workflow and "loop_only" in sync_workflow, "a finished sync dispatches the backup and the extract")
    check(cdn_fallback_ok("video", "https://video.twimg.com/a.mp4") is False, "a video does not fall back to a CDN rendition")
    check(cdn_fallback_ok("photo", "https://pbs.twimg.com/media/a.jpg?name=orig") is True, "a full-size photo may use the original CDN file")
    check(cdn_fallback_ok("photo", "https://pbs.twimg.com/media/a.jpg?name=small") is False, "a resized photo is not the original")
    check(cdn_fallback_ok("thumb", "https://i.ytimg.com/vi/x/hqdefault.jpg") is True, "a thumbnail still uses its CDN file")
    summary = upload_summary({"files": 2, "bytes": 9, "kinds": {"small": 2}, "kind_bytes": {"small": 9}, "newest": 1761157560})
    check(summary.startswith("[telegram-backup] uploaded 2 files, 9 bytes") and "newest " in summary, "the summary names the newest sendDocument time")
    kept = merge_manifest(
        {"v": 1, "files": [{"bucket": "cdn", "key": "social/x/new/photo/0", "parts": [{"role": "file", "index": 0, "file_id": "B"}], "verified": False}]},
        {"v": 1, "files": [{"bucket": "cdn", "key": "social/x/old/photo/0", "parts": [{"role": "file", "index": 0, "file_id": "A"}], "verified": True}]},
    )
    keys = [row["key"] for row in kept["files"]]
    check(keys == ["social/x/old/photo/0", "social/x/new/photo/0"] and manifest_covers(kept, kept), "a parallel save keeps both uploaded files")
    same = part_from_saved({"file_id": "B", "message_id": 3, "size": 4, "sha256": "ab", "mime": "image/jpeg"}, "file", 0, "ab")
    changed = part_from_saved({"file_id": "B", "sha256": "zz"}, "file", 0, "ab")
    check(same and same["file_id"] == "B" and changed is None, "a saved D1 row is not sent again")
    check('echo "$TELEGRAM' not in workflow and "echo ${{ secrets" not in workflow, "the workflow does not print secrets")
    check('path.startsWith("/tg/")' in worker and "TELEGRAM_BOT_TOKEN" in worker and "not_configured" in worker, "the Worker serves /tg and returns 503 without its secret")
    check("function telegramSecretKey(" in worker and "function ownerOnlyMedia(" in worker and "function hiddenAvatar(" in worker, "the Worker keeps keys, hidden avatars, and owner-only Shorts off anonymous playback")
    check("buildPlaylist" in worker and "index.m3u8" in worker and "parseRange" in worker, "the Worker rewrites playlists and honors Range")
    check("function r2ObjectKey" in app and "tgMediaUrl" in app and "index.m3u8" in app, "the app tries R2, then the Worker, then the source")
    check("docs/telegram-backup.md" in readme and "TELEGRAM_BOT_TOKEN" in readme, "the readme points at the Telegram backup")
    check('const DATA_KEY = /^(?:feeds|stories|people|suggestions|status|feeds\\.config)\\.json$' in worker, "the live JSON pattern is still the worker pattern")
    probe = (ROOT / "scripts" / "telegram_probe.py").read_text(encoding="utf-8")
    restore = (ROOT / "scripts" / "telegram_restore.py").read_text(encoding="utf-8")
    check("getMe" in probe and "getChat" in probe and "getChatMember" in probe and "sendDocument" in probe, "the probe checks the bot, the channel, and one upload")
    check('("true" if present else "false")' in probe, "the probe prints true or false for each secret")
    check(".github/telegram-probe" in workflow and "scripts/telegram_probe.py" in workflow, "pushing the probe file runs the check")
    check("getFile" in restore and "sha256" in restore, "restore downloads by file id and checks sha256")
    check("/tg/loop/" in doc and "never deleted from R2" in doc, "the radio loop is mirrored and stays on R2")
    check("AES key" in doc and "covers/" in doc and "media/avatars/" in doc and "stories/" in doc, "songs, covers, stories, avatars, and banners are documented")
    check("sign-up gate" in doc and "owner-only" in doc, "the sign-up gate and the Shorts owner-only rule are documented")
    check("function tgBlockedKey(" in app and "music/" in app, "the app can fall back to Telegram for music and still refuses key files")
    check('"primary": "r2"' in doc and "LOOP_PRIMARY" in doc, "the radio primary field is documented and defaults to r2")
    check("--loop" in workflow and 'workflows: ["Publish radio loop"]' in workflow and "loop_only" in workflow and "timeout-minutes: 180" in workflow, "a published loop is mirrored")
    check(loop_file_cap() >= 1000 and MAX_NEW_FILES == 300, "a loop mirror can hold a full version and the daily backup stays at 300 files")
    check(loop_rank("loop/v202610221355/seg_0001.m4s", "v202610221355") < loop_rank("loop/vOLD/seg_0001.m4s", "v202610221355"), "the current loop version is mirrored first")
    tiktok_post = {
        "platform": "tiktok",
        "handle": "lockclip",
        "statusId": "7695476356548660503",
        "date": "2026-10-11T18:18:39Z",
        "stats": {"views": 9, "likes": 3, "replies": 1, "reposts": 0},
        "media": [
            {"type": "video", "url": "https://v16.tiktokcdn.com/clip.mp4", "poster": "https://p16.tiktokcdn.com/cover.jpg"},
            {"type": "photo", "url": "https://p16.tiktokcdn.com/slide.jpg"},
        ],
    }
    planned = plan_social([{"posts": [tiktok_post]}], set())
    planned_keys = {row["key"]: row for row in planned}
    check(set(planned_keys) == {
        "tiktok/lockclip/7695476356548660503/video",
        "tiktok/lockclip/7695476356548660503/poster",
        "tiktok/lockclip/7695476356548660503/photo/1",
    }, "TikTok video, poster, and carousel photo get stable keys")
    video_row = planned_keys["tiktok/lockclip/7695476356548660503/video"]
    check(video_row["original"] is True and video_row["page_url"] == "https://www.tiktok.com/@lockclip/video/7695476356548660503", "a TikTok video is fetched from the public page")
    check(planned_keys["tiktok/lockclip/7695476356548660503/photo/1"]["photo_ordinal"] == 1, "a carousel photo keeps its gallery index")
    check(video_row["info"]["views"] == 9 and video_row["info"]["likes"] == 3 and video_row["info"]["upload_date"] == "20261011", "the manifest keeps views, likes, and the upload date")
    live_post = {"platform": "tiktok", "handle": "lockclip", "kind": "live", "url": "https://www.tiktok.com/@lockclip/live", "media": [{"type": "video", "url": "https://v16.tiktokcdn.com/live.mp4"}]}
    check(plan_social([{"posts": [live_post]}], set()) == [], "a TikTok live is not recorded")
    thumb = plan_social([{"posts": [{"platform": "youtube", "statusId": "xtrFOsncOeo", "url": "https://www.youtube.com/watch?v=xtrFOsncOeo", "date": "2026-10-20T13:34:32+00:00", "stats": {"views": 88288, "likes": 5387}, "media": [{"type": "video", "url": "https://www.youtube-nocookie.com/embed/xtrFOsncOeo", "poster": "https://i.ytimg.com/vi/xtrFOsncOeo/hqdefault.jpg", "stream": "https://invidious.example/v.mp4"}]}]}], set())
    by_key = {row["key"]: row for row in thumb}
    check(set(by_key) == {"social/youtube/xtrFOsncOeo/video/0", "social/youtube/xtrFOsncOeo/thumb/0"}, "YouTube stores the original video and its thumbnail")
    check(by_key["social/youtube/xtrFOsncOeo/video/0"]["source_url"] == "" and by_key["social/youtube/xtrFOsncOeo/video/0"]["page_url"] == "https://www.youtube.com/watch?v=xtrFOsncOeo", "the YouTube embed is not fetched")
    check(by_key["social/youtube/xtrFOsncOeo/thumb/0"]["source_url"].startswith("https://i.ytimg.com/"), "YouTube contributes its thumbnail, not the embed")
    check(host_ok("https://v16.tiktokcdn.com/a.mp4") and not host_ok("https://www.youtube.com/watch?v=xtrFOsncOeo"), "only the existing CDN hosts are fetched")
    again = plan_social([{"posts": [tiktok_post]}], {"tiktok/lockclip/7695476356548660503/video"})
    check(any(row["key"] == "tiktok/lockclip/7695476356548660503/video" and row["original"] for row in again), "a TikTok video on R2 is still replaced by the original")
    renamed_tiktok = dict(tiktok_post)
    renamed_tiktok["permanentId"] = "123456789"
    renamed_tiktok["previousHandles"] = ["oldlock"]
    renamed_keys = social_key_candidates(renamed_tiktok, "video", 0)
    check(
        renamed_keys
        and renamed_keys[0] == "tiktok/id/123456789/7695476356548660503/video"
        and "tiktok/lockclip/7695476356548660503/video" in renamed_keys
        and "tiktok/oldlock/7695476356548660503/video" in renamed_keys,
        "a renamed TikTok account keeps the id key and the older handle keys",
    )
    kept = plan_social([{"posts": [renamed_tiktok]}], {"tiktok/lockclip/7695476356548660503/video"})
    check(any(row["key"] == "tiktok/lockclip/7695476356548660503/video" for row in kept), "a file stored under the previous handle stays on that key")
    check("bv*+ba/b" in ytdlp_download_args("https://www.youtube.com/watch?v=xtrFOsncOeo", Path("out"), YTDLP_FORMAT), "yt-dlp uses bv*+ba/b")
    args = ytdlp_download_args("https://www.tiktok.com/@lockclip/video/1", Path("out"), "bytevc1+audio/bv*+ba/b")
    check(args[args.index("-f") + 1].endswith("/bv*+ba/b") and args[args.index("--merge-output-format") + 1] == "mp4" and args[args.index("--remux-video") + 1] == "mp4" and "--no-cookies" in args and "--cookies" not in args, "the remux is mp4 and uses no cookies")
    check(tiktok_selector([
        {"format_id": "h264_1080", "vcodec": "h264", "acodec": "none", "tbr": 2500, "height": 1080},
        {"format_id": "bytevc1_720", "vcodec": "bytevc1", "acodec": "none", "tbr": 1800, "height": 720},
        {"format_id": "h265_540", "vcodec": "h265", "acodec": "none", "tbr": 900, "height": 540},
        {"format_id": "audio", "vcodec": "none", "acodec": "aac", "tbr": 128},
    ]) == "bytevc1_720+audio/bv*+ba/b", "TikTok prefers the top bytevc1 bitrate over a higher h264")
    check(video_format_arg("instagram") == "bv*+ba/b" and "threads" in ORIGINAL_VIDEO, "Instagram, Threads, X, YouTube, VK, and Facebook use bv*+ba/b")
    gallery_args = gallery_download_args("https://www.instagram.com/p/DeZgzTEggQe/", Path("photos"), 2)
    check("--config-ignore" in gallery_args and "--cookies" not in gallery_args and "2-2" in gallery_args, "gallery-dl asks for one full-size photo and no cookies")
    meta = info_fields({"id": "abc", "view_count": 5, "like_count": 2, "comment_count": 1, "repost_count": 3, "upload_date": "20261011", "url": "https://cdn.example/file.mp4?token=secret", "formats": [{"url": "https://cdn.example/a"}]})
    check(meta == {"id": "abc", "views": 5, "likes": 2, "comments": 1, "shares": 3, "upload_date": "20261011"} and "token" not in json.dumps(meta), "info JSON keeps counts and drops URLs")
    check(runner_blocked("ERROR: unable to download video data: HTTP Error 403: Forbidden") and runner_blocked("captcha required") and not runner_blocked("video unavailable"), "a TikTok 403 or captcha is a skip, and a normal miss is not")
    ig = {"platform": "instagram", "statusId": "https://www.instagram.com/p/DeZgzTEggQe/", "url": "https://www.instagram.com/p/DeZgzTEggQe/", "media": [{"type": "photo", "url": "https://scontent.cdninstagram.com/a.jpg"}]}
    check(social_object_key(ig, "photo", 0) == "social/instagram/DeZgzTEggQe/photo/0", "an Instagram shortcode is the object id")
    node_keys = subprocess.run(["node", "--input-type=module", "-e", """
import { socialObjectKey } from "./shared/social-keys.js";
const post = { platform: "tiktok", handle: "lockclip", statusId: "7695476356548660503" };
const ig = { platform: "instagram", statusId: "https://www.instagram.com/p/DeZgzTEggQe/", url: "https://www.instagram.com/p/DeZgzTEggQe/" };
const yt = { platform: "youtube", statusId: "xtrFOsncOeo" };
process.stdout.write([
  socialObjectKey(post, "video", 0),
  socialObjectKey(post, "poster", 0),
  socialObjectKey(post, "photo", 1),
  socialObjectKey(ig, "photo", 0),
  socialObjectKey(yt, "thumb", 0)
].join("\\n"));
"""], capture_output=True, text=True, check=False)
    check(node_keys.returncode == 0 and node_keys.stdout.splitlines() == [
        "tiktok/lockclip/7695476356548660503/video",
        "tiktok/lockclip/7695476356548660503/poster",
        "tiktok/lockclip/7695476356548660503/photo/1",
        "social/instagram/DeZgzTEggQe/photo/0",
        "social/youtube/xtrFOsncOeo/thumb/0",
    ], "the page and the backup use the same object keys")
    check('return "tiktok/" + handle + "/" + ident + "/video"' in app, "the app builds the TikTok video key")
    check("does not record TikTok LIVE" in doc and "scripts/tiktok_record.py" in doc and "docker/tiktok-live/" in doc, "this backup does not record TikTok LIVE; the recorder is separate")
    stalled_dir = Path(tempfile.mkdtemp(prefix="tg-stall-"))
    real_open = urllib.request.urlopen

    def stalled_open(*_args, **_kwargs):
        raise TimeoutError("The read operation timed out")

    urllib.request.urlopen = stalled_open
    global WORKER_LIMITED
    limited_before = WORKER_LIMITED
    WORKER_LIMITED = False
    try:
        stalled = fetch_worker("https://example.test/tg/sample", "not-a-token", stalled_dir / "stalled.bin")
    finally:
        urllib.request.urlopen = real_open
        WORKER_LIMITED = limited_before
        shutil.rmtree(stalled_dir, ignore_errors=True)
    check(stalled == 0, "a stalled worker read does not fail the backup")
    check("TikTok media loads from /tg" in doc, "TikTok playback from Telegram is documented")
    check("bv*+ba/b" in doc and "--merge-output-format mp4" in doc and "--remux-video mp4" in doc, "the docs name the yt-dlp remux")
    check("gallery-dl" in doc and "-c copy" in doc and "bytevc1" in doc, "the docs name full-size photos, copy-only HLS, and the TikTok codec")
    extract_workflow = (ROOT / ".github" / "workflows" / "media-extract.yml").read_text(encoding="utf-8")
    check("yt-dlp==2026.10.21" in extract_workflow and "gallery-dl==1.32.17" in extract_workflow and "ffprobe" in extract_workflow and 'cron: "17 */3 * * *"' in extract_workflow, "media-extract is scheduled and pins yt-dlp, gallery-dl, and ffprobe")
    spaces = (ROOT / "spaces.js").read_text(encoding="utf-8")
    check("function loopMirrorPlan(" in spaces and "maxNumRetry: 1" in spaces, "the player falls back after one R2 retry")
    check("function loopPrimaryName(" in spaces and "loopPrimaryChanged(" in spaces, "the player reads the loop primary field")
    extracted = subprocess.run([sys.executable, str(ROOT / "scripts" / "media_extract.py"), "--selftest"], capture_output=True, text=True, check=False)
    if extracted.returncode != 0:
        print(extracted.stdout)
        print(extracted.stderr)
    check(extracted.returncode == 0, "the media-extract self-test passes")
    probed = subprocess.run([sys.executable, str(ROOT / "scripts" / "telegram_probe.py"), "--selftest"], capture_output=True, text=True, check=False)
    check(probed.returncode == 0, "the probe self-test passes")
    restored = subprocess.run([sys.executable, str(ROOT / "scripts" / "telegram_restore.py"), "--selftest"], capture_output=True, text=True, check=False)
    check(restored.returncode == 0, "the restore self-test passes")
    check(parse_shard("1/3") == (1, 3) and parse_shard("invalid") is None, "shard parser parses K/N format")
    check(shard_match("test-key-abc", (0, 2)) != shard_match("test-key-abc", (1, 2)), "shard matcher splits keys disjointly")
    check(next_bot({"bots": ["botA", "botB"]}, {"bot_lasts": {"botA": 1000000000.0, "botB": 0.0}}) == "botB", "multi-bot pool chooses the idle bot")
    check(plan_kind("post-media/0123456789abcdef.jpg", 2000, "image/jpeg", False) == "mirror", "an uploaded post photo is copied and kept on R2")
    check(plan_kind("post-media/0123456789abcdef.mp4", SMALL_BYTES + 1, "video/mp4", False) == "too-big", "a big upload is not re-encoded or deleted")
    check(plan_kind("post-media/0123456789abcdef.mp4", SMALL_BYTES + 1, "video/mp4", True) == "archive", "a big upload uses archive parts when the local server runs")
    check(plan_kind("srv/0123456789abcdef/i/0123456789abcdef", 500, "image/png", False) == "mirror", "a server file is copied and kept on R2")
    check(not may_delete("mirror", True, 10) and not may_delete("archive", True, 10), "uploads never leave R2")
    check(structural_role("feeds.json") == "live" and "feeds.json" in SNAPSHOT_KEYS, "feeds.json is snapshotted, not mirrored as media")
    masked = redact_names("stored viktorych-data/live-buf/0/somebody.name/77/1/seg1.m4s tiktok/somebody/123456789/video tiktok/id/1234567/99999999/video media/avatars/123456789012/x.webp")
    check("somebody" not in masked and "1234567/" not in masked and "123456789012" not in masked and "seg1.m4s" in masked, "handles and account ids are masked in public logs")
    worker_src = (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8")
    for name in SNAPSHOT_KEYS:
        check('"' + name + '"' in worker_src.split("const TG_SNAPSHOT_KEYS")[1].split(";")[0], "the Worker reads the %s snapshot" % name)
    check("TG_PRIVATE_KEY.test(decoded)" in worker_src, "snapshots and uploads are not served on /tg")
    print("telegram backup selftest ok")
    return 0


def continuous_loop(loop_only: bool = False, shard: tuple[int, int] | None = None, interval: float = 120.0) -> int:
    log("[telegram-backup] starting continuous backup runner (interval %ss)" % interval)
    while True:
        try:
            backup(loop_only=loop_only, shard=shard)
        except Exception as err:
            log("[telegram-backup] continuous cycle error: %s" % scrub(str(err), current_secrets()))
        log("[telegram-backup] sleeping %ss before next cycle..." % interval)
        time.sleep(interval)


def main(argv: list | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if "--selftest" in args:
            return selftest()
        if "--preflight" in args:
            return preflight()
        loop_only = "--loop" in args
        shard = None
        continuous = "--continuous" in args
        interval = 120.0
        for i, a in enumerate(args):
            if a.startswith("--shard="):
                shard = parse_shard(a.split("=", 1)[1])
            elif a == "--shard" and i + 1 < len(args):
                shard = parse_shard(args[i + 1])
            elif a.startswith("--interval="):
                try:
                    interval = float(a.split("=", 1)[1])
                except ValueError:
                    pass
            elif a == "--interval" and i + 1 < len(args):
                try:
                    interval = float(args[i + 1])
                except ValueError:
                    pass
        if shard is None:
            shard = parse_shard()
        if continuous:
            return continuous_loop(loop_only=loop_only, shard=shard, interval=interval)
        return backup(loop_only=loop_only, shard=shard)
    except SystemExit:
        raise
    except Exception as err:
        log("[telegram-backup] backup failed")
        log(scrub(str(err), current_secrets()))
        return 1


if __name__ == "__main__":
    try:
        from log_redact import auto as _redact_logs

        _redact_logs()
    except ImportError:
        pass
    sys.exit(main())
