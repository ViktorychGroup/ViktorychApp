import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

/* Privacy for each friendship: both sides, per-viewer counts, mutuals,
   precedence, blocks, preview, and the bypass hook the owner inspector uses. */

let mf;
let ipN = 10;

function workerOptions(entry) {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL(entry || "../src/index.js", import.meta.url)),
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

function ip() { ipN += 1; return "198.51.101." + (ipN % 250); }

async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers();
  headers.set("CF-Connecting-IP", opts.ip || ip());
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.body) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (err) { body = { raw: text }; }
  return { status: res.status, body, text };
}

async function signup(handle, name) {
  const created = await call("/v1/signup", { method: "POST", body: { displayName: name, handle } });
  assert.equal(created.status, 201, created.text);
  return Object.assign(created.body, { handle });
}

async function befriend(a, b) {
  assert.equal((await call("/v1/friends/request", { method: "POST", token: a.token, body: { targetId: "app:" + b.account.publicId } })).status, 200);
  const ok = await call("/v1/friends/accept", { method: "POST", token: b.token, body: { targetId: "app:" + a.account.publicId } });
  assert.equal(ok.body.status, "friends", ok.text);
}

async function listOf(viewer, owner) {
  const res = await call("/v1/friends?id=app:" + owner.account.publicId + "&tab=friends", { token: viewer.token });
  assert.equal(res.status, 200, res.text);
  return res.body;
}

function handlesOf(body) {
  return (body.friends || []).map((card) => String(card.handle || "").replace(/^@/, "")).sort();
}

async function setRule(who, handles, rule) {
  const res = await call("/v1/friends/privacy", { method: "PUT", token: who.token, body: { handles, rule } });
  assert.equal(res.status, 200, res.text);
  return res.body;
}

function noHiddenHints(body) {
  const text = JSON.stringify(body);
  assert.ok(!/hidden(Count|Friends)|"hidden":\s*\d|more_hidden/i.test(text), "no hidden-count hints: " + text);
}

let ana, ben, cy, dee, eve, own;

test.before(async () => {
  mf = new Miniflare(workerOptions());
  ana = await signup("ana_fp", "Ana");
  ben = await signup("ben_fp", "Ben");
  cy = await signup("cy_fp", "Cy");
  dee = await signup("dee_fp", "Dee");
  eve = await signup("eve_fp", "Eve");
  own = await signup("own_fp", "Owner");
  const db = await mf.getD1Database("DB");
  await db.prepare("UPDATE accounts SET owner = 1 WHERE public_id = ?").bind(own.account.publicId).run();
  // Ana-Ben, Ana-Cy, Ben-Cy, Dee-Ben are friends.
  await befriend(ana, ben);
  await befriend(ana, cy);
  await befriend(ben, cy);
  await befriend(dee, ben);
});

test.after(async () => { if (mf) await mf.dispose(); });

test("default: everyone sees every friendship", async () => {
  const seen = await listOf(eve, ana);
  assert.deepEqual(handlesOf(seen), ["ben_fp", "cy_fp"]);
  assert.equal(seen.friendsCount, 2);
});

test("Only me hides one friendship from everyone else, on both people's lists, counts and mutuals", async () => {
  await setRule(ana, ["ben_fp"], { mode: "hidden" });
  const fromEve = await listOf(eve, ana);
  assert.deepEqual(handlesOf(fromEve), ["cy_fp"]);
  assert.equal(fromEve.friendsCount, 1);
  noHiddenHints(fromEve);
  // Ben's own list, seen by Eve: Ana is gone there too (both sides).
  const benFromEve = await listOf(eve, ben);
  assert.deepEqual(handlesOf(benFromEve), ["cy_fp", "dee_fp"]);
  assert.equal(benFromEve.friendsCount, 2);
  // Each friend still sees it on their own list; "Only me" means Ana's list
  // shows it to Ana only, Ben included.
  assert.deepEqual(handlesOf(await listOf(ana, ana)), ["ben_fp", "cy_fp"]);
  assert.ok(handlesOf(await listOf(ben, ben)).includes("ana_fp"));
  assert.ok(!handlesOf(await listOf(ben, ana)).includes("ben_fp"));
  // Mutuals: Cy is friends with Ana and Ben; Cy looking at Ana's page must
  // not count Ben as a mutual (the Ana-Ben friendship is hidden).
  const cyView = await listOf(cy, ana);
  assert.equal(cyView.mutualCount, 0);
  // Dee (friend of Ben) looking at Ana: Ben not a visible mutual.
  assert.equal((await listOf(dee, ana)).mutualCount, 0);
  // Profile counts are per viewer as well.
  const prof = await call("/v1/profile/ana_fp", { token: eve.token });
  assert.equal(prof.status, 200, prof.text);
  assert.equal(prof.body.account.friendsCount, 1);
  noHiddenHints(prof.body);
});

test("specific people: show-to chips, and the other side must also allow", async () => {
  await setRule(ana, ["ben_fp"], { mode: "custom", audience: { include: { people: ["eve_fp"] }, exclude: {} } });
  assert.deepEqual(handlesOf(await listOf(eve, ana)), ["ben_fp", "cy_fp"]);
  assert.deepEqual(handlesOf(await listOf(dee, ana)), ["cy_fp"]);
  // Ben hides it on his side: now nobody else sees it, Eve included.
  await setRule(ben, ["ana_fp"], { mode: "hidden" });
  assert.deepEqual(handlesOf(await listOf(eve, ana)), ["cy_fp"]);
  assert.equal((await listOf(eve, ana)).friendsCount, 1);
  await setRule(ben, ["ana_fp"], { mode: "inherit" });
  assert.deepEqual(handlesOf(await listOf(eve, ana)), ["ben_fp", "cy_fp"]);
  await setRule(ana, ["ben_fp"], { mode: "inherit" });
});

test("precedence: hide-from wins over show-to, person over friends, list over public", async () => {
  // Public but hidden from Eve.
  await setRule(ana, ["cy_fp"], { mode: "custom", audience: { include: { public: true }, exclude: { people: ["eve_fp"] } } });
  assert.ok(!handlesOf(await listOf(eve, ana)).includes("cy_fp"));
  assert.ok(handlesOf(await listOf(dee, ana)).includes("cy_fp"));
  // Friends only: Dee is not Ana's friend, Ben is.
  await setRule(ana, ["cy_fp"], { mode: "custom", audience: { include: { friends: true }, exclude: {} } });
  assert.ok(!handlesOf(await listOf(dee, ana)).includes("cy_fp"));
  assert.ok(handlesOf(await listOf(ben, ana)).includes("cy_fp"));
  // Friends, but hidden from Ben by person: the person rule wins.
  await setRule(ana, ["cy_fp"], { mode: "custom", audience: { include: { friends: true }, exclude: { people: ["ben_fp"] } } });
  assert.ok(!handlesOf(await listOf(ben, ana)).includes("cy_fp"));
  // Lists: a list with Dee.
  const list = await call("/v1/audience-lists", { method: "POST", token: ana.token, body: { name: "Close" } });
  assert.equal(list.status, 201, list.text);
  // Dee must follow Ana to be addable to a list.
  await call("/v1/follows", { method: "PUT", token: dee.token, body: { id: "app:" + ana.account.publicId } });
  const added = await call("/v1/audience-lists/" + list.body.id + "/members", { method: "POST", token: ana.token, body: { handle: "dee_fp" } });
  assert.equal(added.status, 200, added.text);
  await setRule(ana, ["cy_fp"], { mode: "custom", audience: { include: { lists: [list.body.id] }, exclude: {} } });
  assert.ok(handlesOf(await listOf(dee, ana)).includes("cy_fp"));
  assert.ok(!handlesOf(await listOf(eve, ana)).includes("cy_fp"));
  // Followers: Dee follows, Eve doesn't.
  await setRule(ana, ["cy_fp"], { mode: "custom", audience: { include: { followers: true }, exclude: {} } });
  assert.ok(handlesOf(await listOf(dee, ana)).includes("cy_fp"));
  assert.ok(!handlesOf(await listOf(eve, ana)).includes("cy_fp"));
  await setRule(ana, ["cy_fp"], { mode: "inherit" });
});

test("same as my friend list follows the list-wide choice; per-friend Everyone can open one", async () => {
  await call("/v1/friends/settings", { method: "PUT", token: ana.token, body: { listAudience: "me" } });
  const closed = await listOf(eve, ana);
  assert.equal(closed.isPrivate, true);
  assert.deepEqual(closed.friends, []);
  assert.equal(closed.friendsCount, 0);
  await setRule(ana, ["cy_fp"], { mode: "custom", audience: { include: { public: true }, exclude: {} } });
  assert.deepEqual(handlesOf(await listOf(eve, ana)), ["cy_fp"]);
  await setRule(ana, ["cy_fp"], { mode: "inherit" });
  await call("/v1/friends/settings", { method: "PUT", token: ana.token, body: { listAudience: "everyone" } });
});

test("blocked people never see the friendship", async () => {
  const db = await mf.getD1Database("DB");
  await db.prepare("INSERT INTO account_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)").bind(cy.account.publicId, eve.account.publicId, Date.now()).run();
  assert.ok(!handlesOf(await listOf(eve, ana)).includes("cy_fp"));
  await db.prepare("DELETE FROM account_blocks WHERE blocker_id = ?").bind(cy.account.publicId).run();
  assert.ok(handlesOf(await listOf(eve, ana)).includes("cy_fp"));
});

test("preview as a person or an audience uses only your own rules", async () => {
  await setRule(ana, ["ben_fp"], { mode: "custom", audience: { include: { people: ["eve_fp"] }, exclude: {} } });
  const asEve = await call("/v1/friends/privacy/preview?as=eve_fp", { token: ana.token });
  assert.equal(asEve.status, 200, asEve.text);
  assert.deepEqual(asEve.body.visible.slice().sort(), ["ben_fp", "cy_fp"]);
  const asPublic = await call("/v1/friends/privacy/preview?as=public", { token: ana.token });
  assert.deepEqual(asPublic.body.visible, ["cy_fp"]);
  const got = await call("/v1/friends/privacy", { token: ana.token });
  const benRow = got.body.friends.find((row) => row.handle === "ben_fp");
  assert.equal(benRow.rule.mode, "custom");
  assert.deepEqual(benRow.rule.audience.include.people, ["eve_fp"]);
  // Not a friend: rule refused.
  assert.equal((await call("/v1/friends/privacy", { method: "PUT", token: ana.token, body: { handles: ["dee_fp"], rule: { mode: "hidden" } } })).status, 404);
  assert.equal((await call("/v1/friends/privacy", { token: "" })).status, 401);
});

test("no bypass by default: even the app owner account follows the rules", async () => {
  await setRule(ana, ["ben_fp"], { mode: "hidden" });
  const seen = await listOf(own, ana);
  assert.deepEqual(handlesOf(seen), ["cy_fp"]);
  assert.equal(seen.friendsCount, 1);
  assert.equal(seen.ownerView, undefined);
  assert.ok(seen.friends.every((card) => card.ownerOnly === undefined));
  noHiddenHints(seen);
  await setRule(ana, ["ben_fp"], { mode: "inherit" });
});

test("bypass hook (owner inspector): true lists, counts and mutuals, each reveal recorded", async () => {
  const main = mf;
  mf = new Miniflare(workerOptions("./fixtures/friendship-bypass-entry.js"));
  try {
    const a = await signup("ana_hk", "Ana");
    const b = await signup("ben_hk", "Ben");
    const c = await signup("cy_hk", "Cy");
    const e = await signup("eve_hk", "Eve");
    const o = await signup("own_hk", "Owner");
    const db = await mf.getD1Database("DB");
    await db.prepare("UPDATE accounts SET owner = 1 WHERE public_id = ?").bind(o.account.publicId).run();
    await befriend(a, b);
    await befriend(a, c);
    await befriend(b, c);
    await befriend(o, b);
    await setRule(a, ["ben_hk"], { mode: "hidden" });
    await setRule(b, ["ana_hk"], { mode: "hidden" });
    const seen = await listOf(o, a);
    assert.deepEqual(handlesOf(seen), ["ben_hk", "cy_hk"]);
    assert.equal(seen.friendsCount, 2);
    assert.equal(seen.mutualCount, 1);
    assert.equal(seen.ownerView, true);
    assert.equal(seen.friends.find((card) => String(card.handle).replace(/^@/, "") === "ben_hk").ownerOnly, true);
    assert.ok(!seen.friends.find((card) => String(card.handle).replace(/^@/, "") === "cy_hk").ownerOnly);
    const log = await db.prepare("SELECT COUNT(*) AS n FROM test_bypass_log WHERE viewer_id = ? AND target_id = ? AND action = 'friendship_bypass'").bind(o.account.publicId, a.account.publicId).first();
    assert.ok(Number(log.n) >= 1);
    const prof = await call("/v1/profile/ana_hk", { token: o.token });
    assert.equal(prof.body.account.friendsCount, 2);
    assert.equal(prof.body.account.ownerView, true);
    assert.ok(!/number_hash|salt|token_hash|password/i.test(JSON.stringify(seen) + JSON.stringify(prof.body)));
    // Everyone else still follows the rules, with no owner markers.
    const other = await listOf(e, a);
    assert.deepEqual(handlesOf(other), ["cy_hk"]);
    assert.equal(other.ownerView, undefined);
    assert.equal((await listOf(c, a)).mutualCount, 0);
    // Nothing hidden -> nothing recorded.
    await setRule(a, ["ben_hk"], { mode: "inherit" });
    await setRule(b, ["ana_hk"], { mode: "inherit" });
    const before = await db.prepare("SELECT COUNT(*) AS n FROM test_bypass_log").first();
    await listOf(o, c);
    const after = await db.prepare("SELECT COUNT(*) AS n FROM test_bypass_log").first();
    assert.equal(Number(after.n), Number(before.n));
  } finally {
    await mf.dispose();
    mf = main;
  }
});

test("removing a friendship drops both sides' rules", async () => {
  await setRule(dee, ["ben_fp"], { mode: "hidden" });
  await call("/v1/friends/remove", { method: "POST", token: dee.token, body: { targetId: "app:" + ben.account.publicId } });
  const db = await mf.getD1Database("DB");
  const left = await db.prepare("SELECT COUNT(*) AS n FROM friendship_privacy WHERE public_id = ? OR friend_id = ?").bind(dee.account.publicId, dee.account.publicId).first();
  assert.equal(Number(left.n), 0);
});
