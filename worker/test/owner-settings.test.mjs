/* Owner-managed member settings (owner_user_settings): only the owner can
   read or change another account's settings, values are validated, and a
   locked setting keeps the owner's value through every /v1/sync write. */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";
import { MANAGED, cleanValue, enforceLocks } from "../src/owner-settings.js";

const require = createRequire(import.meta.url);
const OWNER = "ownermaple";
let mf;

async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers();
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.70");
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.body) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (err) { body = { raw: text }; }
  return { status: res.status, body };
}

async function signup(handle, ip, extra) {
  const res = await call("/v1/signup", { method: "POST", ip, body: Object.assign({ displayName: handle, handle }, extra || {}) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test.before(async () => {
  mf = new Miniflare({
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
      OWNER_HANDLE: OWNER,
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io",
      PBKDF2_ITERATIONS: "1000"
    }
  });
});

test.after(async () => { if (mf) await mf.dispose(); });

test("managed settings match settings-registry.js", () => {
  const reg = require("../../settings-registry.js");
  for (const row of MANAGED) {
    const r = reg.get(row.key);
    assert.ok(r, "registry row for " + row.key);
    assert.equal(r.label, row.label, row.key + " label");
    assert.equal(r.sync, "account", row.key + " syncs with the account");
    assert.equal(r.def, row.def, row.key + " default");
    if (row.type === "bool") assert.equal(r.type, "bool", row.key);
    else r.values.forEach((v) => assert.ok(row.values.indexOf(v) >= 0, row.key + " takes " + v));
  }
  assert.equal(cleanValue("appearance", "dim").ok, true);
  assert.equal(cleanValue("appearance", "neon").ok, false);
  assert.equal(cleanValue("fontSize", 40).ok, false);
  assert.equal(cleanValue("haptics", "yes").ok, false);
  assert.equal(cleanValue("follows", []).ok, false);
  const p = { appearance: "default", prefsAt: { appearance: 5 } };
  assert.deepEqual(enforceLocks(p, { appearance: { value: "dim", at: 9 } }), ["appearance"]);
  assert.equal(p.appearance, "dim");
  assert.equal(p.prefsAt.appearance, 9);
});

test("only the owner manages settings; locks hold through member syncs", async () => {
  const owner = await signup(OWNER, "203.0.113.71", { claimCode: "claim-test" });
  const member = await signup("memberbirch", "203.0.113.72");
  const other = await signup("othercedar", "203.0.113.73");
  const id = member.account.publicId;
  const route = "/v1/owner/user-settings/" + id;

  // Authorization: anonymous 401, members 403 (even for themselves), owners can't target owners.
  assert.equal((await call(route)).status, 401);
  assert.equal((await call(route, { token: other.token })).status, 403);
  assert.equal((await call(route, { token: member.token })).status, 403);
  assert.equal((await call(route, { method: "PUT", token: other.token, body: { values: { appearance: "dim" } } })).status, 403);
  assert.equal((await call("/v1/owner/user-settings/" + owner.account.publicId, { token: owner.token })).status, 403);
  assert.equal((await call("/v1/owner/user-settings/nobody123", { token: owner.token })).status, 404);

  // The member synced their own choices first.
  const first = await call("/v1/sync", { method: "PUT", token: member.token, body: { payload: { appearance: "default", autoplay: "all", follows: ["x:demo"], prefsAt: { appearance: 1 } } } });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const read = await call(route, { token: owner.token });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.settings.appearance, "default");
  assert.deepEqual(read.body.locks, {});
  assert.ok(read.body.schema.some((r) => r.key === "privacyWebRTC"));
  assert.ok(!read.body.schema.some((r) => r.key === "follows" || r.key === "blocks" || r.key === "history"));

  // Bad values and unknown keys are refused.
  assert.equal((await call(route, { method: "PUT", token: owner.token, body: { values: { appearance: "neon" } } })).status, 400);
  assert.equal((await call(route, { method: "PUT", token: owner.token, body: { values: { follows: [] } } })).status, 400);
  assert.equal((await call(route, { method: "PUT", token: owner.token, body: { locks: { mutedWords: true } } })).status, 400);

  // Owner edit path: change a value without locking it, then change and lock another.
  const edit = await call(route, { method: "PUT", token: owner.token, body: { values: { autoplay: "wifi" } } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.settings.autoplay, "wifi");
  const lock = await call(route, { method: "PUT", token: owner.token, body: { values: { appearance: "dim" }, locks: { appearance: true, lang: true } } });
  assert.equal(lock.status, 200, JSON.stringify(lock.body));
  assert.deepEqual(lock.body.locks, { appearance: "dim", lang: "en" });

  // The member's devices see the owner's values and the locks; the rest of their data stays.
  const pulled = await call("/v1/sync", { token: member.token });
  assert.equal(pulled.status, 200);
  assert.equal(pulled.body.payload.appearance, "dim");
  assert.equal(pulled.body.payload.autoplay, "wifi");
  assert.deepEqual(pulled.body.payload.follows, ["x:demo"]);
  assert.deepEqual(pulled.body.locks, { appearance: "dim", lang: "en" });

  // Lock enforcement: a member write (even with a far-future stamp or as a device-only key) can't change a locked value.
  const push = await call("/v1/sync", { method: "PUT", token: member.token, body: { payload: { appearance: "default", lang: "ru", autoplay: "never", localKeys: ["appearance"], prefsAt: { appearance: Date.now() + 10 ** 9 } } } });
  assert.equal(push.status, 200, JSON.stringify(push.body));
  assert.equal(push.body.payload.appearance, "dim");
  assert.equal(push.body.payload.lang, "en");
  assert.equal(push.body.payload.autoplay, "never", "unlocked settings stay the member's choice");
  const after = await call("/v1/sync", { token: member.token });
  assert.equal(after.body.payload.appearance, "dim");
  assert.equal(after.body.payload.lang, "en");

  // Other members are untouched.
  const otherSync = await call("/v1/sync", { token: other.token });
  assert.deepEqual(otherSync.body.locks, {});

  // Unlock: the member can change it again.
  const unlock = await call(route, { method: "PUT", token: owner.token, body: { locks: { appearance: false } } });
  assert.deepEqual(unlock.body.locks, { lang: "en" });
  const free = await call("/v1/sync", { method: "PUT", token: member.token, body: { payload: { appearance: "default", prefsAt: { appearance: Date.now() } } } });
  assert.equal(free.body.payload.appearance, "default");

  // Each change is in the owner's access log.
  const audit = await call("/v1/owner/inspector/audit", { token: owner.token });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.rows.some((r) => r.id === id && r.action === "settings"));

  // The owner switch off stops the routes and the enforcement.
  const off = await call("/v1/owner/features", { method: "POST", token: owner.token, body: { name: "owner_user_settings", off: true } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.notEqual((await call(route, { token: owner.token })).status, 200);
  const freed = await call("/v1/sync", { method: "PUT", token: member.token, body: { payload: { lang: "ru" } } });
  assert.equal(freed.body.payload.lang, "ru");
  assert.equal(freed.body.locks, undefined);
});
