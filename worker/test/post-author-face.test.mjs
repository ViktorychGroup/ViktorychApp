import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

let mf;
let seq = 0;

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
      OWNER_HANDLE: "vis_owner",
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000"
    }
  };
}

function tinyWebp(mark) {
  const raw = atob("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=");
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] + mark) & 255;
  return bytes;
}

function dataUrl(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return "data:image/webp;base64," + btoa(bin);
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
  return { status: res.status, body, text, headers: res.headers };
}

async function signup(handle, extra) {
  seq += 1;
  const created = await call("/v1/signup", {
    method: "POST",
    ip: "203.0.113." + (40 + (seq % 200)),
    body: Object.assign({ displayName: "Visitor " + seq, handle }, extra || {})
  });
  assert.equal(created.status, 201, created.text);
  return created.body;
}

function leaksId(text, id) {
  return text.indexOf(id) >= 0 || text.indexOf("/v1/media/avatars/" + id + "/") >= 0 || text.indexOf("/v1/media/banners/" + id + "/") >= 0;
}

test.before(async () => {
  mf = new Miniflare(workerOptions());
});

test.after(async () => {
  if (mf) await mf.dispose();
});

test("in-app post authors carry a loadable face, the lock and the official badge", async () => {
  const boss = await signup("vis_owner", { claimCode: "claim-test" });
  const author = await signup("face_author");
  const stranger = await signup("face_stranger");
  assert.equal(boss.account.owner, true);

  const up = await call("/v1/profile/media", { method: "POST", ip: "203.0.113.70", token: author.token, body: { kind: "photo", image: dataUrl(tinyWebp(5)) } });
  assert.equal(up.status, 200, up.text);
  const photoId = up.body.account.photos[0].id;
  const made = await call("/v1/posts", { method: "POST", ip: "203.0.113.71", token: author.token, body: { body: "face check" } });
  assert.ok(made.status === 200 || made.status === 201, made.text);
  const bossPost = await call("/v1/posts", { method: "POST", ip: "203.0.113.72", token: boss.token, body: { body: "from the owner" } });
  assert.ok(bossPost.status === 200 || bossPost.status === 201, bossPost.text);

  async function authorPost(viewer, ip, who) {
    const res = await call("/v1/posts?by=" + who.account.publicId, { ip, token: viewer.token });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text.indexOf("/v1/media/avatars/"), -1, "no storage key in posts");
    assert.equal(res.text.indexOf("media/avatars/"), -1, "no storage key in posts");
    const post = (res.body.posts || res.body.items || []).find((item) => item.authorHandle === who.account.handle);
    assert.ok(post, "post listed");
    return post;
  }

  let seen = await authorPost(stranger, "203.0.113.73", author);
  assert.match(seen.authorAvatar, /\/v1\/media\/view\/[a-f0-9]{32}$/);
  assert.equal(seen.authorLocked, false);
  assert.equal(seen.authorOfficial, false);
  const bytes = await call(new URL(seen.authorAvatar, "https://accounts.test").pathname, { ip: "203.0.113.74", token: stranger.token });
  assert.equal(bytes.status, 200);

  const hide = await call("/v1/profile/media", { method: "PATCH", ip: "203.0.113.75", token: author.token, body: { id: photoId, visibility: "nobody", main: true } });
  assert.equal(hide.status, 200, hide.text);
  const lock = await call("/v1/profile", { method: "PATCH", ip: "203.0.113.76", token: author.token, body: { privateFollows: true } });
  assert.equal(lock.status, 200, lock.text);

  seen = await authorPost(stranger, "203.0.113.77", author);
  assert.equal(seen.authorAvatar, "");
  assert.equal(seen.authorLocked, true);

  // The site owner sees every profile picture, whatever its audience.
  const asBoss = await authorPost(boss, "203.0.113.78", author);
  assert.match(asBoss.authorAvatar, /\/v1\/media\/view\//);
  assert.equal(asBoss.authorLocked, true);
  const bossBytes = await call(new URL(asBoss.authorAvatar, "https://accounts.test").pathname, { ip: "203.0.113.79", token: boss.token });
  assert.equal(bossBytes.status, 200);
  const strangerBytes = await call(new URL(asBoss.authorAvatar, "https://accounts.test").pathname, { ip: "203.0.113.80", token: stranger.token });
  assert.notEqual(strangerBytes.status, 200);

  const official = await authorPost(stranger, "203.0.113.81", boss);
  assert.equal(official.authorOfficial, true);
});
