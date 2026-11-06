#!/usr/bin/env python3
"""Copy the app shell into _site from the files the page actually loads.

index.html, sw.js, and shared/lazy-modules.js name the shell. Static
imports inside those scripts are followed, so a module such as presence.js
pulls in shared/presence.js even when no hand-written list mentions it.
The build fails when any of those files is missing from the checkout or
from _site. Catalogs, icons, and the other data directories are copied
too, the same set the Pages job used to copy by hand.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Files the old deploy always published, even when no script tag names them.
# Private catalogs stay in R2. The shell must not publish them.
REQUIRED_EXTRAS = (
    "sw.js",
    "404.html",
    "robots.txt",
    ".nojekyll",
    "_redirects",
    ".well-known/assetlinks.json",
    "tv/index.html",
    "tv/version.json",
    "tv/qr.svg",
    "tv/ViktorychTV.apk",
)

PRIVATE_PUBLICATION = {
    "feeds.json",
    "stories.json",
    "people.json",
    "suggestions.json",
    "feeds.config.json",
    "status.json",
}

HTML_REF = re.compile(r"""(?:src|href)\s*=\s*['"]([^'"]+)['"]""", re.I)
QUOTED = re.compile(r"""['"]([^'"]+)['"]""")
SHELL_ARRAY = re.compile(r"SHELL_FILES\s*=\s*\[(.*?)\]", re.S)
# Files the worker caches on first use instead of with every update.
LAZY_ARRAY = re.compile(r"LAZY_FILES\s*=\s*\[(.*?)\]", re.S)
IMPORT_SCRIPTS = re.compile(r"importScripts\s*\((.*?)\)", re.S)
LAZY_SCRIPTS = re.compile(r"scripts\s*:\s*\[([^\]]*)\]")
MODULE_SPEC = re.compile(
    r"""(?:^|[^\w$])(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)""",
    re.S,
)


def normalize(raw: str) -> str | None:
    text = (raw or "").strip()
    if not text or text.startswith(("#", "data:", "mailto:", "javascript:", "blob:")):
        return None
    if text.startswith("//") or "://" in text:
        return None
    text = text.split("#", 1)[0].split("?", 1)[0].strip()
    if text.startswith("./"):
        text = text[2:]
    text = text.lstrip("/")
    if not text or text.endswith("/"):
        return None
    parts = Path(text).parts
    if ".." in parts:
        return None
    return "/".join(parts)


def _quoted(block: str) -> list[str]:
    found = []
    for raw in QUOTED.findall(block):
        path = normalize(raw)
        if path:
            found.append(path)
    return found


def refs_from_html(text: str) -> list[str]:
    found = []
    for raw in HTML_REF.findall(text):
        path = normalize(raw)
        if path:
            found.append(path)
    return found


def refs_from_worker(text: str) -> list[str]:
    found = []
    match = SHELL_ARRAY.search(text)
    if match:
        found.extend(_quoted(match.group(1)))
    lazy = LAZY_ARRAY.search(text)
    if lazy:
        found.extend(_quoted(lazy.group(1)))
    for block in IMPORT_SCRIPTS.findall(text):
        found.extend(_quoted(block))
    return found


def refs_from_lazy(text: str) -> list[str]:
    found = []
    for block in LAZY_SCRIPTS.findall(text):
        found.extend(_quoted(block))
    return found


def resolve_spec(base_file: str, spec: str) -> str | None:
    spec = spec.split("#", 1)[0].split("?", 1)[0].strip()
    if not spec.startswith("."):
        return None
    parts: list[str] = []
    for part in (Path(base_file).parent / spec).as_posix().split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                return None
            parts.pop()
            continue
        parts.append(part)
    return "/".join(parts) or None


def module_imports(text: str, base_file: str) -> list[str]:
    found = []
    for left, right in MODULE_SPEC.findall(text):
        spec = left or right
        path = resolve_spec(base_file, spec)
        if path:
            found.append(path)
    return found


def shell_files(root: Path) -> list[str]:
    """Every local file the shell, the worker, or the lazy loader names."""
    ordered: list[str] = []
    seen: set[str] = set()

    def add(path: str | None) -> None:
        if not path or path in seen:
            return
        seen.add(path)
        ordered.append(path)

    index = root / "index.html"
    worker = root / "sw.js"
    lazy = root / "shared" / "lazy-modules.js"
    if index.is_file():
        for path in refs_from_html(index.read_text(encoding="utf-8", errors="replace")):
            add(path)
    if worker.is_file():
        for path in refs_from_worker(worker.read_text(encoding="utf-8", errors="replace")):
            add(path)
    if lazy.is_file():
        add("shared/lazy-modules.js")
        for path in refs_from_lazy(lazy.read_text(encoding="utf-8", errors="replace")):
            add(path)

    # Follow static imports so a new module cannot ship without its dependency.
    pending = [path for path in ordered if path.endswith(".js") and not path.endswith(".min.js")]
    while pending:
        path = pending.pop()
        file = root / path
        if not file.is_file():
            continue
        for dep in module_imports(file.read_text(encoding="utf-8", errors="replace"), path):
            if dep in seen:
                continue
            add(dep)
            if dep.endswith(".js") and not dep.endswith(".min.js"):
                pending.append(dep)
    return ordered


def published_shell(root: Path) -> list[str]:
    """Shell files that are safe to publish. Catalog JSON stays in R2."""
    return [path for path in shell_files(root) if path not in PRIVATE_PUBLICATION]


def published_text(root: Path) -> str:
    """Names the deploy publishes, one per line, for checks."""
    lines = list(published_shell(root))
    lines.extend(REQUIRED_EXTRAS)
    lines.extend(
        (
            "data/music.json",
            "live/",
            "icons/",
            "nft/",
            "splash/",
            "screenshots/",
            "i18n/",
            "data/communities/index.json",
        )
    )
    return "\n".join(lines)


def _copy_file(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)


def copy_shell(root: Path, dest: Path) -> list[str]:
    files = published_shell(root)
    missing = [path for path in files if not (root / path).is_file()]
    if missing:
        raise SystemExit("referenced assets missing from the checkout:\n" + "\n".join(missing))
    for path in files:
        _copy_file(root / path, dest / path)
    return files


def _copy_tree(src: Path, dest: Path) -> None:
    if not src.is_dir():
        raise SystemExit(f"missing directory {src}")
    files = [path for path in src.rglob("*") if path.is_file() and not path.is_symlink()]
    if not files:
        raise SystemExit(f"empty directory {src}")
    for path in files:
        _copy_file(path, dest / path.relative_to(src))


def _copy_json_flat(src: Path, dest: Path, skip: set[str] | None = None) -> None:
    if not src.is_dir():
        return
    dest.mkdir(parents=True, exist_ok=True)
    skipped = skip or set()
    for path in src.rglob("*.json"):
        if not path.is_file() or path.is_symlink() or path.name in skipped:
            continue
        _copy_file(path, dest / path.name)


def _copy_parents(src_root: Path, root: Path, dest: Path, pattern: str) -> None:
    if not src_root.is_dir():
        return
    for path in src_root.rglob(pattern):
        if not path.is_file() or path.is_symlink():
            continue
        _copy_file(path, dest / path.relative_to(root))


def copy_payload(root: Path, dest: Path) -> None:
    missing = [name for name in REQUIRED_EXTRAS if not (root / name).is_file()]
    if missing:
        raise SystemExit("required site files missing from the checkout:\n" + "\n".join(missing))
    for name in REQUIRED_EXTRAS:
        _copy_file(root / name, dest / name)
    _copy_tree(root / "icons", dest / "icons")
    _copy_tree(root / "splash", dest / "splash")
    _copy_tree(root / "screenshots", dest / "screenshots")
    # Gift NFT token metadata (nft/<index>.json), public by design.
    if (root / "nft").is_dir():
        _copy_tree(root / "nft", dest / "nft")
    if (root / "i18n").is_dir():
        _copy_tree(root / "i18n", dest / "i18n")
    music = root / "data" / "music.json"
    if music.is_file():
        _copy_file(music, dest / "data" / "music.json")
    # The public index only. Comment pages stay in R2.
    index = root / "data" / "communities" / "index.json"
    if index.is_file():
        _copy_file(index, dest / "data" / "communities" / "index.json")
    live = root / "live"
    if live.is_dir():
        (dest / "live").mkdir(parents=True, exist_ok=True)
        for path in live.glob("*.json"):
            if path.is_file() and not path.is_symlink():
                _copy_file(path, dest / "live" / path.name)


def verify_site(dest: Path, files: list[str]) -> None:
    missing = [path for path in files if not (dest / path).is_file()]
    if missing:
        raise SystemExit("referenced assets missing from _site:\n" + "\n".join(missing))


def commit_built(sha: str, root: Path | None = None) -> str:
    """The commit time of sha in UTC (YYYY-MM-DDTHH:MM:SSZ), or "".

    sw.js carries this instead of the deploy time, so scheduled runs of the
    same commit publish byte-identical workers and phones see no new install.
    """
    if not sha:
        return ""
    import subprocess
    from datetime import datetime, timezone
    try:
        out = subprocess.run(
            ["git", "log", "-1", "--format=%ct", sha],
            cwd=str(root or Path(__file__).resolve().parent.parent),
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout.strip()
        return datetime.fromtimestamp(int(out), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return ""


def stamp_worker(dest: Path, sha: str) -> None:
    worker = dest / "sw.js"
    if not worker.is_file() or not sha:
        return
    text = worker.read_text(encoding="utf-8").replace("__SW_VERSION__", sha)
    built = commit_built(sha)
    if built:
        text = text.replace("__SW_BUILT__", built)
    worker.write_text(text, encoding="utf-8")


def copy_sidecar(root: Path, dest: Path) -> None:
    """Status, fallback, comments, archive, and discord stay in R2."""
    return None


def build(root: Path, dest: Path, sha: str = "") -> list[str]:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    files = copy_shell(root, dest)
    copy_payload(root, dest)
    copy_sidecar(root, dest)
    stamp_worker(dest, sha)
    verify_site(dest, files)
    return files


def selftest() -> int:
    files = shell_files(ROOT)
    published = set(files) | set(REQUIRED_EXTRAS)
    needed = (
        "presence.js",
        "presence.css",
        "shared/presence.js",
        "shared/pill-data.js",
        "shared/lazy-modules.js",
        "shared/feed-order.js",
        "localfirst.js",
        "direct.js",
        "dock.js",
        "dock.css",
        "index.html",
        "sw.js",
        "logo/v.svg",
        "shared/storage-contract.js",
    )
    missing = [name for name in needed if name not in published]
    if missing:
        print("shell list missing " + ", ".join(missing))
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "src"
        site = Path(tmp) / "site"
        root.mkdir()
        (root / "shared").mkdir()
        (root / "index.html").write_text(
            '<link rel="stylesheet" href="app.css"><script src="app.js"></script><script src="missing.js"></script>\n',
            encoding="utf-8",
        )
        (root / "sw.js").write_text('const SHELL_FILES = ["./index.html", "./app.js"];\n', encoding="utf-8")
        (root / "shared" / "lazy-modules.js").write_text(
            'var REGISTRY = { tv: { scripts: ["tv.js", "tv.css"] } };\n',
            encoding="utf-8",
        )
        (root / "app.js").write_text(
            'import {\n  n\n} from "./shared/dep.js";\nimport "./shared/side.js";\n',
            encoding="utf-8",
        )
        (root / "app.css").write_text("body{}\n", encoding="utf-8")
        listed = shell_files(root)
        for name in ("missing.js", "tv.js", "tv.css", "shared/dep.js", "shared/side.js"):
            if name not in listed:
                print("fixture did not name " + name)
                return 1
        try:
            copy_shell(root, site)
        except SystemExit as exc:
            text = str(exc)
            if "missing.js" not in text or "tv.js" not in text or "shared/dep.js" not in text or "shared/side.js" not in text:
                print(text)
                return 1
        else:
            print("copy should fail when a referenced file is missing")
            return 1
        for name, body in (
            ("missing.js", "/* m */\n"),
            ("tv.js", "/* tv */\n"),
            ("tv.css", "/* tv */\n"),
            ("shared/dep.js", "export const n = 1;\n"),
            ("shared/side.js", "export const side = 1;\n"),
        ):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")
        site.mkdir()
        copied = copy_shell(root, site)
        verify_site(site, copied)
        # A file removed after the copy must fail the _site check.
        (site / "missing.js").unlink()
        try:
            verify_site(site, copied)
        except SystemExit as exc:
            if "missing.js" not in str(exc):
                print(str(exc))
                return 1
        else:
            print("verify should fail when _site drops a referenced file")
            return 1
    built = Path(tempfile.mkdtemp(prefix="viktorych-site-"))
    try:
        built_files = build(ROOT, built)
        verify_site(built, built_files)
        for name in needed:
            if not (built / name).is_file():
                print("real build left out " + name)
                return 1
    finally:
        shutil.rmtree(built, ignore_errors=True)
    print("assemble_site: shell files " + str(len(files)))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Assemble _site from referenced shell files")
    parser.add_argument("--site", default="_site")
    parser.add_argument("--root", default=str(ROOT))
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        # The unattended-run guards ride along with the shell selftest,
        # because the workflow files cannot be edited by the bot token.
        import source_breaker
        source_breaker.selftest()
        return selftest()
    root = Path(args.root).resolve()
    dest = Path(args.site)
    if not dest.is_absolute():
        dest = (Path.cwd() / dest).resolve()
    sha = (os.environ.get("GITHUB_SHA") or "").strip()
    files = build(root, dest, sha)
    print(f"assembled {len(files)} shell files into {dest}")
    return 0


if __name__ == "__main__":
    try:
        from log_redact import auto as _redact_logs

        _redact_logs()
    except ImportError:
        pass
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(f"assemble_site: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
