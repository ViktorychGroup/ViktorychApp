import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { notificationSelfTest, notifyLiveStarted, scrubNoteHash } from "../src/notifications.js";

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
    durableObjects: {
      ACCOUNT_CHANNEL: { className: "AccountChannel", useSQLite: true }
    },
    bindings: {
      ACCOUNT_PEPPER: "pepper-test",
      OWNER_CLAIM_CODE: "claim-test",
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000",
      PUSH_SINK: "d1"
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

async function signup(ip, handle, name) {
  const created = await call("/v1/signup", {
    method: "POST",
    ip,
    body: { displayName: name, handle }
  });
  if (created.status !== 201 || !created.body || !created.body.token || !created.body.account) throw new Error("signup failed");
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

test.before(async () => {
  mf = new Miniflare(workerOptions());
});

test.after(async () => {
  if (mf) await mf.dispose();
});

test("merge, cursor, and push round trip", async () => {
  await notificationSelfTest();
});

test("two devices share notes, read state, and the account channel", async () => {
  const ada = await signup("203.0.113.40", "ada_note", "Ada Note");
  const bea = await signup("203.0.113.41", "bea_note", "Bea Note");
  const second = await call("/v1/login", {
    method: "POST",
    ip: "203.0.113.42",
    body: { accountNumber: ada.accountNumber }
  });
  if (second.status !== 200 || !second.body || !second.body.token) throw new Error("second device failed");
  const other = second.body.token;

  const followed = await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.43",
    token: ada.token,
    body: { id: "app:" + bea.account.publicId }
  });
  assert.equal(followed.status, 200);
  const followedAgain = await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.44",
    token: ada.token,
    body: { id: "app:" + bea.account.publicId }
  });
  assert.equal(followedAgain.status, 200);
  const follows = await one("SELECT COUNT(*) AS n FROM notifications WHERE public_id = ? AND kind = 'follow'", bea.account.publicId);
  assert.equal(Number(follows.n), 1);

  const keys = await pushKeys();
  const sub = await call("/v1/push/subscribe", {
    method: "PUT",
    ip: "203.0.113.45",
    token: ada.token,
    body: { endpoint: "https://push.example/ada-phone", keys, expirationTime: 0 }
  });
  assert.equal(sub.status, 200);
  const keysB = await pushKeys();
  const subB = await call("/v1/push/subscribe", {
    method: "PUT",
    ip: "203.0.113.46",
    token: other,
    body: { endpoint: "https://push.example/ada-desk", keys: keysB, expirationTime: 0, fmt: 2 }
  });
  assert.equal(subB.status, 200);
  const fmts = await one("SELECT SUM(CASE WHEN push_fmt = 2 THEN 1 ELSE 0 END) AS compact, COUNT(*) AS n FROM push_subscriptions WHERE public_id = ?", ada.account.publicId);
  assert.equal(Number(fmts.n), 2);
  assert.equal(Number(fmts.compact), 1);

  const item = { id: "post:cross-device", kind: "post", at: 1700000000000, text: "hello", handle: "ada", name: "Ada" };
  const first = await call("/v1/notifications", {
    method: "POST",
    ip: "203.0.113.47",
    token: ada.token,
    body: { items: [item] }
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.items.length, 1);
  assert.equal(first.body.unread, 1);
  const duplicate = await call("/v1/notifications", {
    method: "POST",
    ip: "203.0.113.48",
    token: ada.token,
    body: { items: [item] }
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.items.length, 1);
  const pushed = await one("SELECT COUNT(*) AS n FROM push_log WHERE public_id = ? AND note_id = ?", ada.account.publicId, "post:cross-device");
  assert.equal(Number(pushed.n), 2);

  const seen = await call("/v1/notifications", { ip: "203.0.113.49", token: other });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.items[0].id, "post:cross-device");
  assert.equal(seen.body.unread, 1);

  const ticket = await call("/v1/channel/ticket", { method: "POST", ip: "203.0.113.50", token: ada.token });
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
  ws.send(JSON.stringify({ op: "subscribe", topics: ["notifications", "presence"] }));
  ws.send(JSON.stringify({ op: "event", topic: "notifications", data: { type: "forged", unread: 9 } }));
  await waitFor(() => messages.some((msg) => msg.op === "ready" && msg.publicId === ada.account.publicId));
  await waitFor(() => messages.some((msg) => msg.op === "ok" && msg.for === "subscribe" && (msg.topics || []).indexOf("notifications") >= 0 && (msg.topics || []).indexOf("presence") >= 0));

  const read = await call("/v1/notifications/read", {
    method: "POST",
    ip: "203.0.113.51",
    token: other,
    body: { until: 1700000000000, ids: ["post:cross-device"] }
  });
  assert.equal(read.status, 200);
  assert.equal(read.body.unread, 0);
  await waitFor(() => messages.some((msg) => msg.op === "event" && msg.data && msg.data.type === "read" && msg.data.unread === 0));
  assert.equal(messages.some((msg) => msg.data && msg.data.type === "forged"), false);

  const cleared = await call("/v1/notifications", { ip: "203.0.113.52", token: ada.token });
  assert.equal(cleared.body.unread, 0);
  assert.equal(cleared.body.items[0].read, true);
  ws.close();

  const dropped = await call("/v1/push/subscribe", {
    method: "DELETE",
    ip: "203.0.113.53",
    token: ada.token,
    body: { endpoint: "https://push.example/ada-phone" }
  });
  assert.equal(dropped.status, 200);
  const left = await one("SELECT COUNT(*) AS n FROM push_subscriptions WHERE public_id = ?", ada.account.publicId);
  assert.equal(Number(left.n), 1);

  const watched = await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.54",
    token: ada.token,
    body: { id: "youtube:liveuser" }
  });
  assert.equal(watched.status, 200);
  const env = await mf.getBindings();
  await notifyLiveStarted(env, { handle: "liveuser", platform: "youtube", roomId: "room-1", at: Date.now(), title: "On air" });
  await notifyLiveStarted(env, { handle: "liveuser", platform: "youtube", roomId: "room-1", at: Date.now(), title: "On air" });
  const lives = await one("SELECT COUNT(*) AS n FROM notifications WHERE public_id = ? AND kind = 'live'", ada.account.publicId);
  assert.equal(Number(lives.n), 1);

  const once = await call("/v1/channel/ticket", { method: "POST", ip: "203.0.113.55", token: bea.token });
  if (once.status !== 200 || !once.body || !once.body.ticket) throw new Error("ticket failed");
  const used = await mf.dispatchFetch("https://accounts.test/v1/channel?ticket=" + encodeURIComponent(once.body.ticket), {
    headers: { Upgrade: "websocket", Connection: "Upgrade" }
  });
  assert.equal(used.status, 101);
  if (used.webSocket) used.webSocket.accept();
  const reused = await mf.dispatchFetch("https://accounts.test/v1/channel?ticket=" + encodeURIComponent(once.body.ticket), {
    headers: { Upgrade: "websocket", Connection: "Upgrade" }
  });
  assert.equal(reused.status, 401);

  const expiring = await call("/v1/channel/ticket", { method: "POST", ip: "203.0.113.56", token: bea.token });
  if (expiring.status !== 200 || !expiring.body || !expiring.body.ticket) throw new Error("ticket failed");
  await one("UPDATE channel_tickets SET expires_at = 1 WHERE public_id = ?", bea.account.publicId);
  const expired = await mf.dispatchFetch("https://accounts.test/v1/channel?ticket=" + encodeURIComponent(expiring.body.ticket), {
    headers: { Upgrade: "websocket", Connection: "Upgrade" }
  });
  assert.equal(expired.status, 401);

  const gone = await call("/v1/logout-all", { method: "POST", ip: "203.0.113.57", token: other });
  assert.equal(gone.status, 200);
  const none = await one("SELECT COUNT(*) AS n FROM push_subscriptions WHERE public_id = ?", ada.account.publicId);
  assert.equal(Number(none.n), 0);
  const sessions = await one("SELECT COUNT(*) AS n FROM sessions WHERE public_id = ?", ada.account.publicId);
  assert.equal(Number(sessions.n), 0);
});

test("notification tabs sync across two devices, merge per tab, and have no count cap", async () => {
  const me = await signup("203.0.113.80", "tab_sync", "Tab Sync");
  const second = await call("/v1/login", { method: "POST", ip: "203.0.113.81", body: { accountNumber: me.accountNumber } });
  if (second.status !== 200 || !second.body || !second.body.token) throw new Error("second device failed");
  const phone = me.token;
  const desk = second.body.token;
  const t0 = 1700000000000;
  const legacy = { id: "legacy", name: "Old tab", members: ["x:someone"], updatedAt: t0 - 5 };
  /* An account that saved tabs before per-tab rows keeps them. */
  await one("INSERT INTO notification_state (public_id, read_until, tabs, bells_at, updated_at) VALUES (?, 0, ?, 0, ?) ON CONFLICT(public_id) DO UPDATE SET tabs = excluded.tabs", me.account.publicId, JSON.stringify({ tabs: [legacy], noteTabsSame: false, lastNoteTab: "all" }), t0);
  const a = await call("/v1/notifications", {
    method: "POST", ip: "203.0.113.82", token: phone,
    body: { tabs: [
      { id: "games", name: "games", kind: "games", pos: 0, updatedAt: t0 },
      { id: "friends", name: "Friends", types: ["friend_request", "follow"], push: true, sound: false, pos: 1, updatedAt: t0 },
      { id: "work", name: "Work", members: ["x:a"], pos: 2, updatedAt: t0 }
    ], noteTabsSame: false }
  });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.tabs.map((tab) => tab.id).sort(), ["friends", "games", "legacy", "work"]);
  /* The desk renames Friends and adds a tab; the phone, offline, still has
     the old Friends and deletes Work. Neither wipes the other. */
  const b = await call("/v1/notifications", {
    method: "POST", ip: "203.0.113.83", token: desk,
    body: { tabs: [
      { id: "friends", name: "Pals", types: ["friend_request", "follow", "game_invite"], push: false, sound: false, pos: 1, updatedAt: t0 + 10 },
      { id: "deskonly", name: "Desk", types: ["dm"], pos: 3, updatedAt: t0 + 11 }
    ] }
  });
  assert.equal(b.status, 200);
  const c = await call("/v1/notifications", {
    method: "POST", ip: "203.0.113.84", token: phone,
    body: { tabs: [
      { id: "friends", name: "Friends", types: ["friend_request", "follow"], push: true, pos: 1, updatedAt: t0 + 1 },
      { id: "work", name: "Work", members: ["x:a"], pos: 2, updatedAt: t0 + 12, deletedAt: t0 + 12 }
    ] }
  });
  assert.equal(c.status, 200);
  for (const token of [phone, desk]) {
    const view = await call("/v1/notifications", { ip: "203.0.113.85", token });
    assert.equal(view.status, 200);
    const byId = {};
    view.body.tabs.forEach((tab) => { byId[tab.id] = tab; });
    assert.equal(byId.friends.name, "Pals");
    assert.deepEqual(byId.friends.types, ["friend_request", "follow", "game_invite"]);
    assert.equal(byId.friends.push, false);
    assert.equal(byId.deskonly.name, "Desk");
    assert.ok(byId.work.deletedAt >= t0 + 12);
    assert.equal(byId.legacy.name, "Old tab");
    assert.equal(byId.games.kind, "games");
    assert.equal(view.body.noteTabsSame, false);
    assert.deepEqual(view.body.tabs.slice(0, 2).map((tab) => tab.id), ["games", "friends"]);
  }
  const rows = await one("SELECT COUNT(*) AS n FROM notification_tabs WHERE public_id = ?", me.account.publicId);
  assert.equal(Number(rows.n), 5);
  /* No cap: 700 tabs in one save all come back. */
  const many = [];
  for (let i = 0; i < 700; i++) many.push({ id: "bulk" + i, name: "Tab " + i, types: ["like"], pos: 10 + i, updatedAt: t0 + 100 + i });
  const big = await call("/v1/notifications", { method: "POST", ip: "203.0.113.86", token: desk, body: { tabs: many } });
  assert.equal(big.status, 200);
  const after = await call("/v1/notifications", { ip: "203.0.113.87", token: phone });
  assert.equal(after.body.tabs.length, 705);
});

test("notification links drop account IDs but keep invite and pairing tokens whole", () => {
  // A game invite id can end in 12 digits by chance; cutting it broke the link.
  assert.equal(scrubNoteHash("#/games/regone?invite=3681e391a79b790448272536"), "#/games/regone?invite=3681e391a79b790448272536");
  assert.equal(scrubNoteHash("#/link-tv?code=ab000000000000"), "#/link-tv?code=ab000000000000");
  assert.equal(scrubNoteHash("#/live/x100000000001"), "#/live/x100000000001");
  // Account IDs in the path or in other parameters are still cut.
  assert.equal(scrubNoteHash("#/post/p100000000001"), "#/post/p");
  assert.equal(scrubNoteHash("#/games/regone?invite=abc&from=u100000000001"), "#/games/regone?invite=abc&from=u");
  assert.equal(scrubNoteHash("#/communities/c100000000001?invite=k200000000002"), "#/communities/c?invite=k200000000002");
  assert.equal(scrubNoteHash(""), "");
  assert.equal(scrubNoteHash("#/messages"), "#/messages");
});
