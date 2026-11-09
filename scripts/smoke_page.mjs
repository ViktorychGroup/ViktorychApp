#!/usr/bin/env node
/* Load the built site, or a live URL, in headless Chrome.
   Fails when a script or stylesheet is missing, the page throws,
   or the screen stays empty. Runs once with a fresh profile and
   once with saved data from before the presence deploy. */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8"
};

const OLD_STATE = `
localStorage.setItem("viktorychapp-account-v1", JSON.stringify({token:"t", account:{publicId:"123456789012", handle:"owner", name:"Owner"}}));
localStorage.setItem("viktorychapp-settings-v1", "{");
localStorage.setItem("viktorych-screen-v1", "{");
localStorage.setItem("viktorychapp-storage", "nope");
`;

const OWNER_STATE = `
localStorage.setItem("viktorychapp-account-v1", JSON.stringify({token:"t", account:{publicId:"123456789012", handle:"mirathorn", displayName:"Owner", owner:true}}));
`;

const OWNER_CHECK = `(() => {
  const accounts = window.ViktorychAccounts;
  const account = accounts && accounts.account ? accounts.account() : null;
  let settings = "";
  try { settings = accounts && accounts.settingsHtml ? accounts.settingsHtml() : ""; }
  catch (err) { settings = ""; }
  const shorts = window.ViktorychShorts || null;
  // The owner can switch Shorts off on the server (GET /v1/features "off").
  // Then the module must stay unloaded instead of being checked.
  const lazy = window.ViktorychLazy;
  const shortsOff = !!(lazy && lazy.serverOff && lazy.serverOff("shorts"));
  let unlocks = false;
  let shown = false;
  if (shorts && shorts.setUnlocked && shorts.isUnlocked) {
    shorts.setUnlocked(["sampleclip"]);
    unlocks = shorts.isUnlocked("sampleclip") === true && shorts.isUnlocked("otherclip") === false;
  }
  if (shorts && shorts.visible && account && account.owner) {
    const prev = window.VIKTORYCH_ACCOUNTS;
    window.VIKTORYCH_ACCOUNTS = Object.assign({}, prev || {}, { gate: true, api: "https://example.test", tiktokAudience: "owner" });
    try { shown = shorts.visible() === true; }
    finally { window.VIKTORYCH_ACCOUNTS = prev; }
  }
  return {
    owner: !!(account && account.owner === true && account.handle === "mirathorn"),
    health: settings.indexOf("TikTok health") >= 0,
    kept: settings.indexOf('data-acct="open-delete"') < 0,
    parked: window.SHORTS_ENABLED !== true,
    link: !!document.querySelector('a[href="#/shorts"], a[href^="#/shorts/"]'),
    shortsOff,
    shorts: !!(shorts && shorts.isUnlocked && shorts.setUnlocked),
    unlocks,
    shown
  };
})()`;

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
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = resolve(join(base, rel));
    if (file !== base && !file.startsWith(base + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function textOf(url) {
  const res = await fetch(url, { cache: "no-store" });
  return { status: res.status, text: await res.text(), type: res.headers.get("content-type") || "" };
}

function assetRefs(html) {
  const refs = [];
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(html))) {
    const raw = match[1];
    if (!raw || raw.startsWith("data:") || raw.startsWith("#") || raw.startsWith("mailto:")) continue;
    if (/^https?:/i.test(raw) || raw.startsWith("//")) continue;
    const clean = raw.split("#")[0].split("?")[0];
    if (!/\.(?:js|css)$/i.test(clean)) continue;
    refs.push(clean.replace(/^\.\//, ""));
  }
  return [...new Set(refs)];
}

async function checkAssets(pageUrl) {
  const base = new URL(pageUrl);
  const home = await textOf(base.href);
  if (home.status !== 200 || !home.text.includes("<html")) {
    throw new Error("page HTML status " + home.status);
  }
  const missing = [];
  for (const rel of assetRefs(home.text)) {
    const asset = new URL(rel, base);
    const res = await fetch(asset, { method: "GET", cache: "no-store" });
    if (res.status !== 200) missing.push(res.status + " " + asset.pathname);
    await res.arrayBuffer().catch(() => {});
  }
  if (missing.length) throw new Error("missing assets:\n" + missing.join("\n"));
  return assetRefs(home.text).length;
}

async function waitForAssets(pageUrl, tries) {
  let last = "not ready";
  // Same overall wait as one pause per try. Poll until the page is actually ready.
  const deadline = Date.now() + tries * 15000;
  while (Date.now() < deadline) {
    try {
      const count = await checkAssets(pageUrl);
      console.log("live assets " + count);
      return;
    } catch (err) {
      last = err.message || String(err);
      console.log("waiting for live page: " + last.split("\n")[0]);
      const pause = Math.min(1000, deadline - Date.now());
      if (pause > 0) await sleep(pause);
    }
  }
  throw new Error(last);
}

// A loaded runner often answers past the old 10s poll, and Chrome may bind a
// port other than the one we asked for. Read the port it actually opened.
const LAUNCH_ATTEMPTS = 3;
const LAUNCH_WAIT_MS = 30000;

function debuggerPort(text) {
  const match = String(text || "").match(/DevTools listening on ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/);
  if (!match) return 0;
  const port = Number(match[1]);
  return port > 0 && port < 65536 ? port : 0;
}

function activePort(dir) {
  try {
    const line = readFileSync(join(dir, "DevToolsActivePort"), "utf8").split(/\r?\n/, 1)[0].trim();
    if (!/^\d+$/.test(line)) return 0;
    const port = Number(line);
    return port > 0 && port < 65536 ? port : 0;
  } catch (err) {
    return 0;
  }
}

function killChrome(chrome) {
  try { chrome.kill("SIGKILL"); } catch (err) { /* already gone */ }
}

function cdpSocket(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  function send(method, params) {
    const msgId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
    });
  }
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
    } else if (msg.method) events.push(msg);
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  return { ws, send, events, opened };
}

async function launchChrome() {
  const dir = mkdtempSync(join(tmpdir(), "viktorych-smoke-"));
  const bin = chromeBin();
  let log = "";
  const chrome = spawn(bin, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-allow-origins=*",
    "--remote-debugging-port=0",
    `--user-data-dir=${dir}`,
    "about:blank"
  ], { stdio: ["ignore", "pipe", "pipe"] });
  chrome.on("error", () => { /* spawn failure is reported when the port never opens */ });
  const take = (chunk) => {
    log += chunk.toString();
    if (log.length > 16000) log = log.slice(-8000);
  };
  if (chrome.stdout) chrome.stdout.on("data", take);
  if (chrome.stderr) chrome.stderr.on("data", take);
  const deadline = Date.now() + LAUNCH_WAIT_MS;
  let ver = null;
  let port = 0;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null) break;
    port = debuggerPort(log) || activePort(dir);
    if (port) {
      try {
        const parsed = JSON.parse(await get(`http://127.0.0.1:${port}/json/version`));
        if (parsed && parsed.webSocketDebuggerUrl) {
          ver = parsed;
          break;
        }
      } catch (err) { /* announced, not accepting yet */ }
    }
    await sleep(200);
  }
  if (!ver) {
    killChrome(chrome);
    try { rmSync(dir, { recursive: true, force: true }); } catch (err) { /* profile still locked */ }
    const detail = log.trim().slice(-800);
    throw new Error("Chrome did not open a debugger (" + bin + ")" + (detail ? "\n" + detail : ""));
  }
  return { port, chrome, dir, ver };
}

async function openSession() {
  if (process.env.SMOKE_CDP) {
    const port = Number(new URL(process.env.SMOKE_CDP).port);
    const ver = JSON.parse(await get("http://127.0.0.1:" + port + "/json/version"));
    const browser = cdpSocket(ver.webSocketDebuggerUrl);
    await browser.opened;
    return { port, browser, external: true };
  }
  let last = null;
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
    let launched = null;
    try {
      launched = await launchChrome();
      const browser = cdpSocket(launched.ver.webSocketDebuggerUrl);
      await browser.opened;
      return { port: launched.port, browser, chrome: launched.chrome, dir: launched.dir, external: false };
    } catch (err) {
      last = err;
      if (launched) {
        killChrome(launched.chrome);
        try { rmSync(launched.dir, { recursive: true, force: true }); } catch (cleanErr) { /* profile still locked */ }
      }
      const message = err && err.message ? err.message : String(err);
      if (!/did not open a debugger/.test(message) || attempt === LAUNCH_ATTEMPTS) throw err;
      console.log("chrome launch " + attempt + " did not open a debugger, retrying");
    }
  }
  throw last;
}

async function closeSession(session) {
  if (!session) return;
  try { session.browser.ws.close(); } catch (err) { /* already closed */ }
  if (session.external) return;
  try { session.chrome.kill("SIGKILL"); } catch (err) { /* already gone */ }
  await sleep(300);
  try { rmSync(session.dir, { recursive: true, force: true }); } catch (err) { /* Chrome may still be releasing the profile */ }
}

function get(url) {
  return fetch(url).then((res) => res.text());
}

async function probe(session, pageUrl, opts) {
  let contextId = "";
  let page = null;
  try {
    const created = await session.browser.send("Target.createBrowserContext");
    contextId = created.browserContextId;
    const target = await session.browser.send("Target.createTarget", {
      url: "about:blank",
      browserContextId: contextId,
      width: opts.width,
      height: opts.height
    });
    let listed = null;
    for (let i = 0; i < 50; i++) {
      const targets = JSON.parse(await get(`http://127.0.0.1:${session.port}/json/list`));
      listed = targets.find((item) => item.id === target.targetId);
      if (listed && listed.webSocketDebuggerUrl) break;
      await sleep(100);
    }
    if (!listed || !listed.webSocketDebuggerUrl) {
      throw new Error("Chrome did not open a debugger (target)");
    }
    page = cdpSocket(listed.webSocketDebuggerUrl);
    await page.opened;
    const send = page.send;
    const events = page.events;
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Log.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: 1,
      mobile: false
    });
    if (opts.init) await send("Page.addScriptToEvaluateOnNewDocument", { source: opts.init });
    await send("Page.navigate", { url: pageUrl });
    const start = Date.now();
    while (Date.now() - start < 20000) {
      if (events.some((event) => event.method === "Page.loadEventFired")) break;
      await sleep(200);
    }
    const loadedAt = Date.now();
    let ownerInfo = null;
    if (opts.owner) {
      // The old probe always waited 3.5s and then up to 8s. Keep that ceiling.
      const ownerDeadline = loadedAt + 3500 + 8000;
      while (Date.now() < ownerDeadline) {
        const checked = await send("Runtime.evaluate", { expression: OWNER_CHECK, returnByValue: true });
        ownerInfo = checked && checked.result && checked.result.value || null;
        const shortsReady = ownerInfo && (ownerInfo.parked
          ? !ownerInfo.shorts && !ownerInfo.shown && !ownerInfo.link
          : (ownerInfo.shortsOff ? !ownerInfo.shorts : (ownerInfo.shorts && ownerInfo.unlocks && ownerInfo.shown)));
        if (ownerInfo && ownerInfo.owner && ownerInfo.health && ownerInfo.kept && shortsReady) break;
        await sleep(400);
      }
    } else {
      const settleEnd = loadedAt + 3500;
      while (Date.now() < settleEnd) {
        const peeked = await send("Runtime.evaluate", {
          expression: `(() => {
            const text = (document.body && document.body.innerText || "").replace(/\\s+/g, " ").trim();
            return { text: text.slice(0, 300), guard: !!document.getElementById("boot-guard") };
          })()`,
          returnByValue: true
        });
        const peek = peeked && peeked.result && peeked.result.value || {};
        if (peek.text && peek.text.length >= 8 && !peek.guard) break;
        await sleep(100);
      }
    }
    const info = await send("Runtime.evaluate", {
      expression: `(() => {
        const text = (document.body && document.body.innerText || "").replace(/\\s+/g, " ").trim();
        return { text: text.slice(0, 300), guard: !!document.getElementById("boot-guard"), children: (document.getElementById("app") || {}).childElementCount || 0 };
      })()`,
      returnByValue: true
    });
    const pageInfo = info && info.result && info.result.value || {};
    const exceptions = events.filter((event) => event.method === "Runtime.exceptionThrown").map((event) => {
      const detail = event.params.exceptionDetails || {};
      const ex = detail.exception || {};
      return (ex.description || detail.text || "exception").slice(0, 400);
    });
    const failed = events.filter((event) => event.method === "Network.responseReceived" && event.params.response && event.params.response.status >= 400).map((event) => {
      const response = event.params.response;
      return response.status + " " + response.url;
    }).filter((line) => {
      try {
        const asset = new URL(line.split(" ").slice(1).join(" "));
        const page = new URL(pageUrl);
        if (asset.origin !== page.origin) return false;
        return /\.(?:js|css)(?:$|\?)/i.test(asset.pathname) || asset.pathname === page.pathname;
      } catch (err) {
        return false;
      }
    });
    const problems = [];
    if (exceptions.length) problems.push("exception: " + exceptions[0]);
    if (failed.length) problems.push("request: " + failed[0]);
    if (pageInfo.guard) problems.push("boot guard is showing");
    if (!pageInfo.text || pageInfo.text.length < 8) problems.push("empty render");
    if (opts.owner) {
      const row = ownerInfo || {};
      if (!row.owner) problems.push("owner session was not recognized");
      if (!row.health) problems.push("owner menu missing");
      if (!row.kept) problems.push("owner account was deletable");
      if (row.parked) {
        if (row.shorts) problems.push("shorts loaded although the switch is off");
        if (row.shown) problems.push("shorts shown although the switch is off");
        if (row.link) problems.push("a Shorts link is visible although the switch is off");
      } else if (row.shortsOff) {
        if (row.shorts) problems.push("shorts loaded although the server switched it off");
      } else {
        if (!row.shorts) problems.push("shorts module missing");
        if (!row.unlocks) problems.push("shorts unlock list missing");
        if (!row.shown) problems.push("shorts hidden from the owner");
      }
    }
    return { problems, text: opts.owner ? "" : (pageInfo.text || ""), label: opts.label };
  } finally {
    if (page) {
      try { page.ws.close(); } catch (err) { /* already closed */ }
    }
    if (contextId) {
      try { await session.browser.send("Target.disposeBrowserContext", { browserContextId: contextId }); } catch (err) { /* context already gone */ }
    }
  }
}

async function main() {
  const site = arg("--site", "");
  const live = arg("--url", process.env.PAGE_URL || "");
  const tries = Number(arg("--retry", "1")) || 1;
  let url = live;
  let server = null;
  if (site) {
    const served = await serve(site);
    server = served.server;
    url = served.url;
  }
  if (!url) {
    console.error("pass --site or --url");
    process.exit(1);
  }
  try {
    if (tries > 1) await waitForAssets(url, tries);
    else {
      const count = await checkAssets(url);
      console.log("assets " + count);
    }
    const runs = [
      { label: "fresh-desktop", width: 1366, height: 768 },
      { label: "fresh-mobile", width: 412, height: 860 },
      { label: "old-state", width: 1366, height: 768, init: OLD_STATE },
      { label: "owner", width: 1366, height: 768, init: OWNER_STATE, owner: true }
    ];
    const problems = [];
    // A live check flakes (a page exception while a fresh service worker
    // reloads the tab, a slow CDN edge). A problem fails the run only when it
    // shows up again on every one of up to three fresh-profile attempts, so a
    // one-off flake cannot hold version.json back for hours.
    const attempts = Math.max(1, Number(arg("--attempts", live && !site ? "3" : "1")) || 1);
    const session = await openSession();
    try {
      const found = await Promise.all(runs.map(async (run) => {
        let kept = null;
        let result = null;
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            result = await probe(session, url, run);
          } catch (err) {
            const message = err && err.message ? err.message : String(err);
            if (!/did not open a debugger/.test(message)) throw err;
            result = await probe(session, url, run);
          }
          const now = result.problems.map((problem) => problem.replace(/^(exception|request): .*/, "$1"));
          kept = kept === null ? now : kept.filter((problem) => now.indexOf(problem) >= 0);
          if (!kept.length) break;
          console.log(run.label + " attempt " + (attempt + 1) + ": " + result.problems.join("; ").slice(0, 300));
        }
        console.log(run.label + ": " + (result.text || (run.owner ? "(owner checks only)" : "(empty)")).slice(0, 120));
        return kept.length ? result.problems.map((problem) => run.label + " " + problem) : [];
      }));
      found.forEach((lines) => problems.push(...lines));
    } finally {
      await closeSession(session);
    }
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
    console.log("smoke ok");
  } finally {
    if (server) server.close();
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
