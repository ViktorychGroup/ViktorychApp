#!/usr/bin/env python3
"""Download new public posts from added accounts and store the original files on Telegram.

Added accounts are the profiles in feeds.config.json (cuentas añadidas,
добавленные аккаунты). The GitHub Actions workflow runs this on a schedule.
When the owner has saved a cookie for that service, the first try sends it.
A 401, 403, captcha, or challenge marks the key and the same download runs
once without it. No captcha solver, no proxy, and nothing that would add
views. A blocked anonymous download skips that account and the run continues.
TikTok lives are not recorded. The saved file is the original, not a re-encode.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import telegram_backup as tb  # noqa: E402

EXTRACT = ("tiktok", "instagram", "x", "youtube", "vk", "facebook", "threads")
ARCHIVE_KEY = "backup/media-archive.txt"
GALLERY_KEY = "backup/gallery-archive.sqlite"
CATALOG_KEY = "backup/tiktok-catalog.json"
CURSOR_KEY = "backup/media-cursor.txt"
LINKS_KEY = "backup/media-links.json"
HANDLE_RE = re.compile(r"^[A-Za-z0-9._]{1,40}$")
CHANNEL_RE = re.compile(r"^UC[A-Za-z0-9_-]{20,}$")
SEC_RE = re.compile(r"^[A-Za-z0-9_-]{8,160}$")
USER_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


def log(message: str) -> None:
    tb.log(message)


def cap_of() -> int:
    try:
        value = int(os.environ.get("MEDIA_EXTRACT_CAP") or "8")
    except ValueError:
        value = 8
    return max(1, min(value, 80))


def per_account() -> int:
    try:
        value = int(os.environ.get("MEDIA_EXTRACT_PER") or "2")
    except ValueError:
        value = 2
    return max(1, min(value, 8))


def fresh_tally() -> dict:
    return {"done": 0, "skipped": 0, "failed": 0, "blocked": 0, "oversize": 0}


def count_result(tally: dict, result: str) -> None:
    if result == "ok":
        tally["done"] += 1
    elif result == "oversize":
        tally["oversize"] += 1
    elif result == "blocked":
        tally["blocked"] += 1
    elif result in {"fail", "failed", "error"}:
        tally["failed"] += 1
    elif result == "stop":
        return
    else:
        tally["skipped"] += 1


def log_tally(tally: dict) -> None:
    log("[media-extract] backfill done=%s skipped=%s failed=%s blocked=%s oversize=%s" % (
        tally["done"], tally["skipped"], tally["failed"], tally["blocked"], tally["oversize"]
    ))


def pace_seconds() -> float:
    try:
        value = float(os.environ.get("MEDIA_EXTRACT_PACE") or "3")
    except ValueError:
        value = 8.0
    return min(max(value, 3.0), 60.0)


def account_url(platform: str, handle: str, channel_id: str = "") -> str:
    if platform == "tiktok":
        return "https://www.tiktok.com/@" + handle
    if platform == "instagram":
        return "https://www.instagram.com/" + handle + "/"
    if platform == "x":
        return "https://x.com/" + handle
    if platform == "youtube" and CHANNEL_RE.fullmatch(channel_id or ""):
        return "https://www.youtube.com/channel/" + channel_id + "/videos"
    if platform == "youtube":
        return "https://www.youtube.com/@" + handle + "/videos"
    if platform == "vk":
        return "https://vk.com/" + handle
    if platform == "facebook":
        return "https://www.facebook.com/" + handle
    if platform == "threads":
        return "https://www.threads.net/@" + handle
    return ""


def catalog_meta_accounts(doc: dict | None) -> list:
    """Owner-added Instagram and Threads profiles. Handles stay out of the log."""
    try:
        from owner_catalog import feed_rows
    except Exception:
        return []
    rows, _ids = feed_rows(doc if isinstance(doc, dict) else {})
    found = []
    for row in rows:
        platform = str(row.get("platform") or "")
        handle = str(row.get("handle") or "").lstrip("@")
        if platform not in ("instagram", "threads") or not HANDLE_RE.fullmatch(handle):
            continue
        url = account_url(platform, handle)
        if not tb.page_host_ok(url):
            continue
        found.append({"platform": platform, "handle": handle, "url": url})
    return found


def accounts_from(config: dict, tiktok_handles: list, accounts_doc: dict | None = None, x_doc: dict | None = None) -> list:
    """Private added TikTok and X rows, config rows, then the fallback handles."""
    from account_identity import clean_id, norm_handle, tiktok_accounts

    rows = []
    seen = set()
    x_doc = x_doc if isinstance(x_doc, dict) else {}
    blocked = {norm_handle(item).casefold() for item in (x_doc.get("removed") or []) if norm_handle(item)}
    blocked_ids = {clean_id(item) for item in (x_doc.get("removedIds") or []) if clean_id(item)}
    for source in x_doc.get("added") or []:
        if not isinstance(source, dict):
            continue
        handle = norm_handle(source.get("handle")).lstrip("@")
        if not HANDLE_RE.fullmatch(handle) or not re.fullmatch(r"[A-Za-z0-9_]{1,15}", handle):
            continue
        pid = clean_id(source.get("permanentId"))
        names = [handle] + [norm_handle(item) for item in (source.get("previousHandles") or [])]
        if any(name.casefold() in blocked for name in names if name) or (pid and pid in blocked_ids):
            continue
        key = ("x", handle.lower())
        if key in seen:
            continue
        seen.add(key)
        for item in names:
            if item:
                seen.add(("x", item.lower()))
        url = account_url("x", handle)
        if not tb.page_host_ok(url):
            continue
        row = {"platform": "x", "handle": handle, "url": url}
        if pid:
            row["permanentId"] = pid
        if source.get("previousHandles"):
            row["previousHandles"] = list(source.get("previousHandles") or [])
        rows.append(row)
    for source in tiktok_accounts(config, tiktok_handles, accounts_doc):
        key = ("tiktok", source["handle"].lower())
        if key in seen:
            continue
        seen.add(key)
        for item in source.get("previousHandles") or []:
            seen.add(("tiktok", str(item).lower()))
        rows.append(source)
    for feed in (config or {}).get("feeds") or []:
        if not isinstance(feed, dict):
            continue
        platform = str(feed.get("platform") or "").lower()
        handle = str(feed.get("handle") or "").lstrip("@")
        if platform not in EXTRACT or not HANDLE_RE.fullmatch(handle):
            continue
        key = (platform, handle.lower())
        if key in seen:
            continue
        url = account_url(platform, handle, str(feed.get("channelId") or feed.get("permanentId") or ""))
        if not tb.page_host_ok(url):
            continue
        seen.add(key)
        row = {"platform": platform, "handle": handle, "url": url}
        if feed.get("permanentId"):
            row["permanentId"] = str(feed.get("permanentId"))
        if feed.get("secUid"):
            row["secUid"] = str(feed.get("secUid"))
        if feed.get("previousHandles"):
            row["previousHandles"] = list(feed.get("previousHandles") or [])
        rows.append(row)
    return rows


def rotate(accounts: list, start: int) -> list:
    if not accounts:
        return []
    index = start % len(accounts)
    return accounts[index:] + accounts[:index]


def video_args(page: str, dest: Path, archive: Path, selector: str, limit: int) -> list:
    return [
        "--ignore-config",
        "--no-cookies",
        "--no-cookies-from-browser",
        "--no-warnings",
        "--no-progress",
        "--retries", "1",
        "--fragment-retries", "1",
        "--concurrent-fragments", "1",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "--socket-timeout", "30",
        "--sleep-requests", "2",
        "--sleep-interval", "5",
        "--max-sleep-interval", "8",
        "--match-filters", "!is_live",
        "--download-archive", str(archive),
        "--max-downloads", str(limit),
        "--playlist-end", "8",
        "-f", selector,
        "--merge-output-format", "mp4",
        "--remux-video", "mp4",
        "--write-info-json",
        "--write-thumbnail",
        "-o", str(dest / "%(id)s.%(ext)s"),
        page,
    ]


def photo_args(page: str, dest: Path, archive: Path, limit: int) -> list:
    return [
        "--config-ignore",
        "--no-input",
        "--sleep", "5",
        "--sleep-request", "2",
        "--download-archive", str(archive),
        "--range", "1-%s" % max(1, limit),
        "-D", str(dest),
        "--write-metadata",
        "--filename", "{num}.{extension}",
        page,
    ]


def remember_tiktok(catalog: dict, info: dict) -> dict:
    """Index a TikTok author by user_id and by sec_uid."""
    catalog = catalog if isinstance(catalog, dict) else {}
    user_id = str((info or {}).get("uploader_id") or "")
    sec_uid = str((info or {}).get("channel_id") or "")
    unique = str((info or {}).get("uploader") or (info or {}).get("channel") or "")
    if not USER_RE.fullmatch(user_id):
        user_id = ""
    if not SEC_RE.fullmatch(sec_uid):
        sec_uid = ""
    if not user_id and not sec_uid:
        return catalog
    row = {"user_id": user_id, "sec_uid": sec_uid, "unique_id": unique[:80]}
    if user_id:
        catalog.setdefault("by_user_id", {})[user_id] = row
    if sec_uid:
        catalog.setdefault("by_sec_uid", {})[sec_uid] = row
    return catalog


def ident_of(platform: str, info: dict) -> str:
    page = str((info or {}).get("webpage_url") or "").split("?", 1)[0]
    raw = str((info or {}).get("id") or "")
    if platform == "instagram":
        match = re.search(r"instagram\.com/(?:p|reel|tv)/([A-Za-z0-9_-]{1,80})", page)
        if match:
            return match.group(1)
    if platform == "youtube" and re.fullmatch(r"[A-Za-z0-9_-]{11}", raw):
        return raw
    if platform == "threads":
        match = re.search(r"threads\.(?:com|net)/(?:@[^/]+/)?(?:post|t)/([A-Za-z0-9_-]{1,80})", page)
        if match:
            return match.group(1)
    return raw if tb.IDENT_RE.fullmatch(raw) else ""


def read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        return {}
    return data if isinstance(data, dict) else {}


def r2_text(cf: dict, bucket: str, key: str, dest: Path) -> str:
    try:
        tb.download_object(cf["token"], cf["account"], bucket, key, dest)
        return dest.read_text(encoding="utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError, RuntimeError, UnicodeError):
        return ""


def r2_json(cf: dict, bucket: str, key: str, dest: Path) -> dict:
    text = r2_text(cf, bucket, key, dest)
    try:
        data = json.loads(text) if text.strip() else {}
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def put_text(cf: dict, bucket: str, key: str, text: str) -> None:
    tb.put_bytes(cf["token"], cf["account"], bucket, key, text.encode("utf-8"), "text/plain; charset=utf-8")


def put_file(cf: dict, bucket: str, key: str, path: Path) -> None:
    if path.is_file() and path.stat().st_size > 0:
        tb.put_bytes(cf["token"], cf["account"], bucket, key, path.read_bytes(), "application/octet-stream")


def text_file(path: Path) -> str:
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def fetch_bytes(cf: dict, bucket: str, key: str, dest: Path) -> None:
    try:
        tb.download_object(cf["token"], cf["account"], bucket, key, dest)
    except (urllib.error.URLError, TimeoutError, OSError, RuntimeError):
        if dest.exists():
            dest.unlink()


def put_json(cf: dict, bucket: str, key: str, data: dict) -> None:
    payload = (json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    tb.put_bytes(cf["token"], cf["account"], bucket, key, payload, "application/json")


def open_destination(directory: Path):
    cf = tb.prepare_clients()
    if cf is None or cf.get("error"):
        return None
    bot = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    channel = (os.environ.get("TELEGRAM_CHANNEL_ID") or "").strip()
    buckets = tb.bucket_names(cf["token"], cf["account"])
    manifest, manifest_bucket = tb.load_remote_manifest(cf["token"], cf["account"], buckets, directory)
    if not manifest_bucket:
        log("[media-extract] no R2 bucket is visible")
        return None
    database = ""
    worker = ""
    try:
        database = tb.d1_id(cf["token"], cf["account"])
        tb.d1_exec(cf["token"], cf["account"], database, tb.D1_CREATE, [])
    except Exception as err:
        log("[media-extract] D1 is not ready; files will not be served until it is")
        log(tb.scrub(str(err), tb.current_secrets()))
        database = ""
    if database:
        try:
            worker = tb.worker_api(cf["token"], cf["account"])
        except Exception:
            worker = ""
    cf.update({
        "bot": bot,
        "channel": channel,
        "database": database,
        "worker": worker,
        "manifest_bucket": manifest_bucket,
        "loop_version": "",
        "blocked_keys": set(),
    })
    return cf, manifest


def selector_for(platform: str) -> str:
    if platform == "tiktok":
        return tb.TIKTOK_FALLBACK
    if platform == "x":
        return "bv*[ext=mp4]+ba[ext=m4a]/bv*[ext=mp4]+ba/b[ext=mp4]/" + tb.YTDLP_FORMAT
    return tb.YTDLP_FORMAT


def x_video_selector(formats) -> str:
    """Highest-bitrate progressive MP4, then bv*+ba/b. Remux only."""
    videos = []
    audios = []
    for fmt in formats or []:
        if not isinstance(fmt, dict):
            continue
        fid = str(fmt.get("format_id") or "")
        if not tb.FORMAT_ID_RE.fullmatch(fid):
            continue
        protocol = str(fmt.get("protocol") or "").lower()
        if "m3u8" in protocol or "hls" in protocol:
            continue
        ext = str(fmt.get("ext") or "").lower()
        url = str(fmt.get("url") or "").split("?")[0].lower()
        if ext != "mp4" and not url.endswith(".mp4") and ext != "m4a":
            continue
        vcodec = str(fmt.get("vcodec") or "none")
        acodec = str(fmt.get("acodec") or "none")
        if ext == "mp4" and vcodec not in {"", "none"} and acodec in {"", "none"}:
            videos.append(fmt)
        elif ext == "mp4" and vcodec not in {"", "none"} and acodec not in {"", "none"}:
            videos.append(fmt)
        elif vcodec in {"", "none"} and acodec not in {"", "none"}:
            audios.append(fmt)
    if not videos:
        return selector_for("x")
    videos.sort(key=lambda fmt: (tb.format_bitrate(fmt), int(fmt.get("height") or 0)), reverse=True)
    best = videos[0]
    vid = str(best.get("format_id") or "")
    if str(best.get("acodec") or "none") not in {"", "none"}:
        return vid + "/" + tb.YTDLP_FORMAT
    audios.sort(key=tb.format_bitrate, reverse=True)
    audio = str(audios[0].get("format_id") or "") if audios else ""
    if audio:
        return vid + "+" + audio + "/" + tb.YTDLP_FORMAT
    return vid + "+ba/" + tb.YTDLP_FORMAT


def twimg_orig(url: str) -> str:
    """Largest Twitter photo. A resized name= is replaced with name=orig."""
    parts = urllib.parse.urlsplit(str(url or ""))
    host = (parts.netloc or "").lower()
    if host != "pbs.twimg.com" and not host.endswith(".twimg.com"):
        return ""
    if "pbs.twimg.com" not in host and not host.endswith("twimg.com"):
        return ""
    query = [(key, value) for key, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True) if key.lower() != "name"]
    query.append(("name", "orig"))
    scheme = parts.scheme or "https"
    return urllib.parse.urlunsplit((scheme, parts.netloc, parts.path, urllib.parse.urlencode(query), ""))


def download_public_file(url: str, dest: Path) -> int:
    from x_guard import assert_not_x_api, open_url

    assert_not_x_api(url)
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
    })
    try:
        with open_url(request, timeout=30) as response:
            status = getattr(response, "status", 200)
            if status != 200:
                return status
            dest.write_bytes(response.read())
            return 200
    except urllib.error.HTTPError as err:
        return int(err.code or 0)


def promote_orig_photos(work: Path) -> None:
    """Keep the larger name=orig file. A 403 or a block leaves the photo skipped."""
    images = [
        path for path in work.rglob("*")
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    ]
    for path in images:
        meta = {}
        for candidate in (path.with_name(path.name + ".json"), path.with_suffix(".json")):
            if not candidate.is_file():
                continue
            try:
                loaded = json.loads(candidate.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                loaded = {}
            if isinstance(loaded, dict):
                meta = loaded
            break
        raw = ""
        if isinstance(meta, dict):
            raw = str(meta.get("url") or meta.get("file_url") or "")
            urls = meta.get("urls")
            if not raw and isinstance(urls, dict):
                raw = str(urls.get("orig") or urls.get("original") or "")
        orig = twimg_orig(raw)
        if not orig:
            continue
        if "name=orig" in raw.lower() and path.stat().st_size > 0:
            continue
        dest = path.with_name(path.stem + "-orig" + path.suffix)
        try:
            status = download_public_file(orig, dest)
        except Exception:
            dest.unlink(missing_ok=True)
            continue
        if status in {403, 429, 503} or status != 200 or not dest.is_file() or dest.stat().st_size <= path.stat().st_size:
            if status in {403, 429, 503}:
                log("[media-extract] skipped_blocked photo")
            dest.unlink(missing_ok=True)
            continue
        dest.replace(path)


def tiktok_download_selector(formats) -> str:
    """Top HEVC or bytevc1 format id. The h264 string is only the fallback."""
    return tb.tiktok_selector(formats or []) or tb.TIKTOK_FALLBACK


def list_tiktok_entries(ytdlp: list, page: str, limit: int) -> tuple:
    cmd = ytdlp + [
        "--ignore-config",
        "--no-cookies",
        "--no-cookies-from-browser",
        "--no-warnings",
        "--no-progress",
        "--no-flat-playlist",
        "-J",
        "--skip-download",
        "--playlist-end", str(max(1, limit)),
        "--socket-timeout", "30",
        page,
    ]
    return run_tool(cmd, 180, page)


def download_tiktok(ytdlp: list, account: dict, work: Path, archive: Path, limit: int) -> tuple:
    """One public video at a time, using the top original format id."""
    _code, out, err = list_tiktok_entries(ytdlp, account["url"], limit)
    text = out + "\n" + err
    if tb.runner_blocked(text):
        return "blocked", text
    info = {}
    try:
        parsed = json.loads(out) if out.strip() else {}
    except json.JSONDecodeError:
        parsed = {}
    if isinstance(parsed, dict):
        info = parsed
    entries = info.get("entries") if isinstance(info.get("entries"), list) else None
    if not entries and info.get("id"):
        entries = [info]
    if not entries:
        _code, out, err = run_tool(ytdlp + video_args(account["url"], work, archive, selector_for("tiktok"), limit), 600, account["url"])
        text = out + "\n" + err
        return ("blocked" if tb.runner_blocked(text) else "ok"), text
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        page = str(entry.get("webpage_url") or "")
        if "tiktok.com" not in page:
            page = str(entry.get("url") or "")
        if "tiktok.com" not in page:
            continue
        selector = tiktok_download_selector(entry.get("formats") or [])
        args = video_args(page, work, archive, selector, 1)
        args.insert(1, "--no-playlist")
        _code, out, err = run_tool(ytdlp + args, 600, page)
        text = out + "\n" + err
        if tb.runner_blocked(text):
            return "blocked", text
    return "ok", ""


def download_x(ytdlp: list, account: dict, work: Path, archive: Path, limit: int) -> tuple:
    """One public video at a time, using the highest-bitrate MP4. Remux only."""
    _code, out, err = list_tiktok_entries(ytdlp, account["url"], limit)
    text = out + "\n" + err
    if tb.runner_blocked(text):
        return "blocked", text
    info = {}
    try:
        parsed = json.loads(out) if out.strip() else {}
    except json.JSONDecodeError:
        parsed = {}
    if isinstance(parsed, dict):
        info = parsed
    entries = info.get("entries") if isinstance(info.get("entries"), list) else None
    if not entries and info.get("id"):
        entries = [info]
    if not entries:
        _code, out, err = run_tool(ytdlp + video_args(account["url"], work, archive, selector_for("x"), limit), 600, account["url"])
        text = out + "\n" + err
        return ("blocked" if tb.runner_blocked(text) else "ok"), text
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        page = str(entry.get("webpage_url") or entry.get("url") or "")
        if "x.com" not in page and "twitter.com" not in page:
            continue
        selector = x_video_selector(entry.get("formats") or [])
        args = video_args(page, work, archive, selector, 1)
        args.insert(1, "--no-playlist")
        if "--recode-video" in args:
            return "blocked", "recode"
        _code, out, err = run_tool(ytdlp + args, 600, page)
        text = out + "\n" + err
        if tb.runner_blocked(text):
            return "blocked", text
    return "ok", ""


def publish_file(path: Path, key: str, role: str, info: dict, cf: dict, manifest: dict, state: dict, directory: Path) -> str:
    if not key or not path.is_file() or path.stat().st_size <= 0:
        return "skip"
    probe = tb.probe_saved(path)
    tb.log_probe(key, probe)
    size = path.stat().st_size
    if role != "video" and size > tb.public_bytes():
        log("[media-extract] skipped_too_big %s %s" % (key, size))
        return "skip"
    content = "video/mp4" if role == "video" else tb.sniff_type(path, "")
    kind = "hls" if role == "video" and size > tb.public_bytes() else "small"
    obj = {
        "bucket": "cdn",
        "key": key,
        "size": size,
        "etag": tb.hash_file(path),
        "content_type": content,
        "role": role,
        "info": info,
        "probe": probe,
    }
    try:
        return tb.store_loaded(path, obj, kind, manifest, cf, state, directory, obj["etag"], copy_only=role == "video")
    except RuntimeError as err:
        if "telegram returned no file id" not in str(err):
            raise
        log("[media-extract] skipped_no_file_id %s" % key)
        return "fail"


def video_posts(work: Path, account: dict, catalog: dict) -> list:
    found = []
    for path in sorted(work.glob("*.mp4")):
        info = read_json(path.with_name(path.stem + ".info.json"))
        if info.get("is_live") or str(info.get("live_status") or "") in {"is_live", "is_upcoming"}:
            log("[media-extract] skipped_live %s/%s" % (account["platform"], account["handle"]))
            continue
        if account["platform"] == "tiktok":
            remember_tiktok(catalog, info)
        ident = ident_of(account["platform"], info)
        post = {
            "platform": account["platform"],
            "handle": account["handle"],
            "statusId": ident,
            "id": account["platform"] + ":" + ident,
            "url": account["url"],
        }
        if account.get("permanentId"):
            post["permanentId"] = account.get("permanentId")
        if account.get("previousHandles"):
            post["previousHandles"] = list(account.get("previousHandles") or [])
        key = tb.social_object_key(post, "video", 0)
        stats = tb.info_fields(info)
        thumbs = [item for item in work.glob(path.stem + ".*") if item.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}]
        found.append({"video": path, "key": key, "post": post, "stats": stats, "thumb": thumbs[0] if thumbs else None})
    return found


def photo_groups(work: Path, account: dict) -> list:
    images = [
        path for path in work.rglob("*")
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".gif"}
    ]
    groups = {}
    order = []
    for path in sorted(images, key=lambda item: str(item)):
        meta = read_json(path.with_name(path.name + ".json"))
        if not meta:
            meta = read_json(path.with_suffix(".json"))
        ident = ident_of(account["platform"], meta) or str(meta.get("post_id") or meta.get("shortcode") or meta.get("tweet_id") or "")
        if not tb.IDENT_RE.fullmatch(ident):
            log("[media-extract] skipped_photo %s/%s" % (account["platform"], account["handle"]))
            continue
        if ident not in groups:
            groups[ident] = []
            order.append(ident)
        groups[ident].append((path, tb.info_fields(meta)))
    rows = []
    for ident in order:
        post = {
            "platform": account["platform"],
            "handle": account["handle"],
            "statusId": ident,
            "id": account["platform"] + ":" + ident,
            "url": account["url"],
        }
        if account.get("permanentId"):
            post["permanentId"] = account.get("permanentId")
        if account.get("previousHandles"):
            post["previousHandles"] = list(account.get("previousHandles") or [])
        for index, (path, stats) in enumerate(groups[ident]):
            rows.append({"path": path, "key": tb.social_object_key(post, "photo", index), "stats": stats, "post": post, "index": index})
    return rows


def run_tool(cmd: list, timeout: int, page: str = "") -> tuple:
    argv = list(cmd)
    if page:
        try:
            from owner_keys import prepare_argv
            argv = prepare_argv(cmd, page)
        except Exception:
            argv = list(cmd)
    code, out, err = tb.run_captured(argv, timeout)
    if page:
        try:
            from owner_keys import fallback_argv
            again = fallback_argv(argv, page, code, (out or "") + "\n" + (err or ""))
        except Exception:
            again = None
        if again is not None:
            code, out, err = tb.run_captured(again, timeout)
    return code, out, err


def photos_allowed(video_status: str) -> bool:
    """A blocked video does not skip photos. The next run retries the video."""
    del video_status
    return True


def catalog_queue(items: list) -> list:
    """Newest synced posts first. A Telegram channel is not extracted."""
    rows = [item for item in items if str((item or {}).get("platform") or "") not in {"telegram", "rss"}]
    rows.sort(key=lambda item: str((item or {}).get("posted") or ""), reverse=True)
    return rows


def store_catalog(cf, manifest, state, directory, links, limit, stored, pause, tally=None) -> int:
    """Upload public originals for posts the sync already stored. Blocked items are retried later."""
    present = set()
    for row in (manifest.get("files") or []):
        if isinstance(row, dict) and row.get("key"):
            present.add(row["key"])
    for row in links or []:
        if isinstance(row, dict) and row.get("key"):
            present.add(row["key"])
    docs = tb.social_catalogs(cf, directory, tb.bucket_names(cf["token"], cf["account"]))
    items = catalog_queue(tb.plan_social(docs, present))
    log("[media-extract] catalog %s pending" % len(items))
    attempted = False
    for item in items:
        if stored >= limit:
            log("[media-extract] reached the run cap")
            return stored
        prior = tb.find_entry(manifest, item.get("bucket") or "cdn", item.get("key") or "")
        if prior and prior.get("verified") and (prior.get("parts") or []):
            if tally is not None:
                tally["skipped"] += 1
            continue
        if attempted and pause:
            time.sleep(pause)
        attempted = True
        before = int(state.get("files") or 0)
        result = tb.process_cdn(item, manifest, cf, state, directory)
        if tally is not None:
            count_result(tally, result)
        if result == "stop":
            log("[media-extract] reached the run cap")
            return limit
        if result == "ok" and int(state.get("files") or 0) > before:
            stored += 1
            links.append({
                "key": item.get("key") or "",
                "platform": item.get("platform") or "",
                "handle": "",
                "id": "",
                "stats": item.get("info") or {},
            })
            log("[media-extract] linked %s" % item.get("key"))
    return stored


def communities_waiting() -> bool:
    folder = ROOT / "data" / "communities"
    if not folder.is_dir():
        return False
    return any(path.name != "index.json" for path in folder.glob("*.json"))


def store_community_originals(directory, cf, manifest, state, links, limit, stored) -> int:
    from reddit_sync import backup_originals

    def publish(path, info):
        nonlocal stored
        if stored >= limit:
            return "stop"
        key = str((info or {}).get("key") or "")
        role = "video" if (info or {}).get("role") == "video" else "photo"
        result = publish_file(path, key, role, {}, cf, manifest, state, directory)
        if result == "ok":
            stored += 1
            links.append({
                "key": key,
                "platform": "reddit",
                "handle": (info or {}).get("community") or "",
                "id": (info or {}).get("id") or "",
                "stats": {},
            })
            log("[media-extract] linked %s" % key)
        return result

    backup_originals(directory, publish)
    return stored


def backup_communities_standalone() -> int:
    """Back up mirrored community media when this run has no added accounts."""
    if not communities_waiting():
        return 0
    directory = Path(tempfile.mkdtemp(prefix="media-reddit-"))
    try:
        opened = open_destination(directory)
        if opened is None:
            return 0
        cf, manifest = opened
        state = tb.new_entry_state()
        store_community_originals(directory, cf, manifest, state, [], cap_of(), 0)
        log(tb.upload_summary(state))
        return 0
    except Exception as err:
        log("[media-extract] community backup failed")
        log(tb.scrub(str(err), tb.current_secrets()))
        return 1
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def extract() -> int:
    config_path = ROOT / "feeds.config.json"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8")) if config_path.is_file() else {}
    except json.JSONDecodeError:
        config = {}
    from r2_catalog import read_catalog
    from tiktok_sync import env_tracked, load_added_accounts
    from update_feeds import load_added_x

    if isinstance(config, dict) and config.get("catalogSeed") is True:
        blob = read_catalog("feeds.config.json")
        restored = None
        if blob:
            try:
                parsed = json.loads(blob.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError):
                parsed = None
            if isinstance(parsed, dict) and not parsed.get("catalogSeed"):
                restored = parsed
        config = restored or {"feeds": []}
    try:
        accounts_doc = load_added_accounts()
    except Exception:
        accounts_doc = {"added": [], "removed": []}
    try:
        x_doc = load_added_x()
    except Exception:
        x_doc = {"added": [], "removed": [], "removedIds": []}
    tracked = env_tracked()
    accounts = accounts_from(config if isinstance(config, dict) else {}, tracked, accounts_doc, x_doc)
    try:
        from owner_catalog import _load_blob

        seen_meta = {(row.get("platform"), str(row.get("handle") or "").lower()) for row in accounts}
        for row in catalog_meta_accounts(_load_blob()):
            key = (row.get("platform"), str(row.get("handle") or "").lower())
            if key in seen_meta:
                continue
            seen_meta.add(key)
            accounts.append(row)
    except Exception:
        pass
    try:
        from log_redact import collect, install

        quiet = set(tracked)
        collect(accounts, quiet)
        collect(config, quiet)
        collect(accounts_doc, quiet)
        collect(x_doc, quiet)
        install(quiet)
    except Exception:
        pass
    if not accounts:
        log("[media-extract] no added accounts")
        return backup_communities_standalone()
    ytdlp = tb.tool_cmd("yt_dlp", "yt-dlp")
    gallery = tb.tool_cmd("gallery_dl", "gallery-dl")
    if not ytdlp or not gallery:
        log("[media-extract] yt-dlp or gallery-dl is not installed")
        return 1
    directory = Path(tempfile.mkdtemp(prefix="media-extract-"))
    try:
        opened = open_destination(directory)
        if opened is None:
            return 0
        cf, manifest = opened
        bucket = cf["manifest_bucket"]
        archive = directory / "archive.txt"
        photos = directory / "gallery-archive.sqlite"
        archive.write_text(r2_text(cf, bucket, ARCHIVE_KEY, directory / "remote-archive.txt"), encoding="utf-8")
        fetch_bytes(cf, bucket, GALLERY_KEY, photos)
        catalog = r2_json(cf, bucket, CATALOG_KEY, directory / "remote-catalog.json")
        links_doc = r2_json(cf, bucket, LINKS_KEY, directory / "remote-links.json")
        links = [row for row in (links_doc.get("items") or []) if isinstance(row, dict) and row.get("key")]
        try:
            start = int((r2_text(cf, bucket, CURSOR_KEY, directory / "remote-cursor.txt") or "0").strip() or "0")
        except ValueError:
            start = 0
        state = tb.new_entry_state()
        limit = cap_of()
        each = per_account()
        pause = pace_seconds()
        visited = 0
        tally = fresh_tally()
        save_queue = {"jobs": {}}
        try:
            from tiktok_save_queue import empty as empty_save_queue
            loaded = r2_json(cf, bucket, "backup/tiktok-save-queue.json", directory / "remote-save-queue.json")
            save_queue = loaded if isinstance(loaded, dict) and isinstance(loaded.get("jobs"), dict) else empty_save_queue()
        except Exception:
            save_queue = {"jobs": {}}
        stored = store_catalog(cf, manifest, state, directory, links, limit, 0, pause, tally)
        stored = store_community_originals(directory, cf, manifest, state, links, limit, stored)
        for offset, account in enumerate(rotate(accounts, start)):
            if stored >= limit:
                break
            visited += 1
            if offset:
                time.sleep(pause)
            room = min(each, limit - stored)
            work = directory / ("a-%s" % offset)
            if work.exists():
                shutil.rmtree(work, ignore_errors=True)
            work.mkdir(parents=True)
            log("[media-extract] added account %s %s" % (account["platform"], account["handle"]))
            if account["platform"] == "tiktok":
                status, text = download_tiktok(ytdlp, account, work, archive, room)
            elif account["platform"] == "x":
                status, text = download_x(ytdlp, account, work, archive, room)
            else:
                _code, out, err = run_tool(ytdlp + video_args(account["url"], work, archive, selector_for(account["platform"]), room), 600, account["url"])
                text = out + "\n" + err
                status = "blocked" if tb.runner_blocked(text) else "ok"
            videos_blocked = status == "blocked"
            if videos_blocked:
                log("[media-extract] skipped_blocked %s/%s" % (account["platform"], account["handle"]))
                tally["blocked"] += 1
            present = set()
            for row in (manifest.get("files") or []):
                if isinstance(row, dict) and row.get("key"):
                    present.add(row["key"])
            for row in links:
                if row.get("key"):
                    present.add(row["key"])
            gained = stored
            if not videos_blocked:
                for item in video_posts(work, account, catalog):
                    if stored >= limit:
                        break
                    candidates = tb.social_key_candidates(item["post"], "video", 0)
                    if any(key in present for key in candidates):
                        log("[media-extract] already stored %s/%s" % (account["platform"], account["handle"]))
                        tally["skipped"] += 1
                        continue
                    item["key"] = candidates[0] if candidates else item["key"]
                    result = publish_file(item["video"], item["key"], "video", item["stats"], cf, manifest, state, directory)
                    count_result(tally, result)
                    if result == "stop":
                        log("[media-extract] reached the run cap")
                        stored = limit
                        break
                    if account["platform"] == "tiktok":
                        try:
                            from tiktok_save_queue import enqueue as enqueue_save, mark as mark_save
                            video_id = str(item["post"].get("statusId") or "")
                            enqueue_save(save_queue, video_id, time.time(), str(item["post"].get("url") or ""))
                            if result == "ok":
                                mark_save(save_queue, video_id, "saved", time.time())
                            elif result in {"fail", "failed", "error"}:
                                mark_save(save_queue, video_id, "failed", time.time(), "error")
                            elif videos_blocked:
                                mark_save(save_queue, video_id, "blocked", time.time(), "blocked")
                        except Exception:
                            pass
                    if result == "ok":
                        stored += 1
                        links.append({"key": item["key"], "platform": account["platform"], "handle": account["handle"], "id": item["post"].get("statusId") or "", "probe": tb.probe_saved(item["video"]), "stats": item["stats"]})
                        log("[media-extract] linked %s" % item["key"])
                    if item["thumb"] and result == "ok":
                        role = "poster" if account["platform"] == "tiktok" else "thumb"
                        thumb_keys = tb.social_key_candidates(item["post"], role, 0)
                        if not any(key in present for key in thumb_keys):
                            thumb_key = thumb_keys[0] if thumb_keys else tb.social_object_key(item["post"], role, 0)
                            publish_file(item["thumb"], thumb_key, role, item["stats"], cf, manifest, state, directory)
            photo_dir = work / "photos"
            photo_dir.mkdir(parents=True)
            if photos_allowed(status) and account["platform"] != "youtube" and stored < limit:
                photo_cmd = gallery + photo_args(account["url"], photo_dir, photos, min(each, limit - stored))
                if account["platform"] == "x":
                    photo_cmd = gallery + ["-o", "twitter.size=orig"] + photo_args(account["url"], photo_dir, photos, min(each, limit - stored))
                _code, out, err = run_tool(photo_cmd, 300, account["url"])
                if tb.runner_blocked(out + "\n" + err):
                    log("[media-extract] skipped_blocked %s/%s" % (account["platform"], account["handle"]))
                    tally["blocked"] += 1
                else:
                    if account["platform"] == "x":
                        promote_orig_photos(photo_dir)
                    for item in photo_groups(photo_dir, account):
                        if stored >= limit:
                            break
                        photo_keys = tb.social_key_candidates(item["post"], "photo", int(item.get("index") or 0))
                        if any(key in present for key in photo_keys):
                            log("[media-extract] already stored %s/%s" % (account["platform"], account["handle"]))
                            tally["skipped"] += 1
                            continue
                        item["key"] = photo_keys[0] if photo_keys else item["key"]
                        result = publish_file(item["path"], item["key"], "photo", item["stats"], cf, manifest, state, directory)
                        count_result(tally, result)
                        if result == "stop":
                            stored = limit
                            break
                        if result == "ok":
                            stored += 1
                            probe = tb.probe_saved(item["path"])
                            if not (probe.get("width") and probe.get("height")):
                                try:
                                    from update_feeds import stored_media_size
                                    found_w, found_h = stored_media_size(item["path"])
                                    if found_w and found_h:
                                        probe = {"width": found_w, "height": found_h}
                                except Exception:
                                    probe = probe or {}
                            links.append({"key": item["key"], "platform": account["platform"], "handle": account["handle"], "id": item["post"].get("statusId") or "", "probe": probe, "stats": item["stats"]})
                            log("[media-extract] linked %s" % item["key"])
            if stored == gained and not videos_blocked:
                log("[media-extract] no file %s/%s" % (account["platform"], account["handle"]))
            shutil.rmtree(work, ignore_errors=True)
            put_text(cf, bucket, ARCHIVE_KEY, text_file(archive))
            put_file(cf, bucket, GALLERY_KEY, photos)
            put_json(cf, bucket, CATALOG_KEY, catalog)
        by_key = {}
        for row in links:
            if row.get("key"):
                by_key[row["key"]] = row
        put_json(cf, bucket, LINKS_KEY, {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "items": list(by_key.values())})
        put_text(cf, bucket, CURSOR_KEY, str((start + visited) % max(len(accounts), 1)))
        log("[media-extract] stored %s files, visited %s added accounts" % (stored, visited))
        log("[media-extract] kept_r2 %s" % (state.get("kept_r2") or 0))
        log_tally(tally)
        log(tb.upload_summary(state))
        tb.log_d1_newest(cf)
        try:
            from tiktok_save_queue import backfill as backfill_save, health as save_health
            known = [row.get("id") for row in links if row.get("platform") == "tiktok" and row.get("id")]
            backfill_save(save_queue, known, time.time())
            put_json(cf, bucket, "backup/tiktok-save-queue.json", save_queue)
            put_json(cf, bucket, "backup/tiktok-save-health.json", save_health(save_queue, time.time()))
        except Exception:
            pass
        return 0
    except Exception as err:
        if "tally" in locals():
            log_tally(tally)
        log("[media-extract] extract failed")
        log(tb.scrub(str(err), tb.current_secrets()))
        return 1
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def selftest() -> int:
    def check(cond, message):
        if not cond:
            raise SystemExit("FAIL: " + message)
        print("ok", message)

    rows = accounts_from({
        "feeds": [
            {"platform": "youtube", "handle": "northlamp", "channelId": "UCsyntheticmaple00001000"},
            {"platform": "telegram", "handle": "laneharbor"},
            {"platform": "x", "handle": "copperlane"},
            {"platform": "instagram", "handle": "birchlane"},
        ]
    }, ["lockclip"])
    urls = {row["url"] for row in rows}
    check("https://www.tiktok.com/@lockclip" in urls, "TikTok is included with the added accounts")
    check("https://www.youtube.com/channel/UCsyntheticmaple00001000/videos" in urls, "YouTube uses the public channel videos page")
    check("https://x.com/copperlane" in urls and "https://www.instagram.com/birchlane/" in urls, "X and Instagram use the public profile")
    added_meta = catalog_meta_accounts({"accounts": [
        {"id": "instagram:orbitfox", "platform": "instagram", "handle": "orbitfox"},
        {"id": "threads:orbitfox", "platform": "threads", "handle": "orbitfox"},
        {"id": "tiktok:laneharbor", "platform": "tiktok", "handle": "laneharbor"},
    ]})
    added_urls = {row["url"] for row in added_meta}
    check(added_urls == {"https://www.instagram.com/orbitfox/", "https://www.threads.net/@orbitfox"}, "owner Instagram and Threads accounts are extracted with the public profile")
    check(all("t.me" not in row["url"] for row in rows), "a Telegram channel is not extracted")
    turned = rotate([{"handle": "a"}, {"handle": "b"}, {"handle": "c"}], 1)
    check([row["handle"] for row in turned] == ["b", "c", "a"], "added accounts rotate so a later run reaches the rest")
    args = video_args("https://www.youtube.com/watch?v=xtrFOsncOeo", Path("out"), Path("archive.txt"), tb.YTDLP_FORMAT, 2)
    check(args[args.index("-f") + 1] == "bv*+ba/b" and args[args.index("--merge-output-format") + 1] == "mp4" and args[args.index("--remux-video") + 1] == "mp4", "videos are remuxed with bv*+ba/b")
    check("--write-info-json" in args and "--write-thumbnail" in args and "--download-archive" in args and str(Path("archive.txt")) in args, "the video command writes info, a thumbnail, and archive.txt")
    check("--no-cookies" in args and "--cookies" not in args and "--cookies-from-browser" not in args, "the video command sends no cookies")
    check(selector_for("tiktok").endswith("/bv*+ba/b") and "bytevc1" in selector_for("tiktok"), "TikTok prefers bytevc1 or h265, then bv*+ba/b")
    formats = [
        {"format_id": "h264-1080", "vcodec": "h264", "acodec": "none", "height": 1080, "tbr": 2500},
        {"format_id": "bytevc1-720", "vcodec": "bytevc1", "acodec": "none", "height": 720, "tbr": 4000},
        {"format_id": "audio", "vcodec": "none", "acodec": "aac", "tbr": 128},
    ]
    picked = tiktok_download_selector(formats)
    check(picked.startswith("bytevc1-720+") and "h264" not in picked.split("/")[0], "TikTok takes the top original bytevc1, not the h264 fallback")
    check("--recode-video" not in video_args("https://www.tiktok.com/@lockclip/video/1", Path("out"), Path("archive.txt"), picked, 1), "TikTok is remuxed and not re-encoded")
    passes = tb.hls_attempts(True)
    check(passes == [(False, 6, False), (False, 4, False), (False, 2, False), (False, 1, False), (False, 1, True)] and all(not row[0] for row in passes), "a social video retries -c copy at 2s, 1s, then keyframe splits and never re-encodes")
    check(tb.social_copy_key("tiktok/lockclip/7695476356548660503/video") and tb.social_copy_key("social/x/1/video/0") and not tb.social_copy_key("music/a.mp3"), "only synced social video is copy-only")
    private = accounts_from({}, ["lockclip"], {"added": [{"handle": "new_name", "permanentId": "123456"}], "removed": ["lockclip"]})
    private_urls = {row["url"] for row in private}
    check("https://www.tiktok.com/@new_name" in private_urls and "https://www.tiktok.com/@lockclip" not in private_urls, "a removed account stays out and a private added account is included")
    photos = photo_args("https://www.instagram.com/birchlane/", Path("photos"), Path("gallery.txt"), 2)
    check("--write-metadata" in photos and "--download-archive" in photos and "--cookies" not in photos and "--config-ignore" in photos, "gallery-dl writes metadata and records the archive")
    catalog = remember_tiktok({}, {"uploader_id": "99", "channel_id": "MS4wLjABAAAA12345678", "uploader": "lockclip"})
    check(catalog["by_user_id"]["99"]["sec_uid"] == "MS4wLjABAAAA12345678" and catalog["by_sec_uid"]["MS4wLjABAAAA12345678"]["user_id"] == "99", "the TikTok catalog is keyed by user_id and sec_uid")
    check(ident_of("instagram", {"id": "123", "webpage_url": "https://www.instagram.com/reel/DeZgzTEggQe/"}) == "DeZgzTEggQe", "an Instagram shortcode is the object id")
    check(cap_of() >= 1 and per_account() >= 1 and pace_seconds() >= 3, "the run has a cap and a pause")
    os.environ["MEDIA_EXTRACT_CAP"] = "500"
    try:
        check(cap_of() == 80, "one extract run stores at most 80 new files")
    finally:
        os.environ.pop("MEDIA_EXTRACT_CAP", None)
    check("--concurrent-fragments" in video_args("https://www.tiktok.com/@lockclip/video/1", Path("out"), Path("archive.txt"), selector_for("tiktok"), 1), "a TikTok download uses one connection")
    check(video_args("https://www.tiktok.com/@lockclip/video/1", Path("out"), Path("archive.txt"), selector_for("tiktok"), 1)[video_args("https://www.tiktok.com/@lockclip/video/1", Path("out"), Path("archive.txt"), selector_for("tiktok"), 1).index("--concurrent-fragments") + 1] == "1", "TikTok does not split a file across connections")
    check(tb.runner_blocked("HTTP Error 403: Forbidden") and tb.runner_blocked("captcha") and not tb.runner_blocked("private account"), "a 403 or captcha is a skip")
    workflow = (ROOT / ".github" / "workflows" / "media-extract.yml").read_text(encoding="utf-8")
    check('cron: "17 */3 * * *"' in workflow and 'cron: "*/30 * * * *"' not in workflow and "workflow_dispatch" in workflow and "yt-dlp==2026.10.21" in workflow and "gallery-dl==1.32.17" in workflow, "the workflow is scheduled every 3 hours and pins the tools")
    check("cancel-in-progress: false" in workflow or "cancel-in-progress: ${{ github.event_name == 'pull_request' }}" in workflow, "an upload that is already running is not cancelled")
    check(photos_allowed("blocked") is True, "a blocked video does not skip photos")
    queued = catalog_queue([
        {"platform": "x", "posted": "2026-10-22T16:00:00Z", "key": "old"},
        {"platform": "telegram", "posted": "2026-10-22T23:00:00Z", "key": "tg"},
        {"platform": "x", "posted": "2026-10-22T22:54:26.000Z", "key": "new"},
        {"platform": "tiktok", "posted": "2026-10-22T18:00:00Z", "key": "tt"},
    ])
    check([row["key"] for row in queued] == ["new", "tt", "old"], "newest synced posts are first and a Telegram channel is not extracted")
    check('echo "$TELEGRAM' not in workflow and "IG_SESSION" not in workflow and "--cookies" not in workflow and "COOKIES" not in workflow, "the workflow does not print secrets or pass cookies")
    doc = (ROOT / "docs" / "telegram-backup.md").read_text(encoding="utf-8")
    check("archive.txt" in doc and "user_id" in doc and "sec_uid" in doc and "17 */3 * * *" in doc, "the docs describe the archive, the catalog, and the schedule")
    check("added account" in doc and "tracked account" not in doc and "name: Extract added accounts" in workflow, "added accounts is the name for profiles in feeds.config.json")
    source = Path(__file__).read_text(encoding="utf-8")
    check(("photos" + ".read_text(") not in source and "gallery-archive.sqlite" in source and "load_added_accounts" in source and "load_added_x" in source, "the gallery-dl archive is a sqlite file, and TikTok and X read the owner list")
    x_rows = accounts_from(
        {"feeds": [{"platform": "x", "handle": "copperlane", "permanentId": "10000000"}]},
        [],
        None,
        {"added": [
            {"handle": "SampleAgency", "permanentId": "20000001"},
            {"handle": "copperlane", "permanentId": "10000000"},
            {"handle": "gone", "permanentId": "77"},
        ], "removed": ["oldname"], "removedIds": ["77"]},
    )
    x_urls = [row["url"] for row in x_rows if row["platform"] == "x"]
    check(x_urls.count("https://x.com/SampleAgency") == 1 and x_urls.count("https://x.com/copperlane") == 1 and "https://x.com/gone" not in x_urls, "a private X account is extracted once and a removed id stays out")
    x_formats = [
        {"format_id": "hls-high", "ext": "mp4", "protocol": "m3u8_native", "vcodec": "avc1", "acodec": "none", "tbr": 8000},
        {"format_id": "low", "ext": "mp4", "vcodec": "avc1", "acodec": "none", "tbr": 500, "height": 360},
        {"format_id": "high", "ext": "mp4", "vcodec": "avc1", "acodec": "none", "tbr": 2500, "height": 720},
        {"format_id": "audio", "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2", "tbr": 128},
    ]
    x_picked = x_video_selector(x_formats)
    check(x_picked.startswith("high+audio/") and "hls-high" not in x_picked.split("/")[0] and "--recode-video" not in video_args("https://x.com/SampleAgency/status/1", Path("out"), Path("archive.txt"), x_picked, 1), "X takes the highest-bitrate MP4 and remuxes it")
    check(twimg_orig("https://pbs.twimg.com/media/abc.jpg?name=small") == "https://pbs.twimg.com/media/abc.jpg?name=orig", "an X photo asks for name=orig")
    check(twimg_orig("https://pbs.twimg.com/media/abc.jpg").endswith("name=orig") and twimg_orig("https://example.com/a.jpg") == "", "only a Twitter photo is rewritten to the original")
    from update_feeds import added_x_feeds, remember_private_x
    config = {"feeds": [{"id": "x:copperlane", "platform": "x", "handle": "copperlane", "permanentId": "10000000"}]}
    private_doc = {"added": [
        {"id": "x:SampleAgency", "handle": "SampleAgency", "permanentId": "20000001", "name": "SampleAgency"},
        {"id": "x:copperlane", "handle": "copperlane", "permanentId": "10000000"},
        {"id": "x:old", "handle": "renamed", "permanentId": "77"},
    ], "removed": [], "removedIds": ["77"]}
    built = added_x_feeds(config, private_doc)
    check(len(built) == 1 and built[0]["handle"] == "SampleAgency" and built[0]["adapter"] == "fxtwitter" and built[0]["source_urls"] == ["{fxtwitterBase}/2/profile/{handle}/statuses"] and built[0]["fallbacks"][0]["adapter"] == "nitter_rss" and "nitter.meowing.monster" in built[0]["fallbacks"][0]["source_urls"][0], "added X accounts use fxtwitter and the nitter fallbacks")
    check(config["feeds"][0]["handle"] == "copperlane" and "_privateAdded" not in config["feeds"][0], "private X rows are not written into the public config")
    renamed = {"_privateAdded": True, "id": "x:SampleAgency", "platform": "x", "handle": "sampleagencynew", "permanentId": "20000001", "previousHandles": ["SampleAgency"]}
    check(remember_private_x(private_doc, renamed) and private_doc["added"][0]["handle"] == "sampleagencynew" and private_doc["added"][0]["previousHandles"] == ["SampleAgency"] and private_doc["added"][0]["id"] == "x:SampleAgency", "a handle change stays on the private row and keeps the feed id")
    sample = Path("gallery-sample.sqlite")
    try:
        blob = b"SQLite format 3\x00" + bytes(range(83)) + b"\x89"
        sample.write_bytes(blob)
        check(sample.read_bytes()[99:100] == b"\x89" and text_file(sample).startswith("SQLite"), "a sqlite archive survives a binary byte")
    finally:
        sample.unlink(missing_ok=True)
    check("store_community_originals" in source and "backup_originals" in source, "community originals go through the media pipeline")
    check(source.count("probe_saved(") >= 2 and "stored_media_size" in source, "stored photos and videos keep probed width and height without re-encoding")
    def missing_id(*_args, **_kwargs):
        raise RuntimeError("telegram returned no file id")
    saved_store = tb.store_loaded
    saved_probe = tb.probe_saved
    tb.store_loaded = missing_id
    tb.probe_saved = lambda _path: {}
    try:
        with tempfile.TemporaryDirectory() as note_dir:
            clip = Path(note_dir) / "clip.mp4"
            clip.write_bytes(b"not-a-real-video")
            result = publish_file(clip, "social/x/1/video/0", "video", {}, {}, {"files": []}, {}, Path(note_dir))
        check(result == "fail", "a missing Telegram file id skips that file and the extract continues")
    finally:
        tb.store_loaded = saved_store
        tb.probe_saved = saved_probe
    print("media extract selftest ok")
    return 0


def main(argv: list | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if "--selftest" in args:
        return selftest()
    return extract()


if __name__ == "__main__":
    try:
        from log_redact import auto as _redact_logs

        _redact_logs()
    except ImportError:
        pass
    sys.exit(main())
