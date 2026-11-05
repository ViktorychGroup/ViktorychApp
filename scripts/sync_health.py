#!/usr/bin/env python3
"""Open one Sync problem issue when a sync, a source, or the deploy is unhealthy.

A source that returns nothing starts a clock. The issue opens only after that
clock reaches six hours, so a single empty fetch does not email anyone. The
same issue is edited when the problem changes and closed once the sync is
healthy. GitHub emails the repository owner.
"""

from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

STALE_SECONDS = 6 * 60 * 60
TITLE = "Sync problem"
ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "sync-report.json"


def record_source(health: dict, feed_id: str, ok: bool, now: str, detail: str = "") -> None:
    row = dict(health.get(feed_id) or {})
    row["checked"] = now
    if ok:
        row["ok"] = now
        row.pop("emptySince", None)
        row.pop("detail", None)
    else:
        row.setdefault("emptySince", now)
        if detail:
            row["detail"] = detail[:300]
    health[feed_id] = row


def prune_health(health: dict, feed_ids) -> dict:
    keep = set(feed_ids)
    keep.add("discord")
    return {key: value for key, value in health.items() if key in keep}


def write_report(doc: dict, path: Path = REPORT) -> None:
    health = doc.get("sourceHealth") or {}
    feeds = []
    for feed_id in sorted(health):
        row = health.get(feed_id) or {}
        feeds.append({
            "id": feed_id,
            "ok": row.get("ok") or "",
            "emptySince": row.get("emptySince") or "",
            "detail": row.get("detail") or "",
        })
    stories = []
    for row in doc.get("storiesHealth") or []:
        if not isinstance(row, dict):
            continue
        stories.append({
            "platform": row.get("platform") or "",
            "ok": bool(row.get("ok")),
            "detail": (row.get("detail") or "")[:300],
        })
    parse = []
    for key, row in sorted((doc.get("parseHealth") or {}).items()):
        if isinstance(row, dict):
            parse.append({
                "source": key,
                "items": row.get("items") or 0,
                "rate": row.get("rate"),
                "drift": bool(row.get("drift")),
                "top": list(row.get("top") or [])[:3],
            })
    path.write_text(
        json.dumps({"updated": doc.get("updated") or "", "feeds": feeds, "stories": stories, "parse": parse}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _when(value: str):
    text = (value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment


def problems(report, now: str, build_result: str = "success", deploy_result: str = "success", accounts_result: str = "success", refresh_result: str = "") -> list[str]:
    lines = []
    build_result = (build_result or "").lower()
    deploy_result = (deploy_result or "").lower()
    accounts_result = (accounts_result or "").lower()
    refresh_result = (refresh_result or "").lower()
    if build_result in ("failure", "cancelled"):
        lines.append("The sync failed.")
    if deploy_result in ("failure", "cancelled"):
        lines.append("The Pages deploy failed.")
    if accounts_result in ("failure", "cancelled"):
        lines.append("The Accounts deploy failed, so Pages was not updated.")
    if refresh_result in ("failure", "cancelled"):
        lines.append("The feed refresh failed.")
    if report is None:
        # A shell deploy skips the refresh, so it has no new report. Callers
        # that omit refresh_result keep the old "missing report" sentence.
        if refresh_result == "success" or (not refresh_result and build_result == "success"):
            lines.append("The sync report is missing.")
        return lines
    moment = _when(now)
    for feed in report.get("feeds") or []:
        since = feed.get("emptySince") or ""
        started = _when(since)
        if not started or not moment:
            continue
        if (moment - started).total_seconds() < STALE_SECONDS:
            continue
        detail = (feed.get("detail") or "").strip()
        line = (feed.get("id") or "a feed") + " has returned nothing since " + since + "."
        if detail:
            line += " " + detail
        lines.append(line)
    for row in report.get("stories") or []:
        if not isinstance(row, dict) or row.get("ok") is not False:
            continue
        detail = (row.get("detail") or "Stories sync failed.").strip()
        if detail:
            lines.append(detail)
    for row in report.get("parse") or []:
        if not isinstance(row, dict) or not row.get("drift"):
            continue
        rate = row.get("rate")
        pct = f"{round(100 * float(rate))}%" if isinstance(rate, (int, float)) else "?"
        line = f"{row.get('source') or 'a source'} parsed only {pct} of {row.get('items') or 0} new items twice in a row; its format may have changed."
        top = "; ".join(row.get("top") or [])
        if top:
            line += " Top reasons: " + top
        lines.append(line)
    return lines


def body_for(lines: list[str], run_url: str) -> str:
    bullets = "\n".join("- " + line for line in lines)
    return "The sync is not healthy.\n\n" + bullets + "\n\nRun: " + run_url + "\n"


def same_problem(existing: str, lines: list[str]) -> bool:
    found = []
    for raw in (existing or "").splitlines():
        text = raw.strip()
        if text.startswith("- "):
            found.append(text[2:].strip())
    return found == list(lines)


WATCHDOG_URL = "https://viktorych-accounts.viktorych-accounts.workers.dev/v1/watchdog"
SITE_TITLE = "Site health problem"
SITE_MIN_AGE = 2 * 60 * 60


def site_lines(summary, now_ms: float) -> list[str]:
    """Watchdog problems that lasted two hours, as issue bullets."""
    lines = []
    if not isinstance(summary, dict):
        return lines
    for row in summary.get("problems") or []:
        if not isinstance(row, dict):
            continue
        since = float(row.get("since") or 0)
        if since and now_ms - since < SITE_MIN_AGE * 1000:
            continue
        text = str(row.get("text") or "").strip()
        if text:
            lines.append(text[:300])
    return sorted(set(lines))


def fetch_watchdog(url: str = WATCHDOG_URL):
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": "feeds-sync", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as res:
        return json.loads(res.read().decode("utf-8"))


def site_body(lines: list[str]) -> str:
    bullets = "\n".join("- " + line for line in lines)
    return ("The Worker watchdog found problems that lasted over two hours.\n\n" + bullets +
            "\n\nWhat to do: docs/RUNNING-WITHOUT-BOT.md\nThis issue closes itself once they are gone.\n")


def plan(lines: list[str], open_issues: list[dict], title: str = TITLE) -> dict:
    matches = [item for item in open_issues if (item.get("title") or "") == title]
    extra = [item.get("number") for item in matches[1:]]
    if not lines:
        if not matches:
            return {"action": "none", "extra": []}
        return {"action": "close", "number": matches[0].get("number"), "extra": extra}
    if not matches:
        return {"action": "open", "extra": []}
    current = matches[0]
    if same_problem(current.get("body") or "", lines):
        return {"action": "none", "number": current.get("number"), "extra": extra}
    return {"action": "edit", "number": current.get("number"), "extra": extra}


def _gh(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(["gh", *args], check=True, text=True, capture_output=True)


def _list_open(repo: str) -> list[dict]:
    result = _gh(["issue", "list", "--repo", repo, "--state", "open", "--limit", "50", "--json", "number,title,body"])
    data = json.loads(result.stdout or "[]")
    return data if isinstance(data, list) else []


def apply(decision: dict, lines: list[str], run_url: str, repo: str, title: str = TITLE) -> None:
    action = decision.get("action")
    if action == "open":
        _gh(["issue", "create", "--repo", repo, "--title", title, "--body", body_for(lines, run_url)])
    elif action == "edit":
        _gh(["issue", "edit", str(decision["number"]), "--repo", repo, "--body", body_for(lines, run_url)])
    elif action == "close":
        number = str(decision["number"])
        _gh(["issue", "comment", number, "--repo", repo, "--body", "Sync is healthy again."])
        _gh(["issue", "close", number, "--repo", repo, "--reason", "completed"])
    for number in decision.get("extra") or []:
        subprocess.run(["gh", "issue", "close", str(number), "--repo", repo, "--reason", "not planned"], check=False)


def main() -> int:
    build_result = os.environ.get("BUILD_RESULT") or "success"
    deploy_result = os.environ.get("DEPLOY_RESULT") or "success"
    accounts_result = os.environ.get("ACCOUNTS_RESULT") or "success"
    refresh_result = os.environ.get("REFRESH_RESULT") or ""
    run_url = os.environ.get("RUN_URL") or ""
    repo = os.environ.get("REPO") or ""
    now = os.environ.get("NOW") or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    report = None
    if REPORT.is_file():
        try:
            report = json.loads(REPORT.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            report = None
    title = os.environ.get("PROBLEM_TITLE") or TITLE
    lines = problems(report, now, build_result, deploy_result, accounts_result, refresh_result)
    print("\n".join(lines) or "healthy")
    if not repo:
        return 0
    decision = plan(lines, _list_open(repo), title=title)
    apply(decision, lines, run_url, repo, title=title)
    print(decision.get("action"))
    # The Worker watchdog's findings, in a bot-authored issue so GitHub
    # emails the owner (an issue the owner's own token opens sends no mail).
    try:
        summary = fetch_watchdog(os.environ.get("WATCHDOG_URL") or WATCHDOG_URL)
        site = site_lines(summary, datetime.now(timezone.utc).timestamp() * 1000)
        open_now = _list_open(repo)
        site_plan = plan(site, open_now, SITE_TITLE)
        action = site_plan.get("action")
        if action == "open":
            _gh(["issue", "create", "--repo", repo, "--title", SITE_TITLE, "--body", site_body(site)])
        elif action == "edit":
            _gh(["issue", "edit", str(site_plan["number"]), "--repo", repo, "--body", site_body(site)])
        elif action == "close":
            _gh(["issue", "close", str(site_plan["number"]), "--repo", repo, "--reason", "completed"])
        print("site health " + str(action))
    except Exception as exc:
        print(f"[site health] skipped: {type(exc).__name__}")
    try:
        import discord_alert

        kind, reason = discord_alert.attention(report)
        if kind == "paused":
            discord_alert.mark(True, reason)
        elif kind == "ok":
            discord_alert.mark(False, "")
    except Exception:
        print("[discord] could not update the account issue")
    return 0


if __name__ == "__main__":
    try:
        from log_redact import auto as _redact_logs

        _redact_logs()
    except ImportError:
        pass
    raise SystemExit(main())
