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
      OWNER_HANDLE: "mirathorn",
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
async function signup(n, displayName, handle, extra) {
  const res = await call("/v1/signup", { method: "POST", ip: "203.0.113." + n, body: Object.assign({ displayName, handle }, extra || {}) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const found = async (token, q, ip) => {
  const res = await call("/v1/people?q=" + encodeURIComponent(q), { ip: ip || "198.51.100.61", token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body.accounts || []).map((a) => a.handle);
};

test("people search: exact handles, the search opt-out, and the owner bypass", async () => {
  const owner = await signup(61, "Owner", "mirathorn", { claimCode: "claim-test" });
  const fresh = await signup(62, "Fresh Person", "fresh_one");
  const quiet = await signup(63, "Quiet Person", "quiet_one");
  const other = await signup(64, "Other Person", "other_one");
  for (let i = 0; i < 25; i++) await signup(100 + i, "Filler " + i, "fresh_one" + String.fromCharCode(97 + i));

  // A new account shows up by its exact handle, with "_" kept and "@" dropped, first in the list.
  assert.equal((await found(other.token, "fresh_one"))[0], "fresh_one");
  assert.equal((await found(other.token, "@fresh_one"))[0], "fresh_one");
  assert.ok((await found(other.token, "Fresh Person")).includes("fresh_one"));
  assert.equal((await found(owner.token, "fresh_one"))[0], "fresh_one");

  // The setting defaults to on.
  const prefs = await call("/v1/suggestions/prefs", { token: quiet.token });
  assert.equal(prefs.body.searchable, true);
  assert.ok((await found(other.token, "quiet_one")).includes("quiet_one"));

  // Turning it off keeps the account out for others...
  const off = await call("/v1/suggestions/prefs", { method: "PUT", token: quiet.token, body: { searchable: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.searchable, false);
  assert.equal(off.body.discoverable, true, "the other switch is untouched");
  assert.deepEqual(await found(other.token, "quiet_one"), []);
  assert.deepEqual(await found(other.token, "Quiet Person"), []);

  // ...but the owner still finds it, and that sight is audit-logged.
  const db = await mf.getD1Database("DB");
  const before = await db.prepare("SELECT COUNT(*) AS n FROM locked_follow_audit WHERE action = 'search'").first();
  assert.deepEqual(await found(owner.token, "quiet_one"), ["quiet_one"]);
  const after = await db.prepare("SELECT COUNT(*) AS n FROM locked_follow_audit WHERE action = 'search' AND subject_id = ?").bind(quiet.account.publicId).first();
  assert.equal(after.n, before.n + 1);

  // Visible accounts don't write audit rows for the owner.
  await found(owner.token, "other_one");
  const still = await db.prepare("SELECT COUNT(*) AS n FROM locked_follow_audit WHERE action = 'search'").first();
  assert.equal(still.n, after.n);

  // Turning it back on brings the account back.
  await call("/v1/suggestions/prefs", { method: "PUT", token: quiet.token, body: { searchable: true } });
  assert.ok((await found(other.token, "quiet_one")).includes("quiet_one"));
  // Nobody finds themselves.
  assert.ok(!(await found(fresh.token, "fresh_one")).includes("fresh_one"));
});
