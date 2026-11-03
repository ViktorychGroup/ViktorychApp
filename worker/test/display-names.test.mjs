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


const IP = { n: 10 };
function ip() { IP.n += 1; return "198.51.100." + (IP.n % 250); }
function get(path, token) { return call(path, { ip: ip(), token }); }

function send(path, method, token, body) { return call(path, { method, ip: ip(), token, body }); }

const ALL_OFF = { include: { public: false, followers: false, friends: false, lists: [], people: [] }, exclude: { followers: false, friends: false, lists: [], people: [] } };

test("pickDisplayName: most specific wins, exclusions fall back to a broader name", async () => {
  const { pickDisplayName, isPlainSet } = await import("../src/display-names.js");
  const { normalizeNameAudience } = await import("../src/usernames.js");
  const P = "100000000002";
  const X = "100000000003";
  const set = {
    listOrder: ["L2", "L1"],
    names: [
      { id: "main", name: "Main", primary: true, position: -1, audience: normalizeNameAudience({ include: { public: true } }) },
      { id: "a", name: "Close", primary: false, position: 1, audience: normalizeNameAudience({ include: { friends: true }, exclude: { people: [X] } }) },
      { id: "b", name: "Crew one", primary: false, position: 2, audience: normalizeNameAudience({ include: { lists: ["L1"] } }) },
      { id: "c", name: "Crew two", primary: false, position: 3, audience: normalizeNameAudience({ include: { lists: ["L2"] } }) },
      { id: "d", name: "For one", primary: false, position: 4, audience: normalizeNameAudience({ include: { people: [P] }, exclude: { followers: false } }) }
    ]
  };
  const pick = (rel) => (pickDisplayName(set, rel) || { name: "" }).name;
  assert.equal(pick({}), "Main");
  assert.equal(pick({ id: "100000000009", follows: true }), "Main");
  assert.equal(pick({ id: "100000000009", friends: true, follows: true }), "Close");
  assert.equal(pick({ id: X, friends: true, follows: true }), "Main", "excluded person falls back");
  assert.equal(pick({ id: "100000000009", lists: ["L1", "L2"], friends: true }), "Crew two", "list order decides");
  assert.equal(pick({ id: P, lists: ["L1"], friends: true }), "For one", "a person beats everything");
  assert.equal(pick({ self: true }), "Main");
  set.names[0].audience = normalizeNameAudience({ include: { followers: true } });
  assert.equal(pickDisplayName(set, {}), null, "no visible name");
  assert.equal(isPlainSet({ names: [{ audience: normalizeNameAudience({ include: { public: true } }) }] }), true);
  assert.equal(isPlainSet(set), false);
  assert.ok(ALL_OFF);
});

test("each viewer sees one display name everywhere a name is returned", async () => {
  const own = await signup(71, "Cedar Hill", "dn_cedar");
  const fol = await signup(72, "Fo Viewer", "dn_fol");
  const fri = await signup(73, "Fri Viewer", "dn_fri");
  const lis = await signup(74, "Li Viewer", "dn_lis");
  const per = await signup(75, "Pe Viewer", "dn_per");
  const str = await signup(76, "St Viewer", "dn_str");
  const exc = await signup(77, "Ex Viewer", "dn_exc");
  const oid = "app:" + own.account.publicId;
  for (const v of [fol, fri, lis, per, exc]) assert.equal((await send("/v1/follows", "PUT", v.token, { id: oid })).status, 200);
  for (const v of [fri, exc]) assert.equal((await send("/v1/follows", "PUT", own.token, { id: "app:" + v.account.publicId })).status, 200);
  const list = await call("/v1/audience-lists", { method: "POST", ip: ip(), token: own.token, body: { name: "Crew", icon: "" } });
  assert.equal(list.status, 201, list.text);
  assert.equal((await send("/v1/audience-lists/" + list.body.id + "/members", "POST", own.token, { handle: "dn_lis" })).status, 200);

  const add = (name, audience) => send("/v1/display-names", "POST", own.token, { name, audience });
  assert.equal((await add("Cedar Close", { include: { friends: true }, exclude: { people: ["dn_exc"] } })).status, 201);
  assert.equal((await add("Cedar Crew", { include: { lists: [list.body.id] } })).status, 201);
  const last = await add("Cedar For Pe", { include: { people: ["dn_per"] } });
  assert.equal(last.status, 201, last.text);
  assert.equal(last.body.names.length, 4);
  assert.deepEqual(last.body.names[1].audience.exclude.people, ["dn_exc"], "people come back as handles");
  assert.equal(last.text.indexOf(exc.account.publicId), -1, "no ids leak to the client");

  const look = async (token) => { const r = await (token ? get("/v1/profile/dn_cedar", token) : call("/v1/profile/dn_cedar", { ip: ip() })); if (!r.body || !r.body.account) throw new Error("profile " + r.status + " " + r.text.slice(0, 200)); return r.body.account; };
  assert.equal((await look(fol.token)).displayName, "Cedar Hill");
  assert.equal((await look(fri.token)).displayName, "Cedar Close");
  assert.equal((await look(exc.token)).displayName, "Cedar Hill", "hide-from falls back to the broader main name");
  assert.equal((await look(lis.token)).displayName, "Cedar Crew");
  assert.equal((await look(per.token)).displayName, "Cedar For Pe");
  assert.equal((await look(str.token)).displayName, "Cedar Hill");
  assert.equal((await look(own.token)).displayName, "Cedar Hill", "the owner sees the main name on their profile");

  // Preview as a tier and as a person.
  const prev = async (as) => (await get("/v1/display-names/preview?as=" + encodeURIComponent(as), own.token)).body;
  assert.equal((await prev("friends")).name, "Cedar Close");
  assert.equal((await prev("list:" + list.body.id)).name, "Cedar Crew");
  assert.equal((await prev("public")).name, "Cedar Hill");
  assert.equal((await prev("@dn_per")).name, "Cedar For Pe");
  assert.equal((await prev("dn_exc")).name, "Cedar Hill");
  assert.equal((await get("/v1/display-names/preview?as=nobody_here_zz", own.token)).status, 404);

  // Followers lists (the response pass): dn_fri's followers include the owner.
  const followers = async (token) => (await get("/v1/follows?id=" + encodeURIComponent("app:" + fri.account.publicId) + "&tab=followers", token)).body;
  const ownCard = (body) => (body.accounts || []).find((a) => a.handle === "dn_cedar");
  const friView = ownCard(await followers(fri.token));
  assert.ok(friView, "owner listed");
  assert.equal(friView.displayName || friView.name, "Cedar Close");
  const strView = ownCard(await followers(str.token));
  if (strView) assert.equal(strView.displayName || strView.name, "Cedar Hill");

  // Search: a name only matches the one name this viewer sees.
  const search = async (token, q) => ((await get("/v1/people?q=" + encodeURIComponent(q), token)).body.accounts || []).map((a) => a.handle + ":" + (a.displayName || a.name));
  assert.deepEqual(await search(fri.token, "cedar close"), ["dn_cedar:Cedar Close"]);
  assert.deepEqual(await search(str.token, "cedar close"), [], "a name you can't see doesn't find the account");
  assert.deepEqual(await search(str.token, "cedar"), ["dn_cedar:Cedar Hill"], "a handle match still finds it");
  // Mention suggestions.
  const sug = async (token) => ((await get("/v1/mentions/suggest?q=dn_ced", token)).body.accounts || []).map((a) => a.handle + ":" + a.name);
  assert.deepEqual(await sug(lis.token), ["dn_cedar:Cedar Crew"]);
  assert.deepEqual(await sug(str.token), ["dn_cedar:Cedar Hill"]);

  // Notifications: a follow from the owner shows the name for that person.
  assert.equal((await send("/v1/follows", "PUT", own.token, { id: "app:" + lis.account.publicId })).status, 200);
  const notes = await get("/v1/notifications", lis.token);
  const follow = (notes.body.items || []).find((n) => n.kind === "follow" && n.handle === "dn_cedar");
  assert.ok(follow, notes.text);
  assert.equal(follow.name, "Cedar Crew");

  // Posts and replies.
  const posted = await send("/v1/posts", "POST", own.token, { body: "hello from the hill" });
  assert.equal(posted.status < 300, true, posted.text);
  const reply = await send("/v1/posts", "POST", fri.token, { body: "a reply", parentId: posted.body.post.id });
  assert.equal(reply.status < 300, true, reply.text);
  const feed = async (token) => (await get("/v1/posts?by=" + own.account.publicId, token)).body;
  const authorOf = (body) => { const p = (body.posts || body.items || [])[0]; return p ? p.authorName : ""; };
  assert.equal(authorOf(await feed(fri.token)), "Cedar Close");
  assert.equal(authorOf(await feed(fol.token)), "Cedar Hill");
  // Replies and the thread they sit in.
  const thread = async (token) => (await get("/v1/posts/thread?id=" + encodeURIComponent(posted.body.post.id), token)).text;
  assert.ok((await thread(per.token)).includes("Cedar For Pe"), "thread shows the name for this person");
  assert.ok(!(await thread(per.token)).includes("Cedar Close"));
  assert.ok(!(await thread(str.token)).includes("Cedar Close") && !(await thread(str.token)).includes("Cedar For Pe"));

  // A viewer's own private nickname still wins in their view.
  assert.equal((await send("/v1/nicknames", "PUT", fri.token, { handle: "dn_cedar", name: "Boss" })).status, 200);
  assert.equal((await look(fri.token)).displayName, "Boss");
  assert.equal(authorOf(await feed(fri.token)), "Boss");
  assert.equal((await send("/v1/nicknames", "PUT", fri.token, { handle: "dn_cedar", name: "" })).status, 200);

  // Main name limited to followers: strangers see no name, only the handle.
  const names = (await get("/v1/display-names", own.token)).body.names;
  assert.equal((await send("/v1/display-names", "PATCH", own.token, { id: "main", audience: { include: { followers: true } } })).status, 200);
  const hidden = await look(str.token);
  assert.equal(hidden.displayName, "dn_cedar");
  assert.equal(hidden.displayNameHidden, true);
  assert.equal((await look(fol.token)).displayName, "Cedar Hill");
  // A stranger's own nickname for the account must not reveal the hidden name as its reset target.
  assert.equal((await send("/v1/nicknames", "PUT", str.token, { handle: "dn_cedar", name: "Tree" })).status, 200);
  const nicked = await look(str.token);
  assert.equal(nicked.displayName, "Tree");
  assert.ok(!JSON.stringify(nicked).includes("Cedar Hill"), "the reset target never shows a name hidden from this viewer");
  assert.equal((await send("/v1/nicknames", "PUT", str.token, { handle: "dn_cedar", name: "" })).status, 200);
  assert.equal((await send("/v1/display-names", "PATCH", own.token, { id: "main", audience: { include: { public: true } } })).status, 200);

  // Make another name the main one: they swap, each keeps its audience.
  const crew = names.find((n) => n.name === "Cedar Crew");
  const swapped = await send("/v1/display-names/primary", "POST", own.token, { id: crew.id });
  assert.equal(swapped.status, 200, swapped.text);
  assert.equal(swapped.body.names[0].name, "Cedar Crew");
  assert.equal((await look(own.token)).displayName, "Cedar Crew", "the main name is the profile's own name");
  assert.equal((await look(str.token)).displayName, "Cedar Hill", "audiences stay with their names");
  assert.equal((await look(lis.token)).displayName, "Cedar Crew");
  assert.equal((await send("/v1/display-names", "DELETE", own.token, { id: "main" })).status, 409);
  assert.equal((await send("/v1/display-names", "DELETE", own.token, { id: crew.id })).status, 200);
  assert.equal((await look(lis.token)).displayName, "Cedar Crew");
  assert.equal((await look(str.token)).displayName, "dn_cedar", "no public name left: the handle stands in");
  assert.equal((await send("/v1/display-names", "POST", own.token, { name: "x".repeat(51) })).status, 400);
  assert.equal((await send("/v1/display-names", "GET", "")).status, 401);
});

test("the old name for friends moves into the set", async () => {
  const own = await signup(81, "Birch Lane", "dn_birch");
  const fri = await signup(82, "Fri Two", "dn_fri2");
  assert.equal((await send("/v1/follows", "PUT", fri.token, { id: "app:" + own.account.publicId })).status, 200);
  assert.equal((await send("/v1/follows", "PUT", own.token, { id: "app:" + fri.account.publicId })).status, 200);
  // Rows written by the old single "name for friends" before this change.
  const db = await mf.getD1Database("DB");
  await db.prepare("INSERT INTO friend_names (public_id, name, updated_at) VALUES (?, ?, ?)").bind(own.account.publicId, "Birchy", 1).run();
  const { DISPLAY_NAME_SCHEMA, resetDisplayNameGate } = await import("../src/display-names.js");
  for (const sql of DISPLAY_NAME_SCHEMA) await db.prepare(sql).run();
  for (const sql of DISPLAY_NAME_SCHEMA) await db.prepare(sql).run();
  resetDisplayNameGate();
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM friend_names").first()).n, 0);
  const set = (await get("/v1/display-names", own.token)).body.names;
  assert.deepEqual(set.map((n) => n.name), ["Birch Lane", "Birchy"]);
  assert.equal(set[1].audience.include.friends, true);
  assert.equal(set[1].audience.include.public, false);
  assert.equal((await get("/v1/profile/dn_birch", fri.token)).body.account.displayName, "Birchy");
  assert.equal((await get("/v1/usernames/friend-name", own.token)).body.name, "Birchy");
  assert.equal((await send("/v1/usernames/friend-name", "PUT", own.token, { name: "" })).status, 200);
  assert.equal((await get("/v1/profile/dn_birch", fri.token)).body.account.displayName, "Birch Lane");
});

test("the site owner sees every display name, whatever its audience, and it is audit-logged", async () => {
  const boss = await call("/v1/signup", { method: "POST", ip: "203.0.113.91", body: { displayName: "Site Owner", handle: "mirathorn", claimCode: "claim-test" } });
  assert.equal(boss.status, 201, boss.text);
  const own = await signup(92, "Oak Ridge", "dn_oak");
  const str = await signup(93, "St Two", "dn_str2");
  // Main name for followers only, a second name for friends that hides from the site owner.
  assert.equal((await send("/v1/display-names", "PATCH", own.token, { id: "main", audience: { include: { followers: true } } })).status, 200);
  const added = await send("/v1/display-names", "POST", own.token, { name: "Oak Close", audience: { include: { friends: true }, exclude: { people: ["mirathorn"] } } });
  assert.equal(added.status, 201, added.text);
  const look = async (token) => (await get("/v1/profile/dn_oak", token)).body.account;

  // A stranger sees no name; the site owner sees the main name and every name.
  const stranger = await look(str.token);
  assert.equal(stranger.displayNameHidden, true);
  assert.equal(stranger.allDisplayNames, undefined, "only the site owner gets every name");
  const seen = await look(boss.body.token);
  assert.equal(seen.displayName, "Oak Ridge");
  assert.equal(seen.displayNameHidden, undefined);
  assert.deepEqual(seen.allDisplayNames.map((n) => n.name), ["Oak Ridge", "Oak Close"]);
  assert.equal(JSON.stringify(seen.allDisplayNames).indexOf(boss.body.account.publicId), -1, "no ids leak");

  // Lists and search go through the same rule.
  const found = ((await get("/v1/people?q=" + encodeURIComponent("oak ridge"), boss.body.token)).body.accounts || []).map((a) => a.handle + ":" + (a.displayName || a.name));
  assert.deepEqual(found, ["dn_oak:Oak Ridge"]);
  assert.deepEqual(((await get("/v1/people?q=" + encodeURIComponent("oak ridge"), str.token)).body.accounts || []).map((a) => a.handle), []);

  // Every name with its audience, owner only.
  const of = await get("/v1/display-names/of?handle=dn_oak", boss.body.token);
  assert.equal(of.status, 200, of.text);
  assert.deepEqual(of.body.names.map((n) => n.name), ["Oak Ridge", "Oak Close"]);
  assert.deepEqual(of.body.names[1].audience.exclude.people, ["mirathorn"]);
  assert.equal(of.text.indexOf(own.account.publicId), -1, "no ids leak");
  assert.equal((await get("/v1/display-names/of?handle=dn_oak", str.token)).status, 403);
  assert.equal((await get("/v1/display-names/of?handle=dn_oak", own.token)).status, 403);
  assert.equal((await get("/v1/display-names/of?handle=nobody_here_zz", boss.body.token)).status, 404);

  // The audit log: one row per account per request, owner only.
  const log = await get("/v1/display-names/audit", boss.body.token);
  assert.equal(log.status, 200, log.text);
  const actions = log.body.entries.filter((e) => e.target === "dn_oak").map((e) => e.action);
  assert.ok(actions.includes("view") && actions.includes("list"), log.text);
  const views = log.body.entries.filter((e) => e.target === "dn_oak" && e.action === "view");
  assert.ok(views.some((e) => e.detail.path === "/v1/profile/dn_oak"), log.text);
  assert.equal(views.filter((e) => e.detail.path === "/v1/profile/dn_oak").length, 1, "one row per request");
  assert.equal((await get("/v1/display-names/audit", str.token)).status, 403);
  // Strangers leave no audit rows.
  assert.equal(log.body.entries.length, (await get("/v1/display-names/audit", boss.body.token)).body.entries.length);
});
