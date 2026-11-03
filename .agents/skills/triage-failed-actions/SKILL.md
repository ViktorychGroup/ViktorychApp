---
name: triage-failed-actions
description: Investigates, fixes and re-runs failed GitHub Actions runs on ViktorychApp (PR checks or scheduled workflows) so nothing is abandoned. Use when a check is red or the watchdog reports failures.
---

# Triage failed Actions

Nothing is ever abandoned: every failure is understood, fixed and re-run.

1. **List.** `gh run list --status failure --limit 20 --json databaseId,name,headBranch,headSha,createdAt` (PR: `gh pr checks <n>`). Ignore runs for commits that are no longer a branch head. TikTok workflows stay enabled; a failure there is triaged like any other workflow.
2. **Read.** `gh run view <id> --log-failed | tail -n 80`. Never paste log lines that contain tokens, cookies, handles or IDs anywhere public.
3. **Classify.**
   - Known flake (for example sign-up flow "settings never showed Log out", notifications 30 s timeout, birthday date checks near midnight UTC): re-run once with `gh run rerun <id> --failed`. If it fails again, treat it as real and fix the test or the code.
   - Real bug in the PR: fix on the branch, re-run the quick checks, push.
   - Main is red: fix main first with a tiny PR at the top of the queue; every PR inherits main's failure.
   - Expired or missing secret (three scheduled failures in a row, 401/403): do not try to work around it. Write the owner exact renewal steps using `docs/RUNNING-WITHOUT-BOT.md` section 3 (secret names only).
   - Needs a workflow edit: do not edit `.github/`. Write a ready patch in `docs/owner-patches/` and ask the owner.
   - Runner jam: cancel only superseded queued runs (a run whose commit is no longer the PR head), never the newest run of a branch.
4. **Re-run** after the fix and confirm green. For deploy workflows, finish with `/verify-live`.
5. **Report** in one or two plain sentences: what failed, why, what was fixed, and anything the owner must do.
