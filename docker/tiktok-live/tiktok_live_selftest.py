#!/usr/bin/env python3
"""Offline checks for the always-on TikTok LIVE recorder. Demo data only.

Run: python3 docker/tiktok-live/tiktok_live_selftest.py
"""

from __future__ import annotations

import http.client
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "scripts"))

import fullvideo  # noqa: E402
import server  # noqa: E402
import watcher as watch  # noqa: E402

DEMO_TOKEN = "123456789:" + "A" * 35
DEMO_CF = "cf-demo-token-0123456789"
DEMO_CHANNEL = "-1001234567890"
failed = 0


def check(ok: bool, message: str) -> None:
    global failed
    if ok:
        print("ok " + message)
    else:
        failed += 1
        print("FAIL " + message)


class FakeProc:
    def __init__(self):
        self.code = None
        self.pid = 999999

    def poll(self):
        return self.code

    def wait(self, timeout=None):
        return self.code

    def send_signal(self, _sig):
        self.code = 0

    def kill(self):
        self.code = -9


class FakeRecord:
    RUNNER_KEY = "owner/live-runner.json"

    def __init__(self):
        self.store = {}
        self.plans = []
        self.jobs = {}

    def r2_put(self, key, blob):
        self.store[key] = blob
        return True

    def r2_get(self, key):
        return self.store.get(key)

    def load_json_bytes(self, blob):
        try:
            return json.loads(blob.decode("utf-8")) if blob else {}
        except ValueError:
            return {}

    def load_added_accounts(self):
        return {"added": [{"handle": "demo.creator"}]}

    def plan_once(self, gated=False, record_all=False, use_local=True):
        self.plans.append((gated, record_all, use_local))
        return {
            "dispatch": [
                {"handle": "demo.creator", "part": 1, "room": "7000000000000000001"},
                {"handle": "demo.creator", "part": 1, "room": "7000000000000000001"},
                {"handle": "bad handle!", "part": 1, "room": "1"},
            ],
            "upload": [0, 0],
            "lives": 1,
            "queued": 0,
        }

    def load_job(self, handle):
        return self.jobs.get(handle, {"handle": handle, "active": {}, "saved": []})

    def occupies(self, active, now):
        return bool(active.get("capturing"))


def make_watcher(extra=None, record=None):
    env = {
        "CLOUDFLARE_API_TOKEN": DEMO_CF,
        "CLOUDFLARE_ACCOUNT_ID": "acct-demo-0000",
        "TELEGRAM_BOT_TOKENS": DEMO_TOKEN,
        "TELEGRAM_CHANNEL_ID": DEMO_CHANNEL,
        "GH_TOKEN": "gh-demo-should-not-pass",
        "TIKTOK_SYNC_SECONDS": "0",
    }
    env.update(extra or {})
    lines = []
    spawned = []

    def spawn(args, child_env, label):
        spawned.append((args, child_env, label))
        return FakeProc()

    w = watch.Watcher(env=env, record=record or FakeRecord(), spawn=spawn, printer=lines.append)
    return w, lines, spawned


def test_watcher() -> None:
    w, lines, spawned = make_watcher()
    w.full_enabled = False
    w.cycle()
    records = [item for item in spawned if "--record" in item[0]]
    uploads = [item for item in spawned if "--upload" in item[0]]
    check(len(records) == 1, "one recorder per handle, a bad handle is ignored")
    check(len(uploads) == 1, "one uploader per channel slot")
    check(w.record.plans[-1] == (True, False, False), "planning follows the owner's server-recording switch and reads R2")
    env = records[0][1]
    check(env["TIKTOK_RUNNER"] == "always-on" and env["TIKTOK_RUN_ID"].startswith("docker-record-"), "children are marked always-on with their own run id")
    check(env.get("TELEGRAM_BOT_TOKEN") == DEMO_TOKEN, "the first of TELEGRAM_BOT_TOKENS becomes the recorder bot")
    check("GH_TOKEN" not in env and "GITHUB_REPOSITORY" not in env, "children cannot dispatch Actions workflows")
    check(int(env["TIKTOK_PART_SECONDS"]) == 12 * 3600, "parts run twelve hours on an always-on host")
    beat = json.loads(w.record.store["owner/live-runner.json"].decode("utf-8"))
    check(beat["runner"] == "always-on" and "demo.creator" not in json.dumps(beat), "the heartbeat carries no account names")
    w.cycle()
    check(len([item for item in spawned if "--record" in item[0]]) == 1, "a running recorder is not started twice")
    for child in w.running():
        child.proc.code = 0
    w.cycle()
    check(len([item for item in spawned if "--record" in item[0]]) == 2, "a finished recorder can start again")
    text = "\n".join(lines)
    check("demo.creator" not in text, "logs mask account handles")
    w.log("token %s url https://example.invalid/x?sig=1 cf %s" % (DEMO_TOKEN, DEMO_CF))
    check(DEMO_TOKEN not in lines[-1] and DEMO_CF not in lines[-1] and "example.invalid" not in lines[-1], "logs mask tokens, secrets and URLs")
    status = w.status()
    blob = json.dumps(status)
    check(DEMO_TOKEN not in blob and DEMO_CHANNEL not in blob and "demo.creator" not in blob, "status shows no secrets, ids or handles")
    check(status["configured"]["fullSender"] == "bot-api", "without API keys full videos use the Bot API")
    code, _doc = w.health()
    check(code == 200, "health is 200 after a good cycle")

    bare, _lines, spawned2 = make_watcher({"CLOUDFLARE_API_TOKEN": ""})
    bare.cycle()
    check(not spawned2 and bare.health()[0] == 503, "no Cloudflare credentials: nothing starts and health is 503")

    killed, _killed_lines, killed_spawned = make_watcher()
    killed.features = lambda: ["tiktok_auto_record"]
    killed.full_enabled = False
    killed.cycle()
    check(not killed_spawned, "the owner kill switch stops new recordings and uploads")
    check(killed.health()[0] == 200, "a kill switch is a healthy idle")
    check("owner/live-runner.json" in killed.record.store, "the heartbeat still stands down the other recorders")

    full, _l, _s = make_watcher({"TELEGRAM_API_ID": "12345", "TELEGRAM_API_HASH": "0" * 32, "TIKTOK_KEEP_DIR": "/tmp/demo-keep"})
    env = full.child_env("x")
    check(env.get("TIKTOK_KEEP_DIR") == "/tmp/demo-keep" and full.configured()["fullSender"] == "mtproto", "full video keeps local copies and uses MTProto with API keys")
    off, _l, _s = make_watcher({"TIKTOK_FULL_VIDEO": "0"})
    check("TIKTOK_KEEP_DIR" not in off.child_env("x"), "full video off keeps no local copies")


def test_server() -> None:
    w, _lines, _spawned = make_watcher()
    w.full_enabled = False
    w.cycle()
    wake = threading.Event()
    httpd = server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(w, wake, "demo-status-secret"))
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        def get(path, method="GET", headers=None):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request(method, path, headers=headers or {})
            res = conn.getresponse()
            body = res.read()
            conn.close()
            return res.status, body

        code, body = get("/health")
        check(code == 200 and json.loads(body)["ok"] is True, "GET /health answers 200")
        code, _body = get("/status")
        check(code == 401, "/status needs the bearer token")
        code, body = get("/status", headers={"Authorization": "Bearer demo-status-secret"})
        check(code == 200 and "recordingNow" in json.loads(body), "/status with the token shows counts")
        code, _body = get("/poll", method="POST")
        check(code == 401 and not wake.is_set(), "POST /poll needs the token")
        code, _body = get("/poll", method="POST", headers={"Authorization": "Bearer demo-status-secret"})
        check(code == 202 and wake.is_set(), "POST /poll with the token wakes the loop")
    finally:
        httpd.shutdown()


def make_run(folder: Path, seconds: int, start: int = 0) -> None:
    """A demo fMP4 HLS run like the recorder's (test input is encoded once here)."""
    folder.mkdir(parents=True, exist_ok=True)
    src = folder.parent / ("src-%s.mp4" % folder.name)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
        "-t", str(seconds), "-c:v", "libx264", "-g", "25", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src),
    ], check=True)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-c", "copy",
        "-f", "hls", "-hls_time", "1", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
        "-hls_list_size", "0", "-start_number", str(start), "-hls_segment_filename", str(folder / "seg%05d.m4s"), str(folder / "index.m3u8"),
    ], check=True)
    (folder / "index.m3u8").unlink()
    src.unlink()


class FakeSender:
    name = "fake"

    def __init__(self, limit):
        self.limit = limit
        self.sent = []

    def send(self, channel, path, caption, meta, thumb):
        self.sent.append((channel, path.name, caption, meta, path.stat().st_size))
        return len(self.sent)


def test_fullvideo() -> None:
    check(not fullvideo.copy_only(["ffmpeg", "-i", "a", "-c", "copy", "-c:v", "libx264", "b"]), "an encoder flag is refused")
    check(fullvideo.copy_only(fullvideo.concat_args(Path("l"), Path("o"))), "the join is a stream copy")
    check(fullvideo.copy_only(fullvideo.split_args(Path("s"), Path("p%03d.mp4"), 60)), "the cut is a stream copy")
    check(fullvideo.copy_only(fullvideo.remux_run_args(Path("o"))), "the remux is a stream copy")
    cap = fullvideo.caption_for("demo.creator", {"title": "Demo title", "startedAt": "2026-01-02T03:04:05Z"}, 2, 3, 3725, True)
    check(cap.startswith("@demo.creator LIVE · 2026-01-02 03:04 UTC · 1h02m · 2/3 · partial"), "the caption names the live, time, length and piece")
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        check(True, "ffmpeg is not installed here; stitching was not run")
        return
    tmp = Path(tempfile.mkdtemp(prefix="tiktok-live-selftest-"))
    try:
        room = tmp / "keep" / "demo.creator" / "7000000000000000001"
        make_run(room / "1" / "0000000000001", 4)
        make_run(room / "1" / "0000000000002", 3, start=4)
        make_run(room / "2" / "0000000000003", 3)
        runs = fullvideo.run_dirs(room)
        check([part for part, _run in runs] == [1, 1, 2], "runs are joined in part and start order")
        sender = FakeSender(fullvideo.MTPROTO_LIMIT)
        result = fullvideo.send_room(room, tmp / "work", sender, DEMO_CHANNEL, "demo.creator", {"title": "Demo"})
        check(result["files"] == 1 and result["parts"] == [1, 2], "a live under the limit is one video")
        duration = sender.sent[0][3].get("duration") or 0
        check(9.0 <= duration <= 11.5, "the joined video keeps every run (%.1fs)" % duration)
        probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", str(tmp / "work" / "full.mp4")], capture_output=True, check=False)
        check(probe.stdout.decode().strip() == "h264", "the joined video keeps the source codec")
        shutil.rmtree(tmp / "work", ignore_errors=True)
        small = FakeSender(40 * 1024)
        result = fullvideo.send_room(room, tmp / "work2", small, DEMO_CHANNEL, "demo.creator", {}, {"2"})
        sizes = [row[4] for row in small.sent]
        check(result["parts"] == [1] and result["files"] >= 2 and all(size <= 40 * 1024 for size in sizes), "a part already sent is skipped and a large one is cut under the limit")
        check(all(" · %d/%d" % (i + 1, len(sizes)) in row[2] for i, row in enumerate(small.sent)), "each piece is numbered")

        # Watcher full pass: waits while recording, then sends and cleans up.
        rec = FakeRecord()
        w, _lines, _spawned = make_watcher({"TIKTOK_KEEP_DIR": str(tmp / "keep"), "TIKTOK_FULL_SETTLE_SECONDS": "30"}, record=rec)
        w._sender = FakeSender(fullvideo.MTPROTO_LIMIT)
        rec.jobs["demo.creator"] = {"handle": "demo.creator", "active": {"roomId": "7000000000000000001", "capturing": True}, "saved": []}
        w.full_pass()
        check(not w._sender.sent and room.exists(), "a live still recording is not sent")
        rec.jobs["demo.creator"] = {"handle": "demo.creator", "active": {}, "saved": [{"roomId": "7000000000000000001", "title": "Demo"}]}
        w.clock = lambda: time.time() + 3600
        w.full_pass()
        marker = json.loads(rec.store["owner/live-full/demo.creator/7000000000000000001.json"].decode("utf-8"))
        check(len(w._sender.sent) == 1 and marker["parts"] == [1, 2] and not room.exists(), "a finished live is sent once, recorded in R2 and removed locally")
        w.full_pass()
        check(len(w._sender.sent) == 1, "nothing is sent twice")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    test_watcher()
    test_server()
    test_fullvideo()
    if failed:
        print("%s failed" % failed)
        return 1
    print("tiktok live always-on selftest passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
