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
      OWNER_HANDLE: "owner_test",
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
  try { body = text ? JSON.parse(text) : null; }
  catch (err) { body = { raw: text }; }
  return { status: res.status, body, text };
}

async function signup(ip, handle, name) {
  const created = await call("/v1/signup", {
    method: "POST",
    ip,
    body: { displayName: name, handle }
  });
  assert.equal(created.status, 201, created.text);
  return created.body;
}

test.before(async () => {
  mf = new Miniflare(workerOptions());
});

test.after(async () => {
  if (mf) await mf.dispose();
});

async function req(from, to, ip) {
  return call("/v1/friends/request", { method: "POST", token: from.token, ip, body: { targetId: "app:" + to.account.publicId } });
}

const handlesOf = (body) => Object.keys((body && body.groups) || {}).filter((g) => g !== "communities").reduce((acc, g) => acc.concat(body.groups[g].map((a) => a.h)), []);

async function setFriends(who, enabled, ip) {
  const res = await call("/v1/friends/settings", { method: "PUT", token: who.token, ip, body: { enabled } });
  assert.equal(res.status, 200, res.text);
}

test("Friends off: hidden friendships do not count for audiences or games, and never in People you may know", async () => {
  const gia = await signup("198.51.100.61", "gia_fg", "Gia Gap");
  const hal = await signup("198.51.100.62", "hal_fg", "Hal Gap");
  const ivy = await signup("198.51.100.63", "ivy_fg", "Ivy Gap");

  // Gia and Hal are friends.
  assert.equal((await req(gia, hal, "198.51.100.64")).status, 200);
  assert.equal((await call("/v1/friends/accept", { method: "POST", token: hal.token, ip: "198.51.100.65", body: { targetId: gia.account.publicId } })).body.status, "friends");

  const people = async (ip) => (await call("/v1/audience-lists/people", { token: gia.token, ip })).body.people.map((p) => p.handle);
  const board = async (ip) => (await call("/v1/games/board?game=regone", { token: gia.token, ip })).body.people.map((p) => p.handle);
  assert.ok((await people("198.51.100.66")).includes("hal_fg"), "friend is pickable for an audience");
  assert.ok((await board("198.51.100.67")).includes("hal_fg"), "friend is on the games board");

  // Ivy follows Hal, so Hal sees Ivy in People you may know.
  await call("/v1/follows", { method: "PUT", ip: "198.51.100.68", token: ivy.token, body: { id: "app:" + hal.account.publicId } });
  const before = await call("/v1/suggestions?fresh=1", { token: hal.token, ip: "198.51.100.69" });
  assert.equal(before.status, 200, before.text);
  assert.ok(handlesOf(before.body).includes("ivy_fg"), "suggested before: " + before.text);
  // Cached copy is served without ?fresh.
  await call("/v1/suggestions", { token: hal.token, ip: "198.51.100.69" });

  // Hal turns Friends off: no longer in Gia's audience picker or games board.
  await setFriends(hal, false, "198.51.100.70");
  assert.ok(!(await people("198.51.100.71")).includes("hal_fg"), "hidden friend not pickable");
  assert.ok(!(await board("198.51.100.72")).includes("hal_fg"), "hidden friend not on the games board");

  // Ivy turns Friends off: dropped from Hal's suggestions, cached or fresh.
  await setFriends(ivy, false, "198.51.100.73");
  const cached = await call("/v1/suggestions", { token: hal.token, ip: "198.51.100.74" });
  assert.ok(!handlesOf(cached.body).includes("ivy_fg"), "not in cached suggestions");
  const fresh = await call("/v1/suggestions?fresh=1", { token: hal.token, ip: "198.51.100.75" });
  assert.ok(!handlesOf(fresh.body).includes("ivy_fg"), "not in fresh suggestions");

  // Back on: everything returns.
  await setFriends(hal, true, "198.51.100.76");
  await setFriends(ivy, true, "198.51.100.77");
  assert.ok((await people("198.51.100.78")).includes("hal_fg"));
  assert.ok((await board("198.51.100.79")).includes("hal_fg"));
  assert.ok(handlesOf((await call("/v1/suggestions?fresh=1", { token: hal.token, ip: "198.51.100.80" })).body).includes("ivy_fg"));
});
