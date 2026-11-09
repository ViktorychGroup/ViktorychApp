"""Deploy the prepared directory to Cloudflare Pages.

A token that cannot edit Pages (HTTP 401 or 403) skips this step. A temporary
5xx or a network error is retried, then fails the job. Wrangler saying it
could not ascertain the deployment is not success: the production alias must
serve this build's service worker. version.json in the shell upload is still
the previous manifest, so it is not the proof. The GitHub Pages deploy is
unchanged.
Nothing here prints the API token.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PROJECT = "viktorychapp"
API = "https://api.cloudflare.com/client/v4"
LIVE_VERSION = "https://viktorychapp.pages.dev/version.json"
LIVE_SW = "https://viktorychapp.pages.dev/sw.js"
RETRY_LIMIT = 3
RETRY_WAITS = (1, 2)
CONFIRM_WAIT = 180
CONFIRM_INTERVAL = 5


def scrub(text: str) -> str:
    return re.sub(r"[A-Za-z0-9_\-]{20,}", "[redacted]", str(text or ""))[:800]


def permission_denied(status: int, payload: dict) -> bool:
    """True only for a real authorization failure, never for a 5xx."""
    if status in (401, 403):
        return True
    if status >= 500:
        return False
    for item in payload.get("errors") or []:
        if not isinstance(item, dict):
            continue
        if item.get("code") in (10000, 9106, 9109, 1003):
            return True
        message = str(item.get("message") or "").lower()
        if "permission" in message or "unauthorized" in message or "authentication" in message:
            return True
    return False


def transient_http(status: int) -> bool:
    code = int(status or 0)
    return 500 <= code <= 599


def failure_kind(text: str) -> str:
    """Classify a failed upload. 401 and 403 are permission. 5xx and network are temporary."""
    blob = str(text or "")
    if re.search(r"(?:^|[^0-9])(401|403)(?:[^0-9]|$)", blob):
        return "permission"
    if re.search(r"(?:^|[^0-9])(5\d\d)(?:[^0-9]|$)", blob):
        return "transient"
    low = blob.lower()
    if any(phrase in low for phrase in (
        "timed out", "timeout", "connection reset", "connection refused",
        "network is unreachable", "temporary failure", "name or service not known",
        "malformed response",
    )):
        return "transient"
    if "permission" in low or "unauthorized" in low or "authentication" in low:
        return "permission"
    return "other"


def pages_permission_notice() -> str:
    return "\n".join([
        "[pages] CLOUDFLARE_API_TOKEN cannot edit Cloudflare Pages. The mirror was not deployed. GitHub Pages is unchanged.",
        "[pages] This is a permission on the token you already use, not a new secret.",
        "[pages] 1. Open https://dash.cloudflare.com/profile/api-tokens",
        "[pages] 2. Edit the token stored in the GitHub Actions secret CLOUDFLARE_API_TOKEN.",
        "[pages] 3. Add permission: Account → Cloudflare Pages → Edit.",
        "[pages] 4. Account resources: include the same account that owns the viktorych-accounts Worker.",
        "[pages] 5. Continue to summary, then update the token.",
        "[pages] 6. If Cloudflare shows a new token value, replace the existing GitHub secret CLOUDFLARE_API_TOKEN (Settings → Secrets and variables → Actions). Do not add a second secret. If the value did not change, leave the secret as it is.",
        "[pages] 7. Re-run Actions → Sync feeds.",
        "[pages] The project name is viktorychapp. The public URL is https://viktorychapp.pages.dev/",
    ])


def outage_message(tries: int) -> str:
    return "\n".join([
        "[pages] Cloudflare Pages upload failed after " + str(tries) + " tries.",
        "[pages] The service returned a temporary error (HTTP 5xx or a network timeout), not a token permission.",
        "[pages] The mirror was not updated. Re-run Publish app when Cloudflare answers.",
        "[pages] The public URL is https://viktorychapp.pages.dev/",
    ])


def request(method: str, url: str, token: str, body: dict | None = None, opener=None, sleep=None, attempts: int = RETRY_LIMIT):
    open_url = opener or urllib.request.urlopen
    pause = sleep or time.sleep
    data = None if body is None else json.dumps(body).encode("utf-8")
    last = (0, {"errors": [{"message": "no response"}]})
    for attempt in range(max(1, attempts)):
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        })
        try:
            with open_url(req, timeout=30) as res:
                raw = res.read().decode("utf-8")
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    payload = {"errors": [{"message": scrub(raw)}]}
                status = int(getattr(res, "status", 0) or 0)
                if not transient_http(status):
                    return status, payload
                last = (status, payload)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = {"errors": [{"message": scrub(raw)}]}
            if not transient_http(exc.code):
                return exc.code, payload
            last = (exc.code, payload)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = (0, {"errors": [{"message": scrub(str(exc))}]})
        if attempt + 1 < attempts:
            pause(RETRY_WAITS[min(attempt, len(RETRY_WAITS) - 1)])
    return last


def create_result(status: int, payload: dict) -> str:
    if status in (200, 409) or (isinstance(payload, dict) and payload.get("success")):
        return "ready"
    if permission_denied(status, payload):
        return "denied"
    if status == 0 or transient_http(status):
        return "unavailable"
    return "rejected"


def ensure_project(account: str, token: str, opener=None, sleep=None) -> str:
    status, payload = request("GET", f"{API}/accounts/{account}/pages/projects/{PROJECT}", token, opener=opener, sleep=sleep)
    if status == 200 and isinstance(payload, dict) and payload.get("success"):
        return "exists"
    if status == 0 or transient_http(status):
        print(outage_message(RETRY_LIMIT))
        return "unavailable"
    if permission_denied(status, payload):
        return "denied"
    if status != 404:
        print("[pages] project lookup " + scrub(json.dumps(payload.get("errors") or payload)[:300]))
        if permission_denied(status, payload):
            return "denied"
    created, created_body = request(
        "POST", f"{API}/accounts/{account}/pages/projects", token,
        {"name": PROJECT, "production_branch": "main"},
        opener=opener, sleep=sleep,
    )
    outcome = create_result(created, created_body)
    if outcome == "ready":
        print("[pages] project ready: " + PROJECT)
        return "ready"
    if outcome == "denied":
        return "denied"
    if outcome == "unavailable":
        print(outage_message(RETRY_LIMIT))
        return "unavailable"
    print("[pages] Cloudflare rejected the Pages project name " + PROJECT + ".")
    print("[pages] The mirror must be https://" + PROJECT + ".pages.dev/. This workflow will not choose another name.")
    print("[pages] " + scrub(json.dumps((created_body or {}).get("errors") or created_body)[:300]))
    return "rejected"


def upload_once(cmd, cwd, env, invoke):
    proc = invoke(cmd, cwd=cwd, env=env, text=True, capture_output=True)
    text = scrub((getattr(proc, "stdout", "") or "") + "\n" + (getattr(proc, "stderr", "") or ""))
    return int(getattr(proc, "returncode", 1) or 0), text


def deployment_unconfirmed(text: str) -> bool:
    """Wrangler can exit 0 before the production alias has moved."""
    return "couldn't ascertain" in str(text or "").lower()


def build_sha() -> str:
    sha = (os.environ.get("GITHUB_SHA") or "").strip().lower()
    if re.fullmatch(r"[0-9a-f]{7,64}", sha):
        return sha
    return ""


def payload_sha(payload) -> str:
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return ""
    if not isinstance(payload, dict):
        return ""
    sha = str(payload.get("sha") or "").strip().lower()
    if re.fullmatch(r"[0-9a-f]{7,64}", sha):
        return sha
    return ""


def default_live(url: str):
    """Public files only. The API token is not sent.

    JSON stays a dict so version.json keeps its sha. sw.js is not JSON, and
    turning that body into {} would hide the build SHA.
    """
    req = urllib.request.Request(url, headers={
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    })
    with urllib.request.urlopen(req, timeout=20) as res:
        raw = res.read().decode("utf-8", "replace")
        status = int(getattr(res, "status", 0) or 0)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = raw
        return status, payload


def uploaded_manifest_sha(directory: Path) -> str:
    """The version.json in this upload. The shell upload still has the previous one."""
    path = directory / "version.json"
    if not path.is_file():
        return ""
    try:
        return payload_sha(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError):
        return ""


def live_body(fetch, url: str) -> str:
    try:
        status, payload = fetch(url)
    except (urllib.error.URLError, TimeoutError, OSError):
        return ""
    if int(status or 0) != 200:
        return ""
    if isinstance(payload, (dict, list)):
        return json.dumps(payload)
    return str(payload or "")


def alias_ready(expected: str, directory: Path, fetch, pause, wait: int = CONFIRM_WAIT, interval: int = CONFIRM_INTERVAL) -> bool:
    """Poll the production alias until this build's shell is there.

    version.json is checked only when this upload contains that build's
    manifest. The first mirror upload still carries the previous one.
    """
    wanted = (expected or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{7,64}", wanted):
        return False
    manifest_required = uploaded_manifest_sha(directory) == wanted
    waited = 0
    while True:
        stamp = str(time.time_ns())
        shell = live_body(fetch, LIVE_SW + "?t=" + stamp).lower()
        shell_ok = wanted in shell
        manifest_ok = True
        if manifest_required:
            raw = live_body(fetch, LIVE_VERSION + "?t=" + stamp)
            try:
                manifest_ok = payload_sha(json.loads(raw)) == wanted
            except json.JSONDecodeError:
                manifest_ok = False
        if shell_ok and manifest_ok:
            if manifest_required:
                print("[pages] production alias is serving this build.")
            else:
                print("[pages] production shell is this build. version.json is still the previous manifest.")
            return True
        if waited >= wait:
            return False
        step = min(interval, wait - waited)
        pause(step)
        waited += step


def note_wrangler(output: str) -> None:
    """Keep the deployment URL and environment. The token is already scrubbed."""
    kept = []
    for line in str(output or "").splitlines():
        low = line.lower()
        if any(word in low for word in ("deployment", "environment", "branch", "pages.dev", "production", "preview")):
            kept.append(line.strip()[:300])
    for line in kept[:8]:
        print("[pages] " + line)


def alias_message() -> str:
    return "\n".join([
        "[pages] The production alias did not serve this build.",
        "[pages] https://viktorychapp.pages.dev/version.json stayed on a different SHA after " + str(RETRY_LIMIT) + " uploads.",
        "[pages] The mirror was not confirmed. Re-run Publish app.",
        "[pages] The public URL is https://viktorychapp.pages.dev/",
    ])


def deploy(directory: Path, run=None, sleep=None, project=None, opener=None, live=None) -> int:
    token = (os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()
    account = (os.environ.get("CLOUDFLARE_ACCOUNT_ID") or "").strip()
    if not token or not account:
        print("[pages] CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID is not set; skipping the Pages mirror.")
        return 0
    if not directory.is_dir():
        print("[pages] mirror directory is missing; skipping.")
        return 0
    pause = sleep or time.sleep
    state = project(account, token) if project else ensure_project(account, token, opener=opener, sleep=pause)
    if state == "denied":
        print(pages_permission_notice())
        return 0
    if state == "unavailable":
        return 1
    if state == "rejected":
        return 1
    wrangler = shutil.which("npx") or "npx"
    cmd = [
        wrangler, "wrangler", "pages", "deploy", str(directory),
        "--project-name", PROJECT,
        "--branch", "main",
        "--commit-dirty",
    ]
    sha = build_sha()
    if sha:
        cmd.extend(["--commit-hash", sha])
    print("[pages] uploading " + PROJECT)
    invoke = run or subprocess.run
    fetch = live or default_live
    cwd = str(Path(__file__).resolve().parents[1] / "worker")
    env = os.environ.copy()
    for attempt in range(RETRY_LIMIT):
        code, output = upload_once(cmd, cwd, env, invoke)
        if code == 0:
            # A clean exit and "couldn't ascertain" both wait for the alias.
            # Wrangler's own success line is not proof the production URL moved.
            note_wrangler(output)
            if deployment_unconfirmed(output):
                print("[pages] Wrangler could not confirm the deployment. Checking the production alias.")
            else:
                print("[pages] Checking the production alias.")
            if sha and alias_ready(sha, directory, fetch, pause):
                print("[pages] mirror URL https://viktorychapp.pages.dev/")
                return 0
            print("[pages] production alias is not this build yet.")
            if attempt + 1 == RETRY_LIMIT:
                print(alias_message())
                return 1
            print("[pages] Retrying the upload.")
            pause(RETRY_WAITS[min(attempt, len(RETRY_WAITS) - 1)])
            continue
        kind = failure_kind(output)
        print("[pages] wrangler exited " + str(code))
        if output.strip():
            print(output.strip())
        if kind == "permission":
            print(pages_permission_notice())
            return 0
        if kind != "transient" or attempt + 1 == RETRY_LIMIT:
            if kind == "transient":
                print(outage_message(RETRY_LIMIT))
            else:
                print("[pages] The mirror was not updated.")
            return 1
        print("[pages] Cloudflare returned a temporary error. Retrying the upload.")
        pause(RETRY_WAITS[min(attempt, len(RETRY_WAITS) - 1)])
    print(outage_message(RETRY_LIMIT))
    return 1


class _Result:
    def __init__(self, code, out="", err=""):
        self.returncode = code
        self.stdout = out
        self.stderr = err


class _Response:
    def __init__(self, status, payload):
        self.status = status
        self._payload = payload

    def read(self):
        if isinstance(self._payload, str):
            return self._payload.encode("utf-8")
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def selftest() -> int:
    import io
    import tempfile
    import threading
    from contextlib import redirect_stdout
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    if not permission_denied(403, {}):
        return 1
    if not permission_denied(200, {"errors": [{"code": 10000, "message": "Authentication error"}]}):
        return 1
    if permission_denied(504, {"errors": [{"message": "Gateway Timeout"}]}):
        return 1
    if permission_denied(404, {"errors": [{"code": 8000007, "message": "Project not found"}]}):
        return 1
    sample = scrub("token " + ("a" * 40) + " ok")
    if "a" * 40 in sample or "[redacted]" not in sample:
        return 1
    notice = pages_permission_notice()
    if "CLOUDFLARE_API_TOKEN" not in notice or "Cloudflare Pages" not in notice or "new secret" not in notice:
        return 1
    old_name = "viktorych" + "-app"
    if PROJECT != "viktorychapp" or "https://viktorychapp.pages.dev/" not in notice or old_name in Path(__file__).read_text(encoding="utf-8"):
        return 1
    if create_result(400, {"success": False, "errors": [{"code": 8000013, "message": "name is reserved"}]}) != "rejected":
        return 1
    if create_result(403, {}) != "denied" or create_result(200, {"success": True}) != "ready":
        return 1
    if create_result(504, {"errors": [{"message": "Gateway Timeout"}]}) != "unavailable":
        return 1
    if failure_kind("GET /accounts/example/upload-token -> 504 Gateway Timeout\nReceived a malformed response from the API") != "transient":
        return 1
    if failure_kind("Authentication error\nstatus 403") != "permission":
        return 1
    if failure_kind("connection reset by peer") != "transient":
        return 1

    token = "secret-token-value-should-not-leak-123456"
    account = "account-id-should-not-leak-1234567890"
    directory = Path(tempfile.mkdtemp(prefix="pages-deploy-"))
    previous_token = os.environ.get("CLOUDFLARE_API_TOKEN")
    previous_account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    previous_sha = os.environ.get("GITHUB_SHA")
    build = "a" * 40
    os.environ["CLOUDFLARE_API_TOKEN"] = token
    os.environ["CLOUDFLARE_ACCOUNT_ID"] = account
    os.environ["GITHUB_SHA"] = build

    def matching_live(url):
        if "sw.js?t=" not in url and "version.json?t=" not in url:
            raise AssertionError("live read was not cache-busted")
        if "sw.js?t=" in url:
            return 200, 'const VERSION = "viktorych-a281-' + build + '"'
        return 200, {"sha": build}

    try:
        calls = {"n": 0}

        def flaky(cmd, cwd, env, text, capture_output):
            calls["n"] += 1
            if calls["n"] < 3:
                return _Result(1, "", "GET /accounts/" + account + "/pages/projects/viktorychapp/upload-token -> 504 Gateway Timeout\nReceived a malformed response from the API\n" + token)
            return _Result(0, "Deployment complete", "")

        waits = []
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = deploy(directory, run=flaky, sleep=lambda seconds: waits.append(seconds), project=lambda _a, _b: "exists", live=matching_live)
        text = buf.getvalue()
        if code != 0 or calls["n"] != 3 or waits != [1, 2]:
            print("retry then success failed", code, calls["n"], waits)
            return 1
        if token in text or account in text or "cannot edit Cloudflare Pages" in text:
            print("retry log leaked or looked like a permission skip")
            return 1

        def always_504(cmd, cwd, env, text, capture_output):
            return _Result(1, "", "upload-token -> 504 Gateway Timeout " + token)

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = deploy(directory, run=always_504, sleep=lambda _s: None, project=lambda _a, _b: "exists")
        text = buf.getvalue()
        if code != 1 or "failed after 3 tries" not in text or "not a token permission" not in text:
            print("persistent 504 did not fail loudly")
            return 1
        if token in text or "cannot edit Cloudflare Pages" in text:
            print("persistent 504 was treated as a permission skip or leaked")
            return 1

        seen = {"n": 0}

        def denied(cmd, cwd, env, text, capture_output):
            seen["n"] += 1
            return _Result(1, "", "Authentication error 403 " + token)

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = deploy(directory, run=denied, sleep=lambda _s: (_ for _ in ()).throw(AssertionError("permission must not retry")), project=lambda _a, _b: "exists")
        text = buf.getvalue()
        if code != 0 or seen["n"] != 1 or "cannot edit Cloudflare Pages" not in text or token in text:
            print("403 was not a one-try permission skip")
            return 1

        polls = {"n": 0}

        def late_alias(url):
            if "sw.js?t=" not in url:
                raise AssertionError("shell read was not cache-busted")
            polls["n"] += 1
            sha = build if polls["n"] >= 3 else ("b" * 40)
            return 200, 'const VERSION = "viktorych-a281-' + sha + '"'

        uploads = {"n": 0}

        def unconfirmed(cmd, cwd, env, text, capture_output):
            uploads["n"] += 1
            return _Result(0, "Deployment complete! However, we couldn't ascertain the final status of your deployment.", "")

        waits = []
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = deploy(directory, run=unconfirmed, sleep=lambda seconds: waits.append(seconds), project=lambda _a, _b: "exists", live=late_alias)
        text = buf.getvalue()
        if code != 0 or uploads["n"] != 1 or polls["n"] != 3 or waits != [CONFIRM_INTERVAL, CONFIRM_INTERVAL]:
            print("unconfirmed deploy did not wait for the shell", code, uploads["n"], polls["n"], waits)
            return 1
        if "mirror URL" not in text or token in text:
            print("unconfirmed deploy did not confirm the alias")
            return 1

        stale_polls = {"n": 0}

        def stale_alias(url):
            if "sw.js?t=" not in url and "version.json?t=" not in url:
                raise AssertionError("live read was not cache-busted")
            stale_polls["n"] += 1
            if "sw.js?t=" in url:
                return 200, 'const VERSION = "viktorych-a281-' + ("c" * 40) + '"'
            return 200, {"sha": "c" * 40}

        clean_uploads = {"n": 0}

        def clean(cmd, cwd, env, text, capture_output):
            clean_uploads["n"] += 1
            return _Result(0, "Deployment complete", "")

        waits = []
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = deploy(directory, run=clean, sleep=lambda seconds: waits.append(seconds), project=lambda _a, _b: "exists", live=stale_alias)
        text = buf.getvalue()
        confirm_sleeps = [item for item in waits if item == CONFIRM_INTERVAL]
        if code != 1 or clean_uploads["n"] != RETRY_LIMIT or sum(confirm_sleeps) != CONFIRM_WAIT * RETRY_LIMIT:
            print("stale alias was not retried and failed", code, clean_uploads["n"], sum(confirm_sleeps))
            return 1
        if "did not serve this build" not in text or "mirror URL" in text or token in text or "cannot edit Cloudflare Pages" in text:
            print("stale alias passed or looked like a permission skip")
            return 1

        (directory / "version.json").write_text(json.dumps({"sha": "b" * 40}) + "\n", encoding="utf-8")
        asked = {"sw": 0, "version": 0}

        def previous_live(url):
            if "sw.js?t=" in url:
                asked["sw"] += 1
                return 200, 'const VERSION = "viktorych-a281-' + build + '"'
            if "version.json?t=" in url:
                asked["version"] += 1
                return 200, {"sha": "b" * 40}
            raise AssertionError("live read was not cache-busted")

        shell_uploads = {"n": 0}

        def shell_only(cmd, cwd, env, text, capture_output):
            shell_uploads["n"] += 1
            return _Result(0, "Deployment complete\nEnvironment: Production\nhttps://example.pages.dev\n", "")

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = deploy(directory, run=shell_only, sleep=lambda _s: None, project=lambda _a, _b: "exists", live=previous_live)
        text = buf.getvalue()
        (directory / "version.json").unlink()
        if code != 0 or shell_uploads["n"] != 1 or asked["sw"] != 1 or asked["version"] != 0:
            print("previous manifest blocked the shell deploy", code, shell_uploads, asked)
            return 1
        if "previous manifest" not in text or "Environment: Production" not in text or token in text:
            print("shell deploy did not record the alias")
            return 1

        (directory / "version.json").write_text(json.dumps({"sha": build}) + "\n", encoding="utf-8")

        def stuck_manifest(url):
            if "sw.js?t=" in url:
                return 200, 'const VERSION = "viktorych-a281-' + build + '"'
            if "version.json?t=" in url:
                return 200, {"sha": "c" * 40}
            raise AssertionError("live read was not cache-busted")

        manifest_uploads = {"n": 0}

        def manifest_upload(cmd, cwd, env, text, capture_output):
            manifest_uploads["n"] += 1
            return _Result(0, "Deployment complete", "")

        waits = []
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = deploy(directory, run=manifest_upload, sleep=lambda seconds: waits.append(seconds), project=lambda _a, _b: "exists", live=stuck_manifest)
        text = buf.getvalue()
        (directory / "version.json").unlink()
        confirm_sleeps = [item for item in waits if item == CONFIRM_INTERVAL]
        if code != 1 or manifest_uploads["n"] != RETRY_LIMIT or sum(confirm_sleeps) != CONFIRM_WAIT * RETRY_LIMIT:
            print("a stuck manifest did not fail", code, manifest_uploads["n"], sum(confirm_sleeps))
            return 1
        if "did not serve this build" not in text or token in text:
            print("a stuck manifest passed")
            return 1

        seen_paths = []

        class LiveHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen_paths.append(self.path)
                path = self.path.split("?", 1)[0]
                if path.endswith("/sw.js"):
                    body = ('const VERSION = "viktorych-a281-' + build + '";\n').encode("utf-8")
                    kind = "text/javascript"
                elif path.endswith("/version.json"):
                    body = json.dumps({"sha": build}).encode("utf-8")
                    kind = "application/json"
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, fmt, *args):
                return

        live_http = ThreadingHTTPServer(("127.0.0.1", 0), LiveHandler)
        live_thread = threading.Thread(target=live_http.serve_forever, daemon=True)
        live_thread.start()
        global LIVE_SW, LIVE_VERSION
        saved_sw, saved_version = LIVE_SW, LIVE_VERSION
        LIVE_SW = "http://127.0.0.1:%d/sw.js" % live_http.server_address[1]
        LIVE_VERSION = "http://127.0.0.1:%d/version.json" % live_http.server_address[1]
        (directory / "version.json").write_text(json.dumps({"sha": build}) + "\n", encoding="utf-8")
        real_uploads = {"n": 0}

        def real_upload(cmd, cwd, env, text, capture_output):
            real_uploads["n"] += 1
            return _Result(0, "Deployment complete\nEnvironment: Production\n", "")

        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = deploy(directory, run=real_upload, sleep=lambda _s: None, project=lambda _a, _b: "exists", live=default_live)
            text = buf.getvalue()
        finally:
            LIVE_SW, LIVE_VERSION = saved_sw, saved_version
            live_http.shutdown()
            live_http.server_close()
            if (directory / "version.json").is_file():
                (directory / "version.json").unlink()
        if code != 0 or real_uploads["n"] != 1 or "serving this build" not in text:
            print("real default_live missed the shell", code, real_uploads["n"], text)
            return 1
        if not any(path.startswith("/sw.js?t=") for path in seen_paths) or not any(path.startswith("/version.json?t=") for path in seen_paths):
            print("real default_live did not cache-bust", seen_paths)
            return 1
        if token in text:
            print("real default_live leaked")
            return 1

        hits = {"n": 0}

        def opener(req, timeout=30):
            hits["n"] += 1
            if hits["n"] == 1:
                raise urllib.error.HTTPError(req.full_url, 504, "Gateway Timeout", hdrs=None, fp=io.BytesIO(b'{"errors":[{"message":"Gateway Timeout"}]}'))
            if hits["n"] == 2:
                raise urllib.error.URLError("timed out")
            return _Response(200, {"success": True, "result": {}})

        status, payload = request("GET", API + "/accounts/x/pages/projects/" + PROJECT, token, opener=opener, sleep=lambda _s: None)
        if status != 200 or not payload.get("success") or hits["n"] != 3:
            print("request did not retry 504 and a network error", status, hits["n"])
            return 1
    finally:
        if previous_token is None:
            os.environ.pop("CLOUDFLARE_API_TOKEN", None)
        else:
            os.environ["CLOUDFLARE_API_TOKEN"] = previous_token
        if previous_account is None:
            os.environ.pop("CLOUDFLARE_ACCOUNT_ID", None)
        else:
            os.environ["CLOUDFLARE_ACCOUNT_ID"] = previous_account
        if previous_sha is None:
            os.environ.pop("GITHUB_SHA", None)
        else:
            os.environ["GITHUB_SHA"] = previous_sha
        shutil.rmtree(directory, ignore_errors=True)
    print("pages deploy selftest ok")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    if not args.dir:
        print("pass --dir or --selftest")
        return 1
    return deploy(Path(args.dir))


if __name__ == "__main__":
    try:
        from log_redact import auto as _redact_logs

        _redact_logs()
    except ImportError:
        pass
    raise SystemExit(main())
