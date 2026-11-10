#!/usr/bin/env python3
"""Start Sync feeds when its last real refresh is older than half an hour.

GitHub can stop creating the scheduled Sync feeds runs. The gate in
sync.yml already skips a dispatch whose source is "chain" when another
sync started within 22 minutes. This script is that chain. A run whose
refresh job was skipped by the gate still concludes success, and those
do not count as a refresh. A sync that is queued or running is left
alone so the feed-refresh concurrency group is not cancelled.

    python3 scripts/sync_keepalive.py --selftest
    REPO=owner/name GH_TOKEN=... python3 scripts/sync_keepalive.py --dry-run
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

STALE_SECONDS = 30 * 60
# The same window the Sync feeds gate uses before it skips a chain dispatch.
DEBOUNCE_SECONDS = 22 * 60
REFRESH_JOB = "refresh"
ACTIVE = ("in_progress", "queued", "waiting", "pending", "requested")
WORKFLOW = "sync.yml"


def parse_time(value: str):
    if not value:
        return None
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def run_started(run: dict):
    return parse_time(run.get("run_started_at") or run.get("created_at") or "")


def gate_counts(run: dict) -> bool:
    """True when the Sync feeds gate would treat this run as recent work."""
    status = run.get("status") or ""
    if status == "completed" and run.get("conclusion") not in ("success", "skipped"):
        return False
    if status not in ACTIVE and status != "completed":
        return False
    return run_started(run) is not None


def refresh_job(jobs) -> dict | None:
    for job in jobs or []:
        if job.get("name") == REFRESH_JOB:
            return job
    return None


def refresh_executed(job: dict | None) -> bool:
    """The refresh job ran and finished. A gate skip does not count."""
    return bool(job) and job.get("status") == "completed" and job.get("conclusion") == "success"


def decide(runs, jobs_for, now: datetime) -> tuple[bool, str]:
    """Return whether to dispatch sync.yml with source=chain, and why.

    runs is newest first. jobs_for(run_id) returns that run's jobs. It is
    not called for a run the gate would still be debouncing.
    """
    for run in runs:
        status = run.get("status") or ""
        if status in ACTIVE:
            return False, f"sync {run.get('id')} is {status}"
        started = run_started(run)
        if not started:
            continue
        age = (now - started).total_seconds()
        if gate_counts(run) and age < DEBOUNCE_SECONDS:
            return False, f"sync {run.get('id')} started {int(age // 60)}m ago, inside the debounce"
    last_id = None
    last_age = None
    for run in runs:
        started = run_started(run)
        if not started:
            continue
        job = refresh_job(jobs_for(run.get("id")))
        if not refresh_executed(job):
            continue
        when = parse_time((job or {}).get("started_at") or "") or started
        last_id = run.get("id")
        last_age = (now - when).total_seconds()
        break
    if last_age is None:
        return True, "no completed refresh in the recent Sync feeds runs"
    if last_age >= STALE_SECONDS:
        return True, f"last refresh {last_id} is {int(last_age // 60)}m old"
    return False, f"refresh {last_id} is {int(last_age // 60)}m old"


def github_json(url: str, token: str, method: str = "GET", body: dict | None = None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "sync-keepalive",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        raw = res.read().decode("utf-8")
    return json.loads(raw) if raw else {}


def fetch_runs(repo: str, token: str) -> list:
    url = f"https://api.github.com/repos/{repo}/actions/workflows/{WORKFLOW}/runs?per_page=20"
    data = github_json(url, token)
    return list(data.get("workflow_runs") or [])


def fetch_jobs(repo: str, token: str, run_id) -> list:
    url = f"https://api.github.com/repos/{repo}/actions/runs/{run_id}/jobs?per_page=100"
    data = github_json(url, token)
    return list(data.get("jobs") or [])


def dispatch_sync(repo: str, token: str) -> None:
    url = f"https://api.github.com/repos/{repo}/actions/workflows/{WORKFLOW}/dispatches"
    github_json(url, token, method="POST", body={"ref": "main", "inputs": {"source": "chain"}})


def _iso(now: datetime, minutes_ago: int) -> str:
    return (now - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _run(run_id: int, status: str, conclusion: str, minutes_ago: int, now: datetime) -> dict:
    return {
        "id": run_id,
        "status": status,
        "conclusion": conclusion,
        "run_started_at": _iso(now, minutes_ago),
    }


def _job(conclusion: str, minutes_ago: int, now: datetime, status: str = "completed") -> dict:
    return {
        "name": REFRESH_JOB,
        "status": status,
        "conclusion": conclusion,
        "started_at": _iso(now, minutes_ago),
    }


def selftest() -> int:
    now = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)
    calls = {"n": 0}

    def jobs_for(mapping):
        def fetch(run_id):
            calls["n"] += 1
            return mapping.get(run_id, [])
        return fetch

    fresh = [_run(1, "completed", "success", 10, now)]
    decision, reason = decide(fresh, jobs_for({1: [_job("success", 10, now)]}), now)
    assert decision is False and "debounce" in reason, reason
    assert calls["n"] == 0, "a run inside the debounce does not need its jobs"

    stale = [_run(2, "completed", "success", 40, now)]
    decision, reason = decide(stale, jobs_for({2: [_job("success", 40, now)]}), now)
    assert decision is True and "40m" in reason, reason

    skipped = [
        _run(3, "completed", "success", 40, now),
        _run(4, "completed", "success", 80, now),
    ]
    decision, reason = decide(skipped, jobs_for({
        3: [_job("skipped", 40, now)],
        4: [_job("success", 80, now)],
    }), now)
    assert decision is True and "80m" in reason, reason

    recent_skip = [
        _run(5, "completed", "success", 10, now),
        _run(6, "completed", "success", 80, now),
    ]
    decision, reason = decide(recent_skip, jobs_for({
        5: [_job("skipped", 10, now)],
        6: [_job("success", 80, now)],
    }), now)
    assert decision is False and "debounce" in reason, reason

    running = [_run(7, "in_progress", "", 5, now)]
    decision, reason = decide(running, jobs_for({}), now)
    assert decision is False and "in_progress" in reason, reason

    failed = [
        _run(8, "completed", "failure", 5, now),
        _run(9, "completed", "success", 50, now),
    ]
    decision, reason = decide(failed, jobs_for({
        8: [_job("failure", 5, now)],
        9: [_job("success", 50, now)],
    }), now)
    assert decision is True and "50m" in reason, reason

    almost = [_run(10, "completed", "success", 25, now)]
    decision, reason = decide(almost, jobs_for({10: [_job("success", 25, now)]}), now)
    assert decision is False and "25m" in reason, reason

    only_skips = [_run(11, "completed", "success", 45, now)]
    decision, reason = decide(only_skips, jobs_for({11: [_job("skipped", 45, now)]}), now)
    assert decision is True and "no completed refresh" in reason, reason

    decision, reason = decide([{"id": 12, "status": "queued", "conclusion": ""}], jobs_for({}), now)
    assert decision is False and "queued" in reason, reason

    print("sync keepalive selftest ok")
    return 0


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return selftest()
    dry = "--dry-run" in argv
    from log_redact import auto
    auto()
    repo = os.environ.get("REPO") or ""
    token = os.environ.get("GH_TOKEN") or ""
    if not repo or not token:
        print("REPO and GH_TOKEN are required", file=sys.stderr)
        return 1
    runs = fetch_runs(repo, token)
    cache: dict = {}

    def jobs_for(run_id):
        if run_id not in cache:
            cache[run_id] = fetch_jobs(repo, token, run_id)
        return cache[run_id]

    do_dispatch, reason = decide(runs, jobs_for, datetime.now(timezone.utc))
    print(reason)
    if not do_dispatch:
        return 0
    if dry:
        print("dry-run; would dispatch sync.yml with source=chain")
        return 0
    dispatch_sync(repo, token)
    print("dispatched sync.yml with source=chain")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as err:
        print(f"sync keepalive failed: {err}", file=sys.stderr)
        sys.exit(1)
