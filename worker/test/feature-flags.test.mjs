import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";

const dispatches = [];
const hosts = [];

let mf;

function workerOptions() {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    bindings: {
      ACCOUNT_PEPPER: "pepper-test",
      OWNER_CLAIM_CODE: "claim-test",
      OWNER_HANDLE: "owner_test",
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000",
      GITHUB_DISPATCH_TOKEN: "dispatch-test"
    },
    async outboundService(request) {
      const url = new URL(request.url);
      hosts.push(url.hostname);
      if (url.hostname === "api.github.com") {
        dispatches.push(url.pathname);
        return new Response(null, { status: 204 });
      }
      return new Response("no", { status: 404 });
    }
  };
}

async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.10");
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.body) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch (err) { body = { raw: text }; }
  return { status: res.status, body, text };
}

test.before(async () => {
  mf = new Miniflare(workerOptions());
});

test.after(async () => {
  if (mf) await mf.dispose();
});

async function signup(n, displayName, handle) {
  const res = await call("/v1/signup", { method: "POST", ip: "203.0.113." + n, body: { displayName, handle } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}


test("the owner can turn heavy features fully off", async () => {
  const owner = await call("/v1/signup", { method: "POST", ip: "203.0.113.61", body: { displayName: "Owner", handle: "owner_test", claimCode: "claim-test" } });
  assert.equal(owner.status, 201, JSON.stringify(owner.body));
  const member = await signup(62, "Member", "member_test");

  let pub = await call("/v1/features");
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.body.off, ["nostr", "nft"], "Nostr and gift NFTs start off until the owner turns them on");
  assert.equal(pub.body.features.includes("storage_recordings"), true);
  assert.equal(pub.body.features.includes("image_copy"), true);
  assert.equal(pub.body.off.includes("image_copy"), false);
  assert.equal(pub.body.off.includes("storage_recordings"), false);
  assert.equal((await call("/v1/nft/config")).status, 204, "gift NFTs are off by default");
  assert.ok(pub.body.features.includes("nostr"));
  for (const path of ["/.well-known/nostr.json?name=member_test", "/v1/nostr/posts/" + "a".repeat(32)]) {
    const res = await call(path);
    assert.equal(res.status, 204, path + " is off by default");
  }
  const nostrOn = await call("/v1/owner/features", { method: "POST", token: owner.body.token, body: { name: "nostr", off: false } });
  assert.deepEqual(nostrOn.body.off, ["nft"]);
  const nftOn = await call("/v1/owner/features", { method: "POST", token: owner.body.token, body: { name: "nft", off: false } });
  assert.deepEqual(nftOn.body.off, []);
  const nftConfig = await call("/v1/nft/config");
  assert.equal(nftConfig.status, 200);
  assert.equal(nftConfig.body.ready, false, "on but without a contract address, nothing can be minted");
  assert.equal((await call("/v1/nostr/posts/" + "a".repeat(32))).status, 404, "on: unknown posts have no Nostr link");
  pub = await call("/v1/features");
  assert.deepEqual(pub.body.off, []);
  assert.ok(pub.body.features.includes("shorts") && pub.body.features.includes("stories") && pub.body.features.includes("lives") && pub.body.features.includes("telegram"));

  const denied = await call("/v1/owner/features", { method: "POST", token: member.token, body: { name: "shorts", off: true } });
  assert.equal(denied.status, 403, "only the owner flips switches");
  const anon = await call("/v1/owner/features", { method: "POST", body: { name: "shorts", off: true } });
  assert.equal(anon.status, 401);
  const bad = await call("/v1/owner/features", { method: "POST", token: owner.body.token, body: { name: "nope", off: true } });
  assert.equal(bad.status, 400);

  const liveOn = await call("/v1/live", { token: member.token });
  assert.notEqual(liveOn.status, 204, "lives answer while on");

  for (const name of ["shorts", "lives", "stories", "telegram"]) {
    const res = await call("/v1/owner/features", { method: "POST", token: owner.body.token, body: { name, off: true } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  pub = await call("/v1/features");
  assert.deepEqual(pub.body.off.sort(), ["lives", "shorts", "stories", "telegram"]);

  const checks = [
    ["/v1/owner/tiktok", "GET", owner.body.token, 204],
    ["/v1/owner/tiktok/board", "GET", owner.body.token, 204],
    ["/v1/live", "GET", member.token, 204],
    ["/v1/live", "POST", member.token, 404],
    ["/v1/stories", "GET", member.token, 204],
    ["/v1/story-bar", "GET", member.token, 204],
    ["/tg/anything", "GET", "", 204]
  ];
  for (const [path, method, token, want] of checks) {
    const res = await call(path, { method, token: token || undefined, body: method === "POST" ? {} : undefined });
    assert.equal(res.status, want, path + " " + method + " is off");
    assert.equal(res.text, "", path + " returns no body");
  }

  // No cron work for an off feature: a stale live is left alone while lives are off.
  const db = await mf.getD1Database("DB");
  const old = Date.now() - 24 * 60 * 60 * 1000;
  await call("/v1/health");
  await db.prepare("CREATE TABLE IF NOT EXISTS live_sessions (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL DEFAULT 'public', fanout INTEGER NOT NULL DEFAULT 3, sources TEXT NOT NULL DEFAULT 'camera', pass_hash TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'live', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER NOT NULL DEFAULT 0)").run();
  await db.prepare("INSERT INTO live_sessions (id, host_id, state, created_at, updated_at) VALUES ('stale-live', ?, 'live', ?, ?)").bind(member.account.publicId, old, old).run();
  const worker = await mf.getWorker();
  await worker.scheduled({ cron: "* * * * *", scheduledTime: new Date(Date.now() + 60 * 1000) });
  let row = await db.prepare("SELECT state FROM live_sessions WHERE id = 'stale-live'").first();
  assert.equal(row.state, "live", "the live sweep does not run while lives are off");

  const on = await call("/v1/owner/features", { method: "POST", token: owner.body.token, body: { name: "lives", off: false } });
  assert.deepEqual(on.body.off.sort(), ["shorts", "stories", "telegram"]);
  await worker.scheduled({ cron: "* * * * *", scheduledTime: new Date(Date.now() + 120 * 1000) });
  row = await db.prepare("SELECT state FROM live_sessions WHERE id = 'stale-live'").first();
  assert.equal(row.state, "ended", "the live sweep runs again once lives are back on");
  const liveBack = await call("/v1/live", { token: member.token });
  assert.notEqual(liveBack.status, 204, "lives answer again");
});
