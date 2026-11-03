---
trigger: always_on
description: "Git and shipping rules: branches, PRs, one merge at a time, live verification."
---

# Shipping (always on)

- Work on a topic branch from fresh `origin/main`, ideally in its own `git worktree`. One feature or fix per PR. Push early.
- Never use `git stash` (shared across worktrees); use a WIP commit. Never merge an old `main` back; merge the current `origin/main` with a normal merge commit.
- No force-push or history rewrite without asking the owner. `--force-with-lease=refs/heads/<branch>:<sha you started from>` only on your own branch. Never force-push `main`.
- Never edit anything under `.github/` (workflows, Dependabot, CODEOWNERS, templates) without the owner's explicit approval. Prepare a patch in `docs/owner-patches/` instead.
- No PR comments. Updates go in commits and the PR description.
- Run the quick checks before pushing: `python3 scripts/check_i18n.py`, `python3 scripts/assemble_site.py --selftest`, `python3 scripts/handle_guard.py --selftest`, plus tests for what you touched (`python3 scripts/selftest.py`, `cd worker && npm test`, the matching `scripts/*_test.mjs`).
- Merge only when the PR is `CLEAN` and every check is success or skipped: `gh pr merge <n> --squash --match-head-commit <sha>`. One merge in flight at a time across all agents and people.
- After each merge verify live before the next one: deploy runs for the new main commit succeed, the live `version.json` shows main's commit, and `/v1/watchdog` returns 200 (`/verify-live`).
- `sw.js`: bump the line-7 stamp `// cache-bust: <UTC ISO>-<label>` above main's only when cached files change. On conflict take main's file and bump above it (`/resolve-sw-conflict`).
- D1 migration numbers in `worker/migrations/` must be unique and above the latest on main.
- Failed Actions are never abandoned: investigate, fix, re-run (`/triage-failed-actions`). TikTok workflows stay enabled.
- Leave Dependabot PRs, workflow or dependency changes, payments and data deletion for the owner.
- Keep usage low: no polling loops, read only what you need (`docs/LOW-USAGE.md`).
