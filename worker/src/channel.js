/* Generic per-account hibernating WebSocket channel.
   Binding ACCOUNT_CHANNEL, class AccountChannel. One object per account:
   env.ACCOUNT_CHANNEL.idFromName(publicId). ctx.id.name is that account id.

   Client to server:
     { op:"subscribe", topics:["presence","notifications"] }
     { op:"unsubscribe", topics:["notifications"] }
     { op:"watch", topic:"presence", ids:["<12-digit>", ...] }
     { op:"unwatch", topic:"presence", ids:["<12-digit>"] }
   Server to client:
     { op:"ready", publicId }
     { op:"ok", for:"subscribe"|"watch"|"unwatch", topics?, topic?, ids? }
     { op:"event", topic, id, data }

   Topics match /^[a-z][a-z0-9_-]{0,31}$/, at most 8 per socket.
   Watch ids are 12-digit account ids, at most 30 per topic per socket.
   The platform answers a WebSocket "ping" with "pong" and does not wake
   the object. The page connects only while it is visible.

   publishToAccount(env, publicId, topic, data, subjectId) wakes that
   account's object and sends the event to its own sockets. It does not
   fan out to watchers. Presence uses listWatchers and deliverToAccount
   so each watcher gets a payload already filtered for them. A notifications
   caller can publishToAccount(env, publicId, "notifications", data) for
   that account's devices and does not need a second Durable Object class.

   Internal stub routes, not public worker routes:
     POST https://channel.internal/publish
     POST https://channel.internal/deliver
     GET  https://channel.internal/watchers?topic=
     POST https://channel.internal/watchers/add
     POST https://channel.internal/watchers/remove
     POST https://channel.internal/wipe */

import { isAccountId } from "../../shared/presence.js";
import { acceptedUnlockedFollow } from "./social.js";
import { readFlags } from "./feature-flags.js";
import { isSwarmName, swarmFetch, swarmMessage, swarmClose } from "./media-swarm.js";
import { isLiveName, liveFetch, liveMessage, liveClose } from "./live.js";
import { isPoolName, poolFetch, poolMessage, poolClose } from "./peer-pool.js";
import { isSrvName, srvFetch, srvMessage, srvClose } from "./servers-room.js";

const TOPIC_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const TOPIC_LIMIT = 8;
const WATCH_LIMIT = 30;
const WATCHER_CAP = 40;
const encoder = new TextEncoder();

export const CHANNEL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS channel_tickets (
    token_hash TEXT PRIMARY KEY,
    public_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS channel_tickets_account ON channel_tickets(public_id)",
  "CREATE INDEX IF NOT EXISTS channel_tickets_expires ON channel_tickets(expires_at)"
];

function rows(result) {
  return (result && result.results) || [];
}

function hex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function b64url(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return hex(new Uint8Array(digest));
}

function cleanTopic(value) {
  const text = String(value || "");
  return TOPIC_RE.test(text) ? text : "";
}

function cleanTopics(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (let i = 0; i < list.length && out.length < TOPIC_LIMIT; i++) {
    const topic = cleanTopic(list[i]);
    if (topic && out.indexOf(topic) < 0) out.push(topic);
  }
  return out;
}

function cleanIds(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (let i = 0; i < list.length && out.length < WATCH_LIMIT; i++) {
    const id = String(list[i] || "");
    if (isAccountId(id) && out.indexOf(id) < 0) out.push(id);
  }
  return out;
}

function stubFor(env, publicId) {
  if (!env || !env.ACCOUNT_CHANNEL || !isAccountId(publicId)) return null;
  return env.ACCOUNT_CHANNEL.get(env.ACCOUNT_CHANNEL.idFromName(publicId));
}

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text || text.length > 8000) return {};
    const body = JSON.parse(text);
    return body && typeof body === "object" ? body : {};
  } catch (err) {
    return {};
  }
}

function accountName(ctx) {
  try { return (ctx.id && ctx.id.name) || ""; }
  catch (err) { return ""; }
}

export class AccountChannel {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    try {
      if (ctx.setWebSocketAutoResponse && typeof WebSocketRequestResponsePair !== "undefined") {
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
      }
    } catch (err) { /* hibernation still accepts the socket */ }
  }

  async fetch(request) {
    if (isLiveName(accountName(this.ctx))) return liveFetch(this, request);
    if (isSwarmName(accountName(this.ctx))) return swarmFetch(this, request);
    if (isPoolName(accountName(this.ctx))) return poolFetch(this, request);
    if (isSrvName(accountName(this.ctx))) return srvFetch(this, request);
    const url = new URL(request.url);
    if (url.hostname === "channel.internal") return this.internal(request, url);
    const upgrade = String(request.headers.get("Upgrade") || "");
    if (upgrade.toLowerCase() === "websocket") return this.accept(request);
    return new Response("not found", { status: 404 });
  }

  accept(request) {
    const name = accountName(this.ctx) || request.headers.get("x-account-id") || "";
    if (!isAccountId(name)) return new Response("account", { status: 403 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ topics: [], watches: {} });
    server.send(JSON.stringify({ op: "ready", publicId: name }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (isLiveName(accountName(this.ctx))) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      return liveMessage(this, ws, text);
    }
    if (isSwarmName(accountName(this.ctx))) return swarmMessage(this, ws, message);
    if (isPoolName(accountName(this.ctx))) return poolMessage(this, ws, typeof message === "string" ? message : "");
    if (isSrvName(accountName(this.ctx))) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      return srvMessage(this, ws, text);
    }
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (!text || text.length > 4000) return;
    let msg = null;
    try { msg = JSON.parse(text); }
    catch (err) { return; }
    if (!msg || typeof msg !== "object") return;
    const att = ws.deserializeAttachment() || { topics: [], watches: {} };
    if (!att.watches || typeof att.watches !== "object") att.watches = {};
    if (!Array.isArray(att.topics)) att.topics = [];
    if (msg.op === "subscribe") {
      att.topics = cleanTopics(msg.topics);
      ws.serializeAttachment(att);
      try { ws.send(JSON.stringify({ op: "ok", for: "subscribe", topics: att.topics })); }
      catch (err) { /* the socket can close while we answer */ }
      return;
    }
    if (msg.op === "unsubscribe") {
      const drop = new Set(cleanTopics(msg.topics));
      att.topics = att.topics.filter((topic) => !drop.has(topic));
      ws.serializeAttachment(att);
      try { ws.send(JSON.stringify({ op: "ok", for: "unsubscribe", topics: att.topics })); }
      catch (err) { /* the socket can close while we answer */ }
      return;
    }
    if (msg.op === "watch" || msg.op === "unwatch") return this.changeWatch(ws, att, msg);
  }

  async webSocketClose(ws) {
    if (isLiveName(accountName(this.ctx))) {
      liveClose(this, ws);
      return;
    }
    if (isSwarmName(accountName(this.ctx))) {
      swarmClose(this, ws);
      return;
    }
    if (isPoolName(accountName(this.ctx))) {
      poolClose(this, ws);
      return;
    }
    if (isSrvName(accountName(this.ctx))) {
      srvClose(this, ws);
      return;
    }
    let att = { watches: {} };
    try { att = ws.deserializeAttachment() || att; }
    catch (err) { att = { watches: {} }; }
    await this.release(ws, att);
  }

  async webSocketError(ws) {
    try { ws.close(1011, "error"); }
    catch (err) { /* already closed */ }
    await this.webSocketClose(ws);
  }

  async changeWatch(ws, att, msg) {
    const topic = cleanTopic(msg.topic);
    if (!topic) return;
    const ids = cleanIds(msg.ids);
    const prev = Array.isArray(att.watches[topic]) ? att.watches[topic] : [];
    let next = ids;
    if (msg.op === "watch" && topic === "posts") {
      let off = {};
      try { off = await readFlags(this.env); }
      catch (err) { off = { home_live: true }; }
      const allowed = [];
      if (!off.home_live) {
        for (let i = 0; i < next.length; i++) {
          if (next[i] === accountName(this.ctx)) continue;
          if (await acceptedUnlockedFollow(this.env, accountName(this.ctx), next[i])) allowed.push(next[i]);
        }
      }
      next = allowed;
    }
    if (msg.op === "unwatch") {
      const drop = new Set(ids);
      next = prev.filter((id) => !drop.has(id));
    }
    const self = accountName(this.ctx);
    const prevSet = new Set(prev);
    const nextSet = new Set(next);
    att.watches[topic] = next;
    if (next.length && att.topics.indexOf(topic) < 0 && att.topics.length < TOPIC_LIMIT) att.topics.push(topic);
    ws.serializeAttachment(att);
    const removed = prev.filter((id) => !nextSet.has(id) && id !== self);
    const added = next.filter((id) => !prevSet.has(id) && id !== self);
    const still = this.unionWatches(topic, null);
    for (let i = 0; i < removed.length; i++) {
      if (still.has(removed[i])) continue;
      await this.touchWatcher(removed[i], topic, "remove");
    }
    for (let i = 0; i < added.length; i++) await this.touchWatcher(added[i], topic, "add");
    try { ws.send(JSON.stringify({ op: "ok", for: msg.op, topic: topic, ids: next })); }
    catch (err) { /* the socket can close while we answer */ }
  }

  unionWatches(topic, except) {
    const set = new Set();
    let sockets = [];
    try { sockets = this.ctx.getWebSockets() || []; }
    catch (err) { sockets = []; }
    for (let i = 0; i < sockets.length; i++) {
      if (sockets[i] === except) continue;
      let att = {};
      try { att = sockets[i].deserializeAttachment() || {}; }
      catch (err) { att = {}; }
      const list = att.watches && att.watches[topic];
      if (!Array.isArray(list)) continue;
      for (let n = 0; n < list.length; n++) set.add(list[n]);
    }
    return set;
  }

  async release(ws, att) {
    const watches = (att && att.watches) || {};
    const topics = Object.keys(watches);
    for (let i = 0; i < topics.length; i++) {
      const topic = topics[i];
      const still = this.unionWatches(topic, ws);
      const ids = Array.isArray(watches[topic]) ? watches[topic] : [];
      const self = accountName(this.ctx);
      for (let n = 0; n < ids.length; n++) {
        if (ids[n] === self || still.has(ids[n])) continue;
        await this.touchWatcher(ids[n], topic, "remove");
      }
    }
  }

  async touchWatcher(subjectId, topic, action) {
    const stub = stubFor(this.env, subjectId);
    if (!stub) return;
    const viewerId = accountName(this.ctx);
    if (!isAccountId(viewerId)) return;
    try {
      await stub.fetch("https://channel.internal/watchers/" + action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: topic, viewerId: viewerId })
      });
    } catch (err) { /* a missing subject object is created on the next event */ }
  }

  async internal(request, url) {
    if (request.method === "GET" && url.pathname === "/watchers") {
      const topic = cleanTopic(url.searchParams.get("topic"));
      const ids = topic ? await this.watchers(topic) : [];
      return Response.json({ ids: ids });
    }
    if (request.method !== "POST") return new Response("method", { status: 405 });
    const body = await readJson(request);
    if (url.pathname === "/publish" || url.pathname === "/deliver") {
      this.sendLocal(cleanTopic(body.topic), body.data, body.id);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/watchers/add") {
      await this.addWatcher(cleanTopic(body.topic), String(body.viewerId || ""));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/watchers/remove") {
      await this.removeWatcher(cleanTopic(body.topic), String(body.viewerId || ""));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/wipe") {
      await this.wipe();
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }

  sendLocal(topic, data, subjectId) {
    if (!topic) return;
    const name = accountName(this.ctx);
    const payload = JSON.stringify({
      op: "event",
      topic: topic,
      id: isAccountId(subjectId) ? String(subjectId) : name,
      data: data && typeof data === "object" ? data : {}
    });
    let sockets = [];
    try { sockets = this.ctx.getWebSockets() || []; }
    catch (err) { sockets = []; }
    for (let i = 0; i < sockets.length; i++) {
      let att = {};
      try { att = sockets[i].deserializeAttachment() || {}; }
      catch (err) { att = {}; }
      const topics = Array.isArray(att.topics) ? att.topics : [];
      if (topics.indexOf(topic) < 0) continue;
      try { sockets[i].send(payload); }
      catch (err) { /* a closing socket is dropped on its close event */ }
    }
  }

  async watchers(topic) {
    const stored = await this.ctx.storage.get("watch:" + topic);
    return Array.isArray(stored) ? stored.filter(isAccountId) : [];
  }

  async addWatcher(topic, viewerId) {
    if (!topic || !isAccountId(viewerId)) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      const key = "watch:" + topic;
      const current = await this.ctx.storage.get(key);
      const list = Array.isArray(current) ? current.filter(isAccountId) : [];
      if (list.indexOf(viewerId) >= 0) return;
      list.push(viewerId);
      await this.ctx.storage.put(key, list.slice(-WATCHER_CAP));
    });
  }

  async removeWatcher(topic, viewerId) {
    if (!topic || !isAccountId(viewerId)) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      const key = "watch:" + topic;
      const current = await this.ctx.storage.get(key);
      const list = Array.isArray(current) ? current.filter((id) => id !== viewerId && isAccountId(id)) : [];
      if (!list.length) await this.ctx.storage.delete(key);
      else await this.ctx.storage.put(key, list);
    });
  }

  async wipe() {
    let sockets = [];
    try { sockets = this.ctx.getWebSockets() || []; }
    catch (err) { sockets = []; }
    for (let i = 0; i < sockets.length; i++) {
      try { sockets[i].close(4000, "deleted"); }
      catch (err) { /* already gone */ }
    }
    await this.ctx.storage.deleteAll();
  }
}

export async function publishToAccount(env, publicId, topic, data, subjectId) {
  const stub = stubFor(env, publicId);
  if (!stub || !cleanTopic(topic)) return;
  await stub.fetch("https://channel.internal/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic: topic, data: data || {}, id: subjectId || publicId })
  });
}

export async function deliverToAccount(env, viewerId, topic, data, subjectId) {
  const stub = stubFor(env, viewerId);
  if (!stub || !cleanTopic(topic)) return;
  await stub.fetch("https://channel.internal/deliver", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic: topic, data: data || {}, id: subjectId || viewerId })
  });
}

export async function listWatchers(env, publicId, topic) {
  const stub = stubFor(env, publicId);
  if (!stub || !cleanTopic(topic)) return [];
  const res = await stub.fetch("https://channel.internal/watchers?topic=" + encodeURIComponent(topic));
  if (!res.ok) return [];
  const body = await res.json();
  return Array.isArray(body.ids) ? body.ids.filter(isAccountId) : [];
}

export async function wipeAccountChannel(env, publicId) {
  const stub = stubFor(env, publicId);
  if (!stub) return;
  await stub.fetch("https://channel.internal/wipe", { method: "POST", body: "{}" });
}

const TICKET_MS = 2 * 60 * 1000;

export async function handleChannel(request, env, url, deps) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/v1/channel/ticket") {
    if (request.method !== "POST") return deps.json(405, { error: "method" });
    const account = await deps.sessionAccount(env, request);
    if (!account) return deps.json(401, { error: "unauthorized" });
    if (!isAccountId(account.public_id)) return deps.json(403, { error: "account" });
    const paced = await deps.rateHit(env, "cht:" + account.public_id, 30, 10 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const ticket = "ct1." + b64url(crypto.getRandomValues(new Uint8Array(24)));
    const now = Date.now();
    await env.DB.prepare("DELETE FROM channel_tickets WHERE expires_at <= ?").bind(now).run();
    await env.DB.prepare("INSERT INTO channel_tickets (token_hash, public_id, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(ticket), account.public_id, now + TICKET_MS).run();
    return deps.json(200, { ticket: ticket, expiresAt: now + TICKET_MS });
  }
  if (path !== "/v1/channel") return null;
  if (request.method !== "GET") return deps.json(405, { error: "method" });
  if (String(request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return deps.json(426, { error: "upgrade" });
  const ticket = String(url.searchParams.get("ticket") || "");
  if (!ticket.startsWith("ct1.") || ticket.length > 80) return deps.json(401, { error: "ticket" });
  const hash = await sha256Hex(ticket);
  const now = Date.now();
  const row = await env.DB.prepare("SELECT public_id, expires_at FROM channel_tickets WHERE token_hash = ?").bind(hash).first();
  await env.DB.prepare("DELETE FROM channel_tickets WHERE token_hash = ?").bind(hash).run();
  if (!row || Number(row.expires_at) <= now || !isAccountId(row.public_id)) return deps.json(401, { error: "ticket" });
  if (!env.ACCOUNT_CHANNEL) return deps.json(503, { error: "channel" });
  const headers = new Headers(request.headers);
  headers.set("x-account-id", row.public_id);
  const forwarded = new Request(request, { headers: headers });
  return env.ACCOUNT_CHANNEL.get(env.ACCOUNT_CHANNEL.idFromName(row.public_id)).fetch(forwarded);
}

export { rows };
