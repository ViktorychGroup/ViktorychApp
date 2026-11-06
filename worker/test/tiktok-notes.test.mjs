import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { notifyLiveStarted } from "../src/notifications.js";

const OWNER = "ownerlock";
const READER = "readerlock";

let mf;
const pushes = [];
let failOpenOnce = true;

function workerOptions() {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    durableObjects: {
      ACCOUNT_CHANNEL: { className: "AccountChannel", useSQLite: true }
    },
    bindings: {
      ACCOUNT_PEPPER: "pepper-test",
      OWNER_CLAIM_CODE: "claim-test",
      OWNER_HANDLE: OWNER,
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000",
      PUSH_SINK: "d1"
    },
    async outboundService(request) {
      const url = new URL(request.url);
      if (url.hostname !== "push.example") return new Response("no", { status: 404 });
      pushes.push(url.pathname);
      if (failOpenOnce && url.pathname === "/device-open") {
        failOpenOnce = false;
        return new Response("down", { status: 500 });
      }
      return new Response("ok", { status: 201 });
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
  catch (err) { body = { raw: true }; }
  return { status: res.status, body };
}

async function one(sql, ...args) {
  const bindings = await mf.getBindings();
  let query = bindings.DB.prepare(sql);
  if (args.length) query = query.bind(...args);
  return query.first();
}

async function signup(ip, handle, name, claim) {
  const body = { displayName: name, handle: handle };
  if (claim) body.claimCode = claim;
  const created = await call("/v1/signup", { method: "POST", ip: ip, body: body });
  if (created.status !== 201 || !created.body || !created.body.token) throw new Error("signup failed");
  return created.body;
}

function b64url(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function pushKeys() {
  const key = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
  return { p256dh: b64url(raw), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) };
}

function waitFor(check) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve(); }
      else if (Date.now() - start > 4000) { clearInterval(timer); reject(new Error("timed out")); }
    }, 20);
  });
}

function hasId(view, id) {
  return !!(view && Array.isArray(view.items) && view.items.some((item) => item && item.id === id));
}

function channelHasTiktok(list) {
  return list.some((msg) => {
    const items = msg && msg.data && msg.data.items;
    return Array.isArray(items) && items.some((item) => item && item.platform === "tiktok");
  });
}

test.before(async () => {
  mf = new Miniflare(workerOptions());
});

test.after(async () => {
  if (mf) await mf.dispose();
});

test("locked account notifications stay hidden until the account is unlocked", async () => {
  const owner = await signup("203.0.113.80", OWNER, "Owner", "claim-test");
  const reader = await signup("203.0.113.81", READER, "Reader");
  const lockedKeys = await pushKeys();
  const openKeys = await pushKeys();
  const lockedSub = await call("/v1/push/subscribe", {
    method: "PUT",
    ip: "203.0.113.82",
    token: owner.token,
    body: { endpoint: "https://push.example/device-locked", keys: lockedKeys, expirationTime: 0 }
  });
  assert.equal(lockedSub.status, 200);
  const openSub = await call("/v1/push/subscribe", {
    method: "PUT",
    ip: "203.0.113.83",
    token: owner.token,
    body: { endpoint: "https://push.example/device-open", keys: openKeys, expirationTime: 0, locked: 0 }
  });
  assert.equal(openSub.status, 200);

  const ticket = await call("/v1/channel/ticket", { method: "POST", ip: "203.0.113.84", token: owner.token });
  if (ticket.status !== 200 || !ticket.body || !ticket.body.ticket) throw new Error("ticket failed");
  const opened = await mf.dispatchFetch("https://accounts.test/v1/channel?ticket=" + encodeURIComponent(ticket.body.ticket), {
    headers: { Upgrade: "websocket", Connection: "Upgrade" }
  });
  assert.equal(opened.status, 101);
  const ws = opened.webSocket;
  assert.ok(ws);
  ws.accept();
  const messages = [];
  ws.addEventListener("message", (event) => {
    try { messages.push(JSON.parse(String(event.data))); }
    catch (err) { messages.push({ op: "bad" }); }
  });
  ws.send(JSON.stringify({ op: "subscribe", topics: ["notifications"] }));
  await waitFor(() => messages.some((msg) => msg.op === "ok"));

  const lockedId = "post:locked-row";
  const plainId = "post:plain-row";
  const posted = await call("/v1/notifications", {
    method: "POST",
    ip: "203.0.113.85",
    token: owner.token,
    body: {
      shortsLocked: 1,
      items: [
        { id: lockedId, kind: "post", at: 1700000001000, text: "hidden row", handle: "lockedacct", name: "Locked", platform: "tiktok", feedId: "tiktok:lockedacct", hash: "#/tiktok/lockedacct" },
        { id: plainId, kind: "post", at: 1700000002000, text: "hello", handle: "readerlock", name: "Reader", platform: "x", feedId: "x:readerlock", hash: "#/readerlock" }
      ]
    }
  });
  assert.equal(posted.status, 200);
  assert.equal(hasId(posted.body, lockedId), false);
  assert.equal(hasId(posted.body, plainId), true);
  assert.equal(posted.body.unread, 1);
  const lockedPushes = await one("SELECT COUNT(*) AS n FROM push_log WHERE public_id = ? AND note_id = ?", owner.account.publicId, lockedId);
  const plainPushes = await one("SELECT COUNT(*) AS n FROM push_log WHERE public_id = ? AND note_id = ?", owner.account.publicId, plainId);
  assert.equal(Number(lockedPushes.n), 1);
  assert.equal(Number(plainPushes.n), 2);
  await waitFor(() => messages.some((msg) => msg.op === "event" && msg.data && msg.data.type === "upsert"));
  assert.equal(channelHasTiktok(messages), false);

  const readerKeys = await pushKeys();
  const readerSub = await call("/v1/push/subscribe", {
    method: "PUT",
    ip: "203.0.113.86",
    token: reader.token,
    body: { endpoint: "https://push.example/device-reader", keys: readerKeys, expirationTime: 0, locked: 0 }
  });
  assert.equal(readerSub.status, 200);
  const readerId = "post:reader-row";
  const readerPost = await call("/v1/notifications", {
    method: "POST",
    ip: "203.0.113.87",
    token: reader.token,
    body: {
      shortsLocked: 0,
      items: [{ id: readerId, kind: "post", at: 1700000003000, text: "not yours", handle: "openacct", name: "Open", platform: "tiktok", feedId: "tiktok:openacct", hash: "#/tiktok/openacct" }]
    }
  });
  assert.equal(readerPost.status, 200);
  assert.equal(hasId(readerPost.body, readerId), false);
  assert.equal(readerPost.body.unread, 0);
  const readerPushes = await one("SELECT COUNT(*) AS n FROM push_log WHERE public_id = ? AND note_id = ?", reader.account.publicId, readerId);
  assert.equal(Number(readerPushes.n), 0);

  const unlockedView = await call("/v1/notifications?locked=0", { ip: "203.0.113.88", token: owner.token });
  assert.equal(hasId(unlockedView.body, lockedId), true);
  const lockedAgain = await call("/v1/notifications?locked=1", { ip: "203.0.113.89", token: owner.token });
  assert.equal(hasId(lockedAgain.body, lockedId), false);
  assert.equal(lockedAgain.body.unread, 1);

  const env = await mf.getBindings();
  await env.DATA.put("owner/tiktok-unlocked.json", JSON.stringify({ handles: ["lockedacct", "openacct"] }));
  const shown = await call("/v1/notifications?locked=1", { ip: "203.0.113.90", token: owner.token });
  assert.equal(hasId(shown.body, lockedId), true);
  const stillOne = await one("SELECT COUNT(*) AS n FROM push_log WHERE public_id = ? AND note_id = ?", owner.account.publicId, lockedId);
  assert.equal(Number(stillOne.n), 1);
  // The open device's first push failed. After the backoff the outbox retries
  // that device only. The locked device, which hid this note, is not added
  // when the account is unlocked.
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const drained = await call("/v1/notifications?locked=1", { ip: "203.0.113.94", token: owner.token });
  assert.equal(hasId(drained.body, lockedId), true);
  assert.equal(pushes.filter((path) => path === "/device-locked").length, 1);
  assert.equal(pushes.filter((path) => path === "/device-open").length, 3);
  const retried = await one("SELECT COUNT(*) AS n FROM push_log WHERE public_id = ? AND note_id = ?", owner.account.publicId, lockedId);
  assert.equal(Number(retried.n), 2);
  const readerStill = await call("/v1/notifications?locked=0", { ip: "203.0.113.91", token: reader.token });
  assert.equal(hasId(readerStill.body, readerId), false);

  const freshId = "post:after-unlock";
  const fresh = await call("/v1/notifications", {
    method: "POST",
    ip: "203.0.113.92",
    token: owner.token,
    body: {
      shortsLocked: 1,
      items: [{ id: freshId, kind: "post", at: 1700000004000, text: "new row", handle: "lockedacct", name: "Locked", platform: "tiktok", feedId: "tiktok:lockedacct", hash: "#/tiktok/lockedacct" }]
    }
  });
  assert.equal(hasId(fresh.body, freshId), true);
  const freshPushes = await one("SELECT COUNT(*) AS n FROM push_log WHERE public_id = ? AND note_id = ?", owner.account.publicId, freshId);
  assert.equal(Number(freshPushes.n), 2);
  await waitFor(() => channelHasTiktok(messages));

  await notifyLiveStarted(env, { handle: "lockedacct", platform: "tiktok", roomId: "room-locked", at: 1700000005000, title: "Started" });
  const liveId = "live:tiktok:lockedacct:room-locked";
  const afterLive = await call("/v1/notifications?locked=1", { ip: "203.0.113.93", token: owner.token });
  assert.equal(hasId(afterLive.body, liveId), true);
  const livePushes = await one("SELECT COUNT(*) AS n FROM push_log WHERE note_id = ?", liveId);
  assert.equal(Number(livePushes.n), 2);

  ws.close();
});
