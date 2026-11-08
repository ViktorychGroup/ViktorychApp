import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";

const OWNER = "ownerlane";
const dispatches = [];
let ownerToken = "";
let mf;

function rss(title) {
  return `<rss><channel><title>${title}</title><item><title>Hello</title><description>Hello from the sample</description><guid>p1</guid><link>https://feeds.example/p1</link></item></channel></rss>`;
}

const outboundHits = [];
let releaseSlow = null;
async function outbound(request) {
  const url = new URL(request.url);
  outboundHits.push(url.pathname);
  if (url.hostname === "api.github.com") {
    dispatches.push(await request.text());
    return new Response(null, { status: 204 });
  }
  if (url.hostname === "feeds.example" && url.pathname === "/slow.xml") {
    await new Promise((resolve) => { releaseSlow = resolve; setTimeout(resolve, 8000); });
    return new Response(rss("Slow Wind"), { status: 200, headers: { "content-type": "application/rss+xml" } });
  }
  if (url.hostname === "feeds.example") return new Response(rss("Sample Wind"), { status: 200, headers: { "content-type": "application/rss+xml" } });
  return new Response("missing", { status: 404 });
}

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

async function r2json(key) {
  const b = await mf.getBindings();
  const obj = await b.DATA.get(key);
  return obj ? JSON.parse(await obj.text()) : null;
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
      PBKDF2_ITERATIONS: "1000",
      GITHUB_DISPATCH_TOKEN: "dispatch-test"
    },
    outboundService: outbound
  });
});

test.after(async () => { if (mf) await mf.dispose(); });

test("source lists reach only assigned accounts", async () => {
  const owner = await signup(OWNER, "203.0.113.20", { claimCode: "claim-test" });
  ownerToken = owner.token;
  const member = await signup("membermaple", "203.0.113.21");
  const other = await signup("otherbirch", "203.0.113.22");

  assert.equal((await call("/v1/owner/source-lists", { ip: "203.0.113.30" })).status, 404);
  assert.equal((await call("/v1/owner/source-lists", { ip: "203.0.113.31", token: member.token })).status, 403);

  const made = await call("/v1/owner/source-lists", { method: "POST", ip: "203.0.113.32", token: owner.token, body: { name: "Weekend picks" } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const lid = made.body.created;
  assert.match(lid, /^s[a-f0-9]{8}$/);

  const src = await call(`/v1/owner/source-lists/${lid}/sources`, { method: "POST", ip: "203.0.113.33", token: owner.token, body: { input: "https://feeds.example/sample.xml" } });
  assert.equal(src.status, 200, JSON.stringify(src.body));
  const sid = src.body.added;
  // No member yet: nothing is fetched.
  let wanted = await r2json("owner/lists/wanted.json");
  assert.equal(wanted.sources.length, 0);

  dispatches.length = 0;
  const assign = await call(`/v1/owner/source-lists/${lid}/members`, { method: "POST", ip: "203.0.113.34", token: owner.token, body: { handle: "@membermaple" } });
  assert.equal(assign.status, 200, JSON.stringify(assign.body));
  assert.equal(assign.body.lists[0].members[0].handle, "membermaple");
  wanted = await r2json("owner/lists/wanted.json");
  assert.deepEqual(wanted.sources.map((row) => row.id), [sid]);
  assert.ok(!JSON.stringify(wanted).includes(member.account.publicId || "membermaple"), "no account ids in wanted");
  assert.equal(dispatches.length, 1);
  const health = assign.body.lists[0].sources[0].health;
  assert.equal(health && health.ok, true, "the owner sees posts as soon as the account is assigned");
  assert.ok((health && health.count) >= 1);

  const started = Date.now();
  const immediate = await call("/v1/me/source-lists", { ip: "203.0.113.38", token: member.token });
  const readMs = Date.now() - started;
  assert.equal(immediate.status, 200);
  const nowList = immediate.body.lists.find((row) => row.id === lid);
  assert.equal(nowList.status, "ready");
  assert.match(nowList.hash, /^[a-f0-9]{64}$/);
  const quick = await call("/v1/me/source-lists/shard/" + nowList.hash, { ip: "203.0.113.39", token: member.token });
  assert.equal(quick.status, 200);
  assert.match(quick.text, /Hello/);
  assert.equal(quick.text.includes(String(member.account.publicId)), false);
  assert.ok(readMs < 3000, "assigned posts were not waiting on the scheduler (" + readMs + "ms)");
  assert.deepEqual((await call("/v1/me/source-lists", { ip: "203.0.113.39", token: other.token })).body.lists, []);

  // A second list with the same source keeps one fetch.
  const second = await call("/v1/owner/source-lists", { method: "POST", ip: "203.0.113.35", token: owner.token, body: { name: "Second" } });
  const lid2 = second.body.created;
  await call(`/v1/owner/source-lists/${lid2}/sources`, { method: "POST", ip: "203.0.113.36", token: owner.token, body: { input: "https://feeds.example/sample.xml" } });
  await call(`/v1/owner/source-lists/${lid2}/members`, { method: "POST", ip: "203.0.113.37", token: owner.token, body: { handle: "membermaple" } });
  wanted = await r2json("owner/lists/wanted.json");
  assert.equal(wanted.sources.length, 1);
  assert.equal(wanted.lists.length, 2);

  // The sync's output.
  const shard = JSON.stringify({ v: 1, feeds: [{ id: sid, platform: "rss", handle: "sample" }], posts: [{ id: "p1", feedId: sid, text: "Hello" }] }) + "\n";
  const hash = createHash("sha256").update(shard).digest("hex");
  const b = await mf.getBindings();
  await b.DATA.put("lists/shards/" + hash + ".json", shard);
  await b.DATA.put("owner/lists/index.json", JSON.stringify({ v: 1, lists: { [lid]: { hash, size: shard.length, count: 1, at: Date.now() + 60000 } } }));

  const mine = await call("/v1/me/source-lists", { ip: "203.0.113.40", token: member.token });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.lists.length, 2);
  assert.equal(mine.body.lists.find((row) => row.id === lid).hash, hash);
  const got = await call("/v1/me/source-lists/shard/" + hash, { ip: "203.0.113.41", token: member.token });
  assert.equal(got.status, 200);
  assert.equal(createHash("sha256").update(got.text).digest("hex"), hash);

  const theirs = await call("/v1/me/source-lists", { ip: "203.0.113.42", token: other.token });
  assert.deepEqual(theirs.body.lists, []);
  assert.equal((await call("/v1/me/source-lists/shard/" + hash, { ip: "203.0.113.43", token: other.token })).status, 404);
  const ownerSees = await call("/v1/me/source-lists", { ip: "203.0.113.44", token: owner.token });
  assert.deepEqual(ownerSees.body.lists, [], "the owner's own feed stays clean");
  assert.equal((await call("/v1/me/source-lists", { ip: "203.0.113.45" })).status, 401);

  // Requests land in the owner's source request queue and allow into a list.
  const asked = await call("/v1/me/source-lists/requests", { method: "POST", ip: "203.0.113.46", token: other.token, body: { input: "https://feeds.example/other.xml" } });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  let view = await call("/v1/owner/feed-requests", { ip: "203.0.113.47", token: owner.token });
  assert.equal(view.body.requests.length, 1);
  assert.equal(view.body.requests[0].requesters[0].handle, "otherbirch");
  const approved = await call(`/v1/owner/feed-requests/${view.body.requests[0].id}/allow`, { method: "POST", ip: "203.0.113.48", token: owner.token, body: { dest: "list", newList: "For otherbirch" } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.pending, 0);
  const listsNow = await call("/v1/owner/source-lists", { ip: "203.0.113.52", token: owner.token });
  const made3 = listsNow.body.lists.find((row) => row.name === "For otherbirch");
  assert.equal(made3.members[0].handle, "otherbirch");

  // Unassign and delete stop the fetch.
  const memberId = assign.body.lists[0].members[0].id;
  await call(`/v1/owner/source-lists/${lid}/members/${memberId}`, { method: "DELETE", ip: "203.0.113.49", token: owner.token });
  await call(`/v1/owner/source-lists/${lid2}`, { method: "DELETE", ip: "203.0.113.50", token: owner.token });
  await call(`/v1/owner/source-lists/${made3.id}`, { method: "DELETE", ip: "203.0.113.51", token: owner.token });
  wanted = await r2json("owner/lists/wanted.json");
  assert.equal(wanted.sources.length, 0);
  const docAfter = await r2json("owner/source-lists.json");
  assert.equal(Object.keys(docAfter.sources).length, 1, "only the source of the remaining list is kept");
});

test("a removal during the fetch is not restored, and one budget covers every source", async () => {
  const owner = { token: ownerToken };
  const member = await signup("membercedar", "203.0.113.61");
  const made = await call("/v1/owner/source-lists", { method: "POST", ip: "203.0.113.62", token: owner.token, body: { name: "Held" } });
  const lid = made.body.created;
  const src = await call(`/v1/owner/source-lists/${lid}/sources`, { method: "POST", ip: "203.0.113.63", token: owner.token, body: { input: "https://feeds.example/sample.xml" } });
  assert.equal(src.status, 200, JSON.stringify(src.body));
  await call(`/v1/owner/source-lists/${lid}/members`, { method: "POST", ip: "203.0.113.64", token: owner.token, body: { handle: "membercedar" } });
  const rich = {
    id: "full-post",
    text: "X".repeat(600),
    date: "2026-11-08T12:00:00.000Z",
    url: "https://feeds.example/full",
    media: [{ type: "photo", url: "https://cdn.example/full.jpg" }],
    quoted: { id: "q-full", handle: "quotedlane", text: "quoted body" }
  };
  const doc = await r2json("owner/source-lists.json");
  const sourceId = doc.lists.find((row) => row.id === lid).sources[0];
  doc.sources[sourceId].cachedPosts = [rich];
  doc.sources.slow = { id: "slow", platform: "rss", handle: "slow", url: "https://feeds.example/slow.xml", name: "Slow", cachedPosts: [] };
  doc.sources.next = { id: "next", platform: "rss", handle: "next", url: "https://feeds.example/next.xml", name: "Next", cachedPosts: [] };
  const list = doc.lists.find((row) => row.id === lid);
  list.sources = [sourceId, "slow", "next"];
  list.changedAt = Date.now();
  const b = await mf.getBindings();
  await b.DATA.put("owner/source-lists.json", JSON.stringify(doc));
  const index = (await r2json("owner/lists/index.json")) || { v: 1, lists: {} };
  delete index.lists[lid];
  await b.DATA.put("owner/lists/index.json", JSON.stringify(index));
  outboundHits.length = 0;
  const started = Date.now();
  const pending = call("/v1/me/source-lists", { ip: "203.0.113.65", token: member.token });
  for (let i = 0; i < 50 && !outboundHits.includes("/slow.xml"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const memberId = String(member.account.publicId);
  await call(`/v1/owner/source-lists/${lid}/members/${memberId}`, { method: "DELETE", ip: "203.0.113.66", token: owner.token });
  const body = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ late: true }), 6000))
  ]);
  if (releaseSlow) releaseSlow();
  const elapsed = Date.now() - started;
  assert.equal(body.late, undefined, "the read did not finish inside the budget");
  assert.ok(elapsed < 6000, "the read ran past the whole-list budget (" + elapsed + "ms)");
  assert.equal(outboundHits.includes("/next.xml"), false, "a source past the budget was still fetched");
  const stored = await r2json("owner/source-lists.json");
  const storedList = stored.lists.find((row) => row.id === lid);
  assert.equal(storedList.members.includes(memberId), false, "the removal was restored");
  const again = await call("/v1/me/source-lists", { ip: "203.0.113.68", token: member.token });
  assert.equal(again.body.lists.find((row) => row.id === lid), undefined);
  const faithful = await r2json("owner/lists/index.json");
  const shard = faithful && faithful.lists && faithful.lists[lid];
  if (shard && shard.hash) {
    const got = await call("/v1/me/source-lists/shard/" + shard.hash, { ip: "203.0.113.67", token: owner.token });
    assert.equal(got.status, 404, "the removed account's shard stayed readable");
  }
});

test("stored posts keep their text, media and quotes, and a failed source stays visible", async () => {
  const owner = { token: ownerToken };
  const member = await signup("memberalder", "203.0.113.71");
  const made = await call("/v1/owner/source-lists", { method: "POST", ip: "203.0.113.72", token: owner.token, body: { name: "Full" } });
  const lid = made.body.created;
  await call(`/v1/owner/source-lists/${lid}/sources`, { method: "POST", ip: "203.0.113.73", token: owner.token, body: { input: "https://feeds.example/sample.xml" } });
  await call(`/v1/owner/source-lists/${lid}/members`, { method: "POST", ip: "203.0.113.74", token: owner.token, body: { handle: "memberalder" } });
  const rich = {
    id: "full-post",
    text: "Y".repeat(600),
    date: "2026-11-08T12:00:00.000Z",
    url: "https://feeds.example/full",
    media: [{ type: "photo", url: "https://cdn.example/full.jpg" }],
    quoted: { id: "q-full", handle: "quotedlane", text: "quoted body" }
  };
  const doc = await r2json("owner/source-lists.json");
  const list = doc.lists.find((row) => row.id === lid);
  const sourceId = list.sources[0];
  doc.sources[sourceId].cachedPosts = [rich];
  doc.sources.missing = { id: "missing", platform: "rss", handle: "missing", url: "https://feeds.example/missing.xml", name: "Missing", cachedPosts: [] };
  list.sources = [sourceId, "missing"];
  list.changedAt = Date.now();
  const b = await mf.getBindings();
  await b.DATA.put("owner/source-lists.json", JSON.stringify(doc));
  const index = (await r2json("owner/lists/index.json")) || { v: 1, lists: {} };
  delete index.lists[lid];
  await b.DATA.put("owner/lists/index.json", JSON.stringify(index));
  const mine = await call("/v1/me/source-lists", { ip: "203.0.113.75", token: member.token });
  const row = mine.body.lists.find((item) => item.id === lid);
  assert.equal(row.status, "error");
  assert.match(row.hash, /^[a-f0-9]{64}$/);
  const got = await call("/v1/me/source-lists/shard/" + row.hash, { ip: "203.0.113.76", token: member.token });
  assert.equal(got.status, 200);
  assert.equal(got.text.includes("Y".repeat(600)), true);
  assert.equal(got.text.includes("https://cdn.example/full.jpg"), true);
  assert.equal(got.text.includes("quotedlane"), true);
});
