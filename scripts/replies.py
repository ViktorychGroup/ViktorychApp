"""Write comments/<postId>.json for posts the browser cannot fetch.

X replies and YouTube comments are loaded in the browser, so this refresh
skips those platforms. Instagram tries the logged-out GraphQL post query, the
captioned embed, and public viewers before INSTAGRAM_COOKIE. Threads tries
the public mobile post page, then the local RSSHub post route, then
THREADS_COOKIE. VK uses wall.getComments with the same token the wall sync
already obtained. RSS uses wfw:commentRss. Only posts under 7 days old are
stored. A failed fetch keeps the previous comment file. Nothing here invents
a reply. Own-fetcher copies for the browser live in fallback/, not here.
"""

from __future__ import annotations

import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from adapters.ig_comments import parse_ig_comments, parse_ig_document  # noqa: E402
from adapters.rss_comments import parse_comment_rss  # noqa: E402
from adapters.threads_replies import parse_threads_document  # noqa: E402
from adapters.x_api_v2 import parse_conversation_search  # noqa: E402
from adapters.x_replies import (  # noqa: E402
    belongs,
    comments_due,
    comments_kept,
    conversation_reply_count,
    extract_fxtwitter_replies,
    fill_missing,
    merge_replies,
    parse_fxtwitter_conversation,
    parse_nitter_replies,
    parse_nitter_status,
    rank_replies,
    select_subthreads,
    status_object,
    _parent_handle,
)
from site_paths import user_agent  # noqa: E402
from x_guard import assert_not_x_api, auth_cookie_header, conversation_search, open_url  # noqa: E402

UA = user_agent()
BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
NEST_CAP = 20
NITTER_HOSTS = (
    "https://nitter.meowing.monster",
    "https://nitter.kareem.one",
    "https://nitter.jaydenha.uk",
)
IG_APP = "936619743392459"
ACTION_DOC = "8845758582119845"
ROOT_DOC = "29336004576007686"
VIEWERS = (
    "https://www.picuki.com/media/{code}",
    "https://imginn.com/p/{code}/",
    "https://dumpor.com/v/{code}",
    "https://dumpor.io/v/{code}",
    "https://anonyig.com/p/{code}",
    "https://anonyig.com/en/post/{code}",
)
FIXTURES = ROOT / "scripts" / "fixtures" / "replies"
_IG = {}


def _get(url: str, headers: dict | None = None, data: bytes | None = None, timeout: int = 30, opener=None) -> str:
    req_headers = {"User-Agent": UA, "Accept": "*/*"}
    req_headers.update(auth_cookie_header(url))
    if headers:
        req_headers.update(headers)
    assert_not_x_api(url)
    request = urllib.request.Request(url, data=data, headers=req_headers)
    client = opener.open if opener else open_url
    with client(request, timeout=timeout) as response:
        return response.read().decode("utf-8", "replace")


def _try(url: str, headers: dict | None = None, data: bytes | None = None, timeout: int = 20, opener=None) -> str | None:
    try:
        return _get(url, headers, data, timeout, opener)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None


def _shortcode(post: dict) -> str:
    match = re.search(r"/(?:p|reel|tv)/([A-Za-z0-9_-]+)", post.get("url") or "")
    return match.group(1) if match else ""


def _ig_session() -> dict:
    if _IG.get("ready"):
        return _IG
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    html = _try("https://www.instagram.com/", {"User-Agent": BROWSER, "Accept": "text/html"}, opener=opener, timeout=20)
    lsd = ""
    if html:
        found = re.search(r'"LSD",\[\],\{"token":"([^"]+)"\}', html)
        lsd = found.group(1) if found else ""
    csrf = next((cookie.value for cookie in jar if cookie.name == "csrftoken"), "")
    _IG.update(ready=True, opener=opener, lsd=lsd, csrf=csrf)
    return _IG


def _ig_graphql(shortcode: str, doc_id: str, friendly: str, variables: dict) -> str | None:
    session = _ig_session()
    if not session.get("csrf"):
        return None
    form = urllib.parse.urlencode(
        {
            "lsd": session.get("lsd") or "",
            "fb_api_caller_class": "RelayModern",
            "fb_api_req_friendly_name": friendly,
            "variables": json.dumps(variables, separators=(",", ":")),
            "doc_id": doc_id,
            "server_timestamps": "true",
        }
    ).encode()
    text = _try(
        "https://www.instagram.com/graphql/query",
        {
            "User-Agent": BROWSER,
            "Content-Type": "application/x-www-form-urlencoded",
            "X-CSRFToken": session["csrf"],
            "X-IG-App-ID": IG_APP,
            "X-FB-LSD": session.get("lsd") or "",
            "X-FB-Friendly-Name": friendly,
            "Accept": "*/*",
            "Origin": "https://www.instagram.com",
            "Referer": f"https://www.instagram.com/p/{shortcode}/",
        },
        form,
        timeout=25,
        opener=session["opener"],
    )
    if not text or not text.lstrip().startswith("{"):
        return None
    return text


def _keep(payload, post: dict):
    replies, count = parse_ig_document(payload, post)
    if not replies and count is None:
        return None
    if not replies and isinstance(payload, str):
        if not any(token in payload for token in ("comment_count", "edge_media_to_parent_comment", "CaptionComment", "comment-text")):
            return None
    return replies, count


def _rsshub_base() -> str:
    path = ROOT / "feeds.config.json"
    base = "http://localhost:1200"
    if path.exists():
        try:
            base = json.loads(path.read_text(encoding="utf-8")).get("rsshubBase") or base
        except json.JSONDecodeError:
            pass
    return str(base).rstrip("/")


def _rsshub_comments(post: dict, paths: tuple[str, ...]):
    base = _rsshub_base()
    parent_text = (post.get("text") or "").strip()
    for path in paths:
        body = _try(base + path, {"Accept": "application/rss+xml, application/xml, text/xml"}, timeout=4)
        if not body or "<item" not in body.lower():
            continue
        replies = [
            reply
            for reply in parse_comment_rss(body, post)
            if (reply.get("text") or "").strip() and (reply.get("text") or "").strip() != parent_text
        ]
        if replies:
            return replies, "rsshub:" + path
    return None


def _lookup_x(post: dict):
    """Fill a thin reply from fxtwitter, then a Nitter status page."""
    status_id = str(post.get("id") or "")
    handle = post.get("handle") or "i"
    if not status_id:
        return None
    for url in (
        f"https://api.fxtwitter.com/status/{status_id}",
        f"https://api.fxtwitter.com/{handle}/status/{status_id}",
    ):
        body = _try(url)
        if not body:
            continue
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            continue
        status = status_object(payload)
        if status:
            return status
    for host in NITTER_HOSTS:
        html = _try(f"{host}/{handle}/status/{status_id}", {"User-Agent": "Mozilla/5.0"})
        if not html or "tweet-content" not in html:
            continue
        found = parse_nitter_status(html, status_id)
        if found:
            return found
    return None


def fetch_x(post: dict, cap: int = 500):
    status_id = str(post.get("statusId") or post.get("id") or "")
    handle = post.get("handle") or "i"
    try:
        urls = [
            f"https://api.fxtwitter.com/2/conversation/{status_id}",
            f"https://api.fxtwitter.com/2/conversation/{status_id}?ranking_mode=recency",
        ]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda u: _try(u, timeout=12), urls))

        primary_payload = None
        all_rows = {}
        for raw in results:
            if not raw:
                continue
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not primary_payload and payload.get("status"):
                primary_payload = payload
            for r in extract_fxtwitter_replies(payload, status_id):
                all_rows[str(r.get("id") or "")] = r

        if not primary_payload and results and results[0]:
            try:
                primary_payload = json.loads(results[0])
            except json.JSONDecodeError:
                primary_payload = {}
        author = _parent_handle(primary_payload or {}) or handle

        sub_candidates = []
        if not _budget_spent():
            sub_candidates = [
                sid for sid, r in all_rows.items()
                if int((r.get("stats") or {}).get("replies") or r.get("reply_count") or 0) > 0
            ][:25]
        if sub_candidates:
            sub_urls = [f"https://api.fxtwitter.com/2/conversation/{sid}" for sid in sub_candidates]
            with ThreadPoolExecutor(max_workers=8) as pool:
                sub_results = list(pool.map(lambda u: _try(u, timeout=8), sub_urls))
            for sid, raw in zip(sub_candidates, sub_results):
                if not raw:
                    continue
                try:
                    sub_payload = json.loads(raw)
                    sub_rows = extract_fxtwitter_replies(sub_payload, sid)
                    for r in sub_rows:
                        r["conversationId"] = status_id
                        sid_key = str(r.get("id") or "")
                        if sid_key and sid_key not in all_rows:
                            all_rows[sid_key] = r
                except Exception:
                    pass

        rows = list(all_rows.values())

        def lookup(reply):
            if (reply.get("text") or "").strip() and reply.get("handle"):
                return None
            return _lookup_x(reply)

        rows = rank_replies(fill_missing(rows, status_id, lookup), author, cap)
        return rows, "fxtwitter", conversation_reply_count(primary_payload or {})
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"[replies] fxtwitter {status_id}: {exc}", file=sys.stderr)
    for host in NITTER_HOSTS:
        html = _try(f"{host}/{handle}/status/{status_id}", {"User-Agent": "Mozilla/5.0"})
        if not html or "tweet-content" not in html:
            continue
        return parse_nitter_replies(html, status_id, cap), host, None
    raw = conversation_search(status_id)
    if raw:
        try:
            rows = [
                row
                for row in parse_conversation_search(raw, status_id)
                if str(row.get("id") or "") != status_id and belongs(row, status_id) is True
            ]
        except (ValueError, json.JSONDecodeError) as exc:
            print(f"[replies] x search {status_id}: {exc}", file=sys.stderr)
            rows = []
        if rows:
            return rank_replies(rows, handle, cap), "x-api-v2", None
    return None


def fetch_instagram(post: dict):
    code = _shortcode(post)
    count = None
    count_source = ""
    if code:
        action = _ig_graphql(
            code,
            ACTION_DOC,
            "PolarisPostActionLoadPostQueryQuery",
            {"shortcode": code, "fetch_tagged_user_count": None, "hoisted_comment_id": None, "hoisted_reply_id": None},
        )
        if action:
            kept = _keep(action, post)
            if kept:
                replies, got = kept
                if got is not None:
                    count, count_source = got, "graphql:PolarisPostActionLoadPostQuery"
                if replies:
                    return replies, "graphql:PolarisPostActionLoadPostQuery", got if got is not None else count
        root = _ig_graphql(
            code,
            ROOT_DOC,
            "PolarisPostRootQuery",
            {
                "shortcode": code,
                "__relay_internal__pv__PolarisShortDramaEnabledrelayprovider": False,
                "__relay_internal__pv__PolarisThreadsStyleCommentsEnabledrelayprovider": False,
                "__relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider": False,
            },
        )
        if root:
            kept = _keep(root, post)
            if kept:
                replies, got = kept
                if got is not None:
                    count, count_source = got, "graphql:PolarisPostRootQuery"
                if replies:
                    return replies, "graphql:PolarisPostRootQuery", got if got is not None else count
        embed = _try(
            f"https://www.instagram.com/p/{code}/embed/captioned/",
            {"User-Agent": BROWSER, "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9"},
            timeout=20,
        )
        if embed and '"pageID":"httpErrorPage"' not in embed:
            kept = _keep(embed, post)
            if kept:
                replies, got = kept
                if got is not None:
                    count, count_source = got, "embed"
                if replies:
                    return replies, "embed", got if got is not None else count
        for pattern in VIEWERS:
            page = _try(pattern.format(code=code), {"User-Agent": BROWSER, "Accept": "text/html"}, timeout=12)
            if not page:
                continue
            kept = _keep(page, post)
            if not kept:
                continue
            replies, got = kept
            host = urllib.parse.urlparse(pattern).netloc
            if got is not None:
                count, count_source = got, "viewer:" + host
            if replies:
                return replies, "viewer:" + host, got if got is not None else count
    try:
        from owner_keys import credential
        cookie = credential("instagram", "INSTAGRAM_COOKIE")
    except Exception:
        cookie = os.environ.get("INSTAGRAM_COOKIE") or ""
    if cookie:
        status_id = str(post.get("statusId") or post.get("id") or "")
        header = cookie if "sessionid=" in cookie else f"sessionid={cookie}"
        payload = _try(
            f"https://www.instagram.com/api/v1/media/{status_id}/comments/?can_support_threading=true",
            {"Cookie": header, "X-IG-App-ID": IG_APP, "User-Agent": BROWSER},
            timeout=20,
        )
        if payload and payload.lstrip().startswith("{"):
            replies = parse_ig_comments(payload, post)
            if replies:
                return replies, "instagram-cookie", count
    if count is not None:
        return [], count_source or "instagram", count
    return None


def _threads_code(post: dict) -> str:
    url = str(post.get("url") or "")
    match = re.search(r"/(?:post|t)/([^/?#]+)", url)
    if match and match.group(1):
        return match.group(1)
    return str(post.get("statusId") or post.get("id") or "")


MOBILE = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"


def fetch_threads(post: dict):
    handle = post.get("handle") or ""
    code = _threads_code(post)
    count = None
    count_source = ""
    # The public mobile page includes the reply tree. The desktop page often does not.
    urls = [
        (f"https://www.threads.com/@{handle}/post/{code}", MOBILE),
        (f"https://www.threads.net/@{handle}/post/{code}", MOBILE),
        (f"https://www.threads.net/t/{code}", MOBILE),
        (f"https://www.threads.com/@{handle}/post/{code}", BROWSER),
        (f"https://www.threads.net/@{handle}/post/{code}", BROWSER),
    ]
    seen = set()
    for url, agent in urls:
        if not code or (url, agent) in seen:
            continue
        seen.add((url, agent))
        html = _try(url, {"User-Agent": agent, "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9"}, timeout=20)
        if not html or code not in html:
            continue
        replies, got = parse_threads_document(html, post)
        if got is not None:
            count, count_source = got, "threads.net"
        if replies:
            return replies, "threads.net", got if got is not None else count
    rss = _rsshub_comments(post, (f"/threads/{handle}/post/{code}",))
    if rss:
        replies, source = rss
        return replies, source, count
    try:
        from owner_keys import credential
        cookie = credential("threads", "THREADS_COOKIE")
    except Exception:
        cookie = os.environ.get("THREADS_COOKIE") or ""
    if cookie and code:
        header = cookie if "=" in cookie else f"sessionid={cookie}"
        url = post.get("url") or f"https://www.threads.com/@{handle}/post/{code}"
        html = _try(url, {"Cookie": header, "User-Agent": BROWSER, "Accept": "text/html"}, timeout=20)
        if html:
            replies, got = parse_threads_document(html, post)
            if got is not None:
                count, count_source = got, "threads-cookie"
            if replies:
                return replies, "threads-cookie", got if got is not None else count
    if count is not None:
        return [], count_source or "threads.net", count
    return None


def fetch_rss(post: dict):
    url = post.get("commentRss") or ""
    if not url:
        return None
    try:
        payload = _get(url)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        print(f"[replies] rss {post.get('id')}: {exc}", file=sys.stderr)
        return None
    return parse_comment_rss(payload, post), "commentRss", None


def from_fixture(post: dict):
    status_id = str(post.get("statusId") or post.get("id") or "")
    conversation = FIXTURES / f"{status_id}.json"
    if conversation.exists():
        raw = conversation.read_text(encoding="utf-8")
        replies = parse_fxtwitter_conversation(raw, status_id, post.get("handle") or "")
        return replies, "fixture", conversation_reply_count(raw)
    nitter = FIXTURES / f"{status_id}.html"
    if nitter.exists():
        return parse_nitter_replies(nitter.read_text(encoding="utf-8"), status_id), "fixture-nitter", None
    return None


def _comment_path(post: dict) -> Path:
    status_id = str(post.get("statusId") or post.get("id") or "")
    name = f"yt_{status_id}.json" if post.get("platform") == "youtube" else f"{status_id}.json"
    return ROOT / "comments" / name


def _stored_replies(path: Path) -> list:
    if not path.exists():
        return []
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    replies = doc.get("replies")
    return replies if isinstance(replies, list) else []


def _stored_fetched_at(path: Path) -> str:
    if not path.exists():
        return ""
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    return str(doc.get("fetchedAt") or "")


def _safe_id(status_id: str) -> str:
    text = str(status_id or "")
    if not text or text in (".", "..") or "/" in text or "\\" in text:
        return ""
    return text


def _detach_children(replies: list) -> list:
    nested = []
    for reply in replies or []:
        if not isinstance(reply, dict):
            continue
        kids = reply.pop("_children", None)
        if kids:
            nested.append((reply, kids[:NEST_CAP]))
    return nested


def write_comments(post: dict, replies: list, source: str, cap: int | None = None) -> None:
    status_id = _safe_id(post.get("statusId") or post.get("id") or "")
    if not status_id:
        return
    dest = ROOT / "comments"
    dest.mkdir(parents=True, exist_ok=True)
    path = dest / f"{status_id}.json"
    merged = merge_replies(_stored_replies(path), replies)
    if post.get("platform") == "x" or cap:
        merged = rank_replies(merged, post.get("handle") or "", cap or 50)
    doc = {
        "postId": status_id,
        "platform": post.get("platform") or "",
        "source": source,
        "fetchedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "replies": merged,
    }
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[replies] {post.get('platform')}:{status_id} {len(merged)} via {source}")


def _write_nested(parent: dict, nested: list, source: str) -> None:
    for reply, kids in nested:
        child = {
            "id": reply.get("id"),
            "statusId": reply.get("statusId") or reply.get("id"),
            "platform": parent.get("platform") or reply.get("platform") or "",
            "handle": reply.get("handle") or "",
            "author": reply.get("author") or "",
            "date": reply.get("date") or "",
            "url": reply.get("url") or "",
        }
        write_comments(child, kids, source + ":nested", NEST_CAP)


def _refresh_subthreads(parent: dict, replies: list, use_fixtures: bool, already: set) -> None:
    """Second-level replies only. Deeper pages stay empty until a later fetch."""
    platform = parent.get("platform") or ""
    if platform not in ("x", "threads"):
        return
    for reply in select_subthreads(replies):
        status_id = _safe_id(reply.get("statusId") or reply.get("id") or "")
        if not status_id or status_id in already:
            continue
        child = {
            "id": reply.get("id") or status_id,
            "statusId": status_id,
            "platform": platform,
            "handle": reply.get("handle") or parent.get("handle") or "",
            "author": reply.get("author") or "",
            "date": reply.get("date") or "",
            "url": reply.get("url") or "",
        }
        path = ROOT / "comments" / f"{status_id}.json"
        if not use_fixtures and not comments_due(child.get("date") or "", _stored_fetched_at(path)):
            continue
        found = from_fixture(child) if use_fixtures else None
        if found is None and not use_fixtures:
            if platform == "x":
                found = fetch_x(child, NEST_CAP)
                time.sleep(0.3)
            elif platform == "threads":
                found = fetch_threads(child)
        if not found:
            continue
        rows, source, count = found
        if count is not None:
            reply.setdefault("stats", {})["replies"] = count
        write_comments(child, rows[:NEST_CAP], source, NEST_CAP)


def fetch_vk(post: dict):
    status_id = str(post.get("statusId") or post.get("id") or "")
    if "_" not in status_id:
        return None
    owner_id, post_id = status_id.rsplit("_", 1)
    if not owner_id or not post_id:
        return None
    try:
        from adapters.vk import parse_comments
        from vk_remote import comments_document

        payload = comments_document(owner_id, post_id, 20)
    except Exception as exc:
        print(f"[replies] vk:{status_id} {exc}", file=sys.stderr)
        return None
    replies = parse_comments(payload, post)
    count = None
    response = payload.get("response") if isinstance(payload, dict) else None
    if isinstance(response, dict) and response.get("count") is not None:
        try:
            count = int(response["count"])
        except (TypeError, ValueError):
            count = None
    if replies or count is not None:
        return replies, "vk", count
    return None


def _budget_spent() -> bool:
    try:
        from update_feeds import over_deadline
    except Exception:
        return False
    return over_deadline()


def stored_first(posts: list) -> list:
    """Sources the browser cannot read live (VK, Instagram, Threads, RSS) first.

    The feed lists hundreds of X posts ahead of them, and the job clock used to
    stop the run before VK was reached, so VK posts kept a reply count with no
    stored replies. X goes last; the browser loads X replies live anyway.
    """
    rows = [post for post in posts or [] if isinstance(post, dict)]
    return [post for post in rows if (post.get("platform") or "") != "x"] + [post for post in rows if (post.get("platform") or "") == "x"]


def refresh(posts: list, use_fixtures: bool, fresh_ids: set | None = None) -> None:
    seen = set()
    missed = {"instagram": 0, "threads": 0}
    for post in stored_first(posts):
        if not use_fixtures and _budget_spent():
            print("[replies] stopped; refresh budget spent", file=sys.stderr)
            break
        status_id = str(post.get("statusId") or post.get("id") or "")
        platform = post.get("platform") or ""
        if not status_id or status_id in seen:
            continue
        seen.add(status_id)
        if platform == "youtube":
            continue
        if not use_fixtures and not comments_kept(post, allow_x=True):
            continue
        found = from_fixture(post) if use_fixtures else None
        if found is None and not use_fixtures:
            if platform == "x":
                found = fetch_x(post)
            elif platform == "instagram":
                found = fetch_instagram(post)
            elif platform == "threads":
                found = fetch_threads(post)
            elif platform == "vk":
                found = fetch_vk(post)
            elif post.get("commentRss"):
                found = fetch_rss(post)
        if found is None:
            if platform in missed:
                missed[platform] += 1
            continue
        replies, source, count = found
        if count is not None:
            stats = post.setdefault("stats", {})
            if stats.get("replies") != count:
                stats["replies"] = count
                print(f"[replies] {platform}:{status_id} count {count} via {source}")
        if replies or count == 0:
            nested = _detach_children(replies)
            write_comments(post, replies, source)
            _write_nested(post, nested, source)
            _refresh_subthreads(post, replies, use_fixtures, {str(reply.get("id") or "") for reply, _kids in nested})
        elif count is not None:
            print(f"[replies] {platform}:{status_id} count only via {source}")
    if missed["instagram"]:
        try:
            from owner_keys import credential as owner_credential
            ig_set = bool(owner_credential("instagram", "INSTAGRAM_COOKIE"))
        except Exception:
            ig_set = bool(os.environ.get("INSTAGRAM_COOKIE"))
        extra = "" if ig_set else " INSTAGRAM_COOKIE is not set."
        print(f"[replies] instagram: {missed['instagram']} posts had no public comments.{extra}", file=sys.stderr)
    if missed["threads"]:
        try:
            from owner_keys import credential as owner_credential
            threads_set = bool(owner_credential("threads", "THREADS_COOKIE"))
        except Exception:
            threads_set = bool(os.environ.get("THREADS_COOKIE"))
        extra = "" if threads_set else " THREADS_COOKIE is not set."
        print(f"[replies] threads: {missed['threads']} posts had no public replies.{extra}", file=sys.stderr)


def main(argv: list | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        feeds_path = ROOT / "feeds.json"
        if feeds_path.is_file():
            doc = json.loads(feeds_path.read_text(encoding="utf-8"))
            refresh(doc.get("posts") or [], False)
        return 0
    for arg in args:
        status_id = re.search(r"/status/(\d+)", arg)
        sid = status_id.group(1) if status_id else arg.strip()
        if sid.isdigit():
            match_handle = re.search(r"x\.com/([^/]+)/status/", arg)
            handle = match_handle.group(1) if match_handle else "cb_doge"
            post = {"id": sid, "statusId": sid, "platform": "x", "handle": handle}
            res = fetch_x(post, cap=500)
            if res:
                rows, source, count = res
                write_comments(post, rows, source, cap=500)
                print(f"[replies] Wrote {len(rows)} comments for {sid}")
            else:
                print(f"[replies] Failed to fetch comments for {sid}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
