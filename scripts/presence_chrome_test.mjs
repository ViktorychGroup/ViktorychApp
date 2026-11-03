// Presence rules, then a headless page for the dot, the status sheet, and
// the visible-only socket.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadStream, statSync } from "node:fs";
import {
  applyBeat,
  canSeeExact,
  clearAtFrom,
  lastSeenPhrase,
  shouldConnect,
  shouldWriteBeat
} from "../shared/presence.js";

const require = createRequire(import.meta.url);
const storage = require("../storage.js");
const root = new URL("..", import.meta.url).pathname;

const noon = new Date(2026, 5, 15, 12, 0, 0, 0).getTime();
assert.equal(lastSeenPhrase(noon - 30 * 1000, noon, true, "offline").key, "last seen just now");
assert.equal(lastSeenPhrase(noon - 5 * 60 * 1000, noon, true, "offline").key, "last seen {count} min ago");
assert.equal(lastSeenPhrase(noon - 5 * 60 * 1000, noon, true, "offline").vars.count, 5);
assert.deepEqual(lastSeenPhrase(new Date(2026, 5, 15, 9, 3).getTime(), noon, true, "offline"), { key: "last seen today at {time}", vars: { time: "09:03" } });
assert.equal(lastSeenPhrase(new Date(2026, 5, 14, 18, 0).getTime(), noon, true, "offline").key, "last seen yesterday");
assert.equal(lastSeenPhrase(new Date(2026, 5, 13, 12, 0).getTime(), noon, true, "offline").key, "last seen recently");
assert.equal(lastSeenPhrase(new Date(2026, 5, 10, 12, 0).getTime(), noon, true, "offline").key, "last seen within a week");
assert.equal(lastSeenPhrase(new Date(2026, 4, 1, 12, 0).getTime(), noon, true, "offline").key, "last seen a long time ago");
assert.equal(lastSeenPhrase(noon - 5 * 60 * 1000, noon, false, "offline").key, "last seen recently");
assert.equal(lastSeenPhrase(noon, noon, true, "online").key, "Online");
assert.equal(canSeeExact("everyone", "follows", true, false, false), true);
assert.equal(canSeeExact("everyone", "follows", false, false, false), false);
assert.equal(canSeeExact("nobody", "everyone", true, true, false), false);
assert.equal(canSeeExact("everyone", "nobody", true, true, false), false);
assert.equal(canSeeExact("nobody", "nobody", false, false, true), true);
assert.equal(canSeeExact("everyone", "followers", true, false, false), true);
assert.equal(canSeeExact("everyone", "followers", false, true, false), false);
assert.equal(canSeeExact("everyone", "mutuals", true, false, false), false);
assert.equal(canSeeExact("everyone", "mutuals", false, false, false, { friends: true }), true);
assert.equal(canSeeExact("everyone", "lists", false, false, false, { targetList: true }), true);
assert.equal(canSeeExact("nobody", "everyone", true, true, false, { reciprocal: false }), true);
assert.equal(canSeeExact("nobody", "everyone", true, true, false, { reciprocal: true }), false);
const prev = { preference: "online", activity: "active", seen_privacy: "everyone", last_beat: 1000, last_seen: 1000 };
assert.equal(shouldWriteBeat(prev, applyBeat(prev, "active", 11000), 11000), false);
assert.equal(shouldWriteBeat(prev, applyBeat(prev, "idle", 11000), 11000), true);
assert.equal(shouldWriteBeat(prev, applyBeat(prev, "active", 1000 + 60000), 1000 + 60000), true);
assert.equal(clearAtFrom("30m", 1000), 1000 + 30 * 60 * 1000);
assert.equal(clearAtFrom("never", 1000), 0);
assert.equal(shouldConnect("visible"), true);
assert.equal(shouldConnect("hidden"), false);
assert.equal(storage.shouldCacheFeed("https://accounts.example/v1/presence?ids=1"), false);
assert.equal(storage.shouldCacheFeed("https://accounts.example/v1/channel?ticket=1"), false);
assert.equal(storage.shouldCacheFeed("https://viktorych.example/feeds.json"), true);
const discord = readFileSync(join(root, "discord-ui.js"), "utf8");
assert.ok(discord.includes("ViktorychPresence.wrap"));
assert.ok(discord.includes("dmSubHtml"));

function which(name) {
  const found = spawnSync("which", [name], { encoding: "utf8" });
  const path = (found.stdout || "").trim();
  return found.status === 0 && path ? path : "";
}

function chromeBin() {
  const named = [process.env.CHROME, process.env.CHROME_PATH, process.env.CHROME_BIN].filter(Boolean);
  for (const bin of named) {
    try { statSync(bin); return bin; } catch (err) { /* try the next candidate */ }
  }
  // setup-chrome puts its binary on PATH as `chrome`. The runner's
  // google-chrome wrapper stays first for `which google-chrome` and never
  // opens a DevTools port, so this check used to time out and skip deploy.
  return which("chrome") || which("google-chrome") || which("google-chrome-stable") || which("chromium") || which("chromium-browser");
}

async function readVersion(port) {
  for (const host of ["127.0.0.1", "localhost"]) {
    try {
      const res = await fetch("http://" + host + ":" + port + "/json/version");
      if (!res.ok) continue;
      const version = await res.json();
      if (version && version.webSocketDebuggerUrl) return version;
    } catch (err) { /* this host is not listening yet */ }
  }
  return null;
}

function readActivePort(profile) {
  try {
    const line = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0].trim();
    return line || "";
  } catch (err) { return ""; }
}

async function launchChrome(bin) {
  let lastLog = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const profile = mkdtempSync(join(tmpdir(), "presence-chrome-"));
    const debugPort = 9400 + Math.floor(Math.random() * 500);
    const logPath = join(profile, "chrome.log");
    const logFd = openSync(logPath, "a");
    const child = spawn(bin, [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--remote-allow-origins=*",
      "--remote-debugging-port=" + debugPort,
      "--user-data-dir=" + profile,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank"
    ], { stdio: ["ignore", logFd, logFd] });
    closeSync(logFd);
    const started = Date.now();
    let version = null;
    while (Date.now() - started < 20000) {
      if (child.exitCode != null) break;
      version = await readVersion(debugPort);
      if (version) return { child, version, profile };
      const active = readActivePort(profile);
      if (active && active !== String(debugPort)) {
        version = await readVersion(active);
        if (version) return { child, version, profile };
      }
      await new Promise((done) => setTimeout(done, 200));
    }
    try { lastLog = readFileSync(logPath, "utf8").trim().slice(-400); } catch (err) { lastLog = ""; }
    try { child.kill("SIGKILL"); } catch (err) { /* already gone */ }
    await new Promise((done) => setTimeout(done, 200));
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (err) { /* the profile can still be busy */ }
  }
  const detail = lastLog ? " " + lastLog.replace(/\s+/g, " ") : "";
  throw new Error("chrome " + bin + detail);
}

const pageHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/presence.css">
</head>
<body>
<div id="app"></div>
<div class="hcard" id="card"></div>
<script src="/i18n.js"></script>
<script src="/i18n/en.js"></script>
<script>
window.__vis = "hidden";
try {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: function () { return window.__vis; } });
} catch (err) { window.__visLock = String(err); }
window.__sockets = [];
function FakeSocket(url) {
  window.__sockets.push(String(url));
  this.readyState = 0;
  this.listeners = {};
}
FakeSocket.prototype.addEventListener = function (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); };
FakeSocket.prototype.send = function () {};
FakeSocket.prototype.close = function () {
  this.readyState = 3;
  (this.listeners.close || []).forEach(function (fn) { fn(); });
};
window.WebSocket = FakeSocket;
window.ViktorychAccounts = {
  token: function () { return "tok"; },
  currentApi: function () { return "https://accounts.test"; },
  account: function () { return { publicId: "123456789012" }; },
  requestRender: function () {},
  call: function (path, opts) {
    opts = opts || {};
    if (path === "/v1/channel/ticket") return Promise.resolve({ status: 200, ticket: "ct1.test" });
    if (path === "/v1/store/catalog") return Promise.resolve({ status: 200, emojis: [{ id: "rocket", emoji: "\u{1F680}", name: "Rocket status", owned: true }, { id: "gem", emoji: "\u{1F48E}", name: "Gem status", owned: false }] });
    if (String(path).indexOf("/v1/presence") === 0 && opts.method === "PATCH") {
      var body = opts.body || {};
      window.__patches = (window.__patches || []).concat([body]);
      if (body.status) window.__status = body.status;
      var status = window.__status || {};
      return Promise.resolve({
        status: 200,
        id: "123456789012",
        state: body.preference || "online",
        preference: body.preference || "online",
        seenPrivacy: body.seenPrivacy || "everyone",
        statusAudience: body.statusAudience || "everyone",
        statusLists: body.statusLists || [],
        exact: true,
        lastSeen: Date.now(),
        emoji: status.emoji || "",
        text: status.text || "",
        clearAt: 0
      });
    }
    return Promise.resolve({ status: 200, id: "123456789012", state: "online", preference: "online", seenPrivacy: "everyone", exact: true, lastSeen: Date.now(), emoji: "", text: "", ok: true, coalesced: false });
  }
};
</script>
<script type="module" src="/presence.js"></script>
</body>
</html>`;

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/presence-test.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(pageHtml);
      return;
    }
    const file = join(root, decodeURIComponent(url.pathname.replace(/^\/+/, "")));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    let size = 0;
    try { size = statSync(file).size; }
    catch (err) {
      res.writeHead(404);
      res.end();
      return;
    }
    const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream";
    res.writeHead(200, { "content-type": type + "; charset=utf-8", "content-length": String(size), "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function cdpMessage(raw) {
  const data = raw && typeof raw === "object" && "data" in raw ? raw.data : raw;
  const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  return JSON.parse(text);
}

async function main() {
  const bin = chromeBin();
  if (!bin) throw new Error("chrome");
  const live = await startServer();
  const port = live.address().port;
  let child = null;
  let profile = "";
  try {
    const launched = await launchChrome(bin);
    child = launched.child;
    profile = launched.profile;
    const version = launched.version;
    const browser = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      browser.addEventListener("open", resolve);
      browser.addEventListener("error", () => reject(new Error("browser")));
    });
    const created = await new Promise((resolve, reject) => {
      const onMessage = (raw) => {
        let message;
        try { message = cdpMessage(raw); } catch (err) { return; }
        if (message.id !== 1) return;
        browser.removeEventListener("message", onMessage);
        if (!message.result || !message.result.targetId) reject(new Error("target"));
        else resolve(message.result.targetId);
      };
      browser.addEventListener("message", onMessage);
      browser.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: "http://127.0.0.1:" + port + "/presence-test.html" } }));
    });
    const sessionId = await new Promise((resolve, reject) => {
      const onMessage = (raw) => {
        let message;
        try { message = cdpMessage(raw); } catch (err) { return; }
        if (message.id !== 2) return;
        browser.removeEventListener("message", onMessage);
        if (!message.result || !message.result.sessionId) reject(new Error("session"));
        else resolve(message.result.sessionId);
      };
      browser.addEventListener("message", onMessage);
      browser.send(JSON.stringify({ id: 2, method: "Target.attachToTarget", params: { targetId: created, flatten: true } }));
    });
    const send = (id, method, params) => browser.send(JSON.stringify({ id, sessionId, method, params }));
    async function evaluate(expression) {
      const id = 10 + Math.floor(Math.random() * 100000);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("eval")), 8000);
        const onMessage = (raw) => {
          let message;
          try { message = cdpMessage(raw); } catch (err) { return; }
          if (message.id !== id) return;
          clearTimeout(timer);
          browser.removeEventListener("message", onMessage);
          if (message.result && message.result.exceptionDetails) reject(new Error(JSON.stringify(message.result.exceptionDetails).slice(0, 800)));
          else resolve(message.result && message.result.result && message.result.result.value);
        };
        browser.addEventListener("message", onMessage);
        send(id, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      });
    }
    let ready = null;
    const waitFrom = Date.now();
    while (Date.now() - waitFrom < 8000) {
      try {
        ready = await evaluate("({href:location.href,presence:!!window.ViktorychPresence,sockets:(window.__sockets||[]).length,vis:document.visibilityState||'',lock:window.__visLock||''})");
      } catch (err) { ready = null; }
      if (ready && ready.presence) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!ready || !ready.presence) throw new Error("presence " + JSON.stringify(ready));
    if (ready.vis !== "hidden" || ready.sockets !== 0) throw new Error("hidden socket " + JSON.stringify(ready));
    const opened = await evaluate("window.__vis='visible';document.dispatchEvent(new Event('visibilitychange'));new Promise(function(resolve){setTimeout(function(){resolve(window.__sockets.slice())},200)})");
    if (!opened || !opened.length || opened[0].indexOf("ticket=") < 0) throw new Error("visible socket");
    const colors = await evaluate(`(function(){
      var host = document.getElementById("card");
      host.innerHTML = window.ViktorychPresence.wrap("123456789012", '<span class="ava"></span>');
      var dot = host.querySelector(".presence-dot");
      function sample(theme, state) {
        if (theme) document.documentElement.setAttribute("data-theme", theme);
        else document.documentElement.removeAttribute("data-theme");
        dot.parentNode.setAttribute("data-presence", state);
        var style = getComputedStyle(dot);
        return { bg: style.backgroundColor, ring: style.borderTopColor };
      }
      return {
        online: sample("", "online"),
        idle: sample("dim", "idle"),
        dnd: sample("default", "dnd"),
        off: sample("", "offline"),
        dimOff: sample("dim", "offline"),
        lightOff: sample("default", "offline")
      };
    })()`);
    assert.equal(colors.online.bg, "rgb(0, 186, 124)");
    assert.equal(colors.online.ring, "rgb(0, 0, 0)");
    assert.equal(colors.idle.bg, "rgb(245, 166, 35)");
    assert.equal(colors.idle.ring, "rgb(21, 32, 43)");
    assert.equal(colors.dnd.bg, "rgb(244, 33, 46)");
    assert.equal(colors.dnd.ring, "rgb(255, 255, 255)");
    assert.equal(colors.off.bg, "rgb(113, 118, 123)");
    assert.equal(colors.dimOff.bg, "rgb(139, 152, 165)");
    assert.equal(colors.lightOff.bg, "rgb(83, 100, 113)");
    const sheet = await evaluate(`(function(){
      window.ViktorychPresence.open(document.body);
      document.querySelector('[data-value="dnd"]').click();
      var muted = window.ViktorychPresence.mutesNotices();
      document.querySelector("[data-presence-emoji]").value = "✨";
      document.querySelector("[data-presence-text]").value = "reading";
      document.querySelector('[data-presence="save"]').click();
      return new Promise(function(resolve){
        setTimeout(function(){
          var line = window.ViktorychPresence.linesHtml("123456789012");
          var noon = new Date(2026, 5, 15, 12, 0, 0, 0).getTime();
          var spoken = window.PresenceRules.lastSeenPhrase(noon - 5 * 60 * 1000, noon, true, "offline");
          resolve({
            muted: muted,
            chime: window.ViktorychPresence.chime() === undefined,
            line: line,
            phrase: window.t(spoken.key, spoken.vars),
            sheet: !document.querySelector(".presence-sheet").hidden,
            wide: document.querySelector(".presence-sheet").className
          });
        }, 80);
      });
    })()`);
    assert.equal(sheet.muted, true);
    assert.equal(sheet.chime, true);
    assert.ok(sheet.line.includes("reading"));
    assert.equal(sheet.phrase, "last seen 5 min ago");
    assert.equal(sheet.sheet, true);
    const status = await evaluate(`(function(){
      var picks = Array.from(document.querySelectorAll('[data-presence="pick-emoji"]')).map(function (b) { return b.textContent; });
      var more = !!document.querySelector('a[href="#/store/emojis"]');
      var audience = document.querySelectorAll('[data-presence="status-audience"]').length;
      document.querySelector('[data-presence="pick-emoji"]').click();
      var picked = document.querySelector("[data-presence-emoji]").value;
      document.querySelector('[data-presence="status-audience"][data-value="followers"]').click();
      return new Promise(function(resolve){
        setTimeout(function(){
          var host = document.getElementById("card");
          host.innerHTML = window.ViktorychPresence.wrap("123456789012", '<span class="ava"></span>');
          var badge = host.querySelector(".status-badge");
          var dot = host.querySelector(".presence-dot");
          var last = window.__patches[window.__patches.length - 1] || {};
          resolve({
            picks: picks,
            more: more,
            audience: audience,
            picked: picked,
            sent: last.statusAudience || "",
            pressed: document.querySelector('[data-presence="status-audience"][data-value="followers"]').getAttribute("aria-pressed"),
            badge: badge ? badge.textContent : "",
            dot: getComputedStyle(dot).display
          });
        }, 80);
      });
    })()`);
    assert.deepEqual(status.picks, ["\u{1F680}"]);
    assert.equal(status.more, true);
    assert.equal(status.audience, 6);
    assert.equal(status.picked, "\u{1F680}");
    assert.equal(status.sent, "followers");
    assert.equal(status.pressed, "true");
    assert.equal(status.badge, "\u2728");
    assert.equal(status.dot, "none");
    const hiddenAgain = await evaluate("var n=window.__sockets.length;window.__vis='hidden';document.dispatchEvent(new Event('visibilitychange'));n");
    const after = await evaluate("window.__sockets.length");
    if (after !== hiddenAgain) throw new Error("hidden reconnect");
    browser.close();
    console.log("presence chrome check passed");
  } finally {
    try { child.kill("SIGKILL"); } catch (err) { /* already gone */ }
    try { live.close(); } catch (err) { /* already closed */ }
    await new Promise((done) => setTimeout(done, 200));
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (err) { /* the profile can still be busy */ }
  }
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
