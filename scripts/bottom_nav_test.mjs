import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function mime(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function chromeBin() {
  const named = [process.env.CHROME_PATH, process.env.CHROME_BIN].filter(Boolean);
  for (const bin of named) {
    if (fs.existsSync(bin)) return bin;
  }
  try {
    const found = execFileSync("bash", ["-lc", "command -v google-chrome || command -v google-chrome-stable || command -v chrome || command -v chromium || command -v chromium-browser"], { encoding: "utf8" }).trim().split("\n")[0];
    if (found) return found;
  } catch (err) { /* fall through to known paths */ }
  const list = [
    "/usr/local/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];
  return list.find((bin) => fs.existsSync(bin)) || "";
}

function logTail(logPath) {
  try {
    return fs.readFileSync(logPath, "utf8").trim().slice(-500);
  } catch (err) {
    return "";
  }
}

async function readVersion(port) {
  const res = await fetch("http://127.0.0.1:" + port + "/json/version");
  if (!res.ok) return null;
  const version = await res.json();
  if (!version || !version.webSocketDebuggerUrl) return null;
  return version;
}

// Headless Chrome can leave "DevTools listening on" buffered when stderr is a
// pipe, so the port is chosen here and the debugger is discovered from
// /json/version (and DevToolsActivePort if Chrome bound a different port).
async function launchChrome(bin) {
  let lastLog = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bnav-"));
    const debugPort = 9400 + Math.floor(Math.random() * 500);
    const logPath = path.join(profile, "chrome.log");
    const logFd = fs.openSync(logPath, "a");
    const chrome = spawn(bin, [
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
    fs.closeSync(logFd);
    const started = Date.now();
    while (Date.now() - started < 20000) {
      if (chrome.exitCode != null) break;
      try {
        const version = await readVersion(debugPort);
        if (version) {
          return { chrome, version, debugPort: String(new URL(version.webSocketDebuggerUrl).port) };
        }
      } catch (err) { /* debugger not up yet */ }
      try {
        const active = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0].trim();
        if (active && active !== String(debugPort)) {
          const version = await readVersion(active);
          if (version) {
            return { chrome, version, debugPort: String(new URL(version.webSocketDebuggerUrl).port) };
          }
        }
      } catch (err) { /* port file not written yet */ }
      await sleep(100);
    }
    lastLog = logTail(logPath);
    try { chrome.kill("SIGKILL"); } catch (err) { /* already gone */ }
    await new Promise((resolve) => {
      if (chrome.exitCode != null) { resolve(); return; }
      chrome.once("exit", () => resolve());
      setTimeout(resolve, 1000);
    });
  }
  fail("Chrome did not open a DevTools port\n" + lastLog);
}

function openCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const waits = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const job = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) job.reject(new Error(JSON.stringify(msg.error)));
      else job.resolve(msg.result || {});
      return;
    }
    waits.slice().forEach((job) => {
      if (job.method === msg.method) {
        waits.splice(waits.indexOf(job), 1);
        job.resolve(msg.params || {});
      }
    });
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("cdp socket failed")));
  });
  return {
    ready,
    send(method, params, sessionId) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const packet = { id, method, params: params || {} };
        if (sessionId) packet.sessionId = sessionId;
        ws.send(JSON.stringify(packet));
      });
    },
    until(method) {
      return new Promise((resolve) => waits.push({ method, resolve }));
    },
    close() { try { ws.close(); } catch (err) { /* already closed */ } }
  };
}

const INJECT = `
try { localStorage.setItem("superintelapp-lang", "en"); } catch (e) {}
try { localStorage.setItem("viktorychapp-lang-user-picked", "1"); } catch (e) {}
try {
  if (!localStorage.getItem("viktorychapp-settings-v1")) {
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({
      version: 1,
      bellRead: 0,
      bellNotes: [{ id: "note-1", at: 1893456000000, hash: "#/", text: "Hello", handle: "ada", name: "Ada" }]
    }));
  }
} catch (e) {}
(function () {
  var api = {
    visible: function () { return true; },
    hide: function () {},
    unmount: function () {},
    mount: function () {},
    pull: function () { return Promise.resolve(); },
    bind: function () {},
    page: function () { return ""; },
    isLocked: function () { return false; },
    isUnlocked: function () { return true; }
  };
  Object.defineProperty(window, "ViktorychShorts", {
    configurable: true,
    enumerable: true,
    get: function () { return api; },
    set: function (next) {
      if (next && typeof next === "object") {
        api = next;
        api.visible = function () { return true; }
      }
    }
  });
})();
if (navigator.serviceWorker) {
  navigator.serviceWorker.register = function () {
    return Promise.resolve({ active: null, update: function () { return Promise.resolve(); } });
  };
}
`;

async function main() {
  const bin = chromeBin();
  if (!bin) fail("Google Chrome was not found");
  const server = await startServer();
  const port = server.address().port;
  const origin = "http://127.0.0.1:" + port;
  const launched = await launchChrome(bin);
  const chrome = launched.chrome;
  const debugPort = launched.debugPort;
  const version = launched.version;
  const stop = () => {
    try { chrome.kill("SIGKILL"); } catch (err) { /* gone */ }
    try { server.close(); } catch (err) { /* gone */ }
  };
  process.on("exit", stop);
  if (!version || !version.webSocketDebuggerUrl) fail("No browser debugger url");
  const browser = openCdp(version.webSocketDebuggerUrl);
  await browser.ready;
  const created = await browser.send("Target.createTarget", { url: "about:blank" });
  const list = await fetch("http://127.0.0.1:" + debugPort + "/json/list").then((res) => res.json());
  const pageInfo = list.find((item) => item.id === created.targetId);
  if (!pageInfo) fail("Page target missing");
  const page = openCdp(pageInfo.webSocketDebuggerUrl);
  await page.ready;

  async function evaluate(expression) {
    const result = await page.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
      fail(desc || result.exceptionDetails.text || expression.slice(0, 180));
    }
    return result.result ? result.result.value : undefined;
  }

  async function waitFor(expression, label) {
    const start = Date.now();
    let last = "";
    while (Date.now() - start < 40000) {
      try {
        const value = await evaluate(expression);
        if (value) return value;
        last = JSON.stringify(value);
      } catch (err) {
        last = err.message;
      }
      await sleep(150);
    }
    fail("Timed out waiting for " + label + " (" + last + ")");
  }

  async function viewport(width, height, landscape) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: true,
      screenOrientation: landscape
        ? { type: "landscapePrimary", angle: 90 }
        : { type: "portraitPrimary", angle: 0 }
    });
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "hover", value: "none" },
        { name: "pointer", value: "coarse" }
      ]
    });
  }

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });
  await viewport(390, 844, false);
  await page.send("Page.navigate", { url: origin + "/#/explore" });

  const barExpr = `JSON.stringify([...document.querySelectorAll("nav.bottom-nav a")].map((a) => a.getAttribute("href")))`;
  await waitFor(`document.querySelector("nav.bottom-nav a") && ${barExpr}.length > 2`, "bottom bar");
  let prev = "";
  let steady = 0;
  const settleStart = Date.now();
  while (Date.now() - settleStart < 20000) {
    const now = await evaluate(barExpr);
    if (now && now === prev && now !== "[]") {
      steady += 1;
      if (steady >= 3) break;
    } else steady = 0;
    prev = now;
    await sleep(200);
  }

  const portrait = await evaluate(`(() => {
    const bar = document.querySelector("nav.bottom-nav");
    const explore = document.querySelector('nav.bottom-nav a[href="#/explore"]');
    const home = document.querySelector('nav.bottom-nav a[href="#/"]');
    const land = document.querySelector("header.nav.nav-land");
    return {
      bar: getComputedStyle(bar).display,
      exploreOn: explore.classList.contains("on") && explore.getAttribute("aria-current") === "page",
      homeOn: home.classList.contains("on") || home.getAttribute("aria-current") === "page",
      badge: !!document.querySelector('nav.bottom-nav a[href="#/notifications"] .nav-badge'),
      land: getComputedStyle(land).display,
      hrefs: ${barExpr}
    };
  })()`);
  if (portrait.bar !== "flex") fail("Portrait bottom bar display is " + portrait.bar);
  if (!portrait.exploreOn || portrait.homeOn) fail("Explore is not the active bottom item: " + JSON.stringify(portrait));
  if (!portrait.badge) fail("Notification badge missing");
  if (portrait.land !== "none") fail("Landscape sidebar is visible in portrait");
  const initial = JSON.parse(portrait.hrefs);
  const expectedDefault = ["#/", "#/explore", "#/tv", "#/communities", "#/notifications", "#/messages"];
  if (JSON.stringify(initial) !== JSON.stringify(expectedDefault)) fail("Default bar " + portrait.hrefs);

  await evaluate(`location.hash = "#/settings/display/navigation"; true`);
  await waitFor(`document.querySelector(".bottom-nav-preview")`, "customize screen");
  const screen = await evaluate(`(() => {
    const home = document.querySelector('[data-act="bottom-nav-toggle"][data-id="home"]');
    const help = document.querySelector(".bnav-screen > .phandle");
    return {
      enabled: window.SHORTS_ENABLED === true,
      shorts: !!document.querySelector('[data-bottom-id="shorts"]'),
      vault: !!document.querySelector('[data-bottom-id="vault"]'),
      homeOff: !!(home && home.disabled && home.getAttribute("aria-checked") === "true"),
      help: help ? help.textContent : "",
      preview: [...document.querySelectorAll("[data-preview-id]")].map((el) => el.getAttribute("data-preview-id")).join(",")
    };
  })()`);
  if (screen.enabled) {
    if (!screen.shorts) fail("Shorts row missing for the owner");
  } else if (screen.shorts) fail("Shorts row is visible while Shorts is turned off");
  if (screen.vault) fail("Vault row is visible while signed out");
  if (!screen.homeOff) fail("Home switch can be turned off");
  if (!screen.help.includes("Home always stays")) fail("Help text missing: " + screen.help);
  if (screen.preview !== "home,explore,tv,communities,notifications,messages") fail("Preview " + screen.preview);

  const dragged = await evaluate(`(() => {
    const before = [...document.querySelectorAll("[data-bottom-id]")].map((row) => row.getAttribute("data-bottom-id"));
    const grip = document.querySelector('[data-drag-bottom="games"]');
    const target = document.querySelector('[data-bottom-id="feeds"]');
    const g = grip.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const fire = (type, x, y, buttons) => {
      const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", clientX: x, clientY: y, button: 0, buttons: buttons });
      (type === "pointerdown" ? grip : document).dispatchEvent(event);
    };
    fire("pointerdown", g.left + 8, g.top + 8, 1);
    fire("pointermove", g.left + 8, g.top + 40, 1);
    fire("pointermove", t.left + 20, t.top + 8, 1);
    fire("pointerup", t.left + 20, t.top + 8, 0);
    const after = [...document.querySelectorAll("[data-bottom-id]")].map((row) => row.getAttribute("data-bottom-id"));
    return { before: before.join(","), after: after.join(",") };
  })()`);
  const gamesAt = dragged.after.split(",").indexOf("games");
  const feedsAt = dragged.after.split(",").indexOf("feeds");
  if (gamesAt < 0 || feedsAt < 0 || gamesAt > feedsAt) fail("Touch drag did not move Games above Feeds: " + JSON.stringify(dragged));

  await evaluate(`document.querySelector('[data-act="bottom-nav-move"][data-id="messages"][data-dir="-1"]').click(); true`);
  await waitFor(`${barExpr}.includes("#/messages")`, "reordered bar");
  const moved = await evaluate(`(() => ({
    bar: ${barExpr},
    preview: [...document.querySelectorAll("[data-preview-id]")].map((el) => el.getAttribute("data-preview-id")).join(",")
  }))()`);
  const movedHrefs = JSON.parse(moved.bar);
  const movedWant = ["#/", "#/explore", "#/tv", "#/communities", "#/messages", "#/notifications"];
  if (JSON.stringify(movedHrefs) !== JSON.stringify(movedWant)) fail("Move up left the bar as " + moved.bar);
  if (moved.preview !== "home,explore,tv,communities,messages,notifications") fail("Preview did not follow the move: " + moved.preview);

  await evaluate(`document.querySelector('[data-act="bottom-nav-toggle"][data-id="tv"]').click(); true`);
  await waitFor(`!document.querySelector('nav.bottom-nav a[href="#/tv"]')`, "hidden tv");
  const hiddenBar = JSON.parse(await evaluate(barExpr));
  const hiddenWant = ["#/", "#/explore", "#/communities", "#/messages", "#/notifications"];
  if (JSON.stringify(hiddenBar) !== JSON.stringify(hiddenWant)) fail("Bar after hiding TV " + JSON.stringify(hiddenBar));
  if (await evaluate(`!!document.querySelector('.bottom-nav-preview [data-preview-id="tv"]')`)) fail("Preview still shows TV");
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll("[data-act=drawer]")].find((el) => getComputedStyle(el).display !== "none");
    btn.click();
    return true;
  })()`);
  await waitFor(`document.querySelector('.drawer a[href="#/tv"]')`, "drawer tv");
  if (!(await evaluate(`!!document.querySelector('.drawer a[href="#/feeds"]')`))) fail("Hidden Feeds is missing from the drawer");

  const stored = await evaluate(`(() => {
    const data = JSON.parse(localStorage.getItem("viktorychapp-settings-v1"));
    return { custom: data.bottomNavCustom === true, hidden: (data.bottomNav.hidden || []).includes("tv") };
  })()`);
  if (!stored.custom || !stored.hidden) fail("Settings were not saved: " + JSON.stringify(stored));

  // Mark the old page so the wait below can't pass before the reload swaps documents.
  await evaluate(`window.__beforeReload = true; true`);
  await page.send("Page.reload", { ignoreCache: true });
  await waitFor(`!window.__beforeReload && document.querySelector("nav.bottom-nav a") && window.ViktorychAccounts && window.ViktorychAccounts.snapshotFrom`, "bar after reload");
  const reloaded = JSON.parse(await evaluate(barExpr));
  if (JSON.stringify(reloaded) !== JSON.stringify(hiddenWant)) fail("Reload lost the bar: " + JSON.stringify(reloaded));
  const still = await evaluate(`JSON.parse(localStorage.getItem("viktorychapp-settings-v1")).bottomNavCustom === true`);
  if (!still) fail("bottomNavCustom did not survive reload");

  const accounts = await evaluate(`(() => {
    const api = window.ViktorychAccounts;
    const saved = JSON.parse(localStorage.getItem("viktorychapp-settings-v1"));
    const snap = api.snapshotFrom(saved);
    const remoteWins = api.mergePayload(
      { bottomNavCustom: false, bottomNav: { order: ["home", "explore"], hidden: [] }, follows: [] },
      { bottomNavCustom: true, bottomNav: { order: ["messages", "home"], hidden: ["tv"] }, follows: [] }
    );
    const localWins = api.mergePayload(
      { bottomNavCustom: true, bottomNav: { order: ["explore", "home"], hidden: ["tv"] }, follows: [] },
      { bottomNavCustom: true, bottomNav: { order: ["messages", "home"], hidden: [] }, follows: [] }
    );
    return {
      snap: !!(snap.bottomNav && snap.bottomNavCustom === true && snap.bottomNav.hidden.includes("tv")),
      remote: remoteWins.bottomNav && remoteWins.bottomNav.order[0] === "messages",
      local: localWins.bottomNav && localWins.bottomNav.order[0] === "explore"
    };
  })()`);
  if (!accounts.snap || !accounts.remote || !accounts.local) fail("Account sync merge failed: " + JSON.stringify(accounts));

  async function assertLandscape(width, height) {
    await viewport(width, height, true);
    await sleep(80);
    const info = await evaluate(`(() => {
      const query = "(orientation: landscape) and (max-height: 520px) and (hover: none) and (pointer: coarse)";
      const land = document.querySelector("header.nav.nav-land");
      const label = land.querySelector(".nav-scroll > a.nav-item .nav-label");
      const center = document.querySelector(".center");
      const doc = document.documentElement;
      const appEl = document.querySelector(".app");
      const appBox = appEl.getBoundingClientRect();
      const cBox = center.getBoundingClientRect();
      const padR = parseFloat(getComputedStyle(appEl).paddingRight) || 0;
      const rows = [...land.querySelectorAll(".nav-scroll > a.nav-item, .nav-scroll > .nav-land-more")];
      const first = rows[0] ? rows[0].getBoundingClientRect() : null;
      const second = rows[1] ? rows[1].getBoundingClientRect() : null;
      const scroll = land.querySelector(".nav-scroll").getBoundingClientRect();
      const logo = land.querySelector(".logo").getBoundingClientRect();
      const post = land.querySelector(".post-btn").getBoundingClientRect();
      const account = land.querySelector(".account-pill").getBoundingClientRect();
      const sideEl = document.querySelector("aside.side");
      let safe = false;
      let safeRight = false;
      let compact = false;
      [...document.styleSheets].forEach((sheet) => {
        try {
          [...sheet.cssRules].forEach((rule) => {
            const text = rule.cssText || "";
            if (text.includes("orientation: landscape") && text.includes("max-height: 520px") && text.includes("safe-area-inset-left")) safe = true;
            if (text.includes("orientation: landscape") && text.includes("max-height: 520px") && text.includes("safe-area-inset-right")) safeRight = true;
            if (text.includes("orientation: landscape") && text.includes("max-height: 500px") && text.includes("max-width: 1100px")) compact = true;
          });
        } catch (err) {}
      });
      return {
        match: matchMedia(query).matches,
        hover: matchMedia("(hover: none)").matches,
        pointer: matchMedia("(pointer: coarse)").matches,
        land: getComputedStyle(land).display,
        labelDisplay: label ? getComputedStyle(label).display : "",
        labelText: label ? label.textContent.trim() : "",
        bar: getComputedStyle(document.querySelector("nav.bottom-nav")).display,
        side: sideEl ? getComputedStyle(sideEl).display : "none",
        sideW: sideEl ? sideEl.getBoundingClientRect().width : 0,
        maxWidth: getComputedStyle(center).maxWidth,
        itemW: first ? first.width : 0,
        itemH: first ? first.height : 0,
        gap: first && second ? Math.round((second.top - first.bottom) * 10) / 10 : -1,
        overflow: doc.scrollWidth > doc.clientWidth + 1,
        gapRight: Math.round((doc.clientWidth - (appBox.right + window.scrollX)) * 10) / 10,
        centerGap: Math.round(((appBox.right - padR) - cBox.right) * 10) / 10,
        logoAbove: logo.bottom <= scroll.top + 2,
        postBelow: post.top >= scroll.bottom - 2,
        accountBelow: account.top >= post.bottom - 2,
        safe,
        safeRight,
        compact,
        direct: [...land.querySelectorAll(".nav-scroll > a.nav-item")].map((a) => a.getAttribute("href")),
        barHrefs: [...document.querySelectorAll("nav.bottom-nav a")].map((a) => a.getAttribute("href")),
        feedsDirect: !!land.querySelector('.nav-scroll > a.nav-item[href="#/feeds"]'),
        feedsMore: !!land.querySelector('.nav-land-more a[href="#/feeds"]'),
        tvMore: !!land.querySelector('.nav-land-more a[href="#/tv"]')
      };
    })()`);
    if (!info.match) fail(width + "x" + height + " did not match the phone landscape query " + JSON.stringify(info));
    if (info.land !== "flex") fail("Landscape sidebar display " + info.land);
    if (!info.labelText || info.labelDisplay !== "none") fail("Landscape rail is not icon-only: " + JSON.stringify(info));
    if (info.itemW < 44 || info.itemH < 44) fail("Landscape tap target is under 44px: " + JSON.stringify(info));
    if (info.gap < 2 || info.gap > 12) fail("Landscape rail spacing is out of range: " + JSON.stringify(info));
    if (!info.logoAbove || !info.postBelow || !info.accountBelow) fail("Landscape rail is not pinned top and bottom: " + JSON.stringify(info));
    if (info.bar !== "none") fail("Bottom bar still visible in landscape");
    if (info.side !== "none" || info.sideW > 1) fail("Right column still takes space at " + width);
    if (info.maxWidth !== "none") fail("Center max width is " + info.maxWidth);
    if (info.overflow || Math.abs(info.gapRight) > 2 || Math.abs(info.centerGap) > 2) fail("Landscape does not fill the width: " + JSON.stringify(info));
    if (!info.safe || !info.safeRight || !info.compact) fail("Landscape rule is missing a safe-area inset or the short-height query");
    if (JSON.stringify(info.direct) !== JSON.stringify(info.barHrefs)) fail("Sidebar links " + JSON.stringify(info.direct) + " vs bar " + JSON.stringify(info.barHrefs));
    if (info.feedsDirect || !info.feedsMore || !info.tvMore) fail("More menu is wrong: " + JSON.stringify(info));
    console.log("landscape", width + "x" + height, "ok");
  }

  await assertLandscape(844, 390);
  await assertLandscape(915, 412);
  await assertLandscape(740, 360);
  await assertLandscape(932, 430);

  // A feed or subscriber-count paint can land in the same moment as the
  // rotation. Wait until the column stops changing, then check that the
  // rotation itself keeps the playing node.
  await evaluate(`(() => {
    window.__navMut = 0;
    if (window.__navObs) window.__navObs.disconnect();
    window.__navObs = new MutationObserver(() => { window.__navMut += 1; });
    window.__navObs.observe(document.body, { childList: true, subtree: true });
    return true;
  })()`);
  let lastMut = -1;
  let quiet = 0;
  const quietStart = Date.now();
  while (Date.now() - quietStart < 8000) {
    const now = await evaluate(`window.__navMut || 0`);
    if (now === lastMut) {
      quiet += 1;
      if (quiet >= 5) break;
    } else quiet = 0;
    lastMut = now;
    await sleep(100);
  }

  const beforeScroll = await evaluate(`(() => {
    const main = document.querySelector("main.center") || document.querySelector(".center");
    main.insertAdjacentHTML("beforeend", '<video id="land-keep" data-token="stay"></video>');
    const video = document.getElementById("land-keep");
    video._keep = "yes";
    document.body.style.minHeight = "2400px";
    document.documentElement.style.minHeight = "2400px";
    window.scrollTo(0, 240);
    return { y: window.scrollY, top: video.getBoundingClientRect().top };
  })()`);
  await viewport(390, 844, false);
  await sleep(120);
  const kept = await evaluate(`(() => {
    const video = document.getElementById("land-keep");
    return {
      token: video ? video.dataset.token : "",
      keep: video ? video._keep : "",
      connected: !!(video && video.isConnected),
      y: window.scrollY,
      top: video ? video.getBoundingClientRect().top : 0,
      bar: getComputedStyle(document.querySelector("nav.bottom-nav")).display,
      land: getComputedStyle(document.querySelector("header.nav.nav-land")).display
    };
  })()`);
  if (kept.token !== "stay" || kept.keep !== "yes" || !kept.connected) fail("Rotation replaced the playing media: " + JSON.stringify(kept));
  if (kept.y < 80) fail("Rotation jumped away from the scrolled page: " + JSON.stringify(kept));
  // The landscape column now fills the screen, so the text above this marker
  // reflows when the phone turns portrait. The node and the scroll offset stay.
  if (Math.abs(kept.top - beforeScroll.top) > 240) fail("Rotation moved the media in view from " + beforeScroll.top + " to " + kept.top + " (scroll " + beforeScroll.y + " -> " + kept.y + ")");
  if (kept.bar !== "flex" || kept.land !== "none") fail("Rotation did not restore the bottom bar: " + JSON.stringify(kept));

  await evaluate(`(() => {
    window.ViktorychAccounts.applySnapshot({
      bottomNavCustom: true,
      bottomNav: {
        order: ["messages", "home", "explore", "tv", "communities", "notifications", "feeds", "lists", "history", "music", "shorts", "games", "subscriptions", "vault", "storage", "settings"],
        hidden: ["explore", "tv", "communities", "notifications", "feeds", "lists", "history", "music", "shorts", "games", "subscriptions", "vault", "storage", "settings"]
      }
    });
    return true;
  })()`);
  await waitFor(`${barExpr} === ${JSON.stringify(JSON.stringify(["#/messages", "#/"]))}`, "synced bar");

  await evaluate(`location.hash = "#/settings/display/navigation"; true`);
  await waitFor(`document.querySelector("[data-act=bottom-nav-reset]")`, "reset button");
  await evaluate(`document.querySelector("[data-act=bottom-nav-reset]").click(); true`);
  await waitFor(`${barExpr} === ${JSON.stringify(JSON.stringify(expectedDefault))}`, "default bar");
  const resetFlag = await evaluate(`JSON.parse(localStorage.getItem("viktorychapp-settings-v1")).bottomNavCustom === true`);
  if (!resetFlag) fail("Reset cleared the custom flag");

  const layoutCopy = await evaluate(`(() => {
    const root = document.querySelector(".bnav-layout");
    const auto = document.querySelector('[data-act="nav-layout"][data-layout="auto"]');
    const land = document.querySelector("[data-act=nav-layout-land]");
    return {
      text: root ? root.textContent : "",
      auto: !!(auto && auto.getAttribute("aria-checked") === "true"),
      landDisabled: !!(land && land.disabled),
      mode: document.documentElement.getAttribute("data-nav-layout")
    };
  })()`);
  if (!layoutCopy.text.includes("Auto (sidebar)") || !layoutCopy.text.includes("Bottom bar (phone style)") || !layoutCopy.text.includes("Use bottom bar in landscape too")) fail("Layout choices missing: " + layoutCopy.text);
  if (!layoutCopy.auto || layoutCopy.mode !== "auto" || !layoutCopy.landDisabled) fail("Default layout is not the sidebar: " + JSON.stringify(layoutCopy));

  async function tabletSnap(width, height) {
    await viewport(width, height, false);
    await sleep(80);
    return evaluate(`(() => {
      const rail = document.querySelector("header.nav:not(.nav-land)");
      const bar = document.querySelector("nav.bottom-nav");
      const side = document.querySelector("aside.side");
      const center = document.querySelector(".center");
      const box = center.getBoundingClientRect();
      const doc = document.documentElement;
      const appEl = document.querySelector(".app");
      const appBox = appEl.getBoundingClientRect();
      const padR = parseFloat(getComputedStyle(appEl).paddingRight) || 0;
      const edge = side && getComputedStyle(side).display !== "none" ? side.getBoundingClientRect().right : box.right;
      return {
        layout: document.documentElement.getAttribute("data-nav-layout"),
        rail: getComputedStyle(rail).display,
        railWidth: getComputedStyle(rail).width,
        bar: getComputedStyle(bar).display,
        side: getComputedStyle(side).display,
        sideW: side.getBoundingClientRect().width,
        maxWidth: getComputedStyle(center).maxWidth,
        hrefs: [...bar.querySelectorAll("a")].map((a) => a.getAttribute("href")),
        overflow: doc.scrollWidth > doc.clientWidth + 1,
        gapRight: Math.round((doc.clientWidth - (appBox.right + window.scrollX)) * 10) / 10,
        centerGap: Math.round(((appBox.right - padR) - edge) * 10) / 10,
        mhead: getComputedStyle(document.querySelector(".mhead")).display
      };
    })()`);
  }

  for (const [width, height] of [[820, 1180], [768, 1024]]) {
    const auto = await tabletSnap(width, height);
    if (auto.layout !== "auto" || auto.rail !== "flex" || auto.bar !== "none") fail(width + "x" + height + " auto layout " + JSON.stringify(auto));
    if (parseFloat(auto.railWidth) > 120) fail(width + "x" + height + " left rail is expanded: " + auto.railWidth);
    if (auto.overflow || Math.abs(auto.gapRight) > 2 || Math.abs(auto.centerGap) > 2) fail(width + "x" + height + " does not fill the width " + JSON.stringify(auto));
    await evaluate(`document.querySelector('[data-act="nav-layout"][data-layout="bar"]').click(); true`);
    await waitFor(`document.documentElement.getAttribute("data-nav-layout") === "bar"`, "bottom bar layout");
    const chosen = await tabletSnap(width, height);
    if (chosen.layout !== "bar" || chosen.rail !== "none" || chosen.bar !== "flex" || chosen.side !== "none") fail(width + "x" + height + " phone layout " + JSON.stringify(chosen));
    if (chosen.maxWidth !== "none" || chosen.overflow || Math.abs(chosen.gapRight) > 2 || Math.abs(chosen.centerGap) > 2) fail(width + "x" + height + " timeline does not fill the width " + JSON.stringify(chosen));
    if (JSON.stringify(chosen.hrefs) !== JSON.stringify(expectedDefault)) fail(width + "x" + height + " bar order " + JSON.stringify(chosen.hrefs));
    if (chosen.mhead === "none") fail(width + "x" + height + " has no drawer button");
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll("[data-act=drawer]")].find((el) => el.offsetParent);
      if (!btn) throw new Error("no drawer button");
      btn.click();
      return true;
    })()`);
    await waitFor(`document.querySelector('.drawer a[href="#/feeds"]')`, "tablet drawer");
    await evaluate(`document.querySelector("[data-act=close-drawer]").click(); true`);
    await evaluate(`document.querySelector('[data-act="nav-layout"][data-layout="auto"]').click(); true`);
    await waitFor(`document.documentElement.getAttribute("data-nav-layout") === "auto"`, "sidebar layout");
    console.log("tablet", width + "x" + height, "ok");
  }

  await evaluate(`document.querySelector('[data-act="nav-layout"][data-layout="bar"]').click(); true`);
  await waitFor(`document.documentElement.getAttribute("data-nav-layout") === "bar"`, "bar layout for rotation");
  await viewport(820, 1180, false);
  const beforeTablet = await evaluate(`(() => {
    const main = document.querySelector("main.center") || document.querySelector(".center");
    main.insertAdjacentHTML("beforeend", '<video id="tablet-keep" data-token="stay"></video>');
    const video = document.getElementById("tablet-keep");
    video._keep = "yes";
    document.body.style.minHeight = "3200px";
    document.documentElement.style.minHeight = "3200px";
    window.scrollTo(0, 360);
    return { y: window.scrollY, top: video.getBoundingClientRect().top };
  })()`);
  await viewport(1180, 820, true);
  await sleep(120);
  const turned = await evaluate(`(() => {
    const video = document.getElementById("tablet-keep");
    const rail = document.querySelector("header.nav:not(.nav-land)");
    return {
      token: video ? video.dataset.token : "",
      keep: video ? video._keep : "",
      y: window.scrollY,
      top: video ? video.getBoundingClientRect().top : 0,
      rail: getComputedStyle(rail).display,
      bar: getComputedStyle(document.querySelector("nav.bottom-nav")).display,
      landFlag: document.documentElement.getAttribute("data-nav-bar-land")
    };
  })()`);
  if (turned.token !== "stay" || turned.keep !== "yes") fail("Tablet rotation replaced playing media: " + JSON.stringify(turned));
  if (Math.abs(turned.y - beforeTablet.y) > 80) fail("Tablet rotation left the page: " + JSON.stringify(turned) + " from " + JSON.stringify(beforeTablet));
  // Portrait bar mode reserves 53px for the fixed header. That padding leaves with the sidebar, so the same scroll offset shifts the media by about one header.
  if (Math.abs(turned.top - beforeTablet.top) > 80) fail("Tablet rotation moved the media from " + beforeTablet.top + " to " + turned.top + " (scroll " + beforeTablet.y + " -> " + turned.y + ")");
  if (turned.landFlag || turned.bar !== "none" || turned.rail === "none") fail("Landscape dropped the sidebar: " + JSON.stringify(turned));
  await viewport(820, 1180, false);
  await sleep(80);
  const back = await evaluate(`(() => {
    const video = document.getElementById("tablet-keep");
    return {
      keep: video ? video._keep : "",
      bar: getComputedStyle(document.querySelector("nav.bottom-nav")).display,
      rail: getComputedStyle(document.querySelector("header.nav:not(.nav-land)")).display
    };
  })()`);
  if (back.keep !== "yes" || back.bar !== "flex" || back.rail !== "none") fail("Portrait did not restore the bottom bar: " + JSON.stringify(back));

  await viewport(1180, 820, true);
  await evaluate(`document.querySelector("[data-act=nav-layout-land]").click(); true`);
  await waitFor(`document.documentElement.getAttribute("data-nav-bar-land") === "1"`, "landscape bottom bar");
  const landBar = await evaluate(`(() => ({
    bar: getComputedStyle(document.querySelector("nav.bottom-nav")).display,
    rail: getComputedStyle(document.querySelector("header.nav:not(.nav-land)")).display,
    land: getComputedStyle(document.querySelector("header.nav.nav-land")).display
  }))()`);
  if (landBar.bar !== "flex" || landBar.rail !== "none" || landBar.land !== "none") fail("Landscape toggle left a sidebar: " + JSON.stringify(landBar));

  const storedLayout = await evaluate(`(() => {
    const data = JSON.parse(localStorage.getItem("viktorychapp-settings-v1"));
    const api = window.ViktorychAccounts;
    const kept = api.mergePayload(
      { navLayout: "bar", navLayoutLand: true, follows: [] },
      { navLayoutSync: true, navLayout: "auto", navLayoutLand: false, follows: [] }
    );
    const published = api.mergePayload(
      { navLayoutSync: true, navLayout: "bar", navLayoutLand: true, follows: [] },
      { navLayoutSync: true, navLayout: "auto", navLayoutLand: false, follows: [] }
    );
    const snapOff = api.snapshotFrom(data);
    const savedSync = data.navLayoutSync === true;
    data.navLayoutSync = true;
    const snapOn = api.snapshotFrom(data);
    const unsynced = Object.assign({}, data, { navLayoutSync: false });
    api.releaseNavLayout();
    const snapClear = api.snapshotFrom(unsynced);
    const snapAfter = api.snapshotFrom(unsynced);
    const dropped = api.mergePayload(
      { navLayoutSync: false, follows: [] },
      { navLayoutSync: true, navLayout: "bar", navLayoutLand: true, follows: [] }
    );
    return {
      layout: data.navLayout,
      land: data.navLayoutLand === true,
      sync: savedSync,
      remoteKept: kept.navLayoutSync === true && kept.navLayout === "auto",
      localWins: published.navLayout === "bar" && published.navLayoutLand === true,
      snapOff: snapOff.navLayout == null && snapOff.navLayoutSync == null,
      snapOn: snapOn.navLayout === "bar" && snapOn.navLayoutSync === true,
      snapClear: snapClear.navLayoutSync === false && snapClear.navLayout == null,
      snapAfter: snapAfter.navLayoutSync == null && snapAfter.navLayout == null,
      dropped: dropped.navLayoutSync === false && dropped.navLayout == null
    };
  })()`);
  if (storedLayout.layout !== "bar" || !storedLayout.land || storedLayout.sync) fail("Layout was not saved on this device: " + JSON.stringify(storedLayout));
  if (!storedLayout.remoteKept || !storedLayout.localWins || !storedLayout.snapOff || !storedLayout.snapOn || !storedLayout.snapClear || !storedLayout.snapAfter || !storedLayout.dropped) fail("Layout sync rules failed: " + JSON.stringify(storedLayout));

  await evaluate(`(() => {
    window.__shortsRouteErrors = [];
    window.addEventListener("error", (event) => window.__shortsRouteErrors.push(String(event.message || event.error || "error")));
    return true;
  })()`);
  await evaluate(`location.hash = "#/shorts"; true`);
  await waitFor(`window.SHORTS_ENABLED === true || location.hash === "#/" || location.hash === "" || location.hash === "#"`, "shorts route leaves for home");
  await evaluate(`location.hash = "#/shorts/live/past"; true`);
  await waitFor(`window.SHORTS_ENABLED === true || location.hash === "#/" || location.hash === "" || location.hash === "#"`, "shorts live route leaves for home");
  const parked = await evaluate(`(() => ({
    hash: location.hash || "",
    enabled: window.SHORTS_ENABLED === true,
    link: !!document.querySelector('a[href="#/shorts"], a[href^="#/shorts/"]'),
    errors: window.__shortsRouteErrors || []
  }))()`);
  if (!parked.enabled) {
    if (parked.hash !== "#/" && parked.hash !== "" && parked.hash !== "#") fail("Shorts route stayed open " + JSON.stringify(parked));
    if (parked.link) fail("A Shorts link is still on the page " + JSON.stringify(parked));
    if (parked.errors.length) fail("Shorts route raised " + parked.errors.join(" | "));
  }

  console.log("bottom nav selftest ok");
  stop();
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
