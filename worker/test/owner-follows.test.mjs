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

async function signup(n, displayName, handle) {
  const res = await call("/v1/signup", { method: "POST", ip: "203.0.113." + n, body: { displayName, handle } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test("a new account follows only the owner's own accounts", async () => {
  const early = await signup(51, "Early Bird", "early_bird");
  const owner = await call("/v1/signup", { method: "POST", ip: "203.0.113.52", body: { displayName: "Owner", handle: "mirathorn", claimCode: "claim-test" } });
  assert.equal(owner.status, 201, JSON.stringify(owner.body));
  await signup(53, "Someone Else", "someone_else");
  const db = await mf.getD1Database("DB");
  const now = Date.now();
  await db.prepare("INSERT INTO account_identities (public_id, platform, handle, created_at) VALUES (?, 'x', 'owner_x_test', ?)").bind(owner.body.account.publicId, now).run();
  await db.prepare("INSERT INTO account_identities (public_id, platform, handle, verified, created_at) VALUES (?, 'x', 'owner_unverified', 0, ?)").bind(owner.body.account.publicId, now).run();

  const fresh = await signup(54, "Fresh User", "fresh_user");
  const listed = await db.prepare("SELECT target_id FROM account_follows WHERE follower_id = ? ORDER BY target_id").bind(fresh.account.publicId).all();
  assert.deepEqual(listed.results.map((r) => r.target_id).sort(), ["app:" + owner.body.account.publicId, "x:owner_x_test"].sort());

  const before = await db.prepare("SELECT COUNT(*) AS n FROM account_follows WHERE follower_id = ?").bind(early.account.publicId).first();
  assert.equal(before.n, 0, "existing accounts are not changed");
  const mine = await db.prepare("SELECT COUNT(*) AS n FROM account_follows WHERE follower_id = ?").bind(owner.body.account.publicId).first();
  assert.equal(mine.n, 0, "the owner does not follow itself");
});

test("every sign-up path follows the owner, and nothing else lands on a new account", async () => {
  const db = await mf.getD1Database("DB");
  const owner = await db.prepare("SELECT public_id FROM accounts WHERE owner = 1").first();
  assert.ok(owner, "the owner exists from the first test");
  const target = "app:" + owner.public_id;
  const follows = async (id) => (await db.prepare("SELECT target_id FROM account_follows WHERE follower_id = ?").bind(id).all()).results.map((r) => r.target_id);

  const temp = await call("/v1/signup", { method: "POST", ip: "203.0.113.61", body: { temporary: true, expiresIn: "1d", displayName: "Short Stay" } });
  assert.equal(temp.status, 201, JSON.stringify(temp.body));
  assert.ok((await follows(temp.body.account.publicId)).includes(target), "temporary sign-up follows the owner");

  const bare = await call("/v1/signup", { method: "POST", ip: "203.0.113.62", body: { profileLess: true, displayName: "" } });
  assert.equal(bare.status, 201, JSON.stringify(bare.body));
  assert.ok((await follows(bare.body.account.publicId)).includes(target), "profile-less sign-up follows the owner");

  // A protected owner still gets the follow directly, never as a request.
  await db.prepare("UPDATE accounts SET protected_account = 1 WHERE public_id = ?").bind(owner.public_id).run();
  const quiet = await signup(63, "Quiet Owner Fan", "quiet_fan");
  assert.ok((await follows(quiet.account.publicId)).includes(target), "a protected owner is still followed");
  await db.prepare("UPDATE accounts SET protected_account = 0 WHERE public_id = ?").bind(owner.public_id).run();

  // A device's guest follows never bulk-import into a new account.
  const fresh = await signup(64, "No Import", "no_import");
  const imported = await call("/v1/follows/import", { method: "POST", ip: "203.0.113.65", token: fresh.token, body: { ids: ["x:copperlane", "youtube:news", "rss:example"] } });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.imported, 0);
  assert.deepEqual((await follows(fresh.account.publicId)).sort(), [target, "x:owner_x_test"].sort());

  // An older account (before the owner-only start) still moves its follows.
  const legacy = await signup(66, "Old Timer", "old_timer");
  await db.prepare("UPDATE accounts SET created_at = ? WHERE public_id = ?").bind(Date.UTC(2026, 9, 28, 18, 4, 30) - 86400000, legacy.account.publicId).run();
  const moved = await call("/v1/follows/import", { method: "POST", ip: "203.0.113.67", token: legacy.token, body: { ids: ["x:copperlane"] } });
  assert.equal(moved.status, 200);
  assert.ok(moved.body.imported === undefined);

  // Unfollowing the owner is remembered, so a backfill never adds it back.
  const off = await call("/v1/follows", { method: "DELETE", ip: "203.0.113.68", token: fresh.token, body: { id: target } });
  assert.equal(off.status, 200, off.text);
  const drop = await db.prepare("SELECT follower_id FROM owner_follow_drops WHERE follower_id = ?").bind(fresh.account.publicId).first();
  assert.ok(drop, "the unfollow is remembered");
});

test("the owner-follow backfill adds only missed passkey sign-ups, once", async () => {
  const fs = await import("node:fs");
  const sql = fs.readFileSync(new URL("../migrations/0125_owner_follow_backfill.sql", import.meta.url), "utf8");
  const db = await mf.getD1Database("DB");
  const owner = await db.prepare("SELECT public_id FROM accounts WHERE owner = 1").first();
  const target = "app:" + owner.public_id;
  for (const stmt of [
    "CREATE TABLE IF NOT EXISTS webauthn_credentials (credential_id TEXT PRIMARY KEY, public_id TEXT NOT NULL, rp_id TEXT NOT NULL, public_key TEXT NOT NULL, algorithm INTEGER NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0, transports TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', aaguid TEXT NOT NULL DEFAULT '', backup_eligible INTEGER NOT NULL DEFAULT 0, backup_state INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS point_ledger (id TEXT PRIMARY KEY, public_id TEXT NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS account_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))",
    "CREATE TABLE IF NOT EXISTS account_deletion_jobs (id TEXT PRIMARY KEY, public_id TEXT NOT NULL, status TEXT NOT NULL)"
  ]) { try { await db.prepare(stmt).run(); } catch (err) { /* the worker made it already */ } }

  const missed = await signup(71, "Key Person", "key_person");
  const tapped = await signup(72, "Tapped Off", "tapped_off");
  const numberOnly = await signup(73, "Number Only", "number_only");
  const now = Date.now();
  for (const a of [missed, tapped, numberOnly]) {
    await db.prepare("DELETE FROM account_follows WHERE follower_id = ? AND target_id = ?").bind(a.account.publicId, target).run();
  }
  for (const a of [missed, tapped]) {
    await db.prepare("INSERT INTO webauthn_credentials (credential_id, public_id, rp_id, public_key, algorithm, created_at) VALUES (?, ?, 'x', 'k', -7, ?)").bind("cred-" + a.account.publicId, a.account.publicId, now).run();
  }
  await db.prepare("INSERT INTO owner_follow_drops (follower_id, created_at) VALUES (?, ?)").bind(tapped.account.publicId, now).run();

  const statements = sql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  await db.batch(statements.map((s) => db.prepare(s)));
  const has = async (id) => !!(await db.prepare("SELECT 1 AS y FROM account_follows WHERE follower_id = ? AND target_id = ?").bind(id, target).first());
  assert.equal(await has(missed.account.publicId), true, "a missed passkey sign-up gets the owner follow");
  assert.equal(await has(tapped.account.publicId), false, "an unfollow is kept");
  assert.equal(await has(numberOnly.account.publicId), false, "a number sign-up without the follow unfollowed on purpose");
  const run = await db.prepare("SELECT added FROM owner_follow_backfills ORDER BY ran_at DESC LIMIT 1").first();
  assert.equal(run.added, 1);
  await db.batch(statements.map((s) => db.prepare(s)));
  const runs = (await db.prepare("SELECT rowid AS r, added FROM owner_follow_backfills ORDER BY rowid").all()).results;
  const again = runs[runs.length - 1];
  assert.equal(again.added, 0, "running it again adds nothing");

  const { signupCheck } = await import("../src/watchdog.js");
  const check = await signupCheck({ DB: db }, Date.now());
  assert.equal(check.newest.followsOwner, false);
  assert.equal(check.ownerFollowBackfill.added, 0);
  assert.ok(!JSON.stringify(check).includes(numberOnly.account.publicId), "the check carries no ids");
});
