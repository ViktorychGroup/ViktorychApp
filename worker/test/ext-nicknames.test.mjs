import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { readdirSync, readFileSync } from "node:fs";

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
      OWNER_HANDLE: "ownertest",
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000"
    },
    async outboundService() { return new Response("no", { status: 404 }); }
  };
}

const IP = { n: 10 };
async function call(path, opts) {
  opts = opts || {};
  IP.n += 1;
  const headers = new Headers();
  headers.set("CF-Connecting-IP", opts.ip || ("198.51.100." + (IP.n % 250)));
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.body) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (err) { body = { raw: text }; }
  return { status: res.status, body };
}

async function signup(n, displayName, handle) {
  const res = await call("/v1/signup", { method: "POST", ip: "203.0.113." + n, body: { displayName, handle } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test.before(async () => { mf = new Miniflare(workerOptions()); });
test.after(async () => { if (mf) await mf.dispose(); });

test("normalizeSourceKey folds platforms, handles and reddit forms", async () => {
  const { normalizeSourceKey } = await import("../src/name-rules.js");
  assert.equal(normalizeSourceKey("X:@Sample_Writer"), "x:sample_writer");
  assert.equal(normalizeSourceKey(" twitter:Sample "), "x:sample");
  assert.equal(normalizeSourceKey("bluesky:Sample.bsky.social"), "bsky:sample.bsky.social");
  assert.equal(normalizeSourceKey("fediverse:Sample@Social.Example"), "mastodon:sample@social.example");
  assert.equal(normalizeSourceKey("reddit:u/SampleUser"), "reddit:sampleuser");
  assert.equal(normalizeSourceKey("reddit:/r/SampleSub"), "reddit:r/samplesub");
  assert.equal(normalizeSourceKey("youtube:UCabcDEF123"), "youtube:ucabcdef123");
  assert.equal(normalizeSourceKey("person:Merged-1"), "person:merged-1");
  assert.equal(normalizeSourceKey("rss:https://blog.example.com/feed"), "rss:https://blog.example.com/feed");
  assert.equal(normalizeSourceKey("app:someone"), "");
  assert.equal(normalizeSourceKey("nocolon"), "");
  assert.equal(normalizeSourceKey("x:"), "");
  assert.equal(normalizeSourceKey("x:<script>"), "");
  assert.equal(normalizeSourceKey("x:" + "a".repeat(201)), "");
});

test("external nicknames: PUT, GET, DELETE, reset and isolation between viewers", async () => {
  const a = await signup(41, "Viewer One", "viewerone");
  const b = await signup(42, "Viewer Two", "viewertwo");

  assert.equal((await call("/v1/nicknames/external")).status, 401);

  let res = await call("/v1/nicknames/external", { method: "PUT", token: a.token, body: { key: "X:@Sample_Writer", name: "  My   writer  " } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.key, "x:sample_writer");
  assert.equal(res.body.name, "My writer");

  res = await call("/v1/nicknames/external", { method: "PUT", token: a.token, body: { key: "reddit:r/SampleSub", name: "Cars" } });
  assert.equal(res.status, 200);
  res = await call("/v1/nicknames/external", { method: "PUT", token: a.token, body: { key: "x:sample_writer", name: "x".repeat(80) } });
  assert.equal(res.body.name.length, 50, "same cap as cleanNickname");

  res = await call("/v1/nicknames/external", { method: "PUT", token: a.token, body: { key: "app:viewertwo", name: "Nope" } });
  assert.equal(res.status, 400);

  res = await call("/v1/nicknames/external", { token: a.token });
  assert.equal(res.status, 200);
  const keys = res.body.nicknames.map((n) => n.key).sort();
  assert.deepEqual(keys, ["reddit:r/samplesub", "x:sample_writer"]);

  // Viewer two sees nothing of viewer one's names, and their own name for the same account stays separate.
  res = await call("/v1/nicknames/external", { token: b.token });
  assert.deepEqual(res.body.nicknames, []);
  await call("/v1/nicknames/external", { method: "PUT", token: b.token, body: { key: "x:sample_writer", name: "Other name" } });
  res = await call("/v1/nicknames/external", { token: a.token });
  assert.equal(res.body.nicknames.find((n) => n.key === "x:sample_writer").name, "x".repeat(50));

  // An empty name resets; DELETE removes.
  res = await call("/v1/nicknames/external", { method: "PUT", token: a.token, body: { key: "x:sample_writer", name: "   " } });
  assert.equal(res.status, 200);
  res = await call("/v1/nicknames/external", { method: "DELETE", token: a.token, body: { key: "reddit:r/samplesub" } });
  assert.equal(res.status, 200);
  res = await call("/v1/nicknames/external", { token: a.token });
  assert.deepEqual(res.body.nicknames, []);
  res = await call("/v1/nicknames/external", { token: b.token });
  assert.deepEqual(res.body.nicknames.map((n) => n.name), ["Other name"]);

  // Public profile data never carries another viewer's external nicknames.
  const pub = await call("/v1/profile/viewertwo");
  assert.ok(!JSON.stringify(pub.body || {}).includes("Other name"));
});

test("the owner cannot read another viewer's custom names", async () => {
  const created = await call("/v1/signup", { method: "POST", ip: "203.0.113.61", body: { displayName: "Owner Test", handle: "ownertest", claimCode: "claim-test" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const owner = created.body;
  const v = await signup(62, "Viewer Three", "viewerthree");
  await call("/v1/nicknames/external", { method: "PUT", token: v.token, body: { key: "x:sample_secret", name: "Secret name" } });
  const id = (v.account && (v.account.id || v.account.publicId)) || "viewerthree";
  for (const q of ["", "?viewer=" + id, "?user=" + id, "?id=" + id, "?handle=viewerthree", "?viewer_id=" + id]) {
    const res = await call("/v1/nicknames/external" + q, { token: owner.token });
    assert.equal(res.status, 200);
    assert.ok(!JSON.stringify(res.body).includes("Secret name"), "owner saw a viewer's name via " + (q || "plain GET"));
  }
  const res = await call("/v1/nicknames/external", { token: v.token });
  assert.deepEqual(res.body.nicknames.map((n) => n.name), ["Secret name"]);
});

test("no other worker module reads the private nickname tables", async () => {
  const { VIEWER_PRIVATE_TABLES } = await import("../src/name-rules.js");
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  const hits = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".js") || f === "name-rules.js") continue;
    const src = readFileSync(dir + f, "utf8");
    for (const table of VIEWER_PRIVATE_TABLES) if (new RegExp("\\b(FROM|JOIN|INTO|UPDATE|TABLE)\\s+[\"'`]?" + table + "\\b", "i").test(src)) hits.push(f + ": " + table);
  }
  assert.deepEqual(hits, [], "private nickname tables are only read in name-rules.js, keyed by the viewer");
});
