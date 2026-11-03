/* Reproduction: a request sent by the site owner's account must be listed for
   the receiver and accepted like any other. Fixtures use made-up handles. */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

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
      OWNER_HANDLE: "site_owner_demo",
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000"
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
  try { body = text ? JSON.parse(text) : null; } catch (err) { body = { raw: text }; }
  return { status: res.status, body, text };
}

async function signup(ip, handle, name) {
  const created = await call("/v1/signup", { method: "POST", ip, body: { displayName: name, handle } });
  assert.equal(created.status, 201, created.text);
  return created.body;
}

test.before(async () => { mf = new Miniflare(workerOptions()); });
test.after(async () => { if (mf) await mf.dispose(); });

test("a request from the owner account is listed for the receiver and accepts", async () => {
  const owner = await signup("203.0.113.201", "demo_owner", "Demo Owner");
  const user = await signup("203.0.113.202", "demo_user", "Demo User");
  const db = await mf.getD1Database("DB");
  await db.prepare("UPDATE accounts SET owner = 1 WHERE public_id = ?").bind(owner.account.publicId).run();

  const ownerId = "app:" + owner.account.publicId;
  const userId = "app:" + user.account.publicId;

  const sent = await call("/v1/friends/request", { method: "POST", token: owner.token, ip: "203.0.113.201", body: { targetId: userId } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.body.status, "sent", sent.text);

  const listed = await call("/v1/friends?tab=requests", { token: user.token, ip: "203.0.113.202" });
  assert.equal(listed.status, 200, listed.text);
  const incoming = listed.body.incoming || [];
  assert.ok(incoming.some((row) => String(row.id || "").includes(owner.account.publicId) || String(row.handle || "") === "demo_owner"), "owner's request is listed: " + listed.text);
  assert.equal(String(listed.body.requestsCount), "1", listed.text);

  const view = await call("/v1/friends?id=" + encodeURIComponent(ownerId), { token: user.token, ip: "203.0.113.202" });
  assert.equal(view.status, 200, view.text);
  assert.equal(view.body.status, "received", "profile view shows a received request: " + view.text);

  const accepted = await call("/v1/friends/accept", { method: "POST", token: user.token, ip: "203.0.113.202", body: { targetId: ownerId } });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.body.status, "friends", accepted.text);

  const after = await call("/v1/friends?id=" + encodeURIComponent(ownerId), { token: user.token, ip: "203.0.113.202" });
  assert.equal(after.body.status, "friends", after.text);
});
