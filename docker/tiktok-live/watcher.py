#!/usr/bin/env python3
"""Always-on TikTok LIVE recorder loop.

It runs the same code the Actions workflows run, without the queue,
cold start, or six-hour cap:

* ``tiktok_sync.py --live-only`` refreshes the live index on a timer, as the
  hourly ``TikTok live`` workflow does. The Worker's minute cron keeps
  refreshing ``owner/tiktok.json`` as before.
* ``tiktok_record.plan_once`` decides what to capture, with the Worker's
  rule that server recording follows the owner's switch.
* Each capture is ``tiktok_record.py --record`` in a child process
  (``ffmpeg -c copy`` of the origin rung, never re-encoded). Segments still
  go to R2, Telegram and D1 exactly as an Actions recorder writes them, so
  Shorts and /tg playback do not change.
* ``tiktok_record.py --upload`` drains whatever the inline offer left.
* When a live ends, ``fullvideo`` sends it as full-length videos to the
  backup channel.

A heartbeat in ``owner/live-runner.json`` tells the Actions steps and the
Worker cron to stand down while this runs. When ``ACCOUNTS_ORIGIN`` is set,
the owner kill switch ``tiktok_auto_record`` stops new work. Logs carry no
tokens, URLs or account handles.
"""

from __future__ import annotations

import itertools
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
for _path in (str(ROOT / "scripts"), str(HERE)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

FULL_PREFIX = "owner/live-full/"
TOKEN_RE = re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b")
URL_RE = re.compile(r"https?://\S+")
HANDLE_RE = re.compile(r"^[a-z0-9._]{2,24}$")
ROOM_RE = re.compile(r"^[1-9][0-9]{5,24}$")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def env_int(env: dict, name: str, default: int, low: int, high: int) -> int:
    raw = str(env.get(name) or "").strip()
    try:
        value = int(raw) if raw else int(default)
    except ValueError:
        value = int(default)
    return max(low, min(high, value))


def env_on(env: dict, name: str, default: bool) -> bool:
    raw = str(env.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def bot_tokens(env: dict) -> list:
    found = []
    for item in re.split(r"[\s,;]+", str(env.get("TELEGRAM_BOT_TOKENS") or "")):
        item = item.strip()
        if ":" in item and len(item) >= 20 and item not in found:
            found.append(item)
    single = str(env.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if ":" in single and len(single) >= 20 and single not in found:
        found.insert(0, single)
    return found


def secret_values(env: dict) -> list:
    names = (
        "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID",
        "TELEGRAM_API_HASH", "TELEGRAM_API_ID", "TIKTOK_STATUS_TOKEN", "WORKER_DISPATCH_TOKEN",
        "TIKTOK_FULL_CHANNEL_ID", "TIKTOK_TRACKED",
    )
    values = [str(env.get(name) or "").strip() for name in names]
    values += bot_tokens(env)
    for extra in re.split(r"[\s,;]+", str(env.get("TIKTOK_TRACKED") or "")):
        values.append(extra.strip().lstrip("@"))
    return sorted({item for item in values if len(item) >= 4}, key=len, reverse=True)


class Scrubber:
    """Masks tokens, URLs, configured secrets and known account handles."""

    def __init__(self, env: dict):
        self.secrets = secret_values(env)
        self.names: set = set()
        self.lock = threading.Lock()

    def learn(self, names) -> None:
        with self.lock:
            for name in names or []:
                text = str(name or "").strip().lstrip("@").lower()
                if len(text) >= 2:
                    self.names.add(text)

    def __call__(self, text: str) -> str:
        out = str(text or "")
        for value in self.secrets:
            out = out.replace(value, "[secret]")
        out = TOKEN_RE.sub("[secret]", out)
        out = URL_RE.sub("<url>", out)
        with self.lock:
            names = sorted(self.names, key=len, reverse=True)
        for name in names:
            out = re.sub(r"(?<![A-Za-z0-9._])@?" + re.escape(name) + r"(?![A-Za-z0-9_])", "[account]", out, flags=re.IGNORECASE)
        return out


class Child:
    def __init__(self, kind: str, key: str, proc, label: str):
        self.kind = kind
        self.key = key
        self.proc = proc
        self.label = label
        self.started = time.time()


class Watcher:
    def __init__(self, env: dict | None = None, record=None, spawn=None, printer=None, clock=None):
        self.env = dict(os.environ if env is None else env)
        self.clock = clock or time.time
        self.scrub = Scrubber(self.env)
        self.printer = printer or (lambda line: print(line, flush=True))
        self._record = record
        self.spawn = spawn or self._spawn
        self.children: dict = {}
        self.lock = threading.RLock()
        self.counter = itertools.count(1)
        self.poll_seconds = env_int(self.env, "TIKTOK_POLL_SECONDS", 30, 10, 600)
        self.sync_seconds = env_int(self.env, "TIKTOK_SYNC_SECONDS", 600, 0, 86400)
        self.settle_seconds = env_int(self.env, "TIKTOK_FULL_SETTLE_SECONDS", 300, 30, 86400)
        self.keep_days = env_int(self.env, "TIKTOK_KEEP_DAYS", 3, 1, 30)
        self.record_all = env_on(self.env, "TIKTOK_RECORD_ALL", False)
        self.full_enabled = env_on(self.env, "TIKTOK_FULL_VIDEO", True)
        self.keep_dir = Path(str(self.env.get("TIKTOK_KEEP_DIR") or "/tmp/tiktok-live-keep"))
        self.host = "hf-space" if self.env.get("SPACE_ID") else str(self.env.get("TIKTOK_HOST_LABEL") or "docker")
        self.version = str(self.env.get("VIKTORYCH_VERSION") or "")
        self.last_sync = 0.0
        self.full_thread = None
        self.full_retry: dict = {}
        self.stopping = False
        self.state = {
            "startedAt": now_iso(),
            "cycles": 0,
            "cycleErrors": 0,
            "lastCycleAt": "",
            "lastCycleOk": False,
            "lastError": "",
            "livesSeen": 0,
            "recordingsStarted": 0,
            "recordingsFinished": 0,
            "uploadersStarted": 0,
            "syncRuns": 0,
            "fullSent": 0,
            "fullFiles": 0,
            "fullFailed": 0,
            "fullPending": 0,
            "queued": 0,
        }

    # ---- configuration -------------------------------------------------

    @property
    def record(self):
        if self._record is None:
            import tiktok_record  # noqa: WPS433

            self._record = tiktok_record
        return self._record

    def configured(self) -> dict:
        tokens = bot_tokens(self.env)
        channel = str(self.env.get("TIKTOK_FULL_CHANNEL_ID") or self.env.get("TELEGRAM_CHANNEL_ID") or "").strip()
        api = bool(str(self.env.get("TELEGRAM_API_ID") or "").strip() and str(self.env.get("TELEGRAM_API_HASH") or "").strip())
        return {
            "cloudflare": bool(str(self.env.get("CLOUDFLARE_API_TOKEN") or "").strip() and str(self.env.get("CLOUDFLARE_ACCOUNT_ID") or "").strip()),
            "telegramBots": len(tokens),
            "telegramChannel": bool(re.fullmatch(r"-100\d{4,16}", channel)),
            "fullVideo": self.full_enabled and bool(tokens) and bool(re.fullmatch(r"-100\d{4,16}", channel)),
            "fullSender": "mtproto" if api else "bot-api",
        }

    def child_env(self, run_id: str) -> dict:
        env = dict(self.env)
        env["TIKTOK_RUNNER"] = "always-on"
        env["TIKTOK_RUN_ID"] = run_id
        env.setdefault("TIKTOK_PART_SECONDS", str(12 * 60 * 60))
        env.setdefault("PYTHONUNBUFFERED", "1")
        tokens = bot_tokens(self.env)
        if tokens and not str(env.get("TELEGRAM_BOT_TOKEN") or "").strip():
            env["TELEGRAM_BOT_TOKEN"] = tokens[0]
        if self.configured()["fullVideo"]:
            env["TIKTOK_KEEP_DIR"] = str(self.keep_dir)
        else:
            env.pop("TIKTOK_KEEP_DIR", None)
        # A child never needs to dispatch Actions workflows.
        env.pop("GH_TOKEN", None)
        env.pop("GITHUB_TOKEN", None)
        env.pop("GITHUB_REPOSITORY", None)
        return env

    # ---- logging ---------------------------------------------------------

    def log(self, message: str) -> None:
        self.printer("[tiktok-live] " + self.scrub(message))

    def _pump(self, label: str, stream) -> None:
        try:
            for raw in iter(stream.readline, b""):
                line = raw.decode("utf-8", "replace").rstrip()
                if line:
                    self.printer("[%s] %s" % (label, self.scrub(line)[:400]))
        except (OSError, ValueError):
            pass
        finally:
            try:
                stream.close()
            except OSError:
                pass

    def _spawn(self, args: list, env: dict, label: str):
        proc = subprocess.Popen(
            args, cwd=str(ROOT), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        threading.Thread(target=self._pump, args=(label, proc.stdout), daemon=True).start()
        return proc

    # ---- children --------------------------------------------------------

    def running(self, kind: str | None = None) -> list:
        with self.lock:
            return [child for child in self.children.values() if kind is None or child.kind == kind]

    def reap(self) -> None:
        with self.lock:
            for key, child in list(self.children.items()):
                code = child.proc.poll()
                if code is None:
                    continue
                del self.children[key]
                if child.kind == "record":
                    self.state["recordingsFinished"] += 1
                self.log("%s finished (code %s, %ss)" % (child.label, code, int(time.time() - child.started)))

    def start(self, kind: str, key: str, args: list) -> bool:
        with self.lock:
            if key in self.children and self.children[key].proc.poll() is None:
                return False
            number = next(self.counter)
            label = "%s#%d" % (kind, number)
            run_id = "%s-%s-%d-%d" % (self.host, kind, os.getpid(), number)
            proc = self.spawn(args, self.child_env(run_id), label)
            self.children[key] = Child(kind, key, proc, label)
        return True

    def start_record(self, item: dict) -> bool:
        handle = str(item.get("handle") or "").lower()
        room = str(item.get("room") or "")
        part = str(int(item.get("part") or 1))
        if not HANDLE_RE.fullmatch(handle) or (room and not ROOM_RE.fullmatch(room)):
            return False
        self.scrub.learn([handle])
        args = [sys.executable, "scripts/tiktok_record.py", "--record", "--handle", handle, "--part", part, "--room", room]
        started = self.start("record", "record:" + handle, args)
        if started:
            self.state["recordingsStarted"] += 1
            self.log("recording started (part %s)" % part)
        return started

    def start_upload(self, slot: int) -> bool:
        args = [sys.executable, "scripts/tiktok_record.py", "--upload", "--slot", str(int(slot))]
        started = self.start("upload", "upload:%d" % int(slot), args)
        if started:
            self.state["uploadersStarted"] += 1
        return started

    def maybe_sync(self) -> bool:
        if self.sync_seconds <= 0:
            return False
        now = self.clock()
        if self.last_sync and now - self.last_sync < self.sync_seconds:
            return False
        self.last_sync = now
        started = self.start("sync", "sync", [sys.executable, "scripts/tiktok_sync.py", "--live-only"])
        if started:
            self.state["syncRuns"] += 1
        return started

    def stop_children(self, grace: float = 20.0) -> None:
        children = self.running()
        for child in children:
            try:
                os.killpg(child.proc.pid, signal.SIGINT)
            except (OSError, AttributeError):
                try:
                    child.proc.send_signal(signal.SIGINT)
                except OSError:
                    pass
        deadline = time.time() + grace
        for child in children:
            left = max(0.1, deadline - time.time())
            try:
                child.proc.wait(timeout=left)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.proc.pid, signal.SIGKILL)
                except OSError:
                    child.proc.kill()
        self.reap()

    # ---- heartbeat and planning -----------------------------------------

    def heartbeat_doc(self) -> dict:
        return {
            "runner": "always-on",
            "host": self.host,
            "at": now_iso(),
            "version": self.version,
            "recording": len(self.running("record")),
        }

    def beat(self) -> bool:
        try:
            return bool(self.record.r2_put(self.record.RUNNER_KEY, json.dumps(self.heartbeat_doc()).encode("utf-8")))
        except Exception:
            return False

    def feature_off_list(self, origin: str) -> list:
        now = self.clock()
        cached = getattr(self, "_features_at", 0.0)
        if now - cached < 60 and hasattr(self, "_features_off"):
            return self._features_off
        self._features_at = now
        self._features_off = []
        req = urllib.request.Request(
            origin + "/v1/features",
            headers={"User-Agent": "viktorych-tiktok-live", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=8) as res:
            body = json.loads(res.read().decode("utf-8", "replace") or "{}")
        off = body.get("off") if isinstance(body, dict) else []
        self._features_off = [str(item) for item in off] if isinstance(off, list) else []
        return self._features_off

    def recorder_killed(self) -> bool:
        """True when the owner turned tiktok_auto_record off.

        No origin means the container follows only the recording switch, the
        same as before this check existed. A failed read stays on, matching
        an unreadable flag table.
        """
        reader = getattr(self, "features", None)
        if reader is None:
            origin = str(self.env.get("ACCOUNTS_ORIGIN") or "").strip().rstrip("/")
            if not origin:
                return False
            reader = lambda: self.feature_off_list(origin)
        try:
            off = reader() or []
        except Exception:
            return False
        return "tiktok_auto_record" in off

    def learn_accounts(self) -> None:
        try:
            accounts = self.record.load_added_accounts()
        except Exception:
            return
        self.scrub.learn(str(row.get("handle") or "") for row in (accounts.get("added") or []) if isinstance(row, dict))

    def cycle(self) -> dict:
        self.reap()
        if not self.configured()["cloudflare"]:
            self.state["lastCycleAt"] = now_iso()
            self.state["lastCycleOk"] = False
            self.state["lastError"] = "Cloudflare credentials are not set"
            return {}
        self.beat()
        if self.recorder_killed():
            self.state["cycles"] += 1
            self.state["lastCycleAt"] = now_iso()
            self.state["lastCycleOk"] = True
            self.state["lastError"] = ""
            self.log("owner recorder switch is off")
            return {}
        if self.state["cycles"] % 20 == 0:
            self.learn_accounts()
        self.maybe_sync()
        result = self.record.plan_once(gated=True, record_all=self.record_all, use_local=False)
        self.state["livesSeen"] = int(result.get("lives") or 0)
        self.state["queued"] = int(result.get("queued") or 0)
        for item in result.get("dispatch") or []:
            self.start_record(item)
        for slot in result.get("upload") or []:
            self.start_upload(int(slot))
        if self.configured()["fullVideo"]:
            self.kick_full()
        self.state["cycles"] += 1
        self.state["lastCycleAt"] = now_iso()
        self.state["lastCycleOk"] = True
        self.state["lastError"] = ""
        return result

    def safe_cycle(self) -> None:
        try:
            self.cycle()
        except Exception as err:  # keep the loop alive
            self.state["cycleErrors"] += 1
            self.state["lastCycleOk"] = False
            self.state["lastCycleAt"] = now_iso()
            self.state["lastError"] = self.scrub(type(err).__name__ + ": " + str(err))[:200]
            self.log("cycle failed: " + self.state["lastError"])

    def loop(self, wake: threading.Event | None = None) -> None:
        event = wake or threading.Event()
        self.log("watching (poll %ss, sync %ss, host %s)" % (self.poll_seconds, self.sync_seconds, self.host))
        while not self.stopping:
            self.safe_cycle()
            event.wait(self.poll_seconds)
            event.clear()

    # ---- full-length videos ----------------------------------------------

    def kick_full(self) -> None:
        if self.full_thread is not None and self.full_thread.is_alive():
            return
        self.full_thread = threading.Thread(target=self.full_pass, name="tiktok-full", daemon=True)
        self.full_thread.start()

    def rooms(self) -> list:
        found = []
        if not self.keep_dir.is_dir():
            return found
        for handle_dir in self.keep_dir.iterdir():
            if not handle_dir.is_dir() or not HANDLE_RE.fullmatch(handle_dir.name):
                continue
            for room_dir in handle_dir.iterdir():
                if room_dir.is_dir() and ROOM_RE.fullmatch(room_dir.name):
                    found.append((handle_dir.name, room_dir.name, room_dir))
        return found

    def room_ready(self, handle: str, room: str, room_dir: Path, job: dict) -> bool:
        import fullvideo

        if "record:" + handle in self.children:
            return False
        active = job.get("active") if isinstance(job.get("active"), dict) else {}
        if str(active.get("roomId") or "") == room and self.record.occupies(active, now_iso()):
            return False
        if str(active.get("roomId") or "") == room and active.get("needsPart"):
            return False
        return self.clock() - fullvideo.newest_mtime(room_dir) >= self.settle_seconds

    def room_info(self, job: dict, room: str) -> dict:
        for row in reversed(job.get("saved") or []):
            if isinstance(row, dict) and str(row.get("roomId") or "") == room:
                return row
        active = job.get("active") if isinstance(job.get("active"), dict) else {}
        if str(active.get("roomId") or "") == room:
            return active
        return {}

    def sender(self):
        import fullvideo

        if getattr(self, "_sender", None) is None:
            tokens = bot_tokens(self.env)
            self._sender = fullvideo.pick_sender(tokens[0], self.env)
        return self._sender

    def full_pass(self) -> None:
        import fullvideo

        rooms = self.rooms()
        pending = 0
        channel = str(self.env.get("TIKTOK_FULL_CHANNEL_ID") or self.env.get("TELEGRAM_CHANNEL_ID") or "").strip()
        for handle, room, room_dir in rooms:
            if self.stopping:
                return
            age = self.clock() - fullvideo.newest_mtime(room_dir)
            if age > self.keep_days * 86400:
                shutil.rmtree(room_dir, ignore_errors=True)
                self.log("dropped an unsent local copy after %s days" % self.keep_days)
                continue
            if self.full_retry.get(room, 0.0) > self.clock():
                pending += 1
                continue
            try:
                job = self.record.load_job(handle)
            except Exception:
                pending += 1
                continue
            if not self.room_ready(handle, room, room_dir, job):
                pending += 1
                continue
            marker_key = FULL_PREFIX + handle + "/" + room + ".json"
            marker = self.record.load_json_bytes(self.record.r2_get(marker_key))
            sent_parts = {str(item) for item in (marker.get("parts") or [])}
            work = room_dir.parent / (".work-" + room)
            shutil.rmtree(work, ignore_errors=True)
            try:
                result = fullvideo.send_room(room_dir, work, self.sender(), channel, handle, self.room_info(job, room), sent_parts)
            except Exception as err:
                self.state["fullFailed"] += 1
                tries = int(marker.get("failures") or 0) + 1
                self.full_retry[room] = self.clock() + min(3600, 300 * tries)
                marker["failures"] = tries
                self.record.r2_put(marker_key, json.dumps(marker).encode("utf-8"))
                self.log("full video send failed, retrying later: " + self.scrub(type(err).__name__ + " " + str(err))[:160])
                pending += 1
                continue
            finally:
                shutil.rmtree(work, ignore_errors=True)
            if result["files"]:
                marker = {
                    "handle": handle,
                    "roomId": room,
                    "parts": sorted({int(item) for item in list(sent_parts) + [str(p) for p in result["parts"]]}),
                    "messages": list(marker.get("messages") or []) + result["messages"],
                    "files": int(marker.get("files") or 0) + result["files"],
                    "bytes": int(marker.get("bytes") or 0) + result["bytes"],
                    "partial": bool(result.get("partial")),
                    "sender": getattr(self.sender(), "name", ""),
                    "at": now_iso(),
                }
                self.record.r2_put(marker_key, json.dumps(marker).encode("utf-8"))
                self.state["fullSent"] += 1
                self.state["fullFiles"] += result["files"]
                self.log("full video sent (%s file%s)" % (result["files"], "" if result["files"] == 1 else "s"))
            for part in result["parts"]:
                shutil.rmtree(room_dir / str(part), ignore_errors=True)
            try:
                if not any(room_dir.iterdir()):
                    room_dir.rmdir()
            except OSError:
                pass
        self.state["fullPending"] = pending

    # ---- reporting ---------------------------------------------------------

    def health(self) -> tuple:
        last = self.state.get("lastCycleAt") or ""
        ok = bool(self.state.get("lastCycleOk"))
        fresh = False
        if last:
            try:
                stamp = datetime.fromisoformat(last.replace("Z", "+00:00"))
                fresh = (datetime.now(timezone.utc) - stamp).total_seconds() < max(300, self.poll_seconds * 6)
            except ValueError:
                fresh = False
        healthy = ok and fresh
        return (200 if healthy else 503), {
            "ok": healthy,
            "service": "viktorych-tiktok-live",
            "lastCycleAt": last,
            "time": now_iso(),
        }

    def status(self) -> dict:
        code, health = self.health()
        doc = dict(self.state)
        doc.update({
            "ok": health["ok"],
            "service": "viktorych-tiktok-live",
            "host": self.host,
            "version": self.version,
            "time": now_iso(),
            "recordingNow": len(self.running("record")),
            "uploadersNow": len(self.running("upload")),
            "syncRunning": bool(self.running("sync")),
            "configured": self.configured(),
            "pollSeconds": self.poll_seconds,
            "syncSeconds": self.sync_seconds,
        })
        if self.keep_dir.exists():
            try:
                doc["diskFreeGiB"] = round(shutil.disk_usage(str(self.keep_dir)).free / (1024 ** 3), 1)
            except OSError:
                pass
        return doc
