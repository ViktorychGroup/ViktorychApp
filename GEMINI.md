# GEMINI.md

Google Antigravity / Gemini: before doing anything in this repository, read these in order:

1. `AGENTS.md` (the single source of truth: architecture, run, test, ship, design and hard rules)
2. `docs/HANDOFF.md` (history and the merge-queue procedure)
3. `docs/STATUS.md` (what is live, open PRs, what needs the owner)

Workspace rules are in `.agents/rules/` and slash-command skills in `.agents/skills/` (`/ship-a-pr`, `/verify-live`, `/resolve-sw-conflict`, `/add-feature-with-switch`, `/triage-failed-actions`).

Top must-not rules:

- Never print, log, commit or ask in chat for a secret, token, cookie or signing key. Secrets live only in GitHub or Worker secrets, set by the owner.
- Never put usernames, handles, account IDs, emails or other personal data of real people anywhere in the repo, commits, PR text, logs or artifacts.
- Never edit `.github/` without the owner's approval. Never use `git stash`. No force-push or history rewrite without asking. No PR comments.
- Merge one PR at a time, only when CLEAN and green, then verify live (`version.json` matches main, watchdog returns 200) before the next.
- Match X.com 1:1. Every new string in en, es, ru and hi. Every new feature behind its own switch.
- Discord: no automated, scheduled or bulk sending; joins only on a user's tap; never solve captchas. Do not touch the ReGone websocket. TikTok workflows stay enabled.
- Messages to other people are only drafted for the owner to send.
