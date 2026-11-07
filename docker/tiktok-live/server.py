#!/usr/bin/env python3
"""HTTP front for the always-on TikTok LIVE recorder.

GET  /health  200 while the watcher loop is cycling, 503 otherwise. No names.
GET  /status  counts and configuration flags only (no handles, no ids, no
              secrets). Send ``Authorization: Bearer $TIKTOK_STATUS_TOKEN``
              when that secret is set.
POST /poll    run a cycle now. Needs the same bearer token.

Listens on $PORT (7860, the Hugging Face default).
"""

from __future__ import annotations

import hmac
import http.server
import json
import os
import signal
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from watcher import Watcher  # noqa: E402


def authorized(header: str, secret: str) -> bool:
    if not secret:
        return True
    text = str(header or "")
    if not text.startswith("Bearer "):
        return False
    return hmac.compare_digest(text[7:].strip().encode("utf-8"), secret.encode("utf-8"))


def make_handler(watcher: Watcher, wake: threading.Event, secret: str):
    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "viktorych-tiktok-live"
        sys_version = ""

        def reply(self, code: int, doc: dict) -> None:
            body = (json.dumps(doc, indent=2) + "\n").encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Robots-Tag", "noindex")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path in {"/", "/health"}:
                code, doc = watcher.health()
                self.reply(code, doc)
            elif path == "/status":
                if not authorized(self.headers.get("Authorization", ""), secret):
                    self.reply(401, {"error": "unauthorized"})
                    return
                self.reply(200, watcher.status())
            else:
                self.reply(404, {"error": "not found"})

        def do_HEAD(self) -> None:  # noqa: N802
            code, _doc = watcher.health()
            self.send_response(code)
            self.end_headers()

        def do_POST(self) -> None:  # noqa: N802
            if self.path.split("?", 1)[0] != "/poll":
                self.reply(404, {"error": "not found"})
                return
            if not secret or not authorized(self.headers.get("Authorization", ""), secret):
                self.reply(401, {"error": "unauthorized"})
                return
            wake.set()
            self.reply(202, {"status": "polling"})

        def log_message(self, format: str, *args) -> None:  # noqa: A002
            pass

    return Handler


def main() -> int:
    try:
        from log_redact import auto as _redact_logs

        _redact_logs()
    except ImportError:
        pass
    port = int(os.environ.get("PORT") or "7860")
    secret = str(os.environ.get("TIKTOK_STATUS_TOKEN") or "").strip()
    watcher = Watcher()
    wake = threading.Event()
    loop = threading.Thread(target=watcher.loop, args=(wake,), name="tiktok-watch", daemon=True)
    loop.start()
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), make_handler(watcher, wake, secret))

    def stop(_signum, _frame) -> None:
        watcher.stopping = True
        wake.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    watcher.log("listening on port %s" % port)
    try:
        server.serve_forever()
    finally:
        watcher.log("stopping; asking recorders to close their files")
        watcher.stop_children()
    return 0


if __name__ == "__main__":
    sys.exit(main())
