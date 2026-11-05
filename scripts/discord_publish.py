#!/usr/bin/env python3
"""Assemble the site and deploy it through the Pages artifact flow.

The last published Pages artifact is the base, so a discord refresh does not
drop feeds, comments, or the archive. The checkout's shell (including
discord-ui) and the local discord/ JSON are copied on top. Outside Actions
this only builds _site.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COPY_DIRS = ("icons", "splash", "screenshots", "i18n", "shared", "logo")
UA = "viktorych-preview/1.0"


def _token_clean(root: Path, token: str) -> None:
    if not token:
        return
    folder = root / "discord"
    if not folder.is_dir():
        return
    for path in folder.rglob("*.json"):
        text = path.read_text(encoding="utf-8")
        if token in text:
            raise RuntimeError("refusing to deploy a file that contains the Discord token")


def _github(path: str, token: str, accept: str = "application/vnd.github+json") -> bytes:
    request = urllib.request.Request(
        "https://api.github.com" + path,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": accept,
            "User-Agent": UA,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()


PAGES_ARTIFACTS = ("github-pages", "app-shell-version")


def pages_artifact(name: str) -> bool:
    """Sync's Pages uploads: the build (github-pages) and the version publish
    (app-shell-version), with or without the per-run suffix."""
    name = str(name or "")
    return any(name == base or name.startswith(base + "-") for base in PAGES_ARTIFACTS)


def _latest_artifact(repo: str, token: str) -> dict | None:
    artifacts = []
    raw = _github(f"/repos/{repo}/actions/artifacts?per_page=100", token)
    data = json.loads(raw.decode("utf-8"))
    artifacts = [item for item in (data.get("artifacts") or []) if isinstance(item, dict) and not item.get("expired") and pages_artifact(item.get("name"))]
    if not artifacts:
        raw = _github(f"/repos/{repo}/actions/artifacts?name=github-pages&per_page=20", token)
        data = json.loads(raw.decode("utf-8"))
        artifacts = [item for item in (data.get("artifacts") or []) if isinstance(item, dict) and not item.get("expired")]
    artifacts.sort(key=lambda item: item.get("created_at") or "", reverse=True)
    return artifacts[0] if artifacts else None


def _head_sha(root: Path) -> str:
    """The commit actually checked out (main after the refresh), not the
    commit this long run was started on."""
    try:
        sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, timeout=30, check=True).stdout.strip()
    except Exception:
        sha = ""
    if len(sha) == 40 and all(ch in "0123456789abcdef" for ch in sha):
        return sha
    return (os.environ.get("GITHUB_SHA") or "discord-live").strip() or "discord-live"


def _live_version(repo: str) -> bytes | None:
    """The version.json that is live now, so this publish never rolls it back."""
    owner, _, name = repo.partition("/")
    if not owner or not name:
        return None
    url = f"https://{owner.lower()}.github.io/{name}/version.json"
    try:
        request = urllib.request.Request(url, headers={"User-Agent": UA, "Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read()
        doc = json.loads(body.decode("utf-8"))
    except Exception as exc:
        print(f"[discord-live] live version.json unreadable: {type(exc).__name__}")
        return None
    sha = str(doc.get("sha") or "") if isinstance(doc, dict) else ""
    if len(sha) != 40:
        return None
    return body


def _keep_live_version(dest: Path, repo: str) -> None:
    body = _live_version(repo) if repo else None
    if body:
        (dest / "version.json").write_bytes(body)
        print("[discord-live] kept the live version.json")


def _safe_tar(tar: tarfile.TarFile, dest: Path) -> None:
    root = dest.resolve()
    for member in tar.getmembers():
        if member.issym() or member.islnk():
            continue
        name = member.name
        if name.startswith("/") or ".." in Path(name).parts:
            continue
        target = (dest / name).resolve()
        if root != target and root not in target.parents:
            continue
        kwargs = {"filter": "data"} if sys.version_info >= (3, 12) else {}
        tar.extract(member, dest, **kwargs)


def _extract_artifact(payload: bytes, dest: Path) -> bool:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    try:
        bundle = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile:
        return False
    tar_name = ""
    for name in bundle.namelist():
        if name.endswith(".tar"):
            tar_name = name
            break
    if not tar_name:
        return False
    with bundle.open(tar_name) as raw:
        blob = raw.read()
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:") as tar:
        _safe_tar(tar, dest)
    return (dest / "index.html").is_file()


def _copy_tree(src: Path, dest: Path) -> None:
    if not src.is_dir():
        return
    for path in src.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        target = dest / path.relative_to(src)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)


def _shell(root: Path):
    sys.path.insert(0, str(root / "scripts"))
    import assemble_site
    return assemble_site


def _overlay(root: Path, dest: Path) -> None:
    assembler = _shell(root)
    assembler.copy_shell(root, dest)
    for name in COPY_DIRS:
        _copy_tree(root / name, dest / name)
    music = root / "data" / "music.json"
    if music.is_file():
        (dest / "data").mkdir(parents=True, exist_ok=True)
        shutil.copy2(music, dest / "data" / "music.json")
    discord = root / "discord"
    if discord.is_dir():
        for path in discord.rglob("*.json"):
            target = dest / path.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
    worker = dest / "sw.js"
    if worker.is_file():
        sha = _head_sha(root)
        text = worker.read_text(encoding="utf-8").replace("__SW_VERSION__", sha)
        built = assembler.commit_built(sha, root) if hasattr(assembler, "commit_built") else ""
        if built:
            text = text.replace("__SW_BUILT__", built)
        worker.write_text(text, encoding="utf-8")
    assembler.verify_site(dest, assembler.shell_files(root))


def _from_checkout(root: Path, dest: Path) -> None:
    assembler = _shell(root)
    assembler.build(root, dest, _head_sha(root))
    subprocess.run([sys.executable, str(root / "scripts" / "share_pages.py"), "--site", str(dest)], check=False)
    assembler.verify_site(dest, assembler.shell_files(root))


def _refresh_checkout(root: Path) -> None:
    if not os.environ.get("GITHUB_ACTIONS"):
        return
    subprocess.run(["git", "fetch", "origin", "main"], cwd=root, check=False)
    subprocess.run(["git", "merge", "--ff-only", "origin/main"], cwd=root, check=False)


def assemble(root: Path, token: str) -> Path:
    _token_clean(root, token)
    _refresh_checkout(root)
    dest = root / "_site"
    repo = os.environ.get("GITHUB_REPOSITORY") or ""
    gh = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    used_artifact = False
    prior = None
    if repo and gh:
        try:
            artifact = _latest_artifact(repo, gh)
            if artifact and artifact.get("id"):
                payload = _github(f"/repos/{repo}/actions/artifacts/{artifact['id']}/zip", gh, "application/vnd.github+json")
                used_artifact = _extract_artifact(payload, dest)
                if used_artifact:
                    print(f"[discord-live] base artifact {artifact.get('id')}")
                    sys.path.insert(0, str(root / "scripts"))
                    import accounts_publish
                    prior = accounts_publish.read_gate(dest)
        except Exception as exc:
            print(f"[discord-live] artifact base skipped: {type(exc).__name__}")
    if not used_artifact:
        if os.environ.get("GITHUB_ACTIONS"):
            subprocess.run([sys.executable, str(root / "scripts" / "pull_snapshot.py")], cwd=root, check=False)
        _from_checkout(root, dest)
    else:
        _overlay(root, dest)
    if prior and prior.get("gate"):
        sys.path.insert(0, str(root / "scripts"))
        import accounts_publish
        accounts_publish.repair(dest, prior)
        kept = accounts_publish.read_gate(dest)
        if not kept.get("gate") or not kept.get("api"):
            raise SystemExit("refusing to publish Pages without the login wall")
    _keep_live_version(dest, repo)
    _token_clean(dest, token)
    return dest


def make_tar(site: Path, dest: Path) -> None:
    if dest.exists():
        dest.unlink()
    with tarfile.open(dest, "w") as tar:
        for path in sorted(site.rglob("*")):
            if not path.is_file() or path.is_symlink():
                continue
            tar.add(path, arcname=str(path.relative_to(site)), recursive=False)


def _pages_guard(root: Path):
    sys.path.insert(0, str(root / "scripts"))
    import pages_guard
    return pages_guard


def publish_site(root: Path, token: str = "") -> None:
    in_actions = bool(os.environ.get("GITHUB_ACTIONS"))
    repo = os.environ.get("GITHUB_REPOSITORY") or ""
    gh = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    if in_actions:
        # Publish app owns the app shell and version.json. Wait while its Pages
        # deploy or version publish is in flight instead of racing it.
        if not _pages_guard(root).wait_until_free(repo, gh):
            print("[discord-live] app publishing is still using Pages; this refresh waits for the next cycle")
            return
    since = time.time()
    site = assemble(root, token)
    if not in_actions:
        print("[discord-live] assembled _site; deploy runs in Actions")
        return
    handle = tempfile.NamedTemporaryFile(prefix="artifact-", suffix=".tar", delete=False)
    handle.close()
    tar_path = Path(handle.name)
    try:
        make_tar(site, tar_path)
        script = root / "scripts" / "pages_deploy.js"
        env = dict(os.environ, PAGES_GUARD_SINCE=str(int(since)))
        result = subprocess.run(["node", str(script), str(tar_path)], cwd=root, check=False, env=env)
        if result.returncode != 0:
            print("[discord-live] pages deploy returned " + str(result.returncode))
    finally:
        tar_path.unlink(missing_ok=True)
