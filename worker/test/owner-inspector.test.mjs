import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { audienceSummary } from "../src/owner-inspector.js";

const OWNER = "ownerfern";
let mf;
let OWNER_TOKEN = "";

async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers();
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.10");
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.body) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (err) { body = { raw: text }; }
  return { status: res.status, body, text };
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

test("audience summary words", () => {
  assert.equal(audienceSummary({ include: { public: true }, exclude: {} }).level, "public");
  assert.equal(audienceSummary({ include: { followers: true }, exclude: {} }).hidden, true);
  assert.equal(audienceSummary({ include: { lists: ["l1"] }, exclude: { people: ["p"] } }).level, "custom");
  assert.equal(audienceSummary({ include: {}, exclude: {} }).level, "only_me");
});

test("only the owner inspects accounts; hidden usernames show; each open is audited", async () => {
  const owner = await signup(OWNER, "203.0.113.30", { claimCode: "claim-test" });
  OWNER_TOKEN = owner.token;
  const member = await signup("memberwillow", "203.0.113.31");
  const other = await signup("otheraspen", "203.0.113.32");

  // A second username only friends can see.
  const added = await call("/v1/usernames", { method: "POST", ip: "203.0.113.33", token: member.token, body: { handle: "willow_quiet", audience: { include: { friends: true } } } });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  // A second display name only friends can see.
  const dn = await call("/v1/display-names", { method: "POST", ip: "203.0.113.34", token: member.token, body: { name: "Willow Q", audience: { include: { friends: true } } } });
  assert.ok(dn.status === 200 || dn.status === 201, JSON.stringify(dn.body));

  // Non-owners: 403. Anonymous: 401.
  assert.equal((await call("/v1/owner/inspector/accounts", { token: other.token })).status, 403);
  assert.equal((await call("/v1/owner/inspector/accounts/" + member.account.publicId, { token: other.token })).status, 403);
  assert.equal((await call("/v1/owner/inspector/audit", { token: member.token })).status, 403);
  assert.equal((await call("/v1/owner/inspector/accounts")).status, 401);

  const list = await call("/v1/owner/inspector/accounts?sort=handle", { token: owner.token });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.totals.accounts, 3);
  const row = list.body.accounts.find((a) => a.handle === "memberwillow");
  assert.ok(row);
  assert.equal(row.extraNames, 1);
  assert.equal(row.hiddenNames, 1);

  // Search finds an account by its hidden username too.
  const found = await call("/v1/owner/inspector/accounts?q=willow_qu", { token: owner.token });
  assert.deepEqual(found.body.accounts.map((a) => a.handle), ["memberwillow"]);
  const filtered = await call("/v1/owner/inspector/accounts?filter=hidden_names", { token: owner.token });
  assert.deepEqual(filtered.body.accounts.map((a) => a.handle), ["memberwillow"]);

  const detail = await call("/v1/owner/inspector/accounts/" + row.id, { token: owner.token });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.audited, true);
  const quiet = detail.body.names.find((n) => n.handle === "willow_quiet");
  assert.ok(quiet, "hidden username is visible to the owner");
  assert.equal(quiet.audience.level, "friends");
  const dq = (detail.body.displayNames || []).find((n) => n.name === "Willow Q");
  assert.ok(dq, "hidden display name is visible to the owner");
  assert.equal(dq.audience.level, "friends");
  assert.equal(dq.audience.hidden, true);
  assert.deepEqual(detail.body.signIn.slice(0, 1), ["account_number"]);
  assert.equal(detail.body.email.stored, false);

  // Nothing secret leaks.
  const text = detail.text;
  assert.ok(text.indexOf(member.token) < 0, "no session token");
  ["number_hash", "salt", "token_hash", "public_key", "code_hash", "password"].forEach((word) => assert.ok(text.indexOf(word) < 0, word));

  const audit = await call("/v1/owner/inspector/audit", { token: owner.token });
  assert.equal(audit.status, 200);
  assert.equal(audit.body.rows.length, 1);
  assert.equal(audit.body.rows[0].id, row.id);

  // Unknown account: 404, and no audit row.
  assert.equal((await call("/v1/owner/inspector/accounts/999999999999", { token: owner.token })).status, 404);
  assert.equal((await call("/v1/owner/inspector/audit", { token: owner.token })).body.rows.length, 1);
});

test("owner sees every hidden friend, follow, locked follow and Friends-off state; secrets never leave", async () => {
  const db = await mf.getD1Database("DB");
  const peek = await call("/v1/owner/inspector/accounts?sort=handle", { token: (await signup("ownerpeek", "203.0.113.40")).token });
  assert.equal(peek.status, 403, "a second account is not the owner");
  const login = await call("/v1/signup", { method: "POST", ip: "203.0.113.41", body: { displayName: "alderquiet", handle: "alderquiet" } });
  const alder = login.body;
  const friend = await signup("hazelhidden", "203.0.113.42");
  const aid = alder.account.publicId;
  const fid = friend.account.publicId;
  const now = Date.now();
  await db.prepare("CREATE TABLE IF NOT EXISTS account_friends (user_id TEXT NOT NULL, friend_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, friend_id))").run();
  await db.prepare("INSERT OR IGNORE INTO account_friends (user_id, friend_id, created_at) VALUES (?, ?, ?), (?, ?, ?)").bind(aid, fid, now, fid, aid, now).run();
  await db.prepare("CREATE TABLE IF NOT EXISTS account_follows (follower_id TEXT NOT NULL, target_id TEXT NOT NULL, snapshot TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, PRIMARY KEY (follower_id, target_id))").run();
  await db.prepare("INSERT OR IGNORE INTO account_follows (follower_id, target_id, created_at) VALUES (?, ?, ?)").bind(fid, "app:" + aid, now).run();
  await db.prepare("CREATE TABLE IF NOT EXISTS locked_follows (owner_id TEXT NOT NULL, target_id TEXT NOT NULL, follow_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (owner_id, target_id))").run();
  await db.prepare("INSERT INTO locked_follows (owner_id, target_id, follow_at, created_at) VALUES (?, ?, ?, ?)").bind(aid, "app:" + fid, now, now).run();
  await db.prepare("CREATE TABLE IF NOT EXISTS locked_follow_prefs (public_id TEXT PRIMARY KEY, code_hash TEXT NOT NULL DEFAULT '', code_salt TEXT NOT NULL DEFAULT '', code_rounds INTEGER NOT NULL DEFAULT 0, hide_entry INTEGER NOT NULL DEFAULT 0, relock_secs INTEGER NOT NULL DEFAULT 60, fails INTEGER NOT NULL DEFAULT 0, fail_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)").run();
  await db.prepare("INSERT INTO locked_follow_prefs (public_id, code_hash, code_salt) VALUES (?, 'lockhashvalue', 'locksaltvalue')").bind(aid).run();
  await db.prepare("CREATE TABLE IF NOT EXISTS friendship_privacy (public_id TEXT NOT NULL, friend_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'inherit', audience TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (public_id, friend_id))").run();
  await db.prepare("INSERT INTO friendship_privacy (public_id, friend_id, mode) VALUES (?, ?, 'only_me')").bind(aid, fid).run();
  const off = await call("/v1/friends/settings", { method: "PUT", token: alder.token, ip: "203.0.113.43", body: { enabled: false, listAudience: "me" } });
  assert.equal(off.status, 200, JSON.stringify(off.body));

  const ownerToken = (await call("/v1/signup", { method: "POST", ip: "203.0.113.44", body: { displayName: "x", handle: "notowner2" } })).body.token;
  assert.equal((await call("/v1/owner/inspector/accounts/" + aid, { token: ownerToken })).status, 403);

  // The real owner (made in the first test) inspects.
  const ownerRow = await db.prepare("SELECT public_id FROM accounts WHERE owner = 1").first();
  assert.ok(ownerRow, "owner account exists");
  const offList = await call("/v1/owner/inspector/accounts?filter=friends_off", { token: OWNER_TOKEN });
  assert.equal(offList.status, 200, JSON.stringify(offList.body));
  assert.deepEqual(offList.body.accounts.map((a) => a.handle), ["alderquiet"]);
  assert.equal(offList.body.accounts[0].friendsOff, true);
  assert.equal(offList.body.accounts[0].lockedFollows, 1);

  const detail = await call("/v1/owner/inspector/accounts/" + aid, { token: OWNER_TOKEN });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  const p = detail.body.people;
  assert.deepEqual(p.friends.map((x) => x.handle), ["hazelhidden"], "friends list even with Friends off and list hidden");
  assert.deepEqual(p.followers.map((x) => x.handle), ["hazelhidden"]);
  assert.deepEqual(p.lockedFollowing.map((x) => x.handle), ["hazelhidden"], "locked follow shows");
  assert.equal(p.friends[0].privacy, "only_me", "a private friendship is shown and marked");
  assert.equal(p.friendsSetting.on, false);
  assert.equal(p.friendsSetting.listAudience, "me");
  assert.equal(p.lockedFollows.lockSet, true);
  assert.equal(detail.body.counts.friends, 1);
  assert.equal(detail.body.counts.lockedFollowing, 1);
  assert.ok(detail.text.indexOf("lockhashvalue") < 0 && detail.text.indexOf("locksaltvalue") < 0, "lock code hash and salt never leave");
  assert.ok(detail.text.indexOf(alder.token) < 0);
  const audit = await call("/v1/owner/inspector/audit", { token: OWNER_TOKEN });
  assert.ok(audit.body.rows.some((r) => r.id === aid && r.action === "view"), "the look is audited");
  const ownerId = String(ownerRow.public_id);
  await db.prepare("INSERT INTO display_name_audit (at, viewer_id, target_id, action, detail) VALUES (?, ?, ?, 'list', '{}')").bind(Date.now(), ownerId, aid).run();
  const audit2 = await call("/v1/owner/inspector/audit", { token: OWNER_TOKEN });
  assert.ok(audit2.body.rows.some((r) => r.id === aid && r.action === "names:list"), "display-name bypasses (#488) show in the same log");
  const { isOwnerViewer } = await import("../src/owner-view.js");
  const env = { DB: db };
  assert.equal(await isOwnerViewer(env, ownerId), true);
  assert.equal(await isOwnerViewer(env, aid), false);
});

test("owner-view helpers: scrubSecrets drops secrets anywhere, keeps safe counts", async () => {
  const { scrubSecrets } = await import("../src/owner-view.js");
  const out = scrubSecrets({ a: 1, passwordHash: "x", nested: [{ token: "t", lock_code: "c", passkeys: 2, recoveryCodesLeft: 3, message_text: "dm" }] });
  assert.deepEqual(out, { a: 1, nested: [{ passkeys: 2, recoveryCodesLeft: 3 }] });
});
