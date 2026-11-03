"""Idempotent queue for saving an owner's TikTok videos.

A video id is one job. Retries wait longer each time. A block or a captcha
is not retried immediately. The queue can be saved and read back, so a
restart continues the same work. Health lines never include a handle.
"""

from __future__ import annotations

import re
import time

VIDEO_RE = re.compile(r"^\d{8,22}$")
MAX_ATTEMPTS = 6
BACKOFF = (60, 300, 900, 3600, 3 * 3600, 12 * 3600)
STALE_SECONDS = 6 * 3600


def job_id(video_id: str) -> str:
    text = str(video_id or "").strip()
    if not VIDEO_RE.fullmatch(text):
        return ""
    return "tiktok:" + text


def empty() -> dict:
    return {"jobs": {}}


def enqueue(queue: dict, video_id: str, now: float, page: str = "") -> dict:
    key = job_id(video_id)
    if not key:
        return queue
    jobs = queue.setdefault("jobs", {})
    row = jobs.get(key)
    if row and row.get("status") == "saved":
        return queue
    if not row:
        row = {"id": key, "status": "pending", "attempts": 0, "nextAt": now, "reason": ""}
        jobs[key] = row
    if page and not row.get("page"):
        row["page"] = page
    if row.get("status") == "failed" and float(row.get("nextAt") or 0) <= now:
        row["status"] = "pending"
    return queue


def backfill(queue: dict, video_ids, now: float) -> dict:
    for video_id in video_ids or []:
        enqueue(queue, str(video_id), now)
    return queue


def due(queue: dict, now: float, limit: int = 8) -> list:
    rows = []
    for row in (queue.get("jobs") or {}).values():
        if row.get("status") == "saved":
            continue
        if int(row.get("attempts") or 0) >= MAX_ATTEMPTS:
            continue
        if float(row.get("nextAt") or 0) > now:
            continue
        rows.append(row)
    rows.sort(key=lambda item: float(item.get("nextAt") or 0))
    return rows[: max(0, int(limit))]


def mark(queue: dict, video_id: str, result: str, now: float, reason: str = "") -> dict:
    key = job_id(video_id) or (video_id if str(video_id).startswith("tiktok:") else "")
    row = (queue.get("jobs") or {}).get(key)
    if not row:
        return queue
    if result == "saved":
        row["status"] = "saved"
        row["reason"] = ""
        row["savedAt"] = now
        return queue
    # A block, a captcha, or a rate limit is recorded and waited out.
    # It is not bypassed.
    row["attempts"] = int(row.get("attempts") or 0) + 1
    row["status"] = "failed"
    step = min(row["attempts"] - 1, len(BACKOFF) - 1)
    wait = BACKOFF[max(0, step)]
    if reason in {"blocked", "captcha", "limited"}:
        wait = max(wait, 6 * 3600)
    row["nextAt"] = now + wait
    row["reason"] = reason if reason in {"blocked", "captcha", "limited", "error"} else "error"
    return queue


def health(queue: dict, now: float) -> dict:
    jobs = list((queue.get("jobs") or {}).values())
    pending = [row for row in jobs if row.get("status") == "pending"]
    failed = [row for row in jobs if row.get("status") == "failed"]
    waiting = [row for row in pending if now - float(row.get("nextAt") or now) >= STALE_SECONDS]
    lines = []
    if failed:
        lines.append("TikTok save queue: %s videos failed and will retry." % len(failed))
    if waiting:
        lines.append("TikTok save queue: %s videos have been waiting over six hours." % len(waiting))
    return {"pending": len(pending), "failed": len(failed), "retrying": len(failed), "lines": lines}


def _selftest() -> None:
    now = time.time()
    queue = empty()
    enqueue(queue, "not-an-id", now)
    assert queue["jobs"] == {}
    enqueue(queue, "7000000000000000001", now)
    enqueue(queue, "7000000000000000001", now)
    assert len(queue["jobs"]) == 1
    assert due(queue, now)[0]["status"] == "pending"
    mark(queue, "7000000000000000001", "blocked", now, "captcha")
    assert due(queue, now + 60) == []
    assert health(queue, now)["failed"] == 1
    mark(queue, "7000000000000000001", "saved", now + 10)
    assert due(queue, now + 999999) == []
    backfill(queue, ["7000000000000000001", "7000000000000000002"], now)
    assert "tiktok:7000000000000000002" in queue["jobs"]
    assert queue["jobs"]["tiktok:7000000000000000001"]["status"] == "saved"
    print("tiktok save queue ok")


if __name__ == "__main__":
    _selftest()
