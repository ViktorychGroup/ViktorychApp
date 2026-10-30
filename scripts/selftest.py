#!/usr/bin/env python3
"""Quick checks for every adapter. Exits non-zero on failure."""

from __future__ import annotations

import base64
import html as html_lib
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from adapters.common import parse_json_loose  # noqa: E402
from adapters.article import article_from_status, normalize_article  # noqa: E402
from adapters.fxtwitter import convert_status, parse as parse_fx  # noqa: E402
from adapters.generic_rss import parse as parse_generic  # noqa: E402
from adapters.nitter_rss import parse as parse_nitter  # noqa: E402
from adapters.rsshub_instagram import parse as parse_ig  # noqa: E402
from adapters.rsshub_threads import parse as parse_threads  # noqa: E402
from adapters.rsshub_x import parse as parse_rsshub_x  # noqa: E402
from adapters.ig_comments import parse_ig_comments, parse_ig_document  # noqa: E402
from adapters.rss_comments import parse_comment_rss  # noqa: E402
from adapters.threads_replies import parse_threads_document, parse_threads_replies  # noqa: E402
from adapters.x_api_v2 import parse as parse_x  # noqa: E402
from adapters.x_api_v2 import parse_conversation_search  # noqa: E402
from adapters.youtube_rss import parse as parse_youtube  # noqa: E402
from yt_remote import carry_youtube_fields, normalize_invidious_comment  # noqa: E402
from adapters.x_replies import (  # noqa: E402
    _cap,
    belongs,
    comments_due,
    comments_kept,
    conversation_reply_count,
    engagement,
    fill_missing,
    merge_replies,
    parse_fxtwitter_conversation,
    parse_nitter_replies,
    parse_nitter_status,
    select_subthreads,
)
from meta_media import cdn_expiry, extract_cdn_urls, media_groups, needs_refresh  # noqa: E402
from x_guard import assert_not_x_api, auth_cookie_header, conversation_search, proxy_token_header  # noqa: E402
from x_fetch import is_retryable, retry_delay, status_of  # noqa: E402
from update_feeds import ensure_x_lanes, x_fallback_rows, x_source_urls  # noqa: E402
from share_pages import SITE_NAME as SHARE_SITE  # noqa: E402
from share_pages import build as build_share_pages  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "scripts" / "fixtures"


def deployed_paths() -> str:
    import assemble_site

    return assemble_site.published_text(ROOT)


def check(cond, message):
    if not cond:
        raise SystemExit("FAIL: " + message)
    print("ok", message)


def x_notes_checks() -> None:
    import subprocess

    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "x_notes_mirror.py"), "--selftest"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        sys.stdout.write(proc.stdout)
        sys.stdout.write(proc.stderr)
    check(proc.returncode == 0, "the X Community Notes mirror self-test passes")


def telegram_checks() -> None:
    import subprocess

    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "telegram_backup.py"), "--selftest"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        sys.stdout.write(proc.stdout)
        sys.stdout.write(proc.stderr)
    check(proc.returncode == 0, "the telegram backup self-test passes")


def accounts_wall_checks() -> None:
    import accounts_publish

    workflow = (ROOT / ".github" / "workflows" / "sync.yml").read_text(encoding="utf-8")
    discord = (ROOT / "scripts" / "discord_publish.py").read_text(encoding="utf-8")
    check("\n  wait-accounts:\n" in workflow, "Pages waits for the Accounts worker before it builds")
    check(
        "needs: [gate, wait-accounts]" in workflow and "needs: [gate, build, wait-accounts]" in workflow,
        "the build and the Pages deploy both wait for Accounts",
    )
    check(
        "workflows/accounts.yml/runs?head_sha=" in workflow and "refusing to publish Pages" in workflow,
        "a failed Accounts deploy stops Pages",
    )
    check(
        workflow.index("\n  wait-accounts:\n") < workflow.index("python3 scripts/accounts_publish.py"),
        "the Accounts wait is ordered before the login wall publish",
    )
    check(
        "--preserve-remote" in workflow
        and "\n  refresh:\n" in workflow
        and "timeout-minutes: 15" in workflow
        and "timeout-minutes: 55" not in workflow
        and "FEED_DEADLINE_SECONDS" in workflow
        and "TIKTOK_BUDGET" in workflow
        and "cancel-in-progress: true" in workflow,
        "Pages deploy does not wait on the feed refresh",
    )
    check(
        "PYTHONUNBUFFERED" in workflow
        and "timeout --kill-after=20s 400 python3 scripts/update_feeds.py" in workflow
        and "timeout --kill-after=20s 190 python3 scripts/tiktok_sync.py" in workflow
        and "timeout --kill-after=20s 90 python3 scripts/r2_catalog.py push" in workflow,
        "the refresh step leaves time to push the catalog",
    )
    replies_src = (ROOT / "scripts" / "replies.py").read_text(encoding="utf-8")
    check("over_deadline()" in replies_src and "refresh budget spent" in replies_src, "reply refresh stops when the feed budget is spent")
    check("paths-ignore:" in workflow and "data/communities/**" in workflow, "data-only commits do not start a deploy")
    check("python3 scripts/assemble_site.py --site _site" in workflow and "shared/lazy-modules.js" in deployed_paths(), "the deploy publishes the lazy route loader")
    check(workflow.count("python3 scripts/catalog_migrate.py --catalog-only") >= 2 and workflow.index("python3 scripts/catalog_migrate.py --catalog-only") < workflow.index("python3 scripts/accounts_publish.py") and workflow.index("python3 scripts/catalog_migrate.py --catalog-only") < workflow.rindex("python3 scripts/r2_catalog.py pull"), "the live catalog is copied into R2 before the shell switch and before refresh")
    migrate_wf = (ROOT / ".github" / "workflows" / "catalog-migrate.yml").read_text(encoding="utf-8")
    check(
        "pull_request:" in migrate_wf
        and "workflow_dispatch:" in migrate_wf
        and "\n      - main\n" in migrate_wf
        and "github.event_name == 'pull_request'" in migrate_wf
        and "python3 scripts/catalog_migrate.py --dry-run" in migrate_wf
        and "github.event_name == 'push' || github.event_name == 'workflow_dispatch'" in migrate_wf
        and "python3 scripts/catalog_migrate.py\n" in migrate_wf,
        "a pull request only counts the catalog, and main copies it before the shell can switch",
    )
    check(
        accounts_publish.DEFAULT_HEALTH_ATTEMPTS >= 24 and accounts_publish.DEFAULT_HEALTH_INTERVAL >= 15,
        "health is retried for longer than a worker deploy",
    )
    check(
        "refusing to publish Pages without the login wall" in discord,
        "a discord refresh does not publish over a locked shell",
    )

    def shell(root: Path) -> None:
        root.mkdir(parents=True, exist_ok=True)
        (root / "accounts.config.js").write_text(
            'window.VIKTORYCH_ACCOUNTS = {\n  api: "",\n  gate: false,\n  turnstileSiteKey: "",\n  tiktokAudience: "owner"\n};\n',
            encoding="utf-8",
        )
        (root / "sw.js").write_text("const ACCOUNTS_WALL = false;\n", encoding="utf-8")

    def open_shell(root: Path) -> bool:
        text = (root / "accounts.config.js").read_text(encoding="utf-8")
        worker = (root / "sw.js").read_text(encoding="utf-8")
        return "gate: false" in text and "gate: true" not in text and worker == "const ACCOUNTS_WALL = false;\n"

    keys = [
        "ACCOUNTS_API",
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_ACCOUNT_ID",
        "TURNSTILE_SITEKEY",
        "ACCOUNTS_HEALTH_ATTEMPTS",
        "ACCOUNTS_HEALTH_INTERVAL",
    ]
    saved_env = {key: os.environ.get(key) for key in keys}

    def setenv(values: dict) -> None:
        for key in keys:
            os.environ.pop(key, None)
        for key, value in values.items():
            os.environ[key] = value

    previous = os.getcwd()
    original_health = accounts_publish.fetch_health
    original_upload = accounts_publish.upload
    original_remote = accounts_publish.remote_exists
    try:
        with tempfile.TemporaryDirectory() as tmp:
            os.chdir(tmp)
            site = Path(tmp) / "site"
            source = Path(tmp) / "source"
            source.mkdir()
            (source / "feeds.json").write_text('{"feeds":[{"id":"x:sample"}],"posts":[{"id":"1"}]}\n', encoding="utf-8")
            api = "https://viktorych-accounts.example.workers.dev"

            shell(site)
            setenv({})
            check(accounts_publish.publish(site, source) == 0 and open_shell(site), "an unconfigured site can still publish without the wall")

            shell(site)
            setenv({"ACCOUNTS_API": api})
            check(accounts_publish.publish(site, source) == 1 and open_shell(site), "ACCOUNTS_API set refuses an unlocked shell when credentials are missing")

            shell(site)
            setenv({"CLOUDFLARE_API_TOKEN": "not-a-real-token"})
            check(accounts_publish.publish(site, source) == 1 and open_shell(site), "a Cloudflare token refuses an unlocked shell")

            shell(site)
            setenv({
                "ACCOUNTS_API": api,
                "CLOUDFLARE_API_TOKEN": "not-a-real-token",
                "CLOUDFLARE_ACCOUNT_ID": "not-a-real-account",
                "ACCOUNTS_HEALTH_ATTEMPTS": "2",
                "ACCOUNTS_HEALTH_INTERVAL": "0",
            })
            calls = {"n": 0}

            def down(_api):
                calls["n"] += 1
                return None

            accounts_publish.fetch_health = down
            try:
                code = accounts_publish.publish(site, source)
            finally:
                accounts_publish.fetch_health = original_health
            check(code == 1 and calls["n"] == 2 and open_shell(site), "health is retried and a dead API fails the deploy")

            shell(site)
            uploaded = []

            def up(_api):
                return {"ready": True, "data": True}

            def fake_upload(key, _payload):
                uploaded.append(key)

            accounts_publish.fetch_health = up
            accounts_publish.upload = fake_upload
            try:
                code = accounts_publish.publish(site, source)
            finally:
                accounts_publish.fetch_health = original_health
                accounts_publish.upload = original_upload
            seen = accounts_publish.read_gate(site)
            text = (site / "accounts.config.js").read_text(encoding="utf-8")
            worker = (site / "sw.js").read_text(encoding="utf-8")
            check(
                code == 0
                and seen["gate"] is True
                and seen["api"] == api
                and "gate: true" in text
                and worker == "const ACCOUNTS_WALL = true;\n"
                and uploaded == ["feeds.json", "lastgood/feeds.json"]
                and Path("accounts-wall/on").is_file(),
                "a ready API locks the shell with the workers API and the service worker wall",
            )

            shell(site)
            uploaded.clear()
            (source / "feeds.json").write_text('{"feeds":[],"posts":[]}\n', encoding="utf-8")
            accounts_publish.fetch_health = up
            accounts_publish.upload = fake_upload
            try:
                code = accounts_publish.publish(site, source)
            finally:
                accounts_publish.fetch_health = original_health
                accounts_publish.upload = original_upload
            check(code == 0 and uploaded == [], "an empty catalog is not published")
            (source / "feeds.json").write_text('{"feeds":[{"id":"x:sample"}],"posts":[{"id":"1"}]}\n', encoding="utf-8")

            shell(site)
            uploaded.clear()
            accounts_publish.fetch_health = up
            accounts_publish.upload = fake_upload
            accounts_publish.remote_exists = lambda _key: True
            try:
                code = accounts_publish.publish(site, source, preserve_remote=True)
            finally:
                accounts_publish.fetch_health = original_health
                accounts_publish.upload = original_upload
                accounts_publish.remote_exists = original_remote
            check(
                code == 0
                and accounts_publish.read_gate(site)["gate"] is True
                and uploaded == []
                and (site / "feeds.json").is_file() is False,
                "a shell deploy keeps the remote catalog and still locks the wall",
            )

            probed = []

            class _Byte:
                status = 206

                def read(self, _n=-1):
                    return b"{"

                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return False

            def probe_open(req, timeout=20):
                method = req.get_method()
                probed.append(method)
                if method == "HEAD":
                    raise urllib.error.HTTPError(req.full_url, 405, "method", None, None)
                return _Byte()

            original_open = urllib.request.urlopen
            urllib.request.urlopen = probe_open
            try:
                found = accounts_publish.remote_exists("feeds.json")
            finally:
                urllib.request.urlopen = original_open
            check(found is True and probed == ["HEAD", "GET"], "a refused HEAD still sees the remote catalog")
            probed.clear()

            def missing_open(req, timeout=20):
                probed.append(req.get_method())
                raise urllib.error.HTTPError(req.full_url, 404, "missing", None, None)

            urllib.request.urlopen = missing_open
            try:
                missing = accounts_publish.remote_exists("feeds.json")
            finally:
                urllib.request.urlopen = original_open
            check(missing is False and probed == ["HEAD"], "a missing catalog is not treated as present")

            legacy = Path(tmp) / "legacy"
            legacy.mkdir()
            (legacy / "accounts.config.js").write_text(
                'window.VIKTORYCH_ACCOUNTS = {"api": "' + api + '", "gate": true, "turnstileSiteKey": "", "tiktokAudience": "owner"};\n',
                encoding="utf-8",
            )
            old = accounts_publish.read_gate(legacy)
            check(old["gate"] is True and old["api"] == api, "an older locked accounts.config.js still counts as the wall")

            shell(site)
            def boom(_key, _payload):
                raise OSError("upload failed")

            accounts_publish.fetch_health = up
            accounts_publish.upload = boom
            try:
                code = accounts_publish.publish(site, source)
            finally:
                accounts_publish.fetch_health = original_health
                accounts_publish.upload = original_upload
            check(code == 1 and open_shell(site), "a failed upload does not publish an unlocked shell")
            os.chdir(previous)
    finally:
        os.chdir(previous)
        accounts_publish.fetch_health = original_health
        accounts_publish.upload = original_upload
        accounts_publish.remote_exists = original_remote
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def follow_list_checks() -> None:
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    accounts = (ROOT / "accounts.js").read_text(encoding="utf-8")
    worker = (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8")
    check('name: "connections"' in app, "follow lists have a route")
    check("/v1/follows" in accounts and "account_follows" in worker, "follows are stored for the signed-in account")
    for code in ("en", "es", "ru"):
        pack = (ROOT / "i18n" / f"{code}.js").read_text(encoding="utf-8")
        for key in (
            "No followers yet",
            "Not following anyone yet",
            "Sign in to see this list.",
            "Couldn’t load this list.",
            "Adding {platform} accounts in the app isn’t available yet.",
            "Only the site owner can add a new account.",
            "Save groups on your account",
            "Groups saved on your account.",
            "Sign in to save groups on your account.",
            "Unfollow @{handle}?",
            "This removes the account from your Following.",
        ):
            check(f'"{key}"' in pack, code + " translates " + key)
    check("issues/new" not in app and "issues/new" not in accounts, "user flows do not build a GitHub new-issue URL")
    check('data-act="note-tabs-same"' in app and "Same tabs as Feed" in app and "function visibleNoteTabs(" in app and "function seedNoteTabs(" in app and 'kind: "verified"' in app and 'kind: "mentions"' in app and 'name: "verified"' in app and 'name: "mentions"' in app and "editingNoteTabs() ? noteTabs()" in app and "noteTabsSame" in accounts and "noteTabs:" in accounts, "notification tabs can stay separate from the feed and sync with the account")
    for code in ("en", "es", "ru"):
        pack = (ROOT / "i18n" / f"{code}.js").read_text(encoding="utf-8")
        for key in ("Same tabs as Feed", "Mentions", "Note tab verified", "Drag the handle to reorder."):
            check(f'"{key}"' in pack, code + " translates " + key)
    for name in ("people.js", "shorts.js", "accounts.js"):
        text = (ROOT / name).read_text(encoding="utf-8")
        check("issues/new" not in text, name + " does not open a GitHub issue")


def refresh_budget_checks() -> None:
    import time

    import replies
    import update_feeds
    import x_fetch

    saved = update_feeds._DEADLINE
    update_feeds._DEADLINE = 0.0
    x_fetch._JOB_DEADLINE.limit = time.monotonic() - 1
    started = time.monotonic()
    payload, result = update_feeds._fetch_one(
        "https://example.invalid/feed.xml",
        "generic_rss",
        {"id": "budget"},
        [],
    )
    elapsed = time.monotonic() - started
    x_fetch._JOB_DEADLINE.limit = 0.0
    check(payload is None and result is None and elapsed < 1, "an abandoned prefetch job does not keep fetching")

    update_feeds._DEADLINE = time.monotonic() - 1
    calls = []
    original = replies.fetch_x

    def blocked(post, cap=500):
        calls.append(post.get("id"))
        return [], "fxtwitter", 0

    replies.fetch_x = blocked
    try:
        post = {
            "id": "1",
            "statusId": "1",
            "platform": "x",
            "handle": "x",
            "date": datetime.now(timezone.utc).isoformat(),
        }
        replies.refresh([post], False, {"1"})
    finally:
        replies.fetch_x = original
        update_feeds._DEADLINE = saved
    check(calls == [], "reply refresh stops when the budget is spent")


def main() -> None:
    from account_identity import selftest as identity_selftest
    import assemble_site

    check(assemble_site.selftest() == 0, "the site assembler publishes every referenced shell file")
    accounts_wall_checks()
    refresh_budget_checks()
    follow_list_checks()
    identity_selftest()
    elon = parse_x((FIX / "x_api_v2_samplea.json").read_text(encoding="utf-8"), {"id": "x:copperlane", "platform": "x", "handle": "copperlane"})
    posts = elon["posts"]
    check(len(posts) == 10, "elon parsed 10 tweets")
    check(any(p["kind"] == "repost" for p in posts), "elon has a repost")
    check(any(p["kind"] == "quote" for p in posts), "elon has a quote")
    repost = next(p for p in posts if p["kind"] == "repost")
    check(repost["repostedBy"]["handle"] == "copperlane", "repost credits elon")
    check(not repost["text"].startswith("RT @"), "repost text has no RT prefix")
    check("River" in repost["author"] or repost["handle"] == "riverquill", "repost shows original author")
    quote = next(p for p in posts if p["id"] == "2112603906723487744")
    check(quote["kind"] == "quote" and quote["quoted"], "electricity post is a quote")
    check("t.co" not in quote["text"], "quote t.co stripped from elon text")
    check("oversimplification" in quote["text"], "quote keeps elon's words")
    long_quote = quote["quoted"]
    check(len(long_quote["text"]) > 280, "quoted note_tweet is the long text")
    check(any(p["handle"] == "copperlane" and p["verifiedType"] == "blue" for p in posts), "elon verified blue")
    check(posts[0]["stats"].get("views", 0) > 1000, "stats mapped")

    mosspoint = parse_x((FIX / "x_api_v2_mosspoint.json").read_text(encoding="utf-8"), {"id": "x:mosspoint", "platform": "x", "handle": "mosspoint"})
    photo = next(p for p in mosspoint["posts"] if p["id"] == "2110778025629347999")
    check(photo["media"] and photo["media"][0]["type"] == "photo", "mosspoint photo media")
    check("t.co" not in photo["text"], "mosspoint media t.co stripped")
    check(any(p["kind"] == "reply" and (p.get("replyingTo") or {}).get("handle") for p in mosspoint["posts"]), "mosspoint reply target")
    self_reply = next(p for p in mosspoint["posts"] if p["id"] == "2109689311088287773")
    check((self_reply.get("replyingTo") or {}).get("handle") == "mosspoint", "mosspoint self reply handle")
    check((self_reply.get("replyingTo") or {}).get("id") == "2109689309825794187", "mosspoint self reply parent id")

    fx = parse_fx((FIX / "fxtwitter_sample.json").read_text(encoding="utf-8"), {"id": "x:testuser", "platform": "x", "handle": "testuser"})
    check(fx["posts"][0]["kind"] == "quote", "fxtwitter quote")
    check(fx["posts"][0]["quoted"]["media"][0]["url"].endswith("high.mp4"), "fxtwitter picks highest mp4")
    check(fx["posts"][0]["stats"]["views"] == 6100000, "fxtwitter stats")
    check(fx["posts"][1]["kind"] == "repost" and fx["posts"][1]["handle"] == "orig", "fxtwitter repost author")
    article_post = convert_status(parse_json_loose((FIX / "x_article_status.json").read_text(encoding="utf-8"))["tweet"], {"id": "x:X", "platform": "x", "handle": "X"})
    article = article_post.get("article") or {}
    check(article.get("title", "").startswith("this week on X"), "fxtwitter article keeps the title")
    check(article.get("cover", "").startswith("https://pbs.twimg.com/"), "fxtwitter article keeps the cover")
    check(any(block.get("type") == "h2" and "New Year" in block.get("text", "") for block in article.get("blocks") or []), "fxtwitter article keeps headings")
    check(any(block.get("type") == "embed" and block.get("tweetId") for block in article.get("blocks") or []), "fxtwitter article keeps embedded posts")
    check(any(block.get("styles") for block in article.get("blocks") or []), "fxtwitter article keeps bold ranges")
    preview_only = normalize_article({"id": "99", "title": "Preview only", "preview_text": "A short look.", "cover_media": {"media_info": {"original_img_url": "https://pbs.twimg.com/media/cover.jpg"}}, "content": {"blocks": [], "entityMap": []}})
    check(preview_only and preview_only["title"] == "Preview only" and not preview_only.get("blocks") and preview_only["cover"].endswith("cover.jpg"), "an article list payload stays a preview")
    linked = article_from_status({"entities": {"urls": [{"expanded_url": "https://x.com/i/article/555", "title": "From a card", "description": "Card preview"}]}})
    check(linked and linked["id"] == "555" and linked["title"] == "From a card" and not linked.get("blocks"), "an article link card becomes a preview")
    moment = datetime(2026, 10, 21, 6, 40, tzinfo=timezone.utc)
    live = parse_fx(
        {
            "code": 200,
            "results": [
                {
                    "id": "100",
                    "text": "older original",
                    "created_at": "Wed Oct 21 02:41:37 +0000 2026",
                    "author": {"name": "Other", "screen_name": "other"},
                    "reposted_by": {"name": "Test User", "screen_name": "testuser"},
                },
                {
                    "id": "200",
                    "text": "newer post",
                    "created_at": "Wed Oct 21 05:44:16 +0000 2026",
                    "author": {"name": "Test User", "screen_name": "testuser"},
                },
                {
                    "id": "300",
                    "text": "not this account",
                    "created_at": "Wed Oct 21 06:00:00 +0000 2026",
                    "author": {"name": "Stranger", "screen_name": "stranger"},
                },
            ],
        },
        {"id": "x:testuser", "handle": "testuser"},
        moment,
    )
    check(len(live["posts"]) == 2, "results timeline keeps this account and drops other people")
    live_repost = live["posts"][0]
    check(live_repost["kind"] == "repost" and live_repost["id"] == "repost:testuser:100" and live_repost["statusId"] == "100", "repost id is the repost and status id is the original")
    check(live_repost["sortDate"] > "2026-10-21T05:44:16" and live_repost["sortDate"] <= "2026-10-21T06:40:00.000Z", "repost sorts above the newer original and not after the fetch")
    check(live["posts"][1]["id"] == "200" and live["posts"][1]["kind"] == "post", "an original post keeps its id")
    ranked = sorted(live["posts"], key=lambda post: post.get("sortDate") or post.get("date") or "", reverse=True)
    check(ranked[0]["id"] == "repost:testuser:100", "sorting by activity keeps the recent repost")
    kept = parse_nitter(
        """<?xml version="1.0"?><rss><channel><title>T / @testuser</title>
        <item><title>R to @someone: hello back</title><description>hello back</description>
        <link>https://nitter.example/testuser/status/77</link><pubDate>Wed, 21 Oct 2026 06:10:00 GMT</pubDate></item>
        <item><title>RT by @testuser: keep this</title><description>keep this</description>
        <link>https://nitter.example/orig/status/66</link><pubDate>Tue, 20 Oct 2026 01:00:00 GMT</pubDate></item>
        </channel></rss>""",
        {"id": "x:testuser", "handle": "testuser"},
    )
    check(kept["posts"][0]["kind"] == "reply" and kept["posts"][0]["replyingTo"]["handle"] == "someone", "nitter R to stays a reply")
    check(kept["posts"][1]["kind"] == "repost" and kept["posts"][1]["id"].startswith("repost:testuser:"), "nitter RT by stays a repost")
    check(fx["posts"][1]["verifiedType"] == "government", "government badge type")
    check(fx["posts"][2]["kind"] == "reply", "fxtwitter reply")
    check(any(p["followers"] == 10 for p in fx["profiles"]), "fxtwitter profile")

    nit = parse_nitter((FIX / "nitter_sample.xml").read_text(encoding="utf-8"), {"id": "x:copperlane", "platform": "x", "handle": "copperlane"})
    check(nit["posts"][0]["kind"] == "repost", "nitter RT by is a repost")
    check(nit["posts"][0]["media"], "nitter image extracted")
    check(nit["posts"][1]["kind"] == "quote" and nit["posts"][1]["quoted"]["handle"] == "someone", "nitter blockquote quote")
    check(nit["profiles"][0]["avatar"].endswith("elon.jpg"), "nitter channel image")

    hub = parse_rsshub_x(
        """<?xml version="1.0"?><rss><channel><title>Twitter @SampleAgency</title>
        <item><title>kept</title><description>kept</description>
        <link>https://x.com/SampleAgency/status/123</link><pubDate>Wed, 21 Oct 2026 06:10:00 GMT</pubDate></item>
        <item><title>no id</title><description>no id</description>
        <link>https://x.com/SampleAgency</link></item>
        </channel></rss>""",
        {"id": "x:SampleAgency", "platform": "x", "handle": "SampleAgency"},
    )
    check(len(hub["posts"]) == 1 and hub["posts"][0]["statusId"] == "123", "the rsshub x lane keeps only a post with a status id")
    check(hub["profiles"][0]["handle"] == "SampleAgency" and hub["profiles"][0]["url"] == "https://x.com/SampleAgency", "the rsshub x lane keeps the configured handle")

    mirrors = {"rsshub": ["{rsshubBase}/twitter/user/{handle}"]}
    lanes = ensure_x_lanes(
        {"id": "x:SampleAgency", "platform": "x", "adapter": "fxtwitter", "handle": "SampleAgency"},
        {"xMirrors": mirrors},
    )["fallbacks"]
    check([row["adapter"] for row in lanes] == ["nitter_rss", "rsshub_x"], "an x feed gets the nitter and rsshub lanes")
    check(
        lanes[0]["source_urls"] == ["https://nitter.meowing.monster/{handle}/rss", "https://nitter.kareem.one/{handle}/rss", "https://nitter.jaydenha.uk/{handle}/rss"],
        "the nitter lane keeps the built-in hosts",
    )
    again = ensure_x_lanes({"id": "x:SampleAgency", "platform": "x", "adapter": "fxtwitter", "handle": "SampleAgency", "fallbacks": lanes}, {"xMirrors": mirrors})
    check([row["adapter"] for row in again["fallbacks"]] == [row["adapter"] for row in lanes], "the lanes are not added twice")
    retired = x_fallback_rows({"xMirrors": {"nitter": ["https://nitter.one/"], "rsshub": []}})
    check([row["adapter"] for row in retired] == ["nitter_rss"] and retired[0]["source_urls"] == ["https://nitter.one/{handle}/rss"], "xMirrors is the list the lanes follow")

    feed = {"id": "x:SampleAgency", "platform": "x", "adapter": "fxtwitter", "handle": "SampleAgency", "source_urls": ["{fxtwitterBase}/2/profile/{handle}/statuses"]}
    mirrored = x_source_urls(feed, {"xProxyBase": "https://mirror.test/v1/x"})
    check(
        mirrored[0] == "https://mirror.test/v1/x/2/profile/{handle}/statuses" and mirrored[1] == "{fxtwitterBase}/2/profile/{handle}/statuses",
        "the cached mirror is tried before fxtwitter",
    )
    check(x_source_urls(feed, {"xProxy": False}) == feed["source_urls"], "xProxy false turns the mirror off")
    direct = x_source_urls(feed, {})
    check(len(direct) == 2 and direct[0].endswith("/v1/x/2/profile/{handle}/statuses"), "a worker mirror is added by default")

    slow = urllib.error.HTTPError("https://nitter.one/SampleAgency/rss", 429, "slow down", {"Retry-After": "7"}, None)
    check(is_retryable(slow) and retry_delay(0, slow.headers) == 7, "a rate limit waits as long as the mirror asks")
    check(not is_retryable(urllib.error.HTTPError("https://nitter.one/SampleAgency/rss", 404, "no", {}, None)), "a missing profile is not retried")
    check(is_retryable(urllib.error.URLError("reset")) and retry_delay(1, None) >= 2, "a dropped connection retries with backoff")
    check(not is_retryable(ValueError("refusing api.x.com: the paid X API is not used")), "the paid api refusal is not retried")
    check(status_of(slow) == 429 and status_of(ValueError("x")) == 0, "the retry status reader is safe")

    th = parse_threads((FIX / "rsshub_threads_birchlane.xml").read_text(encoding="utf-8"), {"id": "threads:birchlane", "platform": "threads", "handle": "birchlane"})
    check(len(th["posts"]) == 10, "threads item count")
    check(all(not p["text"].startswith("@birchlane") for p in th["posts"]), "threads title prefix stripped")
    check(any(m["type"] == "video" and m.get("poster") for p in th["posts"] for m in p["media"]), "threads video poster")
    check(any(p["kind"] == "reply" for p in th["posts"]), "threads reply marker")
    check("<" not in th["posts"][0]["text"], "threads html stripped")

    ig = parse_ig((FIX / "rsshub_instagram_birchlane.xml").read_text(encoding="utf-8"), {"id": "instagram:birchlane", "platform": "instagram", "handle": "birchlane"})
    check(len(ig["posts"]) == 33, "instagram item count")
    check(ig["posts"][0]["media"] and ig["posts"][0]["media"][0]["width"] == 3072, "instagram image size")
    check("<img" not in ig["posts"][0]["text"] and "thoughtful" in ig["posts"][0]["text"], "instagram caption text")
    check(ig["profiles"][0]["bio"] == "I build stuff", "instagram bio without RSSHub suffix")

    ig_atom = parse_ig((FIX / "ig_atom_bridge.xml").read_text(encoding="utf-8"), {"id": "instagram:birchlane", "platform": "instagram", "handle": "birchlane"})
    check(len(ig_atom["posts"]) == 1 and ig_atom["posts"][0]["id"] == "Abcd1234" and ig_atom["posts"][0]["statusId"] == "Abcd1234", "an Atom bridge keeps the shortcode, not the numeric id")
    check("Building something new" in ig_atom["posts"][0]["text"] and "Bridge returned" not in ig_atom["posts"][0]["text"], "an Atom bridge keeps the caption and drops the error entry")
    check(ig_atom["posts"][0]["media"][0]["url"].endswith("_nc_ht=scontent.cdninstagram.com") and "&amp;" not in ig_atom["posts"][0]["media"][0]["url"] and ig_atom["posts"][0]["media"][0]["width"] == 1080, "a double-escaped Instagram image URL is stored once")
    th_atom = parse_threads((FIX / "threads_atom_bridge.xml").read_text(encoding="utf-8"), {"id": "threads:birchlane", "platform": "threads", "handle": "birchlane"})
    check(len(th_atom["posts"]) == 1 and th_atom["posts"][0]["id"] == "Abcd1234" and th_atom["posts"][0]["kind"] == "reply", "a Threads Atom reply uses the shortcode")
    check(th_atom["posts"][0]["text"] == "Hello from the bridge" and not th_atom["posts"][0]["text"].startswith("@"), "a Threads Atom caption drops the author line")
    from adapters.common import dedupe_posts as dedupe_meta
    from meta_media import instagram_pages, threads_pages, thumbnail_from_oembed
    collapsed = dedupe_meta([
        {"platform": "instagram", "id": "4006", "statusId": "4006", "url": "https://www.instagram.com/p/Abcd1234/", "text": "Building something new", "date": "2026-10-20T10:00:00Z", "media": [{"type": "photo", "url": "https://scontent.cdninstagram.com/v/a.jpg", "width": 1080}]},
        {"platform": "instagram", "id": "https://www.instagram.com/p/Abcd1234/", "statusId": "https://www.instagram.com/p/Abcd1234/", "url": "https://www.instagram.com/p/Abcd1234/", "text": "▶ Building something new\n\nBuilding something new", "date": "2026-10-20T11:00:00Z", "media": [{"type": "photo", "url": "https://www.instagram.com/p/Abcd1234/media?size=l"}]},
    ])
    check(len(collapsed) == 1 and collapsed[0]["id"] == "Abcd1234" and "cdninstagram.com" in collapsed[0]["media"][0]["url"] and collapsed[0]["text"] == "Building something new", "a numeric id and a URL id collapse to the CDN copy")
    check(instagram_pages("Abcd1234")[0].endswith("/reel/Abcd1234/embed/captioned/"), "Instagram media tries the reel embed first")
    thread_pages = threads_pages({"platform": "threads", "statusId": "Abcd1234", "handle": "birchlane", "url": "https://www.threads.net/t/Abcd1234"})
    check(thread_pages[0] == "https://www.threads.net/t/Abcd1234/embed", "Threads media tries the official embed first")
    check(thumbnail_from_oembed((FIX / "own" / "ig_oembed.json").read_text(encoding="utf-8")).endswith("example.jpg"), "Instagram oEmbed keeps the thumbnail")
    check(thumbnail_from_oembed((FIX / "own" / "threads_oembed.json").read_text(encoding="utf-8")).endswith("example-threads.jpg"), "Threads oEmbed keeps the thumbnail")
    from meta_sources import feed_urls as meta_feed_urls
    ig_urls = meta_feed_urls("instagram")
    check(ig_urls[0].startswith("{rsshubBase}/instagram/user/") and any("rss-bridge.org" in url and "InstagramBridge" in url for url in ig_urls) and any("localhost:8080" in url for url in ig_urls), "Instagram tries local bridges before the public mirrors")

    gen = parse_generic((FIX / "generic_sample.xml").read_text(encoding="utf-8"), {"id": "rss:example", "platform": "rss", "handle": "example"})
    post = gen["posts"][0]
    check("Hello & welcome" in post["text"], "generic title unescaped")
    check("link" in post["text"] and "<" not in post["text"], "generic html stripped")
    check(any(l["expanded"] == "https://example.com/post" for l in post["links"]), "generic anchor kept")
    check(any(m["url"].endswith("i.jpg") for m in post["media"]), "generic img")
    check(any(m["url"].endswith("clip.mp4") for m in post["media"]), "generic enclosure")
    check(post["kind"] == "quote", "generic blockquote")
    check(post.get("commentRss") == "https://example.com/comments.xml", "generic commentRss")
    check((post.get("stats") or {}).get("replies") == 2, "generic slash comments")

    from adapters.common import BridgeError, post_is_bridge_error
    from archive import merge_archive, purge_bridge_errors
    from update_feeds import build as build_feeds

    def raises_bridge(parser, payload, feed):
        try:
            parser(payload, feed)
        except BridgeError:
            return True
        return False

    live_error = {
        "id": "urn:sha1:e3c20ce9e73fcb2aad62770f7a19d0d558f47d5a",
        "text": "Bridge returned error 302! (20747)\nType: HttpException\nFile: lib/http.php\nLine: 34",
        "url": "http://localhost:8080/?action=display&bridge=InstagramBridge&context=Username&u=orbitfox&format=Atom",
    }
    check(post_is_bridge_error(live_error), "a stored bridge error post is detected")
    check(not post_is_bridge_error({"id": "Abcd1234", "text": "The word error is not a failure", "url": "https://www.instagram.com/p/Abcd1234/"}), "a caption that merely says error stays")
    check(post_is_bridge_error({"id": "urn:sha1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "text": "photo", "url": ""}), "a sha1 guid with no permalink is an error id")
    check(not post_is_bridge_error({"id": "urn:sha1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "text": "photo", "url": "https://www.instagram.com/p/Abcd1234/"}), "a sha1 guid with a real permalink stays")
    check(post_is_bridge_error({"id": "notice", "text": "try again", "url": "https://docs.rsshub.app/"}), "an RSSHub docs guid is an error id")
    check("function bridgeErrorPost(" in (ROOT / "app.js").read_text(encoding="utf-8"), "the renderer hides bridge error items")

    atom_error = """<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom"><title>orbitfox</title>
    <entry><title>Bridge returned error 302! (20747)</title>
    <id>urn:sha1:e3c20ce9e73fcb2aad62770f7a19d0d558f47d5a</id>
    <link href="http://localhost:8080/?action=display&amp;bridge=InstagramBridge&amp;context=Username&amp;u=orbitfox&amp;format=Atom"/>
    <content type="html">Type: HttpException File: lib/http.php Line: 34</content></entry></feed>"""
    check(raises_bridge(parse_ig, atom_error, {"id": "instagram:orbitfox", "handle": "orbitfox"}), "instagram drops an Atom bridge error")
    rsshub_error = """<?xml version="1.0"?><rss><channel><title>RSSHub</title>
    <item><title>Looks like something went wrong</title><description>Error message: timeout</description>
    <link>https://docs.rsshub.app/</link><guid>https://docs.rsshub.app/</guid></item></channel></rss>"""
    check(raises_bridge(parse_generic, rsshub_error, {"id": "rss:x", "handle": "x"}), "generic rss drops an RSSHub error item")
    http_only = """<?xml version="1.0"?><rss><channel><title>birchlane</title>
    <item><title>Update</title><description>Type: HttpException Code: 301</description>
    <link>https://www.threads.com/t/NoPost</link><guid>NoPost</guid></item></channel></rss>"""
    check(raises_bridge(parse_threads, http_only, {"id": "threads:birchlane", "handle": "birchlane"}), "threads drops an HttpException item")
    php_only = """<?xml version="1.0"?><rss><channel><title>birchlane</title>
    <item><title>Update</title><description>File: lib/http.php Line: 34</description>
    <link>https://www.threads.com/t/NoPost</link><guid>NoPost</guid></item></channel></rss>"""
    check(raises_bridge(parse_threads, php_only, {"id": "threads:birchlane", "handle": "birchlane"}), "threads drops a lib/http.php item")
    guid_only = """<?xml version="1.0"?><rss><channel><title>birchlane</title>
    <item><title>Update</title><description>photo</description>
    <link>http://localhost:8080/?action=display&amp;bridge=ThreadsBridge&amp;context=Username&amp;u=birchlane&amp;format=Atom</link>
    <guid>urn:sha1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</guid></item></channel></rss>"""
    check(raises_bridge(parse_threads, guid_only, {"id": "threads:birchlane", "handle": "birchlane"}), "threads drops an error-like bridge guid")
    mixed = """<?xml version="1.0"?><rss><channel><title>Moss Point (@birchlane) - Instagram</title><description>I build stuff</description>
    <item><title>Bridge returned error 302!</title><description>Type: HttpException File: lib/http.php</description>
    <link>http://localhost:8080/?action=display&amp;bridge=InstagramBridge&amp;u=birchlane&amp;format=Atom</link>
    <guid>urn:sha1:cccccccccccccccccccccccccccccccccccccccc</guid><pubDate>Tue, 21 Oct 2026 16:48:30 GMT</pubDate></item>
    <item><title>A real caption</title><description>Building something new</description>
    <link>https://www.instagram.com/p/Abcd1234/</link><guid>Abcd1234</guid>
    <pubDate>Mon, 20 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>"""
    mixed_posts = parse_ig(mixed, {"id": "instagram:birchlane", "handle": "birchlane"})["posts"]
    check(len(mixed_posts) == 1 and "Building something new" in mixed_posts[0]["text"] and "Bridge returned" not in mixed_posts[0]["text"], "a mixed instagram feed keeps the real post")
    plain = parse_generic("""<?xml version="1.0"?><rss><channel><title>Example</title>
    <item><title>No failure</title><description>The word error is not a bridge failure</description>
    <link>https://example.com/fine</link><guid>fine-1</guid></item></channel></rss>""", {"id": "rss:example", "handle": "example"})
    check(len(plain["posts"]) == 1 and "error" in plain["posts"][0]["text"].lower(), "generic rss keeps a normal post that says error")

    import json as bridge_json
    import tempfile as bridge_tempfile
    with bridge_tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        error_xml = root / "error.xml"
        good_xml = root / "good.xml"
        error_xml.write_text(atom_error, encoding="utf-8")
        good_xml.write_text("""<?xml version="1.0"?><rss><channel><title>North Lamp</title>
        <item><title>Ready</title><description>Water storage</description>
        <link>https://www.instagram.com/p/GoodNew1/</link><guid>GoodNew1</guid>
        <pubDate>Mon, 20 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>""", encoding="utf-8")
        out = root / "feeds.json"
        seed = {
            "posts": [
                {"id": "good-old", "statusId": "good-old", "platform": "instagram", "feedId": "instagram:orbitfox", "handle": "orbitfox", "text": "Earlier real post", "url": "https://www.instagram.com/p/GoodOld1/", "date": "2026-10-01T00:00:00Z"},
                live_error | {"statusId": live_error["id"], "platform": "instagram", "feedId": "instagram:orbitfox", "handle": "orbitfox", "date": "2026-10-21T16:48:30Z"},
            ],
            "feeds": [],
        }
        out.write_text(bridge_json.dumps(seed), encoding="utf-8")
        config = {
            "output": str(out),
            "rsshubBase": "http://localhost:1200",
            "fxtwitterBase": "https://api.fxtwitter.com",
            "cap": 50,
            "people": [],
            "feeds": [{
                "id": "instagram:orbitfox",
                "platform": "instagram",
                "handle": "orbitfox",
                "adapter": "rsshub_instagram",
                "source_urls": [str(error_xml), str(good_xml)],
                "limit": 8,
            }],
        }
        rotated = build_feeds(config, False, False)
        texts = " ".join(post.get("text") or "" for post in rotated["posts"])
        ids = {post.get("id") for post in rotated["posts"]}
        check("Bridge returned error" not in texts and live_error["id"] not in ids, "rotation does not publish the bridge error")
        check("Earlier real post" in texts and "GoodNew1" in ids and "Water storage" in texts, "rotation keeps the stored post and uses the next mirror")
        check((rotated.get("sourceHealth") or {}).get("instagram:orbitfox", {}).get("ok"), "a later good mirror counts as a successful fetch")
        out.write_text(bridge_json.dumps(seed), encoding="utf-8")
        config["feeds"][0]["source_urls"] = [str(error_xml)]
        kept = build_feeds(config, False, False)
        kept_ids = {post.get("id"): post.get("text") for post in kept["posts"]}
        check(kept_ids.get("good-old") == "Earlier real post" and live_error["id"] not in kept_ids, "an error fetch does not overwrite the stored post")
        check(not (kept.get("sourceHealth") or {}).get("instagram:orbitfox", {}).get("ok"), "an error-only fetch is a failed source")
        same = dict(seed)
        same["posts"] = [dict(seed["posts"][0], id="GoodNew1", statusId="GoodNew1", text="Earlier real post")]
        out.write_text(bridge_json.dumps(same), encoding="utf-8")
        same_xml = root / "same.xml"
        same_xml.write_text("""<?xml version="1.0"?><rss><channel><title>North Lamp</title>
        <item><title>Bridge returned error 302!</title><description>Type: HttpException File: lib/http.php</description>
        <link>http://localhost:8080/?action=display&amp;bridge=InstagramBridge&amp;u=orbitfox&amp;format=Atom</link>
        <guid>GoodNew1</guid><pubDate>Tue, 21 Oct 2026 16:48:30 GMT</pubDate></item></channel></rss>""", encoding="utf-8")
        config["feeds"][0]["source_urls"] = [str(same_xml)]
        replaced = build_feeds(config, False, False)
        same_post = next(post for post in replaced["posts"] if post.get("id") == "GoodNew1")
        check(same_post["text"] == "Earlier real post" and "Bridge returned" not in same_post["text"], "an error item does not replace a stored post with the same id")
        shard = root / "archive"
        shard.mkdir()
        (shard / "2026-10.json").write_text(bridge_json.dumps([
            {"p": "instagram", "id": "GoodOld1", "h": "birchlane", "d": "2026-10-01T00:00:00Z", "t": "Earlier real post"},
            {"p": "threads", "id": "err1", "h": "birchlane", "d": "2026-10-21T00:00:00Z", "t": "Bridge returned error 301! HttpException"},
            {"p": "threads", "id": "err2", "h": "birchlane", "d": "2026-10-21T00:00:00Z", "t": "Looks like something went wrong"},
        ]), encoding="utf-8")
        (shard / "index.json").write_text('{"shards":["2026-10"]}\n', encoding="utf-8")
        merge_archive(shard, [])
        saved_ids = {row["id"] for row in bridge_json.loads((shard / "2026-10.json").read_text(encoding="utf-8"))}
        check(saved_ids == {"GoodOld1"}, "archive shards drop bridge error stubs and keep the real one")
        check(purge_bridge_errors({"shards": {"2026-10": [{"p": "x", "id": "1", "t": "hello"}]}}) == 0, "a clean shard is not rewritten as an error")

    conv_raw = (FIX / "replies" / "2112600761762717997.json").read_text(encoding="utf-8")
    conv = parse_fxtwitter_conversation(conv_raw, "2112600761762717997")
    clean = [c for c in conv if not c.get("spam")]
    scores = [engagement(c) for c in clean]
    check(len(conv) >= 10, "conversation has replies")
    check(conversation_reply_count(conv_raw) == 3283 and len(conv) != 3283, "source reply count stays separate from the cap")
    check(scores == sorted(scores, reverse=True), "relevant order is engagement")
    check(conv[0]["handle"] == "replyuser01", "highest engagement leads")
    check(conv[0]["kind"] == "reply" and conv[0]["replyingTo"]["handle"] == "copperlane", "conversation reply target")
    check(conv[0]["replyingTo"]["id"] == "2112600761762717997", "conversation reply parent id")
    check(conv[0]["date"].startswith("2026-10-20T"), "conversation date is ISO")
    check(conv[0]["verifiedType"] == "blue", "individual verification maps to blue")
    check(conv[0].get("authorFollowers") == 14170, "reply keeps follower count for spam checks")
    check(all(c["id"] != "2112600761762717997" for c in conv), "conversation skips the parent")
    capped = _cap([{"stats": {"likes": i}} for i in range(60)])
    check(len(capped) == 50 and capped[0]["stats"]["likes"] == 59, "reply cap keeps the top 50 by engagement")

    parent = "PARENT"
    sample = {
        "code": 200,
        "status": {"replies": 9, "author": {"screen_name": "copperlane"}},
        "replies": [
            {"id": "8", "text": "first", "author": {"screen_name": "copperlane", "followers": 100}, "replying_to": {"screen_name": "copperlane", "status": parent}, "likes": 1, "created_at": "Tue Oct 20 02:00:00 +0000 2026"},
            {"id": "9", "text": "second", "author": {"screen_name": "copperlane", "followers": 100}, "replying_to": {"screen_name": "copperlane", "status": "8"}, "conversation_id": parent, "likes": 1, "created_at": "Tue Oct 20 03:00:00 +0000 2026"},
            {"id": "1", "text": "plain reply", "author": {"screen_name": "ada", "followers": 40, "joined": "Tue Jun 02 20:12:29 +0000 2009", "verification": {"type": "individual"}}, "replying_to": {"screen_name": "copperlane", "status": parent}, "likes": 5, "replies": 0, "reposts": 0, "created_at": "Tue Oct 20 00:00:00 +0000 2026"},
            {"id": "1", "text": "duplicate id loses", "author": {"screen_name": "ada"}, "replying_to": {"status": parent}, "likes": 1, "created_at": "Tue Oct 20 00:00:00 +0000 2026"},
            {"id": "2", "text": "wrong thread", "author": {"screen_name": "bea"}, "replying_to": {"screen_name": "other", "status": "999"}, "likes": 100, "created_at": "Tue Oct 20 00:00:00 +0000 2026"},
            {"id": "3", "text": "This post is unavailable.", "author": {}, "replying_to": {"status": parent}},
            {"id": "4", "text": "Send a crypto giveaway airdrop now", "author": {"screen_name": "spammer", "followers": 1000, "joined": "Tue Jun 02 20:12:29 +0000 2009"}, "replying_to": {"status": parent}, "likes": 80, "created_at": "Tue Oct 20 01:00:00 +0000 2026"},
            {"id": "5", "text": "https://evil.example/free", "author": {"screen_name": "linky", "followers": 100}, "replying_to": {"status": parent}, "likes": 2, "created_at": "Tue Oct 20 01:00:00 +0000 2026"},
            {"id": "10", "text": "plain reply from another account here", "author": {"screen_name": "copy", "followers": 100}, "replying_to": {"status": parent}, "likes": 1, "created_at": "Tue Oct 20 01:00:00 +0000 2026"},
            {"id": "11", "text": "plain reply from another account here", "author": {"screen_name": "copy2", "followers": 100}, "replying_to": {"status": parent}, "likes": 4, "created_at": "Tue Oct 20 01:00:00 +0000 2026"},
            {"id": "12", "text": "hi", "author": {"screen_name": "BotUser12345", "followers": 500, "joined": "Tue Jun 02 20:12:29 +0000 2009"}, "replying_to": {"status": parent}, "likes": 3, "created_at": "Tue Oct 20 01:00:00 +0000 2026"},
            {"id": "13", "text": "airdrop now please", "author": {"screen_name": "copperlane", "followers": 100}, "replying_to": {"status": parent}, "likes": 1, "created_at": "Tue Oct 20 04:00:00 +0000 2026"},
            {"id": "6", "text": "", "author": {"screen_name": "gap"}, "replying_to": {"status": parent}},
            {"id": "7", "text": "maybe", "author": {"screen_name": "neo", "followers": 3, "joined": "Mon Oct 19 00:00:00 +0000 2026"}, "created_at": "Tue Oct 20 00:00:00 +0000 2026", "likes": 4},
            {"id": "14", "text": "low likes lots of replies", "author": {"screen_name": "talk", "followers": 100}, "replying_to": {"status": parent}, "likes": 10, "replies": 20, "reposts": 0, "created_at": "Tue Oct 20 01:00:00 +0000 2026"},
            {"id": "15", "text": "more likes fewer replies", "author": {"screen_name": "quiet", "followers": 100}, "replying_to": {"status": parent}, "likes": 30, "replies": 0, "reposts": 0, "created_at": "Tue Oct 20 01:00:00 +0000 2026"},
        ],
    }
    ranked = parse_fxtwitter_conversation(sample, parent)
    ids = [row["id"] for row in ranked]
    check(ids[:3] == ["8", "9", "13"], "self-thread stays first and is not spam")
    check("2" not in ids and "3" not in ids and "7" not in ids, "mismatch, deleted, and unconfirmed replies drop")
    check(ids.count("1") == 1 and next(row["text"] for row in ranked if row["id"] == "1") == "plain reply", "duplicate ids keep the first copy")
    spam_ids = {row["id"] for row in ranked if row.get("spam")}
    check(spam_ids >= {"4", "5", "10", "12"}, "giveaway, link-only, duplicate, and bot replies are spam")
    check("11" not in spam_ids, "the highest duplicate stays in the relevant list")
    talk_at = ids.index("14")
    quiet_at = ids.index("15")
    check(talk_at < quiet_at, "replies outweigh a higher like count")
    filled = fill_missing(
        [row for row in sample["replies"] if row["id"] in {"6", "7"}],
        parent,
        lambda reply: {
            "id": reply["id"],
            "text": "filled from status" if reply["id"] == "6" else "maybe",
            "author": {"screen_name": reply["author"]["screen_name"], "followers": 3 if reply["id"] == "7" else 50, "joined": "Mon Oct 19 00:00:00 +0000 2026" if reply["id"] == "7" else "Tue Jun 02 20:12:29 +0000 2009"},
            "replying_to": {"screen_name": "copperlane", "status": parent},
            "created_at": "Tue Oct 20 00:00:00 +0000 2026",
            "likes": 3,
        },
    )
    by_id = {row["id"]: row for row in filled}
    check(by_id["6"]["text"] == "filled from status" and by_id["6"]["replyingTo"]["id"] == parent, "fxtwitter status fills a missing reply")
    check(by_id["7"].get("authorFollowers") == 3, "status lookup keeps a reply once the conversation matches")
    nitter_html = """
    <div class="timeline-item">
      <a href="/gap/status/6"></a>
      <a class="fullname" href="/gap">Gap</a>
      <div class="replying-to">Replying to <a href="/copperlane/status/PARENT">@copperlane</a></div>
      <div class="tweet-content media-body">filled from nitter</div>
      <span class="tweet-date"><a title="Tue, 20 Oct 2026 18:00:00 +0000"></a></span>
      <div class="icon-heart"></div> 3
    </div>
    """
    nitter_status = parse_nitter_status(nitter_html, "6")
    check(nitter_status["text"] == "filled from nitter" and nitter_status["replyingTo"]["id"] == parent, "nitter status page fills the reply target")
    nitter_filled = fill_missing([{"id": "6", "text": "", "handle": "gap", "kind": "reply", "platform": "x"}], parent, lambda _reply: nitter_status)
    check(nitter_filled and nitter_filled[0]["text"] == "filled from nitter", "nitter lookup is used when the reply is incomplete")
    mismatched = fill_missing(
        [{"id": "7", "text": "maybe", "handle": "neo", "platform": "x", "kind": "reply"}],
        parent,
        lambda _reply: {"id": "7", "text": "maybe", "author": {"screen_name": "neo"}, "replying_to": {"status": "999"}, "created_at": "Tue Oct 20 00:00:00 +0000 2026"},
    )
    check(mismatched == [], "a status lookup that points elsewhere is dropped")
    merged = merge_replies(
        [{"id": "1", "text": "old", "avatar": "keep", "stats": {"likes": 1}}],
        [{"id": "1", "text": "new", "stats": {"likes": 9}}, {"id": "2", "text": "only"}],
    )
    check(merged[0]["stats"]["likes"] == 9 and merged[0]["text"] == "new" and merged[0]["avatar"] == "keep" and merged[1]["id"] == "2", "fresh likes win and missing fields stay")
    moment = datetime(2026, 10, 20, tzinfo=timezone.utc)
    check(comments_due("2026-10-19T00:00:00Z", "2026-10-19T23:00:00Z", moment), "posts under 7 days refresh every run")
    check(not comments_due("2026-10-13T00:00:00Z", "2026-10-19T23:00:00Z", moment), "a 7 day post waits a day")
    check(comments_due("2026-10-13T00:00:00Z", "2026-10-18T00:00:00Z", moment), "a 7 day post refreshes after a day")
    check(comments_due("2026-09-20T00:00:00Z", "", moment), "a 30 day post with no fetch time is due")
    check(not comments_due("2026-09-19T23:00:00Z", "", moment), "posts older than 30 days are left alone")
    check(comments_due("", "2026-10-19T00:00:00Z", moment), "an undated post refreshes every run")
    fresh_ig = {"platform": "instagram", "date": "2026-10-19T00:00:00Z"}
    check(comments_kept(fresh_ig, moment), "instagram under 7 days is stored")
    check(comments_kept({"platform": "threads", "date": "2026-10-18T00:00:00Z"}, moment), "threads under 7 days is stored")
    check(not comments_kept({"platform": "instagram", "date": "2026-10-13T00:00:00Z"}, moment), "a 7 day instagram post is not stored")
    check(not comments_kept({"platform": "x", "date": "2026-10-19T00:00:00Z"}, moment), "x replies are not stored")
    check(not comments_kept({"platform": "youtube", "date": "2026-10-19T00:00:00Z"}, moment), "youtube comments are not stored")
    check(not comments_kept({"platform": "instagram"}, moment), "an undated post is not stored")
    check(comments_kept({"platform": "rss", "commentRss": "https://example.com/comments", "date": "2026-10-19T00:00:00Z"}, moment), "comment rss under 7 days is stored")

    nit = parse_nitter_replies((FIX / "replies" / "nitter_sample.html").read_text(encoding="utf-8"), "2112600761762717997")
    check(len(nit) == 2, "nitter replies")
    check(nit[0]["handle"] == "replyuser01" and "Bach" in nit[0]["text"], "nitter first reply")
    check(nit[0]["stats"]["likes"] == 40 and nit[0]["kind"] == "reply", "nitter reply stats")

    ig_replies = parse_ig_comments((FIX / "replies" / "ig_comments.json").read_text(encoding="utf-8"), {"handle": "birchlane", "author": "birchlane", "statusId": "1"})
    check(len(ig_replies) == 2 and ig_replies[0]["stats"]["likes"] == 5, "instagram comments sorted by likes")
    check(ig_replies[0]["verifiedType"] == "blue" and ig_replies[0]["kind"] == "reply", "instagram verified reply")
    check(ig_replies[0]["replyingTo"]["handle"] == "birchlane", "instagram reply target")

    th_replies = parse_threads_replies((FIX / "replies" / "threads_replies.html").read_text(encoding="utf-8"), {"handle": "birchlane", "author": "birchlane", "statusId": "DeZtp"})
    check(len(th_replies) == 2 and th_replies[0]["stats"]["likes"] == 9, "threads replies sorted by likes")
    check(th_replies[0]["text"] == "Wow" and th_replies[0]["kind"] == "reply", "threads reply text")

    parent = {"handle": "birchlane", "author": "Moss Point", "statusId": "4006377606181159966", "url": "https://www.instagram.com/p/DeZgzTEggQe/"}
    gql_rows, gql_count = parse_ig_document((FIX / "replies" / "ig_graphql.json").read_text(encoding="utf-8"), parent)
    check(gql_count == 42 and len(gql_rows) == 2 and gql_rows[0]["text"] == "Nice melon", "graphql parent comments")
    check(gql_rows[0]["verifiedType"] == "blue" and gql_rows[0]["stats"]["likes"] == 5, "graphql comment likes")
    web_rows, web_count = parse_ig_document((FIX / "replies" / "ig_web_info.json").read_text(encoding="utf-8"), parent)
    check(web_count == 7 and web_rows[0]["handle"] == "cy" and web_rows[0]["text"] == "First", "web info preview comments")
    embed_rows, embed_count = parse_ig_document((FIX / "replies" / "ig_embed.html").read_text(encoding="utf-8"), parent)
    check(embed_count == 42 and embed_rows[0]["handle"] == "ada" and embed_rows[0]["text"] == "Nice melon", "embed caption comments")
    viewer_rows, _viewer_count = parse_ig_document((FIX / "replies" / "ig_viewer.html").read_text(encoding="utf-8"), parent)
    check(len(viewer_rows) == 1 and viewer_rows[0]["handle"] == "bea" and viewer_rows[0]["text"] == "Hello there", "viewer html comments")

    direct_rows, direct_count = parse_threads_document((FIX / "replies" / "threads_direct.html").read_text(encoding="utf-8"), {"handle": "birchlane", "author": "birchlane", "statusId": "DeZtp"})
    check(direct_count == 4 and len(direct_rows) == 1 and direct_rows[0]["text"] == "Wow", "threads direct replies skip other posts")
    check(direct_rows[0]["handle"] == "ada" and direct_rows[0]["replyingTo"]["id"] == "DeZtp", "threads direct reply target")

    nested_ig = {
        "comments": [{
            "pk": "p1",
            "text": "Parent",
            "comment_like_count": 3,
            "child_comment_count": 4,
            "user": {"username": "ada", "full_name": "Ada"},
            "preview_child_comments": [
                {"pk": "k1", "text": "Child", "comment_like_count": 1, "user": {"username": "bea"}},
                {
                    "pk": "k2",
                    "text": "Next",
                    "child_comment_count": 1,
                    "user": {"username": "cy"},
                    "preview_child_comments": [{"pk": "g1", "text": "Nope", "user": {"username": "dee"}}],
                },
            ],
        }]
    }
    ig_nested = parse_ig_comments(nested_ig, {"handle": "birchlane", "statusId": "post", "url": "https://www.instagram.com/p/abc/"})
    check(ig_nested[0]["stats"]["replies"] == 4 and len(ig_nested[0]["_children"]) == 2, "instagram stores one level of child comments")
    check(ig_nested[0]["_children"][0]["replyingTo"]["id"] == "p1" and "_children" not in ig_nested[0]["_children"][1], "instagram children reply to the comment")
    gql_nested, _gql_nested_count = parse_ig_document(
        {"data": {"xdt_shortcode_media": {"edge_media_to_parent_comment": {"count": 1, "edges": [{"node": {
            "id": "c1", "text": "Top", "owner": {"username": "ada"}, "edge_liked_by": {"count": 2},
            "edge_threaded_comments": {"count": 2, "edges": [{"node": {"id": "c1a", "text": "Under", "owner": {"username": "bea"}, "edge_liked_by": {"count": 1}}}]},
        }}]}}}},
        {"handle": "birchlane", "statusId": "post"},
    )
    check(gql_nested[0]["stats"]["replies"] == 2 and gql_nested[0]["_children"][0]["text"] == "Under", "graphql threaded comments become children")

    thread_nested = parse_threads_replies(
        {"reply_threads": [{"post": {
            "pk": "10", "code": "AbC", "like_count": 2, "caption": {"text": "Hi"}, "user": {"username": "ada"},
            "text_post_app_info": {
                "direct_reply_count": 3,
                "direct_replies": {"edges": [{"node": {"post": {
                    "pk": "11", "code": "XyZ", "caption": {"text": "Yo"}, "user": {"username": "bea"},
                    "text_post_app_info": {"direct_reply_count": 1, "direct_replies": {"edges": [{"node": {"post": {
                        "pk": "12", "caption": {"text": "Deep"}, "user": {"username": "cy"},
                    }}}]}},
                }}}]},
            },
        }}]},
        {"handle": "birchlane", "statusId": "root"},
    )
    check(thread_nested[0]["stats"]["replies"] == 3 and thread_nested[0]["url"].endswith("/t/AbC"), "threads reply count and permalink")
    check(len(thread_nested[0]["_children"]) == 1 and thread_nested[0]["_children"][0]["replyingTo"]["id"] == "10" and "_children" not in thread_nested[0]["_children"][0], "threads stores one level of replies")

    engaged = [
        {"id": str(i), "handle": "a", "text": "hello from " + str(i), "date": "2026-10-20T00:00:00Z", "stats": {"likes": i, "replies": 1 if i < 13 else 0}}
        for i in range(1, 16)
    ]
    engaged.append({"id": "spam", "handle": "x", "text": "free btc airdrop now", "spam": True, "stats": {"likes": 500, "replies": 9}})
    picked = select_subthreads(engaged, 10)
    check(len(picked) == 10 and picked[0]["id"] == "12" and all(int((row.get("stats") or {}).get("replies") or 0) > 0 and not row.get("spam") for row in picked), "subthreads are the ten most engaged replies")

    search_payload = {
        "data": [
            {"id": "parent", "text": "root", "author_id": "u1", "conversation_id": "parent", "created_at": "2026-10-20T00:00:00.000Z"},
            {"id": "c1", "text": "direct", "author_id": "u2", "in_reply_to_user_id": "u1", "conversation_id": "parent", "created_at": "2026-10-20T00:01:00.000Z", "referenced_tweets": [{"type": "replied_to", "id": "parent"}], "public_metrics": {"like_count": 2, "reply_count": 1}},
            {"id": "c2", "text": "elsewhere", "author_id": "u3", "conversation_id": "root", "created_at": "2026-10-20T00:02:00.000Z", "referenced_tweets": [{"type": "replied_to", "id": "elsewhere"}]},
        ],
        "includes": {"users": [
            {"id": "u1", "name": "A", "username": "a", "created_at": "2020-01-01T00:00:00.000Z", "public_metrics": {"followers_count": 10}},
            {"id": "u2", "name": "B", "username": "b", "public_metrics": {"followers_count": 3}},
            {"id": "u3", "name": "C", "username": "c"},
        ]},
    }
    searched = parse_conversation_search(search_payload, "parent")
    kept = [row for row in searched if belongs(row, "parent") is True]
    check("parent" not in {row["id"] for row in searched} and len(kept) == 1 and kept[0]["id"] == "c1", "conversation search keeps only a direct reply")
    check(kept[0]["replyingTo"]["id"] == "parent" and kept[0]["conversationId"] == "parent" and kept[0]["authorFollowers"] == 3, "conversation search fills the reply target")
    saved_bearer = os.environ.pop("X_BEARER_TOKEN", None)
    try:
        check(conversation_search("2112600761762717997") is None, "conversation search does nothing without a token")
    finally:
        if saved_bearer is not None:
            os.environ["X_BEARER_TOKEN"] = saved_bearer

    rss_replies = parse_comment_rss((FIX / "replies" / "comments.xml").read_text(encoding="utf-8"), {"handle": "example", "author": "Example", "id": "g1", "platform": "rss"})
    check(len(rss_replies) == 2 and all(r["kind"] == "reply" for r in rss_replies), "comment rss replies")
    check(rss_replies[0]["replyingTo"]["id"] == "g1" and rss_replies[0]["replyingTo"]["handle"] == "example", "comment rss target")

    # loose JSON header tolerance
    wrapped = "tool header\n" + (FIX / "x_api_v2_mosspoint.json").read_text(encoding="utf-8") + "\nX reads left: 1\n"
    check(parse_json_loose(wrapped)["data"], "loose json skips header and trailer")

    check(cdn_expiry("https://scontent.cdninstagram.com/v/a.jpg?oe=6ADDAAC5") == "2026-10-25T07:07:49Z", "oe hex is an expiry")
    check(needs_refresh("media/local.jpg"), "local media needs a CDN url")
    later = (datetime.now(timezone.utc) + timedelta(days=4)).strftime("%Y-%m-%dT%H:%M:%SZ")
    check(not needs_refresh("https://scontent.cdninstagram.com/v/a.jpg?oe=6ADDAAC5", later), "fresh CDN url waits")
    html = '<img src="https://static.cdninstagram.com/rsrc.php/icon.png"><img src="https://scontent.cdninstagram.com/v/t51.1/pic.jpg?oe=6ADDAAC5&amp;_nc_cat=1">'
    pulled = extract_cdn_urls(html)
    check(len(pulled) == 1 and "pic.jpg" in pulled[0] and "&_nc_cat=1" in pulled[0], "embed html keeps the post image")
    groups = media_groups(
        [
            "https://scontent.cdninstagram.com/v/t51.82787-19/ava.jpg?stp=dst-jpg_s150x150",
            "https://scontent.cdninstagram.com/v/t51.1/pic.jpg?stp=dst-jpg_e35_p640x640",
            "https://scontent.cdninstagram.com/v/t51.1/pic.jpg?stp=dst-jpg_e35_p1080x1080",
        ]
    )
    check(len(groups) == 1 and "p1080" in groups[0][0] and "p640" in groups[0][1], "refresh prefers the larger rendition")
    try:
        assert_not_x_api("https://api.x.com/2/users/me")
        check(False, "paid X API is refused")
    except ValueError:
        check(True, "paid X API is refused")
    os.environ["TWITTER_AUTH_TOKEN"] = "abc123"
    try:
        check(auth_cookie_header("https://nitter.meowing.monster/copperlane/rss").get("Cookie") == "auth_token=abc123", "nitter gets the optional cookie")
        check(auth_cookie_header("https://api.fxtwitter.com/2/profile/copperlane/statuses") == {}, "fxtwitter does not get the X cookie")
        check(auth_cookie_header("https://www.instagram.com/p/abc/") == {}, "instagram does not get the X cookie")
    finally:
        os.environ.pop("TWITTER_AUTH_TOKEN", None)
    os.environ["X_PROXY_TOKEN"] = "mirror-secret"
    try:
        check(
            proxy_token_header("https://viktorych-accounts.viktorych-accounts.workers.dev/v1/x/2/profile/SampleAgency/statuses").get("X-Viktorych-Token") == "mirror-secret",
            "the cached mirror gets the optional token",
        )
        check(proxy_token_header("https://api.fxtwitter.com/2/profile/SampleAgency/statuses") == {}, "fxtwitter never gets the mirror token")
        check(proxy_token_header("https://evil.example/v1/x/2/profile/SampleAgency/statuses") == {}, "the mirror token stays off an unknown host")
        check(proxy_token_header("http://127.0.0.1:8787/v1/x/2/profile/SampleAgency/statuses").get("X-Viktorych-Token") == "mirror-secret", "a local worker still gets the token")
    finally:
        os.environ.pop("X_PROXY_TOKEN", None)

    import json as jsonlib
    import tempfile
    from update_feeds import prune_comments, write_comment_lookup

    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        (folder / "keep.json").write_text(jsonlib.dumps({"replies": [{"id": "r1", "replies": [{"statusId": "r2"}]}]}), encoding="utf-8")
        (folder / "r1.json").write_text(jsonlib.dumps({"replies": [{"id": "r3"}]}), encoding="utf-8")
        (folder / "yt_keep.json").write_text("{}", encoding="utf-8")
        (folder / "xpost.json").write_text("{}", encoding="utf-8")
        (folder / "gone.json").write_text("{}", encoding="utf-8")
        (folder / "orphan.json").write_text("{}", encoding="utf-8")
        (folder / "lookup.json").write_text("{}", encoding="utf-8")
        removed = prune_comments(
            {
                "posts": [
                    {"id": "keep", "statusId": "keep", "platform": "instagram", "date": "2026-10-19T00:00:00Z"},
                    {"id": "xpost", "statusId": "xpost", "platform": "x", "date": "2026-10-19T00:00:00Z"},
                    {"id": "old", "statusId": "gone", "platform": "threads", "date": "2026-09-01T00:00:00Z"},
                ]
            },
            folder,
            now=datetime(2026, 10, 20, tzinfo=timezone.utc),
        )
        check(removed == 3 and (folder / "keep.json").exists() and (folder / "xpost.json").exists() and (folder / "r1.json").exists() and (folder / "lookup.json").exists() and not (folder / "yt_keep.json").exists() and not (folder / "gone.json").exists() and not (folder / "orphan.json").exists(), "stale comment files are pruned and nested replies stay")
        count = write_comment_lookup(folder)
        lookup = jsonlib.loads((folder / "lookup.json").read_text(encoding="utf-8"))
        check(count == 3 and lookup.get("r1") == "keep" and lookup.get("r2") == "keep" and lookup.get("r3") == "r1", "reply lookup points at the comment file")

    yt = parse_youtube((FIX / "youtube_amberquill.xml").read_text(encoding="utf-8"), {"id": "youtube:amberquill", "platform": "youtube", "handle": "amberquill", "channelId": "UCsyntheticmaple00002000"})
    first = yt["posts"][0]
    check(len(yt["posts"]) == 2 and first["id"] == "scwlR0QHGOk" and first["title"].startswith("The NEW Goldthistle Roadster"), "youtube rss title and id")
    check(yt["profiles"][0].get("channelId") == "UCsyntheticmaple00002000", "youtube profile keeps the channel id")
    check(first["stats"]["views"] == 11453176 and first["stats"]["likes"] == 181847, "youtube rss views and likes")
    check(first["media"][0]["poster"] == "https://i.ytimg.com/vi/scwlR0QHGOk/hqdefault.jpg", "youtube thumbnail is hotlinked")
    check("youtube-nocookie.com/embed/scwlR0QHGOk" in first["media"][0]["url"], "youtube embed url")
    from adapters.youtube_community import parse as parse_community
    from adapters.youtube_community import owner_from_oembed, parse_invidious_posts, parse_rss_posts

    community_feed = {"id": "youtube:northlamp", "platform": "youtube", "handle": "northlamp", "channelId": "UCsyntheticmaple00001000", "profile": {"name": "North Lamp"}}
    community = parse_community((FIX / "youtube_community_invidious.json").read_text(encoding="utf-8"), community_feed)
    by_id = {post["id"]: post for post in community["posts"]}
    image_post = by_id["UgkxwgD1SpZbB0jjdvLVVQ1kDUAUojU3kyah"]
    check(image_post["kind"] == "community" and image_post["author"] == "North Lamp" and image_post["stats"]["likes"] == 690 and image_post["stats"]["replies"] == 70, "community image post keeps likes and comments")
    check(image_post["media"][0]["url"].startswith("https://yt3.ggpht.com/") and "s2000" in image_post["media"][0]["url"] and image_post["avatar"].startswith("https://yt3.googleusercontent.com/"), "community images hotlink the largest thumbnail")
    check(image_post["url"] == "https://www.youtube.com/post/UgkxwgD1SpZbB0jjdvLVVQ1kDUAUojU3kyah" and image_post["date"] == "", "community post links to the post page and does not keep a relative time")
    multi = by_id["UgzdP2CVxI1IMXtXT9B4AaABCQ"]
    check(2 <= len(multi["media"]) <= 4 and all(item["type"] == "photo" and "yt3.ggpht.com" in item["url"] for item in multi["media"]), "community multi-image post keeps each photo")
    poll = next(post for post in community["posts"] if post.get("poll"))
    check(poll["poll"]["totalVotes"] > 0 and len(poll["poll"]["choices"]) >= 2 and all("percent" not in choice and "votes" not in choice for choice in poll["poll"]["choices"]), "community poll keeps choices and hides missing percents")
    shared = next(post for post in community["posts"] if any((item.get("type") == "video") for item in (post.get("media") or [])))
    check(shared["kind"] == "community" and shared["media"][0]["videoId"] == "ofnS1aDDF3Y" and shared["media"][0]["url"].startswith("https://www.youtube-nocookie.com/embed/") and shared["media"][0]["poster"].startswith("https://i.ytimg.com/vi/") and not shared.get("quoted"), "community video plays as media")
    foreign = parse_invidious_posts(
        {
            "comments": [{
                "commentId": "Ugforeignshare0001",
                "author": "North Lamp",
                "content": "Watch this https://youtu.be/abcdefghijk",
                "attachment": {
                    "type": "video",
                    "videoId": "abcdefghijk",
                    "title": "Foreign title",
                    "author": "Other Creator",
                    "authorId": "UCsyntheticmaple00003000",
                },
            }]
        },
        community_feed,
    )[0]
    check(foreign["kind"] == "repost" and foreign["author"] == "Other Creator" and foreign["repostedBy"]["handle"] == "northlamp" and foreign["statusId"] == "abcdefghijk" and str(foreign["id"]).startswith("repost:") and foreign.get("repostComment") == "Watch this" and foreign["profileHandle"] == "UCsyntheticmaple00003000", "a shared community video keeps the reposter's comment and the original channel")
    oembed = owner_from_oembed({"author_name": "DD Geopolitics", "author_url": "https://www.youtube.com/@nightheron", "title": "Hormuz"})
    check(oembed["name"] == "DD Geopolitics" and oembed["handle"] == "nightheron" and oembed["title"] == "Hormuz" and "channelId" not in oembed, "oembed owner is parsed without a network call")
    page = parse_community((FIX / "youtube_community_initial.json").read_text(encoding="utf-8"), community_feed)
    scraped = page["posts"][0]
    check(scraped["id"] == image_post["id"] and scraped["stats"]["likes"] == 690 and scraped["media"][0]["url"].startswith("https://yt3.ggpht.com/") and scraped["date"] == "", "posts page fallback keeps the image and does not invent a time")
    rss_image = image_post["media"][0]["url"]
    rss = (
        "<?xml version='1.0'?><rss version='2.0'><channel><item>"
        f"<title>{image_post['text'][:40]}</title>"
        f"<link>{image_post['url']}</link>"
        f"<guid>{image_post['url']}</guid>"
        "<pubDate>Fri, 20 Mar 2026 12:00:00 GMT</pubDate>"
        f"<description><![CDATA[<p>{image_post['text']}</p><img src=\"{rss_image}\">]]></description>"
        "</item></channel></rss>"
    )
    rss_posts = parse_rss_posts(rss, community_feed)
    check(len(rss_posts) == 1 and rss_posts[0]["id"] == image_post["id"] and rss_posts[0]["media"][0]["url"] == rss_image and rss_posts[0]["date"].startswith("2026-03-20"), "rsshub community item keeps the post id and image")
    goldthistle = parse_youtube((FIX / "youtube_goldthistle.xml").read_text(encoding="utf-8"), {"id": "youtube:goldthistle", "platform": "youtube", "handle": "Goldthistle", "channelId": "UCsyntheticmaple00004000"})
    check(goldthistle["posts"][0]["title"].startswith("Zero to sixty") and goldthistle["profiles"][0]["name"] == "Goldthistle", "goldthistle fixture parses offline")
    comment = normalize_invidious_comment(
        {"commentId": "abc", "author": "@ada", "content": "Nice", "likeCount": 5, "published": 1792272039, "verified": True, "replies": {"replyCount": 2, "continuation": "tok"}},
        "scwlR0QHGOk",
        "amberquill",
    )
    check(comment["text"] == "Nice" and comment["stats"]["likes"] == 5 and comment["stats"]["replies"] == 2 and comment["date"].startswith("2026-"), "invidious comment shape")
    import yt_remote as yt_remote_mod
    calls = []

    def fake_page(video_id, sort, continuation=""):
        calls.append(continuation)
        kids = [{"commentId": "kid-" + str(index), "author": "@bea", "content": "yo " + str(index), "likeCount": 1, "replies": {"replyCount": 4, "continuation": "deeper"}} for index in range(25)]
        return {"comments": kids}

    previous_page = yt_remote_mod._page_invidious
    yt_remote_mod._page_invidious = fake_page
    try:
        quiet = normalize_invidious_comment({"commentId": "quiet", "author": "a", "content": "nope", "likeCount": 9, "replies": {"replyCount": 0}}, "video", "chan")
        loud = normalize_invidious_comment({"commentId": "loud", "author": "@ada", "content": "yes", "likeCount": 1, "replies": {"replyCount": 8, "continuation": "loud-token"}}, "video", "chan")
        mid = normalize_invidious_comment({"commentId": "mid", "author": "b", "content": "mid", "likeCount": 3, "replies": {"replyCount": 2, "continuation": "mid-token"}}, "video", "chan")
        yt_remote_mod._fill_replies([quiet, mid, loud], "video", "chan", 1)
        check(calls == ["loud-token"] and len(loud["replies"]) == 20 and loud["replies"][0]["replyingTo"]["id"] == "loud", "invidious fills the busiest thread and stops at 20")
        check(loud["replies"][0]["replies"] == [] and not mid.get("replies"), "invidious does not fetch a third level")
    finally:
        yt_remote_mod._page_invidious = previous_page
    fresh = {"id": "vid", "avatar": "", "verifiedType": None, "media": [{"type": "video", "url": "https://www.youtube-nocookie.com/embed/vid"}]}
    carry_youtube_fields(
        [fresh],
        [{"id": "vid", "avatar": "https://yt3.googleusercontent.com/a", "verifiedType": "blue", "media": [{"duration": 90, "stream": "https://example/stream"}]}],
        {"avatar": "https://yt3.googleusercontent.com/saved", "verifiedType": "blue"},
    )
    check(fresh["avatar"].endswith("/a") and fresh["verifiedType"] == "blue" and fresh["media"][0]["duration"] == 90 and fresh["short"] is False, "youtube enrichment survives a missed channel fetch")
    blank = {"id": "new", "avatar": "", "media": [{}]}
    carry_youtube_fields([blank], [], {"avatar": "https://yt3.googleusercontent.com/saved", "verifiedType": "blue"})
    check(blank["avatar"].endswith("/saved") and blank["verifiedType"] == "blue", "new youtube posts inherit the saved profile")

    import json
    import tempfile

    from archive import merge_archive, stub_from_post, summarize

    community_stub = stub_from_post(image_post)
    check(community_stub["p"] == "youtube" and community_stub["id"] == image_post["id"] and community_stub["k"] == "community" and community_stub["t"] == image_post["text"][:280], "community posts archive as stubs")
    from pull_snapshot import pull_archive

    long_text = "word " * 80
    post = {
        "platform": "instagram",
        "id": "4006377606181159966",
        "handle": "birchlane",
        "date": "2026-10-12T16:56:29Z",
        "kind": "post",
        "text": long_text,
        "url": "https://www.instagram.com/p/DeZgzTEggQe/",
        "media": [{"type": "photo", "url": "https://cdn.example/a.jpg"}],
        "stats": {"likes": 5},
        "avatar": "https://cdn.example/a.jpg",
    }
    stub = stub_from_post(post)
    check(stub["id"] == "DeZgzTEggQe" and stub["p"] == "instagram", "instagram stub uses the shortcode")
    check(len(stub["t"]) == 280 and "k" not in stub, "snippet is capped at 280 and plain posts omit kind")
    encoded = json.dumps(stub, ensure_ascii=False, separators=(",", ":"))
    check("media" not in stub and "stats" not in stub and stub.get("av") == "https://cdn.example/a.jpg" and "likes" not in encoded, "stub stores the author avatar and no media or stats")
    reply = stub_from_post(dict(post, platform="threads", id="DeZtp7KER52", url="https://www.threads.com/t/DeZtp7KER52", kind="reply", text="short"))
    check(reply["id"] == "DeZtp7KER52" and reply["k"] == "reply" and len(reply["t"]) < 280, "threads stub keeps a reply kind")
    undated = stub_from_post({"platform": "rss", "id": "item-1", "handle": "news", "text": "hi"})
    check(undated and undated["id"] == "item-1" and "d" not in undated, "undated stub omits an empty date")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        merge_archive(root / "archive", [post])
        merge_archive(root / "archive", [dict(post, date="2026-10-21T20:24:18Z", text="later text")])
        kept_month = json.loads((root / "archive" / "2026-10.json").read_text(encoding="utf-8"))
        check(kept_month[0]["d"].startswith("2026-10-12") and kept_month[0]["t"] == stub["t"], "a later sync cannot move an archived date forward")
        merge_archive(root / "archive", [dict(post, date="2026-09-02T00:00:00Z")])
        check(not (root / "archive" / "2026-10.json").exists(), "an earlier real date leaves the later month shard")
        moved_month = json.loads((root / "archive" / "2026-09.json").read_text(encoding="utf-8"))
        check(moved_month[0]["id"] == "DeZgzTEggQe" and moved_month[0]["d"].startswith("2026-09-02") and moved_month[0]["t"] == stub["t"], "an archived post keeps the earliest real date and the first text")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        added = merge_archive(root / "archive", [post, post])
        check(added == 1, "the same id is not archived twice")
        added = merge_archive(root / "archive", [dict(post, text="different text that must not replace the first snippet")])
        check(added == 0, "an existing stub is not overwritten")
        saved = json.loads((root / "archive" / "2026-10.json").read_text(encoding="utf-8"))
        check(saved[0]["t"] == stub["t"] and saved[0]["id"] == "DeZgzTEggQe", "the first snippet stays in the month shard")
        share = {
            "platform": "x",
            "id": "2112908406873072074",
            "statusId": "2112908406873072074",
            "handle": "nightheron",
            "author": "DD Geopolitics",
            "avatar": "https://pbs.twimg.com/profile_images/face.jpg",
            "kind": "repost",
            "text": "WATCH: University professors",
            "date": "2026-10-21T12:00:00Z",
            "repostedBy": {"handle": "cedarhill", "name": "North Lamp"},
            "repostComment": "look at this",
        }
        share_stub = stub_from_post(share)
        check(share_stub["h"] == "nightheron" and share_stub["a"] == "DD Geopolitics" and share_stub["av"].startswith("https://") and share_stub["rb"] == "cedarhill" and share_stub["rn"] == "North Lamp" and share_stub["rc"] == "look at this" and share_stub["k"] == "repost", "a repost stub keeps the original creator and who reposted it")
        thin = dict(share)
        thin.pop("avatar")
        thin.pop("repostComment")
        check(merge_archive(root / "archive", [thin]) == 1, "a repost stub is archived")
        merge_archive(root / "archive", [dict(share, text="a later caption that must not replace the first")])
        month = json.loads((root / "archive" / "2026-10.json").read_text(encoding="utf-8"))
        row = next(item for item in month if item["id"] == "2112908406873072074")
        check(row["t"].startswith("WATCH:") and row.get("av", "").startswith("https://") and row.get("rc") == "look at this" and "later caption" not in row["t"], "archiving again fills the creator fields without replacing the text")
        index = json.loads((root / "archive" / "index.json").read_text(encoding="utf-8"))
        check(index["shards"] == ["2026-10"], "the shard is named for its month")
        older = {"platform": "x", "id": "2112600761762717997", "handle": "copperlane", "date": "2026-08-02T00:00:00Z", "text": "old", "kind": "post"}
        merge_archive(root / "archive", [older])
        index = json.loads((root / "archive" / "index.json").read_text(encoding="utf-8"))
        check(index["shards"] == ["2026-10", "2026-08"], "older months follow the newest shard")
        before = (root / "archive" / "2026-10.json").read_bytes()

        def fetch_partial(rel):
            if rel.endswith("index.json"):
                return b'{"shards":["2026-10","2026-09"]}\n'
            if rel.endswith("2026-10.json"):
                return b'[{"p":"x","id":"1"}]\n'
            return None

        check(pull_archive(root, fetch_partial) == "kept", "a partial archive download keeps the local shards")
        check((root / "archive" / "2026-10.json").read_bytes() == before, "a partial download does not rewrite a shard")

        def fetch_ok(rel):
            if rel.endswith("index.json"):
                return b'{"shards":["2026-09"]}\n'
            if rel.endswith("2026-09.json"):
                return b'[{"p":"x","id":"only","d":"2026-09-01T00:00:00Z","t":"kept","media":"nope"}]\n'
            return None

        check(pull_archive(root, fetch_ok) == "updated", "a complete archive download merges the shards")
        september = json.loads((root / "archive" / "2026-09.json").read_text(encoding="utf-8"))
        check(september[0]["id"] == "only" and set(september[0]) <= {"p", "id", "h", "d", "k", "t"}, "the downloaded stub is stored without extra fields")
        check((root / "archive" / "2026-10.json").is_file() and (root / "archive" / "2026-08.json").is_file(), "months missing from the remote stay")
        kept_rows = json.loads((root / "archive" / "2026-10.json").read_text(encoding="utf-8"))
        kept_text = next(row["t"] for row in kept_rows if row["id"] == "DeZgzTEggQe")

        def fetch_more(rel):
            if rel.endswith("index.json"):
                return b'{"shards":["2026-10"]}\n'
            if rel.endswith("2026-10.json"):
                return b'[{"p":"instagram","id":"DeZgzTEggQe","d":"2026-10-12T16:56:29Z","t":"replaced","media":"nope"},{"p":"x","id":"20","d":"2026-10-02T00:00:00Z","t":"new","stats":{"likes":1}}]\n'
            return None

        check(pull_archive(root, fetch_more) == "updated", "a later complete archive adds stubs")
        october = {row["id"]: row for row in json.loads((root / "archive" / "2026-10.json").read_text(encoding="utf-8"))}
        check(october["DeZgzTEggQe"]["t"] == kept_text and october["20"]["t"] == "new" and "stats" not in october["20"], "an existing stub keeps its first text")
        check(pull_archive(root, fetch_more) == "kept", "a complete archive with no new stubs leaves the files")
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp)
        doc = json.loads((ROOT / "feeds.json").read_text(encoding="utf-8"))
        added = merge_archive(dest, doc["posts"])
        stats = summarize(dest)
        check(added == stats["count"] and stats["count"] >= 20, "the seed archive has one stub per post id")
        check(stats["max"] < 700 and stats["avg"] < 400, "seed stubs stay within a few hundred bytes")
        bad_fields = 0
        long_text = 0
        for path in dest.glob("*.json"):
            if path.name == "index.json":
                continue
            for row in json.loads(path.read_text(encoding="utf-8")):
                if not set(row) <= {"p", "id", "h", "d", "k", "t", "a", "av", "c", "rb", "rn", "rc"}:
                    bad_fields += 1
                if len(row.get("t") or "") > 280:
                    long_text += 1
        check(bad_fields == 0 and long_text == 0, "every stub is text only and at most 280 characters")
    import subprocess
    env = os.environ.copy()
    env.pop("IA_ACCESS_KEY", None)
    env["IA_SECRET_KEY"] = "sentinel-secret-value"
    skipped = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "ia_archive.py")],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    combined = skipped.stdout + skipped.stderr
    check(skipped.returncode == 0 and "skipping the upload" in skipped.stdout, "missing Internet Archive keys skip the upload")
    check("sentinel-secret-value" not in combined and "IA_SECRET_KEY" not in combined, "the skip path does not print a secret")
    storage_worker = (ROOT / "sw.js").read_text(encoding="utf-8")
    storage_workflow = (ROOT / ".github" / "workflows" / "sync.yml").read_text(encoding="utf-8")
    storage_flow = subprocess.run(["node", str(ROOT / "scripts" / "storage_test.js")], cwd=ROOT)
    check(storage_flow.returncode == 0, "the storage cache helpers pass")
    native_flow = subprocess.run(["node", str(ROOT / "scripts" / "native_test.js")], cwd=ROOT)
    check(native_flow.returncode == 0, "installed-app helpers pass")
    local_flow = subprocess.run(["node", str(ROOT / "scripts" / "localfirst_test.js")], cwd=ROOT)
    direct_flow = subprocess.run(["node", str(ROOT / "scripts" / "direct_test.js")], cwd=ROOT)
    device_flow = subprocess.run(["node", str(ROOT / "scripts" / "device_test.js")], cwd=ROOT)
    check(local_flow.returncode == 0, "a blocked reload paints home, a profile, a post, and notifications from cache")
    counts_flow = subprocess.run(["node", str(ROOT / "scripts" / "profile_counts_test.mjs")], cwd=ROOT)
    check(counts_flow.returncode == 0, "profile headers never show 0 as a stand-in for unknown counts and paint last known counts from this device")
    feed_images = subprocess.run(["node", str(ROOT / "scripts" / "feed_images_test.mjs")], cwd=ROOT)
    post_actions = subprocess.run(["node", str(ROOT / "scripts" / "post_actions_test.mjs")], cwd=ROOT)
    check(post_actions.returncode == 0, "every action on a feed post's page works like X: replies show under it, quote embeds it, repost, like, bookmark, share and the menu")
    reply_context = subprocess.run(["node", str(ROOT / "scripts" / "reply_context_test.mjs")], cwd=ROOT)
    check(reply_context.returncode == 0, "replies show one X-style \"Replying to\" line, hide the prefixed @mentions, keep mid-text mentions, and drop the line under a shown parent")
    reply_parent = subprocess.run(["node", str(ROOT / "scripts" / "reply_parent_test.mjs")], cwd=ROOT)
    check(reply_parent.returncode == 0, "timeline replies show their parent above on the thread line, loaded live when missing, once when the parent is also on Home, and fall back to \"Replying to\"")
    reply_sources = subprocess.run([sys.executable, str(ROOT / "scripts" / "reply_sources_test.py")], cwd=ROOT, stdout=subprocess.DEVNULL)
    check(reply_sources.returncode == 0, "every X source keeps a reply's target, and merges keep the copy that has it")
    check(feed_images.returncode == 0, "feed media URLs are real and a refused picture ends as the silhouette or the picture placeholder, never a broken frame")
    swr_flow = subprocess.run(["node", str(ROOT / "scripts" / "swr_cache_test.js")], cwd=ROOT)
    check(swr_flow.returncode == 0, "the shared local-first cache stays under its byte budget and evicts least recently used pages")
    budget_flow = subprocess.run(["node", str(ROOT / "scripts" / "local_budget_test.js")], cwd=ROOT)
    check(budget_flow.returncode == 0, "localStorage stays under 500 KB in a long session, old bloated keys move out, and Free up space keeps settings")
    check(direct_flow.returncode == 0, "public reads run on the device and fall back to the server")
    check(device_flow.returncode == 0, "device performance levels, toggles, and fallbacks pass")
    busy_flow = subprocess.run(["node", str(ROOT / "scripts" / "busy_test.js")], cwd=ROOT)
    check(busy_flow.returncode == 0, "busy accounts are detected, folded, and interleaved on the device")
    busy_sync = subprocess.run([sys.executable, str(ROOT / "scripts" / "busy_sources.py")], cwd=ROOT)
    check(busy_sync.returncode == 0, "the sync trims busy sources' replies and reads their replies hourly")
    tv_flow = subprocess.run(["node", str(ROOT / "scripts" / "tv_boot_test.js")], cwd=ROOT)
    check(tv_flow.returncode == 0, "TV mode detects TVs, keeps its light defaults switchable, and publishes the TV app files")
    tv_tune = subprocess.run(["node", str(ROOT / "scripts" / "tv_tune_test.js")], cwd=ROOT)
    check(tv_tune.returncode == 0, "the TV app's first-open check picks defaults from the TV's specs and never overwrites a setting changed by hand")
    tv_pair = subprocess.run(["node", str(ROOT / "scripts" / "tv_pair_test.mjs")], cwd=ROOT)
    check(tv_pair.returncode == 0, "a phone signs a TV in with a one-use code that expires")
    tv_short = subprocess.run(["node", str(ROOT / "scripts" / "tv_short_pair_test.mjs")], cwd=ROOT)
    check(tv_short.returncode == 0, "TV sign-in codes and share links use the short address")
    send_tv_flow = subprocess.run(["node", str(ROOT / "scripts" / "send_tv_test.js")], cwd=ROOT)
    check(send_tv_flow.returncode == 0, "Send to my TV shares the short TV link and shows each TV maker's free phone-app steps")
    page_html = (ROOT / "index.html").read_text(encoding="utf-8")
    published = deployed_paths()
    check('src="storage.js"' in page_html and "storage.js" in published and "navigator.storage.persist" in (ROOT / "storage.js").read_text(encoding="utf-8") and "If-None-Match" in storage_worker and "storage-wipe" in storage_worker, "settings show storage usage and feeds revalidate with ETag")
    check('src="localfirst.js"' in page_html and 'src="direct.js"' in page_html and 'src="device.js"' not in page_html and "localfirst.js" in published and "direct.js" in published and "device.js" in published and "device-search.js" in published and "device-ai.js" in published and "device-media.js" in published and "device-record.js" in published and "mergeNotes" in (ROOT / "localfirst.js").read_text(encoding="utf-8") and "public.api.bsky.app" in (ROOT / "direct.js").read_text(encoding="utf-8"), "the shell restores from local snapshots and public APIs are fetched on the device")
    app_boot = (ROOT / "app.js").read_text(encoding="utf-8")
    check("requestIdleCallback(fire, { timeout: 1200 })" in app_boot and '"pointerdown"' in app_boot and '"keydown"' in app_boot and '"scroll"' in app_boot and '"hashchange"' in app_boot and "setTimeout(fire, 6500)" not in app_boot and "holdDevice(true)" in app_boot and "holdDevice" in (ROOT / "direct.js").read_text(encoding="utf-8"), "device work starts after first paint or the first interaction, and the first feed read stays on the existing path")
    local_src = (ROOT / "localfirst.js").read_text(encoding="utf-8")
    check("orderPosts" in local_src and "playlistFirst" in local_src and "cacheFirstSegment" in local_src and 'saveDoc("shorts"' in (ROOT / "shorts.js").read_text(encoding="utf-8") and 'saveDoc("lives"' in (ROOT / "shorts.js").read_text(encoding="utf-8") and 'saveDoc("music"' in (ROOT / "music.js").read_text(encoding="utf-8") and 'saveDoc("messages"' in (ROOT / "discord-ui.js").read_text(encoding="utf-8") and 'order: "utc"' in (ROOT / "app.js").read_text(encoding="utf-8"), "every screen keeps an ordered local copy and the first video segment is cached")
    ia_backup_checks()
    feed_order_checks()
    gdrive_checks()
    telegram_checks()
    x_notes_checks()

    import struct
    manifest = json.loads((ROOT / "manifest.webmanifest").read_text(encoding="utf-8"))
    workflow = (ROOT / ".github" / "workflows" / "sync.yml").read_text(encoding="utf-8")
    check(manifest["display"] == "standalone" and manifest["scope"] == "./" and manifest["id"] == "./" and manifest["name"] == "ViktorychApp" and manifest["short_name"] == "ViktorychApp", "the installed shortcut name is ViktorychApp, and scope and id follow the manifest directory")
    check("404.html" in deployed_paths() and "__SITE_BASE__" not in workflow and "brand.js" not in workflow and "i18n.js" in deployed_paths() and "marks.js" in deployed_paths(), "the deploy publishes the 404 fallback, translations, and marks without baking a repository path")
    missing = ROOT / "404.html"
    missing_text = missing.read_text(encoding="utf-8")
    check("location.replace" in missing_text and "ViktorychApp" in missing_text and "SuperintelApp" not in missing_text and "github.io" in missing_text and "parts[0]" in missing_text, "a missing page returns to this site's directory")
    robots_text = (ROOT / "robots.txt").read_text(encoding="utf-8") if (ROOT / "robots.txt").is_file() else ""
    noindex_tag = '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">'
    googlebot_tag = '<meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet, noimageindex">'
    worker_index = (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8")
    discord_pub = (ROOT / "scripts" / "discord_publish.py").read_text(encoding="utf-8")
    check("User-agent: *" in robots_text and "Disallow: /data/" in robots_text and "robots.txt" in deployed_paths() and "assemble_site" in discord_pub, "robots.txt disallows data directories while letting crawlers read noindex on HTML pages")
    check(noindex_tag in (ROOT / "index.html").read_text(encoding="utf-8") and googlebot_tag in (ROOT / "index.html").read_text(encoding="utf-8") and noindex_tag in missing_text and googlebot_tag in missing_text, "the shell and 404 pages block search engine indexing")
    check('"x-robots-tag": "noindex, nofollow, noarchive, nosnippet, noimageindex"' in worker_index and 'path === "/robots.txt"' in worker_index, "the Worker sends X-Robots-Tag and serves /robots.txt")
    check("https://github.com/${GITHUB_REPO}" not in (ROOT / "app.js").read_text(encoding="utf-8"), "the sidebar fineprint does not link crawlers to the GitHub repository")
    from site_paths import pages_base, raw_data, cdn_data
    saved_repo = os.environ.pop("GITHUB_REPOSITORY", None)
    try:
        check(pages_base() == "" and raw_data() == "" and cdn_data() == "", "Pages URLs are empty until GITHUB_REPOSITORY is set")
        os.environ["GITHUB_REPOSITORY"] = "ViktorychGroup/ViktorychApp"
        check(pages_base() == "https://viktorychgroup.github.io/ViktorychApp/" and raw_data().endswith("/ViktorychApp/data/") and "ViktorychGroup/ViktorychApp@data/" in cdn_data(), "Pages, raw, and jsDelivr URLs follow the repository")
        os.environ["GITHUB_REPOSITORY"] = "Example/Other"
        check(pages_base() == "https://example.github.io/Other/", "a renamed repository follows GITHUB_REPOSITORY")
    finally:
        os.environ.pop("GITHUB_REPOSITORY", None)
        if saved_repo:
            os.environ["GITHUB_REPOSITORY"] = saved_repo
    stale = []
    old_repo = "rss-" + "feeds"
    stale_re = re.compile(r"github\.io/" + old_repo + r"|riverquoll/" + old_repo + r"|/" + old_repo + r"/")
    for path in ROOT.rglob("*"):
        if not path.is_file() or "fixtures" in path.parts or path.suffix not in {".js", ".py", ".html", ".yml", ".md", ".webmanifest", ".css", ".json"}:
            continue
        rel = str(path.relative_to(ROOT))
        if rel == "scripts/text-edits.json":
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        # Account deletion still clears data saved under the previous name.
        cleaned = text.replace('"' + old_repo + '-"', "").replace("'" + old_repo + "-'", "")
        if stale_re.search(cleaned) or old_repo in cleaned:
            stale.append(rel)
    check(not stale, "the previous site name is gone: " + ", ".join(stale))
    check(str(manifest["start_url"]).endswith("#/home"), "the manifest opens the home timeline")
    check("window-controls-overlay" in manifest["display_override"], "desktop installs can use the window controls overlay")
    purposes = [icon.get("purpose") for icon in manifest["icons"]]
    sizes = {icon.get("sizes") for icon in manifest["icons"]}
    check("192x192" in sizes and "512x512" in sizes and "any" in purposes and "maskable" in purposes and "monochrome" in purposes and all(" " not in (item or "") for item in purposes) and all("?v=7" in icon["src"] for icon in manifest["icons"]), "the manifest has separate any, maskable, and monochrome icons with a cache-busting query")
    shortcut_names = [item["name"] for item in manifest["shortcuts"]]
    check(shortcut_names[:4] == ["Home", "Notifications", "Inbox", "Post"] and set(["Search", "Bookmarks", "Subscriptions", "Notifications", "ViktorychMusic", "Home", "Inbox", "Post"]).issubset(shortcut_names), "the manifest shortcuts lead with Home, Notifications, Messages, and Post and keep Search, Bookmarks, Subscriptions, and ViktorychMusic")
    share_files = manifest["share_target"]["params"].get("files") or []
    check(manifest["share_target"]["method"] == "POST" and manifest["share_target"]["enctype"] == "multipart/form-data" and manifest["share_target"]["params"].get("url") == "url" and any(item.get("name") == "media" for item in share_files), "sharing a link or a file into the app is a POST share target")
    check(manifest.get("file_handlers") and manifest["launch_handler"]["client_mode"] == "focus-existing" and any(item.get("protocol") == "web+viktorych" for item in manifest.get("protocol_handlers") or []), "the installed app opens files, focuses the existing window, and handles web+viktorych")
    worker = (ROOT / "sw.js").read_text(encoding="utf-8")
    check("__SW_VERSION__" in worker and "150 * 1024 * 1024" in worker and "staleWhileRevalidate" in worker, "the service worker versions its cache and caps media")
    check("api.fxtwitter.com" in worker and "networkFirst" in worker and "networkFirstTimeout" in worker and "6000" in worker, "comment APIs are network-first with a short timeout")
    page = (ROOT / "index.html").read_text(encoding="utf-8")
    check('rel="manifest"' in page and "apple-mobile-web-app-capable" in page and "apple-touch-icon" in page and "apple-touch-startup-image" in page and "preconnect" in page, "the page links the manifest, splash images, and preconnect hints")
    update_js = (ROOT / "update.js").read_text(encoding="utf-8")
    check('id="viewer"' in page and 'src="update.js"' in page and 'id="upd-go"' in update_js and 'tr("Update now")' in update_js, "the shell has an update prompt and a media viewer")
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    check("beforeinstallprompt" in app and "Install app" in app and "pictureInPicture" in app and "mediaSession" in app, "install, picture in picture, and media session are in the page")
    check("function creatorOf(" in app and "function repostBanner(" in app and "function countsAsUpload(" in app and "repostComment" in app and "function creditCarried(" in app and "function carriedBy(" in app and "postsCountIncludesReposts" in app and "countsAsOwn" in (ROOT / "people.js").read_text(encoding="utf-8"), "reposts keep the original author, name who reposted, and stay out of that account's post count")
    check("parseSharedLink" in app and "startViewTransition" in app and 'readStored(localStorage, "timeline-v1")' in app and 'readStored(localStorage, "bookmark-queue")' in app and "setAppBadge" in app and 'decoding="async"' in app and "navigator.vibrate" in app, "share targets, view transitions, offline snapshots, badges, and haptics are wired")
    check("requestPermission" in app and app.index("requestPermission") > app.index("data-act=\"notify\""), "notification permission is requested from the settings control")
    check("manifest.webmanifest" in deployed_paths() and "__SW_VERSION__" in workflow and "GITHUB_SHA" in workflow, "the deploy copies the app shell and stamps the service worker")
    check('ranking_mode: "recency"' in app, "fxtwitter conversations also request newest replies")
    check("COMMENT_TTL" in app and "reply-sort" in app and "Updated " in app and 'tab("relevant", tr("Relevant"))' in app and 'tab("recent", tr("Recent"))' in app and 'tab("liked", tr("Liked"))' in app and "replySortMode" in app, "opening a post can sort replies and show when they were fetched")
    yt_loader = app[app.index("function ytStub("):app.index("function liveDuration(")]
    reply_bucket = app[app.index("function replyBucket("):app.index("function ivIso(")]
    check("ivThread(" in yt_loader and "ivCommunityThread(" in yt_loader and 'ownPack("yt_"' in yt_loader and 'snapshotDoc("yt_"' in yt_loader and 'ownPack("ytpost_"' in yt_loader and 'snapshotDoc("ytpost_"' in yt_loader and "pipedThread(" not in yt_loader and "loadYtComments(post)" in reply_bucket, "youtube comments share one loader on every surface")
    profile_view = app[app.index("function profileView("):app.index("function statusView(")]
    yt_channel = app[app.index("function ytProfileFromPiped("):app.index("function loadLimited(")]
    check("function catalogAccount(" in app and "function accountHash(" in app and "accountHash(feed.platform, feed.channelId || feed.handle)" in app and "function stopWatchPlayback(" in app and "leavingWatch" in app and "Subscribers" in profile_view and "profileLinkLabel(feed.platform)" in profile_view, "a followed channel opens its synced profile and the watch player stops")
    check("previousHandles" in app and "permanentId" in app and "data-tg-alts" in app, "an old handle opens the account and older media keys still play")
    check('"/channel/"' in yt_channel and "ytProfileFromPiped" in yt_channel and "filter=videos" in yt_channel and "PIPED_SEEDS.slice()" in yt_channel and "function ytImage(" in app, "a live YouTube channel uses the public channel fallback when Invidious misses")
    community_loader = app[app.index("function ivCommunityThread("):app.index("function ytStub(")]
    check("ucid=" in community_loader and "commentCount" in community_loader, "community comments pass the channel id and keep the source count")
    check('cron: "15,45 * * * *"' in workflow and "/dispatches" in workflow and "chain" in workflow, "the sync has a staggered cron and a keepalive dispatch")
    published = deployed_paths()
    check("status.json" not in published and "\nfallback/" not in published and "\ncomments/" not in published and "\narchive/" not in published and "\ndiscord/" not in published, "the deploy does not publish private sync files")
    check('name: "sources"' in app and "ownPack" in app and "fxDown" in app and "fallback/" in app and "settled" in app and "source-row" in (ROOT / "styles.css").read_text(encoding="utf-8"), "a hidden sources view fails over to our own files")
    check('name: "user"' in app and "#/u/" in app and "with_replies=1" in app and "Open on Instagram" in app and "feeds.config.json" in app and "pfollow-note" in (ROOT / "styles.css").read_text(encoding="utf-8"), "live profiles open from a handle and keep follows on the device")
    css = (ROOT / "styles.css").read_text(encoding="utf-8")
    check("grid-template-rows: subgrid" in css and "grid-row: span 4" in css and 'class="yt-label"' in app and "text-overflow: ellipsis" in css[css.index(".subs.grid .yt-label"):css.index(".subs.grid .yt-label") + 700], "subscription cards share a repost row so thumbnails in a row start together")
    actions = css[css.index(".pactions .outline"):css.index(".pactions .outline") + 280]
    check("flex-shrink: 100" in css and "white-space: nowrap" in actions, "the display name keeps its room and the profile link stays one line")
    check("--fill:" in css and "--hover: rgba(231, 233, 234, 0.1)" in css and "--hover-soft: rgba(255, 255, 255, 0.03)" in css and ".add-account .search { flex: 1; min-width: 0; }" in css and "text-overflow: ellipsis; white-space: nowrap; }" in css[css.index(".who-copy .name"):css.index(".who-copy .name") + 220] and ".watch-main { padding: 0; min-width: 0; }" in css and "function deadMediaUrl(" in app and "function collapseSameUrl(" in app and "Skip to content" in app and 'class="vh">${tr("Home")}' in app and 'aria-current="page"' in app and 'role="tab" aria-selected="' in app, "themes, watch width, dead posters, and control names stay in place")
    check('data-act="autoplay"' in app and "On cellular and Wi-Fi" in app and "Wi-Fi only" in app and 'autoplay: "all"' in app, "settings can keep autoplay on, limit it to Wi-Fi, or turn it off")
    accounts_js = (ROOT / "accounts.js").read_text(encoding="utf-8")
    check('tr("You reposted")' in app and "by.self" in app and 'data-act="repost-do"' in app and 'data-act="quote-open"' in app and "/v1/reposts" in app and "function profilePostsHtml(" in app and "function commitRepost(" in app and "profilePostsHtml" in accounts_js and 'tr("Posts")' in accounts_js and "account_reposts" in (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8") and "shared/reposts.js" in worker and "shared/handle-skeleton.js" in deployed_paths() and "shared/reposts.js" in deployed_paths() and 'method: "POST"' in app[app.index("function commitRepost("):app.index("function watchHash(")] and 'method: "DELETE"' not in app[app.index("function commitRepost("):app.index("function watchHash(")] and 'request.method === "POST" || request.method === "DELETE"' in (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8"), "a repost or quote is saved on the account and shown on that profile")
    check('data-act="face-pref"' in app and "showPictures" in app and "showBanners" in app and "Profile pictures" in app and ".ava-none { display: none; }" in css and "hide-avatar" in accounts_js and "avatarEmpty" in accounts_js and "bannerEmpty" in accounts_js and "data-acct=\"face\"" in accounts_js, "a picture or banner can be the photo, the default, or nothing at all")
    check('meta[name="theme-color"]' in app and 'meta[name="color-scheme"]' in app and "apple-mobile-web-app-status-bar-style" in app and "black-translucent" in page and ".wco { display: none; background: var(--bg); }" in css, "the status bar matches the theme")
    check('media="(prefers-color-scheme: light)" content="#FFFFFF"' in page and 'media="(prefers-color-scheme: dark)" content="#000000"' in page and 'name="theme-color" content="#000000"' in page and "#15202B" in page and "querySelectorAll('meta[name=\"theme-color\"]')" in app and '"#FFFFFF"' in app and '"#15202B"' in app and '"#000000"' in app and 'setAttribute("content", "black-translucent")' in app and 'setAttribute("content", "black-translucent")' in page and 'mode === "default" ? "default"' not in app and 'mode === "default" ? "default"' not in page and "calc(env(safe-area-inset-top, 0px) + 1px)" in css and "--bg: #000000" in css and "--bg: #15202B" in css and "--bg: #FFFFFF" in css, "theme-color matches Lights out, Dim, and Default, including before paint")
    check('class="add-account"' in app and "form.add-account" in app and "function parseAccountInput(" in app and "function saveOwnerX(" in app and "function saveOwnerTikTok(" in app and 'data-act="follow"' in app and 'data-act="follow-request"' not in app and "issues/new" not in app, "follow, unfollow, and add-by-paste stay in the app")
    check("/v1/owner/accounts" in app and 'tr("added accounts")' in app and 'tr("Fetching posts…")' in app and "saveOwnerX" in app, "the owner adds an X account from Feeds and shows it while posts are fetching")
    danger = css[css.index(".follow.remove-pill"):css.index(".follow.remove-pill") + 420]
    follow_pill = css[css.index("\n.follow {"):css.index("\n.follow {") + 240]
    remove_sheet = css[css.index(".modal.remove-sheet"):css.index(".modal.remove-sheet") + 420]
    check('data-act="ask-remove"' in app and 'class="follow remove-pill"' in app and "Remove @" in app and "whole site" in app and 'data-act="confirm-remove"' in app and "applyFollow([pending.id], false)" in app and "issues/new" not in app and "#f4212e" in danger and "rgba(244, 33, 46, 0.1)" in danger and "border: 1px solid #f4212e" in danger and "height: 32px" in danger and "font-size: 14px" in danger and "border-radius: 9999px" in follow_pill and ".row-actions" in css and ".remove-sheet" in css and "border-radius: 16px 16px 0 0" in remove_sheet, "removing a catalog feed confirms in an X dialog and unfollows on the account")
    translate_now = app[app.index("async function translateNow("):app.index("function formatDur(")]
    check("Translate post" in app and "Show original" in app and "function foreignScript(" in app and "function translateTarget(" in app and "LanguageDetector" in app and "function translateNow(" in app and "STATE.translated" in app and "FeedsTranslate" in app and "translate.google.com" not in app and "window.open" not in translate_now and "translated" not in app[app.index("function saveSettings("):app.index("function saveSettings(") + 800], "a foreign post translates in place, the app does not open Google Translate, and the result is not saved")
    translate_js = (ROOT / "translate.js").read_text(encoding="utf-8")
    check("Translate post" in translate_js and "Translate reply" in translate_js and "Translate bio" in translate_js and "Show original" in translate_js and "Translated from " in translate_js and "LanguageDetector" in translate_js and "downloadable" in translate_js and "api.mymemory.translated.net" in translate_js and "lingva" in translate_js and "translate.google.com" in translate_js and "sessionStorage" in translate_js and "Open in Google Translate" in translate_js, "in-place translation keeps links and falls through free engines")
    check("corsproxy.io" not in translate_js and "allorigins" not in translate_js and "api.x.com" not in translate_js, "translation does not depend on an open proxy or the X API")
    check(page.index('src="translate.js"') < page.index('src="app.js"') and 'href="translate.css"' in page, "the page loads the translator before the app")
    check(page.index('src="people.js"') < page.index('src="app.js"') and 'href="people.css"' in page, "the page loads unified profiles before the app")
    check(page.index('src="spaces.js"') < page.index('src="app.js"') and 'href="spaces.css"' in page, "the page loads the Space player before the app")
    check("translate.js" in deployed_paths() and "people.js" in deployed_paths() and "people.css" in deployed_paths() and "people.json" not in deployed_paths() and "suggestions.json" not in deployed_paths() and "feeds.config.json" not in deployed_paths(), "the deploy publishes translation and people files")
    check("people.js" in worker and "people.css" in worker and 'VERSION = "viktorych-a260-__SW_VERSION__"' in worker, "the service worker cache stamp drops the previous shell")
    check("tv.js" in deployed_paths() and "tv.css" in deployed_paths(), "the deploy publishes the TV layout")
    check("tv.js" in worker and "tv.css" in worker and "discord-ui.js" in worker and "discord-ui.css" in worker and "split.js" in worker and "viktorych-a260-__SW_VERSION__" in worker, "the service worker precaches the TV shell and the Discord messages UI")
    pill = app[app.index("function showPill("):app.index("function memoryPosts(")]
    check('route.name !== "home"' in pill and "homeShows(post, route)" in pill and any("showPill(pendingPillPosts())" in app[at:at + 1200] for at in [i for i in range(len(app)) if app.startswith('addEventListener("hashchange"', i)]) and "html.tv-on #new-posts" in css, "the new-posts pill stays on the current home tab")
    check(page.index('src="tv.js"') < page.index('src="app.js"') and 'href="tv.css"' in page and "FeedsTV" in app, "the page loads TV mode before the app and the app keeps a tiny hook")
    tv_js = (ROOT / "tv.js").read_text(encoding="utf-8")
    check("?." not in tv_js and "??" not in tv_js and "10009" in tv_js and "461" in tv_js and "youtube-nocookie.com/embed/" in tv_js and "TV mode" in tv_js, "TV mode stays on ES2017 and drives a nocookie player from the remote")
    check("spaces.js" in deployed_paths() and "spaces.css" in deployed_paths() and "live/" in deployed_paths(), "the deploy publishes the Space player and live status")
    check("people.js" in worker and "people.css" in worker and "spaces.js" in worker and "spaces.css" in worker and 'VERSION = "viktorych-a260-__SW_VERSION__"' in worker and "live/superintelmusic" not in worker, "the service worker cache stamp includes the Space shell and leaves live status fresh")
    row = subprocess.run(["node", "scripts/spaces_row_test.js"], cwd=ROOT, capture_output=True, text=True)
    check(row.returncode == 0, "space follow, allowlist, and marquee checks passed\n" + row.stdout + row.stderr)
    spaces_js = (ROOT / "spaces.js").read_text(encoding="utf-8")
    check("STATUS_MAX_AGE = 2 * 60 * 1000" in spaces_js and "STATUS_OFFLINE_AGE = 8 * 60 * 1000" in spaces_js and "function remoteStatusUrl(" in spaces_js and "function statusStale(" in spaces_js and "function statusOffline(" in spaces_js and "source.fallback" in spaces_js and "recoverMediaError" in spaces_js and "startLoad" in spaces_js and "liveSyncDurationCount: 3" in spaces_js and "maxBufferLength: 60" in spaces_js and "Reconnecting…" in spaces_js, "a remote Space stays up through a short stall, recovers the player, and goes offline after eight minutes or live:false")
    check("isSpaceAsset" in worker and "pub-bf9b5e3ebb2b421aa49e7af484f3c22d.r2.dev" in worker and '"r2.dev"' in worker and '"trycloudflare.com"' in worker and "isSpaceStatus(url) || isSpaceAsset(url)" in worker and 'cache: "no-store"' in worker, "the service worker does not cache the remote radio status or its segments")
    music = next(item for item in json.loads((ROOT / "feeds.config.json").read_text(encoding="utf-8"))["spaces"] if item["id"] == "superintelmusic")
    check(music["source"].get("type") == "loop" and music["source"].get("loopUrl") == "https://pub-bf9b5e3ebb2b421aa49e7af484f3c22d.r2.dev/loop/current.json" and "statusUrl" not in music["source"] and "fallback" not in music["source"] and music["source"]["allow"] == ["pub-bf9b5e3ebb2b421aa49e7af484f3c22d.r2.dev", "r2.dev"] and "url" not in music["source"], "ViktorychMusic plays the static loop and does not read the box status")
    check("function loopFromDoc(" in spaces_js and "LOOP_RECHECK_MS = 3 * 60 * 1000" in spaces_js and "LOOP_DRIFT_S = 5" in spaces_js and "startPosition:" in spaces_js and "cache: \"no-store\"" in spaces_js, "the loop player joins the shared clock and refreshes the bed every three minutes")
    check("function loopRecovery(" in spaces_js and "function refreshLoopSource(" in spaces_js and "function loopManifestDoc(" in spaces_js and "function loopNeedsRefresh(" in spaces_js and "function isLoopPointer(" in worker and "function isLoopVersionMedia(" in worker and "function forgetLoopCaches(" in worker and "loop/current.json" in worker, "a deleted loop version refetches current.json and status.json cannot mark the loop offline")
    check("function loopPlayChoice(" in spaces_js and "function flacInMp4(" in spaces_js and 'audio/mp4; codecs="flac"' in spaces_js and "MediaSource.isTypeSupported" in spaces_js and ".canPlayType(" in spaces_js, "the loop plays FLAC in mp4 and falls back when that codec is missing")
    check("drive.google.com" not in spaces_js and "download" not in spaces_js.lower(), "the Space player does not offer the radio or its masters as a download")
    radio_py = (ROOT / "scripts" / "radio_loop.py").read_text(encoding="utf-8")
    check("archive.org" not in radio_py and "-c:a\", \"flac\"" in radio_py and "-b:a\", \"256k\"" in radio_py, "the loop builder stays off the Internet Archive and encodes FLAC plus 256 kbps AAC")
    radio_check = subprocess.run([sys.executable, "scripts/radio_loop.py", "--self-check"], cwd=ROOT, capture_output=True, text=True)
    check(radio_check.returncode == 0, "the loop manifest grid matches the health check\n" + radio_check.stdout + radio_check.stderr)
    banned = re.compile("supa" + "base|sb_" + "publishable|nadjniz" + "sdaskttxahclp", re.I)
    banned_hits = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or ".git" in path.parts or path.suffix.lower() not in {".js", ".py", ".json", ".yml", ".md", ".html", ".css", ".svg", ".webmanifest"}:
            continue
        if banned.search(path.read_text(encoding="utf-8", errors="ignore")):
            banned_hits.append(str(path.relative_to(ROOT)))
    check(not banned_hits, "the old radio host is gone: " + ", ".join(banned_hits))
    check(page.index('src="i18n.js"') < page.index('src="marks.js"') < page.index('src="music.js"') < page.index('src="app.js"') and "brand.js" not in page and 'href="music.css"' in page, "the page loads translations and marks before music")
    check("music.js" in worker and "music.css" in worker and "i18n.js" in worker and "marks.js" in worker and "brand.js" not in worker and "data/music.json" in worker, "the service worker precaches music mode and refreshes its catalog")
    check("music.js" in deployed_paths() and "music.css" in deployed_paths() and "hls-1.7.3.min.js" in deployed_paths() and "data/music.json" in deployed_paths() and "assemble_site" in (ROOT / "scripts" / "discord_publish.py").read_text(encoding="utf-8"), "the deploy publishes ViktorychMusic")
    music_js = (ROOT / "music.js").read_text(encoding="utf-8")
    music_css = (ROOT / "music.css").read_text(encoding="utf-8")
    music_data = (ROOT / "data" / "music.json").read_text(encoding="utf-8")
    music_catalog = json.loads(music_data)
    check('productName("music")' in music_js and "SuperintelMusic" not in music_js and "SuperintelMusic" not in music_css and "SuperintelMusic" not in music_data and 'aria-label="ViktorychMusic"' in (ROOT / "logo" / "viktorychmusic.svg").read_text(encoding="utf-8"), "the music mode name comes from the language packs")
    check(any(song.get("id") == "america-dont-sit-still" and song.get("artist") == "ViktorychMusic" and song.get("kind") == "hls" and str(song.get("stream") or "").endswith("/index.m3u8") and song.get("stream") not in music_js for song in music_catalog.get("songs") or []), "the lossless release is credited in the catalog and its stream stays out of the script")
    check('parts[0] === "music"' in app and 'href: "#/music"' in app and 'href="#/music"' in music_js and 'classList.add("music-on")' in music_js and 'classList.remove("music-on")' in music_js and "audio.pause" in music_js, "music mode opens from its route and pauses on the way out")
    check('title === productName("music")' in music_js and '<h1 class="vh">' in music_js and 'const musicHome = route.name === "music"' in app and "else if (tall && !musicHome) bar = 106" in app, "music home shows the logo without a second title")
    music_row = subprocess.run(["node", "scripts/music_test.js"], cwd=ROOT, capture_output=True, text=True)
    check(music_row.returncode == 0, "SIntelMusic library checks passed\n" + music_row.stdout + music_row.stderr)
    catalog = subprocess.run([sys.executable, "scripts/music_catalog.py", "--selftest"], cwd=ROOT, capture_output=True, text=True)
    check(catalog.returncode == 0, "the SIntelMusic catalog issue check passed\n" + catalog.stdout + catalog.stderr)
    check("Mute and block" in app and "mutedWords" in app and "mutedAccounts" in app and "repostOff" in app and "Turn off reposts" in app and "function hiddenPost(" in app and "Muted on this device." in app, "muted words, muted accounts, and reposts stay on this device")
    follows_workflow = (ROOT / ".github" / "workflows" / "follows.yml").read_text(encoding="utf-8")
    music_workflow = (ROOT / ".github" / "workflows" / "music.yml").read_text(encoding="utf-8")
    check("github.actor ==" not in follows_workflow and "OWNER_ACTOR_SHA256" in follows_workflow and "github.actor == github.repository_owner" not in follows_workflow and "OWNER: ${{ github.repository_owner }}" not in follows_workflow and "startsWith(github.event.issue.title, 'Follow request')" not in follows_workflow and "startsWith(github.event.issue.title, 'Unfollow request')" not in follows_workflow and "startsWith(github.event.issue.title, 'Subscription groups')" in follows_workflow and "startsWith(github.event.issue.title, 'Link accounts')" in follows_workflow, "group and link issues stay owner-only, and follow requests are not public issues")
    check("github.actor ==" not in music_workflow and "OWNER_ACTOR_SHA256" in music_workflow and "github.actor == github.repository_owner" not in music_workflow and "REPO: ${{ github.repository }}" in music_workflow, "the music catalog issue is applied only for the human owner")
    check((ROOT / ".github" / "ISSUE_TEMPLATE" / "groups.yml").is_file(), "subscription group issue form exists")
    published = deployed_paths()
    assemble_src = (ROOT / "scripts" / "assemble_site.py").read_text(encoding="utf-8")
    check("feeds.json" not in published and "stories.json" not in published and "people.json" not in published and "suggestions.json" not in published and "feeds.config.json" not in published and "mindepth 2" not in assemble_src, "the public site does not copy private catalogs")
    chips_at = css.index(".yt-chips {")
    chips_css = css[chips_at:chips_at + 500]
    check("flex-wrap: nowrap" in chips_css and "overflow-x: auto" in chips_css, "subscription chips stay on one scrolling row")
    check("var(--fill)" in css[css.index(".yt-chip.on"):css.index(".yt-chip.on") + 160], "the selected subscription chip uses the inverted fill")
    check("yt-chips" in app and "New group" in app and "Add to group" in app and "subsGroup" in app and "groupsOwn" in app and "group=" in app and "function absorbSiteGroups(" in app and "Save groups on your account" in app and "Groups saved on your account." in app, "subscription groups filter from the chip bar and save on the account")
    subs_markup = app[app.index('return `<div class="subs'):app.index('return `<div class="subs') + 220]
    hidden_chips = css[css.index(".topbar.is-hidden ~ .yt-chips"):css.index(".topbar.is-hidden ~ .yt-chips") + 160]
    check("${head}${strip}${chips}${save}<div class=\"subs-feed\">" in subs_markup and "display: flow-root" in css[css.index(".subs-feed"):css.index(".subs-feed") + 80] and "z-index: 0" in css[css.index(".subs.grid .yt-grid"):css.index(".subs.grid .yt-grid") + 240], "the groups row sits under the channel strip and outside the video grid")
    check("top: env(safe-area-inset-top)" in hidden_chips, "the groups row sticks to the top when the phone header hides")
    subs_strip = app[app.index("const strip = `<div class=\"yt-strip\""):app.index("const strip = `<div class=\"yt-strip\"") + 1100]
    ch_name = css[css.index(".yt-ch .ch-name"):css.index(".yt-ch .ch-name") + 420]
    subs_view = app[app.index("function subsView("):app.index("function revealSubsChannel(")]
    check("function subsChannelHash(" in app and "parts[1] || query.get(\"c\")" in app and "subsChannelHash" in subs_strip and "accountHash" not in subs_strip and "ch-name" in subs_strip and "creditCarried" in subs_view and "onChannel" in subs_view and "-webkit-line-clamp: 2" in ch_name and "height: 32px" in ch_name and "align-items: flex-start" in css[css.index(".yt-strip {"):css.index(".yt-strip {") + 180], "a channel in the subscription row filters that creator's videos and its name wraps to two lines")
    tabs_css = css[css.index(".tabs {"):css.index(".tabs {") + 360]
    check("flex-wrap: nowrap" in tabs_css and "overflow-x: auto" in tabs_css and "white-space: nowrap" in tabs_css, "home tabs stay on one scrolling row")
    tab_menu_css = css[css.index(".menu.tab-menu"):css.index(".menu.tab-menu") + 1400]
    check("Manage tabs" in app and "Following options" in app and 'sortItem("recent", tr("Recent"))' in app and "Popular" in app and "Show reposts" in app and "Show replies" in app and "forYouReposts" in app and "forYouReplies" in app and 'q.set("reposts"' in app and 'q.set("sort"' in app and "function homeShows(" in app and "Scroll tabs left" in app and "followingSort" in app and "function syncTabArrows(" in app and "Unpin from Home" in app and "Edit list" in app and "list.sort" in app and "tabScrollRoute" in app and "top: auto !important" in tab_menu_css and "border-radius: 16px 16px 0 0" in tab_menu_css, "home tabs have a sort menu, a list menu, a manage button, and scroll arrows")
    check("function smoothTop(" in app and "function reloadAtTop(" in app and "function sameNavSection(" in app and "function goHash(" in app and "scrollFreeze" in app and "STATE.snapTop" in app, "the current section, selected tab, and phone header scroll to the top and a later back press keeps the feed position")
    check("function revealSelectedTab(" in app and "is-fade-left" in app and "is-fade-right" in app and 'behavior: reduced ? "auto" : "smooth"' in app and "--tab-arrow:" in css, "home tabs fade at the overflow edge and a hover scrolls one view")
    check("Reposts only" in app and "All posts" in app and "No reposts yet" in app and "function isRepost(" in app and "function byRepostTime(" in app and "tabViews" in app and 'item("reposts", tr("Reposts only"))' in app and 'q.set("view", "reposts")' in app and "forwardedFrom" in app, "each home tab can show only reposts, newest by repost time")
    check('class="notify-bell' in app and 'title="${tr("Notify")}"' in app and "Only posts with live video" in app and "You'll get notified when @" in app and "New post notifications for @" in app and "function scanBellPosts(" in app and "function postIsLiveVideo(" in app and "function ensureNotifyPermission(" in app and "Notification.requestPermission" in app and "bell-deliver" in app and "Without Web Push" in app and "function bellButton(" in app, "a followed profile can turn on post alerts")
    check("function postIsLiveVideo(" in worker and "bell-deliver" in worker and "bell-seen" in worker and "showNotification" in worker, "the service worker notifies bell accounts from background checks")
    check(".notify-bell" in css and "border-radius: 999px" in css[css.index(".notify-bell"):css.index(".notify-bell") + 500] and ".menu.bell-menu" in css and "border-radius: 16px 16px 0 0" in css[css.index(".menu.bell-menu"):css.index(".menu.bell-menu") + 2200] and "--bell-border:" in css, "the notify button is a round outlined control and the phone menu is a bottom sheet")
    check("bellButton" in (ROOT / "people.js").read_text(encoding="utf-8"), "unified profiles get the same notify bell")
    home_header = app[app.index("function homeHeader("):app.index("function tabChoice(")]
    note_tabs = app[app.index("function noteTabButton("):app.index("function noteRow(")]
    check("function cleanFeedTabs(" in app and "Add to tab…" in app and "Show on Home" in app and "Show in Notifications" in app and "lastNoteTab" in app and 'aria-label="${tr("New tab")}"' in app and "data-drag-tab" in app and "feedTabs:" in app and "Delete this tab" not in app and 'tr("Delete {name}?"' in app and "tab-grip" not in home_header and "tab-grip" not in note_tabs and "tab-dot" not in home_header and "tab-dot" not in note_tabs and "tab-plus" not in note_tabs and "tab-count" not in note_tabs, "custom tabs group accounts on Home and in Notifications and travel with settings")
    check(".tabs-bar.notes-tabs" in css and ".tab-grip" in css and ".tab-switch" in css and ".note-gear" in css and ".tab-count" not in css and ".tab-plus" not in css, "notification tabs use the home underline bar, and reorder handles stay in the editor")
    check("pinned.slice" not in app and "lists.slice(0," not in app, "pinned home tabs are not capped")
    check("function sharePostUrl(" in app and "function shareProfileUrl(" in app and "isn’t in the published snapshot" in app and 's/watch-"' in app and 's/" + (post.platform' in app and "function notePublished(" in app and "PUBLISHED.posts" in app, "share and copy use the static preview pages, and a live post outside the snapshot does not")
    check('og:image" content="landing/og.jpg"' in page and 'rel="canonical"' in page and "location.origin" in page and "__SITE_BASE__" not in page and "SuperintelApp/" not in page and "riverquoll.github.io" not in page and 'og:site_name" content="ViktorychApp"' in page and "<title>ViktorychApp</title>" in page and 'apple-mobile-web-app-title" content="ViktorychApp"' in page and "manifest.webmanifest?v=7" in page and "favicon.ico?v=7" in page and 'productName("app")' in app and "function routeTitle(" in app and '<a class="logo${' in app and 'class="m-logo" href="#/"' in app and 'markSvg("app", "logo-full")' in app and 'markSvg("appShort", "logo-short")' in app and 'markSvg("mark", "logo-si")' in app and "function githubRepo(" in app and "riverquoll" not in app and "viktorychapp-settings-v1" in page and "superintelapp-settings-v1" in page and 'readStored(localStorage, "settings-v1")' in app and "function shareRoot(" in app and "function pagesDirectory(" in app, "the home page names the app, the shortcut label is the short form, and copied links stay on this site")
    check('tr("Search {app}"' in app and "Surprise me" in app and "explore-mode" in app and 'const SEARCH_SUFFIX = "searches-v1"' in app and "readStored(localStorage, SEARCH_SUFFIX)" in app and 'id="explore-q"' in app and "function exploreHome(" in app and "function wordmarkSvg(" in app and '["videos", tr("Videos")]' in app and "ghome-logo" in css and 'html[data-theme="default"] .ghome-logo' in css, "explore is a search home with themed wordmark, suggestions, and result tabs")
    check('productName("search")' in app and 'productName("searchShort")' in app and "new ResizeObserver" in app and "EXPLORE_SEARCH_MIN = 13" in app and 'tr("Explore")' in app and 't("brand.search")' in (ROOT / "i18n.js").read_text(encoding="utf-8") and '"brand.search": "Search"' in (ROOT / "i18n" / "en.js").read_text(encoding="utf-8") and '"brand.search": "Поиск"' in (ROOT / "i18n" / "ru.js").read_text(encoding="utf-8") and '"brand.search": "Buscar"' in (ROOT / "i18n" / "es.js").read_text(encoding="utf-8"), "the explore field uses the search product name and keeps the Explore nav label")
    check("function shellDocument(" in worker and "/\\/(?:s|u)\\/" in worker, "a share-page navigation does not replace the cached app shell")
    check("python3 scripts/share_pages.py --site _site" in workflow, "the deploy rebuilds share pages inside the artifact")
    with tempfile.TemporaryDirectory() as share_dir:
        share_root = Path(share_dir)
        (share_root / "feeds.json").write_text(json.dumps({
            "feeds": [
                {"platform": "x", "handle": "ada", "name": "Ada <script>", "avatar": "https://pbs.twimg.com/profile_images/a_400x400.jpg", "bio": "Hello & welcome"},
                {"id": "vk:vk", "platform": "vk", "handle": "vk", "name": "ВКонтакте"},
            ],
            "posts": [
                {"platform": "x", "id": "100", "statusId": "100", "handle": "ada", "author": "Ada <script>", "text": "A <b>post</b> " + ("word " * 80), "url": "https://x.com/ada/status/100", "media": [{"type": "photo", "url": "https://pbs.twimg.com/media/abc.jpg?name=small", "width": 680, "height": 400}]},
                {"platform": "youtube", "id": "abcdefghijk", "statusId": "abcdefghijk", "handle": "Chan", "author": "Chan", "title": "Watch me", "text": "", "url": "https://www.youtube.com/watch?v=abcdefghijk", "media": [{"type": "video", "url": "https://www.youtube.com/embed/abcdefghijk", "poster": "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg", "width": 480, "height": 360}]},
                {"platform": "instagram", "id": "https://www.instagram.com/p/AbC123/", "statusId": "https://www.instagram.com/p/AbC123/", "handle": "ada", "author": "Ada", "text": "photo", "url": "https://www.instagram.com/p/AbC123/"},
                {"platform": "discord", "id": "discord:10:20", "statusId": "discord:10:20", "handle": "ada", "author": "Ada", "text": "hello", "url": "https://discord.com/channels/1/10/20"},
                {"platform": "x", "id": "nitter", "statusId": "nitter", "handle": "ada", "author": "Ada", "text": "From nitter", "media": [{"type": "photo", "url": "http://nitter.example/pic/media%2Fabc.jpg"}]},
                {"platform": "x", "id": "mp4", "statusId": "mp4", "handle": "ada", "author": "Ada", "text": "Clip", "media": [{"type": "video", "url": "http://video.twimg.com/amplify_video/1/vid/avc1/720x720/a.mp4", "poster": "https://pbs.twimg.com/amplify_video_thumb/1/img/a.jpg"}]},
                {"platform": "x", "id": "cdn", "statusId": "cdn", "handle": "cdn", "author": "CDN", "text": "skip", "avatar": "https://cdn.jsdelivr.net/gh/Example/Other@data/archive/x.jpg", "media": [{"type": "photo", "url": "https://raw.githubusercontent.com/Example/Other/data/archive/x.jpg"}]},
                {"platform": "vk", "id": "-220923985_58381", "statusId": "-220923985_58381", "feedId": "vk:vk", "handle": "vkfandomfest", "author": "Фандом Фест", "text": "Фестиваль", "kind": "repost", "repostedBy": {"name": "ВКонтакте", "handle": "vk", "platform": "vk", "feedId": "vk:vk"}},
            ],
        }), encoding="utf-8")
        archive = share_root / "archive"
        archive.mkdir()
        (archive / "2026-01.json").write_text(json.dumps([
            {"p": "x", "id": "100", "h": "ada", "t": "should not replace the full post"},
            {"p": "x", "id": "stub1", "h": "ada", "t": "old <i>note</i>"},
        ]), encoding="utf-8")
        (share_root / "s").mkdir()
        (share_root / "s" / "stale.html").write_text("old", encoding="utf-8")
        share_base = "https://example.github.io/Other/"
        counts = build_share_pages(
            share_root,
            share_base,
            thumb_probe=lambda url: "maxresdefault.jpg" in url,
        )
        post_html = (share_root / "s" / "x-100.html").read_text(encoding="utf-8")
        watch_html = (share_root / "s" / "watch-abcdefghijk.html").read_text(encoding="utf-8")
        ig_html = (share_root / "s" / "instagram-AbC123.html").read_text(encoding="utf-8")
        stub_html = (share_root / "s" / "x-stub1.html").read_text(encoding="utf-8")
        profile_html = (share_root / "u" / "x-ada.html").read_text(encoding="utf-8")
        check(counts["posts"] == 8 and counts["watch"] == 1 and counts["profiles"] == 2 and counts["stubs"] == 1 and counts["spaces"] == 1, "share pages cover posts, a watch page, a profile, a new stub, and a Space")
        vk_share = (share_root / "s" / "vk--220923985_58381.html").read_text(encoding="utf-8")
        check('class="repost"' in vk_share and "ВКонтакте reposted" in vk_share and 'href="../u/vk-vk.html"' in vk_share and "Фандом Фест" in vk_share, "a share page names who reposted and keeps the original author")
        space_html = (share_root / "s" / "space-superintelmusic.html").read_text(encoding="utf-8")
        check('og:title" content="ViktorychMusic"' in space_html and 'og:description" content="Live Space"' in space_html and "#/spaces/superintelmusic" in space_html and "streamTitle" not in space_html and old_repo not in space_html and 'src="../icons/' in space_html and f'og:url" content="{share_base}s/space-superintelmusic.html"' in space_html, "a Space share page uses the station title, the caller site URL, and a relative cover")
        discord_html = (share_root / "s" / "discord-discord-10-20.html").read_text(encoding="utf-8")
        check('og:title" content="Ada (@ada) on Discord"' in discord_html and "#/discord/ada/status/discord%3A10%3A20" in discord_html, "an id with colons still gets a share page and opens that post")
        check(not (share_root / "s" / "stale.html").exists(), "rebuilding share pages removes pages from the previous deploy")
        check("Ada &lt;script&gt;" in post_html and "<script>alert" not in post_html and "A &lt;b&gt;post&lt;/b&gt;" in post_html, "share page text is escaped")
        check('og:title" content="Ada &lt;script&gt; (@ada) on X"' in post_html and f'og:site_name" content="{SHARE_SITE}"' in post_html and 'name="theme-color" content="#000000"' in post_html and f'rel="canonical" href="{share_base}s/x-100.html"' in post_html and f'og:url" content="{share_base}s/x-100.html"' in post_html and noindex_tag in post_html and googlebot_tag in post_html, "a post page has the Open Graph title, site name, theme color, canonical URL, and noindex tags on this site")
        description = html_lib.unescape(post_html.split('og:description" content="', 1)[1].split('"', 1)[0])
        check("name=large" in post_html and 'og:image:width" content="2048"' in post_html and 'twitter:card" content="summary_large_image"' in post_html and description.endswith("…") and len(description) <= 200, "a wide image is preferred and the description stays near 200 characters")
        from share_pages import sized as size_share_image
        original = size_share_image("https://pbs.twimg.com/media/abc.jpg", 4096, 2599, "image")
        check(original["url"].endswith("?name=large") and original["width"] == 2048 and original["height"] == 1300, "a Twitter original is requested at the large rendition with matching dimensions")
        from share_pages import https as share_https
        check(share_https("http://pbs.twimg.com/media/abc.jpg") == "https://pbs.twimg.com/media/abc.jpg", "an http Twitter image is rewritten to https")
        check(share_https("https://nitter.example/pic/media%2Fabc.jpg") == "https://pbs.twimg.com/media/abc.jpg?name=large", "a Nitter picture proxy becomes the Twitter CDN image")
        check(share_https("http://video.twimg.com/tweet_video/abc.mp4") == "https://video.twimg.com/tweet_video/abc.mp4", "an http Twitter video is rewritten to https")
        check(share_https("https://cdn.jsdelivr.net/gh/x.png") == "" and share_https("https://raw.githubusercontent.com/o/r/data/x.jpg") == "", "jsDelivr and the data branch are not preview images")
        nitter_html = (share_root / "s" / "x-nitter.html").read_text(encoding="utf-8")
        mp4_html = (share_root / "s" / "x-mp4.html").read_text(encoding="utf-8")
        cdn_html = (share_root / "s" / "x-cdn.html").read_text(encoding="utf-8")
        check('og:image" content="https://pbs.twimg.com/media/abc.jpg?name=large"' in nitter_html, "a Nitter picture proxy is the share image")
        check('og:video" content="https://video.twimg.com/amplify_video/1/vid/avc1/720x720/a.mp4"' in mp4_html and 'og:video:type" content="video/mp4"' in mp4_html, "an http mp4 on video.twimg.com is shared as https")
        check("jsdelivr" not in cdn_html and "raw.githubusercontent.com" not in cdn_html and "og-card.png" in cdn_html, "a blocked image host falls back to the Feeds card")
        check("maxresdefault.jpg" in watch_html and 'twitter:card" content="player"' in watch_html and "youtube.com/embed/abcdefghijk" in watch_html and "#/watch/youtube:abcdefghijk" in watch_html, "a YouTube video offers a player card and opens the watch route")
        from share_pages import choose_youtube_thumb
        wide = choose_youtube_thumb("abcdefghijk", lambda url: "maxresdefault.jpg" in url)
        medium = choose_youtube_thumb("abcdefghijk", lambda url: "sddefault.jpg" in url)
        small = choose_youtube_thumb("abcdefghijk", lambda url: False)
        check(wide["width"] == 1280 and wide["height"] == 720 and wide["url"].endswith("maxresdefault.jpg"), "a YouTube poster prefers the 1280px image")
        check(medium["width"] == 640 and "sddefault.jpg" in medium["url"] and small["width"] == 480 and small["url"].endswith("hqdefault.jpg"), "a missing wide poster falls back to a thumbnail that exists")
        check("#/instagram/ada/status/https%3A%2F%2Fwww.instagram.com" in ig_html and f"Open in {SHARE_SITE}" in ig_html, "an unsafe id still opens the post the app can find")
        check("old &lt;i&gt;note&lt;/i&gt;" in stub_html and "should not replace" not in post_html, "a stub fills a missing post and does not replace a stored one")
        check('og:type" content="profile"' in profile_html and "Hello &amp; welcome" in profile_html and 'icons/og-card.png' not in profile_html, "a profile page uses the account and keeps its bio")
        check((share_root / "icons" / "og-card.png").is_file(), "the branded fallback card is written into the artifact")
    check(not (ROOT / ".github" / "ISSUE_TEMPLATE" / "follow-request.yml").is_file() and not (ROOT / ".github" / "ISSUE_TEMPLATE" / "unfollow-request.yml").is_file(), "follow and unfollow are not public issue forms")
    feeds_page = (ROOT / "feeds-page.js").read_text(encoding="utf-8")
    check("issues/new" not in feeds_page and "/v1/owner/feeds" in feeds_page and "api.x.com" not in feeds_page and "api.twitter.com" not in feeds_page, "adding a feed stays on the private owner API")
    import follow_request as follow_req

    check(not follow_req.allowed("stranger", "riverquoll") and follow_req.allowed("riverquoll", "riverquoll") and not follow_req.allowed("", "riverquoll"), "only the repository owner can change follows")
    parsed_follow = follow_req.parse_issue("Follow request: x sampleagency", "### Account\n\nsampleagency\n\n### Platform\n\nx\n")
    check(parsed_follow == {"kind": "follow", "account": "sampleagency", "platform": "x"}, "a follow issue form is read")
    x_spec = follow_req.normalize("https://x.com/sampleagency", "x")
    check(x_spec["platform"] == "x" and x_spec["handle"] == "sampleagency" and x_spec["url"] == "https://x.com/sampleagency", "an x profile URL becomes a handle")
    bare_spec = follow_req.normalize("@sampleagency", "")
    check(bare_spec["platform"] == "x" and bare_spec["handle"] == "sampleagency", "a bare @handle is an X account")
    yt_spec = follow_req.normalize("https://www.youtube.com/@SampleTechChannel", "youtube")
    check(yt_spec["handle"] == "SampleTechChannel" and yt_spec["channelId"] == "", "a youtube @handle is kept")
    yt_channel_spec = follow_req.normalize("https://www.youtube.com/channel/UCsyntheticmaple00005000", "youtube")
    check(yt_channel_spec["channelId"] == "UCsyntheticmaple00005000", "a youtube channel id is kept")
    check(follow_req.normalize("https://vk.com/vk", "vk")["handle"] == "vk", "a vk profile URL is a handle")
    check(follow_req.normalize("https://www.threads.net/@birchlane", "threads")["handle"] == "birchlane", "a threads URL is a handle")
    check(follow_req.normalize("https://www.instagram.com/birchlane/", "instagram")["handle"] == "birchlane", "an instagram URL is a handle")
    tg_link = follow_req.normalize("https://t.me/s/laneharbor", "")
    check(tg_link["platform"] == "telegram" and tg_link["handle"] == "laneharbor" and tg_link["url"] == "https://t.me/laneharbor", "a t.me preview link is a Telegram channel")
    tg_at = follow_req.normalize("telegram:@laneharbor", "telegram")
    check(tg_at["handle"] == "laneharbor" and tg_at["url"] == "https://t.me/laneharbor", "telegram:@name is a Telegram follow")
    tg_entry = follow_req.entry_for(tg_at)
    check(tg_entry["adapter"] == "telegram" and tg_entry["source_urls"] == ["https://t.me/s/{handle}"] and tg_entry["fallbacks"][0]["source_urls"] == ["{rsshubBase}/telegram/channel/{handle}"], "a Telegram follow uses the public preview and RSSHub backup")
    check(follow_req.check_url(tg_at) == "https://t.me/s/laneharbor", "Telegram is confirmed from the public preview")
    rss_spec = follow_req.normalize("https://example.com/feed.xml", "rss")
    check(rss_spec["platform"] == "rss" and rss_spec["url"] == "https://example.com/feed.xml", "an https feed is an rss follow")
    http_rejected = False
    try:
        follow_req.normalize("http://example.com/feed.xml", "rss")
    except follow_req.Reject:
        http_rejected = True
    check(http_rejected, "an http feed is rejected")
    public_ok = follow_req.host_is_public("one.one.one.one", lambda host: ["1.1.1.1"])
    loopback = follow_req.host_is_public("local.test", lambda host: ["127.0.0.1"])
    private_net = follow_req.host_is_public("lan.test", lambda host: ["10.1.2.3"])
    link_local = follow_req.host_is_public("meta.test", lambda host: ["169.254.169.254"])
    check(public_ok and not loopback and not private_net and not link_local, "only public addresses can be fetched")

    def fake_follow_fetch(url):
        if "fxtwitter.com/sampleagency" in url:
            return 200, '{"user":"sampleagency"}'
        if "youtube.com/@" in url:
            return 200, 'href="https://www.youtube.com/channel/UCsyntheticmaple00005000"'
        if "videos.xml" in url:
            return 200, "<feed></feed>"
        if "example.com" in url:
            return 200, "<rss><channel></channel></rss>"
        return 404, ""

    public_resolve = lambda host: ["1.1.1.1"]
    confirmed_yt = follow_req.confirm_source(dict(yt_spec), fake_follow_fetch, public_resolve)
    check(confirmed_yt["channelId"] == "UCsyntheticmaple00005000", "a youtube page supplies the channel id")
    follow_config = {"feeds": []}
    added, follow_config = follow_req.run("riverquoll", "riverquoll", "Follow request: x sampleagency", "### Account\n\nsampleagency\n\n### Platform\n\nx\n", follow_config, fake_follow_fetch, public_resolve)
    added_row = follow_config["feeds"][0]
    check(added.startswith("Added x:sampleagency") and added_row["adapter"] == "fxtwitter" and added_row["fallbacks"][0]["adapter"] == "nitter_rss", "a follow adds the fxtwitter source and nitter fallbacks")
    duplicate_rejected = False
    try:
        follow_req.run("riverquoll", "riverquoll", "Follow request: x sampleagency", "### Account\n\nsampleagency\n\n### Platform\n\nx\n", follow_config, fake_follow_fetch, public_resolve)
    except follow_req.Reject:
        duplicate_rejected = True
    check(duplicate_rejected, "a duplicate follow is rejected")
    removed, follow_config = follow_req.run("riverquoll", "riverquoll", "Unfollow request: x sampleagency", "### Account\n\nx:sampleagency\n\n### Platform\n\nx\n", follow_config, fake_follow_fetch, public_resolve)
    check(removed.startswith("Removed x:sampleagency") and follow_config["feeds"] == [] and "x:sampleagency" in follow_config.get("removed", []), "an unfollow removes the account and blocks auto-add")
    brought, follow_config = follow_req.run("riverquoll", "riverquoll", "Follow request: x sampleagency", "### Account\n\nsampleagency\n\n### Platform\n\nx\n", follow_config, fake_follow_fetch, public_resolve)
    check(brought.startswith("Added x:sampleagency") and follow_config["feeds"][0]["id"] == "x:sampleagency" and follow_config.get("removed") == [], "an explicit follow clears the auto-add block")
    untouched = {"feeds": [{"id": "x:keep"}]}
    ignored, same_config = follow_req.run("someone", "riverquoll", "Follow request: x sampleagency", "### Account\n\nsampleagency\n\n### Platform\n\nx\n", untouched, fake_follow_fetch, public_resolve)
    check(ignored == "" and same_config["feeds"] == [{"id": "x:keep"}], "an issue from anyone else is ignored")
    group_body = "### Groups\n\n" + json.dumps([{"id": "grp_news", "name": "News", "icon": "https://example.com/a.png", "members": ["youtube:Someone"]}])
    saved, grouped = follow_req.run("riverquoll", "riverquoll", "Subscription groups", group_body, {"feeds": [{"id": "x:keep"}]}, fake_follow_fetch, public_resolve)
    check(saved == "Saved 1 subscription groups." and grouped["feeds"] == [{"id": "x:keep"}] and grouped["groups"][0]["id"] == "grp_news" and grouped["groups"][0]["members"] == ["youtube:Someone"], "the owner can publish subscription groups without touching feeds")
    stranger_groups, stranger_config = follow_req.run("someone", "riverquoll", "Subscription groups", group_body, {"feeds": [{"id": "x:keep"}]}, fake_follow_fetch, public_resolve)
    check(stranger_groups == "" and "groups" not in stranger_config, "a groups issue from anyone else is ignored")
    private_icon = False
    try:
        follow_req.clean_groups([{"id": "grp_a", "name": "A", "icon": "https://local.test/a.png", "members": []}], lambda host: ["127.0.0.1"])
    except follow_req.Reject:
        private_icon = True
    check(private_icon, "a private group icon is rejected")
    script_icon = False
    try:
        follow_req.clean_groups([{"id": "grp_a", "name": "A", "icon": "javascript:alert(1)", "members": []}], public_resolve)
    except follow_req.Reject:
        script_icon = True
    check(script_icon, "a javascript group icon is rejected")
    check(follow_req.clean_groups("[]", public_resolve) == [], "an empty group list clears site groups")
    import sync_health

    clock = {}
    sync_health.record_source(clock, "vk:vk", False, "2026-10-21T06:00:00Z", "no source")
    sync_health.record_source(clock, "vk:vk", False, "2026-10-21T07:00:00Z", "no source")
    check(clock["vk:vk"]["emptySince"] == "2026-10-21T06:00:00Z", "an empty source starts the clock once")
    sync_health.record_source(clock, "vk:vk", True, "2026-10-21T08:00:00Z")
    check(clock["vk:vk"].get("ok") == "2026-10-21T08:00:00Z" and "emptySince" not in clock["vk:vk"], "posts from a source clear the empty clock")
    quiet = {"feeds": [{"id": "x:copperlane", "emptySince": "", "ok": "2026-10-21T11:00:00Z"}, {"id": "vk:vk", "emptySince": "2026-10-21T06:00:00Z", "detail": "no source"}]}
    check(sync_health.problems(quiet, "2026-10-21T11:00:00Z") == [], "five hours of nothing does not alert, and a quiet account that still returns posts is healthy")
    stale = sync_health.problems(quiet, "2026-10-21T12:00:00Z")
    check(len(stale) == 1 and stale[0].startswith("vk:vk has returned nothing since 2026-10-21T06:00:00Z"), "six hours of nothing is a sync problem")
    check(sync_health.problems(None, "2026-10-21T12:00:00Z", "failure", "skipped") == ["The sync failed."], "a failed sync opens a problem without a report")
    check(sync_health.problems(None, "2026-10-21T12:00:00Z", "skipped", "skipped", "failure") == ["The Accounts deploy failed, so Pages was not updated."], "a failed Accounts deploy keeps the previous Pages and is reported")
    check(sync_health.problems({"feeds": []}, "2026-10-21T12:00:00Z", "success", "failure") == ["The Pages deploy failed."], "a failed Pages deploy is a sync problem")
    same_body = sync_health.body_for(stale, "https://example.test/1")
    check(sync_health.plan([], [])["action"] == "none", "a healthy sync with no issue does nothing")
    check(sync_health.plan([], [{"number": 7, "title": "Sync problem", "body": same_body}])["action"] == "close", "a healthy sync closes the open problem")
    check(sync_health.plan(stale, [])["action"] == "open", "the first problem opens one issue")
    check(sync_health.plan(stale, [{"number": 7, "title": "Sync problem", "body": same_body}])["action"] == "none", "the same problem does not edit the issue")
    check(sync_health.plan(stale, [{"number": 7, "title": "Sync problem", "body": "The sync is not healthy.\n\n- something else\n"}])["action"] == "edit", "a changed problem edits the same issue")
    check(sync_health.plan(stale, [{"number": 3, "title": "Follow request: x sampleagency", "body": ""}])["action"] == "open", "a follow request is not the sync problem issue")
    import discord_alert

    stopped = discord_alert.SENTENCES["unauthorized"]
    secret = "super-secret-discord-token"
    check(discord_alert.safe_reason(stopped) == stopped and secret not in discord_alert.safe_reason("401 " + secret) and secret not in discord_alert.body_for("captcha " + secret, "https://example.test/run"), "the account issue uses a fixed sentence and drops the token")
    opened = {"number": 4, "title": "Discord account needs attention", "body": discord_alert.body_for(stopped, "https://example.test/run")}
    check(discord_alert.plan(True, stopped, [])["action"] == "open", "the first account failure opens one issue")
    same = discord_alert.plan(True, stopped, [opened, {"number": 9, "title": "Discord account needs attention", "body": "dup"}])
    check(same["action"] == "none" and same["extra"] == [9], "the same account issue is kept and a duplicate is closed")
    check(discord_alert.plan(True, discord_alert.SENTENCES["captcha"], [opened])["action"] == "edit", "a new account failure updates the same issue")
    check(discord_alert.plan(False, "", [opened])["action"] == "close" and discord_alert.plan(False, "", [])["action"] == "none", "a guild read that works again closes the account issue")
    check(discord_alert.attention({"feeds": [{"id": "discord", "detail": stopped}]}) == ("paused", stopped), "an account stop in the sync report pauses Discord")
    check(discord_alert.attention({"feeds": [{"id": "discord", "ok": "2026-10-21T00:00:00Z", "detail": ""}]}) == ("ok", ""), "a clean Discord row closes the account issue")
    check(discord_alert.attention({"feeds": [{"id": "discord", "ok": "2026-10-21T00:00:00Z", "detail": "Discord rejected the bot token. Discord sync stopped for this run and will not retry."}]})[0] == "unknown", "a rejected bot token is not the user account issue")
    check("issues: write" in (ROOT / ".github" / "workflows" / "discord-live.yml").read_text(encoding="utf-8"), "the live workflow can update the account issue")
    workflow_text = (ROOT / ".github" / "workflows" / "sync.yml").read_text(encoding="utf-8")
    check("name: sync-report" in workflow_text and "TITLE = \"Sync problem\"" in (ROOT / "scripts" / "sync_health.py").read_text(encoding="utf-8") and "needs: [gate, build, deploy, wait-accounts, refresh]" in workflow_text, "the sync uploads a report and keeps one problem issue")
    check("function autoplayAllowed(" in app and "prefers-reduced-motion" in app and "prefers-reduced-data" in app and "saveData" in app and "is not Never" in app and 'threshold: [0, 0.5, 1]' in app and 'rootMargin: "0px"' in app and "playsinline" in app and "autoplay=1&mute=1&playsinline=1&controls=0" in app and 'preload = "none"' in app and "STATE.sound" in app and "strict-origin-when-cross-origin" in app and "function scheduleIdleReload(" in app and 'box.id = "autoplay-debug"' in app and "function xRefresh(" in app and "onReady" in app and "reload-armed" in app, "one in-view video previews muted, a miss is explained, and an update reloads when idle")
    check("function fetchShellFile(" in worker and 'cache: "no-store"' in worker and "skipWaiting" in worker and "clients.claim" in worker and "function isShell(" in worker and "apply-update" in worker and "skip-waiting" in worker and "update-progress" in worker and "version.json" in worker and "includeUncontrolled" in worker and "precacheShell" in worker and "precacheDelay" in worker and "serve-network-once" in worker and "__SW_BUILT__" in worker and "translate.js" in worker and "translate.css" in worker and "ACCOUNTS_WALL = false" in worker, "a new service worker waits, retries a failed shell file, then claims clients")
    check("ViktorychUpdate" in app and "holdsReload" in app and 'src="update.js"' in (ROOT / "index.html").read_text(encoding="utf-8") and "python3 scripts/write_version.py --out version-next/version.json" in workflow_text and "python3 scripts/write_version.py --previous --out _site/version.json" in workflow_text and "artifact_name: app-shell-version" in workflow_text and "needs: [gate, verify-live, pages-mirror]" in workflow_text and "update.js" in deployed_paths(), "the page offers a full-screen update and the deploy publishes the version manifest after the assets")
    update_js = (ROOT / "update.js").read_text(encoding="utf-8")
    check("expectingController" in update_js and "shouldOfferReset" in update_js and "safeFailure" in update_js and "serve-network-once" in update_js, "retry starts a new update and can reload the current version from the network")
    import write_version
    write_version.selftest()
    import handle_guard
    check(handle_guard.selftest() == 0, "the handle guard hashes a private list")
    guard_src = (ROOT / "scripts" / "handle_guard.py").read_text(encoding="utf-8")
    guard_workflow = (ROOT / ".github" / "workflows" / "handle-guard.yml").read_text(encoding="utf-8")
    check("hash comparison skipped" in guard_src and "HANDLE_ALLOWLIST" in guard_src and "derived " in guard_src, "the handle guard skips when the private catalog cannot be read")
    check("CLOUDFLARE_API_TOKEN" in guard_workflow and "HANDLE_DENYLIST" in guard_workflow and "HANDLE_GUARD_REQUIRE_CATALOG" in guard_workflow, "the handle guard reads the private catalog and still accepts an optional list")
    import catalog_migrate
    check(catalog_migrate.selftest() == 0, "the catalog migration copies counts and sizes only")
    import r2_catalog
    check(r2_catalog.selftest() == 0, "a missing catalog keeps the last good copy")
    import subprocess
    update_flow = subprocess.run(["node", str(ROOT / "scripts" / "update_flow_test.js")], cwd=ROOT)
    check(update_flow.returncode == 0, "the update flow helpers pass")
    comments_client = subprocess.run(["node", str(ROOT / "scripts" / "comments_client_test.mjs")], cwd=ROOT)
    check(comments_client.returncode == 0, "comments share in-flight loads, cache for minutes, revalidate stale pages, and cancel on leave")
    check("function posterList(" in app and "function posterOrder(" in app and "function feedFrame(" in app and "function frameSpec(" in app and "100cqw" in app and "function clipLoops(" in app and "data-falls" in app and "onStateChange" in app and "enablejsapi=1" in app and "ratio >= 0.5" in app and "el._hold" in app and "lockHlsTop(" in app and "capLevelToPlayerSize: false" in app and "i.ytimg.com/vi/" in app, "a video keeps a real thumbnail until playback and starts muted at about 50 percent visible")
    check("function stripLeadMentions(" in app and "function threadPair(" in app and "parentShown" in app and 'class="thread"' in app and "function quoteCard(" in app, "a reply with its parent is a thread and a quote stays a quote card")
    frame_test = subprocess.run(["node", str(ROOT / "scripts" / "media_frame_test.js")], cwd=ROOT)
    check(frame_test.returncode == 0, "media frames keep each ratio and a reply thread strips only leading mentions")
    check('data-preview="subs"' in app and 'index, "feed"' in app and ".vmute" in css and ".vleft" in css and "function vkRefresh(" in app, "feed cards show mute and remaining time, and a dead file is resolved again")
    check("function followedFeeds()" in app and "LIVE_REFRESH_MS = 60 * 1000" in app and "function livePostsForFeed(" in app and "/community" in app and "feeds.config.json" in app, "near-live refresh walks every followed feed")
    follow_fn = app[app.index("function followedFeeds()"):app.index("function followedFeeds()") + 500]
    check("copperlane" not in follow_fn and "mosspoint" not in follow_fn and "northlamp" not in follow_fn, "live refresh has no per-account special case")
    check("return !isSelfReply(post);" in app and "replyParent" in app and "pill-faces" in css and "reply-context" in css and ".thread > .post.continues" in css and "--thread:" in css, "home shows replies to other people and the new-posts pill can show avatars")
    config_text = (ROOT / "feeds.config.json").read_text(encoding="utf-8")
    community_src = (ROOT / "scripts" / "adapters" / "youtube_community.py").read_text(encoding="utf-8")
    check("rsshub.rssforever.com" not in config_text and "rsshub.pseudoyu.com" not in config_text and "hub.slarker.me" not in config_text, "public RSSHub mirrors are not feed sources")
    check('"id": "vk:vk"' in config_text and '"platform": "vk"' in config_text, "the official VK community is a configured follow")
    from adapters.vk import parse as parse_vk
    from adapters.vk import parse_comments as parse_vk_comments
    from vk_remote import parse_web_client

    vk_doc = parse_vk(json.loads((FIX / "vk_wall_vk.json").read_text(encoding="utf-8")), {"id": "vk:vk", "platform": "vk", "handle": "vk"})
    check(len(vk_doc["posts"]) == 4, "vk wall keeps the text post, the video, the copy, and the co-owned post")
    vk_text_post = vk_doc["posts"][0]
    check("запись в блоге" in vk_text_post["text"] and "away.php" not in vk_text_post["text"] and vk_text_post["media"][0]["url"].endswith("vk-large.jpg"), "vk markup becomes the label and the largest photo")
    check(vk_text_post["url"] == "https://vk.com/wall-10000041_1730797" and vk_text_post["stats"]["replies"] == 12, "vk post links to the wall and keeps the comment count")
    vk_video = vk_doc["posts"][1]
    check(vk_video["media"][0]["type"] == "video" and vk_video["media"][0]["poster"].endswith("vk-video.jpg") and vk_video["media"][0]["open"].startswith("https://vk.com/video"), "vk video keeps a poster and the watch page")
    vk_repost = vk_doc["posts"][2]
    check(vk_repost["kind"] == "repost" and vk_repost["handle"] == "team" and vk_repost["repostedBy"]["handle"] == "vk" and vk_repost["repostedBy"]["platform"] == "vk" and vk_repost["repostedBy"]["feedId"] == "vk:vk" and "Исходная" in vk_repost["text"], "vk repost credits the community and shows the original")
    vk_wall = next(post for post in vk_doc["posts"] if post["id"] == "-220923985_58381")
    check(vk_wall["kind"] == "repost" and vk_wall["author"] == "Фандом Фест" and vk_wall["handle"] == "vkfandomfest" and vk_wall["url"] == "https://vk.com/wall-220923985_58381" and vk_wall["repostedBy"]["name"] == "ВКонтакте" and vk_wall["repostedBy"]["handle"] == "vk" and vk_wall["repostedBy"]["feedId"] == "vk:vk" and "Фестиваль" in vk_wall["text"], "a co-owned wall post keeps the original author and names who reposted it")
    owned_wall = parse_vk({"response": {"count": 2, "items": [
        {"id": 9, "owner_id": -10000041, "from_id": -10000041, "date": 10, "post_type": "post", "text": "Своя запись", "header": {"title": {"source_id": -10000041, "source_ids": [-10000041, -9]}}, "coowners": {"list": [{"owner_id": -10000041}, {"owner_id": -9}]}},
        {"id": 3, "owner_id": -10000041, "from_id": -10000041, "date": 9, "post_type": "copy", "text": "Смотрите", "copy_history": [{"id": 4, "owner_id": -1, "from_id": -1, "date": 8, "post_type": "post", "text": "Чужая запись"}]},
    ], "groups": [{"id": 10000041, "name": "ВКонтакте", "screen_name": "vk"}, {"id": 1, "name": "Команда", "screen_name": "team"}]}}, {"id": "vk:vk", "platform": "vk", "handle": "vk"})
    check(owned_wall["posts"][0]["kind"] == "post" and owned_wall["posts"][0]["handle"] == "vk" and not owned_wall["posts"][0].get("repostedBy"), "a post the community owns stays its own post")
    check(owned_wall["posts"][1]["kind"] == "quote" and owned_wall["posts"][1]["handle"] == "vk" and owned_wall["posts"][1]["quoted"]["handle"] == "team", "a copy with commentary stays a quote")
    check(vk_doc["profiles"][0]["name"] == "ВКонтакте" and vk_doc["profiles"][0]["followers"] == 14000000 and vk_doc["profiles"][0]["url"] == "https://vk.com/vk" and vk_doc["profiles"][0]["verifiedType"] == "business" and vk_doc["profiles"][0]["postsCountIncludesReposts"] is True, "vk profile comes from the community and its wall count includes reposts")
    from adapters.common import credit_carried
    stored = [
        {"id": "-10000041_1", "statusId": "-10000041_1", "platform": "vk", "feedId": "vk:vk", "kind": "post", "author": "ВКонтакте", "handle": "vk", "text": "own"},
        {"id": "-220923985_58381", "statusId": "-220923985_58381", "platform": "vk", "feedId": "vk:vk", "kind": "post", "author": "Фандом Фест", "handle": "vkfandomfest", "text": "kept"},
        {"id": "19", "platform": "telegram", "feedId": "telegram:laneharbor", "kind": "post", "author": "Telegram News", "handle": "laneharbor", "text": "The original note.", "forwardedFrom": {"name": "Pavel foxglen", "handle": "foxglen"}},
    ]
    check(credit_carried(stored, [{"id": "vk:vk", "platform": "vk", "handle": "vk", "name": "ВКонтакте"}, {"id": "telegram:laneharbor", "platform": "telegram", "handle": "laneharbor", "name": "Telegram News"}]) == 2 and stored[1]["kind"] == "repost" and stored[1]["author"] == "Фандом Фест" and stored[1]["repostedBy"]["name"] == "ВКонтакте" and stored[0]["kind"] == "post" and stored[2]["kind"] == "repost" and stored[2]["author"] == "Pavel foxglen" and stored[2]["handle"] == "foxglen" and stored[2]["repostedBy"]["handle"] == "laneharbor", "stored wall posts and forwards grow a repost line without taking the original author's name")
    vk_comments = parse_vk_comments(
        {"response": {"count": 1, "items": [{"id": 9, "from_id": 5, "owner_id": -10000041, "post_id": 1730797, "date": 1792307000, "text": "Привет", "likes": {"count": 3}, "thread": {"count": 0, "items": []}}], "profiles": [{"id": 5, "first_name": "Аня", "last_name": "Иванова", "screen_name": "anya"}]}},
        {"statusId": "-10000041_1730797", "handle": "vk"},
    )
    check(len(vk_comments) == 1 and vk_comments[0]["text"] == "Привет" and vk_comments[0]["handle"] == "anya" and vk_comments[0]["replyingTo"]["id"] == "-10000041_1730797", "vk comments keep the author and the parent")
    vk_client = parse_web_client('{clientSecret:L,clientId:R,authClientId:D}=(j=111,P="publicsecretvalue1",O=1);mG:"5.289"')
    check(vk_client == ("111", "publicsecretvalue1", "5.289"), "the public web bundle yields the anonymous client")
    check("6287487" not in (ROOT / "scripts" / "vk_remote.py").read_text(encoding="utf-8"), "vk client credentials are parsed from vk.com, not copied into the repo")
    check("loadVkSaved" in app and "Watch on VK" in app and "seenFeeds" in app and "seenDefaults" in app and "function mergeDefaultFollows(" in app and 'id === "vk:vk"' in app and 'platform === "vk"' in app, "vk profiles use the synced wall and a new follow is picked up once")
    check("function catalogSignature(" in app and "feedsChanged" in app and "function adoptFeeds(" in app, "a configured feed with no posts still updates the Feeds page")
    from adapters.telegram import fetch_channel, parse as parse_telegram

    tg_html = (FIX / "telegram_channel.html").read_text(encoding="utf-8")
    tg_feed = {"id": "telegram:laneharbor", "platform": "telegram", "handle": "laneharbor", "_probe": lambda url: ("bad" not in url, "ok")}
    tg_doc = parse_telegram(tg_html, tg_feed)
    check(len(tg_doc["posts"]) == 11, "telegram preview keeps every message type")
    tg_by = {post["id"]: post for post in tg_doc["posts"]}
    formatted = tg_by["10"]
    check("<b>Bold</b>" in formatted["html"] and "<i>italic</i>" in formatted["html"] and "<u>" in formatted["html"] and "<s>" in formatted["html"] and "<code>" in formatted["html"] and "<pre>" in formatted["html"] and 'class="tg-spoiler"' in formatted["html"] and 'class="tg-emoji"' in formatted["html"] and "<script" not in formatted["html"], "telegram formatting stays as safe html")
    check("secret words" in formatted["text"] and formatted["stats"]["views"] == 1590000 and formatted["edited"] is True and formatted["date"].startswith("2026-08-26T19:11:05"), "telegram keeps plain text, views, the edit flag, and the exact time")
    check(len(tg_by["11"]["media"]) == 3 and all(item["type"] == "photo" for item in tg_by["11"]["media"]), "a telegram album is a multi-image grid")
    check(tg_by["12"]["media"][0]["url"].endswith("good.mp4") and tg_by["12"]["media"][0]["type"] == "video" and not tg_by["12"]["media"][0].get("round"), "a probed telegram video keeps its mp4")
    check(tg_by["13"]["media"][0]["type"] == "animated_gif" and tg_by["14"]["media"][0].get("round") is True, "telegram GIFs and round videos keep their shape")
    bad_video = parse_telegram(tg_html.replace("good.mp4", "bad.mp4"), tg_feed)["posts"]
    bad_row = next(post for post in bad_video if post["id"] == "12")
    check(bad_row["media"][0]["url"] == "" and bad_row["media"][0]["poster"].endswith("poster.jpg"), "a telegram video that does not play falls back to its poster")
    check(tg_by["15"]["media"][0]["type"] == "audio" and tg_by["16"]["media"][0]["type"] == "file" and tg_by["16"]["media"][0]["title"] == "notes.pdf", "telegram voice and documents become attachment cards")
    check(tg_by["17"]["link"]["title"] == "Hello from the blog" and tg_by["17"]["link"]["image"].endswith("card.jpg") and not tg_by["17"]["media"], "a telegram link preview is a card, not another photo")
    check(tg_by["18"]["poll"]["question"] == "Which build?" and tg_by["18"]["poll"]["choices"][1]["percent"] == 38, "a telegram poll keeps the question and the percents")
    check(tg_by["19"]["forwardedFrom"]["name"] == "Pavel foxglen" and tg_by["19"]["forwardedFrom"]["handle"] == "foxglen" and tg_by["19"]["kind"] == "repost" and tg_by["19"]["author"] == "Pavel foxglen" and tg_by["19"]["handle"] == "foxglen" and tg_by["19"]["repostedBy"]["name"] == "Telegram News" and tg_by["19"]["repostedBy"]["handle"] == "laneharbor" and tg_by["19"]["repostedBy"]["platform"] == "telegram", "a telegram forward keeps the original author and names the channel that reposted it")
    check(tg_by["20"]["replyParent"]["author"] == "Telegram News" and tg_by["20"]["replyingTo"]["id"] == "10" and tg_by["20"].get("discussion") is True and tg_by["20"]["kind"] == "post", "a telegram reply shows its parent and can open comments")
    quiet = parse_telegram(tg_html + '\n<div id="feeds-discussion" data-on="0"></div>', tg_feed)
    check(all(not post.get("discussion") for post in quiet["posts"]), "a channel without a discussion hides comments")
    tg_profile = tg_doc["profiles"][0]
    check(tg_profile["name"] == "Telegram News" and tg_profile["followers"] == 9270000 and tg_profile["verifiedType"] == "blue" and tg_profile["url"] == "https://t.me/laneharbor" and tg_profile["bannerColor"].startswith("linear-gradient"), "telegram profile keeps the title, subscribers, and theme banner")
    rss_payload = '<?xml version="1.0"?><rss><channel><item><title>Telegram News</title><link>https://t.me/laneharbor/3</link><description>&lt;b&gt;Hello&lt;/b&gt;</description><pubDate>Wed, 26 Aug 2026 19:11:05 +0000</pubDate></item></channel></rss>'
    rss_post = parse_telegram(rss_payload, tg_feed)["posts"][0]
    check(rss_post["id"] == "3" and "Hello" in rss_post["text"] and "<b>Hello</b>" in rss_post["html"], "the RSSHub backup is parsed by the same adapter")
    pages = {
        "https://t.me/s/laneharbor": '<div class="tgme_widget_message" data-post="telegram/2"><div class="js-message_text">one</div></div><a data-before="2"></a>',
        "https://t.me/s/laneharbor?before=2": '<div class="tgme_widget_message" data-post="telegram/1"><div class="js-message_text">two</div></div>',
    }
    backfill = fetch_channel("laneharbor", limit=2, backfill=True, get=lambda url: pages[url])
    check('data-post="telegram/1"' in backfill and 'data-post="telegram/2"' in backfill, "the first follow walks ?before= until the window is full")
    check('"id": "telegram:laneharbor"' in config_text and "loadTelegramSaved" in app and "Watch on Telegram" in app and 'act === "spoiler"' in app and ".tg-spoiler" in css and 'platform === "telegram"' in app and "t.me" in app and '["posts", tr("Posts")], ["media", tr("Media")]' in app, "telegram is configured and rendered with Posts and Media")
    check("RSSHUB_MIRRORS" not in community_src and "rssforever" not in community_src, "community posts use the local RSSHub container")
    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    check("fallback/" in ignore and "status.json" in ignore, "generated fallback files stay out of git")

    from datetime import datetime as dt
    from own_fetch import (
        extract_watch,
        next_page_token,
        parse_ig_oembed,
        parse_innertube_comments,
        parse_syndication,
        parse_thread_renderers,
        reply_continuations,
        select_community,
        select_recent,
        _community_token,
        _header_count,
        _safe_name,
    )
    from health import build_status, piped_payload_ok

    synd = parse_syndication(json.loads((FIX / "own" / "syndication.json").read_text(encoding="utf-8")))
    check(synd["handle"] == "copperlane" and synd["stats"]["likes"] == 48280 and synd["stats"]["replies"] == 5558 and synd["replies"] == [] and "Bach" in synd["text"], "x syndication keeps the post and does not invent replies")
    moment = dt(2026, 10, 21, 12, 0, tzinfo=timezone.utc)
    comments = parse_innertube_comments(json.loads((FIX / "own" / "innertube_comments.json").read_text(encoding="utf-8")), {"statusId": "xtrFOsncOeo", "handle": "northlamp"}, moment)
    check(len(comments) == 1 and comments[0]["text"] == "This is a public comment." and comments[0]["stats"]["likes"] == 276 and comments[0]["date"] == "2026-10-20T21:00:00Z", "youtube innertube comments keep text, likes, and a real time")
    check(comments[0]["replies"][0]["text"] == "A reply under it." and comments[0]["replies"][0]["date"] == "2026-10-21T11:57:00Z", "a youtube reply stays under its parent")
    watch = extract_watch((FIX / "own" / "watch_snippet.html").read_text(encoding="utf-8"))
    check(watch["key"] == "AIzaSyTESTKEY" and watch["token"] == "Eg0S_TEST_TOKEN" and watch["version"] == "2.20251021.00.00", "the watch page yields the public innertube key and comment token")
    panel = base64.urlsafe_b64encode(b"\x12\x01engagement-panel-comments-section").decode().rstrip("=")
    section = base64.urlsafe_b64encode(b"\x12\x01comments-section").decode().rstrip("=")
    modern = (
        '<html><script>"panelIdentifier":"engagement-panel-comments-section"'
        + (" " * 8000)
        + '"continuationCommand":{"token":"' + section + '%3D"}'
        + '"continuationCommand":{"token":"' + panel + '"}</script></html>'
    )
    modern_watch = extract_watch(modern)
    check(modern_watch["token"] == panel, "a comments-panel token is used when the page omits the request field")
    classic = {
        "onResponseReceivedEndpoints": [
            {
                "reloadContinuationItemsCommand": {
                    "continuationItems": [
                        {
                            "commentThreadRenderer": {
                                "comment": {
                                    "commentRenderer": {
                                        "commentId": "Ugclassic",
                                        "contentText": {"runs": [{"text": "Classic thread text."}]},
                                        "authorText": {"simpleText": "@Cara"},
                                        "likeCount": 3,
                                        "replyCount": 2,
                                        "publishedTimeText": {"runs": [{"text": "1 hour ago"}]},
                                        "authorThumbnail": {"thumbnails": [{"url": "https://yt3.ggpht.com/a=s88"}]},
                                    }
                                },
                                "replies": {
                                    "commentRepliesRenderer": {
                                        "contents": [
                                            {
                                                "commentRenderer": {
                                                    "commentId": "Ugchild",
                                                    "contentText": {"simpleText": "Inline child."},
                                                    "authorText": {"simpleText": "Dan"},
                                                    "publishedTimeText": {"simpleText": "5 minutes ago"},
                                                }
                                            },
                                            {"continuationItemRenderer": {"continuationEndpoint": {"continuationCommand": {"token": "REPLYTOKEN"}}}},
                                        ]
                                    }
                                },
                            }
                        },
                        {"continuationItemRenderer": {"continuationEndpoint": {"continuationCommand": {"token": "PAGETOKEN", "request": "CONTINUATION_REQUEST_TYPE_WATCH_NEXT"}}}},
                    ]
                }
            }
        ]
    }
    classic_rows = parse_thread_renderers(classic, {"statusId": "videoid", "handle": "northlamp"}, moment)
    check(
        len(classic_rows) == 1
        and classic_rows[0]["text"] == "Classic thread text."
        and classic_rows[0]["handle"] == "Cara"
        and classic_rows[0]["stats"]["likes"] == 3
        and classic_rows[0]["date"] == "2026-10-21T11:00:00Z"
        and classic_rows[0]["replies"][0]["text"] == "Inline child."
        and classic_rows[0]["replies"][0]["replyingTo"]["id"] == "Ugclassic",
        "older innertube threads keep the comment and its inline reply",
    )
    check(reply_continuations(classic) == {"Ugclassic": "REPLYTOKEN"} and next_page_token(classic) == "PAGETOKEN", "reply and next-page tokens stay on the public continuation")
    siblings = parse_innertube_comments(
        {
            "frameworkUpdates": {
                "entityBatchUpdate": {
                    "mutations": [
                        {"payload": {"commentEntityPayload": {"properties": {"commentId": "a", "content": {"content": "one"}, "replyLevel": 1}, "author": {"displayName": "A"}, "toolbar": {}}}},
                        {"payload": {"commentEntityPayload": {"properties": {"commentId": "b", "content": {"content": "two"}, "replyLevel": 1}, "author": {"displayName": "B"}, "toolbar": {}}}},
                    ]
                }
            }
        },
        {"statusId": "parent"},
        as_siblings=True,
    )
    check(len(siblings) == 2 and siblings[0]["id"] == "a" and siblings[1]["id"] == "b" and "replies" not in siblings[0], "a reply page lists each reply on its own")
    from adapters.youtube_community import posts_tab

    home_params = base64.urlsafe_b64encode(b"\x12\x04home").decode().rstrip("=")
    posts_params = base64.urlsafe_b64encode(b"\x12\x05posts").decode().rstrip("=")
    tab_html = (
        '{"browseEndpoint":{"browseId":"UChomechannelidxxxxxx","params":"'
        + home_params
        + '"}}{"browseEndpoint":{"browseId":"UCpostchannelidxxxxxx","params":"'
        + posts_params
        + '"}}'
    )
    tab = posts_tab(tab_html)
    check(tab[0] == "UCpostchannelidxxxxxx" and tab[1] == posts_params, "the posts tab is the browse endpoint whose params name posts")
    oembed = parse_ig_oembed(json.loads((FIX / "own" / "ig_oembed.json").read_text(encoding="utf-8")), "DeZgzTEggQe")
    check("melon" in oembed["text"] and oembed["author"] == "birchlane" and oembed["replies"] == [] and oembed["media"][0]["url"].startswith("https://"), "instagram oembed keeps the caption and no comments")
    wrapped, wrapped_count = parse_threads_document(json.loads((FIX / "own" / "threads_wrapper.json").read_text(encoding="utf-8")), {"handle": "birchlane", "statusId": "DeZtp"})
    check(wrapped_count == 76 and len(wrapped) == 1 and wrapped[0]["text"] == "Visible reply" and wrapped[0]["stats"]["likes"] == 25 and wrapped[0]["handle"] == "ada", "threads mobile wrapper yields the visible reply")
    picked = select_recent(
        [
            {"id": "x1", "platform": "x", "date": "2026-10-20T00:00:00Z"},
            {"id": "x2", "platform": "x", "date": "2026-10-19T00:00:00Z"},
            {"id": "ig", "platform": "instagram", "date": "2026-10-12T00:00:00Z"},
            {"id": "th", "platform": "threads", "date": "2026-10-12T00:00:00Z"},
            {"id": "yt", "platform": "youtube", "date": "2026-10-20T00:00:00Z"},
            {"id": "old", "platform": "x", "date": "2026-09-01T00:00:00Z"},
            {"id": "post", "platform": "youtube", "kind": "community", "date": "2026-10-20T00:00:00Z"},
        ],
        moment,
    )
    picked_ids = [post["id"] for post in picked]
    check(picked_ids[0] == "x1" and "ig" in picked_ids and "th" in picked_ids and "yt" in picked_ids and "old" not in picked_ids and "post" not in picked_ids, "fallback files stay on recent posts and skip community comments")
    community_picked = select_community(
        [
            {"id": "oldc", "platform": "youtube", "kind": "community", "date": "2026-03-01T00:00:00Z"},
            {"id": "newc", "platform": "youtube", "kind": "community", "date": "2026-10-20T00:00:00Z"},
            {"id": "video", "platform": "youtube", "date": "2026-10-20T00:00:00Z"},
        ],
        moment,
    )
    check([post["id"] for post in community_picked] == ["newc"], "a community post from the last 14 days is fetched on its own")
    stale_posts = [
        {"id": "c%d" % index, "platform": "youtube", "kind": "community", "date": "2026-01-%02dT00:00:00Z" % (index + 1)}
        for index in range(7)
    ]
    stale_ids = [post["id"] for post in select_community(stale_posts, moment)]
    check(stale_ids == ["c6", "c5", "c4", "c3", "c2", "c1"] and "c0" not in stale_ids, "when nothing is recent, the newest community posts still in the feed are fetched")
    check(_safe_name({"platform": "youtube", "kind": "community", "id": "Ugabc"}) == "ytpost_Ugabc.json" and _safe_name({"platform": "youtube", "id": "abcdefghijk"}) == "yt_abcdefghijk.json", "community comment files use the ytpost_ prefix")
    with_request = '"continuationCommand":{"token":"4qmFabc%3D","request":"CONTINUATION_REQUEST_TYPE_BROWSE"},"apiUrl":"/youtubei/v1/browse","targetId":"comments-section"'
    without_request = '"apiUrl":"/youtubei/v1/next","continuationCommand":{"token":"4qmFxyz"},"targetId":"comments-section"'
    named = base64.urlsafe_b64encode(b"FEcomment_post_detail").decode().rstrip("=")
    check(_community_token(with_request) == ("4qmFabc=", "browse"), "a community token with the browse request field is kept")
    check(_community_token(without_request) == ("4qmFxyz", "next"), "a community token without the request field follows the page endpoint")
    check(_community_token('"continuationCommand":{"token":"' + named + '"}')[0] == named, "a comment continuation is accepted when the section id is missing")
    check(_community_token('"continuationCommand":{"token":"Egwatch","request":"CONTINUATION_REQUEST_TYPE_WATCH_NEXT"}') == ("", "browse"), "a watch-next token is not a community comment token")
    check(_header_count({"panel": {"commentsHeaderRenderer": {"commentsCount": {"runs": [{"text": "70"}]}}}}) == 70, "the community comment total comes from the header")
    check(_header_count({"commentsHeaderRenderer": {"countText": {"runs": [{"text": "1,204"}, {"text": " Comments"}]}}}) == 1204, "a comma count on the header is kept")
    status_doc = build_status(
        [
            {"id": "fxtwitter", "group": "X", "up": False, "detail": "down", "down": "fxtwitter"},
            {"id": "invidious.f5.si", "group": "YouTube", "up": True, "detail": "invidious API", "down": "https://invidious.f5.si"},
            {"id": "pipedapi.kavin.rocks", "group": "YouTube", "up": False, "detail": "down", "down": "https://pipedapi.kavin.rocks"},
        ],
        "2026-10-21T12:00:00Z",
    )
    check(status_doc["down"] == ["fxtwitter", "https://pipedapi.kavin.rocks"] and status_doc["sources"][1]["up"] is True, "status.json lists dead browser hosts and leaves live ones in rotation")
    check(piped_payload_ok(200, '[{"url":"/watch?v=abc"}]') and piped_payload_ok(200, '{"name":"Linus"}') and not piped_payload_ok(200, "<html>") and not piped_payload_ok(404, '{"name":"x"}'), "a piped host that returns a json list stays in rotation")

    def png_size(path: Path):
        data = path.read_bytes()
        check(data.startswith(b"\x89PNG\r\n\x1a\n"), path.name + " is a png")
        return struct.unpack(">II", data[16:24])

    check(png_size(ROOT / "icons" / "icon-192.png") == (192, 192), "the 192 icon is 192 pixels")
    check(png_size(ROOT / "icons" / "icon-512.png") == (512, 512), "the 512 icon is 512 pixels")
    check(png_size(ROOT / "icons" / "icon-maskable-512.png") == (512, 512), "the maskable icon is 512 pixels")
    check(png_size(ROOT / "icons" / "icon-monochrome-512.png") == (512, 512), "the monochrome icon is 512 pixels")
    check(png_size(ROOT / "icons" / "apple-touch-icon.png") == (180, 180), "the apple touch icon is 180 pixels")
    check(png_size(ROOT / "screenshots" / "narrow.png") == (1080, 1920), "the narrow screenshot is a phone frame")
    check(png_size(ROOT / "screenshots" / "wide.png") == (1920, 1080), "the wide screenshot is a desktop frame")
    check((ROOT / "scripts" / "pwa_assets.py").read_text(encoding="utf-8").find("M18.244") < 0, "the install mark is not the X logo")
    check("M18.244" not in (ROOT / "app.js").read_text(encoding="utf-8") and "M18.244" not in (ROOT / "favicon.svg").read_text(encoding="utf-8") and 'icon("logo")' not in (ROOT / "app.js").read_text(encoding="utf-8"), "the X logo is not in the app chrome or the favicon")
    favicon = (ROOT / "favicon.svg").read_text(encoding="utf-8")
    check("ViktorychApp" in favicon and 'fill="#fff"' in favicon and 'fill="#000"' in favicon and "M12 2.2l1.7 5.4" not in favicon and "function sourceBadge(" in (ROOT / "app.js").read_text(encoding="utf-8"), "the favicon is a black V on white, and posts keep their source badges")
    ico = (ROOT / "favicon.ico").read_bytes()
    ico_count = struct.unpack_from("<H", ico, 4)[0]
    check(ico[:4] == b"\x00\x00\x01\x00" and ico_count == 4, "favicon.ico carries the 16, 32, 48, and 256 tiles")

    from adapters.common import html_to_parts, is_playable_video
    from video_media import _one, extract_video, probe

    stand = html_to_parts('<video poster=""><source src="https://www.instagram.com/p/AbCdEf/media?size=l"></video>')
    check(stand["media"][0]["type"] == "video" and stand["media"][0]["url"] == "" and "media?size=l" in stand["media"][0]["poster"] and not is_playable_video(stand["media"][0]["poster"]), "an instagram image redirect is not stored as the video file")
    real = html_to_parts('<video poster="https://cdn.example/p.jpg"><source src="https://cdn.example/clip.mp4"></video>')
    check(real["media"][0]["url"] == "https://cdn.example/clip.mp4" and real["media"][0]["poster"].endswith("p.jpg"), "a real mp4 stays the video url")
    found = extract_video('{"video_url":"https://cdn.example/clip.mp4","display_url":"https://cdn.example/p.jpg","video_duration":"12"}')
    check(found["url"].endswith("clip.mp4") and found["poster"].endswith("p.jpg") and found["duration"] == 12, "extract_video reads the file, poster, and duration")
    blocked, why = probe("https://www.instagram.com/p/AbCdEf/media?size=l")
    check(blocked is False and why == "not a video file", "a range probe rejects an image stand-in")
    yt_item = {"type": "video", "url": "https://www.youtube-nocookie.com/embed/abcdefghijk", "stream": "https://invidious.example/latest_version?id=abcdefghijk&itag=18"}
    yt_ok, yt_row = _one({"platform": "youtube", "id": "abcdefghijk"}, yt_item)
    check(yt_ok and yt_row is None and "stream" not in yt_item, "youtube playback is resolved in the player, not one baked stream")
    ig_item = {"type": "video", "url": "https://www.instagram.com/p/AbCdEf/media?size=l"}
    ig_ok, ig_row = _one({"platform": "rss", "id": "ig-stand-in"}, ig_item)
    check(ig_ok is False and ig_item["url"] == "" and "media?size=l" in ig_item["poster"] and ig_row["detail"] == "image stand-in", "a stand-in url is cleared and reported")
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    check("Watch on Instagram" in app and "function youtubeSources" in app and "function startPlayback" in app and 'toast("Video unavailable")' not in app and "hls.min.js" in app, "the player rotates sources and does not toast video unavailable")
    check('src="video-embed.js"' in (ROOT / "index.html").read_text(encoding="utf-8") and "./video-embed.js" in (ROOT / "sw.js").read_text(encoding="utf-8") and "function playbackSource(" in (ROOT / "video-embed.js").read_text(encoding="utf-8") and "/v1/yt/manifest" not in app, "the official embed helper is in the shell and the page does not relay YouTube through the worker")
    embed_js = (ROOT / "video-embed.js").read_text(encoding="utf-8")
    worker_js = (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8")
    check("function runXPlayback(" in embed_js and "function xEmbedUrl(" in embed_js and "function startXPlayback(" in app and "dev.playbackUrl" in app and "armPeer(el, null, source.url)" in app and "function publicMediaPolicy(" in worker_js and "cacheEverything: false" in worker_js, "X video tries the original file, then the official embed, and a relayed file skips the CDN cache")
    embed_flow = subprocess.run(["node", str(ROOT / "scripts" / "video_embed_test.js")], cwd=ROOT)
    check(embed_flow.returncode == 0, "official embed urls, fallbacks, and combined-file selection pass")
    providers_flow = subprocess.run(["node", str(ROOT / "scripts" / "video_providers_test.js")], cwd=ROOT)
    check(providers_flow.returncode == 0, "link card video providers match golden urls and only frame official players")
    check("latest_version" not in (ROOT / "scripts" / "yt_remote.py").read_text(encoding="utf-8"), "sync does not bake an invidious itag url")
    from adapters.common import dates_moved_later, lock_publish_time, publish_date_from_html, relative_label
    from adapters.youtube_rss import backfill_youtube_dates

    check(relative_label("0 seconds ago") and relative_label("1 day ago") and relative_label("Streamed 1 week ago") and relative_label("Premiered 3 hours ago") and relative_label("2d ago") and relative_label("10 min ago") and relative_label("1 hr ago") and relative_label("2 hrs ago") and relative_label("5 mins ago") and not relative_label("2026-10-11T00:00:00Z") and not relative_label("Oct 3, 2026"), "relative publish labels are recognized")
    restamped = {"id": "yt:video:Iuvm-HKIMg8", "platform": "youtube", "kind": "post", "date": "2026-10-21T13:35:36Z", "url": "https://www.youtube.com/watch?v=Iuvm-HKIMg8"}
    lock_publish_time({"id": "Iuvm-HKIMg8", "date": "2026-10-11T00:00:00Z"}, restamped)
    check(restamped["id"] == "Iuvm-HKIMg8" and restamped["statusId"] == "Iuvm-HKIMg8" and restamped["date"] == "2026-10-11T00:00:00Z", "a later sync cannot move a video's publish time forward")
    community_row = {"id": "UgkxwgD1SpZbB0jjdvLVVQ1kDUAUojU3kyah", "platform": "youtube", "kind": "community", "date": "2026-03-15T17:37:27-07:00"}
    lock_publish_time({"id": community_row["id"], "date": "2026-03-21T00:41:24Z"}, community_row)
    kept = datetime.fromisoformat(community_row["date"])
    if kept.tzinfo is None:
        kept = kept.replace(tzinfo=timezone.utc)
    check(kept < datetime.fromisoformat("2026-03-16T01:00:00+00:00"), "the earlier community publish time replaces a drifted sync stamp")
    kept_x = {"id": "123", "platform": "x", "kind": "post", "date": ""}
    lock_publish_time({"id": "123", "date": "2026-01-02T00:00:00Z"}, kept_x)
    check(kept_x["date"] == "2026-01-02T00:00:00Z" and kept_x["id"] == "123", "an empty new date keeps the stored time")
    exact = publish_date_from_html('{"publishDate":"2026-03-15T17:37:27.463301-07:00"}')
    day = publish_date_from_html('{"publishDate":{"simpleText":"Oct 11, 2026"}}')
    uploaded = publish_date_from_html('{"uploadDate":"2026-10-11T21:31:32+00:00","datePublished":"2026-10-11T21:31:32+00:00"}')
    grocery_day = publish_date_from_html('{"views":{"simpleText":"190,347 views"},"publishDate":{"simpleText":"Oct 3, 2026"},"comment":{"dateCreated":"2026-10-03T17:28:30-07:00"}}')
    check(exact == "2026-03-16T00:37:27.000Z" and day == "2026-10-11T00:00:00.000Z" and uploaded == "2026-10-11T21:31:32.000Z" and grocery_day == "2026-10-03T00:00:00.000Z", "watch and community pages yield the real publish date")
    drifted = """<?xml version="1.0"?>
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
    <title>North Lamp</title><yt:channelId>UCsyntheticmaple00001000</yt:channelId>
    <entry><id>yt:video:Iuvm-HKIMg8</id><yt:videoId>Iuvm-HKIMg8</yt:videoId>
    <title>AI Expert Just Ruined My Day With This WARNING</title>
    <published>2026-10-11T21:31:32+00:00</published><updated>2026-10-21T20:24:18+00:00</updated>
    <link rel="alternate" href="https://www.youtube.com/watch?v=Iuvm-HKIMg8"/></entry>
    <entry><id>yt:video:Sl0xhb6STQ0</id><yt:videoId>Sl0xhb6STQ0</yt:videoId>
    <title>Russia's Plan to Win WW3</title>
    <updated>2026-10-21T20:24:18+00:00</updated>
    <link rel="alternate" href="https://www.youtube.com/watch?v=Sl0xhb6STQ0"/></entry></feed>"""
    drifted_posts = parse_youtube(drifted, {"id": "youtube:northlamp", "platform": "youtube", "handle": "northlamp"})["posts"]
    by_video = {post["id"]: post for post in drifted_posts}
    check(by_video["Iuvm-HKIMg8"]["date"].startswith("2026-10-11T21:31:32") and "20:24:18" not in by_video["Iuvm-HKIMg8"]["date"], "youtube uses the RSS published time, not the later updated time")
    check(by_video["Sl0xhb6STQ0"]["date"] == "", "a missing published field does not fall back to updated or now")
    filled = backfill_youtube_dates(drifted_posts, fetch=lambda video_id: '{"uploadDate":"2026-10-10T21:36:22+00:00"}' if video_id == "Sl0xhb6STQ0" else "")
    check(filled == 1 and by_video["Sl0xhb6STQ0"]["date"] == "2026-10-10T21:36:22.000Z", "a missing youtube date comes from the watch page uploadDate")
    first_seen_at = datetime(2026, 10, 21, 20, 24, 18, tzinfo=timezone.utc)
    later_sync = datetime(2026, 10, 21, 21, 0, 0, tzinfo=timezone.utc)
    first_pass = [
        {"id": "Iuvm-HKIMg8", "platform": "youtube", "kind": "post", "date": "2026-10-11T21:31:32+00:00"},
        {"id": "Sl0xhb6STQ0", "platform": "youtube", "kind": "post", "date": "2026-10-10T21:36:22+00:00"},
        {"id": "nodate", "platform": "x", "kind": "post", "date": ""},
        {"id": "kept-empty", "platform": "rss", "kind": "post", "date": ""},
    ]
    locked_first = []
    for row in first_pass:
        item = dict(row)
        previous = {"id": "kept-empty", "platform": "rss", "date": ""} if row["id"] == "kept-empty" else None
        lock_publish_time(previous, item, now=first_seen_at)
        locked_first.append(item)
    second_pass = []
    for row in locked_first:
        item = dict(row)
        if row["id"] in ("Iuvm-HKIMg8", "Sl0xhb6STQ0"):
            item["date"] = "2026-10-21T21:00:00Z"
        elif row["id"] == "nodate":
            item["date"] = ""
            item.pop("seenAt", None)
        lock_publish_time(row, item, now=later_sync)
        second_pass.append(item)
    check(not dates_moved_later(locked_first, second_pass), "no item date moves later between syncs")
    by_second = {post["id"]: post for post in second_pass}
    check(by_second["Iuvm-HKIMg8"]["date"].startswith("2026-10-11") and by_second["Sl0xhb6STQ0"]["date"].startswith("2026-10-10"), "stored youtube dates stay on the original upload")
    check(by_second["nodate"]["date"] == locked_first[2]["date"] == "" and "seenAt" not in by_second["nodate"] and "20:24:18" not in by_second["nodate"]["date"], "a post with no real date is not stamped with the time it was fetched")
    check(by_second["kept-empty"]["date"] == "", "a post already stored without a date is not restamped on a later sync")
    invented = {"id": "7t8Llz1hszQ", "platform": "youtube", "kind": "post", "date": "2026-10-22T07:26:00Z", "seenAt": "2026-10-22T07:26:00Z"}
    lock_publish_time({"id": "7t8Llz1hszQ", "date": "2026-10-22T07:26:00Z", "seenAt": "2026-10-22T07:26:00Z"}, invented, now=later_sync)
    check(invented["date"] == "", "a date that is only the first fetch time is dropped")
    merge_src = app.split("function mergeLiveYoutube", 1)[1].split("function liveYoutube", 1)[0]
    check("function calendarDate(" in app and "function livePublishDate(" in app and "LIVE_STAMP_MS" in app and "rememberSeen(" not in merge_src and '["published", "pubdate"]' in app, "live youtube dates come from a real publish time, not a fresh clock time")
    check("function canonicalPostId(" in app and "function relativeLabel(" in app and "seenPostIds" in app and "seen-ids" in worker and "def lock_publish_time(" in (ROOT / "scripts" / "adapters" / "common.py").read_text(encoding="utf-8") and "def dates_moved_later(" in (ROOT / "scripts" / "adapters" / "common.py").read_text(encoding="utf-8"), "publish times stay on the original post and new posts are unseen ids")

    import subprocess

    live_dates = subprocess.run(["node", "scripts/live_date_test.js"], cwd=ROOT, capture_output=True, text=True)
    check(live_dates.returncode == 0, "live youtube publish times stay on the original upload\n" + live_dates.stdout + live_dates.stderr)

    import people

    people_src = (ROOT / "scripts" / "people.py").read_text(encoding="utf-8")
    check("api.x.com" not in people_src and "api.twitter.com" not in people_src and "api.fxtwitter.com" in people_src, "people sync uses fxtwitter and never the X API")
    check((ROOT / ".github" / "ISSUE_TEMPLATE" / "link-accounts.yml").is_file(), "the link-accounts issue form exists")
    site_config = json.loads((ROOT / "feeds.config.json").read_text(encoding="utf-8"))
    people.validate_config(site_config)
    x_account = next((feed for feed in site_config.get("feeds") or [] if feed.get("id") == "x:X"), None)
    check(x_account is not None and x_account.get("defaultFollow") is False and x_account.get("adapter") == "fxtwitter", "the X account is synced as a feed and is not a default follow")
    check(not any(isinstance(item, dict) and item.get("id") == "x:X" for item in site_config.get("discord") or []), "the X account is not stored as a Discord server")
    from pull_snapshot import merge_seed_articles
    published_articles = {"posts": [{"id": "1", "article": {"title": "T", "preview": "p"}}], "feeds": []}
    seed_articles = {"posts": [
        {"id": "1", "feedId": "x:X", "article": {"title": "T", "blocks": [{"type": "paragraph", "text": "body"}]}},
        {"id": "2", "feedId": "x:X", "article": {"title": "New", "blocks": [{"type": "paragraph", "text": "full"}]}},
    ], "feeds": [{"id": "x:X", "handle": "X", "configured": False}]}
    added_articles = merge_seed_articles(published_articles, seed_articles)
    check(added_articles == 1 and published_articles["posts"][0]["article"]["blocks"][0]["text"] == "body" and published_articles["posts"][1]["id"] == "2" and published_articles["feeds"][0]["configured"] is False, "a seed article survives the published snapshot and keeps its body")
    prepper = next(person for person in site_config["people"] if person["id"] == "canadian-prepper")
    prepper_accounts = {(account["platform"], account["handle"]) for account in prepper["accounts"]}
    check(("youtube", "northlamp") in prepper_accounts and ("x", "cedarhill") in prepper_accounts and ("instagram", "orbitfox") in prepper_accounts, "North Lamp links the verified YouTube, X, and Instagram accounts")
    check(any(account.get("channelId") == "UCsyntheticmaple00001000" for account in prepper["accounts"]), "the YouTube account keeps the channel id")
    x_source = next(account["source"] for account in prepper["accounts"] if account["platform"] == "x")
    ig_source = next(account["source"] for account in prepper["accounts"] if account["platform"] == "instagram")
    check("canadianpreparedness.com" in x_source and "twitter.com/cedarhill" in x_source, "the X handle is sourced from the website")
    check("youtube.com/@northlamp/about" in ig_source and "canadianpreparedness.com" in ig_source, "Instagram is sourced from the About page and the website")
    check(not any(account["platform"] in ("threads", "telegram") for account in prepper["accounts"]), "Threads and Telegram are omitted when no source lists them")
    bad_id = empty_accounts = duplicate_account = False
    try:
        people.validate_person({"id": "Bad", "name": "Nope", "accounts": [{"platform": "x", "handle": "sampleagency"}]})
    except people.SchemaError:
        bad_id = True
    try:
        people.validate_person({"id": "ok-person", "name": "Ok", "accounts": []})
    except people.SchemaError:
        empty_accounts = True
    try:
        people.validate_config({"people": [
            {"id": "one", "name": "One", "accounts": [{"platform": "x", "handle": "sampleagency"}]},
            {"id": "two", "name": "Two", "accounts": [{"platform": "x", "handle": "SampleAgency"}]},
        ]})
    except people.SchemaError:
        duplicate_account = True
    check(bad_id and empty_accounts and duplicate_account, "people schema rejects a bad id, an empty account list, and a shared account")
    extra = people.extra_feeds(site_config)
    extra_ids = {row["id"] for row in extra}
    check("x:cedarhill" in extra_ids and "instagram:orbitfox" in extra_ids and "youtube:northlamp" not in extra_ids, "sync follows linked accounts that are not already feeds")
    linked_telegram = people.extra_feeds({"feeds": [], "people": [{"id": "t", "name": "T", "accounts": [{"platform": "telegram", "handle": "prepperchannel"}]}]})
    check(len(linked_telegram) == 1 and linked_telegram[0]["id"] == "telegram:prepperchannel" and linked_telegram[0]["adapter"] == "telegram" and linked_telegram[0]["source_urls"] == ["https://t.me/s/{handle}"], "a linked Telegram channel is followed once the adapter exists")

    cross_posts = [
        {"platform": "youtube", "handle": "northlamp", "id": "abcdefghijk", "url": "https://www.youtube.com/watch?v=abcdefghijk", "feedId": "youtube:northlamp"},
        {"platform": "x", "handle": "cedarhill", "id": "1", "text": "new video", "links": [{"expanded": "https://youtu.be/abcdefghijk"}]},
        {"platform": "x", "handle": "cedarhill", "id": "2", "text": "also the shop", "links": [{"expanded": "https://youtu.be/abcdefghijk"}, {"expanded": "https://canadianpreparedness.com/shop"}]},
        {"platform": "x", "handle": "someoneelse", "id": "3", "text": "share", "links": [{"expanded": "https://youtu.be/abcdefghijk"}]},
    ]
    cross_config = {"people": [prepper]}
    stamped = people.stamp_cross_posts(cross_posts, cross_config, fetch=False)
    check(stamped == 1 and cross_posts[1]["alsoOn"] == {"person": "canadian-prepper", "platform": "youtube", "handle": "northlamp", "videoId": "abcdefghijk", "url": "https://youtu.be/abcdefghijk"}, "an X post that only links the person's own video gets alsoOn")
    check("alsoOn" not in cross_posts[2] and "alsoOn" not in cross_posts[3], "a second link or a different author does not count as a cross-post")
    unknown = [{"platform": "x", "handle": "cedarhill", "id": "4", "text": "live", "links": [{"expanded": "https://www.youtube.com/watch?v=zzzzzzzzzzz"}]}]
    stamped_live = people.stamp_cross_posts(unknown, cross_config, fetch=True, oembed=lambda url: {"author_url": "https://www.youtube.com/@northlamp"})
    check(stamped_live == 1 and unknown[0]["alsoOn"]["videoId"] == "zzzzzzzzzzz", "oembed author_url can confirm the person's channel")
    foreign = [{"platform": "x", "handle": "cedarhill", "id": "5", "text": "nope", "links": [{"expanded": "https://www.youtube.com/watch?v=yyyyyyyyyyy"}]}]
    stamped_foreign = people.stamp_cross_posts(foreign, cross_config, fetch=True, oembed=lambda url: {"author_url": "https://www.youtube.com/@SomeoneElse"})
    check(stamped_foreign == 0 and "alsoOn" not in foreign[0], "a different YouTube author is not alsoOn")

    suggest_profiles = [
        {"platform": "x", "handle": "lefty", "name": "Left", "bio": "see https://www.youtube.com/@righty", "avatar": "https://example.com/a.jpg"},
        {"platform": "youtube", "handle": "righty", "name": "Right", "bio": "https://x.com/lefty", "avatar": "https://example.com/b.jpg"},
        {"platform": "instagram", "handle": "oneway", "name": "One", "bio": "https://x.com/lefty", "avatar": "https://example.com/c.jpg"},
        {"platform": "threads", "handle": "samename", "name": "Same Person", "avatar": "https://cdn.example/face.jpg?s=1"},
        {"platform": "vk", "handle": "samename", "name": "Same Person", "avatar": "https://cdn.example/face.jpg"},
        {"platform": "x", "handle": "nameonly", "name": "Same Person", "avatar": "https://cdn.example/other.jpg"},
    ]

    def suggestion_pair(rows, left, right):
        for row in rows:
            handles = {(account["platform"], account["handle"]) for account in row["accounts"]}
            if left in handles and right in handles:
                return row
        return None

    suggestions = people.suggest(suggest_profiles, [])
    mutual = suggestion_pair(suggestions, ("x", "lefty"), ("youtube", "righty"))
    same_face = suggestion_pair(suggestions, ("threads", "samename"), ("vk", "samename"))
    check(mutual and "bio links point at each other" in mutual["reasons"], "bios that point at each other are suggested")
    check(suggestion_pair(suggestions, ("instagram", "oneway"), ("x", "lefty")) is None, "a one-way bio link is not a suggestion")
    check(same_face and "same name and avatar" in same_face["reasons"], "the same name and avatar on two platforms is a suggestion")
    check(suggestion_pair(suggestions, ("x", "nameonly"), ("vk", "samename")) is None, "the same name with a different avatar is not a suggestion")
    linked_people = [{"id": "p", "name": "P", "accounts": [{"platform": "x", "handle": "lefty"}]}]
    linked_before = json.dumps(linked_people)
    linked_suggestions = people.suggest(suggest_profiles, linked_people)
    check(suggestion_pair(linked_suggestions, ("x", "lefty"), ("youtube", "righty")) is None and json.dumps(linked_people) == linked_before, "suggestions never merge or rewrite people")
    import subprocess as links_proc
    links_run = links_proc.run(["node", str(ROOT / "scripts" / "people_links_test.js")], capture_output=True, text=True)
    check(links_run.returncode == 0, "per-reader merge overrides: platform toggles, merge with Undo, unmerge: " + (links_run.stderr or "")[-300:])

    auto_profiles = [
        {"id": "instagram:quillfern", "platform": "instagram", "handle": "quillfern", "name": "Quill Fern"},
        {"id": "threads:quillfern", "platform": "threads", "handle": "quillfern", "name": "Quill"},
        {"id": "x:lefty", "platform": "x", "handle": "lefty", "name": "Left Side", "bio": "videos https://www.youtube.com/@righty"},
        {"id": "youtube:righty", "platform": "youtube", "handle": "righty", "name": "Left Side"},
        {"id": "vk:lonely", "platform": "vk", "handle": "lonely", "name": "Lonely", "bio": "https://x.com/someoneelse"},
        {"id": "x:someoneelse", "platform": "x", "handle": "someoneelse", "name": "Other Name"},
        {"id": "telegram:northlamp", "platform": "telegram", "handle": "northlamp", "name": "North Lamp", "bio": "https://www.youtube.com/@northlamp"},
    ]
    owner_people = [{"id": "canadian-prepper", "name": "North Lamp", "accounts": [{"platform": "youtube", "handle": "northlamp"}]}]
    auto_profiles.append({"id": "youtube:northlamp", "platform": "youtube", "handle": "northlamp", "name": "North Lamp"})
    merged, weak_rows, merge_counts = people.auto_people(auto_profiles, owner_people)
    auto_ids = [person for person in merged if person.get("auto")]
    pair_sets = [{(a["platform"], a["handle"]) for a in person["accounts"]} for person in auto_ids]
    check({("instagram", "quillfern"), ("threads", "quillfern")} in pair_sets, "a Threads account merges with the Instagram account of the same handle")
    check({("x", "lefty"), ("youtube", "righty")} in pair_sets, "a bio link plus the same name merges on its own")
    check(not any(("vk", "lonely") in s for s in pair_sets) and any({a["handle"] for a in row["accounts"]} == {"lonely", "someoneelse"} for row in weak_rows), "a one-way link without a matching name is only suggested")
    owner_row = next(person for person in merged if person["id"] == "canadian-prepper")
    check(any(a["platform"] == "telegram" and a.get("auto") for a in owner_row["accounts"]) and owner_people[0]["accounts"] == [{"platform": "youtube", "handle": "northlamp"}], "a new source that links a hand-linked person joins that person and the owner config stays as is")
    split_people, _w, _c = people.auto_people(auto_profiles, [], {"threads:quillfern"})
    check(not any({a["handle"] for a in p["accounts"]} == {"quillfern"} for p in split_people), "an account the owner split out never merges again")
    cross_people = [{"id": "q", "name": "Q", "accounts": [{"platform": "instagram", "handle": "quillfern", "feedId": "instagram:quillfern"}, {"platform": "threads", "handle": "quillfern", "feedId": "threads:quillfern"}, {"platform": "x", "handle": "quillx", "feedId": "x:quillx"}]}]
    cross_rows = [
        {"id": "i1", "platform": "instagram", "handle": "quillfern", "feedId": "instagram:quillfern", "date": "2026-10-20T10:00:00Z", "text": "New mural finished today, come see it downtown!", "media": [{"type": "photo", "url": "https://cdn.example/a.jpg", "width": 1080, "height": 1350}]},
        {"id": "t1", "platform": "threads", "handle": "quillfern", "feedId": "threads:quillfern", "date": "2026-10-20T10:03:00Z", "text": "New mural finished today, come see it downtown! #art", "media": [{"type": "photo", "url": "https://cdn.example/b.jpg", "width": 640, "height": 800}]},
        {"id": "x1", "platform": "x", "handle": "quillx", "feedId": "x:quillx", "date": "2026-10-20T11:00:00Z", "text": "New mural finished today, come see it downtown!"},
        {"id": "y1", "platform": "youtube", "handle": "other", "statusId": "abcdefghijk", "date": "2026-10-20T09:00:00Z", "text": "a video"},
    ]
    folded, fold_stats = people.dedupe_cross_posts([dict(row) for row in cross_rows], cross_people)
    first = next(row for row in folded if row["id"] == "i1")
    check(fold_stats["dropped"] == 1 and [ref["platform"] for ref in first.get("crossPosts", [])] == ["threads"] and any(row["id"] == "x1" for row in folded), "the same post on two platforms within ten minutes shows once with the larger media, and a copy an hour later stays")
    video_people = [{"id": "v", "name": "V", "accounts": [{"platform": "x", "handle": "vx", "feedId": "x:vx"}, {"platform": "youtube", "handle": "vy", "feedId": "youtube:vy"}]}]
    video_rows = [
        {"id": "xv", "platform": "x", "handle": "vx", "feedId": "x:vx", "date": "2026-10-20T10:00:00Z", "text": "new video", "links": [{"url": "https://youtu.be/abcdefghijk"}]},
        {"id": "yv", "platform": "youtube", "handle": "vy", "feedId": "youtube:vy", "statusId": "abcdefghijk", "date": "2026-10-20T10:05:00Z", "text": "My video"},
    ]
    vfold, _vs = people.dedupe_cross_posts(video_rows, video_people)
    check(len(vfold) == 1 and vfold[0]["platform"] == "youtube" and vfold[0]["crossPosts"][0]["platform"] == "x", "an X post sharing the person's own YouTube video folds into the video")
    now_ts = 1_000_000.0
    mirrors = people.update_mirrors({}, {"threads:quillfern": 1.0}, {"threads:quillfern"}, now_ts)
    check(not people.mirror_due(mirrors, "threads:quillfern", now_ts + 60) and people.mirror_due(mirrors, "threads:quillfern", now_ts + 3 * 3600) and people.mirror_due(mirrors, "x:new", now_ts), "a mirror source is read every three hours and others every run")

    link_body = "### Person\n\nNorth Lamp\n\n### Accounts\n\nx:sampleagency\n"
    link_config = {"feeds": [{"id": "x:keep"}], "people": json.loads(json.dumps(site_config["people"]))}
    linked_msg, linked_config = follow_req.run("riverquoll", "riverquoll", "Link accounts: North Lamp", link_body, link_config, fake_follow_fetch, public_resolve)
    linked_person = next(person for person in linked_config["people"] if person["id"] == "canadian-prepper")
    check(linked_msg.startswith("Linked x:sampleagency") and any(account["platform"] == "x" and account["handle"] == "sampleagency" for account in linked_person["accounts"]) and linked_config["feeds"] == [{"id": "x:keep"}], "the owner can link a confirmed account without adding a feed")
    stranger_link, stranger_people = follow_req.run("someone", "riverquoll", "Link accounts: North Lamp", link_body, {"feeds": [{"id": "x:keep"}], "people": []}, fake_follow_fetch, public_resolve)
    check(stranger_link == "" and stranger_people == {"feeds": [{"id": "x:keep"}], "people": []}, "a link issue from anyone else is ignored")
    owned_config = {"people": [
        {"id": "canadian-prepper", "name": "North Lamp", "accounts": [{"platform": "youtube", "handle": "northlamp"}]},
        {"id": "other", "name": "Other", "accounts": [{"platform": "x", "handle": "sampleagency"}]},
    ]}
    owned_rejected = False
    try:
        follow_req.run("riverquoll", "riverquoll", "Link accounts: North Lamp", link_body, owned_config, fake_follow_fetch, public_resolve)
    except follow_req.Reject:
        owned_rejected = True
    check(owned_rejected, "an account already linked to another person is rejected")

    def telegram_fetch(url):
        if "t.me/" in url:
            return 200, '<div class="tgme_page_title">Prepper</div>'
        return fake_follow_fetch(url)

    telegram_body = "### Person\n\nNorth Lamp\n\n### Accounts\n\ntelegram:prepperchannel\n"
    telegram_config = {"people": [{"id": "canadian-prepper", "name": "North Lamp", "accounts": [{"platform": "youtube", "handle": "northlamp"}]}]}
    telegram_msg, telegram_updated = follow_req.run("riverquoll", "riverquoll", "Link accounts: North Lamp", telegram_body, telegram_config, telegram_fetch, public_resolve)
    check("telegram:prepperchannel" in telegram_msg and any(account["platform"] == "telegram" and account["handle"] == "prepperchannel" for account in telegram_updated["people"][0]["accounts"]), "a confirmed Telegram page can be linked")

    node_check = subprocess.run(
        ["node", "--input-type=module", "-e", r"""
import fs from "fs";
import vm from "vm";
const context = { console, Intl };
vm.createContext(context);
vm.runInContext(fs.readFileSync("translate.js", "utf8"), context);
const FT = context.FeedsTranslate;
const sample = "see https://vk.com/vk and @vk #вконтакте $BTC";
const shielded = FT._shield(sample);
if (!shielded.text.includes("[[0]]") || shielded.text.includes("https://")) throw new Error("shield " + shielded.text);
if (FT._restore(shielded.text, shielded.kept) !== sample) throw new Error("restore");
const ru = "Новая запись в блоге про ленту и рекомендации.";
const en = "This is a normal English sentence for the feed and you.";
if (FT._offerText(en, "en") !== false) throw new Error("english");
if (FT._offerText(ru, "en") !== true) throw new Error("russian");
if (FT._offerText(ru, "ru") !== false) throw new Error("same");
if (FT._guess(ru) !== "ru") throw new Error("guess");
if (FT.normalize("EN-us") !== "en" || FT.normalize("nope") !== "en") throw new Error("normalize");
const bind = (lang) => FT.bind({ state: { settings: { translateTo: "en" }, lang: lang, translated: {}, originalShown: {}, translateFallback: {} } });
bind({ k: "no" });
if (FT.offer("k", ru) !== true) throw new Error("lang no hid cyrillic");
bind({ k: "en" });
if (FT.offer("k", ru) !== true) throw new Error("detector en hid cyrillic");
FT.bind({ state: { settings: { translateTo: "ru" }, lang: { k: "en" }, translated: {}, originalShown: {}, translateFallback: {} } });
if (FT.offer("k", ru) !== false) throw new Error("russian target");
bind({});
if (FT.offer("k", en) !== false) throw new Error("english offer");
"""],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    check(node_check.returncode == 0, "translate.js shields tokens and skips text already in the target language: " + (node_check.stderr or node_check.stdout))
    people_check = subprocess.run(
        ["node", "--input-type=module", "-e", r"""
import fs from "fs";
import vm from "vm";
const context = { console };
vm.createContext(context);
vm.runInContext(fs.readFileSync("people.js", "utf8"), context);
const P = context.FeedsPeople;
P.use(JSON.parse(fs.readFileSync("people.json", "utf8")));
const hash = "#/p/canadian-prepper";
if (P.hashFor("x", "cedarhill") !== hash) throw new Error("x");
if (P.hashFor("youtube", "northlamp") !== hash) throw new Error("yt");
if (P.hashFor("youtube", "UCsyntheticmaple00001000") !== hash) throw new Error("channel");
if (P.hashFor("instagram", "orbitfox") !== hash) throw new Error("ig");
if (P.hashFor("x", "sampleagency") !== "") throw new Error("other");
const posts = [
  { id: "1", platform: "x", handle: "cedarhill", kind: "post", date: "2026-10-20T00:00:00Z", media: [{ type: "video", url: "https://example.test/a.mp4" }] },
  { id: "2", platform: "youtube", handle: "northlamp", kind: "post", date: "2026-10-21T00:00:00Z", url: "https://www.youtube.com/shorts/abc" },
  { id: "3", platform: "youtube", handle: "northlamp", kind: "community", date: "2026-10-19T00:00:00Z" },
  { id: "4", platform: "x", handle: "cedarhill", kind: "reply", date: "2026-10-18T00:00:00Z" },
  { id: "5", platform: "x", handle: "someoneelse", kind: "post", date: "2026-10-22T00:00:00Z" },
  { id: "6", platform: "instagram", handle: "orbitfox", kind: "post", date: "2026-10-17T00:00:00Z", media: [{ type: "photo", url: "https://example.test/p.jpg" }] },
  { id: "7", platform: "x", handle: "nightheron", feedId: "x:cedarhill", kind: "repost", date: "2026-10-23T00:00:00Z", media: [{ type: "video", url: "https://example.test/r.mp4" }], author: "DD Geopolitics", repostedBy: { handle: "cedarhill", name: "North Lamp" } }
];
const person = P.byId("canadian-prepper");
const rows = P.postsFor(person, posts);
if (rows.map((post) => post.id).join(",") !== "7,2,1,3,4,6") throw new Error("order " + rows.map((post) => post.id).join(","));
const tabs = P.tabsFor(person, rows).map((pair) => pair[0]);
["posts", "videos", "shorts", "community", "replies", "media"].forEach((name) => {
  if (tabs.indexOf(name) < 0) throw new Error("missing " + name);
});
if (P.filterTab(rows, "videos").some((post) => post.id === "2")) throw new Error("short listed as a video");
if (P.filterTab(rows, "videos").some((post) => post.id === "7")) throw new Error("repost listed as a video");
if (!P.filterTab(rows, "posts").some((post) => post.id === "7")) throw new Error("repost missing from posts");
if (!P.filterTab(rows, "videos").some((post) => post.id === "1")) throw new Error("x video missing");
if (!P.filterTab(rows, "shorts").some((post) => post.id === "2")) throw new Error("short missing");
if (P.filterTab(rows, "posts").some((post) => post.id === "4")) throw new Error("reply in posts");
P.bind({
  posts: () => posts,
  formatCount: (n) => String(n),
  card: (post, mode) => "CARD" + post.id + ":" + (mode || "show"),
  esc: (value) => String(value == null ? "" : value),
  icon: () => "",
  avatar: () => "",
  emptyBlock: () => ""
});
const profileHtml = P.page({ name: "person", id: "canadian-prepper", query: { get: () => "" } });
if (!profileHtml || profileHtml.indexOf("4 posts") < 0) throw new Error("count " + (profileHtml || "").slice(0, 400));
if (profileHtml.indexOf("CARD7:show") < 0) throw new Error("repost line hidden");
if (profileHtml.indexOf("CARD1:author") < 0) throw new Error("own post " + profileHtml);
const collapsed = P.collapse([
  { id: "youtube:northlamp", platform: "youtube", handle: "northlamp", name: "North Lamp" },
  { id: "x:cedarhill", platform: "x", handle: "cedarhill", name: "North Lamp" },
  { id: "x:sampleagency", platform: "x", handle: "sampleagency", name: "SampleAgency" }
]);
if (collapsed.length !== 2 || collapsed[0].personId !== "canadian-prepper" || collapsed[0].name !== "North Lamp") throw new Error("collapse");
const suggested = P.suggestions([
  { id: "youtube:northlamp", platform: "youtube", handle: "northlamp", configured: true },
  { id: "x:cedarhill", platform: "x", handle: "cedarhill", configured: true },
  { id: "x:sampleagency", platform: "x", handle: "sampleagency", configured: true }
], (id) => id === "youtube:northlamp");
if (suggested.some((feed) => feed.personId === "canadian-prepper" || feed.handle === "cedarhill")) throw new Error("followed person still suggested");
if (!suggested.some((feed) => feed.handle === "sampleagency")) throw new Error("sampleagency missing");
"""],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    check(people_check.returncode == 0, "one person profile covers every linked account: " + (people_check.stderr or people_check.stdout))
    discord_checks()
    print("all adapter checks passed")


def discord_checks() -> None:
    import io
    import contextlib
    import subprocess
    import tempfile

    from adapters.discord import (
        attachment_parts,
        fetch_messages,
        invite_permissions,
        message_time,
        merge_discord,
        public_error,
        render_content,
        Client,
    )

    check(invite_permissions() == 66560, "the Discord invite is view channel plus read history")
    moment = datetime(2024, 5, 1, 15, 30, tzinfo=timezone.utc)
    ms = int(moment.timestamp() * 1000)
    snow = str((ms - 1420070400000) << 22)
    stamped = message_time({"id": snow, "edited_timestamp": "2030-01-01T00:00:00.000Z"})
    check(stamped == "2024-05-01T15:30:00.000Z", "a missing Discord timestamp comes from the snowflake, not the edit")
    edited = message_time({"id": snow, "timestamp": "2024-05-01T15:30:00.000000+00:00", "edited_timestamp": "2030-01-01T00:00:00.000Z"})
    check(edited == "2024-05-01T15:30:00.000Z", "an edit does not move the Discord publish time")

    bob = "100000000000000043"
    rendered, links, emojis = render_content(
        "Hello <@%s> **bold** <:wave:99> [site](https://example.com) ||secret|| \\*star\\* <t:1714577400:R> <#100000000000000010> <@&5>\n`**<@%s>**` hello_world _hi_"
        % (bob, bob),
        {
            "mentions": [{"id": bob, "username": "bob", "global_name": "Bob"}],
            "mention_channels": [{"id": "100000000000000010", "name": "announcements"}],
        },
    )
    check("Hello @Bob bold :wave: site secret *star*" in rendered, "discord markdown, mentions, emoji, and spoilers become plain text")
    check("May 01, 2024" in rendered and "ago" not in rendered, "a relative Discord timestamp is stored as a clock time")
    check("#announcements" in rendered and "@role" in rendered and "**<@%s>**" % bob in rendered and "hello_world hi" in rendered, "code, channel names, and snake_case stay put")
    check(emojis[0]["url"] == "https://cdn.discordapp.com/emojis/99.png" and links[0]["expanded"] == "https://example.com", "custom emoji and the labeled link are kept")
    animated, _, animated_emoji = render_content("<a:wave:99>", {})
    check(animated == ":wave:" and animated_emoji[0]["url"].endswith(".gif") and animated_emoji[0]["animated"] is True, "an animated custom emoji points at the gif")
    media, file_links = attachment_parts(
        {
            "attachments": [
                {"filename": "pic.png", "content_type": "image/png", "url": "https://cdn.discordapp.com/attachments/1/pic.png", "width": 8, "height": 4, "description": "A pic", "proxy_url": "https://media.discordapp.net/pic.png"},
                {"filename": "clip.mp4", "content_type": "video/mp4", "url": "https://cdn.discordapp.com/attachments/1/clip.mp4", "width": 640, "height": 360},
                {"filename": "notes.pdf", "content_type": "application/pdf", "url": "https://cdn.discordapp.com/attachments/1/notes.pdf"},
            ]
        }
    )
    check(media[0]["type"] == "photo" and media[0]["url"].endswith("pic.png") and "media.discordapp.net" not in media[0]["url"] and media[1]["type"] == "video" and file_links[0]["expanded"].endswith("notes.pdf"), "images and video stay on the CDN and other files are links")

    token = "super-secret-token"
    user_secret = "user-secret-token"
    old_token = os.environ.get("DISCORD_BOT_TOKEN")
    old_user = os.environ.get("DISCORD_USER_TOKEN")
    os.environ["DISCORD_BOT_TOKEN"] = token
    os.environ["DISCORD_USER_TOKEN"] = user_secret
    try:
        check(token not in public_error(RuntimeError("bad " + token)) and "[redacted]" in public_error(RuntimeError("bad " + token)), "a Discord error does not repeat the bot token")
        check(user_secret not in public_error(RuntimeError("bad " + user_secret)), "a Discord error does not repeat the user token")
    finally:
        if old_token is None:
            os.environ.pop("DISCORD_BOT_TOKEN", None)
        else:
            os.environ["DISCORD_BOT_TOKEN"] = old_token
        if old_user is None:
            os.environ.pop("DISCORD_USER_TOKEN", None)
        else:
            os.environ["DISCORD_USER_TOKEN"] = old_user

    guild = "100000000000000001"
    posts_channel = "100000000000000010"
    messages_channel = "100000000000000011"
    forbidden = "100000000000000013"
    scrape = "100000000000000014"
    parent = "100000000000000200"
    reply = "100000000000000201"
    thread_msg = "100000000000000300"
    chat_old = "100000000000000301"
    chat_new = "100000000000000302"
    cursor = "100000000000000100"
    ada = {"id": "100000000000000042", "username": "ada", "global_name": "Ada Lovelace", "avatar": "abc123"}
    bob_user = {"id": bob, "username": "bob", "global_name": "Bob", "avatar": "def456"}
    parent_message = {
        "id": parent,
        "channel_id": posts_channel,
        "type": 0,
        "content": "Hello <@%s> **bold** <:wave:99> [site](https://example.com) ||secret|| \\*star\\* <t:1714577400:R>" % bob,
        "timestamp": "2024-05-01T15:30:00.000000+00:00",
        "edited_timestamp": "2030-01-01T00:00:00.000000+00:00",
        "author": ada,
        "mentions": [bob_user],
        "attachments": [
            {"id": "1", "filename": "pic.png", "content_type": "image/png", "url": "https://cdn.discordapp.com/attachments/10/1/pic.png?ex=abcd", "width": 100, "height": 80, "description": "A pic", "proxy_url": "https://media.discordapp.net/attachments/10/1/pic.png"},
            {"id": "2", "filename": "clip.mp4", "content_type": "video/mp4", "url": "https://cdn.discordapp.com/attachments/10/2/clip.mp4", "width": 640, "height": 360},
        ],
        "embeds": [{"title": "Example", "description": "A **card**", "url": "https://example.com/post", "image": {"url": "https://cdn.discordapp.com/embed/image.png"}, "provider": {"name": "Example Site"}}],
        "reactions": [{"count": 3, "emoji": {"name": "👍"}}],
        "thread": {"id": parent, "name": "discussion", "message_count": 2},
    }
    reply_message = {
        "id": reply,
        "channel_id": posts_channel,
        "type": 19,
        "content": "a reply",
        "timestamp": "2024-05-01T16:00:00.000000+00:00",
        "author": bob_user,
        "message_reference": {"message_id": parent, "channel_id": posts_channel, "guild_id": guild},
        "referenced_message": {"id": parent, "channel_id": posts_channel, "author": ada},
    }
    join_message = {"id": "100000000000000190", "channel_id": posts_channel, "type": 7, "content": "Ada joined", "timestamp": "2024-05-01T15:00:00.000Z", "author": ada}
    thread_message = {
        "id": thread_msg,
        "channel_id": parent,
        "type": 0,
        "content": "in the thread",
        "timestamp": "2024-05-01T17:00:00.000000+00:00",
        "author": ada,
    }
    avatar = "https://cdn.discordapp.com/avatars/100000000000000042/abc123.png?size=128"
    chat = [
        {"id": chat_new, "channel_id": messages_channel, "type": 0, "content": "one " + token, "timestamp": "2024-06-01T00:00:00.000Z", "author": ada, "attachments": [{"filename": "pic.png", "content_type": "image/png", "url": "https://cdn.discordapp.com/attachments/11/9/pic.png?ex=ffff", "width": 10, "height": 12, "proxy_url": "https://media.discordapp.net/attachments/11/9/pic.png"}]},
        {"id": chat_old, "channel_id": messages_channel, "type": 0, "content": "earlier", "timestamp": "2024-05-02T00:00:00.000Z", "author": ada},
    ]

    def ok(payload, remaining="5"):
        return 200, {"X-RateLimit-Remaining": remaining}, json.dumps(payload).encode()

    calls = []

    def transport(url, headers):
        calls.append((url, dict(headers)))
        auth = headers.get("Authorization")
        if "widget.json" in url or "/invites/" in url:
            check(auth is None, "widget and invite lookups do not send the bot token")
        else:
            check(auth == "Bot " + token, "Discord requests use the bot token and not a configured one")
        check(token not in url, "the bot token is not put in the URL")
        if url.endswith("/users/@me"):
            return ok({"id": "100000000000000077", "username": "feedbot"})
        if "widget.json" in url:
            return ok({"id": guild, "name": "Widget Name", "instant_invite": "https://discord.gg/AbCdEf", "presence_count": 12})
        if "/invites/AbCdEf" in url:
            return ok({"code": "AbCdEf", "approximate_member_count": 500, "approximate_presence_count": 9, "guild": {"id": guild, "name": "Widget Name", "icon": "a1b2c3", "description": "A public server"}})
        if "/guilds/%s" % guild in url and "with_counts" in url:
            return ok({"id": guild, "name": "Guild Name", "icon": "a1b2c3", "description": "A public server", "approximate_member_count": 500, "approximate_presence_count": 12})
        if "/channels/%s/messages" % forbidden in url:
            return 403, {}, b'{"message":"Missing Access","code":50001}'
        if "/channels/%s/messages" % posts_channel in url and "after=" in url:
            check(("after=" + parent) in url, "after pages from the newest snowflake already stored")
            return ok([reply_message])
        if "/channels/%s/messages" % posts_channel in url:
            return ok([reply_message, parent_message, join_message])
        if "/channels/%s/messages" % parent in url:
            return ok([thread_message])
        if "/channels/%s/messages" % messages_channel in url:
            return ok(chat)
        return 404, {}, b"{}"

    config = {
        "cap": 300,
        "discord": [
            {
                "id": guild,
                "name": "Configured Server",
                "token": "config-secret",
                "channels": [
                    {"id": posts_channel, "name": "announcements", "mode": "posts", "limit": 20},
                    {"id": messages_channel, "name": "general", "mode": "messages", "limit": 20},
                    {"id": forbidden, "name": "secret", "mode": "posts"},
                    {"id": scrape, "name": "nope", "mode": "scrape"},
                ],
            }
        ],
    }
    previous = [{"id": "discord:%s:%s" % (posts_channel, parent), "platform": "discord", "feedId": "discord:" + guild, "date": "2030-01-01T00:00:00.000Z", "text": "stale"}]
    doc = {"posts": [{"id": "keep-x", "platform": "x", "feedId": "x:copperlane", "date": "2026-01-01T00:00:00.000Z", "text": "stay"}], "feeds": []}
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "discord").mkdir()
        (root / "discord" / "state.json").write_text(json.dumps({"channels": {posts_channel: cursor}}), encoding="utf-8")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            merge_discord(doc, config, root, previous, token=token, user_token="", transport=transport, remote=False, now=datetime(2030, 1, 1, tzinfo=timezone.utc))
        log = buf.getvalue()
        check(token not in log and "config-secret" not in log and "bot feedbot" in log, "the sync log names the bot and not the token")
        check("not readable" in log, "a channel the bot cannot view is skipped")
        check(not any(scrape in url for url, _headers in calls), "an unknown Discord mode is not requested")
        post = next(item for item in doc["posts"] if item["id"] == "discord:%s:%s" % (posts_channel, parent))
        check(post["date"] == "2024-05-01T15:30:00.000Z" and "2030" not in post["date"], "the stored Discord date is the original timestamp")
        check(post["author"] == "Ada Lovelace" and post["handle"] == "ada" and post["avatar"] == avatar, "the post shows the Discord author")
        check("Hello @Bob bold :wave:" in post["text"] and "secret" in post["text"] and "*star*" in post["text"] and "May 01, 2024" in post["text"], "the post text is rendered")
        check(post["emojis"][0]["name"] == "wave" and post["media"][0]["type"] == "photo" and post["media"][1]["type"] == "video" and post["media"][1]["url"].endswith("clip.mp4"), "emoji, the photo, and the video are on the post")
        check(post["cards"][0]["title"] == "Example" and post["cards"][0]["description"] == "A card" and post["stats"]["likes"] == 3 and post["stats"]["replies"] == 2, "an embed is a link card and reactions are likes")
        check(post["url"] == "https://discord.com/channels/%s/%s/%s" % (guild, posts_channel, parent) and post["channelName"] == "announcements", "the permalink is the Discord message")
        nested = {item["id"]: item for item in post["replies"]}
        check("discord:%s:%s" % (posts_channel, reply) in nested and "discord:%s:%s" % (parent, thread_msg) in nested, "the reply and the thread are nested on the parent")
        check(nested["discord:%s:%s" % (posts_channel, reply)]["replyingTo"]["handle"] == "ada" and nested["discord:%s:%s" % (parent, thread_msg)]["text"] == "in the thread", "a thread message points at the starter")
        check(all(item["id"] != "discord:%s:100000000000000190" % posts_channel for item in doc["posts"]), "a join message is not a post")
        check(any(item["id"] == "keep-x" for item in doc["posts"]), "Discord merge leaves the other feeds in place")
        profile = next(item for item in doc["feeds"] if item["id"] == "discord:" + guild)
        check(profile["name"] == "Configured Server" and "a1b2c3" in profile["avatar"] and profile["followers"] == 500 and profile["online"] == 12 and profile["url"] == "https://discord.gg/AbCdEf" and profile["bio"] == "A public server" and profile["configured"] is True, "widget and invite fill the server header")
        transcript = json.loads((root / "discord" / "messages" / ("%s.json" % messages_channel)).read_text(encoding="utf-8"))
        body = json.dumps(transcript)
        check(transcript["messages"][0]["id"] == chat_new and transcript["messages"][0]["date"].startswith("2024-06-01") and transcript["fetchedAt"].startswith("2030-"), "message dates stay on the message and fetchedAt is the sync")
        check(body.count(avatar) == 1 and "proxy_url" not in body and "referenced_message" not in body and token not in body and "[redacted]" in body, "a transcript stores each author once and only CDN urls")
        check(transcript["messages"][0]["attachments"][0]["url"].startswith("https://cdn.discordapp.com/attachments/"), "transcript media stays on the Discord CDN")
        index = json.loads((root / "discord" / "index.json").read_text(encoding="utf-8"))
        modes = {item["id"]: item for item in index["servers"][0]["channels"]}
        check(modes[posts_channel]["mode"] == "posts" and modes[messages_channel]["file"] == "discord/messages/%s.json" % messages_channel and scrape not in modes, "the index lists posts and message files")
        state = json.loads((root / "discord" / "state.json").read_text(encoding="utf-8"))
        check(state["channels"][posts_channel] == reply and token not in json.dumps(state), "the next after cursor is the newest snowflake")

        skipped = {"posts": [], "feeds": []}
        earlier = [{"id": "discord:%s:%s" % (posts_channel, parent), "platform": "discord", "feedId": "discord:" + guild, "date": "2024-05-01T15:30:00.000Z", "text": "kept"}]

        def explode(_url, _headers):
            raise AssertionError("discord was called without a token")

        quiet = io.StringIO()
        with contextlib.redirect_stdout(quiet):
            merge_discord(skipped, config, root / "skip", earlier, token="", user_token="", transport=explode, remote=False)
        check("DISCORD_BOT_TOKEN is not set" in quiet.getvalue() and skipped["posts"][0]["date"] == "2024-05-01T15:30:00.000Z", "a missing token skips Discord and keeps the old post")

        denied = {"posts": [], "feeds": []}

        def reject(url, headers):
            check(headers.get("Authorization") == "Bot " + token, "a rejected token was still sent as a bot token")
            return 401, {}, b'{"message":"401: Unauthorized"}'

        denied_log = io.StringIO()
        with contextlib.redirect_stdout(denied_log):
            merge_discord(denied, config, root / "denied", earlier, token=token, user_token="", transport=reject, remote=False)
        check("rejected the bot token" in denied_log.getvalue() and token not in denied_log.getvalue() and denied["posts"][0]["id"].endswith(parent), "a rejected token skips Discord without printing it")

    slept = []

    def limited(url, headers):
        limited.n += 1
        check(headers["Authorization"] == "Bot " + token, "paged reads use the bot token")
        if limited.n == 1:
            return 429, {"Retry-After": "0.2"}, b'{"retry_after":0.2,"message":"You are being rate limited.","global":false}'
        if "after=" not in url:
            return 200, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "1.25"}, b"[]"
        if "after=100" in url:
            return 200, {"X-RateLimit-Remaining": "1"}, json.dumps([
                {"id": "102", "channel_id": "10", "content": "n", "timestamp": "2024-05-01T00:00:02Z", "author": {"id": "1", "username": "a"}},
                {"id": "101", "channel_id": "10", "content": "o", "timestamp": "2024-05-01T00:00:01Z", "author": {"id": "1", "username": "a"}},
            ]).encode()
        if "after=102" in url:
            return 200, {"X-RateLimit-Remaining": "1"}, json.dumps([
                {"id": "104", "channel_id": "10", "content": "n", "timestamp": "2024-05-01T00:00:04Z", "author": {"id": "1", "username": "a"}},
                {"id": "103", "channel_id": "10", "content": "o", "timestamp": "2024-05-01T00:00:03Z", "author": {"id": "1", "username": "a"}},
            ]).encode()
        return 200, {"X-RateLimit-Remaining": "1"}, b"[]"

    limited.n = 0
    paged = Client(token, transport=limited, sleep=lambda seconds: slept.append(seconds), page_size=2)
    page_log = io.StringIO()
    with contextlib.redirect_stdout(page_log):
        found = fetch_messages(paged, "10", 4, "100")
    check([item["id"] for item in found] == ["104", "103", "102", "101"], "after pages walk forward from the cursor")
    check(slept == [0.2, 1.25], "429 and an empty rate-limit bucket are waited out")
    check(token not in page_log.getvalue(), "rate-limit logs do not include the token")

    seen_urls = []

    def paging(url, headers):
        seen_urls.append(url)
        if "after=" not in url:
            return 200, {"X-RateLimit-Remaining": "1"}, b"[]"
        if "after=100&" in url or url.endswith("after=100") or "after=100" in url and "after=102" not in url and "after=101" not in url:
            return 200, {"X-RateLimit-Remaining": "1"}, json.dumps([
                {"id": "102", "channel_id": "10"},
                {"id": "101", "channel_id": "10"},
            ]).encode()
        if "after=102" in url:
            return 200, {"X-RateLimit-Remaining": "1"}, json.dumps([
                {"id": "104", "channel_id": "10"},
                {"id": "103", "channel_id": "10"},
            ]).encode()
        return 200, {"X-RateLimit-Remaining": "1"}, b"[]"

    walker = Client(token, transport=paging, sleep=lambda _seconds: None, page_size=2)
    walked = fetch_messages(walker, "10", 4, "100")
    check([item["id"] for item in walked] == ["104", "103", "102", "101"], "the second after cursor is the newest id on the page")
    check(any("after=100" in url for url in seen_urls) and any("after=102" in url for url in seen_urls) and not any("after=101" in url for url in seen_urls), "paging follows Discord's newest-id after cursor")

    from adapters.discord import DiscordStop, user_get_allowed

    user_guild = "200000000000000001"
    visible = "200000000000000010"
    hidden = "200000000000000011"
    blocked = "200000000000000012"
    bot_token = "bot-token-value"
    account_token = "account-token-value"
    check(user_get_allowed("https://discord.com/api/v10/channels/%s/messages" % visible), "user reads are limited to channel message gets")
    check(user_get_allowed("https://discord.com/api/v10/channels/%s/pins" % visible), "user reads include one pins list per channel")
    check(not user_get_allowed("https://discord.com/api/v10/users/@me") and not user_get_allowed("https://discord.com/api/v10/channels/%s/messages/1/reactions" % visible), "user reads do not include the account or a reaction")

    refused = {"n": 0}

    def refuse_transport(url, headers):
        refused["n"] += 1
        raise AssertionError(url)

    quiet_user = Client(account_token, auth="user", transport=refuse_transport, sleep=lambda _seconds: None, clock=lambda: 0)
    refuse_log = io.StringIO()
    with contextlib.redirect_stdout(refuse_log):
        check(quiet_user.get_json("/users/@me") is None, "a user token does not call /users/@me")
    check(refused["n"] == 0 and account_token not in refuse_log.getvalue(), "a refused user request is not sent and does not log the token")

    pace_slept = []

    def paced(url, headers):
        check(headers.get("Authorization") == account_token and not headers.get("Authorization").startswith("Bot "), "paced reads send the user token without a Bot prefix")
        check("Mozilla/5.0" in headers.get("User-Agent", "") and "DiscordBot" not in headers.get("User-Agent", ""), "user reads use a browser user agent")
        for banned in ("X-Super-Properties", "X-Fingerprint", "Cookie"):
            check(banned not in headers, "user reads do not add a client fingerprint")
        check(account_token not in url, "the user token is not put in the URL")
        if "after=100" in url:
            return 200, {"X-RateLimit-Remaining": "1"}, json.dumps([{"id": "101", "channel_id": "10", "content": "a", "timestamp": "2024-05-01T00:00:01Z", "author": {"id": "1", "username": "a"}}]).encode()
        if "after=101" in url:
            return 200, {"X-RateLimit-Remaining": "1"}, json.dumps([{"id": "102", "channel_id": "10", "content": "b", "timestamp": "2024-05-01T00:00:02Z", "author": {"id": "1", "username": "a"}}]).encode()
        raise AssertionError(url)

    paced_client = Client(account_token, auth="user", transport=paced, sleep=pace_slept.append, clock=lambda: 0, page_size=1)
    paced_found = fetch_messages(paced_client, "10", 2, "100")
    check([item["id"] for item in paced_found] == ["102", "101"] and pace_slept == [1.5], "a user sync pages after the cursor and waits 1.5 seconds")
    check(Client(account_token, auth="user", transport=refuse_transport, sleep=lambda _seconds: None).page_size == 25, "a user client defaults to 25-message pages")

    history_calls = []

    def history(url, headers):
        history_calls.append(url)
        if "before=" in url:
            older = [{"id": str(200 - i), "channel_id": "10", "content": "o", "timestamp": "2024-05-01T00:00:00Z", "author": {"id": "1", "username": "a"}} for i in range(25)]
            return 200, {"X-RateLimit-Remaining": "1"}, json.dumps(older).encode()
        newest = [{"id": str(300 - i), "channel_id": "10", "content": "n", "timestamp": "2024-05-01T00:00:01Z", "author": {"id": "1", "username": "a"}} for i in range(25)]
        return 200, {"X-RateLimit-Remaining": "1"}, json.dumps(newest).encode()

    history_client = Client(account_token, auth="user", transport=history, sleep=lambda _seconds: None, clock=lambda: 0)
    history_found = fetch_messages(history_client, "10", 50, None)
    check(len(history_found) == 50 and history_found[0]["id"] == "300", "the first history reads the last 50 messages")
    check(any("limit=25" in url and "before=" not in url and "after=" not in url for url in history_calls) and any("before=276" in url for url in history_calls), "a full first page continues with before")

    waited = []
    attempts = {"n": 0}

    def once_limited(url, headers):
        attempts["n"] += 1
        if attempts["n"] == 1:
            return 429, {"Retry-After": "2"}, b'{"retry_after":2,"message":"You are being rate limited."}'
        return 200, {"X-RateLimit-Remaining": "1"}, b"[]"

    limited_user = Client(account_token, auth="user", transport=once_limited, sleep=waited.append, clock=lambda: 0)
    check(limited_user.get_json("/channels/10/messages", {"limit": "25"}) == [] and waited == [2.0] and attempts["n"] == 2, "a user-token 429 waits Retry-After once and does not stack another pause")

    storm = {"n": 0}
    storm_slept = []

    def always_limited(url, headers):
        storm["n"] += 1
        return 429, {"Retry-After": "2"}, b'{"retry_after":2}'

    storm_user = Client(account_token, auth="user", transport=always_limited, sleep=storm_slept.append, clock=lambda: 0)
    storm_error = None
    try:
        storm_user.get_json("/channels/10/messages")
    except DiscordStop as exc:
        storm_error = exc
    check(storm_error is not None and storm_error.reason == "rate-limit" and storm["n"] == 2 and storm_slept == [2.0, 2.0], "a second 429 stops the user-token run")

    ada_id = "100000000000000042"
    user_message = {"id": "200000000000000200", "channel_id": visible, "type": 0, "content": "seen " + account_token, "timestamp": "2024-05-01T15:30:00.000Z", "author": {"id": ada_id, "username": "ada", "global_name": "Ada Lovelace", "avatar": "abc123"}}
    hidden_message = {"id": "200000000000000201", "channel_id": hidden, "type": 0, "content": "from the account", "timestamp": "2024-05-01T16:00:00.000Z", "author": {"id": ada_id, "username": "ada", "global_name": "Ada Lovelace"}}
    seen = []

    def both_tokens(url, headers):
        seen.append((url, headers.get("Authorization"), headers.get("User-Agent")))
        auth = headers.get("Authorization")
        if url.endswith("/users/@me"):
            check(auth == "Bot " + bot_token, "the bot identity uses the bot token")
            return 200, {"X-RateLimit-Remaining": "5"}, b'{"id":"9","username":"feedbot"}'
        if "widget.json" in url or "/invites/" in url:
            check(auth is None, "widget and invite lookups stay anonymous")
            if "widget.json" in url:
                return 200, {}, json.dumps({"id": user_guild, "name": "Joined", "presence_count": 4}).encode()
            return 404, {}, b"{}"
        if "/guilds/%s" % user_guild in url and auth == "Bot " + bot_token:
            return 403, {}, b'{"message":"Missing Access","code":50001}'
        if "/guilds/%s" % user_guild in url:
            check(auth == account_token, "the guild header falls back to the user token")
            return 200, {}, json.dumps({"id": user_guild, "name": "Joined", "approximate_member_count": 8}).encode()
        if url.endswith("/channels/" + visible):
            check(auth == "Bot " + bot_token, "the bot is asked whether it can see the channel")
            return 200, {}, json.dumps({"id": visible, "name": "announcements"}).encode()
        if "/channels/%s/messages" % visible in url:
            check(auth == "Bot " + bot_token, "a channel the bot can see is not read with the user token")
            return 200, {"X-RateLimit-Remaining": "5"}, json.dumps([user_message]).encode()
        if url.endswith("/channels/" + hidden):
            check(auth == "Bot " + bot_token, "the hidden channel is probed with the bot first")
            return 403, {}, b'{"message":"Missing Access","code":50001}'
        if "/channels/%s/messages" % hidden in url:
            check(auth == account_token and "Mozilla/5.0" in (headers.get("User-Agent") or ""), "the bot miss uses the user token and the browser user agent")
            check("limit=25" in url and "after=" not in url, "the first user page is small and has no cursor yet")
            return 200, {"X-RateLimit-Remaining": "5"}, json.dumps([hidden_message]).encode()
        if url.endswith("/pins"):
            return 200, {"X-RateLimit-Remaining": "5"}, b"[]"
        raise AssertionError(url)

    both_config = {
        "cap": 50,
        "discord": [
            {
                "id": user_guild,
                "name": "Joined Server",
                "auth": "user",
                "userToken": account_token,
                "channels": [
                    {"id": visible, "name": "announcements", "mode": "posts"},
                    {"id": hidden, "name": "general", "mode": "messages", "limit": 40},
                ],
            }
        ],
    }
    both_doc = {"posts": [], "feeds": [], "sourceHealth": {"discord": {"ok": "", "emptySince": "2020-01-01T00:00:00Z", "detail": "old"}}}
    with tempfile.TemporaryDirectory() as tmp:
        both_root = Path(tmp)
        both_log = io.StringIO()
        with contextlib.redirect_stdout(both_log):
            both_result = merge_discord(both_doc, both_config, both_root, [], token=bot_token, user_token=account_token, transport=both_tokens, sleep=lambda _seconds: None, clock=lambda: 0, remote=False, now=datetime(2030, 1, 1, tzinfo=timezone.utc))
        both_text = both_log.getvalue()
        check(both_result["skipped"] is False and account_token not in both_text and bot_token not in both_text, "both tokens can run without either secret being logged")
        visible_post = next(item for item in both_doc["posts"] if item["id"].endswith(user_message["id"]))
        check(visible_post["author"] == "Ada Lovelace" and visible_post["text"] == "seen [redacted]", "a user-auth channel the bot can see stays a bot post and redacts the token")
        transcript = json.loads((both_root / "discord" / "messages" / (hidden + ".json")).read_text(encoding="utf-8"))
        check(transcript["messages"][0]["text"] == "from the account" and account_token not in json.dumps(transcript), "the channel the bot cannot see is stored as a user-token transcript")
        check(both_doc["sourceHealth"]["discord"].get("detail", "") == "" and both_doc["sourceHealth"]["discord"].get("emptySince", "") == "", "a finished Discord sync clears a previous stop")

        stop_calls = []

        later_id = "200000000000000202"

        def stop_transport(url, headers):
            stop_calls.append(url)
            if "widget.json" in url:
                check(headers.get("Authorization") is None, "a channel skip still does not send the token to the widget")
                return 200, {}, b'{"name":"Joined","presence_count":1}'
            if "/guilds/" in url:
                return 200, {}, json.dumps({"id": user_guild, "name": "Joined"}).encode()
            if hidden in url:
                return 403, {}, b'{"message":"Missing Access","code":50001}'
            if blocked in url and "/messages" in url:
                return 200, {"X-RateLimit-Remaining": "5"}, json.dumps([
                    {"id": later_id, "channel_id": blocked, "type": 0, "content": "still here", "timestamp": "2024-05-02T00:00:00.000Z", "author": {"id": ada_id, "username": "ada", "global_name": "Ada Lovelace"}}
                ]).encode()
            raise AssertionError(url)

        stop_config = {
            "cap": 50,
            "discord": [
                {
                    "id": user_guild,
                    "name": "Joined Server",
                    "auth": "user",
                    "channels": [
                        {"id": hidden, "name": "general", "mode": "posts"},
                        {"id": blocked, "name": "later", "mode": "posts"},
                    ],
                }
            ],
        }
        stop_doc = {"posts": [{"id": "discord:%s:%s" % (hidden, hidden_message["id"]), "platform": "discord", "feedId": "discord:" + user_guild, "date": "2024-05-01T15:30:00.000Z", "text": "kept"}], "feeds": []}
        stop_log = io.StringIO()
        with contextlib.redirect_stdout(stop_log):
            stop_result = merge_discord(stop_doc, stop_config, both_root / "stop", stop_doc["posts"], token="", user_token=account_token, transport=stop_transport, sleep=lambda _seconds: None, clock=lambda: 0, remote=False, now=datetime(2030, 1, 2, tzinfo=timezone.utc))
        stop_text = stop_log.getvalue()
        check(stop_result.get("stopped") is not True and "will not retry" not in stop_text and account_token not in stop_text, "a channel 403 does not stop Discord")
        check(any("/messages" in url and blocked in url for url in stop_calls) and any(item.get("text") == "still here" for item in stop_doc["posts"]), "the next channel is still read")
        check(any(item.get("text") == "kept" for item in stop_doc["posts"]) and "not readable" in stop_text, "the locked channel is skipped and the old post stays")
        check("will not retry" not in stop_doc["sourceHealth"]["discord"].get("detail", ""), "a skipped channel is not recorded as a sync stop")

        unauth_calls = []

        def unauthorized_transport(url, headers):
            unauth_calls.append(url)
            if "widget.json" in url:
                return 200, {}, b"{}"
            if "/guilds/" in url:
                return 200, {}, json.dumps({"id": user_guild, "name": "Joined"}).encode()
            if hidden in url:
                return 401, {}, b'{"message":"401: Unauthorized","code":0}'
            if blocked in url:
                raise AssertionError("a later channel was requested after 401")
            raise AssertionError(url)

        unauth_doc = {"posts": [], "feeds": []}
        unauth_log = io.StringIO()
        with contextlib.redirect_stdout(unauth_log):
            unauth_result = merge_discord(unauth_doc, stop_config, both_root / "unauth", [], token="", user_token=account_token, transport=unauthorized_transport, sleep=lambda _seconds: None, clock=lambda: 0, remote=False)
        check(unauth_result.get("stopped") is True and unauth_result.get("reason") == "unauthorized" and "401" in unauth_doc["sourceHealth"]["discord"]["detail"] and account_token not in unauth_log.getvalue(), "a 401 stops Discord for the run")
        check(all(blocked not in url for url in unauth_calls), "a 401 does not read later channels")

        def captcha_transport(url, headers):
            if "widget.json" in url:
                return 200, {}, b"{}"
            if "/guilds/" in url:
                return 400, {}, b'{"captcha_key":["captcha-required"],"captcha_sitekey":"abc"}'
            raise AssertionError(url)

        captcha_doc = {"posts": [], "feeds": []}
        captcha_log = io.StringIO()
        with contextlib.redirect_stdout(captcha_log):
            captcha_result = merge_discord(captcha_doc, stop_config, both_root / "captcha", [], token="", user_token=account_token, transport=captcha_transport, sleep=lambda _seconds: None, clock=lambda: 0, remote=False)
        check(captcha_result["reason"] == "captcha" and "captcha" in captcha_log.getvalue().lower() and account_token not in captcha_log.getvalue(), "a captcha stops Discord without a retry")

        def verify_transport(url, headers):
            if "widget.json" in url:
                return 200, {}, b"{}"
            return 403, {}, b'{"message":"You need to verify your account in order to perform this action.","code":40002}'

        verify_doc = {"posts": [], "feeds": []}
        verify_log = io.StringIO()
        with contextlib.redirect_stdout(verify_log):
            verify_result = merge_discord(verify_doc, stop_config, both_root / "verify", [], token="", user_token=account_token, transport=verify_transport, sleep=lambda _seconds: None, clock=lambda: 0, remote=False)
        check(verify_result["reason"] == "verification" and "verification" in verify_log.getvalue().lower(), "a verification challenge stops Discord")

        guild_calls = []

        def guild_block(url, headers):
            guild_calls.append(url)
            if "widget.json" in url:
                return 200, {}, b"{}"
            if "/guilds/" in url:
                return 403, {}, ('{"message":"Missing Access","code":50001,"token":"%s"}' % account_token).encode()
            raise AssertionError("a later read happened after a guild 403")

        guild_doc = {"posts": [], "feeds": []}
        guild_log = io.StringIO()
        with contextlib.redirect_stdout(guild_log):
            guild_result = merge_discord(guild_doc, stop_config, both_root / "guild403", [], token="", user_token=account_token, transport=guild_block, sleep=lambda _seconds: None, clock=lambda: 0, remote=False)
        guild_index = json.loads((both_root / "guild403" / "discord" / "index.json").read_text(encoding="utf-8"))
        guild_text = guild_log.getvalue() + json.dumps(guild_index)
        check(guild_result.get("stopped") is True and guild_result.get("reason") == "forbidden" and guild_index.get("status") == "forbidden" and guild_index.get("detail", "").startswith("Discord returned 403") and account_token not in guild_text, "a guild 403 stops Discord and writes a paused index without the token")
        check(all("/channels/" not in url for url in guild_calls), "a guild 403 does not read channels")

        quiet_calls = []
        quiet_id = "0100000000000000542"

        def quiet_block(url, headers):
            quiet_calls.append(url)
            if "widget.json" in url:
                return 200, {}, b"{}"
            if "/guilds/" in url:
                return 200, {}, json.dumps({"id": user_guild, "name": "Joined"}).encode()
            if quiet_id in url:
                return 403, {}, ('{"message":"nope","code":20016,"token":"%s"}' % account_token).encode()
            if blocked in url and "/messages" in url:
                return 200, {"X-RateLimit-Remaining": "5"}, json.dumps([
                    {"id": later_id, "channel_id": blocked, "type": 0, "content": "after quiet", "timestamp": "2024-05-02T00:00:00.000Z", "author": {"id": ada_id, "username": "ada", "global_name": "Ada"}}
                ]).encode()
            raise AssertionError(url)

        quiet_config = {
            "cap": 50,
            "discord": [{
                "id": user_guild,
                "name": "Joined Server",
                "auth": "user",
                "channels": [
                    {"id": quiet_id, "name": "boosters-chat", "mode": "messages"},
                    {"id": blocked, "name": "later", "mode": "messages"},
                ],
            }],
        }
        quiet_doc = {"posts": [], "feeds": []}
        quiet_log = io.StringIO()
        with contextlib.redirect_stdout(quiet_log):
            quiet_result = merge_discord(quiet_doc, quiet_config, both_root / "quiet403", [], token="", user_token=account_token, transport=quiet_block, sleep=lambda _seconds: None, clock=lambda: 0, remote=False)
        quiet_index = json.loads((both_root / "quiet403" / "discord" / "index.json").read_text(encoding="utf-8"))
        quiet_channels = quiet_index["servers"][0]["channels"]
        quiet_row = next(item for item in quiet_channels if item["id"] == quiet_id)
        check(quiet_result.get("stopped") is not True and any(blocked in url for url in quiet_calls) and quiet_row.get("inaccessible") is True and "will not retry" not in quiet_doc["sourceHealth"]["discord"].get("detail", "") and account_token not in quiet_log.getvalue(), "a 403 on a known-unreadable channel does not stop Discord")

    pin_guild = "400000000000000001"
    pin_ok = "400000000000000010"
    pin_no = "400000000000000011"
    pin_old = "400000000000000100"
    pin_new = "400000000000000200"
    pin_calls = []
    pin_slept = []

    def pin_transport(url, headers):
        pin_calls.append(url)
        if "widget.json" in url or "/invites/" in url:
            return 200, {}, b"{}"
        if "/guilds/" in url:
            return 200, {}, json.dumps({"id": pin_guild, "name": "Pins"}).encode()
        if url.endswith("/pins") and pin_ok in url:
            return 200, {"X-RateLimit-Remaining": "5"}, json.dumps([
                {"id": pin_old, "content": "older " + account_token, "timestamp": "2024-05-01T00:00:01.000Z", "author": {"id": "1", "username": "ada", "global_name": "Ada"}},
                {"id": pin_new, "content": "newer pin", "timestamp": "2024-05-01T00:00:02.000Z", "author": {"id": "1", "username": "ada", "global_name": "Ada"}},
            ]).encode()
        if url.endswith("/pins") and pin_no in url:
            return 403, {}, b'{"message":"Missing Access","code":50001}'
        if "/messages" in url:
            return 200, {"X-RateLimit-Remaining": "5"}, json.dumps([
                {"id": pin_new, "channel_id": pin_ok, "type": 0, "content": "hello", "timestamp": "2024-05-01T00:00:02.000Z", "author": {"id": "1", "username": "ada", "global_name": "Ada"}},
            ]).encode()
        raise AssertionError(url)

    pin_config = {
        "cap": 50,
        "discord": [{
            "id": pin_guild,
            "name": "Pins",
            "auth": "user",
            "channels": [
                {"id": pin_ok, "name": "general", "mode": "messages", "limit": 20},
                {"id": pin_no, "name": "locked-pins", "mode": "messages", "limit": 20},
            ],
        }],
    }
    with tempfile.TemporaryDirectory() as tmp:
        pin_root = Path(tmp)
        pin_doc = {"posts": [], "feeds": []}
        pin_log = io.StringIO()
        with contextlib.redirect_stdout(pin_log):
            pin_result = merge_discord(pin_doc, pin_config, pin_root, [], token="", user_token=account_token, transport=pin_transport, sleep=pin_slept.append, clock=lambda: 0, remote=False, now=datetime(2030, 1, 1, tzinfo=timezone.utc))
        pin_urls = [url for url in pin_calls if url.endswith("/pins")]
        pin_file = json.loads((pin_root / "discord" / "pins" / (pin_ok + ".json")).read_text(encoding="utf-8"))
        pin_index = json.loads((pin_root / "discord" / "index.json").read_text(encoding="utf-8"))
        pin_rows = {item["id"]: item for item in pin_index["servers"][0]["channels"]}
        pin_text = pin_log.getvalue() + json.dumps(pin_file)
        check(pin_result.get("stopped") is not True and pin_urls.count(next(url for url in pin_urls if pin_ok in url)) == 1 and len(pin_urls) == 2, "each channel's pins are read once and a forbidden pins list does not stop Discord")
        check(pin_file["pins"][0]["id"] == pin_new and pin_file["forbidden"] is False and account_token not in pin_text and "[redacted]" in pin_text, "pin stubs are newest first and do not keep the token")
        check(pin_rows[pin_no].get("pinsForbidden") is True and pin_rows[pin_ok].get("pinsForbidden") is not True and 1.5 in pin_slept, "a forbidden pins read hides that channel and stays on the same pace")

    window_guild = "300000000000000001"
    window_channel = "300000000000000010"
    window_new = "300000000000000104"

    def window_transport(url, headers):
        if url.endswith("/users/@me"):
            return 200, {}, b'{"id":"9","username":"feedbot"}'
        if "widget.json" in url or "/invites/" in url:
            return 200, {}, b"{}"
        if "/guilds/" in url:
            return 200, {}, json.dumps({"id": window_guild, "name": "W"}).encode()
        if "/messages" in url:
            return 200, {"X-RateLimit-Remaining": "5"}, json.dumps([
                {"id": window_new, "channel_id": window_channel, "type": 0, "content": "d", "timestamp": "2024-05-01T00:00:04.000Z", "author": {"id": "1", "username": "a", "global_name": "A"}}
            ]).encode()
        return 404, {}, b"{}"

    window_config = {
        "cap": 50,
        "discord": [
            {
                "id": window_guild,
                "name": "W",
                "channels": [{"id": window_channel, "name": "general", "category": "General", "mode": "messages", "limit": 2, "window": 4}],
            }
        ],
    }
    with tempfile.TemporaryDirectory() as tmp:
        window_root = Path(tmp)
        previous_path = window_root / "discord" / "messages" / (window_channel + ".json")
        previous_path.parent.mkdir(parents=True)
        previous_path.write_text(json.dumps({
            "messages": [
                {"id": "300000000000000101", "author": "1", "text": "a", "date": "2024-05-01T00:00:01.000Z"},
                {"id": "300000000000000102", "author": "1", "text": "b", "date": "2024-05-01T00:00:02.000Z"},
                {"id": "300000000000000103", "author": "1", "text": "c", "date": "2024-05-01T00:00:03.000Z"},
            ],
            "authors": {"1": {"name": "A", "handle": "a"}},
        }), encoding="utf-8")
        window_doc = {"posts": [], "feeds": []}
        with contextlib.redirect_stdout(io.StringIO()):
            merge_discord(window_doc, window_config, window_root, [], token=token, user_token="", transport=window_transport, remote=False, now=datetime(2030, 1, 1, tzinfo=timezone.utc))
        window_file = json.loads(previous_path.read_text(encoding="utf-8"))
        window_ids = [item["id"] for item in window_file["messages"]]
        check(window_ids == ["300000000000000104", "300000000000000103", "300000000000000102", "300000000000000101"], "a transcript keeps the rolling window, not just the fetch limit")
        window_index = json.loads((window_root / "discord" / "index.json").read_text(encoding="utf-8"))
        check(window_index["servers"][0]["channels"][0]["category"] == "General", "the index keeps the channel category")
        check(window_index["servers"][0]["channels"][0].get("pinsForbidden") is not True, "a missing pins list does not hide the pin icon")

    source = (ROOT / "scripts" / "adapters" / "discord.py").read_text(encoding="utf-8")
    check('method="GET"' in source and "POST" not in source and "PUT" not in source and "PATCH" not in source and "DELETE" not in source, "the Discord client only issues GET requests")

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    workflow = (ROOT / ".github" / "workflows" / "sync.yml").read_text(encoding="utf-8")
    check("DISCORD_BOT_TOKEN" in readme and "66560" in readme and "Message Content Intent" in readme and "widget.json" in readme and "Follow" in readme and "discord/messages/" in readme, "the readme documents the bot, the follow trick, and the files")
    check("DISCORD_USER_TOKEN" in readme and "spare account" in readme and "banned" in readme and "password" in readme.lower() and "auth\": \"user\"" in readme, "the readme states the ban risk and how the user token is stored")
    check("DISCORD_BOT_TOKEN" in workflow and "DISCORD_USER_TOKEN" in workflow and "add-mask" in workflow and "discord/**/*.json" in readme, "the workflow receives both Discord secrets and masks the user token")
    check("merge_discord" in (ROOT / "scripts" / "update_feeds.py").read_text(encoding="utf-8"), "the feed sync calls Discord")
    config_text = (ROOT / "feeds.config.json").read_text(encoding="utf-8")
    check('"discord"' in config_text and "100000000000000355" in config_text and '"auth": "user"' in config_text and '"window": 300' in config_text and "general-chat" in config_text and "product-updates" in config_text, "Town Hall is a user-auth server with a rolling window")
    page = (ROOT / "index.html").read_text(encoding="utf-8")
    check(page.index('src="split.js"') < page.index('src="discord-ui.js"') < page.index('src="app.js"') and 'href="discord-ui.css"' in page and "FeedsDiscord" in (ROOT / "app.js").read_text(encoding="utf-8"), "the page loads the Discord messages UI and app.js keeps a small hook")
    split_js = (ROOT / "split.js").read_text(encoding="utf-8")
    messages_css = (ROOT / "discord-ui.css").read_text(encoding="utf-8")
    messages_ui = (ROOT / "discord-ui.js").read_text(encoding="utf-8")
    publish = (ROOT / "scripts" / "discord_publish.py").read_text(encoding="utf-8")
    check("FeedsSplit" in split_js and "viktorychapp-splits-v1" in split_js and "superintelapp-splits-v1" in split_js and '"rss-" + "feeds-splits-v1"' in split_js and "requestAnimationFrame" in split_js and "function bind(" in split_js and ('role="separator"' in messages_ui or 'role=\\"separator\\"' in messages_ui) and "FeedsSplit.bind" in messages_ui and "--dmsgs-list, 440px" in messages_css and "col-resize" in messages_css and "min-width: 300px" in messages_css and "max-width: 60%" in messages_css and ".dmsgs-split { display: none; }" in messages_css and "split.js" in deployed_paths() and "assemble_site" in publish, "the message list divider drags between 300px and 60 percent and remembers the width")
    styles = (ROOT / "styles.css").read_text(encoding="utf-8")
    shell = (ROOT / "app.js").read_text(encoding="utf-8")
    check('class="nav-split"' in shell and 'role="separator"' in shell and "sidebar: sidebar" in split_js and "snapBelow" in split_js and "Collapse sidebar" in shell and 'data-act="nav-collapse"' in shell and 'html[data-nav="icons"]' in styles and "--nav-w" in styles and "width: 88px" in styles and "History" in shell and ".nav-split { display: none; }" in styles and 'matchMedia("(max-width: 1279px)")' in split_js and 'matchMedia("(max-width: 1279px)")' in (ROOT / "index.html").read_text(encoding="utf-8"), "the sidebar divider drags between icons-only and full width and narrow windows still force the icon rail")
    ui_check = subprocess.run(
        ["node", "--input-type=module", "-e", r"""
import fs from "fs";
import vm from "vm";
const context = { console, URLSearchParams, Date, Map, BigInt, Intl, JSON, Math, Number, Object, Array, String, isFinite, encodeURIComponent, decodeURIComponent };
vm.createContext(context);
vm.runInContext(fs.readFileSync("discord-ui.js", "utf8"), context);
const D = context.FeedsDiscord;
const html = D._format("**bold** <script>alert(1)</script> [x](javascript:alert(1)) https://discord.com/safety ||hide|| @Ada");
if (html.includes("<script>") || html.includes('href="javascript:')) throw new Error("xss " + html);
if (!html.includes("<strong>bold</strong>") || !html.includes("&lt;script&gt;") || !html.includes("dmsg-spoiler") || !html.includes("dmsg-mention") || !html.includes("https://discord.com/safety")) throw new Error("format " + html);
const known = { "100000000000000355": true };
if (D._validate({ v: 1, ch: "nope", m: { id: "1", content: "x", author: { id: "2", name: "A" } } }, known)) throw new Error("unknown channel");
const img = D._validate({
  v: 1,
  ch: "100000000000000355",
  m: {
    id: "10",
    content: "hi",
    author: { id: "2", name: "A", avatar: "https://evil.example/a.png" },
    att: [
      { url: "https://evil.example/a.png", type: "image" },
      { url: "javascript:alert(1)", type: "image" },
      { url: "https://cdn.discordapp.com/attachments/1/2/a.png", type: "image", w: 10, h: 12 },
      { url: "https://media.discordapp.net/attachments/1/2/b.png", type: "image" }
    ]
  }
}, known);
if (!img || img.m.att.length !== 2 || img.m.author.avatar) throw new Error("cdn " + JSON.stringify(img));
if (D._validate({ v: 1, ch: "100000000000000355", m: { id: "11", content: "x".repeat(4001), author: { id: "2", name: "A" } } }, known)) throw new Error("cap");
const posts = "100000000000000440";
if (!D._accept({ v: 1, ch: posts, m: { id: "12", content: "announce", author: { id: "2", name: "A" } } })) throw new Error("posts channel");
if (D._ids(posts).length) throw new Error("posts leaked into the inbox");
const general = "100000000000000355";
if (!D._accept({ v: 1, ch: general, m: { id: "10", content: "one", author: { id: "2", name: "Ada" } } })) throw new Error("accept");
if (!D._accept({ v: 1, ch: general, m: { id: "10", content: "one again", author: { id: "2", name: "Ada" } } })) throw new Error("dup");
if (D._ids(general).join(",") !== "10") throw new Error("dedupe " + D._ids(general).join(","));
if (!D._accept({ v: 1, ch: general, del: "10" })) throw new Error("del");
if (D._ids(general).length) throw new Error("deleted");
const empty = D.page({ name: "messages", query: new URLSearchParams("") });
if (!empty.includes("No conversations yet")) throw new Error("empty " + empty.slice(0, 240));
const page = D.page({ name: "messages", channel: general, query: new URLSearchParams("fixture=1") });
if (!page.includes("Read-only channel") || !page.includes("general-chat") || !page.includes("peer-help") || !page.includes("dmsg-embed") || !page.includes("dmsg-rx")) throw new Error("page");
if (page.includes("<script>")) throw new Error("page xss");
if (!page.includes("Discord Town Hall") || !page.includes('aria-expanded="false"') || page.includes("dmsgs-srv open")) throw new Error("collapsed server");
if (!page.includes('role="separator"') || !page.includes('aria-label="Resize message list"') || !page.includes('title="Discord Town Hall"') || !page.includes('title="general-chat"') || !page.includes('title="Town Hall General"')) throw new Error("split titles");
if (!page.includes("dmsgs-chev")) throw new Error("chevron");
D._setPrefs({ expanded: { "100000000000000355": true }, pinnedServers: ["100000000000000355"], pinnedChannels: ["100000000000000593"], mutedServers: [], mutedChannels: [] });
const expanded = D.page({ name: "messages", channel: "100000000000000355", query: new URLSearchParams("fixture=1") });
if (!expanded.includes('aria-expanded="true"') || !expanded.includes("dmsgs-srv open") || !expanded.includes('aria-pressed="true"')) throw new Error("expanded");
const peerAt = expanded.indexOf('data-ch="100000000000000593"');
const generalAt = expanded.indexOf('data-ch="100000000000000355"');
if (peerAt < 0 || generalAt < 0 || peerAt > generalAt) throw new Error("pinned channel order");
const peerChunk = expanded.split('data-ch="100000000000000593"')[1].split("</a>")[0];
if (!peerChunk.includes("dmsgs-pinmark")) throw new Error("pin mark");
D._openMenu("100000000000000355", false);
const pinMenu = D.page({ name: "messages", query: new URLSearchParams("fixture=1") });
if (!pinMenu.includes("Pin channel") || !pinMenu.includes("Mute channel")) throw new Error("pin menu");
D._openMenu("100000000000000593", false);
const unpinMenu = D.page({ name: "messages", query: new URLSearchParams("fixture=1") });
if (!unpinMenu.includes("Unpin channel")) throw new Error("unpin");
D._openMenu("100000000000000355", true);
const durations = D.page({ name: "messages", query: new URLSearchParams("fixture=1") });
if (!durations.includes("For 15 minutes") || !durations.includes("For 1 hour") || !durations.includes("For 8 hours") || !durations.includes("For 24 hours") || !durations.includes("Until I turn it back on")) throw new Error("durations");
D._openPins("100000000000000355");
const pins = D.page({ name: "messages", channel: "100000000000000355", query: new URLSearchParams("fixture=1") });
const panel = pins.split('class="dmsgs-pinpanel"')[1] || "";
const newerPin = panel.indexOf('data-mid="1530000000000000004"');
const olderPin = panel.indexOf('data-mid="1530000000000000001"');
if (!panel.includes("Pinned messages") || !panel.includes("Clyde") || newerPin < 0 || olderPin < 0 || newerPin > olderPin) throw new Error("pins panel");
D._setPrefs({ expanded: { "100000000000000355": true }, pinnedServers: [], pinnedChannels: [], mutedServers: ["100000000000000355"], mutedChannels: [] });
const muted = D.page({ name: "messages", query: new URLSearchParams("fixture=1") });
if (!muted.includes("dmsgs-srv open muted") || muted.includes("dmsgs-badge")) throw new Error("muted server " + (muted.includes("dmsgs-badge") ? "badge" : "class"));
D._openMenu("", false);
D._openPins("");
D._setPrefs({ expanded: { "100000000000000355": true }, pinnedServers: [], pinnedChannels: [], mutedServers: [], mutedChannels: ["100000000000000593"], mutes: {} });
const partial = D.page({ name: "messages", query: new URLSearchParams("fixture=1") });
if (!partial.includes('aria-label="1 unread"')) throw new Error("badge " + (partial.match(/aria-label="\\d+ unread"/) || []).join(","));
const peerBits = partial.split("dmsgs-ch-row");
let peerRow = "";
for (let i = 1; i < peerBits.length; i++) { if (peerBits[i].includes('data-ch="100000000000000593"')) peerRow = peerBits[i]; }
if (!peerRow.startsWith(" muted") || !peerRow.includes("dmsgs-bell") || peerRow.split("</a>")[0].includes("dmsgs-dot")) throw new Error("muted channel");
D._openMenu("100000000000000593", false);
if (!D.page({ name: "messages", query: new URLSearchParams("fixture=1") }).includes("Unmute channel")) throw new Error("unmute");
D._setPrefs({ expanded: { "100000000000000355": true }, pinnedServers: [], pinnedChannels: [], mutedServers: [], mutedChannels: [], mutes: { "100000000000000355": Date.now() - 1000 } });
const expired = D.page({ name: "messages", query: new URLSearchParams("fixture=1") });
const expiredBits = expired.split("dmsgs-ch-row");
let expiredRow = "";
for (let i = 1; i < expiredBits.length; i++) { if (expiredBits[i].includes('data-ch="100000000000000355"')) expiredRow = expiredBits[i]; }
if (expiredRow.startsWith(" muted")) throw new Error("expired mute");
D._applyIndex({ status: "ok", servers: [{ id: "100000000000000355", channels: [{ id: "100000000000000355", pinsForbidden: true }] }] });
const hiddenPins = D.page({ name: "messages", channel: "100000000000000355", query: new URLSearchParams("fixture=1") });
if (hiddenPins.includes("Pinned messages")) throw new Error("forbidden pins icon");
D._applyIndex({ status: "ok", servers: [] });
D._setServers([
  { id: "111111111111111111", name: "Alpha Guild", channels: [{ id: "111111111111111112", name: "alpha-room", mode: "messages" }] },
  { id: "222222222222222222", name: "Beta Guild", channels: [{ id: "222222222222222223", name: "beta-room", mode: "messages" }] }
]);
D._setPrefs({ expanded: {}, pinnedServers: ["222222222222222222"], pinnedChannels: [], mutedServers: [], mutedChannels: [] });
const ordered = D.page({ name: "messages", query: new URLSearchParams() });
if (ordered.indexOf("Beta Guild") < 0 || ordered.indexOf("Beta Guild") > ordered.indexOf("Alpha Guild")) throw new Error("pinned server order");
D._applyIndex({ status: "forbidden", detail: "raw secret body", servers: [] });
const paused = D.page({ name: "messages", query: new URLSearchParams() });
if (!paused.includes("Discord paused") || paused.includes("raw secret body")) throw new Error("paused");
D._applyIndex({ status: "ok", servers: [] });
const resumed = D.page({ name: "messages", query: new URLSearchParams() });
if (resumed.includes("Discord paused")) throw new Error("resumed");
"""],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    check(ui_check.returncode == 0, "discord messages escape text, validate ntfy, and render the fixture: " + (ui_check.stderr or ui_check.stdout))

    import discord_live

    live = discord_live.live_servers(json.loads(config_text))
    check(len(live) == 1 and live[0]["ntfy"] == "superintelmusic-discord-th-7f3a91c2" and len(live[0]["channels"]) == 19, "the live poller reads every Town Hall message channel")
    busy_ids = [item["id"] for item in live[0]["channels"] if item["busy"]]
    check(busy_ids == ["100000000000000355", "0100000000000000576", "100000000000000593"], "general-chat, discord-discussion, and peer-help are the busy channels")
    rotation = [{"id": "1", "busy": True}, {"id": "2", "busy": False}, {"id": "3", "busy": True}]
    first, cursor = discord_live.pick_due(rotation, {"1": 0, "2": 0, "3": 0}, 10, 0)
    second, cursor = discord_live.pick_due(rotation, {"1": 0, "2": 0, "3": 0}, 10, cursor)
    third, _cursor = discord_live.pick_due(rotation, {"1": 0, "2": 0, "3": 0}, 10, cursor)
    check([first["id"], second["id"], third["id"]] == ["1", "3", "1"], "due busy channels are preferred and rotate")

    class _Low:
        def uniform(self, low, _high):
            return low

    class _High:
        def uniform(self, _low, high):
            return high

    check(discord_live.next_gap(True, _Low()) == 10 and discord_live.next_gap(True, _High()) == 15, "busy channels wait 10 to 15 seconds")
    check(discord_live.next_gap(False, _Low()) == 120 and discord_live.next_gap(False, _High()) == 300, "quiet channels wait 2 to 5 minutes")
    secret = "super-secret-discord-token"
    fitted = discord_live.fit_ntfy({"v": 1, "ch": "9", "m": {"content": ("y" * 5000) + secret}})
    dumped = json.dumps(fitted, ensure_ascii=False, separators=(",", ":"))
    check(len(dumped.encode("utf-8")) <= 3800 and secret not in dumped and fitted["v"] == 1, "an ntfy body stays under 3800 bytes and drops a trailing token")
    sample = discord_live.ntfy_body(
        {"content": "**hi** <@9>"},
        {"id": "42", "text": "hi", "date": "2024-05-01T00:00:00.000Z", "attachments": [], "cards": [], "reactions": []},
        "99",
        "9",
        {"name": "Ada", "avatar": "https://cdn.discordapp.com/embed/avatars/0.png"},
        {},
    )
    check(sample["v"] == 1 and sample["ch"] == "99" and sample["m"]["content"] == "**hi** @user" and sample["m"]["author"]["name"] == "Ada", "the ntfy payload matches the Messages page")

    pace_calls = []
    pace_slept = []
    pace_clock = {"t": 0.0}

    def pace_sleep(seconds):
        pace_slept.append(seconds)
        pace_clock["t"] += seconds

    def pace_transport(url, headers):
        pace_calls.append(url)
        check(headers.get("Authorization") == "tok" and not str(headers.get("Authorization") or "").startswith("Bot "), "a live read sends the user token with no Bot prefix")
        if "/channels/50001/" in url:
            return 403, {}, b'{"message":"Missing Access","code":50001}'
        if "/channels/20016/" in url:
            return 403, {}, b'{"message":"This account is not allowed to use the API","code":20016}'
        return 200, {"X-RateLimit-Remaining": "5"}, json.dumps([
            {"id": "200000000000000001", "channel_id": "111", "type": 0, "content": "hello", "timestamp": "2024-05-01T18:00:00.000Z", "author": {"id": "9", "username": "ada", "global_name": "Ada"}},
        ]).encode()

    paced_live = Client("tok", auth="user", transport=pace_transport, sleep=pace_sleep, clock=lambda: pace_clock["t"], min_interval=1.5)
    paced_live.max_attempts = 4
    first_page, _gap = discord_live.page(paced_live, "111")
    second_page, _gap = discord_live.page(paced_live, "222")
    hidden_page, _gap = discord_live.page(paced_live, "50001")
    check(isinstance(first_page, list) and isinstance(second_page, list) and hidden_page is None, "a missing-access channel is skipped and the others are read")
    check(pace_slept == [1.5, 1.5] and any("limit=50" in url for url in pace_calls), "live pages request 50 messages and wait 1.5 seconds")
    try:
        discord_live.page(paced_live, "20016")
    except DiscordStop as exc:
        stopped_reason = exc.reason
    else:
        stopped_reason = ""
    check(stopped_reason == "forbidden", "a user-level 403 stops the live read")
    live_workflow = (ROOT / ".github" / "workflows" / "discord-live.yml").read_text(encoding="utf-8")
    live_script = (ROOT / "scripts" / "discord_live.py").read_text(encoding="utf-8")
    check("group: discord-live" in live_workflow and "cancel-in-progress: false" in live_workflow and "add-mask" in live_workflow and "timeout-minutes: 350" in live_workflow and 'cron: "23 */6 * * *"' in live_workflow, "the live workflow is one long job that does not cancel itself")
    old_site = "rss-" + "feeds"
    check("github.repository" in live_workflow and "SuperintelApp" not in live_workflow and old_site not in live_workflow and old_site not in live_script, "the live job follows the repository and no old feed URL")
    check("/pins" not in live_script, "the live poller does not read pins")
    check("viktorych-discord" in messages_ui and "dmsgs-skel" in messages_ui and "If-None-Match" in messages_ui and "/v1/data/" in messages_ui and 'loading="lazy"' in messages_ui and 'preload="none"' in messages_ui and "dmsgs-skel" in messages_css, "messages paint from IndexedDB, then a small page, with a skeleton and lazy media")
    worker_src = (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8")
    wrangler = (ROOT / "worker" / "wrangler.toml").read_text(encoding="utf-8")
    discord_fn = worker_src.split("async function maybeDispatchDiscord", 1)[1].split("async function ", 1)[0]
    check('crons = ["* * * * *"]' in wrangler and "discord-live.yml" in worker_src and "in_progress" in worker_src and "If-None-Match" in worker_src and "stale-while-revalidate=86400" in worker_src and "console" not in discord_fn, "the worker cron watches TikTok every minute and dispatches Discord only when idle while pages serve ETags")
    check("messages/" in live_script and "/p/" in live_script and "def r2_put" in live_script and "def restore_from" in live_script and "upload_discord" in live_script, "live history is paged and stored in R2")
    saved_token = os.environ.pop("CLOUDFLARE_API_TOKEN", None)
    try:
        check(discord_live.r2_put("discord/index.json", b"{}") is False, "R2 upload does nothing without the Cloudflare token")
    finally:
        if saved_token is not None:
            os.environ["CLOUDFLARE_API_TOKEN"] = saved_token
    page_board = discord_live.Board()
    page_server = {"id": "1", "name": "Hall", "channels": [{"id": "42", "name": "general"}]}
    for index in range(120):
        mid = str(1_000_000_000_000_000_000 + index)
        page_board.add("42", {"id": mid, "author": "9", "text": "m" + str(index), "date": "2024-01-01T00:00:00.000Z"}, "9", {"name": "Ada"})
    with tempfile.TemporaryDirectory() as tmp:
        page_root = Path(tmp)
        discord_live.write_tree(page_root, page_server, page_board, "", None, "", "ok", "", "super-secret-discord-token")
        hot = json.loads((page_root / "discord" / "messages" / "42.json").read_text(encoding="utf-8"))
        older = json.loads((page_root / "discord" / "messages" / "42" / "p" / "1.json").read_text(encoding="utf-8"))
        tail = json.loads((page_root / "discord" / "messages" / "42" / "p" / "2.json").read_text(encoding="utf-8"))
        dumped = (page_root / "discord" / "messages" / "42.json").read_text(encoding="utf-8")
        check(len(hot["messages"]) == 50 and hot["older"] is True and len(older["messages"]) == 50 and older["older"] is True and len(tail["messages"]) == 20 and tail["older"] is False, "a channel publishes the newest 50 and older pages of 50")
        check(int(hot["messages"][0]["id"]) > int(older["messages"][0]["id"]) > int(tail["messages"][0]["id"]) and "super-secret-discord-token" not in dumped, "pages stay newest-first and never contain the token")
        again = discord_live.Board()
        again.load_dir(page_root)
        check(len(again.rows("42")) == 120 and again.cursor["42"] == hot["messages"][0]["id"], "a restart reads the hot page and the older pages")
        empty = Path(tmp) / "restored"
        store = {
            "discord/index.json": json.loads((page_root / "discord" / "index.json").read_text(encoding="utf-8")),
            "discord/state.json": json.loads((page_root / "discord" / "state.json").read_text(encoding="utf-8")),
            "discord/messages/42.json": hot,
            "discord/messages/42/p/1.json": older,
            "discord/messages/42/p/2.json": tail,
        }
        discord_live.restore_from(empty, "", store.get)
        restored = discord_live.Board()
        restored.load_dir(empty)
        check(len(restored.rows("42")) == 120, "a missing Pages copy is restored from R2 pages")
    discord_picks_checks(discord_live)


def discord_picks_checks(discord_live) -> None:
    import discord_picks
    from adapters.discord import user_get_allowed

    g1, g2, g3 = "100000000000000001", "100000000000000002", "100000000000000003"
    check(user_get_allowed("https://discord.com/api/v10/users/@me/guilds") and user_get_allowed("https://discord.com/api/v10/guilds/%s/channels" % g1), "the picker may list the account's servers and their channels")
    check(not user_get_allowed("https://discord.com/api/v10/invites/abc") and not user_get_allowed("https://discord.com/api/v10/users/@me/channels"), "the GET list still leaves out invites and DMs")
    raw = [
        {"id": "300000000000000001", "type": 4, "name": "Info", "position": 0},
        {"id": "300000000000000002", "type": 4, "name": "Talk", "position": 1},
        {"id": "300000000000000010", "type": 0, "name": "chat", "parent_id": "300000000000000002", "position": 0},
        {"id": "300000000000000011", "type": 5, "name": "news", "parent_id": "300000000000000001", "position": 1},
        {"id": "300000000000000012", "type": 2, "name": "voice", "position": 0},
    ]
    rows = discord_picks.guild_channels(raw)
    check([row["name"] for row in rows] == ["news", "chat"] and rows[0]["kind"] == "announcement" and rows[0]["category"] == "Info", "the picker lists text and announcement channels in sidebar order")
    picks = {"servers": [{"id": g1, "name": "One", "channels": [{"id": "300000000000000010", "name": "chat"}]}, {"id": g2, "name": "Main", "channels": [{"id": "300000000000000011"}]}]}
    found = discord_picks.picked_servers(picks, [g2])
    check([s["id"] for s in found] == [g1] and found[0]["ntfy"] == "" and found[0]["channels"][0]["private"] is True, "picked servers skip the configured one and never use ntfy")
    check(discord_picks.catalog_task(None, None) == ("full", "") and discord_picks.catalog_task({"servers": [], "fetchedAt": "2026-01-02"}, {"requestedAt": "2026-01-01"}) == ("", "") and discord_picks.catalog_task({"servers": [], "fetchedAt": "2026-01-01"}, {"requestedAt": "2026-01-02", "guild": g3}) == ("guild", g3), "the catalog is listed when missing or when the owner asks")

    class FakeClient:
        def __init__(self):
            self.calls = []

        def get_json(self, path, params=None):
            self.calls.append(path)
            if path == "/users/@me/guilds":
                return [{"id": g1, "name": "One"}, {"id": g3, "name": "Three", "icon": "abc"}]
            return raw

    fake = FakeClient()
    old = {"servers": [{"id": g1, "name": "One", "channels": [{"id": "300000000000000010", "name": "chat"}]}, {"id": g2, "name": "Gone", "channels": []}]}
    doc = discord_picks.build_catalog(fake, "2026-01-03", old=old, want=g3)
    check([s["id"] for s in doc["servers"]] == [g1, g3] and fake.calls == ["/users/@me/guilds", f"/guilds/{g3}/channels"] and doc["servers"][1]["icon"].startswith("https://cdn.discordapp.com/icons/"), "a fresh join lists only the new server again")
    check(discord_picks.join_invite("t", "abc", lambda url, headers: (200, b'{"guild":{"id":"%s"}}' % g3.encode())) == ("joined", g3), "a join returns the server")
    check(discord_picks.join_invite("t", "abc", lambda url, headers: (400, b'{"captcha_key":["captcha-required"],"captcha_sitekey":"x"}'))[0] == "captcha", "a captcha answer is reported, not solved")
    check(discord_picks.join_invite("t", "abc", lambda url, headers: (403, b'{"code":40002}'))[0] == "verification", "a verification answer is reported")
    check(discord_picks.join_invite("t", "bad code!", lambda url, headers: (200, b"{}"))[0] == "invalid", "a bad code is never sent")
    sent = []
    seen_urls = []

    def transport(url, headers):
        seen_urls.append(url)
        return 200, b'{"guild":{"id":"%s"}}' % g3.encode()

    store = {"discord/x/request.json": {"requestedAt": "2026-01-02", "guild": g3, "join": {"code": "abc", "id": "abcdefgh1234", "guild": g3}}}

    def put(key, payload):
        sent.append(key)
        store[key] = json.loads(payload.decode("utf-8"))
        return True

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        picker = discord_live.Picks(root, "secret-token-value", [g2], store.get, put)
        picker.join_transport = transport
        picker.join(store["discord/x/request.json"])
        picker.join(store["discord/x/request.json"])
        check(len(seen_urls) == 1 and seen_urls[0].endswith("/invites/abc") and store["discord/x/join.json"]["status"] == "joined", "one confirmed join is sent once")
        cap_seen = []

        def cap_transport(url, headers):
            cap_seen.append(dict(headers))
            if headers.get("X-Captcha-Key"):
                return 200, b'{"guild":{"id":"%s"}}' % g3.encode()
            return 400, b'{"captcha_key":["captcha-required"],"captcha_sitekey":"site-key-1","captcha_service":"hcaptcha","captcha_rqdata":"rq-data","captcha_rqtoken":"rq-token","captcha_session_id":"sess-1"}'

        picker.join_transport = cap_transport
        ask2 = {"requestedAt": "2026-01-03", "guild": g3, "join": {"code": "abc", "id": "abcdefgh5678", "guild": g3}}
        picker.join(ask2)
        cap_doc = store.get("discord/x/captcha.json") or {}
        check(store["discord/x/join.json"]["status"] == "needs_captcha" and cap_doc.get("sitekey") == "site-key-1" and cap_doc.get("rqtoken") == "rq-token" and "secret-token-value" not in json.dumps(cap_doc), "a captcha is saved privately for the owner, never solved")
        ask3 = {"requestedAt": "2026-01-03", "guild": g3, "join": {"code": "abc", "id": "abcdefgh5678", "guild": g3, "captcha": {"sid": "solution0001", "key": "owner-answer", "rqtoken": "rq-token", "session": "sess-1"}}}
        picker.join(ask3)
        picker.join(ask3)
        check(len(cap_seen) == 2 and cap_seen[1].get("X-Captcha-Key") == "owner-answer" and cap_seen[1].get("X-Captcha-Rqtoken") == "rq-token" and store["discord/x/join.json"]["status"] == "joined", "the owner's own answer is sent once with Discord's captcha headers")
        picker.join({"requestedAt": "2026-01-04", "guild": g3, "join": {"code": "abc", "id": "abcdefgh9999", "guild": g3, "by": "worker"}})
        check(len(cap_seen) == 2, "a join the Worker already sent is not sent again")
        check(discord_picks.key_check_due({}, "2026-01-05T00:00:00Z") and not discord_picks.key_check_due({"checkedAt": "2026-01-05T08:00:00Z"}, "2026-01-05T23:00:00Z"), "the key check runs once a day")
        me_calls = []

        class FakeMe:
            token = "secret-token-value"

            def key_check(self):
                me_calls.append("/users/@me")
                return {"id": "1"}

        wrote = []
        real_write = discord_live.write_health
        discord_live.write_health = lambda status, reason, token, checked=None: wrote.append((status, checked))
        try:
            discord_live.daily_key_check(FakeMe(), {"checkedAt": "2026-01-04T00:00:00Z"}, "2026-01-05T00:00:00Z")
            discord_live.daily_key_check(FakeMe(), {"checkedAt": "2026-01-05T00:00:00Z"}, "2026-01-05T09:00:00Z")
        finally:
            discord_live.write_health = real_write
        check(me_calls == ["/users/@me"] and wrote == [("ok", "2026-01-05T00:00:00Z")], "one light /users/@me read a day, recorded without ids")
        from adapters.discord import Client as _DClient, user_get_allowed as _uga
        seen_urls = []
        probe = _DClient("t", transport=lambda url, headers: (seen_urls.append(url) or (200, {}, b"{}")), sleep=lambda s: None, auth="user", min_interval=0)
        check(probe.get_json("/users/@me") is None and probe.key_check() == {} and probe.get_json("/users/@me") is None and len(seen_urls) == 1 and not _uga("https://discord.com/api/v10/users/@me"), "/users/@me is read only by the daily key check")
        capped = _DClient("t", transport=lambda url, headers: (200, {}, b"[]"), sleep=lambda s: None, auth="user", min_interval=0)
        capped.max_requests = 3
        got = [capped.get_json("/users/@me/guilds") for _ in range(5)]
        check(capped.requests == 3 and capped.capped and got[3] is None, "user reads stop at the per-run cap")
        picker.join_transport = transport
        store["discord/x/picks.json"] = picks
        added = picker.reload()
        check(added == {"300000000000000010"}, "a new pick is polled right away")
        board = discord_live.Board()
        board.add("300000000000000010", {"id": "400000000000000001", "author": "9", "text": "hi", "date": "2026-01-01T00:00:00.000Z"}, "9", {"name": "Ada"})
        picker.write(board)
        sent.clear()
        picker.upload()
        picker.upload()
        check(not (root / "discord").exists() and all(key.startswith("discord/x/") for key in sent) and sent[-1] == "discord/x/index.json" and len(sent) == 2, "picked servers go only to the private bucket and unchanged files are not sent again")
        bad = discord_picks.health_doc("invalid", "unauthorized", "secret-token-value", "2026-01-01T00:00:00Z")
        check(discord_picks.key_blocked(bad, "secret-token-value") and not discord_picks.key_blocked(bad, "other-token") and "secret" not in json.dumps(bad), "an invalid key is blocked by fingerprint until a new key is pasted")
        index = store["discord/x/index.json"]
        check(index["servers"][0]["channels"][0]["file"] == "discord/x/messages/300000000000000010.json" and index["servers"][0]["channels"][0]["last"] == "400000000000000001" and "secret-token-value" not in json.dumps(store), "the private index points at private files and never holds the token")


def ia_backup_checks() -> None:
    import hashlib
    import re
    import subprocess
    import threading
    import urllib.parse
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    import ia_backup

    os.environ["IA_UPLOADS_ENABLED"] = "true"
    source = (ROOT / "scripts" / "ia_backup.py").read_text(encoding="utf-8")
    workflow = (ROOT / ".github" / "workflows" / "ia-backup.yml").read_text(encoding="utf-8")
    sync = (ROOT / ".github" / "workflows" / "sync.yml").read_text(encoding="utf-8")
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    old_site = "rss-" + "feeds"
    check(old_site not in source and old_site not in workflow, "the new backup does not hard-code the old site path")
    check("token_hex" in source and "x-archive-meta-noindex" in source and "Authorization" in source and "LOW" in source, "backup items are random, unlisted, and use LOW auth")
    check("group: ia-backup" in workflow and "workflow_dispatch" in workflow and "schedule:" not in workflow and 'cron: "47 7 * * *"' not in workflow and 'IA_UPLOADS_ENABLED: "false"' in workflow, "the backup workflow is manual, unscheduled, and uploads are off")
    check("group: pages" not in workflow and "echo \"$IA_" not in workflow and "echo $IA_" not in workflow, "the backup workflow does not take the pages lock or print the keys")
    check("ia-manifest.json" not in sync and "git push --force" not in sync and "archive stubs stay in R2" in sync, "the daily job leaves archive stubs in private storage")
    snap = (ROOT / "scripts" / "pull_snapshot.py").read_text(encoding="utf-8")
    sidecar = snap[snap.index("def pull_ia_sidecars"):]
    check(sidecar.index('("data", DATA_ARCHIVE)') < sidecar.index('("pages", SITE)'), "the media manifest is taken from the data branch before the live site")
    check('new URL("archive/"' in app and "function installIaManifest(" in app and "archive.org/download/superintelapp-" not in app and "superintelapp-manifest" not in app and "cors.archive.org/cors/" in app and "function applyIaPreview(" in app and "IA.shards" in app, "the page loads archive media from a relative manifest and archive.org")
    preview = app[app.index("function applyIaPreview("):app.index("function applyIaPreview(") + 700]
    check("127.0.0.1" in preview and "localhost" in preview and "ia-deleted" in preview, "the deleted-post preview stays on localhost")
    check(ia_backup.public_media_url("https://pbs.twimg.com/media/abc.jpg"), "public X images are eligible")
    check(not ia_backup.public_media_url("https://cdn.discordapp.com/attachments/1/a.png"), "Discord files are not eligible")
    check(not ia_backup.public_media_url("https://pub-bf9b5e3ebb2b421aa49e7af484f3c22d.r2.dev/loop/v1/seg_0000.m4s") and not ia_backup.public_media_url("https://pub-bf9b5e3ebb2b421aa49e7af484f3c22d.r2.dev/loop/v1/seg_0000.ts") and not ia_backup.public_media_url("https://pub-bf9b5e3ebb2b421aa49e7af484f3c22d.r2.dev/loop/v1/index.m3u8"), "radio audio is not eligible for the Internet Archive")
    check(not ia_backup.public_media_url("https://www.youtube-nocookie.com/embed/abcdefghijk"), "embed pages are not eligible")
    check(ia_backup.archive_download_url("superintelapp-img-2026-10", "abc.jpg") == "https://archive.org/download/superintelapp-img-2026-10/abc.jpg", "download URLs use the archive.org download host")
    check(ia_backup.archive_cors_url("superintelapp-img-2026-10", "abc.jpg") == "https://cors.archive.org/cors/superintelapp-img-2026-10/abc.jpg", "playback can fall back to the CORS host")

    env = os.environ.copy()
    env.pop("IA_ACCESS_KEY", None)
    env["IA_SECRET_KEY"] = "sentinel-secret-value"
    skipped = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "ia_backup.py")],
        capture_output=True,
        text=True,
        env=env,
        check=False,
        cwd=ROOT,
    )
    skipped_out = skipped.stdout + skipped.stderr
    check(skipped.returncode == 0 and "not set" in skipped.stdout and "Nothing was uploaded" in skipped.stdout, "missing backup keys skip the run")
    check("sentinel-secret-value" not in skipped_out, "the backup skip path does not print a secret")
    check(ia_backup.uploads_enabled() is True, "the literal true is the only value that enables uploads")
    os.environ["IA_UPLOADS_ENABLED"] = "false"
    check(ia_backup.uploads_enabled() is False, "false does not enable uploads")
    os.environ.pop("IA_UPLOADS_ENABLED", None)
    check(ia_backup.uploads_enabled() is False, "uploads are off when the switch is unset")
    blocked = os.environ.copy()
    blocked.pop("IA_UPLOADS_ENABLED", None)
    blocked["IA_ACCESS_KEY"] = "sentinel-access-value"
    blocked["IA_SECRET_KEY"] = "sentinel-secret-value"
    for script, args, needle in (
        ("ia_backup.py", [], "Nothing was uploaded"),
        ("ia_archive.py", [], "skipping the upload"),
        ("ia_retire.py", ["copy"], "Nothing was copied"),
        ("ia_retire.py", ["delete"], "Nothing was copied"),
    ):
        stopped = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / script), *args],
            capture_output=True,
            text=True,
            env=blocked,
            check=False,
            cwd=ROOT,
        )
        stopped_out = stopped.stdout + stopped.stderr
        check(stopped.returncode == 0 and needle in stopped.stdout, script + " exits before an upload when the keys exist and the switch is off")
        check("sentinel-access-value" not in stopped_out and "sentinel-secret-value" not in stopped_out, script + " does not print the keys when uploads are off")
    os.environ["IA_UPLOADS_ENABLED"] = "true"

    jpeg = b"\xff\xd8\xff\xd9"
    calls = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, fmt, *args):
            return

        def do_GET(self):
            calls.append(("GET", self.path, self.headers.get("Authorization")))
            name = self.path.rsplit("/", 1)[-1]
            if name == "blocked.jpg":
                self.send_response(403)
                self.end_headers()
                return
            if name == "page.html":
                body = b"<html>login</html>"
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if name in {"a.jpg", "b.jpg"}:
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(jpeg)))
                self.end_headers()
                self.wfile.write(jpeg)
                return
            self.send_response(404)
            self.end_headers()

        def do_PUT(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length)
            decision = "ok"
            if self.headers.get("Content-Type") == "image/jpeg":
                seen = sum(1 for row in calls if row[0] == "PUT" and len(row) > 7 and row[7] == "image/jpeg")
                if seen == 0:
                    decision = "slowdown"
                elif self.headers.get("x-archive-meta-collection"):
                    decision = "collection"
            calls.append((
                "PUT",
                self.path,
                self.headers.get("Authorization"),
                self.headers.get("x-archive-meta-mediatype"),
                self.headers.get("x-archive-meta-collection"),
                decision,
                body,
                self.headers.get("Content-Type"),
                self.headers.get("x-archive-meta-noindex"),
                self.headers.get("x-archive-meta-title"),
                self.headers.get("x-archive-meta-description"),
                self.headers.get("x-archive-meta-creator"),
                self.headers.get("x-archive-meta-subject"),
            ))
            if decision == "slowdown":
                payload = b"<Error><Code>SlowDown</Code></Error>"
                self.send_response(503)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if decision == "collection":
                payload = b"collection is not allowed"
                self.send_response(400)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = "http://127.0.0.1:%d" % server.server_address[1]
    sleeps = []
    try:
        result = ia_backup.run_backup(
            {
                "access": "test-access",
                "secret": "test-secret-value",
                "endpoint": base,
                "download_base": "https://archive.org/download",
                "pace": 0,
                "backoff": 0.01,
                "max_uploads": 10,
                "max_bytes": 100000,
                "allow_hosts": ("127.0.0.1",),
                "allow_http": True,
            },
            [
                {
                    "platform": "x",
                    "id": "20",
                    "adapter": "fxtwitter",
                    "handle": "ada",
                    "date": "2026-10-12T00:00:00Z",
                    "text": "public",
                    "avatar": base + "/files/a.jpg",
                    "media": [{"type": "photo", "url": base + "/files/b.jpg"}],
                },
                {
                    "platform": "discord",
                    "id": "discord:1:2",
                    "date": "2026-10-12T00:00:00Z",
                    "text": "discord secret words",
                    "avatar": base + "/files/discord.jpg",
                    "media": [{"type": "photo", "url": base + "/files/discord.jpg"}],
                },
                {
                    "platform": "x",
                    "id": "21",
                    "date": "2026-10-03T00:00:00Z",
                    "media": [{"type": "photo", "url": base + "/files/page.html"}, {"type": "photo", "url": base + "/files/blocked.jpg"}],
                },
            ],
            {"2026-10": [
                {"p": "x", "id": "20", "s": "fxtwitter", "h": "ada", "d": "2026-10-12T00:00:00Z", "t": "public"},
                {"p": "discord", "id": "abc", "t": "discord secret words"},
                {"p": "tiktok", "id": "1", "h": "lockclip", "t": "not public"},
                {"p": "vk", "id": "2", "t": "token wall"},
            ]},
            sleep=lambda delay: sleeps.append(delay),
        )
    finally:
        server.shutdown()
    puts = [row for row in calls if row[0] == "PUT"]
    gets = [row for row in calls if row[0] == "GET"]
    joined = " ".join(result["notes"])
    bodies = b"\n".join(row[6] for row in puts)
    check(all(row[2] == "LOW test-access:test-secret-value" for row in puts), "uploads send the LOW authorization header")
    check("test-secret-value" not in joined and "test-access" not in joined, "upload notes do not print the keys")
    check(not any(path.endswith("/discord.jpg") for _method, path, _auth in gets), "Discord media is not downloaded")
    check(b"discord secret words" not in bodies and b"not public" not in bodies and b"token wall" not in bodies, "Discord, TikTok, and VK text are not uploaded")
    ia_policy = ia_backup.load_ia_policy()
    widened = ia_backup.load_ia_policy({"public_sources": ["discord", "fxtwitter", "vk"], "tiktok_allow": ["lockclip"]})
    check("lockclip" not in ia_policy["tiktok"] and ia_policy["tiktok"] == set() and "vk" not in ia_policy["sources"] and "nitter_rss" not in ia_policy["sources"] and "discord" not in ia_policy["sources"], "the TikTok allowlist is empty and token or cookie sources are not public")
    check("discord" not in widened["sources"] and "vk" not in widened["sources"] and "fxtwitter" in widened["sources"] and "lockclip" in widened["tiktok"], "config cannot add a source the code has not audited")
    check(ia_backup.ia_source_for_post({"platform": "tiktok", "handle": "lockclip"}, ia_policy) == "", "lockclip is not an allowlisted TikTok handle")
    check(ia_backup.ia_source_for_post({"platform": "x"}, ia_policy) == "", "an X post with no recorded source is denied")
    check(ia_backup.ia_source_for_post({"platform": "youtube", "feedId": "youtube:northlamp"}, ia_policy) == "youtube_rss", "a YouTube feed with only a public source is allowed")
    check(not ia_backup.ia_url_ok("https://pub-example.r2.dev/music/song/cover.png", "youtube_rss") and not ia_backup.ia_url_ok("https://pub-example.r2.dev/loop/current.json", "telegram"), "music covers and radio audio are denied")
    hidden_name = re.compile(r"/x[0-9a-f]{32}/[0-9a-f]{20}\.")
    check(puts and all(hidden_name.search(row[1]) for row in puts), "item and file names are unguessable")
    check(all(row[3] == "data" and row[8] == "true" and row[9] == "files" and row[10] == "files" and not row[4] and not row[11] and not row[12] for row in puts), "uploads are unlisted data with a generic title and no owner tag")
    check(not any("superintelapp" in row[1] or row[1].endswith("/2026-10.json") for row in puts), "uploads do not use the old item or month names")
    img = [row for row in puts if row[7] == "image/jpeg"]
    check([row[5] for row in img] == ["slowdown", "ok"], "image uploads back off on SlowDown and then succeed")
    check(any(delay >= 0.01 for delay in sleeps), "SlowDown waits before the next attempt")
    check(img[-1][4] is None and img[-1][6] == jpeg, "the retried image upload has no collection and the file bytes")
    manifest = result["manifest"]
    saved = manifest["files"]
    check("x:20" in manifest["posts"] and len(manifest["posts"]["x:20"]) == 2, "the manifest maps the post to its avatar and photo")
    check(all(re.match(r"https://archive.org/download/x[0-9a-f]{32}/[0-9a-f]{20}\.jpg$", item["a"]) for item in saved), "manifest URLs are archive.org download links")
    check(manifest["items"].get("stub:2026-10") and ia_backup.valid_item_id(manifest["items"]["stub:2026-10"]) and manifest["shards"]["2026-10"].endswith(".json"), "the manifest maps the month to a random item")
    check(len({item["a"] for item in saved}) == 1, "identical bytes are stored once")
    check(result["failures"] == 0, "the mocked backup finishes the files it attempted")

    def refuse(*_args, **_kwargs):
        raise AssertionError("second run tried the network")

    again = ia_backup.run_backup(
        {
            "access": "test-access",
            "secret": "test-secret-value",
            "endpoint": base,
            "pace": 0,
            "backoff": 0,
            "max_uploads": 10,
            "allow_hosts": ("127.0.0.1",),
            "allow_http": True,
            "opener": type("Opener", (), {"open": staticmethod(refuse)})(),
        },
        [{
            "platform": "x",
            "id": "20",
            "handle": "ada",
            "date": "2026-10-12T00:00:00Z",
            "text": "public",
            "avatar": base + "/files/a.jpg",
            "media": [{"type": "photo", "url": base + "/files/b.jpg"}],
        }],
        {"2026-10": [
            {"p": "x", "id": "20", "h": "ada", "d": "2026-10-12T00:00:00Z", "t": "public"},
            {"p": "discord", "id": "abc", "t": "discord secret words"},
        ]},
        result["state"],
        sleep=lambda delay: None,
    )
    check(again["manifest"]["posts"]["x:20"] == manifest["posts"]["x:20"], "a second run keeps the manifest and does not upload again")
    check(again["manifest"]["items"] == manifest["items"], "a second run keeps the same random item ids")

    jpeg_old = b"\xff\xd8\xff\xd9"
    old_digest = hashlib.sha256(jpeg_old).hexdigest()
    old_name = old_digest[:20] + ".jpg"
    saved_files = {}
    deleted = []
    patches = []

    class Resp:
        def __init__(self, status, body):
            self.status = status
            self._body = body

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def migrate_open(request, timeout=None):
        method = request.get_method()
        url = request.full_url
        path = urllib.parse.urlparse(url).path
        if method == "PUT":
            length = int(request.headers.get("Content-Length") or 0)
            saved_files[path] = request.data
            return Resp(200, b"")
        if method == "DELETE":
            deleted.append(path)
            return Resp(204, b"")
        if method == "POST":
            patches.append(request.data.decode("utf-8"))
            return Resp(200, b'{"success":true}')
        if path == "/metadata/superintelapp-img-2026-10":
            body = json.dumps({
                "metadata": {"identifier": "superintelapp-img-2026-10", "title": "superintelapp-img-2026-10", "creator": "riverquoll", "description": "Public backup", "collection": "opensource_media"},
                "files": [{"name": old_name}, {"name": "superintelapp-img-2026-10_meta.xml"}],
            }).encode()
            return Resp(200, body)
        if path == "/download/superintelapp-img-2026-10/" + old_name:
            return Resp(200, jpeg_old)
        if path.startswith("/download/x") and path.endswith("/" + old_name):
            item = path.split("/")[2]
            stored = saved_files.get("/" + item + "/" + old_name)
            if stored == jpeg_old:
                return Resp(200, stored)
            return Resp(404, b"")
        if path == "/archive/ia-manifest.json":
            return Resp(200, json.dumps({"v": 1, "items": {}}).encode())
        if path.startswith("/metadata/x"):
            return Resp(200, json.dumps({"metadata": {}, "files": []}).encode())
        return Resp(404, b"")

    migrated_state = {
        "v": 1,
        "shards": {},
        "byHash": {old_digest: {"a": "https://archive.org/download/superintelapp-img-2026-10/" + old_name, "k": "photo"}},
        "byUrl": {"https://cdn.example/a.jpg": old_digest},
        "posts": {"x:7": [{"u": "https://cdn.example/a.jpg", "k": "photo"}]},
    }
    host = "http://127.0.0.1"
    moved = ia_backup.migrate_copies(
        {
            "access": "test-access",
            "secret": "test-secret-value",
            "endpoint": host,
            "download_base": host + "/download",
            "metadata_base": host + "/metadata",
            "old_items": ["superintelapp-img-2026-10"],
            "pace": 0,
            "backoff": 0,
            "urlopen": migrate_open,
            "opener": type("Opener", (), {"open": staticmethod(migrate_open)})(),
        },
        migrated_state,
        sleep=lambda delay: None,
    )
    new_url = migrated_state["byHash"][old_digest]["a"]
    check(moved["failures"] == 0 and ia_backup.valid_item_id(new_url.split("/")[4]) and new_url.endswith("/" + old_name), "an old file is copied onto a random item and checked")
    check("test-secret-value" not in " ".join(moved["notes"]), "copy notes do not print the keys")
    kept = ia_backup.retire_old(
        {
            "access": "test-access",
            "secret": "test-secret-value",
            "endpoint": host,
            "metadata_base": host + "/metadata",
            "pages_origin": host,
            "old_items": ["superintelapp-img-2026-10"],
            "pace": 0,
            "urlopen": migrate_open,
            "opener": type("Opener", (), {"open": staticmethod(migrate_open)})(),
        },
        migrated_state,
        sleep=lambda delay: None,
    )
    check(kept["deleted"] == 0 and not deleted, "old files stay until the site manifest uses the new copies")

    def live_open(request, timeout=None):
        path = urllib.parse.urlparse(request.full_url).path
        if path == "/archive/ia-manifest.json":
            return Resp(200, json.dumps({
                "v": 1,
                "items": migrated_state["items"],
                "files": [{"u": "https://cdn.example/a.jpg", "a": migrated_state["byHash"][old_digest]["a"], "k": "photo"}],
                "shards": {},
            }).encode())
        return migrate_open(request, timeout)

    retired = ia_backup.retire_old(
        {
            "access": "test-access",
            "secret": "test-secret-value",
            "endpoint": host,
            "metadata_base": host + "/metadata",
            "pages_origin": host,
            "old_items": ["superintelapp-img-2026-10"],
            "pace": 0,
            "urlopen": live_open,
            "opener": type("Opener", (), {"open": staticmethod(live_open)})(),
        },
        migrated_state,
        sleep=lambda delay: None,
    )
    check(retired["deleted"] >= 1 and any(path.endswith("/" + old_name) for path in deleted), "old files are deleted only after the new copy and the site manifest check out")
    check("noindex" in " ".join(patches) and "title" in " ".join(patches), "retired items are marked noindex and lose their title")
    check(not any("test-secret-value" in patch or "test-secret-value" in " ".join(retired["notes"]) for patch in patches), "metadata writes do not print the keys")

    probe_meta = {"title": "superintelapp-img-2026-10", "description": "Public backup", "creator": "riverquoll"}
    probe_puts = []
    probe_deletes = []

    def hide_open(request, timeout=None):
        method = request.get_method()
        path = urllib.parse.urlparse(request.full_url).path
        if method == "PUT":
            header_map = {key.lower(): value for key, value in request.header_items()}
            probe_puts.append((
                path,
                header_map.get("x-archive-meta-noindex"),
                header_map.get("authorization"),
                header_map.get("x-archive-meta-title"),
            ))
            probe_meta["noindex"] = "true"
            return Resp(200, b"")
        if method == "DELETE":
            probe_deletes.append(path)
            return Resp(204, b"")
        if method == "POST":
            body = request.data.decode("utf-8")
            if "noindex" in body:
                return Resp(400, b'{"success":false,"error":"Can\'t modify read-only field \'noindex\'"}')
            return Resp(200, b'{"success":true}')
        if path.endswith("/superintelapp-img-2026-10"):
            return Resp(200, json.dumps({"metadata": dict(probe_meta), "files": [{"name": "a.jpg"}]}).encode())
        return Resp(404, b"")

    hidden_state = {"v": 1}
    hidden = ia_backup.hide_old_items(
        {
            "access": "test-access",
            "secret": "test-secret-value",
            "endpoint": host,
            "metadata_base": host + "/metadata",
            "old_items": ["superintelapp-img-2026-10"],
            "urlopen": hide_open,
            "opener": type("Opener", (), {"open": staticmethod(hide_open)})(),
        },
        hidden_state,
        sleep=lambda delay: None,
    )
    probe = ia_backup._probe_name("superintelapp-img-2026-10")
    check(hidden["failures"] == 0 and any("hid superintelapp-img-2026-10" in line for line in hidden["notes"]), "an existing item gets noindex from the s3 header when the metadata write is rejected")
    check(probe_puts and probe_puts[0][1] == "true" and probe_puts[0][2] == "LOW test-access:test-secret-value" and probe_puts[0][3] is None and probe_puts[0][0].endswith("/" + probe), "the noindex header is sent on a hashed file without a title")
    check(probe_deletes == ["/" + "superintelapp-img-2026-10" + "/" + probe], "the noindex probe file is removed after the flag sticks")
    check("test-secret-value" not in " ".join(hidden["notes"]), "hide notes do not print the keys")

    refused_meta = {"title": "superintelapp-img-2026-10"}
    refused_puts = []

    def refuse_open(request, timeout=None):
        method = request.get_method()
        path = urllib.parse.urlparse(request.full_url).path
        if method == "PUT":
            refused_puts.append(path)
            return Resp(200, b"")
        if method == "DELETE":
            return Resp(204, b"")
        if method == "POST":
            body = request.data.decode("utf-8")
            if "noindex" in body:
                return Resp(400, b'{"success":false,"error":"Can\'t modify read-only field \'noindex\'"}')
            return Resp(200, b'{"success":true}')
        if path.endswith("/superintelapp-img-2026-10"):
            return Resp(200, json.dumps({"metadata": dict(refused_meta), "files": [{"name": "a.jpg"}]}).encode())
        return Resp(404, b"")

    refused_state = {"v": 1}
    refused_config = {
        "access": "test-access",
        "secret": "test-secret-value",
        "endpoint": host,
        "metadata_base": host + "/metadata",
        "old_items": ["superintelapp-img-2026-10"],
        "urlopen": refuse_open,
        "opener": type("Opener", (), {"open": staticmethod(refuse_open)})(),
    }
    first_refuse = ia_backup.hide_old_items(refused_config, refused_state, sleep=lambda delay: None)
    still_open = not refused_state.get("noindexBlocked")
    second_refuse = ia_backup.hide_old_items(refused_config, refused_state, sleep=lambda delay: None)
    puts_after_lock = len(refused_puts)
    third_refuse = ia_backup.hide_old_items(refused_config, refused_state, sleep=lambda delay: None)
    check(first_refuse["failures"] == 1 and still_open, "one rejected s3 header is retried later")
    check(second_refuse["failures"] == 1 and refused_state["noindexBlocked"].get("superintelapp-img-2026-10") == "readonly", "a second rejection records that noindex is read-only")
    check(len(refused_puts) == puts_after_lock and any("stays listed" in line for line in third_refuse["notes"]), "later runs do not upload another probe once noindex is known read-only")

    import ia_retire
    from pull_snapshot import shard_url

    archive_src = (ROOT / "scripts" / "ia_archive.py").read_text(encoding="utf-8")
    retire_wf = (ROOT / ".github" / "workflows" / "ia-retire.yml").read_text(encoding="utf-8")
    snap = (ROOT / "scripts" / "pull_snapshot.py").read_text(encoding="utf-8")
    check("feeds-archive" not in archive_src and "Viktorych" not in archive_src and "creator" not in archive_src and "opensource" not in archive_src and "internetarchive" not in archive_src and "run_backup" in archive_src, "shard uploads use the anonymous backup items")
    check("internetarchive" not in sync and "ia_archive.py" not in sync and "r2_usage.py" in sync and "git push --force" not in sync and 'echo "$CLOUDFLARE' not in sync and "echo $CLOUDFLARE" not in sync, "the daily job checks R2 and does not publish archive stubs or call archive.org")
    check("workflow_dispatch" in retire_wf and "schedule:" not in retire_wf and "cron:" not in retire_wf and "push:" not in retire_wf and "ia-retire.once" not in retire_wf and 'echo "$IA_' not in retire_wf and "echo $IA_" not in retire_wf and "IA_ACCESS_KEY" in retire_wf and "IA_SECRET_KEY" in retire_wf and "ia_retire.py copy" in retire_wf and "ia_retire.py delete" in retire_wf and 'git checkout -f "$head"' in retire_wf and retire_wf.count("if: false") >= 4, "the retire workflow is manual, its write steps do not run, and it does not print the keys")
    check(retire_wf.index('git checkout --force "$GITHUB_SHA"') < retire_wf.index("ia_retire.py delete"), "delete runs from this commit after the data branch publish")
    import r2_usage
    check(r2_usage.kept_copy("video", 20 * 1024 * 1024) == "source", "a big video stays on the source URL")
    check(r2_usage.kept_copy("photo", 80 * 1024) == "r2", "a small photo may stay on R2")
    check(r2_usage.should_warn(8 * 1024 ** 3 - 1) is False and r2_usage.should_warn(8 * 1024 ** 3) is True, "R2 warns at 8 GB")
    warned = r2_usage.warn_line(8 * 1024 ** 3)
    check("[r2] warning:" in warned and "8 GB" in warned and "10 GB" in warned and r2_usage.warn_line(8 * 1024 ** 3 - 1) == "", "the warning names 8 GB and the 10 GB free tier")
    samples = [
        {"dimensions": {"bucketName": "a", "datetime": "2026-10-21T00:00:00Z"}, "max": {"payloadSize": 100, "metadataSize": 1, "objectCount": 2}},
        {"dimensions": {"bucketName": "a", "datetime": "2026-10-22T00:00:00Z"}, "max": {"payloadSize": 50, "metadataSize": 1, "objectCount": 1}},
        {"dimensions": {"bucketName": "b", "datetime": "2026-10-22T00:00:00Z"}, "max": {"payloadSize": 25, "metadataSize": 0, "objectCount": 3}},
    ]
    totals = r2_usage.latest_totals(samples)
    check(totals["payload"] == 75 and totals["metadata"] == 1 and totals["objects"] == 4 and totals["buckets"] == 2, "R2 usage keeps the latest sample per bucket")
    check("sentinel-token-value" not in r2_usage.scrub("bearer sentinel-token-value", ["sentinel-token-value"]), "R2 logs do not keep the API token")
    import ia_to_r2
    old = "https://archive.org/download/x" + ("ab" * 16) + "/abc.jpg"
    new = ia_to_r2.public_url(("cd" * 32) + ".jpg")
    moved, moved_state = ia_to_r2.rewrite(
        {"v": 1, "files": [{"u": "https://cdn.example/a.jpg", "a": old, "k": "photo"}], "shards": {"2026-10": old[:-3] + "json"}, "posts": {}},
        {"byHash": {"abc": {"a": old}}, "shardUrls": {"2026-10": old[:-3] + "json"}},
        {old: new, old[:-3] + "json": new[:-3] + "json"},
    )
    check(moved["files"][0]["a"] == new and moved["files"][0]["ia"] == old and moved_state["byHash"]["abc"]["a"] == new, "the manifest points at the R2 copy and remembers the old URL")
    budget = [
        {"name": "new.mp4", "kind": "video", "size": 40 * 1024 * 1024, "recent": "2026-10"},
        {"name": "old.mp4", "kind": "video", "size": 40 * 1024 * 1024, "recent": "2022-10"},
        {"name": "pic.jpg", "kind": "photo", "size": 100 * 1024, "recent": "2024-01"},
    ]
    planned = ia_to_r2.plan_copies(budget, 8 * 1000 ** 3, limit=8 * 1000 ** 3 + 20 * 1024 * 1024)
    actions = {row["name"]: row["action"] for row in planned}
    check(actions["pic.jpg"] == "copy" and actions["new.mp4"] == "shrink" and actions["old.mp4"] == "drop", "a tight R2 budget keeps the photo, shrinks the newest video, and drops the old one")
    copy_wf = (ROOT / ".github" / "workflows" / "ia-to-r2.yml").read_text(encoding="utf-8")
    check("ia-to-r2.once" in copy_wf and "IA_ACCESS_KEY" not in copy_wf and "IA_SECRET_KEY" not in copy_wf and 'echo "$CLOUDFLARE' not in copy_wf and "schedule:" not in copy_wf, "the R2 copy is a push, does not use the Internet Archive keys, and does not print the token")
    import ia_empty
    anon = "x" + ("ab" * 16)
    chosen = ia_empty.collect_ids(
        {"items": {"stub:2026-10": anon}, "files": [{"ia": "https://archive.org/download/" + anon + "/pic.jpg"}]},
        {"noindexBlocked": {"superintelapp-2026-10": "readonly"}},
    )
    check(anon in chosen and "superintelapp-2026-10" in chosen and "not-an-item" not in chosen, "the empty run covers anonymous items and the named items")
    check(ia_empty.files_to_remove({"files": [{"name": "pic.jpg"}, {"name": anon + "_meta.xml"}, {"name": "_archive.torrent"}, {"name": anon + "_files.xml"}, {"name": anon + "_meta.sqlite"}]}) == ["pic.jpg", "_archive.torrent"], "catalog files stay and every other file is removed")
    store = {anon: ["pic.jpg", anon + "_meta.xml", "_archive.torrent"]}
    class Resp:
        def __init__(self, status, body):
            self.status = status
            self.body = body
        def read(self):
            return self.body
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
    def urlopen(request, timeout=60):
        item = request.full_url.rstrip("/").split("/")[-1]
        body = json.dumps({"files": [{"name": name} for name in store.get(item, [])]}).encode()
        return Resp(200, body)
    class Opener:
        def open(self, request, timeout=60):
            parts = request.full_url.rstrip("/").split("/")
            item, name = parts[-2], parts[-1]
            if name in store.get(item, []):
                store[item].remove(name)
            return Resp(204, b"")
    os.environ["IA_UPLOADS_ENABLED"] = "true"
    try:
        emptied = ia_empty.empty_items([anon], urlopen=urlopen, opener=Opener(), access="k", secret="sentinel-secret-value", endpoint="http://127.0.0.1", metadata_base="http://127.0.0.1/metadata", sleep=lambda delay: None, pace=0)
    finally:
        os.environ.pop("IA_UPLOADS_ENABLED", None)
    check(emptied["empty"] == [anon] and emptied["holding"] == {} and store[anon] == [anon + "_meta.xml"] and emptied["deleted"] == 2, "a file delete leaves the catalog file and reports the item empty")
    check(ia_empty.main() == 0, "the empty script does nothing unless uploads are enabled")
    empty_wf = (ROOT / ".github" / "workflows" / "ia-empty.yml").read_text(encoding="utf-8")
    check("ia-empty.once" in empty_wf and "IA_UPLOADS_ENABLED" in empty_wf and "schedule:" not in empty_wf and 'echo "$IA_' not in empty_wf and "echo $IA_" not in empty_wf, "the empty workflow is a push, turns writes on for that job, and does not print the keys")
    os.environ.pop("IA_UPLOADS_ENABLED", None)
    class Boom:
        def open(self, *args, **kwargs):
            raise AssertionError("network")
    quiet = ia_backup.run_backup({"access": "a", "secret": "b", "opener": Boom(), "endpoint": "http://127.0.0.1"}, [], {}, sleep=lambda delay: None)
    check(quiet["uploaded"] == [] and quiet["failures"] == 0 and "skipping the upload" in " ".join(quiet["notes"]), "a disabled backup does not upload")
    held = []
    check(ia_backup.upload_bytes("http://127.0.0.1", "x" + "ab" * 16, "a.jpg", b"hi", content_type="image/jpeg", access="k", secret="sentinel-secret-value", opener=Boom(), sleep=lambda delay: None, backoff=0, notes=held, secrets_for_log=["sentinel-secret-value"]) is False and "skipping the upload" in " ".join(held), "upload_bytes returns before any request when uploads are off")
    check(ia_backup._delete_status("http://127.0.0.1", "item", "a.jpg", "k", "sentinel-secret-value", Boom()) == 0, "a disabled delete does not call the network")
    patched, _detail = ia_backup._patch_metadata("item", {"title": "x"}, (), "k", "sentinel-secret-value", Boom().open, Boom(), "http://127.0.0.1")
    check(patched is False, "a disabled metadata write does not call the network")
    check(ia_retire._submit_delete_task("superintelapp-2026-10", "k", "sentinel-secret-value", Boom(), "http://127.0.0.1/tasks", lambda delay: None)[0] == "refused", "a disabled delete task is refused before any request")
    os.environ["IA_UPLOADS_ENABLED"] = "true"
    check("feeds-archive" not in app and "ARCHIVE_IA" not in app and "installIaManifest(manifestDoc" in app, "the page resolves archive shards from the manifest")
    check("feeds-archive" not in snap and "def shard_url(" in snap and '("ia",' not in snap, "snapshot reads archive shards from the manifest")
    anon = "x" + ("ab" * 16)
    check(shard_url({"shards": {"2026-10": "https://archive.org/download/" + anon + "/abc.json"}}, "archive/2026-10.json").endswith("/abc.json"), "a manifest shard url is accepted")
    stored_shard = "https://viktorych-accounts.example.workers.dev/v1/archive/" + ("cd" * 32) + ".json"
    check(shard_url({"shards": {"2026-10": stored_shard}}, "archive/2026-10.json") == stored_shard, "a private R2 shard url is accepted")
    check(shard_url({"shards": {"2026-10": "https://archive.org/download/superintelapp-2026-10/2026-10.json"}}, "archive/2026-10.json") == "", "a named item url is not used")

    sample = b"hello-archive"
    sample_digest = hashlib.sha256(sample).hexdigest()
    retire_host = "http://127.0.0.1"
    copied_url = retire_host + "/download/" + anon + "/file.json"
    retire_state = {
        "v": 1,
        "items": {"stub:2026-10": anon},
        "copied": {"superintelapp-2026-10/old.json": {"url": copied_url, "digest": sample_digest, "size": len(sample), "slot": "stub:2026-10"}},
        "shards": {},
        "byHash": {},
        "byUrl": {},
        "posts": {},
    }
    retire_files = ["superintelapp-2026-10_meta.xml", "superintelapp-2026-10_files.xml"]
    retire_meta = {"creator": "riverquoll", "collection": "opensource", "uploader": "person@example.com", "title": "named"}
    anon_meta = {"title": "files", "uploader": "person@example.com", "noindex": "true"}
    retire_deleted = []
    retire_headers = []

    def retire_open(request, timeout=None):
        method = request.get_method()
        path = urllib.parse.urlparse(request.full_url).path
        if method == "DELETE":
            retire_deleted.append(path)
            retire_headers.extend(request.header_items())
            name = path.rsplit("/", 1)[-1]
            if name in retire_files:
                retire_files.remove(name)
            return Resp(204, b"")
        if method == "POST":
            form = urllib.parse.parse_qs(request.data.decode("utf-8"))
            patch = json.loads(form["-patch"][0])
            target = path.rsplit("/", 1)[-1]
            bucket = retire_meta if target == "superintelapp-2026-10" else anon_meta
            for op in patch:
                key = str(op.get("path") or "").strip("/")
                if key in {"uploader", "noindex"}:
                    return Resp(400, b'{"error":"read-only"}')
                if op.get("op") == "remove":
                    bucket.pop(key, None)
                elif op.get("op") in {"add", "replace"}:
                    bucket[key] = op.get("value")
            return Resp(200, b'{"success":true}')
        if path == "/metadata/superintelapp-2026-10":
            return Resp(200, json.dumps({"metadata": dict(retire_meta), "files": [{"name": name} for name in retire_files]}).encode())
        if path == "/metadata/" + anon:
            return Resp(200, json.dumps({"metadata": dict(anon_meta), "files": []}).encode())
        if path == "/download/" + anon + "/file.json":
            return Resp(200, sample)
        return Resp(404, b"")

    retire_config = {
        "access": "test-access",
        "secret": "test-secret-value",
        "endpoint": retire_host,
        "download_base": retire_host + "/download",
        "metadata_base": retire_host + "/metadata",
        "old_items": ["superintelapp-2026-10"],
        "pace": 0,
        "state": retire_state,
        "urlopen": retire_open,
        "opener": type("Opener", (), {"open": staticmethod(retire_open)})(),
    }
    retire_verified = ia_retire.verify_copies(retire_config, retire_state, sleep=lambda delay: None)
    check(retire_verified["failures"] == [] and retire_verified["checked"] == 1, "a copied file matches its hash and size")
    bad_state = json.loads(json.dumps(retire_state))
    bad_state["copied"]["superintelapp-2026-10/old.json"]["digest"] = "0" * 64
    retire_failed = ia_retire.verify_copies(retire_config, bad_state, sleep=lambda delay: None)
    check(retire_failed["failures"] and "test-secret-value" not in " ".join(retire_failed["notes"]), "a hash mismatch blocks the delete")
    check(not ia_retire.manifest_covers({"files": [], "shards": {}}, retire_state), "deletion waits until the manifest lists the copy")
    check(ia_retire.manifest_covers({"v": 1, "files": [{"a": copied_url}], "shards": {}}, retire_state), "the manifest gate accepts the copied url")
    retire_purged = ia_retire.purge_files(retire_config, retire_state, sleep=lambda delay: None)
    check("superintelapp-2026-10" in retire_purged["emptied"] and retire_purged["remaining"]["superintelapp-2026-10"] == [], "named items are emptied after the copies check out")
    check(any(path.endswith("_meta.xml") for path in retire_deleted), "derived metadata files are deleted too")
    check(any("cascade-delete" in key.lower() and value == "1" for key, value in retire_headers), "deletes ask Internet Archive to drop derivatives")
    retire_blanked = ia_retire.blank_metadata(retire_config, sleep=lambda delay: None)
    retire_fields = retire_blanked["items"]["superintelapp-2026-10"]
    check(retire_fields["creator"] == "removed" and retire_fields["collection"] == "removed" and retire_fields["uploader"] == "refused" and retire_fields["noindex"] == "refused", "creator and collection can be cleared and a read-only uploader is kept")
    check(retire_fields["description"] == "overwritten" and retire_fields["title"] == "removed", "a missing description becomes the plain label and a title can be cleared")
    check(retire_blanked["uploader_left"] == 1 and retire_blanked["anonymous"] == 1, "anonymous items are counted and a refused uploader stays")
    catalog_left = [name for names in {"superintelapp-2026-10": ["superintelapp-2026-10_meta.xml", "superintelapp-2026-10_files.xml"]}.values() for name in names]
    torrent_left = [name for names in {"superintelapp-2026-10": ["superintelapp-2026-10_archive.torrent"]}.values() for name in names]
    check(catalog_left and torrent_left, "a leftover catalog file or torrent still blocks the retirement")
    retire_notes = " ".join(retire_blanked["notes"] + retire_purged["notes"])
    check("test-secret-value" not in retire_notes and "person@example.com" not in retire_notes and anon not in retire_notes, "retire notes do not print the keys, the uploader address, or an anonymous id")

    stuck_item = "superintelapp-2026-03"
    stuck_files = [stuck_item + "_meta.xml", stuck_item + "_files.xml"]
    task_calls = []

    def stuck_open(request, timeout=None):
        method = request.get_method()
        path = urllib.parse.urlparse(request.full_url).path
        if method == "DELETE":
            return Resp(403, b"forbidden")
        if method == "POST" and path == "/tasks.php":
            task_calls.append(json.loads(request.data.decode("utf-8")))
            header = request.headers.get("Authorization") or request.headers.get("authorization")
            task_calls.append(header)
            stuck_files.clear()
            return Resp(200, b'{"success":true,"value":{"task_id":1}}')
        if path == "/metadata/" + stuck_item:
            return Resp(200, json.dumps({"metadata": {"collection": "opensource"}, "files": [{"name": name} for name in stuck_files]}).encode())
        if path == "/metadata/" + anon:
            return Resp(200, json.dumps({"metadata": dict(anon_meta), "files": [{"name": "keep.json"}]}).encode())
        return Resp(404, b"")

    stuck_config = dict(retire_config)
    stuck_config.update({
        "old_items": [stuck_item, anon],
        "tasks_base": retire_host + "/tasks.php",
        "delete_wait": 0,
        "urlopen": stuck_open,
        "opener": type("Opener", (), {"open": staticmethod(stuck_open)})(),
    })
    stuck_purged = ia_retire.purge_files(stuck_config, retire_state, sleep=lambda delay: None)
    stuck_notes = " ".join(stuck_purged["notes"])
    check(stuck_item in stuck_purged["emptied"] and stuck_purged["tasks_accepted"] == 1 and stuck_purged["remaining"][stuck_item] == [], "a refused file delete is finished by deleting the named item")
    check(task_calls and task_calls[0]["cmd"] == "delete.php" and task_calls[0]["identifier"] == stuck_item and "args" not in task_calls[0] and anon not in json.dumps(task_calls[0]) and task_calls[1] == "LOW test-access:test-secret-value", "the delete task names only the old item")
    check("test-secret-value" not in stuck_notes and anon not in stuck_notes and "could not remove" in stuck_notes and "403" in stuck_notes, "a blocked file delete records the status and not the keys")

    refused_files = [stuck_item + "_meta.xml"]
    refused_tasks = []

    def refuse_task_open(request, timeout=None):
        method = request.get_method()
        path = urllib.parse.urlparse(request.full_url).path
        if method == "DELETE":
            return Resp(403, b"forbidden")
        if method == "POST" and path == "/tasks.php":
            refused_tasks.append(json.loads(request.data.decode("utf-8")))
            return Resp(403, b'{"success":false,"error":"not allowed"}')
        if path == "/metadata/" + stuck_item:
            return Resp(200, json.dumps({"metadata": {"collection": "opensource"}, "files": [{"name": name} for name in refused_files]}).encode())
        return Resp(404, b"")

    refused_task_config = dict(stuck_config)
    refused_task_config.update({
        "old_items": [stuck_item],
        "urlopen": refuse_task_open,
        "opener": type("Opener", (), {"open": staticmethod(refuse_task_open)})(),
    })
    refused_task = ia_retire.purge_files(refused_task_config, retire_state, sleep=lambda delay: None)
    refused_task_notes = " ".join(refused_task["notes"])
    check(stuck_item not in refused_task["emptied"] and refused_task["tasks_refused"] == 1 and refused_task["remaining"][stuck_item] == refused_files, "a refused item delete leaves the files and continues")
    check(refused_tasks and refused_tasks[0]["identifier"] == stuck_item and "test-secret-value" not in refused_task_notes and "delete task refused" in refused_task_notes, "a refused item delete is recorded without the keys")

    os.environ.pop("IA_UPLOADS_ENABLED", None)
    story_checks()


def vk_web_checks(now) -> None:
    import vk_session
    from stories import collect
    from sync_health import problems
    from vk_session import (
        BROWSER,
        SESSION_ATTENTION,
        SPARE_ATTENTION,
        VK_WEB_PACE,
        StoryAuthError,
        decrypt_cookies,
        encrypt_cookies,
        fetch_vk_web,
        forbidden_request,
        load_cookie_export,
        page_state,
        parse_vk_web_stories,
        passphrase,
        run_sign_in,
        totp_code,
    )

    logged_in = "window.vk = Object.assign(window.vk || {}, { id: %s });"
    feed_html = (FIX / "vk_web_feed.html").read_text(encoding="utf-8")
    payload = json.loads((FIX / "vk_web_stories.json").read_text(encoding="utf-8"))
    parsed = parse_vk_web_stories(payload, now, viewer_id=100)
    from_page = parse_vk_web_stories(feed_html, now)
    check([row["id"] for row in parsed] == ["vk:vk", "vk:foxglen"], "the VK web fixture keeps followed accounts and drops the spare account")
    check([row["id"] for row in from_page] == ["vk:vk", "vk:foxglen"], "the feed page fixture parses the same accounts")
    check([item["id"] for item in parsed[0]["items"]] == ["6", "5"], "VK web stories are oldest first")
    check(parsed[0]["items"][0]["type"] == "video" and parsed[0]["items"][0]["url"] == "https://cdn.example/v.mp4" and parsed[0]["items"][0]["poster"] == "https://cdn.example/poster.jpg", "a VK web video uses the https mp4 and its poster")
    check(parsed[0]["name"] == "ВКонтакте" and parsed[0]["avatar"] == "https://cdn.example/vk-face.jpg" and parsed[0]["items"][1]["caption"] == "Hello", "the VK group supplies the name, avatar, and caption")
    check(parsed[1]["name"] == "Pavel foxglen" and parsed[1]["items"][0]["open"] == "https://vk.com/story1_9", "a followed profile keeps its name and story link")
    dumped = json.dumps(parsed)
    check("old.jpg" not in dumped and "mine.jpg" not in dumped and "nope.mp4" not in dumped and "plain" not in dumped, "expired, own, and http VK web media are dropped")
    cards = """
    <div data-owner-id="1" data-handle="foxglen" data-name="Pavel" data-avatar="https://cdn.example/foxglen-face.jpg">
      <a data-story-id="9" data-type="photo" data-date="1792607400" data-expires="1792693800">
        <img src="https://cdn.example/foxglen.jpg">
      </a>
    </div>
    """
    card_accounts = parse_vk_web_stories(cards, now, viewer_id=100)
    check(card_accounts[0]["items"][0]["url"] == "https://cdn.example/foxglen.jpg", "a feed card with an image URL becomes a story")
    code = totp_code("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", datetime.fromtimestamp(59, timezone.utc))
    check(code == "287082", "the authenticator code matches the RFC 6238 vector")
    exported = load_cookie_export(json.dumps([
        {"domain": ".vk.com", "name": "remixsid", "value": "abc", "path": "/"},
        {"domain": ".login.vk.com", "name": "p", "value": "long", "path": "/"},
    ]))
    header = load_cookie_export("remixsid=abc; remixstlid=def")
    check([row["name"] for row in exported] == ["remixsid", "p"] and header[1]["name"] == "remixstlid", "cookie JSON and a raw Cookie header both load")
    try:
        load_cookie_export("{not-json remixsid=SECRETCOOKIE")
    except StoryAuthError as exc:
        check("SECRETCOOKIE" not in str(exc) and str(exc) == SESSION_ATTENTION, "a bad cookie export does not echo the secret")
    else:
        check(False, "a bad cookie export must stop")
    phrase = passphrase("", "password-VALUE-not-logged")
    sentinel = "remixsid-SUPERSECRETVALUE-not-logged"
    if shutil.which("openssl"):
        blob = encrypt_cookies([{"domain": ".vk.com", "name": "remixsid", "value": sentinel, "path": "/"}], phrase)
        check(sentinel.encode() not in blob and b"password-VALUE-not-logged" not in blob, "the cookie cache is ciphertext")
        check(decrypt_cookies(blob, phrase)[0]["value"] == sentinel, "the cookie cache decrypts with the same key")
        check(decrypt_cookies(blob, passphrase("other-key", "")) == [], "a different cache key does not return the cookies")
    check(VK_WEB_PACE >= 2 and forbidden_request("https://login.vk.com/?act=web_token") and forbidden_request("https://vk.com/al_stories.php", "stories.markSeen") and not forbidden_request("https://vk.com/feed"), "web_token and mark-seen are refused, and requests wait at least two seconds")
    check("6287487" not in (ROOT / "scripts" / "vk_session.py").read_text(encoding="utf-8"), "the web session path does not use an official VK app id")

    def page(user_id, extra=""):
        return "<html><body><script>%s</script>%s</body></html>" % (logged_in % user_id, extra)

    class Steps:
        def __init__(self, steps):
            self.steps = list(steps)
            self.calls = []

        def __call__(self, url, headers):
            self.calls.append((url, dict(headers or {})))
            return self.steps.pop(0)

    login_html = page(0, "<title>VK | Welcome!</title>")
    captcha_html = "<html><body><form><input name=\"captcha_key\"></form><p>Confirm you are not a robot</p></body></html>"
    check(page_state("https://vk.com/feed", 200, feed_html) == "ok", "a feed page with a user id is signed in")
    check(page_state("https://vk.com/", 200, login_html) == "login", "the welcome page is a signed-out session")
    check(page_state("https://vk.com/", 200, captcha_html) == "captcha", "a captcha form is a challenge")
    check(page_state("https://vk.com/feed", 403, "no") == "denied", "403 stops before the body is treated as a feed")

    sleeps = []
    restore = Steps([
        (302, "https://login.vk.com/?act=restore_cookies&c_hash=1", "", ["remixstlid=LONG"]),
        (302, "https://vk.com/feed", "", ["remixsid=NEW; Path=/; Domain=.vk.com; Secure; HttpOnly"]),
        (200, "", feed_html, []),
    ])
    accounts = fetch_vk_web(now, session_export="remixsid=OLD", session_key="cache-key", transport=restore, sleep=lambda delay: sleeps.append(delay), sign_in=lambda *args: (_ for _ in ()).throw(AssertionError("cookie session signed in")))
    check([row["id"] for row in accounts] == ["vk:vk", "vk:foxglen"], "login.vk.com restore redirects return the feed stories")
    check(len(restore.calls) == 3 and sleeps == [VK_WEB_PACE, VK_WEB_PACE], "restore hops are paced and the feed is fetched once")
    check(all(call[1].get("User-Agent") == BROWSER and "web_token" not in call[0] and "access_token" not in call[0] for call in restore.calls), "the feed uses a desktop browser and does not mint a web token")
    check("remixsid=NEW" in restore.calls[2][1].get("Cookie", ""), "the fresh remixsid is sent on the feed request")

    blocked = Steps([(302, "https://login.vk.com/?act=web_token&app=1", "", [])])
    try:
        fetch_vk_web(now, session_export="remixsid=OLD", transport=blocked, sleep=lambda delay: None, sign_in=lambda *args: (_ for _ in ()).throw(AssertionError("web_token signed in")))
    except StoryAuthError as exc:
        check(str(exc) == SESSION_ATTENTION and len(blocked.calls) == 1 and "web_token" not in blocked.calls[0][0], "a web_token redirect is not requested")
    else:
        check(False, "web_token must stop")

    denied = Steps([(401, "", "no", [])])
    signed = []

    def boom(*_args):
        signed.append("signed")
        raise AssertionError("401 signed in again")

    try:
        fetch_vk_web(
            now,
            login="spare@example.com",
            password="secret-password",
            session_export="remixsid=OLD",
            transport=denied,
            sleep=lambda delay: None,
            sign_in=boom,
        )
    except StoryAuthError as exc:
        check(str(exc) == SPARE_ATTENTION and signed == [] and len(denied.calls) == 1, "401 stops with no retry and no second sign-in")
    else:
        check(False, "401 must stop")

    browser = vk_session.ScriptedBrowser([
        {"html": page(0), "inputs": {"login"}},
        {"html": captcha_html, "inputs": set()},
    ])
    try:
        run_sign_in(browser, "spare@example.com", "secret-password", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
    except StoryAuthError as exc:
        check(str(exc) == SPARE_ATTENTION and ("password",) not in browser.events, "a captcha stops before the password is submitted again")
    else:
        check(False, "captcha must stop the sign-in")

    sms = vk_session.ScriptedBrowser([
        {"html": page(0), "inputs": {"login"}},
        {"html": page(0), "inputs": {"password"}},
        {"html": page(0, "<p>We sent an SMS</p>"), "inputs": {"otp"}},
    ])
    try:
        run_sign_in(sms, "spare@example.com", "secret-password", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
    except StoryAuthError as exc:
        check(str(exc) == SPARE_ATTENTION and ("otp", 6) not in sms.events, "an SMS challenge is not answered")
    else:
        check(False, "SMS must stop the sign-in")

    ok_browser = vk_session.ScriptedBrowser(
        [
            {"html": page(0), "inputs": {"login"}},
            {"html": page(0), "inputs": {"password"}},
            {"html": page(0, "<p>Code from the app</p>"), "inputs": {"otp"}},
            {"html": page(42), "inputs": set()},
        ],
        cookies=[{"domain": ".vk.com", "name": "remixsid", "value": "fresh", "path": "/"}],
    )
    signed_cookies = run_sign_in(ok_browser, "spare@example.com", "secret-password", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
    check(("otp", 6) in ok_browser.events and signed_cookies[0]["value"] == "fresh" and "secret-password" not in repr(ok_browser.events), "one sign-in submits the authenticator code and keeps the cookies")

    with tempfile.TemporaryDirectory() as tmp:
        cache = str(Path(tmp) / "cookies.enc")
        first = Steps([
            (200, "", login_html, []),
            (200, "", feed_html, ["remixsid=SAVED; Path=/; Domain=.vk.com"]),
        ])
        calls = []

        def signer(user, password, secret):
            calls.append((user, len(password), len(secret)))
            return [{"domain": ".vk.com", "name": "remixsid", "value": "from-login", "path": "/"}]

        found = fetch_vk_web(
            now,
            login="spare@example.com",
            password="secret-password",
            totp_secret="GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
            session_export="remixsid=OLD",
            session_key="cache-key",
            session_file=cache,
            transport=first,
            sleep=lambda delay: None,
            sign_in=signer,
        )
        check(len(calls) == 1 and [row["id"] for row in found] == ["vk:vk", "vk:foxglen"], "a dead session signs in once")
        if shutil.which("openssl"):
            saved = Path(cache).read_bytes()
            check(b"from-login" not in saved and b"secret-password" not in saved and b"SAVED" not in saved, "refreshed cookies are stored only as ciphertext")
            second = Steps([(200, "", feed_html, [])])

            def refuse_sign_in(*_args):
                raise AssertionError("cached session signed in again")

            again = fetch_vk_web(
                now,
                login="spare@example.com",
                password="secret-password",
                session_key="cache-key",
                session_file=cache,
                transport=second,
                sleep=lambda delay: None,
                sign_in=refuse_sign_in,
            )
            check(len(second.calls) == 1 and again[0]["handle"] == "vk", "the next run reuses the cached session")

    previous_vk = [{
        "id": "vk:vk",
        "platform": "vk",
        "handle": "vk",
        "items": [{"id": "1", "type": "photo", "url": "https://cdn.example/keep.jpg", "expires": "2026-10-22T00:00:00Z"}],
    }]
    token_calls = []

    def token_must_not(method, params):
        token_calls.append(method)
        raise AssertionError("user token was called")

    accounts, health = collect(
        [{"id": "vk:vk", "platform": "vk", "handle": "vk", "ownerId": -10000041}],
        "",
        now,
        previous_vk,
        vk_secret="vk1.secret.TOKENVALUE",
        vk_login="spare@example.com",
        vk_password="secret-password",
        vk_session="remixsid=OLD",
        vk_transport=Steps([(403, "", "no", [])]),
        vk_sign_in=lambda *args: (_ for _ in ()).throw(AssertionError("403 signed in")),
        sleep=lambda delay: None,
        vk_call=token_must_not,
    )
    check(token_calls == [] and health == [{"platform": "vk", "ok": False, "detail": SPARE_ATTENTION}], "the web session wins over VK_USER_TOKEN and reports one problem")
    check(accounts[0]["items"][0]["url"] == "https://cdn.example/keep.jpg" and "secret-password" not in json.dumps(health), "the failed web fetch keeps the previous story and omits the password")
    moment = "2026-10-21T19:00:00Z"
    check(any(SPARE_ATTENTION in line for line in problems({"feeds": [], "stories": health}, moment)), "the spare-account challenge is the Sync problem text")
    workflow = (ROOT / ".github" / "workflows" / "sync.yml").read_text(encoding="utf-8")
    guide = (ROOT / "docs" / "vk-session.md").read_text(encoding="utf-8")
    check("VK_LOGIN" in guide and "VK_PASSWORD" in guide and "VK_TOTP_SECRET" in guide and "Cookie-Editor" in guide and SPARE_ATTENTION in guide, "the owner steps name the secrets, the cookie fallback, and the issue text")
    check("VK_LOGIN: ${{ secrets.VK_LOGIN }}" in workflow and "VK_PASSWORD: ${{ secrets.VK_PASSWORD }}" in workflow and "VK_TOTP_SECRET: ${{ secrets.VK_TOTP_SECRET }}" in workflow and "VK_SESSION: ${{ secrets.VK_SESSION }}" in workflow and 'echo "::add-mask::${VK_LOGIN}"' in workflow and 'echo "::add-mask::${VK_PASSWORD}"' in workflow and ".vk-session" in workflow, "the sync masks the spare-account secrets and caches the session")
    check("6287487" not in workflow and "act=web_token" not in workflow, "the workflow does not call web_token or an official app id")


def story_checks() -> None:
    import subprocess

    from stories import (
        AUTH_DETAIL,
        StoryAuthError,
        StoryQueryError,
        VK_AUTH_DETAIL,
        VK_PACE,
        VK_QUERY_DETAIL,
        collect,
        fetch_vk,
        parse_story_document,
        parse_vk_stories,
        publish,
        redact,
        session_header,
        vk_http,
    )
    from sync_health import problems

    now = datetime(2026, 10, 21, 19, 0, tzinfo=timezone.utc)
    payload = json.loads((FIX / "ig_stories.json").read_text(encoding="utf-8"))
    account = parse_story_document(payload, "birchlane", now, {"id": "instagram:birchlane", "handle": "birchlane"})
    check(len(account["items"]) == 2, "the instagram fixture keeps the two stories that have not expired")
    check(account["items"][0]["id"] == "1002" and account["items"][0]["type"] == "video", "the older video is first")
    check(account["items"][1]["id"] == "1001" and account["items"][1]["caption"] == "Morning" and account["items"][1]["url"].endswith("story.jpg"), "the photo keeps the larger image and its caption")
    check(account["name"] == "Moss Point" and account["avatar"] == "https://cdn.example/birchlane.jpg", "the reel supplies the name and avatar")
    check("1003" not in json.dumps(account), "an expired story is dropped")
    leaked = "sessionid=SECRETVALUE; ds_user_id=42"
    check(redact("Cookie: " + leaked) == "Cookie: sessionid=redacted; ds_user_id=redacted", "a story error cannot carry the session")
    header = session_header(leaked + "; extra=no")
    check(header.startswith("sessionid=") and "extra=" not in header, "the request keeps the session cookies and drops the rest")

    calls = []

    def refuse(*_args):
        calls.append("called")
        raise AssertionError("unset session called the network")

    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp) / "stories.json"
        dest.write_text('{"accounts":[{"id":"instagram:birchlane","items":[{"url":"https://cdn.example/old.jpg"}]}]}', encoding="utf-8")
        health = publish(
            {"feeds": [{"id": "instagram:birchlane", "platform": "instagram", "handle": "birchlane"}], "rsshubBase": "http://127.0.0.1:1200"},
            dest,
            now=now,
            secret="",
            vk_secret="",
            transport=refuse,
        )
        saved = json.loads(dest.read_text(encoding="utf-8"))
    check(health == [] and calls == [] and saved["accounts"] == [], "IG_SESSION unset writes no stories and does not call out")

    previous = [
        {
            "id": "instagram:birchlane",
            "platform": "instagram",
            "handle": "birchlane",
            "items": [
                {"id": "9", "type": "photo", "url": "https://cdn.example/keep.jpg", "date": "2026-10-21T12:00:00Z", "expires": "2026-10-22T00:00:00Z"},
                {"id": "8", "type": "photo", "url": "http://cdn.example/nope.jpg", "date": "2026-10-21T12:00:00Z", "expires": "2026-10-22T00:00:00Z"},
                {"id": "7", "type": "photo", "url": "https://cdn.example/gone.jpg", "date": "2026-10-20T00:00:00Z", "expires": "2026-10-21T00:00:00Z"},
            ],
        },
        {
            "id": "vk:vk",
            "platform": "vk",
            "handle": "vk",
            "items": [{"id": "1", "type": "photo", "url": "https://cdn.example/vk.jpg", "expires": "2026-10-22T00:00:00Z"}],
        },
    ]
    seen_urls = []

    def rejected(method, url, headers, body):
        seen_urls.append(url)
        cookie = (headers or {}).get("Cookie") or ""
        check("SECRETVALUE" in cookie and (body is None or b"SECRETVALUE" not in body), "the session travels in the cookie header only")
        raise StoryAuthError(AUTH_DETAIL)

    feeds = [
        {"id": "instagram:birchlane", "platform": "instagram", "handle": "birchlane"},
        {"id": "instagram:sampleagency", "platform": "instagram", "handle": "sampleagency"},
        {"id": "telegram:laneharbor", "platform": "telegram", "handle": "laneharbor"},
        {"id": "vk:vk", "platform": "vk", "handle": "vk"},
    ]
    accounts, health = collect(feeds, "sessionid=SECRETVALUE", now, previous, transport=rejected)
    check(len(seen_urls) == 1, "a rejected session stops the remaining accounts")
    check(health == [{"platform": "instagram", "ok": False, "detail": AUTH_DETAIL}], "a rejected session is one health failure")
    check("SECRETVALUE" not in json.dumps(health), "the health row does not contain the session")
    check([row["id"] for row in accounts] == ["instagram:birchlane"], "a failed fetch keeps that account and does not invent Telegram or VK")
    check([item["id"] for item in accounts[0]["items"]] == ["9"], "only the unexpired https story is kept")

    def empty_reel(method, url, headers, body):
        if method == "GET":
            return 200, url, '"profile_id":"5"', []
        return 200, url, json.dumps({"data": {"xdt_api__v1__feed__reels_media": {"reels_media": []}}}), []

    accounts, health = collect(feeds[:1], "sessionid=SECRETVALUE", now, previous, transport=empty_reel)
    check(accounts == [] and health == [], "an empty reel clears the account and stays healthy")

    rss = """<?xml version="1.0"?><rss><channel><item>
      <link>https://www.instagram.com/stories/birchlane/55/</link>
      <guid>55</guid>
      <pubDate>Wed, 21 Oct 2026 18:00:00 GMT</pubDate>
      <description>&lt;img src="https://cdn.example/from-rss.jpg"&gt; Morning</description>
    </item></channel></rss>"""

    def query_then_rss(method, url, headers, body):
        if method == "GET" and "instagram.com" in url:
            return 200, url, '"profile_id":"5"', []
        if method == "POST":
            return 200, url, '{"error":"nope"}', []
        if "/instagram/stories/" in url:
            return 200, url, rss, []
        raise AssertionError(url)

    accounts, health = collect(
        [{"id": "instagram:birchlane", "platform": "instagram", "handle": "birchlane", "profile": {"name": "Mark"}}],
        "sessionid=SECRETVALUE",
        now,
        [],
        transport=query_then_rss,
        rsshub="http://127.0.0.1:1200",
    )
    check(health == [] and accounts[0]["items"][0]["url"] == "https://cdn.example/from-rss.jpg", "a local stories route can fill in when the query has no reel")
    check(accounts[0]["items"][0]["open"].endswith("/55/"), "the story link stays on instagram.com")

    def login_wall(method, url, headers, body):
        return 302, "https://www.instagram.com/accounts/login/", "checkpoint", []

    accounts, health = collect(feeds[:1], "sessionid=SECRETVALUE", now, previous, transport=login_wall)
    check(health and health[0]["ok"] is False and "SECRETVALUE" not in health[0]["detail"], "a login wall is a session failure and the cookie stays out of the detail")
    check(accounts[0]["items"][0]["id"] == "9", "the login wall keeps the previous story")

    moment = "2026-10-21T19:00:00Z"
    check(any("IG_SESSION was rejected" in line for line in problems({"feeds": [], "stories": health}, moment)), "a rejected session is reported immediately")
    check(problems({"feeds": [], "stories": []}, moment) == [], "no stories is healthy")
    check(problems({"feeds": [], "stories": [{"platform": "instagram", "ok": True, "detail": ""}]}, moment) == [], "a successful story fetch adds no health line")

    page = (ROOT / "index.html").read_text(encoding="utf-8")
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    worker = (ROOT / "sw.js").read_text(encoding="utf-8")
    workflow = (ROOT / ".github" / "workflows" / "sync.yml").read_text(encoding="utf-8")
    styles = (ROOT / "stories.css").read_text(encoding="utf-8")
    check(page.index('src="stories.js"') < page.index('src="app.js"') and 'href="stories.css"' in page and 'id="stories"' in page, "the page loads the story tray before the app")
    check('act === "story"' in app and "window.Stories.open" in app and "window.Stories.homeTray" in app and "window.Stories.trayExtra" in app and "stories.json" in app, "home opens a story and reserves room for the tray")
    check("stories.js" in worker and "stories.css" in worker and "viktorych-a260-__SW_VERSION__" in worker and "stories)\\.json" in worker, "the service worker precaches the story shell and refreshes stories.json")
    lazy = (ROOT / "shared" / "lazy-modules.js").read_text(encoding="utf-8")
    check('shorts.js", "shorts.css"' in lazy and "shorts.js" in worker and "shorts.css" in worker and 'info.name === "shorts"' in app, "the page and the service worker load Shorts on demand")
    check('drive.js", "drive.css"' in lazy and "drive.js" in worker and "drive.css" in worker and "drive-crypto.js" in worker and 'ensureLazy("drive")' in app, "the page and the service worker load Drive on demand")
    check("drive.js" in deployed_paths() and "drive.css" in deployed_paths() and "drive-crypto.js" in deployed_paths() and "drive-photos.js" in deployed_paths(), "the sync publishes the Drive shell")
    check('parts[1] === "photos"' in app and 'tr("Photos")' in (ROOT / "drive.js").read_text(encoding="utf-8") and 'tr("Back up photos")' in (ROOT / "drive.js").read_text(encoding="utf-8"), "Photos is an owner Drive section")
    check("drive-photos.js" in worker, "the service worker precaches the Photos library")
    nav_fn = app.split("function navItemDef(id)", 1)[1].split("function shownFeeds", 1)[0]
    bottom_fn = app.split("function bottom(route)", 1)[1].split("function listSortOf", 1)[0]
    bottom_ids = app.split("const BOTTOM_NAV_IDS", 1)[1].split("];", 1)[0]
    bottom_default = app.split("const BOTTOM_NAV_DEFAULT_ON", 1)[1].split("];", 1)[0]
    side_ids = app.split("const ALL_NAV_IDS", 1)[1].split("];", 1)[0]
    check("#/drive" not in nav_fn and "#/drive" not in bottom_fn and "#/storage" not in bottom_fn and '"storage"' not in side_ids and '"storage"' not in bottom_default and '"storage"' in bottom_ids and 'href: "#/storage"' in nav_fn, "storage stays off the default nav and can be pinned on the bottom bar")
    check('href: "#/storage"' in nav_fn and 'icon: "storage"' in nav_fn and "ViktorychDrive.visible" in app and "bottomHiddenItems()" in app and 'parts[0] === "storage"' in app and 'bare === "#/drive"' in app, "storage opens from the account menu when it is off the bar, and the old drive route redirects")
    games_js = (ROOT / "games.js").read_text(encoding="utf-8")
    check('games.js", "games.css"' in lazy and 'id="game-host"' in page and "games.js" in worker and "games.css" in worker, "the page and the service worker load Games on demand")
    check("games.js" in deployed_paths() and "games.css" in deployed_paths(), "the sync publishes the Games shell")
    check('href: "#/games"' in nav_fn and 'r.name === "games"' in nav_fn and 'icon: "games"' in nav_fn and '"games"' in side_ids and 'parts[0] === "games"' in app, "Games opens from the left nav and the account menu")
    communities_js = (ROOT / "communities.js").read_text(encoding="utf-8")
    check('communities.js", "communities.css"' in lazy and "communities.js" in worker and "communities.css" in worker and 'info.name === "communities"' in app, "the page and the service worker load Communities on demand")
    check("communities.js" in deployed_paths() and "communities.css" in deployed_paths() and "data/communities/index.json" in deployed_paths() and "reddit.yml" in workflow, "the sync publishes Communities and dispatches the Reddit mirror")
    check(('"#/communities", "communities"' in nav_fn or 'href: "#/communities"' in nav_fn) and 'parts[0] === "communities"' in app and "ViktorychCommunities" in app and "takeCompose" in app, "Communities opens from the left nav and reuses compose")
    check("Only on ViktorychApp" in communities_js and "data-cm=\"filter\"" in communities_js and "parentId" in communities_js, "a community thread mixes Reddit and ViktorychApp replies")
    communities_css = (ROOT / "communities.css").read_text(encoding="utf-8")
    check("isForum" in communities_js and "Open on forum" in communities_js and "Nothing is sent to the forum." in communities_js and "cm-type-badge" in communities_css, "a mirrored Discourse forum is labelled and linked as a forum, not as a subreddit")
    index_doc = json.loads((ROOT / "data" / "communities" / "index.json").read_text(encoding="utf-8"))
    index_names = [row.get("name") for row in index_doc.get("communities") or [] if isinstance(row, dict)]
    check("teslamotors" in index_names and "grapheneos" in index_names, "the Communities index lists the built-in subreddit and Discourse forum")
    check("mergeBuiltins" in communities_js and "INDEX_TTL" in communities_js and "grapheneos" in communities_js, "the client keeps built-in communities and revalidates a stale index")
    reddit_py = (ROOT / "scripts" / "reddit_sync.py").read_text(encoding="utf-8")
    discourse_py = (ROOT / "scripts" / "discourse_sync.py").read_text(encoding="utf-8")
    check("discourse_forums" in reddit_py and 'd_name == "grapheneos"' not in reddit_py and "index_meta" in discourse_py, "the sync keeps every configured Discourse forum in the index")
    check("loadComments" in communities_js and "retry-comments" in communities_js and "cleanRedditText(item.reply.text)" in communities_js and "cm-thread-note" in communities_css, "a forum thread loads its own comment page instead of a partial preview")
    check("fetch_replies" in discourse_py and "write_comments" in discourse_py and "prune_comments" in discourse_py and "html_to_text" in discourse_py and "TOPIC_LIMIT" in discourse_py, "the forum sync keeps every topic's comments in a per-topic file")
    sw_js = (ROOT / "sw.js").read_text(encoding="utf-8")
    check("mindepth 2" not in (ROOT / "scripts" / "assemble_site.py").read_text(encoding="utf-8") and "data/communities/index.json" in deployed_paths() and "one comment page per topic" in sw_js and "data\\/communities" in sw_js, "comment pages stay in private storage and the service worker still treats them as data")
    reddit_wf = (ROOT / ".github" / "workflows" / "reddit.yml").read_text(encoding="utf-8")
    check("trying public feeds" in reddit_py and "leaving communities unchanged" not in reddit_py and "client_credentials" in reddit_py and "reddit.com/.json" not in reddit_py and 'cron: "*/20 * * * *"' in reddit_wf and "echo \"$REDDIT_CLIENT" not in reddit_wf and "echo ${{ secrets" not in reddit_wf, "the Reddit mirror tries public feeds without secrets and runs every 20 minutes")
    import communities_publish
    check(communities_publish.selftest() == 0 and ".communities-r2" in reddit_wf, "community mirrors can stay in R2 instead of a commit on main")
    check("handleCommunityRoute" in (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8") and "community_posts" in (ROOT / "worker" / "src" / "communities.js").read_text(encoding="utf-8") and "oauth.reddit.com" not in (ROOT / "worker" / "src" / "communities.js").read_text(encoding="utf-8"), "internal community posts stay in the accounts Worker")
    check('setAttribute("sandbox", "allow-scripts allow-same-origin allow-pointer-lock allow-orientation-lock")' in games_js and 'setAttribute("allow", "fullscreen; autoplay; gamepad; screen-wake-lock")' in games_js and "allow-popups" not in games_js and "allow-top-navigation" not in games_js, "the game frame only gets the Unity sandbox")
    check("https://nzlay.com/ReGone/game/index.html" in games_js and "https://nzlay.com/pages/ReGone" in games_js and "nzlay.com" not in (ROOT / "games.css").read_text(encoding="utf-8"), "ReGone stays on its own site")
    check('screen.orientation.lock("landscape")' in games_js and "viktorychapp-games-v1" in games_js, "phones try landscape and play time stays in this browser")
    check("function isGameHost(" in worker and 'hostname === "nzlay.com"' in worker and "if (isGameHost(url)) return;" in worker and "nzlay.com" not in worker[worker.index("SHELL_FILES"):worker.index("SHELL_FILES") + 2500], "the service worker leaves the game origin alone")
    drive_crypto = subprocess.run(["node", "scripts/drive_test.mjs"], cwd=ROOT, capture_output=True, text=True)
    check(drive_crypto.returncode == 0, "drive crypto round-trip\n" + drive_crypto.stdout + drive_crypto.stderr)
    check('img.closest(".shorts-slide")' in app, "a refused Shorts video stays in the slide so the TikTok detail can show")
    check("shorts.js" in deployed_paths() and "shorts.css" in deployed_paths() and "python3 scripts/tiktok_sync.py" in workflow, "the sync fetches TikTok and publishes the Shorts shell")
    accounts_cfg = (ROOT / "accounts.config.js").read_text(encoding="utf-8")
    wrangler = (ROOT / "worker" / "wrangler.toml").read_text(encoding="utf-8")
    check('tiktokAudience: "owner"' in accounts_cfg and 'TIKTOK_AUDIENCE = "owner"' in wrangler and "gate: true" not in accounts_cfg, "TikTok stays owner-only until the one audience flag changes")
    shorts_js = (ROOT / "shorts.js").read_text(encoding="utf-8")
    check('tr("added accounts")' in shorts_js and 'data-shorts="remove-account"' in shorts_js and 'tr("Original quality")' in shorts_js and "tracked" not in shorts_js.lower(), "Shorts lets the owner add an account and does not call it tracked")
    check("isTikTokCdn(url)" in worker and "if (isTikTokCdn(url)) return;" in worker, "the service worker does not intercept TikTok CDN media")
    check('VERSION = "viktorych-a260-__SW_VERSION__"' in worker, "the service worker cache stamp is a144")
    landing_css = (ROOT / "landing.css").read_text(encoding="utf-8")
    accounts_src = (ROOT / "accounts.js").read_text(encoding="utf-8")
    check("function showLanding(" in accounts_src and "function installedApp(" in accounts_src and "display-mode: standalone" in accounts_src and 'data-acct="signup"' in accounts_src and 'data-acct="login"' in accounts_src and "prefers-reduced-motion" in landing_css and "animation-timeline" in landing_css and "landing/timeline.webp" in accounts_src, "logged-out visitors get the marketing landing and an installed app skips it")
    check('tr("Too many plays. Try again in a minute.")' in shorts_js and 'tr("Signed out")' in shorts_js and 'tr("Couldn\'t play this video")' in shorts_js and "playbackNote(err)" in shorts_js and 'level + "-pending"' in shorts_js and "if (!autoplay) return Promise.resolve();" in shorts_js, "a For You miss names 429, a missing backup, or a signed-out session and only the next short is probed")
    check("maxBufferLength = 30" in shorts_js and "maxBufferLength: 30" in app and "function slowLink(" in shorts_js and "conn.saveData" in shorts_js and 'kind === "2g"' in shorts_js and "function prefetchUrls(" in shorts_js and "prefetchParts(" in shorts_js and 'armSlide(slides[i], "metadata")' in shorts_js, "For You and feed videos buffer about 30 seconds and only the next short is prefetched, except on Save-Data or 2g")
    check('source.kind === "tg"' in app and "URL.createObjectURL(blob)" not in app[app.index('source.kind === "tg"'):app.index('source.kind === "tg"') + 700], "a Telegram file streams from its Range URL")
    check("syncPlaybackAuth" in (ROOT / "accounts.js").read_text(encoding="utf-8") and "/v1/session/refresh" in (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8") and "ownerPart" in (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8") and "segmentCached" in (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8"), "the owner playback counts once and a session can refresh without a prompt")
    check("stats=1" in shorts_js and "15000" in shorts_js and "60 * 1000" in shorts_js and 'tr("Live ended")' in shorts_js and 'tr("Couldn\'t play this live")' in shorts_js and "/v1/owner/play" not in shorts_js and "playHls(video, step.url, false" in shorts_js and "withCredentials = false" in shorts_js and "capLevelToPlayerSize: false" in shorts_js and "currentLevel = top" in shorts_js and "/v1/owner/tiktok/recordings" in shorts_js and 'tr("Recording ({n} of {cap})",' in shorts_js and 'tr("Saved")' in shorts_js and 'tr("Queued")' in shorts_js and "tgUrl(" in shorts_js, "Shorts plays a live directly from the top variant, a saved video only from Telegram, and a finished live from its recording")
    check(shorts_js.count("function bindVideoZoom") == 1 and shorts_js.count("bindVideoZoom(") >= 3 and "zoom.scale = 2.5" in shorts_js and "shorts-zoomed" in shorts_js and "takeGesture" in shorts_js, "For You and the live player share one zoom helper")
    check("owner/tiktok-accounts.json" in (ROOT / "scripts" / "tiktok_sync.py").read_text(encoding="utf-8") and "load_added_accounts" in (ROOT / "scripts" / "media_extract.py").read_text(encoding="utf-8"), "the sync and media extract read the private account list")
    check("def room_probe(" in (ROOT / "scripts" / "tiktok_sync.py").read_text(encoding="utf-8") and "async function roomProbe(" in (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8") and "def pick_retry(" in (ROOT / "scripts" / "tiktok_record.py").read_text(encoding="utf-8"), "a blocked page or pick falls back to the cached room id before the lane declares blocked")
    sync_lanes = (ROOT / "scripts" / "tiktok_sync.py").read_text(encoding="utf-8")
    worker_lanes = (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8")
    check("/webcast/room/enter/" in sync_lanes and "def room_shaped(" in sync_lanes and "def fresh_room_id(" in sync_lanes and "def room_lanes(" in sync_lanes, "the sync tries the enter path and api-live before declaring blocked")
    check("async function fetchEnter(" in worker_lanes and "function roomShaped(" in worker_lanes and "async function apiLiveRoomId(" in worker_lanes and "/webcast/room/enter/" in worker_lanes and "api-live/user/room" in worker_lanes and "roomProbe(prev, handle)" in worker_lanes, "the worker watcher tries the enter path and api-live before declaring blocked")
    readme = (ROOT / "worker" / "README.md").read_text(encoding="utf-8")
    check("GITHUB_DISPATCH_TOKEN" in readme and "GITHUB_DISPATCH_TOKEN" in wrangler and "GITHUB_DISPATCH_TOKEN" not in (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8").split("env.GITHUB_DISPATCH_TOKEN", 1)[0], "the dispatch token is a secret the owner adds")
    dispatch_wf = (ROOT / ".github" / "workflows" / "worker-dispatch-secret.yml").read_text(encoding="utf-8")
    check("WORKER_DISPATCH_TOKEN" in readme and "WORKER_DISPATCH_TOKEN" in wrangler and ".github/worker-dispatch-secret" in (ROOT / "worker" / "README.md").read_text(encoding="utf-8"), "WORKER_DISPATCH_TOKEN is the repo secret")
    check("not set yet" in dispatch_wf and "printf '%s' \"$WORKER_DISPATCH_TOKEN\" | npx wrangler secret put GITHUB_DISPATCH_TOKEN --name viktorych-accounts" in dispatch_wf, "an empty dispatch token is skipped and a set one is copied from stdin")
    check('cron: "*/30 * * * *"' in dispatch_wf and "workflow_dispatch" in dispatch_wf and ".github/worker-dispatch-secret" in dispatch_wf and "sha256sum" in dispatch_wf and re.search(r"actions/cache/restore@(?:v4\b|[0-9a-f]{40} # v4)", dispatch_wf) is not None and re.search(r"actions/cache/save@(?:v4\b|[0-9a-f]{40} # v4)", dispatch_wf) is not None, "the dispatch secret workflow retries itself and skips a value it already copied")
    check('echo "$WORKER_DISPATCH_TOKEN"' not in dispatch_wf and "echo $WORKER_DISPATCH_TOKEN" not in dispatch_wf and "echo ${{ secrets" not in dispatch_wf and "printf '%s' \"$WORKER_DISPATCH_TOKEN\"" in dispatch_wf, "the dispatch secret workflow does not print the token")
    live_check = (ROOT / "worker" / "dispatch-live-check.mjs").read_text(encoding="utf-8")
    check("node dispatch-live-check.mjs" in dispatch_wf and "/tiktok-live.yml/dispatches" in live_check and "media-extract.yml" not in live_check and "tiktok-added.yml" not in live_check, "the worker dispatch check starts only tiktok-live.yml")
    check("console.log(process.env" not in live_check and "workers.dev" not in live_check and "status: 500" in live_check, "the dispatch check does not print the token or call the owner account")
    en = (ROOT / "i18n" / "en.js").read_text(encoding="utf-8")
    es = (ROOT / "i18n" / "es.js").read_text(encoding="utf-8")
    ru = (ROOT / "i18n" / "ru.js").read_text(encoding="utf-8")
    check('"added accounts": "added accounts"' in en and '"added accounts": "cuentas añadidas"' in es and '"added accounts": "добавленные аккаунты"' in ru, "added accounts is translated in English, Spanish, and Russian")
    check('"platform": "tiktok"' not in (ROOT / "feeds.json").read_text(encoding="utf-8"), "public feeds.json has no TikTok posts")
    tiktok_live = subprocess.run(["node", "scripts/tiktok_live_test.mjs"], cwd=ROOT, capture_output=True, text=True)
    check(tiktok_live.returncode == 0, "tiktok live parser\n" + tiktok_live.stdout + tiktok_live.stderr)
    tiktok_norm = subprocess.run([sys.executable, "scripts/tiktok_test.py"], cwd=ROOT, capture_output=True, text=True)
    check(tiktok_norm.returncode == 0, "tiktok normalize\n" + tiktok_norm.stdout + tiktok_norm.stderr)
    check("IG_SESSION" in workflow and "::add-mask::${IG_SESSION}" in workflow and "stories.json" in workflow and "publish-stories" in workflow and "git add stories.json" not in workflow, "the sync masks the story session and does not commit stories.json")
    check("VK_USER_TOKEN: ${{ secrets.VK_USER_TOKEN }}" in workflow and 'echo "::add-mask::${VK_USER_TOKEN}"' in workflow, "the sync masks the VK user token and does not print it")
    instructions = (ROOT / "docs" / "vk-stories-token.md").read_text(encoding="utf-8")
    check(instructions.rstrip().endswith("add it as the repo secret VK_USER_TOKEN in GitHub Settings > Secrets and variables > Actions."), "the VK token instructions end with the settings step")

    token = "vk1.secret.TOKENVALUE"
    stamp = int(now.timestamp())
    group = {"id": 10000041, "name": "ВКонтакте", "photo_200": "https://cdn.example/vk-face.jpg"}
    photo = {
        "id": 5,
        "owner_id": -10000041,
        "date": stamp - 3600,
        "expires_at": stamp + 3600,
        "type": "photo",
        "photo": {"sizes": [
            {"url": "http://cdn.example/small.jpg", "width": 100, "height": 100},
            {"url": "https://cdn.example/big.jpg", "width": 800, "height": 800},
        ]},
        "link": {"text": "Hello"},
    }
    video = {
        "id": 6,
        "owner_id": -10000041,
        "date": stamp - 7200,
        "type": "video",
        "video": {
            "files": {"mp4_720": "https://cdn.example/v.mp4", "hls": "https://cdn.example/v.m3u8", "mp4_1080": "http://cdn.example/nope.mp4"},
            "image": [{"url": "https://cdn.example/poster.jpg", "width": 320, "height": 180}],
        },
    }
    expired = {
        "id": 4,
        "owner_id": -10000041,
        "date": stamp - 90000,
        "expires_at": stamp - 100,
        "type": "photo",
        "photo": {"sizes": [{"url": "https://cdn.example/old.jpg", "width": 10, "height": 10}]},
    }
    http_only = {
        "id": 7,
        "owner_id": -10000041,
        "date": stamp - 1800,
        "expires_at": stamp + 3600,
        "type": "photo",
        "photo": {"sizes": [{"url": "http://cdn.example/plain.jpg", "width": 400, "height": 400}]},
    }
    vk_feed = {"id": "vk:vk", "platform": "vk", "handle": "vk", "ownerId": -10000041}
    parsed = parse_vk_stories({"response": {"items": [[photo, video, expired, http_only]], "groups": [group]}}, vk_feed, now)
    check([item["id"] for item in parsed["items"]] == ["6", "5"], "VK keeps the current video and photo, oldest first")
    check(parsed["items"][0]["type"] == "video" and parsed["items"][0]["url"] == "https://cdn.example/v.mp4" and parsed["items"][0]["poster"] == "https://cdn.example/poster.jpg", "a VK video uses the https mp4 and its poster")
    check(parsed["items"][1]["url"] == "https://cdn.example/big.jpg" and parsed["items"][1]["open"] == "https://vk.com/story-10000041_5", "a VK photo uses the largest https image and the story link")
    check(parsed["name"] == "ВКонтакте" and parsed["avatar"] == "https://cdn.example/vk-face.jpg", "the VK group supplies the name and avatar")
    check("old.jpg" not in json.dumps(parsed) and "plain.jpg" not in json.dumps(parsed) and "nope.mp4" not in json.dumps(parsed), "expired and http VK media are dropped")

    paced = []
    methods = []

    def ready(method, params):
        methods.append(method)
        return {"response": {"items": [[photo, video]], "groups": [group]}}

    filled = fetch_vk(vk_feed, token, now, call=ready, sleep=lambda delay: paced.append(delay))
    check(methods == ["stories.get"] and paced == [VK_PACE] and [item["id"] for item in filled["items"]] == ["6", "5"], "stories.getById is skipped when the files are already present")

    bare = dict(photo)
    bare["photo"] = {}
    follow = []

    def missing_then_fill(method, params):
        follow.append(method)
        if method == "stories.get":
            return {"response": {"items": [[bare]], "groups": [group]}}
        check(params.get("stories") == "-10000041_5", "stories.getById asks for the row that had no file")
        return {"response": {"items": [[photo]], "groups": [group]}}

    filled = fetch_vk(vk_feed, token, now, call=missing_then_fill, sleep=lambda delay: paced.append(delay))
    check(follow == ["stories.get", "stories.getById"] and filled["items"][0]["url"] == "https://cdn.example/big.jpg", "stories.getById fills a photo that arrived without a file")

    for code in (5, 15, 17):
        try:
            fetch_vk(vk_feed, token, now, call=lambda method, params, code=code: {"error": {"error_code": code, "error_msg": token}}, sleep=None)
        except StoryAuthError as exc:
            check(str(exc) == VK_AUTH_DETAIL and token not in str(exc), "VK error %s is an auth failure and the token stays out" % code)
        else:
            check(False, "VK error %s must stop" % code)
    try:
        vk_http("stories.delete", {}, token)
    except StoryQueryError as exc:
        check(str(exc) == VK_QUERY_DETAIL and token not in str(exc), "the user token cannot call a write method")
    else:
        check(False, "a write method must be refused")
    check(redact("access_token=" + token + "&v=5.199", token) == "access_token=redacted&v=5.199", "a VK error cannot carry the user token")

    previous_vk = [
        {
            "id": "vk:vk",
            "platform": "vk",
            "handle": "vk",
            "items": [
                {"id": "1", "type": "photo", "url": "https://cdn.example/keep.jpg", "expires": "2026-10-22T00:00:00Z"},
                {"id": "2", "type": "photo", "url": "http://cdn.example/drop.jpg", "expires": "2026-10-22T00:00:00Z"},
            ],
        },
        {
            "id": "vk:other",
            "platform": "vk",
            "handle": "other",
            "items": [{"id": "3", "type": "photo", "url": "https://cdn.example/other.jpg", "expires": "2026-10-22T00:00:00Z"}],
        },
    ]
    auth_calls = []

    def rejected_vk(method, params):
        auth_calls.append(method)
        return {"error": {"error_code": 5, "error_msg": "failed " + token}}

    accounts, health = collect(
        [vk_feed, {"id": "vk:other", "platform": "vk", "handle": "other", "ownerId": 1}],
        "",
        now,
        previous_vk,
        vk_secret=token,
        vk_call=rejected_vk,
        sleep=lambda delay: None,
    )
    check(auth_calls == ["stories.get"], "a VK auth error does not call the next account or stories.getById")
    check(health == [{"platform": "vk", "ok": False, "detail": VK_AUTH_DETAIL}] and token not in json.dumps(health), "VK errors 5, 15, and 17 are one health row and the token is absent")
    check(sorted(row["id"] for row in accounts) == ["vk:other", "vk:vk"], "an auth failure keeps the previous VK stories")
    check(all(item["url"].startswith("https://") for row in accounts for item in row["items"]), "only unexpired https VK stories are kept")

    query_calls = []

    def one_denied(method, params):
        query_calls.append(params.get("owner_id"))
        if params.get("owner_id") == -10000041:
            return {"error": {"error_code": 6, "error_msg": token}}
        return {"response": {"items": [[photo]], "groups": [group]}}

    accounts, health = collect(
        [vk_feed, {"id": "vk:other", "platform": "vk", "handle": "other", "ownerId": 1}],
        "",
        now,
        previous_vk,
        vk_secret=token,
        vk_call=one_denied,
        sleep=lambda delay: None,
        vk_lookup=lambda handle: 1,
    )
    check(query_calls == [-10000041, 1], "a non-auth VK error fails that account and continues")
    check(health == [{"platform": "vk", "ok": False, "detail": VK_QUERY_DETAIL}] and token not in json.dumps(health), "a query failure uses the fixed detail")
    by_id = {row["id"]: row for row in accounts}
    check([item["id"] for item in by_id["vk:vk"]["items"]] == ["1"], "the failed VK account keeps its previous https story")
    check(by_id["vk:other"]["items"][0]["url"] == "https://cdn.example/big.jpg", "the next VK account is still fetched")

    quiet = []

    def must_not_call(*_args):
        quiet.append("called")
        raise AssertionError("unset VK token called the API")

    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp) / "stories.json"
        dest.write_text(json.dumps({"accounts": previous_vk}), encoding="utf-8")
        health = publish(
            {"feeds": [vk_feed]},
            dest,
            now=now,
            secret="",
            vk_secret="",
            vk_call=must_not_call,
        )
        saved = json.loads(dest.read_text(encoding="utf-8"))
    check(health == [] and quiet == [] and saved["accounts"] == [], "VK_USER_TOKEN unset writes no VK stories and does not call out")
    vk_web_checks(now)
    check("border-radius: 999px" in styles and "linear-gradient" in styles and "#stories" in styles and ".story-shell" in styles and "viktorych-stories-bar-v1" in (ROOT / "stories.js").read_text(encoding="utf-8"), "story avatars are circles and the bar collapses without covering the viewer")
    row = subprocess.run(["node", "scripts/stories_test.js"], cwd=ROOT, capture_output=True, text=True)
    check(row.returncode == 0, "story tray ordering passed\n" + row.stdout + row.stderr)

    import auto_add

    def auto_fetch(url):
        if "fxtwitter.com/riverquill" in url:
            return 200, '{"screen_name":"riverquill","id":"1"}'
        if "fxtwitter.com/flintmoor" in url:
            return 200, '{"screen_name":"flintmoor"}'
        if "fxtwitter.com/freshname" in url or "fxtwitter.com/sampleagency" in url:
            return 200, '{"screen_name":"freshname"}'
        if "t.me/s/foxglen" in url:
            return 200, '<div class="tgme_widget_message_wrap" data-post="foxglen/1">foxglen</div>'
        if "vk.com/team" in url:
            return 200, "<html>team community</html>"
        if "videos.xml" in url:
            return 200, "<feed><entry></entry></feed>"
        if "instagram.com/someuser" in url:
            return 200, "<html>login</html>"
        if "fxtwitter.com/DeniedUser" in url:
            return 403, "no"
        return 404, ""

    carriers = [
        {"id": "x:copperlane", "platform": "x", "handle": "copperlane", "profile": {"name": "Copper Lane"}},
        {"id": "telegram:laneharbor", "platform": "telegram", "handle": "laneharbor", "profile": {"name": "Telegram News"}},
        {"id": "vk:vk", "platform": "vk", "handle": "vk", "profile": {"name": "VK"}},
        {"id": "instagram:birchlane", "platform": "instagram", "handle": "birchlane"},
        {"id": "youtube:northlamp", "platform": "youtube", "handle": "northlamp", "channelId": "UCsyntheticmaple00001000"},
        {"id": "x:already", "platform": "x", "handle": "already", "origin": "repost", "defaultFollow": False, "adapter": "fxtwitter"},
        {"id": "x:X", "platform": "x", "handle": "X", "defaultFollow": False, "adapter": "fxtwitter"},
    ]
    discovered = [
        {"platform": "x", "feedId": "x:copperlane", "kind": "repost", "handle": "riverquill", "author": "River Quill", "avatar": "https://pbs.twimg.com/a.jpg", "sortDate": "2026-10-20T17:22:54.000Z", "repostedBy": {"handle": "copperlane", "name": "Copper Lane", "platform": "x", "feedId": "x:copperlane"}},
        {"platform": "x", "feedId": "x:copperlane", "kind": "quote", "handle": "copperlane", "quoted": {"handle": "SomeoneElse"}},
        {"platform": "x", "feedId": "x:copperlane", "kind": "repost", "handle": "flintmoor", "author": "Brian", "repostedBy": {"handle": "copperlane", "feedId": "x:copperlane"}},
        {"platform": "telegram", "feedId": "telegram:laneharbor", "kind": "repost", "handle": "foxglen", "author": "Pavel foxglen", "forwardedFrom": {"handle": "foxglen", "name": "Pavel foxglen"}, "repostedBy": {"handle": "laneharbor", "feedId": "telegram:laneharbor", "platform": "telegram"}},
        {"platform": "telegram", "feedId": "telegram:laneharbor", "kind": "post", "handle": "laneharbor", "forwardedFrom": {"name": "Hidden person"}, "repostedBy": {"handle": "laneharbor", "feedId": "telegram:laneharbor"}},
        {"platform": "vk", "feedId": "vk:vk", "kind": "repost", "handle": "team", "author": "Team", "repostedBy": {"handle": "vk", "feedId": "vk:vk", "platform": "vk"}},
        {"platform": "vk", "feedId": "vk:vk", "kind": "repost", "handle": "12345", "repostedBy": {"handle": "vk", "feedId": "vk:vk"}},
        {"platform": "instagram", "feedId": "instagram:birchlane", "kind": "repost", "handle": "someuser", "repostedBy": {"handle": "birchlane", "feedId": "instagram:birchlane"}},
        {"platform": "youtube", "feedId": "youtube:northlamp", "kind": "repost", "handle": "OtherCreator", "channelId": "UCsyntheticmaple00006000", "author": "Other Creator", "repostedBy": {"handle": "northlamp", "feedId": "youtube:northlamp"}},
        {"platform": "x", "feedId": "x:already", "kind": "repost", "handle": "freshname", "author": "Fresh", "repostedBy": {"handle": "already", "feedId": "x:already"}},
    ]
    auto_config = {"feeds": [dict(row) for row in carriers], "removed": ["x:flintmoor"], "autoAdd": {"perRun": 5, "total": 12, "paceSeconds": 2}, "people": []}
    added_ids = auto_add.apply_auto_adds(auto_config, discovered, auto_fetch, lambda *_args: None, lambda host: ["1.1.1.1"])
    added_set = set(added_ids)
    check(added_set == {"x:riverquill", "telegram:foxglen", "vk:team", "youtube:OtherCreator"}, "reposts add the original public account and skip quotes, private, removed, and a second hop")
    sawyer = next(feed for feed in auto_config["feeds"] if feed.get("id") == "x:riverquill")
    check(sawyer.get("origin") == "repost" and sawyer.get("defaultFollow") is False and sawyer.get("limit") == 4 and sawyer["addedFrom"]["handle"] == "copperlane" and sawyer["addedFrom"]["feedId"] == "x:copperlane" and sawyer["addedFrom"]["at"].startswith("2026-10-20T17:22:54") and sawyer["adapter"] == "fxtwitter", "an auto-added account records who reposted it and is not a default follow")
    youtube_added = next(feed for feed in auto_config["feeds"] if feed.get("id") == "youtube:OtherCreator")
    check(youtube_added.get("channelId") == "UCsyntheticmaple00006000" and youtube_added.get("adapter") == "youtube_rss", "a shared YouTube channel is added by its channel id")
    again = auto_add.apply_auto_adds(auto_config, discovered, auto_fetch, lambda *_args: None, lambda host: ["1.1.1.1"])
    check(again == [], "a later sync does not add the same account twice")
    capped = {"feeds": [dict(row) for row in carriers], "removed": [], "autoAdd": {"perRun": 1, "total": 12}, "people": []}
    one = auto_add.apply_auto_adds(capped, discovered, auto_fetch, lambda *_args: None, lambda host: ["1.1.1.1"])
    check(len(one) == 1, "a sync adds at most perRun new accounts")
    full = {"feeds": [dict(row) for row in carriers], "removed": [], "autoAdd": {"perRun": 5, "total": 1}, "people": []}
    check(auto_add.apply_auto_adds(full, discovered, auto_fetch, lambda *_args: None, lambda host: ["1.1.1.1"]) == [], "the total cap counts accounts already added from reposts")
    denied_posts = [
        {"platform": "x", "feedId": "x:copperlane", "kind": "repost", "handle": "DeniedUser", "author": "Denied", "repostedBy": {"handle": "copperlane", "feedId": "x:copperlane"}},
        {"platform": "telegram", "feedId": "telegram:laneharbor", "kind": "repost", "handle": "foxglen", "forwardedFrom": {"handle": "foxglen", "name": "Pavel foxglen"}, "repostedBy": {"handle": "laneharbor", "feedId": "telegram:laneharbor"}},
    ]
    denied_config = {"feeds": [dict(row) for row in carriers if row["id"] in ("x:copperlane", "telegram:laneharbor")], "autoAdd": {"perRun": 5, "total": 12}, "people": []}
    denied_ids = auto_add.apply_auto_adds(denied_config, denied_posts, auto_fetch, lambda *_args: None, lambda host: ["1.1.1.1"])
    check(denied_ids == ["telegram:foxglen"], "a 403 stops more checks on that platform and still adds other platforms")
    profiles = [
        {"id": "x:riverquill", "handle": "riverquill", "configured": True},
        {"id": "x:copperlane", "handle": "copperlane", "configured": False},
        {"id": "x:X", "handle": "X", "configured": True},
    ]
    auto_add.stamp_profiles(profiles, auto_config["feeds"])
    stamped = {row["id"]: row for row in profiles}
    check(stamped["x:riverquill"]["configured"] is False and stamped["x:riverquill"]["origin"] == "repost" and stamped["x:riverquill"]["addedFrom"]["handle"] == "copperlane", "the published profile stays Added and keeps the repost note")
    check(stamped["x:copperlane"]["configured"] is True and "origin" not in stamped["x:copperlane"], "a normal source stays a default follow")
    check(stamped["x:X"]["configured"] is False and "origin" not in stamped["x:X"], "defaultFollow false stays out of Following")
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        base = folder / "feeds.config.json"
        incoming = folder / "incoming.json"
        base.write_text('{\n  "cap": 300,\n  "autoAdd": {"perRun": 3, "total": 12},\n  "removed": ["x:flintmoor"],\n  "feeds": [\n    {"id": "x:copperlane", "platform": "x", "handle": "copperlane"}\n  ]\n}\n', encoding="utf-8")
        evil = json.loads(json.dumps(sawyer))
        evil["source_urls"] = ["http://127.0.0.1/secret"]
        incoming.write_text(json.dumps({"feeds": [sawyer, evil]}), encoding="utf-8")
        merged_ids = auto_add.merge_into_file(base, incoming)
        merged = json.loads(base.read_text(encoding="utf-8"))
        check(merged_ids == ["x:riverquill"] and merged["feeds"][0]["id"] == "x:copperlane" and merged["feeds"][1]["id"] == "x:riverquill" and merged["cap"] == 300, "the config commit appends the repost source and drops a rewritten URL")
        blocked = dict(sawyer)
        blocked["id"] = "x:flintmoor"
        blocked["handle"] = "flintmoor"
        blocked["profile"] = {"name": "Brian", "url": "https://x.com/flintmoor"}
        from follow_request import entry_for as entry_for_feed
        blocked = entry_for_feed({"platform": "x", "handle": "flintmoor", "url": "https://x.com/flintmoor", "channelId": ""})
        blocked["origin"] = "repost"
        blocked["defaultFollow"] = False
        incoming.write_text(json.dumps({"feeds": [blocked]}), encoding="utf-8")
        check(auto_add.merge_into_file(base, incoming) == [], "a removed account is not committed again")


def feed_order_checks() -> None:
    import subprocess
    from datetime import datetime, timezone

    from adapters.common import dedupe_posts, order_ms, parse_time, stamp_activity

    moment = datetime(2026, 10, 27, tzinfo=timezone.utc)
    same = datetime(2026, 10, 21, 17, tzinfo=timezone.utc)
    check(parse_time("2026-10-21T17:00:00") == same, "a timestamp without an offset is UTC")
    check(parse_time("2026-10-21 17:00:00") == same, "a VK wall time is UTC")
    check(parse_time("Wed Oct 21 17:00:00 +0000 2026") == same, "an X created_at is UTC")
    check(parse_time("1761066000.0") == parse_time(1761066000), "a fractional unix time is a timestamp")
    later = {"id": "b", "platform": "x", "date": "2026-10-21T17:00:00Z"}
    earlier = {"id": "a", "platform": "x", "date": "2026-10-21T19:00:00+03:00"}
    future = {"id": "z", "platform": "x", "date": "2099-01-01T00:00:00Z"}
    missing = {"id": "m", "platform": "x", "date": ""}
    repost = {"id": "r", "platform": "x", "kind": "repost", "date": "2026-10-20T00:00:00Z", "sortDate": "2026-10-21T18:00:00Z", "repostedBy": {"handle": "someone"}}
    duplicate = {"id": "yt:video:abcdefghijk", "platform": "youtube", "url": "https://youtu.be/abcdefghijk", "date": "2026-10-21T17:00:00+00:00"}
    mirror = {"id": "abcdefghijk", "platform": "youtube", "date": "2026-10-21T18:00:00Z"}
    check(order_ms(later, now=moment) > order_ms(earlier, now=moment), "17:00 UTC sorts ahead of 16:00 UTC even when the offset reads 19:00")
    check(order_ms(future, now=moment) == 0 and order_ms(missing, now=moment) == 0, "a future or missing time sorts last")
    check(order_ms(repost, now=moment) > order_ms(later, now=moment), "a repost is ordered by its repost time")
    ranked = dedupe_posts([earlier, future, later, missing, repost, duplicate, mirror])
    check([post["id"] for post in ranked] == ["r", "abcdefghijk", "b", "a", "z", "m"], "mixed sources, reposts, and mirrors keep one row in UTC order")
    check(next(post for post in ranked if post["id"] == "abcdefghijk")["date"] == "2026-10-21T17:00:00+00:00", "dedupe keeps the earlier real publish time")
    import r2_catalog

    class _Path:
        def __init__(self, stamp):
            self._stamp = stamp

        def stat(self):
            class _Stat:
                pass

            row = _Stat()
            row.st_mtime = self._stamp
            return row

    ordered = r2_catalog.ordered_keys({
        "archive/2020-01.json": _Path(10),
        "feeds.json": _Path(1),
        "data/communities/a.json": _Path(50),
        "people.json": _Path(2),
    })
    check([key for key, _path in ordered] == ["feeds.json", "people.json", "data/communities/a.json", "archive/2020-01.json"], "the live catalog is uploaded before archive JSON, newest extras first")
    pinned_first = [
        {"id": "pin", "platform": "x", "handle": "tabfixture", "kind": "post", "pinned": True, "date": "2020-01-01T00:00:00Z", "pinAt": "2020-01-01T00:00:00Z"},
        {"id": "repost:tabfixture:2", "platform": "x", "kind": "repost", "handle": "otheracct", "date": "2026-10-20T00:00:00Z", "repostedBy": {"handle": "tabfixture"}},
        {"id": "3", "platform": "x", "handle": "tabfixture", "kind": "post", "date": "2026-10-27T11:00:00Z"},
    ]
    stamp_activity(pinned_first, datetime(2026, 10, 27, 12, tzinfo=timezone.utc))
    check(pinned_first[0]["id"] == "repost:tabfixture:2" and pinned_first[-1]["id"] == "pin" and pinned_first[-1]["date"] == "", "a pinned row is not treated as the newest post")
    check(pinned_first[0].get("sortDate", "") > "2026-10-27T11:00:00Z" and pinned_first[0]["sortDate"] < "2026-10-27T12:00:00Z", "a repost listed under a pin is stamped between the fetch and the next real post")
    proc = subprocess.run(["node", str(ROOT / "scripts" / "feed_order_test.mjs")], check=False)
    check(proc.returncode == 0, "feed order fixtures")
    for_you = subprocess.run(["node", str(ROOT / "scripts" / "for_you_test.mjs")], check=False)
    check(for_you.returncode == 0, "for you ranking fixtures")
    custom = subprocess.run(["node", str(ROOT / "scripts" / "custom_tab_test.mjs")], check=False)
    check(custom.returncode == 0, "custom tab freshness fixtures")
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    check("shared/feed-order.js" in (ROOT / "index.html").read_text(encoding="utf-8") and "./shared/feed-order.js" in (ROOT / "sw.js").read_text(encoding="utf-8") and "shared/feed-order.js" in deployed_paths() and "python3 scripts/assemble_site.py --site _site" in (ROOT / ".github" / "workflows" / "sync.yml").read_text(encoding="utf-8"), "the feed order helper is published with the shell")
    check("shared/for-you.js" in (ROOT / "index.html").read_text(encoding="utf-8") and "./shared/for-you.js" in (ROOT / "sw.js").read_text(encoding="utf-8") and "./shared/for-you-weights.js" in (ROOT / "sw.js").read_text(encoding="utf-8"), "the For You ranker is published with the shell")
    order_js = (ROOT / "shared" / "feed-order.js").read_text(encoding="utf-8")
    check('trn("showPosts"' in app and "function mergeCatalog(" in app and "function revealMoreTimeline(" in app and "followsPost" in order_js, "new posts merge in place and the Following tab uses the signed-in accounts")
    check("function hydrateTab(" in app and "function keepTabRows(" in app and "function tabStillLoading(" in app and "TAB_RETRY_MS" in app and "custom_tab_reload_test.mjs" in (ROOT / "scripts" / "home_tabs_test.mjs").read_text(encoding="utf-8"), "custom tabs keep last good posts, show loading instead of empty, and retry with backoff")
    unfurl_js = (ROOT / "worker" / "src" / "unfurl.js").read_text(encoding="utf-8")
    check("function previewLinkOf(" in app and "function linkImagesBlocked(" in app and "lc-large" in app and "function fxCard(" in app and "/v1/unfurl?url=" in app and "handleUnfurl" in (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8") and "unfurl/" in unfurl_js and "safeTarget" in unfurl_js and "link_preview_test.mjs" in (ROOT / "scripts" / "boot_speed_test.mjs").read_text(encoding="utf-8"), "links show X-style preview cards, unfurled once through the Worker cache, with no pictures when saving data")
    check("function customTabFeeds(" in app and "function timelineFeeds(" in app and "timelineFeeds()" in app and "function hydrateTabSnapshots(" in app and "refreshTab" in order_js, "custom tabs use the same UTC refresh as Following")
    fresh_js = (ROOT / "shared" / "home-fresh.js").read_text(encoding="utf-8")
    page = (ROOT / "index.html").read_text(encoding="utf-8")
    worker = (ROOT / "sw.js").read_text(encoding="utf-8")
    fresh_node = subprocess.run(["node", str(ROOT / "scripts" / "home_fresh_test.mjs")], check=False)
    check(fresh_node.returncode == 0, "home snapshot freshness fixtures")
    check("shared/home-fresh.js" in page and "./shared/home-fresh.js" in worker and "shared/home-fresh.js" in deployed_paths(), "the home freshness helper is published with the shell")
    check("PERIODIC_MIN_MS = 15 * 60 * 1000" in fresh_js and "VISIBLE_MS = 60 * 1000" in fresh_js and "home-refresh-start" in page and "X-Feed-Refresh" in page and "function refreshData(" in worker and "minInterval: 15 * 60 * 1000" in app and "pageshow" in app and "function saveHomeSnapshot(" in app, "a stale snapshot refreshes in the background and on the way back")
    lock_notes = subprocess.run(["node", str(ROOT / "scripts" / "tiktok_lock_test.mjs")], check=False)
    check(lock_notes.returncode == 0, "locked account notifications stay hidden")
    check("shared/tiktok-lock.js" in page and "./shared/tiktok-lock.js" in worker and "shared/tiktok-lock.js" in deployed_paths(), "the tiktok lock helper is published with the shell")


def gdrive_checks() -> None:
    import subprocess

    import gdrive_backup

    doc = (ROOT / "docs" / "gdrive-backup.md").read_text(encoding="utf-8")
    workflow = (ROOT / ".github" / "workflows" / "gdrive-backup.yml").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    check('cron: "17 9 * * *"' in workflow and "workflow_dispatch" in workflow and "timeout-minutes: 40" in workflow and "group: gdrive-backup" in workflow, "the Drive backup is daily, manual, and capped at 40 minutes")
    check("GDRIVE_RCLONE_TOKEN" in workflow and 'echo "$GDRIVE' not in workflow and "echo $GDRIVE" not in workflow and 'echo "${GDRIVE' not in workflow, "the Drive workflow uses the secret and does not print it")
    check("v1.75.2" in workflow and "v1.75.2" in doc and "drive.file" in doc and ".\\rclone.exe authorize \"drive\" $blob" in doc, "the token steps pin rclone and the drive.file authorize command")
    check("https://github.com/ViktorychGroup/ViktorychApp/settings/secrets/actions/new" in doc and "GDRIVE_RCLONE_TOKEN" in doc and "service account" in doc.lower() and "account data" in doc.lower(), "the token steps name the GitHub secret page and refuse a service account")
    check("docs/gdrive-backup.md" in readme and "GDRIVE_RCLONE_TOKEN" in readme and "account data is not uploaded" in readme.lower(), "the readme points at the Drive backup and leaves account data out")
    env = os.environ.copy()
    env.pop("GDRIVE_RCLONE_TOKEN", None)
    skipped = subprocess.run([sys.executable, str(ROOT / "scripts" / "gdrive_backup.py")], capture_output=True, text=True, env=env, check=False)
    check(skipped.returncode == 0 and "skipping the upload" in skipped.stdout, "a missing Drive token skips the upload")
    env["GDRIVE_RCLONE_TOKEN"] = json.dumps({"client_id": "cid-secret-value", "client_secret": "csec-secret-value", "scope": "drive", "token": {"access_token": "at-secret-value", "refresh_token": "rt-secret-value"}})
    rejected = subprocess.run([sys.executable, str(ROOT / "scripts" / "gdrive_backup.py")], capture_output=True, text=True, env=env, check=False)
    combined = rejected.stdout + rejected.stderr
    check(rejected.returncode == 1 and "not a drive.file user token" in rejected.stdout and "cid-secret-value" not in combined and "csec-secret-value" not in combined and "at-secret-value" not in combined and "rt-secret-value" not in combined, "a full-drive token is rejected and is not printed")
    parsed = gdrive_backup.parse_secret(json.dumps({"client_id": "cid-secret-value", "client_secret": "csec-secret-value", "scope": "drive.file", "token": "{\"access_token\":\"at-secret-value\",\"refresh_token\":\"rt-secret-value\"}"}))
    rendered = gdrive_backup.rclone_config_text(parsed)
    check("scope = drive.file" in rendered and "rt-secret-value" in rendered and "rt-secret-value" not in gdrive_backup.scrub("saw rt-secret-value", gdrive_backup.secret_values(parsed)), "the rclone config is drive.file and logs are scrubbed")
    check(gdrive_backup.account_data_url("https://pub-example.r2.dev/media/avatars/a.png") and gdrive_backup.account_data_url("https://app.workers.dev/v1/me") and not gdrive_backup.account_data_url("https://pub-example.r2.dev/music/song/cover.png"), "account avatars and the worker API stay off Drive")
    store = "https://viktorych-accounts.viktorych-accounts.workers.dev/v1/archive/" + ("ab" * 32) + ".mp4"
    check(gdrive_backup.archive_store_url(store) and not gdrive_backup.account_data_url(store), "an archive copy on the accounts worker is not account data")
    music = json.loads((ROOT / "data" / "music.json").read_text(encoding="utf-8"))
    songs = gdrive_backup.music_plan(music)
    check(any(row["kind"] == "covers" and row["label"] == "america-dont-sit-still" for row in songs) and any(row["kind"] == "music" and row["playlist"] for row in songs), "song audio and covers are planned for Drive")
    poisoned = gdrive_backup.music_plan({"songs": [{"id": "x", "cover": "https://cdn.workers.dev/media/avatars/a.png", "stream": "https://cdn.workers.dev/v1/song.m3u8"}]})
    check(poisoned == [], "a song entry that points at account data is dropped")
    loops = gdrive_backup.loop_urls_from_config(json.loads((ROOT / "feeds.config.json").read_text(encoding="utf-8")))
    radio = gdrive_backup.radio_plan(loops)
    check(loops and loops[0].endswith("/loop/current.json") and radio and radio[0]["kind"] == "radio" and radio[0]["playlist"], "the radio loop is planned for Drive")
    variant, segments, extras = gdrive_backup.hls_media("#EXTM3U\n#EXTINF:6,\nseg-0.ts\n#EXTINF:6,\nseg-1.ts\n", "https://pub-example.r2.dev/loop/index.m3u8")
    check(variant == "" and extras == [] and segments == ["https://pub-example.r2.dev/loop/seg-0.ts", "https://pub-example.r2.dev/loop/seg-1.ts"], "radio segments resolve against the playlist")
    encrypted = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1\n#EXTINF:6,\na.m4s\n"
    _variant, parts, assets = gdrive_backup.hls_media(encrypted, "https://pub-example.r2.dev/music/abc/index.m3u8")
    saved = gdrive_backup.segment_items({"kind": "music", "logical": "music:abc:playlist", "hosts": ("r2.dev",), "label": "abc"}, assets + parts, encrypted.encode(), "https://pub-example.r2.dev/music/abc/index.m3u8")
    paths = [row["path"] for row in saved]
    check(paths == ["music/abc/index.m3u8", "music/abc/init.mp4", "music/abc/key.bin", "music/abc/a.m4s"], "a song keeps its playlist, init file, key, and audio in one folder")
    blocked, _base = gdrive_backup.playlist_source(b'{"url":"https://cdn.workers.dev/loop/index.m3u8"}', "https://pub-example.r2.dev/loop/current.json", ("r2.dev",))
    check(blocked is None, "a radio manifest that leaves the music host is dropped")
    policy = __import__("ia_backup").load_ia_policy()
    widened = __import__("ia_backup").load_ia_policy({"tiktok_allow": ["lockclip"]})
    posts = [
        {"platform": "tiktok", "handle": "lockclip", "statusId": "123", "media": [{"type": "video", "url": "https://v16.tiktokcdn.com/a.mp4", "poster": "https://p16.tiktokcdn.com/a.jpg"}]},
        {"platform": "vk", "id": "9", "media": [{"type": "video", "url": "https://userapi.com/v.mp4"}, {"type": "photo", "url": "https://userapi.com/p.jpg"}]},
        {"platform": "youtube", "id": "abc", "feedId": "youtube:northlamp", "media": [{"type": "video", "url": "https://archive.org/download/x/y.mp4"}]},
    ]
    tiktok = gdrive_backup.tiktok_plan(posts, policy)
    check(len(tiktok) == 2 and gdrive_backup.tiktok_plan(posts, widened) == [], "TikTok that is not allowlisted is backed up, and lockclip stays off while the list is empty")
    manifest = {
        "files": [
            {"u": "https://video.twimg.com/a.mp4", "a": "https://archive.org/download/xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/a.mp4", "k": "video"},
            {"u": "https://i.ytimg.com/vi/abc.jpg", "a": "https://archive.org/download/xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/b.jpg", "k": "photo"},
        ],
        "posts": {"x:1": [0], "youtube:abc": [1]},
    }
    media = gdrive_backup.media_plan(posts, manifest, policy)
    check(any(row["logical"].endswith("/a.mp4") for row in media) and not any("b.jpg" in row["logical"] or row["label"].startswith("youtube:") for row in media) and any(row["label"] == "vk:9" for row in media), "Drive keeps rejected videos and leaves allowlisted YouTube files out")
    sizes = {media[0]["logical"]: 10, media[-1]["logical"]: 90}
    ordered = [row for row in gdrive_backup.sort_media(media, sizes) if row["kind"] == "media"]
    check(len(ordered) == 2 and sizes[ordered[0]["logical"]] == 90 and sizes[ordered[1]["logical"]] == 10, "the larger video is uploaded before the smaller one")
    known = {"v": 1, "files": [{"logical": songs[0]["logical"], "sha256": "ab" * 32, "path": "covers/" + ("ab" * 32) + ".png"}]}
    check(songs[0]["logical"] in gdrive_backup.known_ids(known) and ("ab" * 32) in gdrive_backup.known_hashes(known), "a stored hash and logical id are treated as already uploaded")
    import cf_pages_prepare
    import cf_pages_deploy
    import cf_kv_bind
    import cf_web_analytics
    check(cf_pages_prepare.selftest() == 0, "the Pages mirror stays inside the file cap and keeps the shell")
    check(cf_pages_deploy.selftest() == 0, "a Pages permission failure skips without printing a token")
    check(cf_kv_bind.selftest() == 0, "a KV permission failure removes only the cache binding")
    check(cf_web_analytics.selftest() == 0, "the analytics beacon is added only with a public token")
    import pages_guard
    pages_sync = (ROOT / ".github" / "workflows" / "sync.yml").read_text(encoding="utf-8")
    pages_publish = (ROOT / "scripts" / "discord_publish.py").read_text(encoding="utf-8")
    check(
        pages_guard.selftest() == 0
        and pages_sync.count("group: pages-deploy") == 2
        and "pages_guard.py pick-head" in pages_sync
        and "pages_guard.py superseded" in pages_sync
        and "app-shell-version-${{ github.run_id }}-${{ github.run_attempt }}" in pages_sync
        and "github-pages-${{ github.run_id }}-${{ github.run_attempt }}" in pages_sync
        and "wait_until_free" in pages_publish
        and "_keep_live_version" in pages_publish,
        "Pages deploys share one lock, build from main's head, never roll version.json back, and rerun without artifact clashes",
    )
    sync = (ROOT / ".github" / "workflows" / "sync.yml").read_text(encoding="utf-8")
    smoke = (ROOT / ".github" / "workflows" / "smoke.yml").read_text(encoding="utf-8")
    check("wrangler pages deploy" in sync and "viktorychapp" in sync and "cf_pages_deploy.py" in sync and "cf_pages_prepare.py" in sync and "shared/mirror.js" in deployed_paths() and "smoke_page.mjs --site _mirror" in sync and "smoke_page.mjs --site _site" in smoke and "smoke_page.mjs --site _mirror" in smoke, "the Pages upload is the generated bundle and the smoke check loads that output")
    check("ViktorychMirror" in (ROOT / "sw.js").read_text(encoding="utf-8") and 'scope: "./"' in (ROOT / "app.js").read_text(encoding="utf-8"), "the service worker can fail over to the other origin")
    wrangler_text = (ROOT / "worker" / "wrangler.toml").read_text(encoding="utf-8")
    check("head_sampling_rate = 1" in wrangler_text and 'binding = "CACHE"' in wrangler_text and 'crons = ["* * * * *"]' in wrangler_text, "workers logs and the KV cache are configured beside the existing cron")
    check("backups/d1/" in (ROOT / "worker" / "src" / "d1-backup.js").read_text(encoding="utf-8"), "the daily D1 export keeps its objects under backups/d1/")
    import secret_scan
    check(secret_scan.selftest() == 0, "the secret and personal-data scan catches its samples")
    check(secret_scan.report(secret_scan.scan(secret_scan.git_files(False), False)) == 0, "no secret or personal data in the tracked tree")


if __name__ == "__main__":
    main()
