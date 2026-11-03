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

const T = (who) => who.token;
const follow = (who, target, ip) => call("/v1/follows", { method: "PUT", ip, token: T(who), body: { id: "app:" + target.account.publicId } });
const lf = (who, sub, opts) => call("/v1/locked-follows/" + sub, Object.assign({ token: T(who) }, opts || {}));
const handlesIn = (list) => (list || []).map((a) => String(a.handle || a.h || a.id || ""));

test("Locked follows: hidden from every follow, count, search and suggestion read", async () => {
  const db = await mf.getD1Database("DB");
  const ana = await signup("198.51.100.31", "lf_ana", "Ana Locks");
  const ben = await signup("198.51.100.32", "lf_ben", "Ben Hidden");
  const cy = await signup("198.51.100.33", "lf_cy", "Cy Fof");
  const dee = await signup("198.51.100.34", "lf_dee", "Dee Viewer");

  assert.equal((await follow(ana, ben, "198.51.100.40")).status, 200);
  assert.equal((await follow(ana, dee, "198.51.100.40")).status, 200);
  assert.equal((await follow(ben, cy, "198.51.100.41")).status, 200);
  assert.equal((await follow(ben, ana, "198.51.100.41")).status, 200);

  // Locking needs a set-up lock first.
  const early = await lf(ana, "lock", { method: "POST", ip: "198.51.100.42", body: { id: "app:@lf_ben" } });
  assert.equal(early.status, 409);

  const state0 = await lf(ana, "state", { ip: "198.51.100.42" });
  assert.equal(state0.status, 200, state0.text);
  assert.equal(state0.body.setUp, false);
  assert.equal(state0.body.filter.hashes.length, 64, "the filter is padded");

  const set = await lf(ana, "code", { method: "POST", ip: "198.51.100.42", body: { code: "4321zz" } });
  assert.equal(set.status, 200, set.text);
  assert.match(set.body.grant, /^lg1\./);
  const prefs = await db.prepare("SELECT code_hash, code_salt, code_rounds FROM locked_follow_prefs WHERE public_id = ?").bind(ana.account.publicId).first();
  assert.match(prefs.code_hash, /^[0-9a-f]{64}$/);
  assert.match(prefs.code_salt, /^[0-9a-f]{32}$/);
  assert.ok(prefs.code_rounds >= 1000);
  assert.equal(JSON.stringify(prefs).includes("4321zz"), false, "the code is never stored plain");

  // Changing the code later needs the lock open.
  assert.equal((await lf(ana, "code", { method: "POST", ip: "198.51.100.42", body: { code: "other1" } })).status, 403);

  const locked = await lf(ana, "lock", { method: "POST", ip: "198.51.100.42", body: { id: "app:@lf_ben" } });
  assert.equal(locked.status, 200, locked.text);
  assert.equal(locked.body.followingCount, 1);

  // Own follow list and count.
  const own = await call("/v1/follows", { ip: "198.51.100.43", token: T(ana) });
  assert.equal(own.status, 200, own.text);
  assert.equal(own.body.followingCount, 1);
  assert.equal(own.text.includes("lf_ben"), false, own.text);
  assert.ok(own.body.ids.indexOf("app:@lf_dee") >= 0);

  // Following and mutuals tabs, for the owner and for anyone else.
  for (const viewer of [ana, dee, ben, cy]) {
    const tabbed = await call("/v1/follows?id=" + encodeURIComponent("app:@lf_ana") + "&tab=following", { ip: "198.51.100.44", token: T(viewer) });
    assert.equal(tabbed.status, 200, tabbed.text);
    assert.equal(tabbed.body.followingCount, 1);
    assert.equal(tabbed.text.includes("lf_ben"), false, "following tab for a viewer");
    const mutual = await call("/v1/follows?id=" + encodeURIComponent("app:@lf_ana") + "&tab=mutuals", { ip: "198.51.100.44", token: T(viewer) });
    assert.equal(mutual.text.includes("lf_ben"), false, "mutuals tab for a viewer");
    const profile = await call("/v1/profile/lf_ana", { ip: "198.51.100.45", token: T(viewer) });
    assert.equal(profile.status, 200, profile.text);
    assert.equal(profile.body.account ? profile.body.account.followingCount : profile.body.followingCount, 1);
  }

  // The followed person still sees the follower.
  const benFollowers = await call("/v1/follows?id=" + encodeURIComponent("app:@lf_ben") + "&tab=followers", { ip: "198.51.100.46", token: T(ben) });
  assert.equal(benFollowers.text.includes("lf_ana"), true);

  // Ana's view of Ben's profile reads as not followed.
  const benProfile = await call("/v1/profile/lf_ben", { ip: "198.51.100.47", token: T(ana) });
  const benAccount = benProfile.body.account || benProfile.body;
  assert.equal(benAccount.viewerFollows, false);
  const benFollowState = await call("/v1/follows?id=" + encodeURIComponent("app:@lf_ben"), { ip: "198.51.100.47", token: T(ana) });
  assert.equal(benFollowState.body.viewerFollows, false);

  // Following again keeps it locked and changes nothing anyone can see.
  const again = await follow(ana, ben, "198.51.100.48");
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.viewerFollows, false);
  assert.equal(again.body.followingCount, 1);

  // Search, mention suggestions, who to follow.
  const people = await call("/v1/people?q=hidden", { ip: "198.51.100.49", token: T(ana) });
  assert.equal(people.text.includes("lf_ben"), false, people.text);
  const peopleOther = await call("/v1/people?q=hidden", { ip: "198.51.100.49", token: T(dee) });
  assert.equal(peopleOther.text.includes("lf_ben"), true);
  const mention = await call("/v1/mentions/suggest?q=lf_be", { ip: "198.51.100.50", token: T(ana) });
  assert.equal(mention.status, 200, mention.text);
  assert.equal(mention.text.includes("lf_ben"), false);
  const sug = await call("/v1/suggestions?fresh=1", { ip: "198.51.100.51", token: T(ana) });
  assert.equal(sug.status, 200, sug.text);
  assert.equal(sug.text.includes("lf_ben"), false, "never suggested");
  assert.equal(sug.text.includes("lf_cy"), false, "not suggested through a locked follow");

  // Notifications from Ben are held for the Locked area.
  await call("/v1/follows", { method: "DELETE", ip: "198.51.100.52", token: T(ben), body: { id: "app:" + ana.account.publicId } });
  assert.equal((await follow(ben, ana, "198.51.100.52")).status, 200);
  const notes = await call("/v1/notifications", { ip: "198.51.100.53", token: T(ana) });
  assert.equal(notes.status, 200, notes.text);
  assert.equal(notes.text.includes("lf_ben"), false, "held from the main list");
  assert.equal(notes.text.includes("Ben Hidden"), false);

  // The Locked area needs a live grant from this session.
  assert.equal((await lf(ana, "list", { ip: "198.51.100.54" })).status, 403);
  assert.equal((await lf(ana, "list", { ip: "198.51.100.54", headers: { "X-Locked-Grant": "lg1.forged" } })).status, 403);
  const open = await lf(ana, "unlock", { method: "POST", ip: "198.51.100.54", body: { code: "4321zz" } });
  assert.equal(open.status, 200, open.text);
  const grant = { "X-Locked-Grant": open.body.grant };
  assert.equal((await call("/v1/locked-follows/list", { ip: "198.51.100.54", token: T(dee), headers: grant })).status, 403, "a grant is bound to its account and session");
  const list = await lf(ana, "list", { ip: "198.51.100.54", headers: grant });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(handlesIn(list.body.accounts).filter((h) => h.indexOf("lf_ben") >= 0).length, 1);
  assert.equal(list.text.includes(ben.account.publicId), false, "no account numbers");
  const held = await lf(ana, "notifications", { ip: "198.51.100.54", headers: grant });
  assert.equal(held.status, 200, held.text);
  assert.equal(held.text.includes("lf_ben") || held.text.includes("Ben Hidden"), true, "held notes show in the Locked area");
  assert.equal((await lf(ana, "posts", { ip: "198.51.100.54", headers: grant })).status, 200);
  const stateOpen = await lf(ana, "state", { ip: "198.51.100.54", headers: grant });
  assert.equal(stateOpen.body.unlocked, true);

  // A chat with a locked follow opens only inside the Locked area.
  const sent = await call("/v1/messages", { method: "POST", ip: "198.51.100.58", token: T(ben), body: { id: ana.account.publicId, text: "locked hello" } });
  assert.ok(sent.status === 200 || sent.status === 201, sent.text);
  {
    const shut = await call("/v1/messages?id=" + ben.account.publicId, { ip: "198.51.100.58", token: T(ana) });
    assert.equal(shut.text.includes("locked hello"), false);
    const openChat = await call("/v1/messages?id=" + ben.account.publicId, { ip: "198.51.100.58", token: T(ana), headers: grant });
    assert.equal(openChat.text.includes("locked hello"), true);
  }

  // Relock drops the grant.
  await lf(ana, "relock", { method: "POST", ip: "198.51.100.54", headers: grant });
  assert.equal((await lf(ana, "list", { ip: "198.51.100.54", headers: grant })).status, 403);

  // Move back to the main list.
  const open2 = await lf(ana, "unlock", { method: "POST", ip: "198.51.100.55", body: { code: "4321zz" } });
  const back = await lf(ana, "unlock-follow", { method: "POST", ip: "198.51.100.55", headers: { "X-Locked-Grant": open2.body.grant }, body: { id: "app:@lf_ben" } });
  assert.equal(back.status, 200, back.text);
  assert.equal(back.body.followingCount, 2);
  const ownAfter = await call("/v1/follows", { ip: "198.51.100.56", token: T(ana) });
  assert.equal(ownAfter.text.includes("lf_ben"), true);

  // Unfollow and follow again starts unlocked, even with an old lock row.
  await lf(ana, "lock", { method: "POST", ip: "198.51.100.57", body: { id: "app:@lf_ben" } });
  await db.prepare("INSERT OR IGNORE INTO locked_follows (owner_id, target_id, follow_at, created_at) VALUES (?, ?, 1, 1)").bind(ana.account.publicId, "app:" + dee.account.publicId).run();
  const deeStill = await call("/v1/follows", { ip: "198.51.100.57", token: T(ana) });
  assert.equal(deeStill.text.includes("lf_dee"), true, "a stale lock row does nothing");
});

test("Locked follows: wrong codes back off, probes do not count, reset re-checks the account", async () => {
  const db = await mf.getD1Database("DB");
  const eve = await signup("198.51.100.61", "lf_eve", "Eve Locks");
  const fay = await signup("198.51.100.62", "lf_fay", "Fay Hidden");
  assert.equal((await follow(eve, fay, "198.51.100.63")).status, 200);
  assert.equal((await lf(eve, "code", { method: "POST", ip: "198.51.100.63", body: { code: "abc" } })).status, 400, "too short");
  assert.equal((await lf(eve, "code", { method: "POST", ip: "198.51.100.63", body: { code: "9876" } })).status, 200);
  assert.equal((await lf(eve, "lock", { method: "POST", ip: "198.51.100.63", body: { id: "app:@lf_fay" } })).status, 200);

  // Probes from the search box never count as wrong tries.
  for (let i = 0; i < 3; i++) {
    const p = await lf(eve, "unlock", { method: "POST", ip: "198.51.100.64", body: { code: "nope" + i, probe: true } });
    assert.equal(p.status, 401);
  }
  const fails0 = await db.prepare("SELECT fails FROM locked_follow_prefs WHERE public_id = ?").bind(eve.account.publicId).first();
  assert.equal(fails0.fails, 0);

  for (let i = 0; i < 5; i++) {
    const wrong = await lf(eve, "unlock", { method: "POST", ip: "198.51.100.65", body: { code: "0000" + i } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.retryAfter, undefined);
  }
  const sixth = await lf(eve, "unlock", { method: "POST", ip: "198.51.100.65", body: { code: "00009" } });
  assert.equal(sixth.status, 401);
  assert.ok(sixth.body.retryAfter >= 30);
  const cooled = await lf(eve, "unlock", { method: "POST", ip: "198.51.100.65", body: { code: "9876" } });
  assert.equal(cooled.status, 429, "the right code waits out the back-off too");

  // Forgot code: the account number, never a list.
  const bad = await lf(eve, "reset", { method: "POST", ip: "198.51.100.66", body: { accountNumber: "0000000000000000" } });
  assert.equal(bad.status, 401);
  const reset = await lf(eve, "reset", { method: "POST", ip: "198.51.100.66", body: { accountNumber: eve.accountNumber } });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.text.includes("lf_fay"), false);
  const after = await lf(eve, "state", { ip: "198.51.100.66" });
  assert.equal(after.body.setUp, false);
  const own = await call("/v1/follows", { ip: "198.51.100.66", token: T(eve) });
  assert.equal(own.text.includes("lf_fay"), false, "still locked after a reset");
  assert.equal(own.body.followingCount, 0);
  const fresh = await lf(eve, "code", { method: "POST", ip: "198.51.100.67", body: { code: "5555" } });
  assert.equal(fresh.status, 200);
  const list = await lf(eve, "list", { ip: "198.51.100.67", headers: { "X-Locked-Grant": fresh.body.grant } });
  assert.equal(list.text.includes("lf_fay"), true);

  // Turning it off brings everything back.
  const off = await lf(eve, "off", { method: "POST", ip: "198.51.100.67", headers: { "X-Locked-Grant": fresh.body.grant } });
  assert.equal(off.status, 200);
  assert.equal(off.body.followingCount, 1);
});

test("Locked follows: the app owner sees the real list and counts, audited, never the code", async () => {
  const db = await mf.getD1Database("DB");
  const boss = await call("/v1/signup", { method: "POST", ip: "198.51.100.81", body: { displayName: "Owner", handle: "owner_test", claimCode: "claim-test" } });
  assert.equal(boss.status, 201, boss.text);
  const owner = boss.body;
  const gil = await signup("198.51.100.82", "lf_gil", "Gil Locks");
  const hal = await signup("198.51.100.83", "lf_hal", "Hal Hidden");
  const ike = await signup("198.51.100.84", "lf_ike", "Ike Viewer");
  assert.equal((await follow(gil, hal, "198.51.100.85")).status, 200);
  assert.equal((await lf(gil, "code", { method: "POST", ip: "198.51.100.85", body: { code: "owner-proof-1" } })).status, 200);
  assert.equal((await lf(gil, "lock", { method: "POST", ip: "198.51.100.85", body: { id: "app:@lf_hal" } })).status, 200);
  const sent = await call("/v1/messages", { method: "POST", ip: "198.51.100.85", token: T(gil), body: { id: hal.account.publicId, text: "private words" } });
  assert.ok(sent.status < 500);

  // Everyone else, the account itself included, still sees it hidden.
  const base = (await call("/v1/follows?id=" + encodeURIComponent("app:@lf_gil"), { ip: "198.51.100.86", token: T(ike) })).body.followingCount;
  for (const viewer of [gil, ike]) {
    const list = await call("/v1/follows?id=" + encodeURIComponent("app:@lf_gil") + "&tab=following", { ip: "198.51.100.86", token: T(viewer) });
    assert.equal(list.body.followingCount, base);
    assert.equal(list.text.includes("lf_hal"), false);
    assert.equal(list.body.lockedFollowsCount, undefined);
  }
  const before = await db.prepare("SELECT COUNT(*) AS n FROM locked_follow_audit").first();

  // The owner: the true list, marked, and the true counts.
  const seen = await call("/v1/follows?id=" + encodeURIComponent("app:@lf_gil") + "&tab=following", { ip: "198.51.100.87", token: T(owner) });
  assert.equal(seen.status, 200, seen.text);
  assert.equal(seen.body.followingCount, base + 1);
  assert.equal(seen.body.lockedFollowsCount, 1);
  const halRow = (seen.body.accounts || []).find((a) => String(a.handle || "") === "lf_hal");
  assert.ok(halRow, seen.text);
  assert.equal(halRow.locked, true);
  const profile = await call("/v1/profile/lf_gil", { ip: "198.51.100.87", token: T(owner) });
  const acct = profile.body.account || profile.body;
  assert.equal(acct.followingCount, base + 1);

  const inspect = await call("/v1/owner/locked-follows?id=" + encodeURIComponent("app:@lf_gil"), { ip: "198.51.100.88", token: T(owner) });
  assert.equal(inspect.status, 200, inspect.text);
  assert.equal(inspect.body.lockedCount, 1);
  assert.equal(inspect.body.followingCount, base + 1);
  assert.equal(inspect.body.visibleFollowingCount, base);
  assert.equal(inspect.text.includes("lf_hal"), true);
  const prefs = await db.prepare("SELECT code_hash, code_salt FROM locked_follow_prefs WHERE public_id = ?").bind(gil.account.publicId).first();
  for (const text of [seen.text, profile.text, inspect.text]) {
    assert.equal(text.includes("owner-proof-1"), false, "never the code");
    assert.equal(text.includes(prefs.code_hash), false, "never the hash");
    assert.equal(text.includes(prefs.code_salt), false, "never the salt");
    assert.equal(text.includes("private words"), false, "never messages");
    assert.equal(text.includes(gil.account.publicId) || text.includes(hal.account.publicId), false, "no account numbers");
  }

  // Every look is written down.
  const after = await db.prepare("SELECT COUNT(*) AS n FROM locked_follow_audit").first();
  assert.ok(after.n >= before.n + 3, "audited");
  const audit = await call("/v1/owner/locked-follows/audit", { ip: "198.51.100.89", token: T(owner) });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.items.some((i) => i.action === "inspect" && i.handle === "lf_gil"));

  // Nobody else gets the owner reads.
  assert.equal((await call("/v1/owner/locked-follows?id=" + encodeURIComponent("app:@lf_gil"), { ip: "198.51.100.90", token: T(ike) })).status, 403);
  assert.equal((await call("/v1/owner/locked-follows/audit", { ip: "198.51.100.90", token: T(gil) })).status, 403);

  // Owner can lock and unlock a TikTok follow (even when added locally or with mixed case).
  assert.equal((await lf(owner, "code", { method: "POST", ip: "198.51.100.91", body: { code: "owner-tok-1" } })).status, 200);
  const lockTok = await lf(owner, "lock", { method: "POST", ip: "198.51.100.91", body: { id: "tiktok:SampleTok" } });
  assert.equal(lockTok.status, 200, lockTok.text);
  const openOwner = await lf(owner, "unlock", { method: "POST", ip: "198.51.100.91", body: { code: "owner-tok-1" } });
  assert.equal(openOwner.status, 200, openOwner.text);
  const ownerList = await lf(owner, "list", { ip: "198.51.100.91", headers: { "X-Locked-Grant": openOwner.body.grant } });
  assert.equal(ownerList.status, 200, ownerList.text);
  const tokCard = (ownerList.body.accounts || []).find((a) => String(a.id || "").toLowerCase() === "tiktok:sampletok");
  assert.ok(tokCard, ownerList.text);
  assert.equal(tokCard.platform, "tiktok");
  assert.equal(tokCard.handle, "SampleTok");
  const unlockTok = await lf(owner, "unlock-follow", { method: "POST", ip: "198.51.100.91", headers: { "X-Locked-Grant": openOwner.body.grant }, body: { id: "tiktok:sampletok" } });
  assert.equal(unlockTok.status, 200, unlockTok.text);
  const ownerFollowsAfter = await call("/v1/follows", { ip: "198.51.100.91", token: T(owner) });
  assert.equal(ownerFollowsAfter.text.toLowerCase().includes("tiktok:sampletok"), true);
});
