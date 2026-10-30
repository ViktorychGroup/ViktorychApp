#!/usr/bin/env python3
"""Keep GitHub Pages deploys from overwriting each other.

Sync feeds and Discord live both publish Pages. They do not share a job, so
this helper is the shared lock and the freshness check:

  pick-head   Which commit the Sync build assembles. main's head when its
              Accounts deploy is done (or it has none), else this run's commit.
              Writes sha=... to GITHUB_OUTPUT.
  superseded  Whether a newer app shell than --sha is already live. Writes
              go=true|false to GITHUB_OUTPUT. A stale run then skips its
              version publish instead of putting old files back.
  busy        Exit 3 when a Sync feeds Pages job (deploy or publish-version) is
              queued or running, or finished after --since. Discord live waits
              on this before it publishes and checks again right before the
              Pages deployment is created.

Every network miss falls back to the old behavior, so a GitHub API hiccup
never blocks a deploy.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UA = "viktorych-pages-guard"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SW_RE = re.compile(r'const VERSION = "viktorych-[a-z0-9]+-([0-9a-f]{40})"')
ACTIVE = {"queued", "in_progress", "waiting", "pending", "requested"}
PAGES_JOBS = {"deploy", "publish-version"}
# Commits that only touch these paths do not change the app shell.
DATA_ONLY = ("data/communities/", "feeds.json", "stories.json", "people.json", "suggestions.json")


def _get(path: str, token: str, timeout: float = 20):
    request = urllib.request.Request(
        "https://api.github.com" + path,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "User-Agent": UA,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def _git(*args: str) -> str:
    try:
        return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=60, check=True).stdout.strip()
    except Exception:
        return ""


def _is_ancestor(old: str, new: str) -> bool:
    try:
        return subprocess.run(["git", "merge-base", "--is-ancestor", old, new], cwd=ROOT, timeout=60).returncode == 0
    except Exception:
        return False


def _output(key: str, value: str) -> None:
    print(f"{key}={value}")
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"{key}={value}\n")


def _stamp(value: str) -> float:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def shell_changed(names: list[str]) -> bool:
    for name in names:
        name = name.strip()
        if not name:
            continue
        if name.startswith(DATA_ONLY[0]) or name in DATA_ONLY[1:]:
            continue
        return True
    return False


def live_shell_sha(text: str) -> str:
    match = SW_RE.search(text or "")
    return match.group(1) if match else ""


def newer_shell(compared: dict) -> bool:
    """True when the compare (this run...live) says live is ahead with shell changes."""
    if not isinstance(compared, dict) or compared.get("status") != "ahead":
        return False
    files = compared.get("files")
    if not isinstance(files, list) or len(files) >= 300:
        return True
    return shell_changed([str(item.get("filename") or "") for item in files if isinstance(item, dict)])


def jobs_busy(jobs: list, since: float) -> bool:
    for job in jobs or []:
        if not isinstance(job, dict) or job.get("name") not in PAGES_JOBS:
            continue
        status = job.get("status") or ""
        if status in ACTIVE:
            return True
        if status == "completed" and job.get("conclusion") == "success" and since and _stamp(job.get("completed_at") or "") >= since:
            return True
    return False


def busy(repo: str, token: str, since: float = 0.0) -> bool:
    if not repo or not token:
        return False
    try:
        runs = _get(f"/repos/{repo}/actions/workflows/sync.yml/runs?branch=main&per_page=6", token).get("workflow_runs") or []
        for run in runs:
            status = run.get("status") or ""
            if status == "completed" and (not since or _stamp(run.get("updated_at") or "") < since):
                continue
            jobs = _get(f"/repos/{repo}/actions/runs/{run['id']}/jobs?filter=latest&per_page=50", token).get("jobs") or []
            if jobs_busy(jobs, since):
                print(f"[pages-guard] Sync feeds run {run.get('id')} is publishing Pages")
                return True
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, KeyError) as exc:
        print(f"[pages-guard] lock check skipped: {type(exc).__name__}")
    return False


def wait_until_free(repo: str, token: str, limit: float = 720, step: float = 20) -> bool:
    """True once no Sync Pages job is in flight; False after limit seconds."""
    finish = time.monotonic() + limit
    while busy(repo, token):
        if time.monotonic() >= finish:
            return False
        time.sleep(step)
    return True


def accounts_done(repo: str, token: str, sha: str, limit: float = 600) -> bool:
    finish = time.monotonic() + limit
    while True:
        try:
            runs = _get(f"/repos/{repo}/actions/workflows/accounts.yml/runs?head_sha={sha}&per_page=5", token).get("workflow_runs") or []
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
            print("[pages-guard] accounts run list unavailable")
            return False
        if not runs:
            return True
        run = runs[0]
        if run.get("status") == "completed":
            ok = run.get("conclusion") in ("success", "skipped")
            print(f"[pages-guard] accounts run for main head {run.get('conclusion')}")
            return ok
        if time.monotonic() >= finish:
            print("[pages-guard] accounts run for main head still running")
            return False
        time.sleep(10)


def pick_head() -> int:
    run_sha = (os.environ.get("RUN_SHA") or os.environ.get("GITHUB_SHA") or "").strip()
    repo = os.environ.get("REPO") or os.environ.get("GITHUB_REPOSITORY") or ""
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    ref = os.environ.get("REF_NAME") or ""
    chosen = run_sha
    if ref == "main":
        _git("fetch", "--quiet", "origin", "main")
        head = _git("rev-parse", "origin/main")
        if SHA_RE.fullmatch(head) and head != run_sha:
            if run_sha and not _is_ancestor(run_sha, head):
                print("[pages-guard] main head does not contain this run; building this run")
            elif accounts_done(repo, token, head):
                print(f"[pages-guard] main moved to {head[:7]}; building the latest shell")
                chosen = head
            else:
                print("[pages-guard] main head's Accounts deploy is not done; building this run")
    _output("sha", chosen)
    return 0


def superseded(sha: str, url: str) -> int:
    go = "true"
    try:
        request = urllib.request.Request(url, headers={"User-Agent": UA, "Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=15) as response:
            live = live_shell_sha(response.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        print(f"[pages-guard] live sw.js unreadable: {type(exc).__name__}")
        live = ""
    if live and sha and live != sha:
        repo = os.environ.get("REPO") or os.environ.get("GITHUB_REPOSITORY") or ""
        token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
        try:
            compared = _get(f"/repos/{repo}/compare/{sha}...{live}", token)
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            print(f"[pages-guard] compare skipped: {type(exc).__name__}")
            compared = {}
        if newer_shell(compared):
            print(f"[pages-guard] a newer shell ({live[:7]}) is live; this run ({sha[:7]}) does not publish over it")
            go = "false"
    _output("go", go)
    return 0


def selftest() -> int:
    assert shell_changed(["app.js"]) and shell_changed(["data/communities/x.json", "sw.js"])
    assert not shell_changed(["data/communities/x.json", "feeds.json", ""])
    assert live_shell_sha('const VERSION = "viktorych-a265-' + "a" * 40 + '";') == "a" * 40
    assert live_shell_sha('const VERSION = "viktorych-a265-__SW_VERSION__";') == ""
    now = time.time()
    later = datetime.fromtimestamp(now + 5, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    earlier = datetime.fromtimestamp(now - 60, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert jobs_busy([{"name": "deploy", "status": "queued"}], 0)
    assert jobs_busy([{"name": "publish-version", "status": "in_progress"}], 0)
    assert not jobs_busy([{"name": "refresh", "status": "in_progress"}], 0)
    assert jobs_busy([{"name": "publish-version", "status": "completed", "conclusion": "success", "completed_at": later}], now)
    assert not jobs_busy([{"name": "publish-version", "status": "completed", "conclusion": "success", "completed_at": earlier}], now)
    assert not jobs_busy([{"name": "deploy", "status": "completed", "conclusion": "success", "completed_at": later}], 0)
    assert busy("", "") is False
    assert newer_shell({"status": "ahead", "files": [{"filename": "app.js"}]})
    assert not newer_shell({"status": "ahead", "files": [{"filename": "feeds.json"}]})
    assert not newer_shell({"status": "behind", "files": [{"filename": "app.js"}]})
    assert not newer_shell({})
    print("pages_guard ok")
    return 0


def main(argv: list[str]) -> int:
    if not argv or argv[0] == "--selftest":
        return selftest()
    mode = argv[0]
    args = argv[1:]

    def opt(name: str, default: str = "") -> str:
        return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else default

    if mode == "pick-head":
        return pick_head()
    if mode == "superseded":
        return superseded(opt("--sha"), opt("--url"))
    if mode == "busy":
        repo = os.environ.get("GITHUB_REPOSITORY") or ""
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
        try:
            since = float(opt("--since", "0") or 0)
        except ValueError:
            since = 0.0
        return 3 if busy(repo, token, since) else 0
    print(f"unknown mode {mode}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        from log_redact import auto as _redact_logs

        _redact_logs()
    except ImportError:
        pass
    raise SystemExit(main(sys.argv[1:]))
