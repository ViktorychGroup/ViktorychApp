/* Baseline for peer sync. Two to four Chrome contexts, a local mock, no
   Worker and no network beyond this machine. 30 runs, plain and with a 4×
   CPU plus a slow link. Prints medians and q1–q3. Does not change the app.

   Friend messages and the public feed document use the real page code.
   Posts, likes, follows and settings have no peer path; their times are
   only the local channel hop a server fan-out would add on this machine.
   A notification read is not sent. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { acceptPoolMessage, buildManifest, manifestObjectName, sha256Hex } from "../shared/peer-pool.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const A = "100000000001";
const B = "100000000002";
const RUNS = Math.max(1, Number(process.env.P2P_RUNS) || 30);
const ORIGIN_MS = 120;
const DOC = JSON.stringify({
  items: Array.from({ length: 40 }, (_, i) => ({ id: "p" + i, text: "Public post " + i + " " + "word ".repeat(12), at: 1700000000000 + i }))
});

const FRIEND = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="toast" hidden></div><span id="line"></span>
<script>
  const me = new URLSearchParams(location.search).get("me");
  const other = new URLSearchParams(location.search).get("other");
  document.getElementById("line").setAttribute("data-pid-line", other);
  window.__server = []; window.__seen = []; const listeners = [];
  window.ViktorychAccounts = { account: () => ({ publicId: me }), token: () => "t",
    call: (p, o) => {
      if (p === "/v1/p2p/signal") { window.__relay(me, o.body.to, JSON.stringify(o.body.signal)); return Promise.resolve({ status: 200 }); }
      if (p === "/v1/messages") {
        if (!navigator.onLine) return Promise.reject(new Error("offline"));
        window.__server.push(o.body);
        return Promise.resolve({ status: 200 });
      }
      return Promise.resolve(null);
    } };
  window.ViktorychPresence = { onChannel: (fn) => listeners.push(fn), stateOf: () => "online", myState: () => "online", refresh: () => {},
    seen: (id, state) => window.__seen.push([id, state]) };
  window.__deliver = (from, sig) => listeners.forEach((fn) => fn({ op: "event", topic: "p2p", data: { from: from, signal: JSON.parse(sig) } }));
</script>
<script type="module" src="/friend-p2p.js"></script></body></html>`;

const POOL = (base) => `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "t-" + Math.random(), account: { publicId: "100000000001" } }));
  localStorage.setItem("viktorychapp-peer-pool-v1", JSON.stringify({ mode: "on" }));
  window.VIKTORYCH_ACCOUNTS = { api: ${JSON.stringify(base + "/api")} };
  window.__marks = { "feeds.json": "bench1" };
  window.ViktorychPulse = { ok: () => true, version: (k) => window.__marks[k] || "", url: () => ${JSON.stringify(base + "/r2/pulse/v1.json")}, on: () => () => {} };
  class FakeWS {
    constructor() { this.readyState = 0; window.__pws = this; window.__wsOpen().then(() => { this.readyState = 1; this.onopen && this.onopen(); }); }
    send(s) { if (this.readyState === 1) window.__wsSend(s); }
    close() { if (this.readyState === 3) return; this.readyState = 3; window.__wsClose(); this.onclose && this.onclose(); }
  }
  window.WebSocket = FakeWS;
  window.__wsDeliver = (s) => { const ws = window.__pws; if (ws && ws.onmessage) ws.onmessage({ data: s }); };
  window.__get = async (key) => {
    const t0 = performance.now();
    const res = await window.ViktorychPool.fetchData(key, () => fetch(${JSON.stringify(base)} + "/api/v1/data/" + key, { cache: "no-store" }));
    const buf = new Uint8Array(await res.arrayBuffer());
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    return { how: res.headers.get("x-pool") || "origin", ms: performance.now() - t0, size: buf.byteLength, sha: Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("") };
  };
  window.__raw = async () => {
    const t0 = performance.now();
    const res = await fetch(${JSON.stringify(base)} + "/api/v1/data/feeds.json?clock=1", { cache: "no-store" });
    await res.arrayBuffer();
    return performance.now() - t0;
  };
</script>
<script type="module" src="/peer-pool.js"></script></body></html>`;

const FAKE_RTC = `(() => {
  const pcs = new Map();
  let n = 0;
  const uid = () => Math.random().toString(36).slice(2) + (++n);
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  const unb64 = (s) => { const t = atob(s); const a = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) a[i] = t.charCodeAt(i); return a.buffer; };
  class DC {
    constructor(pc) { this.pc = pc; this.readyState = "connecting"; this.bufferedAmount = 0; this.binaryType = "arraybuffer"; }
    send(data) {
      if (this.readyState !== "open") throw new Error("not open");
      const u8 = typeof data === "string" ? null : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      window.__pipe(this.pc.remote, JSON.stringify(u8 ? { b: b64(u8) } : { s: data }));
    }
    close() { if (this.readyState === "closed") return; this.readyState = "closed"; window.__pipe(this.pc.remote, JSON.stringify({ close: 1 })); this.onclose && this.onclose(); }
  }
  class PC {
    constructor() { this.uid = uid(); this.remote = ""; this.connectionState = "new"; this.localDescription = null; this.remoteDescription = null; this.dc = null; pcs.set(this.uid, this); }
    createDataChannel() { this.dc = new DC(this); return this.dc; }
    async createOffer() { return { type: "offer", sdp: "v=0 fake " + this.uid }; }
    async createAnswer() { return { type: "answer", sdp: "v=0 fake " + this.uid }; }
    async setLocalDescription(d) { this.localDescription = d; setTimeout(() => this.onicecandidate && this.onicecandidate({ candidate: null }), 0); }
    async setRemoteDescription(d) {
      this.remoteDescription = d; this.remote = String(d.sdp || "").trim().split(/\\s+/).pop();
      if (d.type === "answer") window.__pipe(this.remote, JSON.stringify({ open: this.uid }));
    }
    async addIceCandidate() {}
    close() { this.connectionState = "closed"; if (this.dc) this.dc.close(); pcs.delete(this.uid); }
    _wire(msg) {
      if (msg.open) {
        this.dc = new DC(this); this.dc.readyState = "open";
        this.ondatachannel && this.ondatachannel({ channel: this.dc });
        this.dc.onopen && this.dc.onopen();
        window.__pipe(this.remote, JSON.stringify({ opened: 1 }));
      } else if (msg.opened) { if (this.dc) { this.dc.readyState = "open"; this.dc.onopen && this.dc.onopen(); } }
      else if (msg.close) { if (this.dc && this.dc.readyState !== "closed") { this.dc.readyState = "closed"; this.dc.onclose && this.dc.onclose(); } }
      else if (this.dc && this.dc.readyState === "open" && this.dc.onmessage) this.dc.onmessage({ data: msg.s != null ? msg.s : unb64(msg.b) });
    }
  }
  window.__hasPc = (id) => pcs.has(id);
  window.__wire = (to, raw) => { const pc = pcs.get(to); if (pc) pc._wire(JSON.parse(raw)); };
  window.RTCPeerConnection = PC;
})();`;

function quartile(list) {
  const s = list.filter((n) => typeof n === "number" && Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!s.length) return { n: 0, q1: null, med: null, q3: null };
  const at = (p) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  const fix = (n) => Number(at(n).toFixed(1));
  return { n: s.length, q1: fix(0.25), med: fix(0.5), q3: fix(0.75) };
}
function rate(list) {
  const s = list.filter((n) => n === 0 || n === 1);
  const ok = s.filter((n) => n === 1).length;
  return { n: s.length, ok: ok, rate: s.length ? Number((ok / s.length).toFixed(3)) : null };
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  return mod.chromium || (mod.default && mod.default.chromium);
}
async function realIce(browser) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => new Promise((resolve) => {
      const pc = new RTCPeerConnection();
      pc.createDataChannel("probe");
      pc.onicecandidate = (event) => resolve(!!event.candidate);
      pc.createOffer().then((offer) => pc.setLocalDescription(offer));
      setTimeout(() => resolve(false), 2500);
    }));
  } finally { await page.close(); }
}
async function throttle(page) {
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await client.send("Network.emulateNetworkConditions", {
    offline: false, latency: 200, downloadThroughput: 50 * 1024, uploadThroughput: 20 * 1024
  });
}

function syncStore() {
  const box = { seq: 0, items: [], waiters: [] };
  function wake() {
    const left = [];
    box.waiters.forEach((w) => {
      const hit = box.items.find((item) => item.seq > w.after);
      if (hit) w.done(hit);
      else left.push(w);
    });
    box.waiters = left;
  }
  return {
    put(body) {
      if (body.kind === "note-read") return { synced: false, seq: box.seq };
      box.seq += 1;
      const item = { seq: box.seq, kind: body.kind, id: String(body.id || ""), value: body.value, at: Number(body.at) || Date.now(), device: String(body.device || "") };
      box.items.push(item);
      wake();
      return { synced: true, seq: item.seq };
    },
    wait(after, ms) {
      const hit = box.items.find((item) => item.seq > after);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const w = { after: after, done: (item) => { clearTimeout(w.timer); resolve(item); } };
        w.timer = setTimeout(() => {
          box.waiters = box.waiters.filter((x) => x !== w);
          resolve(null);
        }, ms);
        box.waiters.push(w);
      });
    },
    mergeOffline(rows) {
      const likes = {};
      const follows = {};
      const posts = {};
      let setting = null;
      rows.forEach((row) => {
        if (row.kind === "like") likes[row.id] = true;
        else if (row.kind === "follow") follows[row.id] = true;
        else if (row.kind === "post") posts[row.id] = row.value;
        else if (row.kind === "setting") {
          if (!setting || row.at >= setting.at) setting = { id: row.id, value: row.value, at: row.at };
        }
      });
      return {
        likes: Object.keys(likes).sort(),
        follows: Object.keys(follows).sort(),
        posts: Object.keys(posts).sort(),
        setting: setting
      };
    }
  };
}

async function main() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const priv = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const pub = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const wantSha = await sha256Hex(DOC);
  const manifest = JSON.stringify(await buildManifest("feeds.json", "bench1", DOC, Date.now(), priv));
  const bus = syncStore();
  let originHits = 0;
  let clockHits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;
    if (p === "/friend.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(FRIEND); return; }
    if (p === "/pool.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(POOL("http://127.0.0.1:" + server.address().port)); return; }
    if (p === "/friend-p2p.js" || p === "/peer-pool.js" || p === "/shared/peer-media.js" || p === "/shared/peer-pool.js" || p === "/shared/pool-scheduler.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(fs.readFileSync(path.join(root, p.slice(1))));
      return;
    }
    if (p === "/api/v1/media/swarm/ticket") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ticket: "bench" })); return; }
    if (p === "/api/v1/data/feeds.json") {
      if (url.searchParams.get("clock") === "1") clockHits += 1;
      else originHits += 1;
      setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(DOC); }, ORIGIN_MS);
      return;
    }
    if (p === "/r2/" + manifestObjectName("feeds.json")) {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(manifest);
      return;
    }
    if (p === "/mock/change" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (err) { body = {}; }
        const out = bus.put(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
      return;
    }
    if (p === "/mock/wait") {
      const after = Number(url.searchParams.get("after") || 0);
      const ms = Math.min(3000, Math.max(50, Number(url.searchParams.get("ms") || 1500)));
      bus.wait(after, ms).then((item) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ item: item }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const chromium = await loadPlaywright();
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const fake = process.env.P2P_FAKE_RTC === "1" || !(await realIce(browser));
  console.error(fake ? "transport: stand-in (WebRTC ICE did not answer)" : "transport: real WebRTC");

  async function arm(page, fakeOn, pipe) {
    if (!fakeOn) return;
    await page.exposeFunction("__pipe", pipe);
    await page.addInitScript(FAKE_RTC);
  }
  function makePipe(pages) {
    let chain = Promise.resolve();
    return (to, raw) => {
      chain = chain.then(async () => {
        for (const p of pages) {
          if (await p.evaluate((id) => window.__hasPc && window.__hasPc(id), to).catch(() => false)) {
            await p.evaluate(([id, r]) => window.__wire(id, r), [to, raw]).catch(() => {});
            return;
          }
        }
      });
    };
  }

  async function friendRun(slow) {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pa = await ctxA.newPage();
    const pb = await ctxB.newPage();
    const pages = [pa, pb];
    const pipe = makePipe(pages);
    const relay = (from, to, sig) => {
      const target = from === A ? pb : pa;
      target.evaluate(([f, s]) => window.__deliver(f, s), [from, sig]).catch(() => {});
    };
    await pa.exposeFunction("__relay", relay);
    await pb.exposeFunction("__relay", relay);
    await arm(pa, fake, pipe);
    await arm(pb, fake, pipe);
    await pa.goto(base + "/friend.html?me=" + A + "&other=" + B, { waitUntil: "domcontentloaded" });
    await pb.goto(base + "/friend.html?me=" + B + "&other=" + A, { waitUntil: "domcontentloaded" });
    await pa.waitForFunction(() => window.ViktorychFriendP2P);
    await pb.waitForFunction(() => window.ViktorychFriendP2P);
    if (slow) { await throttle(pa); await throttle(pb); }
    const t0 = Date.now();
    const linked = await pa.evaluate((id) => window.ViktorychFriendP2P.connect(id).then((p) => !!p), B);
    const connectMs = Date.now() - t0;
    let msgP2pMs = null;
    if (linked) {
      msgP2pMs = await pa.evaluate(async (id) => {
        const t = performance.now();
        const sent = await window.ViktorychFriendP2P.send(id, "bench hello");
        const got = window.ViktorychFriendP2P.thread(id);
        return sent.via === "p2p" && got.some((m) => m.text === "bench hello" && m.mine) ? performance.now() - t : null;
      }, B);
      await pb.waitForFunction((id) => window.ViktorychFriendP2P.thread(id).some((m) => m.text === "bench hello" && !m.mine), A, { timeout: 5000 }).catch(() => {});
    }
    await pb.evaluate(() => window.ViktorychFriendP2P.setEnabled(false));
    await pa.waitForFunction(() => window.ViktorychFriendP2P.peers().length === 0, null, { timeout: 400 }).catch(() => {});
    const server = await pa.evaluate(async (id) => {
      const t = performance.now();
      const sent = await window.ViktorychFriendP2P.send(id, "bench server");
      return { via: sent.via, ms: performance.now() - t, serverN: window.__server.length };
    }, B);
    const bThread = await pb.evaluate((id) => window.ViktorychFriendP2P.thread(id).map((m) => m.text), A);
    await ctxA.setOffline(true);
    const queued = await pa.evaluate((id) => window.ViktorychFriendP2P.send(id, "bench later").then((s) => s.via), B);
    const queuedN = await pa.evaluate(() => window.ViktorychFriendP2P.outbox().length);
    await pb.evaluate(() => window.ViktorychFriendP2P.setEnabled(true));
    await ctxA.setOffline(false);
    await pa.waitForFunction(() => window.ViktorychFriendP2P.outbox().length === 0, null, { timeout: 12000 }).catch(() => {});
    const after = await pa.evaluate((id) => ({
      out: window.ViktorychFriendP2P.outbox().length,
      mine: window.ViktorychFriendP2P.thread(id).filter((m) => m.text === "bench later").length,
      server: window.__server.filter((m) => m.text === "bench later").length
    }), B);
    const onB = await pb.evaluate((id) => window.ViktorychFriendP2P.thread(id).filter((m) => m.text === "bench later").length, A);
    /* The sender keeps one local copy and posts one server copy. The
       friend's own thread only updates when the bytes arrived peer to
       peer, so a server fallback is still missing on device B. */
    const drained = queued === "outbox" && queuedN === 1 && after.out === 0 && after.mine === 1 && after.server === 1;
    const dup = after.mine > 1 || after.server > 1 || onB > 1;
    await ctxA.close();
    await ctxB.close();
    return {
      friendConnectMs: linked ? connectMs : null,
      friendConnectOk: linked ? 1 : 0,
      msgP2pMs: msgP2pMs,
      msgServerMs: server.via === "server" ? server.ms : null,
      msgServerReachedB: bThread.indexOf("bench server") >= 0 ? 1 : 0,
      offlineDrained: drained ? 1 : 0,
      offlineSeenOnB: onB === 1 ? 1 : 0,
      offlineDup: dup ? 1 : 0
    };
  }

  async function poolRun(slow) {
    const room = new Map();
    const pages = [];
    const pipe = makePipe(pages);
    const deliver = (id, body) => { const m = room.get(id); if (m) m.page.evaluate((s) => window.__wsDeliver(s), JSON.stringify(body)).catch(() => {}); };
    async function add() {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      pages.push(page);
      let id = "";
      await page.exposeFunction("__wsOpen", () => {
        id = Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
        const others = Array.from(room.keys());
        room.set(id, { page: page });
        setTimeout(() => { deliver(id, { op: "ready", id: id, peers: others }); others.forEach((o) => deliver(o, { op: "peer", id: id })); }, 15);
        return true;
      });
      await page.exposeFunction("__wsSend", (raw) => {
        const msg = acceptPoolMessage(raw);
        if (!msg) return;
        if (msg.op === "have") room.forEach((_, o) => { if (o !== id) deliver(o, { op: "have", from: id, items: msg.items, reset: msg.reset }); });
        if (msg.op === "signal") deliver(msg.to, { op: "signal", from: id, signal: msg.signal });
      });
      await page.exposeFunction("__wsClose", () => { room.delete(id); });
      await arm(page, fake, pipe);
      await page.addInitScript((jwk) => { window.__viktorychPoolTestJwk = jwk; }, pub);
      await page.goto(base + "/pool.html", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.ViktorychPool && window.ViktorychPool.stats().on, null, { timeout: 10000 });
      return { ctx: ctx, page: page };
    }
    const beforeHits = originHits;
    const one = await add();
    const two = await add();
    if (slow) { await throttle(one.page); await throttle(two.page); }
    const tConnect = Date.now();
    const peersOk = await one.page.waitForFunction(() => window.ViktorychPool.stats().peers >= 1, null, { timeout: 8000 }).then(() => true).catch(() => false);
    const poolConnectMs = peersOk ? Date.now() - tConnect : null;
    const rawMs = await two.page.evaluate(() => window.__raw());
    const cold = await one.page.evaluate(() => window.__get("feeds.json"));
    await one.page.waitForFunction(() => window.ViktorychPool._state.store.size >= 1, null, { timeout: 8000 }).catch(() => {});
    if (peersOk) await two.page.waitForFunction((h) => Array.from(window.ViktorychPool._state.haves.values()).some((m) => m.has(h)), wantSha, { timeout: 5000 }).catch(() => {});
    const peer = await two.page.evaluate(() => window.__get("feeds.json"));
    const saved = await two.page.evaluate(() => window.ViktorychPool.stats());
    const miss = await one.page.evaluate(async () => {
      const t = performance.now();
      await window.ViktorychPool.fetchData("stories.json", () => fetch(location.origin + "/nope", { cache: "no-store" }).catch(() => new Response("", { status: 404 })));
      return performance.now() - t;
    }).catch(() => null);
    await one.ctx.close();
    await two.ctx.close();
    const peerHit = peer && String(peer.how || "").indexOf("peer") === 0 && peer.sha === wantSha;
    return {
      poolConnectMs: poolConnectMs,
      poolConnectOk: peersOk ? 1 : 0,
      poolOriginMs: cold && cold.how === "origin" && cold.sha === wantSha ? cold.ms : null,
      poolPeerMs: peerHit ? peer.ms : null,
      poolHit: peerHit ? 1 : 0,
      poolBytesSaved: peerHit ? peer.size : 0,
      poolOriginReads: originHits - beforeHits,
      rawOriginMs: rawMs,
      poolMissMs: miss,
      hashOk: cold && cold.sha === wantSha ? 1 : 0
    };
  }

  async function syncRun(slow) {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pa = await ctxA.newPage();
    const pb = await ctxB.newPage();
    await pa.goto(base + "/friend.html?me=" + A + "&other=" + B, { waitUntil: "domcontentloaded" });
    await pb.goto(base + "/friend.html?me=" + B + "&other=" + A, { waitUntil: "domcontentloaded" });
    if (slow) { await throttle(pa); await throttle(pb); }
    async function once(kind, id, value) {
      const after = await pb.evaluate(async () => {
        const res = await fetch("/mock/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "probe", id: "x", value: 1, device: "B" }) });
        const body = await res.json();
        return body.seq || 0;
      });
      const started = Date.now();
      const waitP = pb.evaluate(async (cursor) => {
        const res = await fetch("/mock/wait?after=" + cursor);
        const body = await res.json();
        return { item: body.item, at: Date.now() };
      }, after);
      await pa.evaluate(async (row) => {
        await fetch("/mock/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(row) });
      }, { kind: kind, id: id, value: value, at: Date.now(), device: "A" });
      const got = await waitP;
      return got.item && got.item.kind === kind && got.item.id === id ? got.at - started : null;
    }
    const postMs = await once("post", "post-1", "hello");
    const likeMs = await once("like", "post-1", true);
    const followMs = await once("follow", "100000000009", true);
    const settingMs = await once("setting", "appearance", "lightsout");
    const cursor = await pb.evaluate(async () => {
      const res = await fetch("/mock/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "probe", id: "cursor", value: 1, device: "B" }) });
      const body = await res.json();
      return body.seq || 0;
    });
    const note = await pa.evaluate(async () => {
      const res = await fetch("/mock/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "note-read", id: "n1", device: "A" }) });
      return res.json();
    });
    const leaked = await pb.evaluate(async (after) => {
      const res = await fetch("/mock/wait?after=" + after + "&ms=200");
      const body = await res.json();
      return !!(body.item && body.item.kind === "note-read");
    }, cursor);
    const offline = bus.mergeOffline([
      { kind: "like", id: "a", at: 1 },
      { kind: "like", id: "a", at: 2 },
      { kind: "like", id: "b", at: 2 },
      { kind: "follow", id: "f1", at: 1 },
      { kind: "follow", id: "f2", at: 1 },
      { kind: "post", id: "p1", value: "from A", at: 1 },
      { kind: "post", id: "p2", value: "from B", at: 2 },
      { kind: "post", id: "p1", value: "from A", at: 3 },
      { kind: "setting", id: "appearance", value: "dim", at: 5 },
      { kind: "setting", id: "appearance", value: "lightsout", at: 9 }
    ]);
    const offlineOk = offline.likes.join() === "a,b" && offline.follows.join() === "f1,f2" && offline.posts.join() === "p1,p2" && offline.setting && offline.setting.value === "lightsout";
    await ctxA.close();
    await ctxB.close();
    return {
      postServerMs: postMs,
      likeServerMs: likeMs,
      followServerMs: followMs,
      settingServerMs: settingMs,
      noteReadStayedLocal: note.synced === false && !leaked ? 1 : 0,
      offlineMergeOk: offlineOk ? 1 : 0
    };
  }

  const wantProfiles = (process.env.P2P_PROFILES || "plain,cpu4").split(",").filter(Boolean);
  const profiles = [
    { name: "plain", slow: false },
    { name: "cpu4", slow: true }
  ].filter((profile) => wantProfiles.indexOf(profile.name) >= 0);
  const out = { transport: fake ? "stand-in" : "webrtc", originDelayMs: ORIGIN_MS, docBytes: DOC.length, runs: RUNS, profiles: {} };
  try {
    for (const profile of profiles) {
      const rows = [];
      for (let i = 1; i <= RUNS; i++) {
        process.stderr.write(profile.name + " " + i + "/" + RUNS + "\n");
        const row = {};
        try { Object.assign(row, await friendRun(profile.slow)); } catch (err) { row.friendError = String(err && err.message || err); }
        try { Object.assign(row, await poolRun(profile.slow)); } catch (err) { row.poolError = String(err && err.message || err); }
        try { Object.assign(row, await syncRun(profile.slow)); } catch (err) { row.syncError = String(err && err.message || err); }
        rows.push(row);
      }
      const keys = ["friendConnectMs", "msgP2pMs", "msgServerMs", "poolConnectMs", "poolOriginMs", "poolPeerMs", "poolBytesSaved", "rawOriginMs", "poolMissMs", "postServerMs", "likeServerMs", "followServerMs", "settingServerMs"];
      const summary = {};
      keys.forEach((key) => { summary[key] = quartile(rows.map((r) => r[key])); });
      ["friendConnectOk", "msgServerReachedB", "offlineDrained", "offlineSeenOnB", "offlineDup", "poolConnectOk", "poolHit", "hashOk", "noteReadStayedLocal", "offlineMergeOk"].forEach((key) => {
        summary[key] = rate(rows.map((r) => r[key]));
      });
      const reads = rows.map((r) => r.poolOriginReads).filter((n) => typeof n === "number");
      summary.poolOriginReads = quartile(reads);
      out.profiles[profile.name] = { summary: summary, rows: rows };
    }
  } finally {
    await browser.close();
    server.close();
  }
  const text = JSON.stringify(out, null, 2);
  if (process.env.P2P_OUT) fs.writeFileSync(process.env.P2P_OUT, text);
  console.log(text);
}

main().catch((err) => { console.error(err); process.exit(1); });
