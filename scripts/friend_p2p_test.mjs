import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/* Friend P2P between two real browser pages over WebRTC. The account
   channel is stubbed by relaying signals between the pages. Checks direct
   messages with acks, typing and online status, the server fallback when
   the friend doesn't answer, the offline outbox, and media from a friend's
   cache with the normal connection as fallback. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const A = "100000000001";
const B = "100000000002";

function fail(message) {
  console.error("FAIL: " + message);
  process.exitCode = 1;
  throw new Error(message);
}
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="toast" hidden></div><span id="line"></span>
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
        const id = (o.body && o.body.mid) || ("dm-" + o.body.text.length);
        if (window.__relayDm) window.__relayDm(me, o.body.id, o.body.text, id);
        return Promise.resolve({ status: 200, id: id });
      }
      return Promise.resolve(null);
    } };
  window.ViktorychPresence = { onChannel: (fn) => listeners.push(fn), stateOf: () => "online", myState: () => "online", refresh: () => {},
    seen: (id, state) => window.__seen.push([id, state]) };
  window.__deliver = (from, sig) => listeners.forEach((fn) => fn({ op: "event", topic: "p2p", data: { from: from, signal: JSON.parse(sig) } }));
  window.__deliverDm = (from, text, id) => listeners.forEach((fn) => fn({ op: "event", topic: "dm", data: { from: from, text: text, id: id, at: Date.now() } }));
</script>
<script type="module" src="/friend-p2p.js"></script></body></html>`;

/* Some sandboxes block WebRTC networking by policy. There the pages get a
   stand-in RTCPeerConnection that carries the same data channel bytes
   through the test runner, so the protocol is still exercised; CI runs real
   WebRTC. */
const FAKE_RTC = `(() => {
  const pcs = new Map();
  let n = 0;
  const uid = () => Math.random().toString(36).slice(2) + (++n);
  const b64 = (buf) => { let s = ""; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
  const unb64 = (s) => { const t = atob(s); const a = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) a[i] = t.charCodeAt(i); return a.buffer; };
  class DC {
    constructor(pc, label) { this.pc = pc; this.label = label; this.readyState = "connecting"; this.bufferedAmount = 0; this.binaryType = "arraybuffer"; }
    send(data) {
      if (this.readyState !== "open") throw new Error("not open");
      const wire = typeof data === "string" ? { s: data } : { b: b64(data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) };
      window.__pipe(this.pc.remote, JSON.stringify(wire));
    }
    close() { if (this.readyState === "closed") return; this.readyState = "closed"; window.__pipe(this.pc.remote, JSON.stringify({ close: 1 })); this.onclose && this.onclose(); }
  }
  class PC {
    constructor() { this.uid = uid(); this.remote = ""; this.connectionState = "new"; this.localDescription = null; this.remoteDescription = null; this.dc = null; pcs.set(this.uid, this); }
    createDataChannel(label) { this.dc = new DC(this, label); return this.dc; }
    async createOffer() { return { type: "offer", sdp: "v=0 fake " + this.uid }; }
    async createAnswer() { return { type: "answer", sdp: "v=0 fake " + this.uid }; }
    async setLocalDescription(d) { this.localDescription = d; setTimeout(() => this.onicecandidate && this.onicecandidate({ candidate: null }), 0); }
    async setRemoteDescription(d) {
      this.remoteDescription = d; this.remote = d.sdp.split(" ").pop();
      if (d.type === "answer") window.__pipe(this.remote, JSON.stringify({ open: this.uid }));
    }
    async addIceCandidate() {}
    close() { this.connectionState = "closed"; if (this.dc) this.dc.close(); pcs.delete(this.uid); }
    _wire(msg) {
      if (msg.open) {
        this.dc = new DC(this, "vk"); this.dc.readyState = "open";
        this.ondatachannel && this.ondatachannel({ channel: this.dc });
        this.dc.onopen && this.dc.onopen();
        window.__pipe(this.remote, JSON.stringify({ opened: 1 }));
      } else if (msg.opened) { this.dc.readyState = "open"; this.dc.onopen && this.dc.onopen(); }
      else if (msg.close) { if (this.dc && this.dc.readyState !== "closed") { this.dc.readyState = "closed"; this.dc.onclose && this.dc.onclose(); } }
      else if (this.dc && this.dc.readyState === "open" && this.dc.onmessage) this.dc.onmessage({ data: msg.s != null ? msg.s : unb64(msg.b) });
    }
  }
  window.__wire = (to, raw) => { const pc = pcs.get(to); if (pc) pc._wire(JSON.parse(raw)); };
  window.__hasPc = (to) => pcs.has(to);
  window.RTCPeerConnection = PC;
})();`;

async function realIce(browser) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => new Promise((resolve) => {
      const pc = new RTCPeerConnection();
      pc.createDataChannel("probe");
      pc.onicecandidate = (event) => { if (event.candidate) resolve(true); else resolve(false); };
      pc.createOffer().then((offer) => pc.setLocalDescription(offer));
      setTimeout(() => resolve(false), 3000);
    }));
  } finally { await page.close(); }
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  return mod.chromium || (mod.default && mod.default.chromium);
}

async function main() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/p.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); return; }
    const rel = url.pathname === "/friend-p2p.js" ? "friend-p2p.js" : url.pathname === "/shared/peer-media.js" ? "shared/peer-media.js" : "";
    if (!rel) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(fs.readFileSync(path.join(root, rel)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const chromium = await loadPlaywright();
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "chrome", headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-features=WebRtcHideLocalIpsWithMdns", "--force-webrtc-ip-handling-policy=default"] });
  try {
    const fake = !(await realIce(browser));
    if (fake) console.log("WebRTC networking is blocked here; using the stand-in transport");
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const origin = [];
    await ctxA.route("https://media.example/**", (route) => { origin.push(route.request().url()); route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/octet-stream" }, body: Buffer.alloc(1000, 7) }); });
    const pa = await ctxA.newPage();
    const pb = await ctxB.newPage();
    const errors = [];
    for (const p of [pa, pb]) p.on("pageerror", (e) => errors.push(String(e)));
    const pages = { [A]: pa, [B]: pb };
    const relay = (from, to, sig) => { const target = pages[to]; if (target) target.evaluate(([f, s]) => window.__deliver(f, s), [from, sig]).catch(() => {}); };
    const relayDm = (from, to, text, id) => { const target = pages[to]; if (target) target.evaluate(([f, t, i]) => window.__deliverDm(f, t, i), [from, text, id]).catch(() => {}); };
    await pa.exposeFunction("__relay", relay);
    await pb.exposeFunction("__relay", relay);
    await pa.exposeFunction("__relayDm", relayDm);
    await pb.exposeFunction("__relayDm", relayDm);
    let delayAcks = false;
    await pb.addInitScript(() => {
      const orig = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function (data) {
        if (window.__delayAck && typeof data === "string" && data.indexOf('"t":"ack"') >= 0) {
          const channel = this;
          setTimeout(() => { try { orig.call(channel, data); } catch (err) { /* already closed */ } }, 1200);
          return;
        }
        return orig.call(this, data);
      };
    });
    if (fake) {
      // Keep each direction in order, like a real data channel.
      let chain = Promise.resolve();
      const pipe = (to, raw) => {
        const lateAck = delayAcks && raw.indexOf('\\"t\\":\\"ack\\"') >= 0;
        chain = chain.then(async () => {
          if (lateAck) await new Promise((resolve) => setTimeout(resolve, 1200));
          for (const p of [pa, pb]) {
            if (await p.evaluate((t) => window.__hasPc && window.__hasPc(t), to).catch(() => false)) {
              await p.evaluate(([t, r]) => window.__wire(t, r), [to, raw]).catch(() => {});
              return;
            }
          }
        });
      };
      await pa.exposeFunction("__pipe", pipe);
      await pb.exposeFunction("__pipe", pipe);
      await pa.addInitScript(FAKE_RTC);
      await pb.addInitScript(FAKE_RTC);
    }
    await pa.goto(base + "/p.html?me=" + A + "&other=" + B);
    await pb.goto(base + "/p.html?me=" + B + "&other=" + A);
    await pa.waitForFunction(() => window.ViktorychFriendP2P);
    await pb.waitForFunction(() => window.ViktorychFriendP2P);

    const linked = await pa.evaluate((b) => window.ViktorychFriendP2P.connect(b).then((p) => !!p), B);
    if (!linked) fail("the friends' devices did not connect");
    await pb.waitForFunction((a) => window.__seen.some((s) => s[0] === a && s[1] === "online"), A, { timeout: 5000 });

    await pa.evaluate((b) => window.ViktorychFriendP2P.typing(b), B);
    await pb.waitForFunction(() => document.getElementById("line").textContent === "typing…", null, { timeout: 3000 });

    const sent = await pa.evaluate((b) => window.ViktorychFriendP2P.send(b, "hi there"), B);
    if (sent.via !== "p2p") fail("the message did not go peer to peer: " + JSON.stringify(sent));
    const got = await pb.evaluate((a) => window.ViktorychFriendP2P.thread(a), A);
    if (!got.length || got[0].text !== "hi there" || got[0].mine) fail("the friend did not get the message");
    if ((await pa.evaluate(() => window.__server.length))) fail("a direct message also went to the server");

    // Media from the friend's cache, original bytes.
    await pb.evaluate(async () => {
      const cache = await caches.open("media-test");
      const bytes = new Uint8Array(100000); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
      await cache.put("https://media.example/clip.bin", new Response(bytes, { headers: { "content-type": "video/mp2t" } }));
    });
    const media = await pa.evaluate(async () => {
      const got = await window.ViktorychFriendP2P.fetchMedia("https://media.example/clip.bin");
      const bytes = new Uint8Array(await got.blob.arrayBuffer());
      let ok = bytes.length === 100000; for (let i = 0; ok && i < bytes.length; i++) ok = bytes[i] === i % 251;
      return { via: got.via, ok: ok, type: got.blob.type };
    });
    if (media.via !== "p2p" || !media.ok || media.type !== "video/mp2t") fail("media did not come from the friend intact: " + JSON.stringify(media));
    if (origin.length) fail("the source was fetched though the friend had it");
    const missing = await pa.evaluate(async () => { const t = Date.now(); const got = await window.ViktorychFriendP2P.fetchMedia("https://media.example/other.bin"); return { via: got && got.via, ms: Date.now() - t }; });
    if (missing.via !== "origin" || missing.ms > 3000) fail("a miss did not fall back to the source quickly: " + JSON.stringify(missing));

    // The direct copy lands, and the confirmation is late, so the server
    // copy goes out too. Both carry the same id and the friend keeps one.
    delayAcks = true;
    await pb.evaluate(() => { window.__delayAck = true; });
    const late = await pa.evaluate((b) => window.ViktorychFriendP2P.send(b, "late confirm"), B);
    delayAcks = false;
    await pb.evaluate(() => { window.__delayAck = false; });
    if (!late || late.via !== "server" || !/^[a-f0-9]{18}$/.test(late.mid || "")) fail("a late confirmation did not fall back with the client id: " + JSON.stringify(late));
    const lateRows = await pb.evaluate((a) => window.ViktorychFriendP2P.thread(a).filter((m) => m.text === "late confirm"), A);
    if (lateRows.length !== 1 || lateRows[0].mid !== late.mid) fail("the direct copy was not the only row: " + JSON.stringify(lateRows));
    const posted = await pa.evaluate(() => window.__server.filter((m) => m.text === "late confirm"));
    if (posted.length !== 1 || posted[0].mid !== late.mid) fail("the server copy did not carry the client id: " + JSON.stringify(posted));
    await pb.waitForTimeout(1500);
    const still = await pb.evaluate((a) => window.ViktorychFriendP2P.thread(a).filter((m) => m.text === "late confirm"), A);
    if (still.length !== 1 || still[0].mid !== late.mid) fail("the late server copy was shown again: " + JSON.stringify(still));

    // The friend stops answering: the server takes over.
    await pb.evaluate(() => window.ViktorychFriendP2P.setEnabled(false));
    await pa.waitForFunction(() => window.ViktorychFriendP2P.peers().length === 0, null, { timeout: 8000 });
    const fallback = await pa.evaluate(async (b) => {
      const t = performance.now();
      const sent = await window.ViktorychFriendP2P.send(b, "via server");
      return { via: sent.via, ms: performance.now() - t };
    }, B);
    if (fallback.via !== "server" || fallback.ms > 1000) fail("no fast server fallback: " + JSON.stringify(fallback));
    const serverTexts = await pa.evaluate(() => window.__server.map((m) => m.text));
    if (serverTexts[serverTexts.length - 1] !== "via server") fail("the server copy is wrong: " + serverTexts.join("|"));
    const onB = await pb.waitForFunction((a) => window.ViktorychFriendP2P.thread(a).some((m) => m.text === "via server" && !m.mine), A, { timeout: 3000 }).then(() => true).catch(() => false);
    if (!onB) fail("the server copy did not reach the friend");

    // Offline outbox.
    await ctxA.setOffline(true);
    const queued = await pa.evaluate((b) => window.ViktorychFriendP2P.send(b, "later"), B);
    if (queued.via !== "outbox" || (await pa.evaluate(() => window.ViktorychFriendP2P.outbox().length)) !== 1) fail("offline messages are not kept");
    await ctxA.setOffline(false);
    await pa.waitForFunction(() => window.ViktorychFriendP2P.outbox().length === 0 && window.__server.some((m) => m.text === "later"), null, { timeout: 15000 });

    const html = await pa.evaluate(() => window.ViktorychFriendP2P.settingsHtml());
    if (!/data-friend-p2p="toggle"/.test(html) || !/IP address/.test(html)) fail("settings are missing");
    if (errors.length) fail("page errors: " + errors.join("; "));
    console.log("friend p2p ok");
  } finally {
    await browser.close();
    server.close();
  }
}
main().catch((err) => { if (!process.exitCode) { console.error(err); process.exitCode = 1; } });
