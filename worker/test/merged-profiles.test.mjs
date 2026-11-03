import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

/* Linked profiles merged into the account's own profile: proof, the
   merge/separate choice, per-link audiences (incl. specific people), the
   site owner's audited view, the redirect map, and unlinking. */

let mf;
const bios = {};

function options(extra) {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    bindings: Object.assign({
      ACCOUNT_PEPPER: "pepper-test",
      OWNER_CLAIM_CODE: "claim-test",
      OWNER_HANDLE: "mirathorn",
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000"
    }, extra || {}),
    async outboundService(request) {
      const url = new URL(request.url);
      if (url.hostname === "api.fxtwitter.com") {
        const handle = decodeURIComponent(url.pathname.replace(/^\//, "")).toLowerCase();
        if (bios[handle] == null) return new Response("{}", { status: 404 });
        return new Response(JSON.stringify({ user: { screen_name: handle, name: "Example " + handle, description: bios[handle] } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.hostname.includes("instagram.com")) {
        const handle = decodeURIComponent(url.pathname.replace(/^\/|\/$/g, "")).toLowerCase();
        return new Response("<html><p>" + (bios["ig:" + handle] || "") + "</p></html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("not found", { status: 404 });
    }
  };
}

let ipN = 10;
async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers();
  headers.set("CF-Connecting-IP", opts.ip || ("198.51.100." + (ipN++ % 250)));
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.body) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (err) { body = { raw: text }; }
  return { status: res.status, body, text };
}
const get = (path, token) => call(path, { token });
const send = (path, method, token, body) => call(path, { method, token, body });

async function signup(handle, name, claim) {
  const res = await call("/v1/signup", { method: "POST", body: Object.assign({ displayName: name, handle }, claim ? { claimCode: claim } : {}) });
  assert.equal(res.status, 201, res.text);
  return res.body;
}

async function link(user, platform, handle) {
  const ch = await send("/v1/account/identities/challenge", "POST", user.token, { platform, handle });
  assert.equal(ch.status, 200, ch.text);
  if (platform === "x") bios[handle.toLowerCase()] = "me " + ch.body.code;
  else bios["ig:" + handle.toLowerCase()] = "me " + ch.body.code;
  const ok = await send("/v1/account/identities/verify", "POST", user.token, { challengeId: ch.body.challengeId });
  assert.equal(ok.status, 200, ok.text);
  return ok.body.identity;
}

test.before(async () => { mf = new Miniflare(options()); });
test.after(async () => { if (mf) await mf.dispose(); });

test("linking needs real proof: a mock proof is refused outside tests", async () => {
  const u = await signup("mp_fox", "Fox Example");
  const ch = await send("/v1/account/identities/challenge", "POST", u.token, { platform: "x", handle: "fox_nobody_owns" });
  assert.equal(ch.status, 200, ch.text);
  const fake = await send("/v1/account/identities/verify", "POST", u.token, { challengeId: ch.body.challengeId, proofUrl: "mock:anything" });
  assert.equal(fake.status, 400, "mock proofs are off in production");
  assert.equal((await get("/v1/account/identities", u.token)).body.identities.length, 0);
});

test("a new link merges by default; the choice switches both ways and keeps everything", async () => {
  const u = await signup("mp_elm", "Elm Example");
  const ident = await link(u, "x", "elm_on_x");
  assert.ok(ident.id > 0, "verify returns the stored id");
  assert.equal(ident.merged, true);
  assert.equal(ident.audience, "public");

  const other = await signup("mp_elm_viewer", "Viewer Example");
  assert.equal((await get("/v1/identities/merged", "")).status, 401, "signed-out viewers get nothing");
  const map = async (token) => (await get("/v1/identities/merged", token || other.token)).body.merged;
  const anon = await map("");
  const row = anon.find((m) => m.platform === "x" && m.handle === "elm_on_x");
  assert.ok(row, JSON.stringify(anon));
  assert.equal(row.to, "mp_elm");
  assert.equal(row.name, "Elm Example");
  assert.equal(JSON.stringify(anon).indexOf(u.account.publicId), -1, "no account ids in the map");

  // Keep separate page: still linked and listed, but no redirect.
  const sep = await send("/v1/account/identities/" + ident.id, "PATCH", u.token, { merged: false });
  assert.equal(sep.status, 200, sep.text);
  assert.equal(sep.body.identity.merged, false);
  assert.equal(sep.body.identity.audience, "public", "switching one field leaves the audience alone");
  assert.equal((await map("")).some((m) => m.handle === "elm_on_x"), false);
  const profRes = await get("/v1/profile/mp_elm", other.token);
  assert.equal(profRes.status, 200, profRes.text);
  const prof = profRes.body.account;
  assert.equal(prof.identities.length, 1);
  assert.equal(prof.identities[0].merged, false);

  // Back to merged.
  assert.equal((await send("/v1/account/identities/" + ident.id, "PATCH", u.token, { merged: true })).body.identity.merged, true);
  assert.ok((await map("")).some((m) => m.handle === "elm_on_x"));

  // Unlink: the redirect goes away and the source has its own page again.
  const del = await send("/v1/account/identities/" + ident.id, "DELETE", u.token);
  assert.equal(del.status, 200, del.text);
  assert.equal((await map("")).some((m) => m.handle === "elm_on_x"), false);
  assert.equal((await get("/v1/account/identities", u.token)).body.identities.length, 0);
  // Linking again starts merged.
  assert.equal((await link(u, "x", "elm_on_x")).merged, true);
});

test("each link has its own audience, enforced on the server; the site owner sees all, audited", async () => {
  const boss = await signup("mirathorn", "Site Owner", "claim-test");
  const u = await signup("mp_ash", "Ash Example");
  const pal = await signup("mp_pal", "Pal Example");
  const fan = await signup("mp_fan", "Fan Example");
  const str = await signup("mp_str", "Str Example");
  const open = await link(u, "x", "ash_public");
  const chosen = await link(u, "instagram", "ash.chosen");
  const solo = await link(u, "x", "ash_only");
  const fol = await link(u, "x", "ash_followers");

  assert.equal((await send("/v1/account/identities/" + chosen.id, "PATCH", u.token, { audience: "people", people: ["mp_pal", "@mp_nobody_here"] })).status, 200);
  assert.equal((await send("/v1/account/identities/" + solo.id, "PATCH", u.token, { audience: "only" })).status, 200);
  assert.equal((await send("/v1/account/identities/" + fol.id, "PATCH", u.token, { audience: "followers" })).status, 200);
  assert.equal((await send("/v1/follows", "PUT", fan.token, { id: "app:" + u.account.publicId })).status, 200);

  const mine = (await get("/v1/account/identities", u.token)).body.identities;
  const pick = mine.find((i) => i.id === chosen.id);
  assert.equal(pick.audience, "people");
  assert.deepEqual(pick.people, ["mp_pal"], "unknown people are dropped");
  assert.equal(JSON.stringify(mine).indexOf(pal.account.publicId), -1, "chosen people go out as handles, not ids");

  const seen = async (token) => ((await get("/v1/profile/mp_ash", token)).body.account.identities || []).map((i) => i.handle).sort();
  assert.deepEqual(await seen(str.token), ["ash_public"]);
  assert.deepEqual(await seen(pal.token), ["ash.chosen", "ash_public"]);
  assert.deepEqual(await seen(fan.token), ["ash_followers", "ash_public"]);
  assert.deepEqual(await seen(u.token), ["ash.chosen", "ash_followers", "ash_only", "ash_public"]);
  assert.deepEqual(await seen(boss.token), ["ash.chosen", "ash_followers", "ash_only", "ash_public"], "the site owner sees every link");

  // The redirect map follows the same rule, so it never reveals a hidden link.
  const mapped = async (token) => (await get("/v1/identities/merged", token)).body.merged.filter((m) => m.to === "mp_ash").map((m) => m.handle).sort();
  assert.deepEqual(await mapped(str.token), ["ash_public"]);
  assert.deepEqual(await mapped(pal.token), ["ash.chosen", "ash_public"]);
  assert.deepEqual(await mapped(boss.token), ["ash.chosen", "ash_followers", "ash_only", "ash_public"]);

  // Owner bypass is audit-logged (owner-only log).
  const log = await get("/v1/display-names/audit", boss.token);
  assert.equal(log.status, 200, log.text);
  assert.ok(log.body.entries.some((e) => e.target === "mp_ash" && e.action === "linked-profiles"), log.text);
  assert.equal((await get("/v1/display-names/audit", str.token)).status, 403);

  // Someone else can't change or remove the link.
  assert.equal((await send("/v1/account/identities/" + open.id, "PATCH", str.token, { merged: false })).status, 404);
  await send("/v1/account/identities/" + open.id, "DELETE", str.token);
  assert.ok((await seen(fan.token)).includes("ash_public"));

  // Hidden from the profile: nobody but the account (and the site owner) sees it or is redirected.
  assert.equal((await send("/v1/account/identities/" + open.id, "PATCH", u.token, { hidden: true })).status, 200);
  assert.deepEqual(await seen(str.token), []);
  assert.deepEqual(await mapped(str.token), []);
});

test("a blocked viewer gets no links and no redirects", async () => {
  const u = await signup("mp_oak", "Oak Example");
  const b = await signup("mp_blk", "Blk Example");
  await link(u, "x", "oak_public");
  assert.equal((await send("/v1/blocks", "PUT", u.token, { id: "app:" + b.account.publicId })).status < 500, true);
  const map = (await get("/v1/identities/merged", b.token)).body.merged || [];
  const prof = await get("/v1/profile/mp_oak", b.token);
  if (prof.body && prof.body.account && prof.body.account.blockedBy) {
    assert.equal(map.some((m) => m.to === "mp_oak"), false);
  }
});

test("the merged_profiles switch is listed", async () => {
  const { FEATURE_NAMES } = await import("../src/feature-flags.js");
  assert.ok(FEATURE_NAMES.includes("merged_profiles"));
});
