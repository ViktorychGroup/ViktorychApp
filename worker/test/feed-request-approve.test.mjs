import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";

/* The owner's Allow must save the source even when every public bridge
   blocks the Worker or hangs: the sync fetches it later. Dummy names only. */
const OWNER = "ownerlane";
let mf;
let ownerTok = "";
const slowHosts = new Set(["t.me"]);

async function outbound(request) {
  const url = new URL(request.url);
  if (url.hostname === "api.github.com") return new Response(null, { status: 204 });
  if (slowHosts.has(url.hostname)) {
    await new Promise((resolve) => setTimeout(resolve, 15000));
    return new Response("late", { status: 504 });
  }
  return new Response("blocked", { status: 403 });
}

async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers();
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.10");
  headers.set("Origin", "https://viktorychgroup.github.io");
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.body) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (err) { body = { raw: text }; }
  return { status: res.status, body, cors: res.headers.get("access-control-allow-origin") };
}

let ipN = 30;
function ip() { ipN += 1; return "198.51.100." + (ipN % 250 + 1); }

async function signup(handle, extra) {
  const res = await call("/v1/signup", { method: "POST", ip: ip(), body: Object.assign({ displayName: handle, handle }, extra || {}) });
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

test("Instagram requests normalize to one handle however they are pasted", async () => {
  const members = [await signup("memberfern"), await signup("memberpine")];
  const spellings = [
    "https://www.instagram.com/sample.igwave",
    "https://instagram.com/sample.igwave/",
    "https://www.instagram.com/sample.igwave/?igsh=abc123&hl=es",
    "instagram.com/sample.igwave",
    "instagram:@sample.igwave",
    "https://m.instagram.com/sample.igwave?utm_source=ig_web"
  ];
  let id = "";
  for (let i = 0; i < spellings.length; i++) {
    const res = await call("/v1/feed-requests", { method: "POST", ip: ip(), token: members[i % 2].token, body: { input: spellings[i] } });
    assert.equal(res.status, 200, spellings[i] + " " + JSON.stringify(res.body));
    assert.equal(res.body.request.key, "instagram:sample.igwave", spellings[i]);
    assert.equal(res.body.request.input, "instagram:sample.igwave", "stored as platform:handle, never the pasted URL");
    assert.equal(res.body.request.handle, "sample.igwave");
    if (id) assert.equal(res.body.request.id, id, "one request for every spelling");
    id = res.body.request.id;
  }
});

test("Allow saves every platform even when the bridges block or hang, single and bulk", { timeout: 120000 }, async () => {
  const owner = await signup(OWNER, { claimCode: "claim-test" });
  ownerTok = owner.token;
  const askers = [];
  for (let i = 0; i < 4; i++) askers.push(await signup("asker" + "abcd"[i] + "wood"));
  const inputs = [
    ["https://www.instagram.com/sample.igwave", "instagram:sample.igwave"],
    ["https://x.com/samplexlane?s=20", "x:samplexlane"],
    ["https://www.threads.net/@samplethreads", "threads:samplethreads"],
    ["https://www.youtube.com/@sampletube", "youtube:sampletube"],
    ["https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv", "youtube:ucabcdefghijklmnopqrstuv"],
    ["https://www.tiktok.com/@sampletok", "tiktok:sampletok"],
    ["https://vk.com/samplevk", "vk:samplevk"],
    ["https://t.me/samplechannel", "telegram:samplechannel"],
    ["https://www.reddit.com/user/sampleredditor", "reddit:u:sampleredditor"],
    ["https://bsky.app/profile/sample.bsky.social", "bluesky:sample.bsky.social"],
    ["https://social.example/@samplefedi", "mastodon:samplefedi@social.example"],
    ["https://feeds.example/sample.xml", null]
  ];
  const ids = {};
  for (let i = 0; i < inputs.length; i++) {
    const [input, key] = inputs[i];
    const res = await call("/v1/feed-requests", { method: "POST", ip: ip(), token: askers[i % askers.length].token, body: { input } });
    assert.equal(res.status, 200, input + " " + JSON.stringify(res.body));
    if (key) assert.equal(res.body.request.key, key);
    ids[input] = res.body.request.id;
  }
  const community = await call("/v1/feed-requests", { method: "POST", ip: ip(), token: askers[0].token, body: { input: "samplecove", kind: "community" } });
  assert.equal(community.status, 200, JSON.stringify(community.body));
  const igReq = ids[inputs[0][0]];

  // A pending row filed before this fix keeps its pasted URL; the queue cleans it.
  const b = await mf.getBindings();
  await b.DB.prepare("INSERT INTO feed_requests (id, source_key, kind, platform, handle, input, state, created_at, updated_at) VALUES ('fr_00000000000000aa', 'instagram:legacy.igwave', 'feed', 'instagram', 'legacy.igwave', 'https://www.instagram.com/legacy.igwave/?igsh=zz', 'pending', 1, 1)").run();
  const queue = await call("/v1/owner/feed-requests?state=pending", { ip: ip(), token: owner.token });
  assert.equal(queue.status, 200);
  const legacy = queue.body.requests.find((r) => r.id === "fr_00000000000000aa");
  assert.equal(legacy.input, "instagram:legacy.igwave");
  assert.equal(legacy.handle, "legacy.igwave");
  assert.ok(queue.body.requests.every((r) => !/^https?:\/\/(www\.)?instagram\.com/.test(r.input)), "no raw Instagram URL left in the queue");

  // Preflight and CORS on the allow route.
  const pre = await call(`/v1/owner/feed-requests/${igReq}/allow`, { method: "OPTIONS", ip: ip() });
  assert.ok(pre.status === 204 || pre.status === 200, String(pre.status));
  assert.equal(pre.cors, "https://viktorychgroup.github.io");

  // Single allow for Instagram (every bridge answers 403).
  const ig = await call(`/v1/owner/feed-requests/${igReq}/allow`, { method: "POST", ip: ip(), token: owner.token, body: { dest: "everyone" } });
  assert.equal(ig.status, 200, JSON.stringify(ig.body));
  assert.equal(ig.body.unverified, true);
  assert.equal(ig.cors, "https://viktorychgroup.github.io");

  // Telegram's bridge hangs: Allow still answers within the time limit.
  const started = Date.now();
  const tg = await call(`/v1/owner/feed-requests/${ids["https://t.me/samplechannel"]}/allow`, { method: "POST", ip: ip(), token: owner.token, body: { dest: "everyone" } });
  assert.equal(tg.status, 200, JSON.stringify(tg.body));
  assert.ok(Date.now() - started < 12000, "allow does not wait for a hanging bridge");

  // Only the people who asked, and a new list with a member.
  const yt = await call(`/v1/owner/feed-requests/${ids[inputs[3][0]]}/allow`, { method: "POST", ip: ip(), token: owner.token, body: { dest: "requester" } });
  assert.equal(yt.status, 200, JSON.stringify(yt.body));
  const th = await call(`/v1/owner/feed-requests/${ids[inputs[2][0]]}/allow`, { method: "POST", ip: ip(), token: owner.token, body: { dest: "list", newList: "Sample list", members: ["askerbwood"] } });
  assert.equal(th.status, 200, JSON.stringify(th.body));
  const lists = await r2json("owner/source-lists.json");
  assert.ok(lists && lists.lists.some((l) => l.name === "Sample list" && l.sources.indexOf("threads:samplethreads") >= 0), "Threads went into the new list");

  // Bulk allow for everything else, the legacy row and the community included.
  const rest = Object.values(ids).filter((id) => [igReq, tg.body.id, yt.body.id, th.body.id].indexOf(id) < 0).concat(["fr_00000000000000aa", community.body.request.id]);
  const bulk = await call("/v1/owner/feed-requests/bulk", { method: "POST", ip: ip(), token: owner.token, body: { ids: rest, action: "allow", dest: "everyone" } });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
  assert.deepEqual(bulk.body.results.filter((r) => !r.ok), [], JSON.stringify(bulk.body.results));
  assert.equal(bulk.body.pending, 0);

  const catalog = await r2json("owner/feeds-catalog.json");
  const got = new Set(catalog.accounts.map((a) => String(a.id).toLowerCase()));
  for (const id of ["instagram:sample.igwave", "instagram:legacy.igwave", "x:samplexlane", "youtube:ucabcdefghijklmnopqrstuv", "tiktok:sampletok", "vk:samplevk", "telegram:samplechannel", "reddit:u:sampleredditor", "bluesky:sample.bsky.social", "mastodon:samplefedi@social.example"]) {
    assert.ok(got.has(id), "catalog has " + id);
  }
  assert.ok(!got.has("youtube:sampletube"), "allowed only for who asked stays out of the shared catalog");
  const igRow = catalog.accounts.find((a) => a.id === "instagram:sample.igwave");
  assert.equal(igRow.handle, "sample.igwave");
  assert.equal(igRow.name, "sample.igwave");
  assert.equal(igRow.paused, false);

  const decided = await call("/v1/owner/feed-requests?state=decided", { ip: ip(), token: owner.token });
  assert.ok(decided.body.requests.length >= 13);
  assert.ok(decided.body.requests.every((r) => r.state === "approved"));

  // The asker sees it approved.
  const mine = await call("/v1/feed-requests", { ip: ip(), token: askers[0].token });
  assert.ok(mine.body.requests.some((r) => r.key === "instagram:sample.igwave" && r.state === "approved"));
});

test("a failed Allow answers with a code the app turns into a clear message", async () => {
  const m = await signup("memberashx");
  const req = await call("/v1/feed-requests", { method: "POST", ip: ip(), token: m.token, body: { input: "https://www.instagram.com/banned.igwave" } });
  assert.equal(req.status, 200);
  const b = await mf.getBindings();
  await b.DB.prepare("INSERT INTO feed_bans (source_key, alias, platform, input, created_at) VALUES ('instagram:banned.igwave', '', 'instagram', 'instagram:banned.igwave', 1)").run();
  const ownerToken = ownerTok;
  assert.ok(ownerToken, "the owner signed up in the test above");
  const res = await call(`/v1/owner/feed-requests/${req.body.request.id}/allow`, { method: "POST", ip: ip(), token: ownerToken, body: { dest: "everyone" } });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "banned");
  const none = await call("/v1/owner/feed-requests/fr_0000000000000000/allow", { method: "POST", ip: ip(), token: ownerToken, body: {} });
  assert.equal(none.status, 404);
  assert.equal(none.body.error, "not_found");
});
