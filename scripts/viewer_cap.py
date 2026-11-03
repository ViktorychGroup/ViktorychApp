"""The same viewer cap the player uses, for the Actions recorder.

Two fresh viewer counts over the cap stop the capture. Two counts back at
or under the cap clear the pause. Recording does not start again unless
auto-restart is on. No new request is made here; the caller already has
the count.
"""

from __future__ import annotations

DEFAULT_CAP = 20
HITS = 2


def parse_cap(value) -> int | str:
    if value is None or value == "":
        return DEFAULT_CAP
    if value is False or value in {"off", "0", 0}:
        return "off"
    try:
        number = int(value)
    except (TypeError, ValueError):
        return DEFAULT_CAP
    if number < 1:
        return "off" if number == 0 else DEFAULT_CAP
    return min(number, 100000)


def step_cap(state: dict | None, viewers: int, cap, wanted: bool = False, auto_restart: bool = False) -> dict:
    prev = state if isinstance(state, dict) else {}
    limit = parse_cap(cap)
    if limit == "off":
        return {"over": 0, "under": 0, "paused": False, "holdRecord": False}
    hot = int(viewers or 0) > limit
    over = (int(prev.get("over") or 0) + 1) if hot else 0
    under = 0 if hot else (int(prev.get("under") or 0) + 1)
    paused = bool(prev.get("paused"))
    if not paused and over >= HITS:
        paused = True
    if paused and under >= HITS:
        paused = False
    hold = bool(prev.get("holdRecord"))
    if paused and not prev.get("paused"):
        hold = True
    if not paused and hold and auto_restart and wanted:
        hold = False
    return {"over": over, "under": under, "paused": paused, "holdRecord": hold}


def allow_record(state: dict | None, auto_restart: bool, wanted: bool) -> bool:
    if not wanted:
        return False
    row = state if isinstance(state, dict) else {}
    if row.get("paused"):
        return False
    if row.get("holdRecord") and not auto_restart:
        return False
    return True
