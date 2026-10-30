/* Unattended watchdog. Runs from the Worker cron once an hour, so the site
   keeps itself alive with nobody (and no assistant) looking after it.

   Every hour it:
   - re-enables any workflow GitHub turned off for 60 days of inactivity
     ("disabled_inactivity"); a workflow the owner disabled by hand is left off,
   - checks GitHub Pages, the Cloudflare Pages mirror and the Render backup,
   - re-runs the deploy when the live version.json lags main for hours,
   - flags workflows whose last three runs failed (usually an expired secret),
   - flags the GitHub token, the analytics token and connected keys before or
     when they expire, and free-tier usage near its limit.

   Results go to R2 (owner/watchdog.json). The owner reads them in the app
   (owner-only banner) and through GET /v1/owner/health. A short public
   summary at GET /v1/watchdog lets the Sync workflow open a bot-authored
   issue, which GitHub emails to the owner. When GitHub Actions itself has
   stopped, the Worker opens the issue directly with GITHUB_DISPATCH_TOKEN
   (needs Issues: write) and, when OWNER_ALERT_CHAT_ID is set, sends one
   Telegram message through the existing bot. Nothing here prints a secret. */

import { usageReport, FREE_LIMITS } from "./usage.js";
import { ownerKeyAlerts } from "./owner-keys.js";
import { RENDER_BACKUP, quietHours, renderHours } from "./render-warm.js";

export const WATCH_KEY = "owner/watchdog.json";
export const REPO = "ViktorychGroup/ViktorychApp";
const API = "https://api.github.com/repos/" + REPO;
const PAGES = "https://viktorychgroup.github.io/ViktorychApp/";
const MIRROR = "https://viktorychapp.pages.dev/";
const HOUR = 36e5;
const DAY = 24 * HOUR;

// Workflows that run on their own. Three failed runs in a row is a problem.
export const WATCHED = [
  "sync.yml", "accounts.yml", "reddit.yml", "discord-live.yml", "media-extract.yml",
  "telegram-backup.yml", "gdrive-backup.yml", "backup-warmup.yml", "radio-check.yml",
  "tiktok-live.yml", "worker-dispatch-secret.yml"
];
const SYNC_STALE_MS = 6 * HOUR;
const BEHIND_REDEPLOY_MS = 2 * HOUR;
const BEHIND_PROBLEM_MS = 12 * HOUR;
const REDEPLOY_GAP_MS = 3 * HOUR;
const TOKEN_WARN_DAYS = 21;
const USAGE_WARN = 0.8;
const USAGE_PAUSE = 0.9;
const R2_FREE_BYTES = 10 * 1024 ** 3;
const D1_FREE_BYTES = 500 * 1024 ** 2;

let guardMemo = null;
let guardAt = 0;

function gh(env, path, init, fetcher) {
  const token = String(env.GITHUB_DISPATCH_TOKEN || "").trim();
  const opts = init || {};
  return fetcher(path.startsWith("http") ? path : API + path, {
    method: opts.method || "GET",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "viktorych-watchdog",
      "Content-Type": "application/json"
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
}

async function safeJson(res) {
  try { return await res.json(); } catch (err) { return null; }
}

function timed(fetcher, url, ms, init) {
  const opts = Object.assign({ cf: { cacheTtl: 0 } }, init || {});
  try { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(ms); }
  catch (err) { /* older runtimes fetch without a timeout */ }
  return fetcher(url, opts);
}

/* Pure: which workflows to re-enable and which keep failing. */
export function planWorkflows(workflows, runs) {
  const enable = [];
  const manual = [];
  (workflows || []).forEach((row) => {
    const file = String(row && row.path || "").split("/").pop();
    if (row && row.state === "disabled_inactivity") enable.push({ id: row.id, file });
    else if (row && row.state === "disabled_manually" && WATCHED.indexOf(file) >= 0) manual.push(file);
  });
  const byFile = {};
  (runs || []).forEach((run) => {
    if (!run || run.status !== "completed" || run.event === "pull_request") return;
    if (run.conclusion === "cancelled" || run.conclusion === "skipped") return;
    const file = String(run.path || "").split("/").pop();
    if (WATCHED.indexOf(file) < 0) return;
    (byFile[file] = byFile[file] || []).push(run);
  });
  const failing = [];
  Object.keys(byFile).forEach((file) => {
    const list = byFile[file].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 3);
    if (list.length === 3 && list.every((run) => run.conclusion === "failure")) failing.push(file);
  });
  return { enable, manual, failing: failing.sort() };
}

/* Pure: what to do when the live version lags main. */
export function planVersion(liveSha, mainSha, mainAt, now, state) {
  const st = state || {};
  if (!liveSha || !mainSha) return { behind: false };
  if (String(mainSha).indexOf(String(liveSha)) === 0 || String(liveSha).indexOf(String(mainSha)) === 0) return { behind: false, attempts: 0 };
  const age = now - (Number(mainAt) || now);
  const attempts = Number(st.attempts) || 0;
  const redeploy = age >= BEHIND_REDEPLOY_MS && now - (Number(st.lastDispatchAt) || 0) >= REDEPLOY_GAP_MS;
  return {
    behind: true,
    age,
    redeploy,
    // From the third try on, the run asks the deploy to publish the build
    // that passed its own offline smoke check, even if the live check flakes.
    source: attempts >= 2 ? "watchdog-force" : "watchdog",
    problem: age >= BEHIND_PROBLEM_MS
  };
}

export function tokenDaysLeft(header, now) {
  const text = String(header || "").trim();
  if (!text) return null;
  const at = Date.parse(text.replace(" UTC", "Z").replace(" ", "T"));
  if (!Number.isFinite(at)) return null;
  return Math.floor((at - now) / DAY);
}

export function usageProblems(usage, storage) {
  const out = [];
  const u = usage || {};
  const check = (value, limit, code, text) => {
    const n = Number(value);
    if (!Number.isFinite(n) || !limit) return;
    const ratio = n / limit;
    if (ratio >= USAGE_WARN) out.push({ code, level: ratio >= 1 ? "down" : "warn", ratio, text: text + " is at " + Math.round(ratio * 100) + "% of the free limit." });
  };
  check(u.workerRequestsToday, FREE_LIMITS.workerRequestsDay, "usage_worker_requests", "Worker requests today");
  check(u.d1RowsReadToday, FREE_LIMITS.d1RowsReadDay, "usage_d1_reads", "D1 rows read today");
  check(u.d1RowsWrittenToday, FREE_LIMITS.d1RowsWrittenDay, "usage_d1_writes", "D1 rows written today");
  check(u.durableRequestsToday, FREE_LIMITS.durableRequestsDay, "usage_durable", "Durable Object requests today");
  check(u.r2ClassAMonth, FREE_LIMITS.r2ClassAMonth, "usage_r2_class_a", "R2 writes this month");
  check(u.r2ClassBMonth, FREE_LIMITS.r2ClassBMonth, "usage_r2_class_b", "R2 reads this month");
  const s = storage || {};
  check(s.r2Bytes, R2_FREE_BYTES, "usage_r2_storage", "R2 storage");
  check(s.d1Bytes, D1_FREE_BYTES, "usage_d1_storage", "D1 database size");
  return out;
}

/* Optional cron work pauses while a daily limit is nearly spent. */
export function shouldPause(problems) {
  return (problems || []).some((p) => (p.code === "usage_worker_requests" || p.code === "usage_d1_reads" || p.code === "usage_d1_writes" || p.code === "usage_r2_class_a" || p.code === "usage_durable") && Number(p.ratio) >= USAGE_PAUSE);
}

const STORAGE_QUERY = `query S($acc: String!, $since: Date!) {
  viewer { accounts(filter: { accountTag: $acc }) {
    r2: r2StorageAdaptiveGroups(limit: 20, filter: { date_geq: $since }) { max { payloadSize metadataSize } dimensions { bucketName } }
    d1: d1StorageAdaptiveGroups(limit: 20, filter: { date_geq: $since }) { max { databaseSizeBytes } dimensions { databaseId } }
  } }
}`;

async function storageUsage(env, now, fetcher) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return null;
  try {
    const since = new Date(now - DAY).toISOString().slice(0, 10);
    const res = await fetcher("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer " + env.CF_ANALYTICS_TOKEN },
      body: JSON.stringify({ query: STORAGE_QUERY, variables: { acc: env.CF_ACCOUNT_ID, since } })
    });
    if (!res.ok) return null;
    const body = await safeJson(res);
    const acc = body && body.data && body.data.viewer && body.data.viewer.accounts && body.data.viewer.accounts[0];
    if (!acc) return null;
    const r2 = {};
    (acc.r2 || []).forEach((row) => {
      const name = row.dimensions && row.dimensions.bucketName || "";
      const n = Number(row.max && row.max.payloadSize || 0) + Number(row.max && row.max.metadataSize || 0);
      r2[name] = Math.max(r2[name] || 0, n);
    });
    let d1 = 0;
    (acc.d1 || []).forEach((row) => { d1 = Math.max(d1, Number(row.max && row.max.databaseSizeBytes || 0)); });
    return { r2Bytes: Object.values(r2).reduce((a, b) => a + b, 0), d1Bytes: d1 };
  } catch (err) {
    return null;
  }
}

async function analyticsToken(env, fetcher) {
  if (!env.CF_ANALYTICS_TOKEN) return null;
  try {
    const res = await fetcher("https://api.cloudflare.com/client/v4/user/tokens/verify", { headers: { Authorization: "Bearer " + env.CF_ANALYTICS_TOKEN } });
    const body = await safeJson(res);
    if (!res.ok || !body || !body.success) return { ok: false };
    return { ok: body.result && body.result.status === "active", expiresOn: body.result && body.result.expires_on || "" };
  } catch (err) {
    return null;
  }
}

async function readDoc(env) {
  if (!env.DATA) return {};
  try {
    const obj = await env.DATA.get(WATCH_KEY);
    if (!obj) return {};
    const parsed = JSON.parse(await obj.text());
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    return {};
  }
}

async function writeDoc(env, doc) {
  if (!env.DATA) return;
  try { await env.DATA.put(WATCH_KEY, JSON.stringify(doc)); } catch (err) { /* next hour writes again */ }
}

function add(list, code, level, text) {
  list.push({ code, level, text });
}

export async function runWatchdog(env, now, fetcher) {
  const at = Number(now) || Date.now();
  const f = fetcher || ((url, init) => fetch(url, init));
  const prev = await readDoc(env);
  const problems = [];
  const actions = [];
  const hourUtc = new Date(at).getUTCHours();
  const hasToken = !!String(env.GITHUB_DISPATCH_TOKEN || "").trim();
  const versionState = Object.assign({}, prev.version || {});
  let actionsDead = false;

  if (!hasToken) {
    add(problems, "gh_token_missing", "down", "The Worker secret GITHUB_DISPATCH_TOKEN is not set, so workflows cannot be re-enabled or re-run.");
  } else {
    // 1. Workflow states and recent runs.
    try {
      const wres = await gh(env, "/actions/workflows?per_page=100", null, f);
      if (wres.status === 401) add(problems, "gh_token_rejected", "down", "GitHub rejected GITHUB_DISPATCH_TOKEN. It has expired or was revoked. Make a new one (runbook step 2).");
      const days = tokenDaysLeft(wres.headers && wres.headers.get && wres.headers.get("github-authentication-token-expiration"), at);
      if (days !== null && days <= TOKEN_WARN_DAYS) add(problems, "gh_token_expiring", days <= 7 ? "down" : "warn", "GITHUB_DISPATCH_TOKEN expires in " + Math.max(0, days) + " days. Renew it (runbook step 2).");
      const wbody = wres.ok ? await safeJson(wres) : null;
      const rres = wres.ok ? await gh(env, "/actions/runs?branch=main&per_page=100", null, f) : null;
      const rbody = rres && rres.ok ? await safeJson(rres) : null;
      const plan = planWorkflows(wbody && wbody.workflows, rbody && rbody.workflow_runs);
      for (const row of plan.enable) {
        let ok = false;
        try {
          const res = await gh(env, "/actions/workflows/" + row.id + "/enable", { method: "PUT" }, f);
          ok = res.status === 204 || res.ok;
        } catch (err) { ok = false; }
        actions.push({ at, type: "enable", file: row.file, ok });
        if (!ok) add(problems, "workflow_disabled", "down", "GitHub turned off " + row.file + " for inactivity and the Worker could not turn it back on. The token needs Actions: Read and write.");
      }
      plan.manual.forEach((file) => add(problems, "workflow_off_" + file, "warn", file + " is turned off by hand in the Actions tab."));
      plan.failing.forEach((file) => add(problems, "workflow_failing_" + file, "warn", file + " failed three runs in a row. An expired secret is the usual cause (runbook section 3)."));

      // 2. Is the sync still running at all?
      const sres = await gh(env, "/actions/workflows/sync.yml/runs?status=success&per_page=1", null, f);
      const sbody = sres.ok ? await safeJson(sres) : null;
      const last = sbody && sbody.workflow_runs && sbody.workflow_runs[0];
      const lastAt = last ? Date.parse(last.updated_at || last.created_at || "") : 0;
      if (sres.ok && (!lastAt || at - lastAt > SYNC_STALE_MS)) {
        actionsDead = true;
        add(problems, "sync_stale", "down", "No successful Sync feeds run for over six hours. GitHub Actions may be off, out of quota or blocked (runbook section 4).");
      }

      // 3. Live version against main.
      const cres = await gh(env, "/commits/main", null, f);
      const cbody = cres.ok ? await safeJson(cres) : null;
      const mainSha = cbody && cbody.sha || "";
      const mainAt = Date.parse(cbody && cbody.commit && cbody.commit.committer && cbody.commit.committer.date || "") || at;
      let liveSha = "";
      try {
        const vres = await timed(f, PAGES + "version.json?watchdog=" + at, 20000);
        const vbody = vres.ok ? await safeJson(vres) : null;
        liveSha = vbody && vbody.sha || "";
      } catch (err) { liveSha = ""; }
      const v = planVersion(liveSha, mainSha, mainAt, at, versionState);
      if (!v.behind) {
        versionState.attempts = 0;
      } else {
        if (v.redeploy) {
          let ok = false;
          try {
            const res = await gh(env, "/actions/workflows/sync.yml/dispatches", { method: "POST", body: { ref: "main", inputs: { source: v.source } } }, f);
            ok = res.status === 204 || res.ok;
          } catch (err) { ok = false; }
          versionState.lastDispatchAt = at;
          versionState.attempts = (Number(versionState.attempts) || 0) + 1;
          actions.push({ at, type: "redeploy", source: v.source, ok });
        }
        if (v.problem) add(problems, "version_behind", "warn", "The live site has been behind main for " + Math.round(v.age / HOUR) + " hours. The Worker re-ran the deploy " + (versionState.attempts || 0) + " times (runbook section 5).");
      }
    } catch (err) {
      add(problems, "gh_unreachable", "warn", "The Worker could not reach the GitHub API this hour.");
    }
  }

  // 4. The three front doors.
  try {
    const res = await timed(f, PAGES, 20000);
    const text = res.ok ? await res.text() : "";
    if (!res.ok || text.indexOf("ViktorychApp") < 0) add(problems, "pages_down", "down", "GitHub Pages did not serve the app (HTTP " + res.status + ").");
  } catch (err) {
    add(problems, "pages_down", "down", "GitHub Pages did not answer.");
  }
  try {
    const res = await timed(f, MIRROR + "version.json?watchdog=" + at, 20000);
    if (!res.ok) add(problems, "mirror_down", "warn", "The Cloudflare Pages mirror did not answer (HTTP " + res.status + ").");
  } catch (err) {
    add(problems, "mirror_down", "warn", "The Cloudflare Pages mirror did not answer.");
  }
  // Render is only checked in the hours the Worker keeps it warm
  // (src/render-warm.js), so the watchdog never spends free instance hours
  // waking it. Hourly: the cheap /backup/health. Once a day: /v1/health,
  // which also proves the backup can reach D1 and R2.
  // Near Render's free monthly hours the backup is left asleep until the 1st.
  const renderRest = String(env.RENDER_WARM || "1") === "0" || quietHours(env).includes(hourUtc) || !!((await renderHours(env, at)) || {}).paused;
  if (!renderRest) {
    const root = String(env.BACKUP_HEALTH_URL || RENDER_BACKUP).replace(/\/(v1\/health)?$/, "").replace(/\/$/, "");
    try {
      const res = await timed(f, root + "/backup/health", 60000);
      if (!res.ok) add(problems, "render_down", "warn", "The Render backup is down (HTTP " + res.status + "). Sign-in still works through the Worker (runbook section 6).");
      else if (hourUtc === 12) {
        const deep = await timed(f, root + "/v1/health", 60000);
        const body = deep.ok ? await safeJson(deep) : null;
        if (!body || !body.ok || body.data === false) add(problems, "render_down", "warn", "The Render backup cannot reach D1 and R2. Sign-in still works through the Worker (runbook section 6).");
      }
    } catch (err) {
      add(problems, "render_down", "warn", "The Render backup did not answer.");
    }
  }
  if (env.DB) {
    try { await env.DB.prepare("SELECT 1").first(); }
    catch (err) { add(problems, "d1_down", "down", "D1 did not answer the Worker. A spent daily limit is the usual cause."); }
  }

  // 5. Once a day: tokens, keys, storage.
  const daily = !prev.dailyAt || at - Number(prev.dailyAt) >= 20 * HOUR;
  let dailyProblems = Array.isArray(prev.dailyProblems) ? prev.dailyProblems : [];
  if (daily) {
    dailyProblems = [];
    const tok = await analyticsToken(env, f);
    if (tok && !tok.ok) add(dailyProblems, "cf_analytics_token", "warn", "CF_ANALYTICS_TOKEN no longer works. The usage panel and usage alerts are blind (runbook step 7).");
    if (tok && tok.ok && tok.expiresOn) {
      const days = Math.floor((Date.parse(tok.expiresOn) - at) / DAY);
      if (days <= TOKEN_WARN_DAYS) add(dailyProblems, "cf_analytics_expiring", "warn", "CF_ANALYTICS_TOKEN expires in " + Math.max(0, days) + " days.");
    }
    const keys = await ownerKeyAlerts(env);
    keys.forEach((row) => add(dailyProblems, "key_" + row.slot, "warn", (row.label || row.slot) + " key is " + (row.status === "expired" ? "expired" : "signed out") + ". Replace it in Settings > Connected keys."));
    const storage = await storageUsage(env, at, f);
    usageProblems(null, storage).forEach((p) => dailyProblems.push(p));
  }
  dailyProblems.forEach((p) => problems.push(p));
  let usage = null;
  try { usage = await usageReport(env, at); } catch (err) { usage = null; }
  usageProblems(usage, null).forEach((p) => problems.push(p));

  // Keep when each problem was first seen.
  const since = {};
  (prev.problems || []).forEach((p) => { since[p.code] = p.since; });
  problems.forEach((p) => { p.since = since[p.code] || at; });

  const doc = {
    at,
    ok: !problems.some((p) => p.level === "down"),
    problems,
    pause: shouldPause(problems),
    version: versionState,
    dailyAt: daily ? at : prev.dailyAt,
    dailyProblems,
    actions: actions.concat(prev.actions || []).slice(0, 40),
    issue: prev.issue || null,
    told: prev.told || ""
  };
  await directAlerts(env, doc, actionsDead, f);
  await writeDoc(env, doc);
  guardMemo = doc;
  guardAt = at;
  return doc;
}

function issueBody(doc) {
  const lines = ["The Worker watchdog found these problems. This issue closes itself when they are gone.", ""];
  doc.problems.forEach((p) => lines.push("- **" + p.level + "** " + p.text));
  lines.push("", "What to do: docs/RUNNING-WITHOUT-BOT.md");
  return lines.join("\n");
}

/* Direct alerts only when GitHub Actions cannot raise them itself. */
async function directAlerts(env, doc, actionsDead, f) {
  const hasToken = !!String(env.GITHUB_DISPATCH_TOKEN || "").trim();
  const issue = doc.issue;
  try {
    if (actionsDead && hasToken && !(issue && issue.open)) {
      const res = await gh(env, "/issues", { method: "POST", body: { title: "Site health: GitHub Actions stopped", body: issueBody(doc) } }, f);
      const body = res.ok ? await safeJson(res) : null;
      doc.issue = body && body.number ? { number: body.number, open: true, at: doc.at } : { open: false, denied: res.status === 403 || res.status === 404, at: doc.at };
    } else if (!actionsDead && issue && issue.open && issue.number && hasToken) {
      await gh(env, "/issues/" + issue.number, { method: "PATCH", body: { state: "closed" } }, f);
      doc.issue = { number: issue.number, open: false, at: doc.at };
    }
  } catch (err) { /* the banner still shows it */ }
  // One Telegram message per new set of serious problems, at most daily.
  const chat = String(env.OWNER_ALERT_CHAT_ID || "").trim();
  const bot = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const serious = doc.problems.filter((p) => p.level === "down").map((p) => p.code).sort().join(",");
  if (!chat || !bot) return;
  const toldAt = Number(String(doc.told || "").split("|")[1]) || 0;
  const toldCodes = String(doc.told || "").split("|")[0];
  if (!serious) { doc.told = ""; return; }
  if (serious === toldCodes && doc.at - toldAt < DAY) return;
  try {
    const text = "ViktorychApp watchdog:\n" + doc.problems.filter((p) => p.level === "down").map((p) => "- " + p.text).join("\n");
    const res = await f("https://api.telegram.org/bot" + bot + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 3500), disable_web_page_preview: true })
    });
    if (res.ok) doc.told = serious + "|" + doc.at;
  } catch (err) { /* the banner still shows it */ }
}

/* Cheap read for the cron: should optional work pause? Ten-minute memo. */
export async function watchdogPause(env, now) {
  const at = Number(now) || Date.now();
  if (guardMemo && at - guardAt < 10 * 60 * 1000) return !!guardMemo.pause;
  const doc = await readDoc(env);
  guardMemo = doc;
  guardAt = at;
  return !!(doc.pause && at - Number(doc.at || 0) < 3 * HOUR);
}

export function publicSummary(doc) {
  const d = doc || {};
  return {
    ok: d.ok !== false,
    at: Number(d.at) || 0,
    problems: (d.problems || []).map((p) => ({ code: p.code, level: p.level, text: p.text, since: p.since }))
  };
}

export async function handleWatchdog(request, env, path, deps) {
  if (path === "/v1/watchdog" && request.method === "GET") {
    return deps.json(200, publicSummary(await readDoc(env)));
  }
  if (path === "/v1/owner/health" && request.method === "GET") {
    const gate = await deps.requireOwner(request, env);
    if (gate.error) return gate.error;
    return deps.json(200, await readDoc(env));
  }
  if (path === "/v1/owner/health" && request.method === "POST") {
    const gate = await deps.requireOwner(request, env);
    if (gate.error) return gate.error;
    return deps.json(200, await runWatchdog(env, Date.now()));
  }
  return null;
}
