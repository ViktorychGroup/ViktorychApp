#!/usr/bin/env python3
"""Write _site/version.json during the Pages deploy.

One short request reads the live version.json (the previous deploy). One
GitHub compare reads merged pull request titles since that sha. Each request
is capped at a few seconds. A miss still writes the sha and the build time,
so the shell deploy does not wait on the changelog.

The published sha is the last deploy that passed the live check. It can lag
the service worker when that check has not passed. Clients treat the running
service worker build as the truth: a mismatch is not an update, and a missing
or unreadable file leaves the open copy alone.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SHA_RE = re.compile(r"^[0-9a-f]{7,64}$")
BUILT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
MENTION_RE = re.compile(r"@[A-Za-z0-9][\w.-]*")
PR_SUFFIX_RE = re.compile(r"\s*\(#\d+\)\s*$")
MERGE_PR_RE = re.compile(r"^Merge pull request #\d+ from \S+", re.I)
MERGE_BRANCH_RE = re.compile(r"^Merge branch ", re.I)
LIMIT = 8
LIVE_TIMEOUT = 3
COMPARE_TIMEOUT = 4


def valid_sha(value: str) -> str:
    text = str(value or "").strip().lower()
    if SHA_RE.fullmatch(text):
        return text
    return ""


def clean_title(title: str) -> str:
    text = str(title or "").replace("\r", " ").replace("\n", " ")
    text = PR_SUFFIX_RE.sub("", text)
    text = MENTION_RE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip(" \t-–—:|")
    if not text or MERGE_PR_RE.match(text) or MERGE_BRANCH_RE.match(text):
        return ""
    if len(text) > 140:
        text = text[:137].rstrip() + "…"
    return text


def title_from_message(message: str) -> str:
    lines = [line.strip() for line in str(message or "").splitlines()]
    subject = lines[0] if lines else ""
    if MERGE_PR_RE.match(subject):
        body = next((line for line in lines[1:] if line), "")
        return clean_title(body)
    if MERGE_BRANCH_RE.match(subject):
        return ""
    if PR_SUFFIX_RE.search(subject):
        return clean_title(subject)
    return ""


def notes_from_commits(commits, limit: int = LIMIT) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for commit in commits or []:
        message = ""
        if isinstance(commit, dict):
            inner = commit.get("commit") if isinstance(commit.get("commit"), dict) else {}
            message = inner.get("message") or commit.get("message") or ""
        title = title_from_message(message)
        key = title.casefold()
        if not title or key in seen:
            continue
        seen.add(key)
        found.append(title)
    found.reverse()
    return found[:limit]


def pages_version_url(repo: str) -> str:
    owner, _, name = str(repo or "").partition("/")
    if not owner or not name:
        return ""
    if name.lower() == owner.lower() + ".github.io":
        return f"https://{owner}.github.io/version.json"
    return f"https://{owner}.github.io/{name}/version.json"


def commit_built(sha: str) -> str:
    if not sha or set(sha) == {"0"}:
        return ""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import assemble_site
        return assemble_site.commit_built(sha)
    except Exception:
        return ""


def built_stamp(env_value: str, now: str) -> str:
    text = str(env_value or "").strip()
    if BUILT_RE.fullmatch(text):
        return text
    return now


def previous_from_payload(payload) -> dict:
    """Keep the manifest that is already live. A miss writes an empty sha.

    The empty sha does not advertise a version whose files are not published yet.
    """
    if not isinstance(payload, dict):
        return build_doc("", "", [])
    sha = valid_sha(str(payload.get("sha") or ""))
    if not sha:
        return build_doc("", "", [])
    built = str(payload.get("built") or "")
    if not BUILT_RE.fullmatch(built):
        built = ""
    notes = []
    for item in payload.get("changelog") or []:
        text = clean_title(str(item))
        if text:
            notes.append(text)
    return build_doc(sha, built, notes)


def build_doc(sha: str, built: str, notes: list[str]) -> dict:
    full = valid_sha(sha)
    return {
        "name": "ViktorychApp",
        "sha": full,
        "short": full[:7] if full else "",
        "built": built,
        "changelog": list(notes)[:LIMIT],
    }


def fetch_json(url: str, timeout: float, token: str = "") -> dict | list | None:
    if not url:
        return None
    headers = {"User-Agent": "viktorych-version", "Accept": "application/vnd.github+json"}
    if token and "api.github.com" in url:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        print(f"version note skipped: {exc.__class__.__name__}")
        return None
    if isinstance(payload, (dict, list)):
        return payload
    return None


def changelog_for(repo: str, sha: str, token: str) -> list[str]:
    previous_url = pages_version_url(repo)
    previous = fetch_json(previous_url, LIVE_TIMEOUT) if previous_url else None
    base = ""
    if isinstance(previous, dict):
        base = valid_sha(str(previous.get("sha") or ""))
    head = valid_sha(sha)
    if not repo or not token or not base or not head or base == head:
        if not base:
            print("version.json notes=0 (no previous deploy)")
        return []
    url = f"https://api.github.com/repos/{repo}/compare/{base}...{head}"
    compared = fetch_json(url, COMPARE_TIMEOUT, token)
    commits = compared.get("commits") if isinstance(compared, dict) else None
    notes = notes_from_commits(commits if isinstance(commits, list) else [])
    print(f"version.json notes={len(notes)}")
    return notes


SW_SHA_RE = re.compile(r'const VERSION = "viktorych-[a-z0-9]+-([0-9a-f]{7,64})"')


def worker_sha(text: str) -> str:
    """The build stamped into sw.js. That is the sha version.json must use."""
    match = SW_SHA_RE.search(str(text or ""))
    if not match:
        return ""
    return valid_sha(match.group(1))


def resolve_build_sha(worker_text: str, env_sha: str) -> str:
    """Prefer the sha already written into sw.js over the environment."""
    stamped = worker_sha(worker_text)
    if stamped:
        return stamped
    return valid_sha(env_sha)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    out = "_site/version.json"
    if "--out" in args:
        at = args.index("--out")
        if at + 1 >= len(args):
            print("missing --out path", file=sys.stderr)
            return 1
        out = args[at + 1]
    sw_text = ""
    sw_path = Path("_site") / "sw.js"
    if sw_path.is_file():
        sw_text = sw_path.read_text(encoding="utf-8", errors="replace")
    sha = resolve_build_sha(sw_text, os.environ.get("GITHUB_SHA") or "")
    if not sha:
        sha = "0" * 40
        print("version.json used a placeholder sha")
    repo = os.environ.get("GITHUB_REPOSITORY") or ""
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # The commit time, the same stamp sw.js carries, so the app compares
    # like with like and a rerun of one commit writes the same manifest.
    built = commit_built(sha) or built_stamp(os.environ.get("VERSION_BUILT") or "", now)
    previous = "--previous" in args
    if previous:
        payload = fetch_json(pages_version_url(repo), LIVE_TIMEOUT) if repo else None
        doc = previous_from_payload(payload if isinstance(payload, dict) else None)
        print("version.json kept the published manifest" if doc.get("sha") else "version.json has no published manifest yet")
    else:
        notes = changelog_for(repo, sha, token) if repo else []
        doc = build_doc(sha, built, notes)
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"version.json sha={doc['short']} built={doc['built']}")
    return 0


def selftest() -> None:
    assert clean_title("Fix playback (#12)") == "Fix playback"
    assert clean_title("Thanks @octocat for the player (#3)") == "Thanks for the player"
    assert clean_title("Merge pull request #9 from octocat/fix") == ""
    assert title_from_message("Merge branch 'main' into feature") == ""
    merge = "Merge pull request #180 from ViktorychGroup/cursor/live-playback-past-1d23\n\nPlay owner lives through a fallback chain\n"
    assert title_from_message(merge) == "Play owner lives through a fallback chain"
    assert "ViktorychGroup" not in title_from_message(merge)
    commits = [
        {"commit": {"message": "Merge pull request #1 from someone/old\n\nOlder fix"}},
        {"commit": {"message": "A normal commit by someone"}},
        {"commit": {"message": "Show past lives (#12)"}},
        {"commit": {"message": "Merge pull request #2 from someone/new\n\nNewer fix thanks @someone"}},
    ]
    notes = notes_from_commits(commits)
    assert notes == ["Newer fix thanks", "Show past lives", "Older fix"]
    assert all("someone" not in note and "@" not in note for note in notes)
    doc = build_doc("abcdef1234567890", "2026-10-27T00:00:00Z", notes)
    assert doc["sha"] == "abcdef1234567890" and doc["short"] == "abcdef1"
    assert doc["name"] == "ViktorychApp" and doc["changelog"] == notes
    assert pages_version_url("ViktorychGroup/ViktorychApp").endswith("/ViktorychApp/version.json")
    assert pages_version_url("octocat/octocat.github.io") == "https://octocat.github.io/version.json"
    assert build_doc("not-a-sha", "t", [])["sha"] == ""
    assert built_stamp("2026-10-27T00:00:00Z", "2020-01-01T00:00:00Z") == "2026-10-27T00:00:00Z"
    assert built_stamp("yesterday", "2020-01-01T00:00:00Z") == "2020-01-01T00:00:00Z"
    kept = previous_from_payload({"sha": "abcdef1234567890", "built": "2020-01-01T00:00:00Z", "changelog": ["Keep this (#4)"]})
    assert kept["sha"] == "abcdef1234567890" and kept["changelog"] == ["Keep this"]
    assert previous_from_payload({"sha": "nope"})["sha"] == ""
    assert previous_from_payload(None)["sha"] == ""
    live_sw = "c2b9cb0959b7a68187171bda4af3af0fd596d274"
    stale = "3a6f2de18453d5416d9ed99ab622047825a105db"
    stamped = 'const VERSION = "viktorych-a281-' + live_sw + '";'
    assert worker_sha(stamped) == live_sw
    assert resolve_build_sha(stamped, stale) == live_sw
    assert resolve_build_sha("const VERSION = \"viktorych-a281-__SW_VERSION__\";", live_sw) == live_sw
    print("write_version ok")


if __name__ == "__main__":
    try:
        from log_redact import auto as _redact_logs

        _redact_logs()
    except ImportError:
        pass
    if "--selftest" in sys.argv:
        selftest()
    else:
        raise SystemExit(main())
