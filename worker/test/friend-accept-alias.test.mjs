/* Reproduce: friend actions by a SECONDARY username of the sender fail.
   A request from an account with an extra username must be listed, viewed
   and accepted through that username too. Made-up handles only. */
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

test("a friend request accepts through the sender's extra username too", async () => {
  const sender = await signup("203.0.113.221", "alias_sender", "Alias Sender");
  const receiver = await signup("203.0.113.222", "alias_receiver", "Alias Receiver");

  const extra = await call("/v1/usernames", { method: "POST", token: sender.token, ip: "203.0.113.221", body: { handle: "alias_alt" } });
  assert.equal(extra.status, 201, extra.text);

  const sent = await call("/v1/friends/request", { method: "POST", token: sender.token, ip: "203.0.113.221", body: { targetId: "app:" + receiver.account.publicId } });
  assert.equal(sent.status, 200, sent.text);

  // The card the receiver may hold can carry the extra username instead of
  // the primary one; viewing and accepting through it must work like the primary.
  const view = await call("/v1/friends?id=" + encodeURIComponent("app:@alias_alt"), { token: receiver.token, ip: "203.0.113.222" });
  assert.equal(view.status, 200, view.text);
  assert.equal(view.body.status, "received", "profile view through the extra username: " + view.text);

  const accepted = await call("/v1/friends/accept", { method: "POST", token: receiver.token, ip: "203.0.113.222", body: { targetId: "app:@alias_alt" } });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.body.status, "friends", accepted.text);

  const after = await call("/v1/friends?id=" + encodeURIComponent("app:" + sender.account.publicId), { token: receiver.token, ip: "203.0.113.222" });
  assert.equal(after.body.status, "friends", after.text);
});

