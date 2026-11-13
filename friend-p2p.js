/* Friend P2P. Friends' devices talk directly over WebRTC once both are
   online: messages, online status and typing go peer to peer, and media a
   friend already loaded can come from their device. The account channel
   only carries the handshake, and only between friends. Messages written
   offline wait in an outbox and go once the device is back online. When a
   friend is slow or unreachable, the normal connection takes over. */
import { STUN_URLS } from "./shared/peer-media.js";

const PREF = "viktorychapp-friend-p2p";
const OUTBOX = "viktorychapp-friend-outbox";
const THREADS = "viktorychapp-friend-threads";
const ACK_MS = 800;
const CONNECT_MS = 4000;
const IDLE_MS = 5 * 60 * 1000;
const HERE_MS = 25000;
const PEER_MAX = 6;
const CHUNK = 16 * 1024;
const MEDIA_MAX = 25 * 1024 * 1024;
const FIRST_BYTE_MS = 600;

const peers = new Map();
const acks = new Map();
const wants = new Map();
const typingUntil = new Map();
let hereTimer = 0;
let flushing = null;
let bound = false;

function tr(key, vars) { return window.t ? window.t(key, vars) : key; }
function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function ls() { try { return window.localStorage; } catch (err) { return null; } }
function readJson(name, fallback) { try { const raw = ls() && ls().getItem(name); return raw ? JSON.parse(raw) : fallback; } catch (err) { return fallback; } }
function writeJson(name, value) { try { if (ls()) ls().setItem(name, JSON.stringify(value)); } catch (err) { /* private mode */ } }
function accounts() { return window.ViktorychAccounts || null; }
function selfId() {
  const api = accounts();
  const acct = api && api.account && api.account();
  const id = acct && acct.publicId;
  return /^\d{12}$/.test(String(id || "")) ? String(id) : "";
}
function token() { const api = accounts(); const value = api && api.token && api.token(); return value ? String(value) : ""; }
function call(path, opts) {
  const api = accounts();
  if (!api || !api.call || !token()) return Promise.resolve(null);
  return api.call(path, Object.assign({ token: token() }, opts || {})).catch(() => null);
}
function rid() {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
function enabled() { const p = readJson(PREF, {}); return p.on !== false && typeof RTCPeerConnection === "function"; }
function setEnabled(on) {
  writeJson(PREF, { on: !!on });
  if (!on) peers.forEach((peer, id) => drop(id, true));
}
function mediaShare() {
  try {
    const perf = JSON.parse(localStorage.getItem("viktorychapp-device-performance") || "{}");
    return perf.peerMedia !== "off";
  } catch (err) { return true; }
}
function presence() { return window.ViktorychPresence || null; }
function myState() {
  const p = presence();
  const state = p && p.myState ? p.myState() : "online";
  return state === "invisible" ? "" : state || "online";
}

/* Signaling through the account channel. */
function signal(to, data) { return call("/v1/p2p/signal", { method: "POST", body: { to: to, signal: data } }); }

function newPeer(id, sid, offering) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_URLS }] });
  const peer = { id: id, sid: sid, pc: pc, dc: null, open: false, offering: offering, last: Date.now(), waiters: [], queue: [] };
  pc.onicecandidate = (event) => {
    if (event.candidate) signal(id, { kind: "ice", sid: sid, cand: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") drop(id);
  };
  pc.ondatachannel = (event) => wire(peer, event.channel);
  peers.set(id, peer);
  trim();
  return peer;
}
function wire(peer, dc) {
  peer.dc = dc;
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = 256 * 1024;
  dc.onopen = () => {
    peer.open = true;
    peer.last = Date.now();
    hello(peer);
    peer.waiters.splice(0).forEach((fn) => fn(true));
    armHere();
  };
  dc.onclose = () => drop(peer.id);
  dc.onmessage = (event) => onData(peer, event.data);
}
function drop(id, quiet) {
  const peer = peers.get(id);
  if (!peer) return;
  peers.delete(id);
  peer.waiters.splice(0).forEach((fn) => fn(false));
  if (!quiet && peer.open) { /* the friend left or the link broke */ }
  try { if (peer.dc) peer.dc.close(); } catch (err) { /* closed */ }
  try { peer.pc.close(); } catch (err) { /* closed */ }
}
function trim() {
  if (peers.size <= PEER_MAX) return;
  const oldest = Array.from(peers.values()).sort((a, b) => a.last - b.last)[0];
  if (oldest) drop(oldest.id);
}
function connect(id) {
  if (!enabled() || !selfId() || !/^\d{12}$/.test(String(id || "")) || id === selfId()) return Promise.resolve(null);
  const have = peers.get(id);
  if (have && have.open) return Promise.resolve(have);
  const peer = have || newPeer(id, rid(), true);
  const ready = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), CONNECT_MS);
    peer.waiters.push((ok) => { clearTimeout(timer); resolve(ok); });
  });
  if (!have) {
    wire(peer, peer.pc.createDataChannel("vk", { ordered: true }));
    peer.pc.createOffer().then((offer) => peer.pc.setLocalDescription(offer)).then(() => {
      return signal(id, { kind: "offer", sid: peer.sid, sdp: peer.pc.localDescription.sdp });
    }).then((res) => { if (!res || res.status !== 200) drop(id); }).catch(() => drop(id));
  }
  return ready.then((ok) => (ok && peers.get(id) === peer ? peer : null));
}
async function onSignal(from, data) {
  if (!enabled() || !data || !/^\d{12}$/.test(String(from || ""))) return;
  let peer = peers.get(from);
  if (data.kind === "offer") {
    // Both sides offered at once: the higher account id keeps its offer.
    if (peer && peer.offering && !peer.open && selfId() > from) return;
    if (peer) drop(from, true);
    peer = newPeer(from, data.sid, false);
    try {
      await peer.pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      await signal(from, { kind: "answer", sid: data.sid, sdp: peer.pc.localDescription.sdp });
      (peer.queue || []).splice(0).forEach((c) => peer.pc.addIceCandidate(c).catch(() => {}));
    } catch (err) { drop(from); }
    return;
  }
  if (!peer || peer.sid !== data.sid) return;
  if (data.kind === "answer") {
    try {
      await peer.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      peer.queue.splice(0).forEach((c) => peer.pc.addIceCandidate(c).catch(() => {}));
    } catch (err) { drop(from); }
  } else if (data.kind === "ice") {
    if (!peer.pc.remoteDescription) peer.queue.push(data.cand);
    else peer.pc.addIceCandidate(data.cand).catch(() => {});
  } else if (data.kind === "bye") drop(from, true);
}

function send(peer, obj) {
  if (!peer || !peer.open || !peer.dc || peer.dc.readyState !== "open") return false;
  try { peer.dc.send(JSON.stringify(obj)); peer.last = Date.now(); return true; } catch (err) { return false; }
}
function hello(peer) {
  const state = myState();
  if (state) send(peer, { t: "here", state: state });
}
function armHere() {
  if (hereTimer) return;
  hereTimer = setInterval(() => {
    if (!peers.size) { clearInterval(hereTimer); hereTimer = 0; return; }
    const now = Date.now();
    peers.forEach((peer, id) => {
      if (now - peer.last > IDLE_MS) drop(id);
      else if (!document.hidden) hello(peer);
    });
  }, HERE_MS);
}

/* Local copy of direct messages, last 50 per friend. */
function threads() { return readJson(THREADS, {}); }
function remember(id, row) {
  const all = threads();
  const list = Array.isArray(all[id]) ? all[id] : [];
  if (row.mid && list.some((m) => m.mid === row.mid)) return false;
  list.push(row);
  all[id] = list.slice(-50);
  writeJson(THREADS, all);
  return true;
}
function thread(id) { const all = threads(); return Array.isArray(all[id]) ? all[id].slice() : []; }

function onData(peer, data) {
  peer.last = Date.now();
  if (typeof data !== "string") return onChunk(peer, data);
  let msg = null;
  try { msg = JSON.parse(data); } catch (err) { return; }
  if (!msg || typeof msg.t !== "string") return;
  const p = presence();
  if (msg.t === "here") {
    if (p && p.seen) p.seen(peer.id, ["online", "idle", "dnd"].indexOf(msg.state) >= 0 ? msg.state : "online");
  } else if (msg.t === "typing") {
    typingUntil.set(peer.id, Date.now() + 5000);
    paintTyping(peer.id);
  } else if (msg.t === "msg" && typeof msg.text === "string" && msg.mid) {
    const text = msg.text.slice(0, 2000);
    send(peer, { t: "ack", mid: String(msg.mid).slice(0, 40) });
    typingUntil.delete(peer.id);
    paintTyping(peer.id);
    if (remember(peer.id, { mid: String(msg.mid).slice(0, 40), mine: false, text: text, at: Date.now(), via: "p2p" })) {
      window.dispatchEvent(new CustomEvent("viktorych-friend-message", { detail: { from: peer.id, text: text } }));
      toast(tr("New message: {text}", { text: text.length > 80 ? text.slice(0, 79) + "…" : text }));
    }
  } else if (msg.t === "ack" && acks.has(msg.mid)) {
    acks.get(msg.mid)(true);
  } else if (msg.t === "have" && typeof msg.url === "string" && msg.rid) {
    serveMedia(peer, String(msg.rid).slice(0, 40), msg.url);
  } else if (msg.t === "media" || msg.t === "nope" || msg.t === "end") {
    const want = wants.get(msg.rid);
    if (want) want.on(msg);
  }
}
function toast(text) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3200);
}
function paintTyping(id) {
  const on = (typingUntil.get(id) || 0) > Date.now();
  document.querySelectorAll('[data-pid-line="' + id + '"]').forEach((el) => {
    if (on) { el.setAttribute("data-typing", "1"); el.textContent = tr("typing…"); }
    else if (el.getAttribute("data-typing")) { el.removeAttribute("data-typing"); const p = presence(); if (p && p.refresh) p.refresh(); }
  });
  if (on) setTimeout(() => paintTyping(id), 5100);
}

/* Messages: direct when the friend's device answers in time, otherwise
   the server, and the outbox when this device is offline. */
function friendOnline(id) {
  const p = presence();
  return !!(p && p.stateOf && ["online", "idle", "dnd"].indexOf(p.stateOf(id)) >= 0);
}
function viaPeer(id, mid, text) {
  const have = peers.get(id);
  /* A closed channel goes to the server now. Connecting can take seconds
     and the message would sit on this device until it gave up. */
  if (!have || !have.open) {
    if (friendOnline(id)) connect(id);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => { acks.delete(mid); resolve(false); }, ACK_MS);
    acks.set(mid, (ok) => { clearTimeout(timer); acks.delete(mid); resolve(ok); });
    if (!send(have, { t: "msg", mid: mid, text: text })) { clearTimeout(timer); acks.delete(mid); resolve(false); }
  });
}
function viaServer(id, text, mid) {
  const body = { id: id, text: text };
  /* The same id the direct copy used, so a late server copy is one message. */
  if (mid) body.mid = mid;
  return call("/v1/messages", { method: "POST", body: body }).then((res) => {
    if (!res) return "offline";
    return res.status === 200 ? "server" : "refused";
  });
}
function queue(id, mid, text) {
  const box = readJson(OUTBOX, []);
  if (!box.some((row) => row.mid === mid)) box.push({ to: id, mid: mid, text: text, at: Date.now() });
  writeJson(OUTBOX, box.slice(-100));
}
function sendMessage(id, text, mid) {
  text = String(text || "").trim().slice(0, 2000);
  mid = mid || rid();
  if (!text || !/^\d{12}$/.test(String(id || ""))) return Promise.resolve({ via: "refused" });
  remember(id, { mid: mid, mine: true, text: text, at: Date.now() });
  if (typeof navigator !== "undefined" && navigator.onLine === false) { queue(id, mid, text); return Promise.resolve({ via: "outbox", mid: mid }); }
  const direct = enabled() ? viaPeer(id, mid, text) : Promise.resolve(false);
  return direct.then((ok) => {
    if (ok) return { via: "p2p", mid: mid };
    return viaServer(id, text, mid).then((via) => {
      if (via === "offline") { queue(id, mid, text); return { via: "outbox", mid: mid }; }
      return { via: via, mid: mid };
    });
  });
}
function flush() {
  if (flushing || (typeof navigator !== "undefined" && navigator.onLine === false) || !token()) return flushing || Promise.resolve(0);
  const box = readJson(OUTBOX, []);
  if (!box.length) return Promise.resolve(0);
  flushing = box.reduce((chain, row) => chain.then((sent) => {
    const direct = enabled() ? viaPeer(row.to, row.mid, row.text) : Promise.resolve(false);
    return direct.then((ok) => (ok ? "p2p" : viaServer(row.to, row.text, row.mid))).then((via) => {
      if (via === "offline") return sent;
      writeJson(OUTBOX, readJson(OUTBOX, []).filter((r) => r.mid !== row.mid));
      return sent + 1;
    });
  }), Promise.resolve(0)).then((sent) => {
    flushing = null;
    if (sent) toast(tr("Sent {n} waiting messages", { n: sent }));
    return sent;
  }, () => { flushing = null; return 0; });
  return flushing;
}
let typingAt = 0;
function typing(id) {
  if (!enabled() || Date.now() - typingAt < 2500) return;
  typingAt = Date.now();
  const peer = peers.get(id);
  if (peer && peer.open) send(peer, { t: "typing" });
  else if (friendOnline(id)) connect(id);
}

/* Media a friend already has. Only readable copies in this device's media
   cache are shared, as the original bytes. */
async function cachedCopy(url) {
  if (typeof caches === "undefined") return null;
  const names = (await caches.keys()).filter((name) => /^media-/.test(name));
  for (const name of names) {
    const res = await (await caches.open(name)).match(url);
    if (res && res.type !== "opaque" && res.ok) return res;
  }
  return null;
}
async function serveMedia(peer, id, url) {
  let res = null;
  try { if (enabled() && mediaShare() && /^https:\/\//.test(url)) res = await cachedCopy(url); } catch (err) { res = null; }
  if (!res) { send(peer, { t: "nope", rid: id }); return; }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!buf.length || buf.length > MEDIA_MAX) { send(peer, { t: "nope", rid: id }); return; }
  send(peer, { t: "media", rid: id, size: buf.length, mime: (res.headers.get("content-type") || "").slice(0, 80) });
  const tag = new TextEncoder().encode(id.padEnd(18, " ").slice(0, 18));
  for (let at = 0; at < buf.length; at += CHUNK) {
    if (!peer.open) return;
    if (peer.dc.bufferedAmount > 1024 * 1024) await new Promise((resolve) => { peer.dc.onbufferedamountlow = () => { peer.dc.onbufferedamountlow = null; resolve(); }; });
    const part = buf.subarray(at, Math.min(buf.length, at + CHUNK));
    const out = new Uint8Array(18 + part.length);
    out.set(tag, 0);
    out.set(part, 18);
    try { peer.dc.send(out); } catch (err) { return; }
  }
  send(peer, { t: "end", rid: id });
}
function onChunk(peer, data) {
  const bytes = new Uint8Array(data);
  if (bytes.length < 18) return;
  const id = new TextDecoder().decode(bytes.subarray(0, 18)).trim();
  const want = wants.get(id);
  if (want) want.chunk(bytes.subarray(18));
}
function askPeer(peer, url) {
  return new Promise((resolve) => {
    const id = rid();
    const parts = [];
    let size = 0, got = 0, mime = "";
    const done = (value) => { clearTimeout(first); wants.delete(id); resolve(value); };
    const first = setTimeout(() => done(null), FIRST_BYTE_MS);
    wants.set(id, {
      on: (msg) => {
        if (msg.t === "nope") return done(null);
        if (msg.t === "media") { clearTimeout(first); size = Number(msg.size) || 0; mime = String(msg.mime || ""); return; }
        if (msg.t === "end") done(got === size && size ? new Blob(parts, { type: mime }) : null);
      },
      chunk: (part) => { parts.push(part.slice()); got += part.length; if (got > size) done(null); }
    });
    if (!send(peer, { t: "have", rid: id, url: url })) done(null);
  });
}
/* Races the friends' copy against the normal connection: the friend only
   wins when it starts within 600 ms and finishes first. */
function fetchMedia(url, opts) {
  opts = opts || {};
  const open = Array.from(peers.values()).filter((p) => p.open);
  const origin = () => fetch(url, { credentials: "omit", mode: "cors" }).then((res) => (res.ok ? res.blob().then((blob) => ({ blob: blob, via: "origin" })) : null)).catch(() => null);
  if (!enabled() || !mediaShare() || !open.length || !/^https:\/\//.test(url)) return opts.peerOnly ? Promise.resolve(null) : origin();
  const fromFriends = Promise.all(open.slice(0, 3).map((peer) => askPeer(peer, url))).then((list) => list.find(Boolean) || null);
  if (opts.peerOnly) return fromFriends.then((blob) => (blob ? { blob: blob, via: "p2p" } : null));
  return new Promise((resolve) => {
    let settled = false, fallback = null;
    const finish = (value) => { if (!settled && value) { settled = true; resolve(value); } };
    const go = () => { if (!fallback) fallback = origin().then((v) => { finish(v); return v; }); return fallback; };
    const slow = setTimeout(go, FIRST_BYTE_MS);
    fromFriends.then((blob) => {
      if (blob) { clearTimeout(slow); finish({ blob: blob, via: "p2p" }); }
      else go().then((v) => { if (!v && !settled) { settled = true; resolve(null); } });
    });
  });
}

function settingsHtml() {
  const on = readJson(PREF, {}).on !== false;
  return '<h2>' + esc(tr("Friends direct")) + '</h2><button class="tab-switch' + (on ? " on" : "") + '" type="button" role="switch" aria-checked="' + (on ? "true" : "false") + '" data-friend-p2p="toggle"><span>' + tr("Connect directly to friends") + "</span><i></i></button>" +
    '<p class="phandle set-desc">' + esc(tr("Messages, online status and typing go straight to friends who are online, and media they already loaded can come from their device. Friends can see your IP address while connected. Messages written offline are sent when you’re back online.")) + "</p>";
}

function boot() {
  if (bound) return;
  bound = true;
  const attach = () => {
    const p = presence();
    if (!p || !p.onChannel) return false;
    p.onChannel((msg) => {
      if (!msg || msg.op !== "event" || !msg.data) return;
      if (msg.topic === "p2p") onSignal(String(msg.data.from || ""), msg.data.signal);
      if (msg.topic === "dm") {
        const from = String(msg.data.from || "");
        const text = String(msg.data.text || "").slice(0, 2000);
        const mid = String(msg.data.id || "").slice(0, 40);
        if (!/^\d{12}$/.test(from) || !text || !mid) return;
        if (remember(from, { mid: mid, mine: false, text: text, at: Number(msg.data.at) || Date.now(), via: "server" })) {
          window.dispatchEvent(new CustomEvent("viktorych-friend-message", { detail: { from: from, text: text } }));
        }
      }
    });
    return true;
  };
  if (!attach()) {
    let tries = 0;
    const timer = setInterval(() => { if (attach() || ++tries > 40) clearInterval(timer); }, 250);
  }
  window.addEventListener("online", () => flush());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) flush(); });
  document.addEventListener("click", (event) => {
    const el = event.target.closest && event.target.closest("[data-friend-p2p]");
    if (!el) return;
    const on = !(readJson(PREF, {}).on !== false);
    setEnabled(on);
    el.classList.toggle("on", on);
    el.setAttribute("aria-checked", on ? "true" : "false");
  });
  setTimeout(flush, 3000);
}

const api = {
  enabled: enabled,
  setEnabled: setEnabled,
  connect: connect,
  send: sendMessage,
  typing: typing,
  flush: flush,
  thread: thread,
  fetchMedia: fetchMedia,
  settingsHtml: settingsHtml,
  outbox: () => readJson(OUTBOX, []),
  peers: () => Array.from(peers.values()).filter((p) => p.open).map((p) => p.id),
  _signal: onSignal
};
window.ViktorychFriendP2P = api;
boot();
export default api;
