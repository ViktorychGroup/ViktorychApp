#!/usr/bin/env node
/* Muted YouTube embed smoke. The official player must report ready
   on a desktop viewport and a phone viewport, with the iframe referrer
   policy set before src, and with no request to /v1/yt/.
   Playing (state 1) is required when YouTube allows the embed.
   Error 100, 101, or 150 is a refusal from YouTube. The test then
   requires the original watch link and does not try to get past it.
   A player that stays silent is opened once more. A broken embed is not.
   A missing direct file must mount that same player before the check.
   Records player states and error codes only. Does not read titles. */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VIDEO_ID = "M7lc1UVf-VE";
/* A stand-in for the embed player. It speaks the same widget messages the
   page already accepts, and it never contacts YouTube. */
const PLAYER_STUB = `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<script>
function reply(msg) {
  parent.postMessage(JSON.stringify(msg), "*");
}
window.addEventListener("message", function (event) {
  var data = event.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch (err) { return; }
  }
  if (!data || typeof data !== "object" || data.event !== "command") return;
  var arg = data.args && data.args[0];
  if (data.func === "addEventListener" && arg === "onReady") reply({ event: "onReady", info: {} });
  if (data.func === "playVideo") reply({ event: "onStateChange", info: 1 });
});
</script>
</body></html>`;
const PLAYER_STUB_B64 = Buffer.from(PLAYER_STUB, "utf8").toString("base64");
const PAGE = (name) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>embed</title>
</head>
<body>
<div id="slot" style="width:100%;max-width:640px;height:360px"></div>
<script src="/video-embed.js"></script>
<script>
window.__ready = false;
window.__playing = false;
window.__fileFailed = false;
window.__states = [];
window.__errors = [];
window.__policy = "";
window.__fallback = "";
var ID = ${JSON.stringify(VIDEO_ID)};
var E = window.ViktorychEmbed;
function mount(url) {
  var frame = document.createElement("iframe");
  frame.id = "ytf1";
  frame.style.cssText = "width:100%;height:360px;border:0";
  E.prepareFrame(frame, { url: url, title: "Video" });
  var bound = E.bindFrame(frame, { preview: true, muted: true });
  frame.addEventListener("load", function () {
    bound.nudge();
    setTimeout(bound.nudge, 400);
    setTimeout(bound.nudge, 1200);
  });
  var slot = document.getElementById("slot");
  slot.textContent = "";
  slot.appendChild(frame);
  frame.src = url;
  window.__policy = frame.getAttribute("referrerpolicy") || "";
}
window.addEventListener("message", function (event) {
  var host = String(event.origin || "");
  if (host.indexOf("youtube.com") < 0 && host.indexOf("youtube-nocookie.com") < 0) return;
  var data = event.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch (err) { return; }
  }
  if (!data || typeof data !== "object") return;
  if (data.event === "onReady") window.__ready = true;
  if (data.event === "onError") {
    var code = data.info;
    if (code && typeof code === "object") code = code.errorCode || code.code;
    var num = Number(code);
    if (isFinite(num)) window.__errors.push(num);
    if (num === 100 || num === 101 || num === 150) {
      var refused = E.nextAfterDirect({ code: num }, ID, { preview: true, origin: location.origin });
      window.__fallback = refused && refused.kind ? refused.kind : "";
    }
  }
  var state = null;
  if (data.event === "onStateChange") state = data.info;
  else if (data.info && typeof data.info === "object" && data.info.playerState != null) state = data.info.playerState;
  if (state == null || state === "") return;
  var n = Number(state);
  if (!isFinite(n)) return;
  window.__states.push(n);
  if (n === 1) window.__playing = true;
});
if (${name === "fallback" ? "true" : "false"}) {
  var video = document.createElement("video");
  video.muted = true;
  video.setAttribute("playsinline", "");
  video.src = "/missing.mp4";
  video.addEventListener("error", function () {
    window.__fileFailed = true;
    var next = E.nextAfterDirect({ code: 5 }, ID, { preview: true, origin: location.origin });
    if (!next || next.kind !== "iframe") { window.__playing = false; return; }
    mount(next.url);
  });
} else {
  mount(E.youtubeEmbed(ID, { preview: true, origin: location.origin }));
}
</script>
</body>
</html>`;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

function chromeBin() {
  const listed = [process.env.CHROME_PATH, process.env.CHROME_BIN, "google-chrome", "google-chrome-stable", "chrome", "chromium", "chromium-browser"];
  for (const bin of listed) {
    if (!bin) continue;
    if (bin.includes("/")) {
      try { statSync(bin); return bin; } catch (err) { continue; }
    }
    const found = spawnSync("which", [bin], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error("Chrome is not installed");
}

function serve(root) {
  const base = resolve(root);
  const helper = readFileSync(join(base, "video-embed.js"));
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/video-embed.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(helper);
      return;
    }
    if (url.pathname === "/play.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE("play"));
      return;
    }
    if (url.pathname === "/fallback.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE("fallback"));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("missing");
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      done({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function launch(width, height) {
  const dir = mkdtempSync(join(tmpdir(), "viktorych-yt-"));
  const port = 9400 + Math.floor(Math.random() * 400);
  const logPath = join(dir, "chrome.log");
  const logFd = openSync(logPath, "a");
  const bin = chromeBin();
  const chrome = spawn(bin, [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    `--window-size=${width},${height}`,
    "about:blank"
  ], { stdio: ["ignore", logFd, logFd] });
  let wsUrl = "";
  for (let i = 0; i < 50; i++) {
    try {
      const ver = JSON.parse(await (await fetch(`http://127.0.0.1:${port}/json/version`)).text());
      wsUrl = ver.webSocketDebuggerUrl;
      break;
    } catch (err) {
      await sleep(200);
    }
  }
  if (!wsUrl) {
    chrome.kill();
    let detail = "";
    try { detail = readFileSync(logPath, "utf8").trim().slice(-500); } catch (err) { detail = ""; }
    throw new Error("Chrome did not open a debugger" + (detail ? "\n" + detail : ""));
  }
  const targets = JSON.parse(await (await fetch(`http://127.0.0.1:${port}/json/list`)).text());
  const page = targets.find((item) => item.type === "page") || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  function waiterKey(msgId, sessionId) {
    return (sessionId || "") + ":" + msgId;
  }
  function send(method, params, sessionId) {
    const msgId = ++id;
    const payload = { id: msgId, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((done, reject) => {
      pending.set(waiterKey(msgId, sessionId), { done, reject });
      ws.send(JSON.stringify(payload));
    });
  }
  const embedPattern = /youtube(?:-nocookie)?\.com\/embed\//i;
  async function answerEmbed(params, sessionId) {
    const url = String((params.request && params.request.url) || "");
    if (embedPattern.test(url)) {
      await send("Fetch.fulfillRequest", {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: "text/html; charset=utf-8" },
          { name: "Cache-Control", value: "no-store" }
        ],
        body: PLAYER_STUB_B64
      }, sessionId);
      return;
    }
    await send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, sessionId);
  }
  function armFetch(sessionId) {
    return send("Fetch.enable", {
      patterns: [
        { urlPattern: "*://*.youtube.com/*", requestStage: "Request" },
        { urlPattern: "*://*.youtube-nocookie.com/*", requestStage: "Request" }
      ]
    }, sessionId).catch(() => {});
  }
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Target.attachedToTarget") {
      const child = msg.params && msg.params.sessionId;
      armFetch(child).finally(() => {
        send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => {});
      });
      return;
    }
    if (msg.method === "Fetch.requestPaused") {
      answerEmbed(msg.params || {}, msg.sessionId).catch(() => {});
      return;
    }
    const key = waiterKey(msg.id, msg.sessionId);
    if (msg.id && pending.has(key)) {
      const waiter = pending.get(key);
      pending.delete(key);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.done(msg.result);
    }
  });
  await new Promise((done, reject) => {
    ws.addEventListener("open", done);
    ws.addEventListener("error", reject);
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await armFetch();
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 800 });
  return {
    async open(url) {
      await send("Page.navigate", { url });
    },
    async status() {
      const info = await send("Runtime.evaluate", {
        expression: "({ ready: !!window.__ready, playing: !!window.__playing, fileFailed: !!window.__fileFailed, policy: window.__policy || '', states: (window.__states || []).slice(-8), errors: (window.__errors || []).slice(-4), fallback: window.__fallback || '', relay: performance.getEntriesByType('resource').some(function (row) { return String(row.name || '').indexOf('/v1/yt/') >= 0; }), helper: !!window.ViktorychEmbed })",
        returnByValue: true
      });
      return info.result && info.result.value ? info.result.value : {};
    },
    async close() {
      try { ws.close(); } catch (err) { /* already closed */ }
      try { chrome.kill(); } catch (err) { /* already closed */ }
      await sleep(300);
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (err) { /* profile files can linger after Chrome exits */ }
    }
  };
}

async function waitUntil(session, label, pred, ms) {
  const start = Date.now();
  let last = {};
  while (Date.now() - start < ms) {
    last = await session.status();
    if (pred(last)) return last;
    await sleep(500);
  }
  throw new Error(label + " did not reach playback: " + JSON.stringify({
    ready: !!last.ready,
    playing: !!last.playing,
    fileFailed: !!last.fileFailed,
    policy: last.policy || "",
    states: last.states || [],
    errors: last.errors || [],
    fallback: last.fallback || "",
    helper: !!last.helper
  }));
}

function accepted(row, needFile) {
  if (!row.helper || !row.ready || row.policy !== "strict-origin-when-cross-origin" || row.relay) return false;
  if (needFile && !row.fileFailed) return false;
  if (row.playing) return true;
  const errors = row.errors || [];
  const refused = errors.indexOf(150) >= 0 || errors.indexOf(101) >= 0 || errors.indexOf(100) >= 0;
  return refused && row.fallback === "link";
}

async function once(origin, path, width, height, label, needFile) {
  const session = await launch(width, height);
  try {
    await session.open(origin + path);
    return await waitUntil(session, label, (row) => accepted(row, needFile), 45000);
  } finally {
    await session.close();
  }
}

async function playCase(origin, path, width, height, label, needFile) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await once(origin, path, width, height, label, needFile);
      const outcome = result.playing ? "playing" : "refused";
      const prefix = needFile ? "fallback file-error then " : label + " ";
      console.log(prefix + outcome + " states=" + (result.states || []).join(",") + " errors=" + (result.errors || []).join(","));
      return;
    } catch (err) {
      last = err;
      if (attempt === 0) console.log(label + " stalled, trying the player again");
    }
  }
  throw last;
}

const root = resolve(arg("--root", "."));
const served = await serve(root);
try {
  await playCase(served.origin, "/play.html", 1366, 768, "desktop", false);
  await playCase(served.origin, "/play.html", 390, 844, "mobile", false);
  await playCase(served.origin, "/fallback.html", 1366, 768, "fallback", true);
} finally {
  served.server.close();
}
console.log("youtube embed smoke passed");
