import assert from "node:assert/strict";
import test from "node:test";
import { planWorkflows, planVersion, tokenDaysLeft, usageProblems, shouldPause, runWatchdog, publicSummary, WATCH_KEY } from "../src/watchdog.js";

const H = 36e5;

test("inactive workflows are re-enabled, hand-disabled ones are left alone", () => {
  const plan = planWorkflows([
    { id: 1, path: ".github/workflows/sync.yml", state: "disabled_inactivity" },
    { id: 2, path: ".github/workflows/reddit.yml", state: "disabled_manually" },
    { id: 3, path: ".github/workflows/smoke.yml", state: "active" }
  ], []);
  assert.deepEqual(plan.enable, [{ id: 1, file: "sync.yml" }]);
  assert.deepEqual(plan.manual, ["reddit.yml"]);
});

test("three failed runs in a row flag a workflow; PR runs and cancels do not count", () => {
  const run = (file, conclusion, t, event) => ({ path: ".github/workflows/" + file, status: "completed", conclusion, created_at: "2026-10-29T0" + t + ":00:00Z", event: event || "schedule" });
  const plan = planWorkflows([], [
    run("reddit.yml", "failure", 1), run("reddit.yml", "failure", 2), run("reddit.yml", "cancelled", 3), run("reddit.yml", "failure", 4),
    run("sync.yml", "failure", 1), run("sync.yml", "success", 2), run("sync.yml", "failure", 3),
    run("discord-live.yml", "failure", 1, "pull_request"), run("discord-live.yml", "failure", 2), run("discord-live.yml", "failure", 3)
  ]);
  assert.deepEqual(plan.failing, ["reddit.yml"]);
});

test("a lagging version is redeployed after two hours, forced from the third try", () => {
  const now = Date.UTC(2026, 9, 29, 12);
  assert.equal(planVersion("abc1234", "abc1234ffff", now - 5 * H, now, {}).behind, false);
  const early = planVersion("old", "new", now - H, now, {});
  assert.equal(early.behind, true);
  assert.equal(early.redeploy, false);
  const first = planVersion("old", "new", now - 3 * H, now, {});
  assert.equal(first.redeploy, true);
  assert.equal(first.source, "watchdog");
  assert.equal(planVersion("old", "new", now - 5 * H, now, { lastDispatchAt: now - H }).redeploy, false);
  const third = planVersion("old", "new", now - 13 * H, now, { attempts: 2, lastDispatchAt: now - 4 * H });
  assert.equal(third.source, "watchdog-force");
  assert.equal(third.problem, true);
});

test("token expiry header and usage thresholds", () => {
  const now = Date.UTC(2026, 9, 29);
  assert.equal(tokenDaysLeft("2026-11-08 00:00:00 UTC", now), 10);
  assert.equal(tokenDaysLeft("", now), null);
  const p = usageProblems({ workerRequestsToday: 95000, d1RowsWrittenToday: 10 }, { r2Bytes: 9.5 * 1024 ** 3 });
  assert.deepEqual(p.map((x) => x.code).sort(), ["usage_r2_storage", "usage_worker_requests"]);
  assert.equal(shouldPause(p), true);
  assert.equal(shouldPause(usageProblems({ workerRequestsToday: 82000 })), false);
});

function memoryR2() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? { text: async () => map.get(key) } : null; },
    async put(key, value) { map.set(key, String(value)); }
  };
}

function reply(status, body, headers) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: headers || {} });
}

test("a full run re-enables, redeploys, and opens an issue only when Actions stopped", async () => {
  const now = Date.UTC(2026, 9, 29, 3, 7);
  const calls = [];
  const fetcher = async (url, init) => {
    const method = (init && init.method) || "GET";
    calls.push(method + " " + url);
    if (url.includes("/actions/workflows?")) return reply(200, { workflows: [{ id: 9, path: ".github/workflows/sync.yml", state: "disabled_inactivity" }] }, { "github-authentication-token-expiration": "2026-11-05 00:00:00 UTC" });
    if (url.endsWith("/enable")) return reply(204, "");
    if (url.includes("/actions/runs?")) return reply(200, { workflow_runs: [] });
    if (url.includes("sync.yml/runs")) return reply(200, { workflow_runs: [{ updated_at: new Date(now - 30 * H).toISOString() }] });
    if (url.endsWith("/commits/main")) return reply(200, { sha: "newsha", commit: { committer: { date: new Date(now - 5 * H).toISOString() } } });
    if (url.includes("github.io/ViktorychApp/version.json")) return reply(200, { sha: "oldsha" });
    if (url.endsWith("/dispatches")) return reply(204, "");
    if (url.endsWith("/issues") && method === "POST") return reply(201, { number: 77 });
    if (url === "https://viktorychgroup.github.io/ViktorychApp/") return reply(200, "<title>ViktorychApp</title>");
    if (url.includes("pages.dev")) return reply(200, "{}");
    return reply(404, "{}");
  };
  const env = { DATA: memoryR2(), GITHUB_DISPATCH_TOKEN: "test-token" };
  const doc = await runWatchdog(env, now, fetcher);
  assert.ok(calls.some((c) => c.startsWith("PUT ") && c.endsWith("/actions/workflows/9/enable")));
  assert.ok(calls.some((c) => c.startsWith("POST ") && c.endsWith("/publish-app.yml/dispatches")));
  const codes = doc.problems.map((p) => p.code);
  assert.ok(codes.includes("sync_stale"));
  assert.ok(codes.includes("gh_token_expiring"));
  assert.equal(doc.issue.number, 77);
  assert.equal(doc.ok, false);
  assert.ok(env.DATA.map.has(WATCH_KEY));
  assert.ok(!JSON.stringify(doc).includes("test-token"));
  const summary = publicSummary(doc);
  assert.ok(summary.problems.every((p) => p.code && p.text));
});
