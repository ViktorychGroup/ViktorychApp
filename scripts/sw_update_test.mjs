/* Service worker update. An old worker can move to a new one, a file that
   fails once is tried again, a file that keeps failing never shows an error
   (the background download tries again later). A downloaded update applies
   on its own, with no tap prompt. What's new is one page after that apply. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const playwright = await import(process.env.PLAYWRIGHT_MJS || "playwright-core");
const chromium = playwright.chromium || (playwright.default && playwright.default.chromium);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const OLD_BUILT = "2020-01-01T00:00:00Z";
const NEW_BUILT = "2026-10-27T00:00:00Z";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function chromeBin() {
  const listed = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const bin of listed) {
    if (bin && fs.existsSync(bin)) return bin;
  }
  throw new Error("Chrome is not installed");
}

function mime(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".ico")) return "image/x-icon";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

const PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>App</title></head>
<body>
<p id="marker">ready</p>
<script src="update.js"></script>
<script>
navigator.serviceWorker.register("sw.js", { scope: "./", updateViaCache: "none" }).then(function (reg) {
  if (window.ViktorychUpdate && window.ViktorychUpdate.watch) window.ViktorychUpdate.watch(reg);
}).catch(function () {});
</script>
</body></html>`;

function startServer() {
  const state = {
    version: OLD,
    built: OLD_BUILT,
    swSha: "",
    swBuilt: "",
    versionMissing: false,
    fail: null,
    css: [],
    manifest: false,
    patch: {},
    hits: {}
  };
  const shellList = () => {
    const text = fs.readFileSync(path.join(root, "sw.js"), "utf8");
    const block = (text.match(/const SHELL_FILES = \[([\s\S]*?)\];/) || [])[1] || "";
    return Array.from(block.matchAll(/"(\.\/[^"]*)"/g)).map((m) => m[1]);
  };
  const bodyOf = (rel) => {
    if (state.patch[rel] != null) return Buffer.from(state.patch[rel]);
    if (rel === "/index.html") return Buffer.from(PAGE);
    try { return fs.readFileSync(path.join(root, rel)); } catch (err) { return null; }
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    const headers = { "cache-control": "no-store" };
    if (rel === "/version.json") {
      if (state.versionMissing) {
        res.writeHead(404, headers);
        res.end("missing");
        return;
      }
      const body = JSON.stringify({
        name: "ViktorychApp",
        sha: state.version,
        short: state.version.slice(0, 7),
        built: state.built,
        changelog: ["A test note"]
      });
      res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
      res.end(body);
      return;
    }
    if (state.fail && rel === state.fail.path) {
      const query = url.search || "";
      if (!state.fail.sha || query.indexOf("sw=" + state.fail.sha) >= 0) {
        if (state.fail.remaining !== 0) {
          if (state.fail.remaining > 0) state.fail.remaining -= 1;
          if (rel === "/styles.css") state.css.push(query);
          res.writeHead(503, { ...headers, "content-type": "text/plain; charset=utf-8" });
          res.end("unavailable");
          return;
        }
      }
    }
    if (rel === "/styles.css") state.css.push(url.search || "");
    if (url.search.indexOf("sw=") >= 0) state.hits[rel] = (state.hits[rel] || 0) + 1;
    if (rel === "/shell-manifest.json") {
      if (!state.manifest) { res.writeHead(404, headers); res.end("missing"); return; }
      const files = {};
      shellList().forEach((item) => {
        const data = bodyOf(item === "./" ? "/index.html" : item.slice(1));
        if (data) files[item] = [crypto.createHash("sha256").update(data).digest("hex"), data.length];
      });
      res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ sha: state.version, built: state.built, files }));
      return;
    }
    if (state.patch[rel] != null) {
      res.writeHead(200, { ...headers, "content-type": mime(rel) });
      res.end(state.patch[rel]);
      return;
    }
    if (rel === "/index.html") {
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    const file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403, headers);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { ...headers, "content-type": "text/plain; charset=utf-8" });
        res.end("missing");
        return;
      }
      let body = data;
      if (rel === "/sw.js") {
        const swSha = state.swSha || state.version;
        const swBuilt = state.swBuilt || state.built;
        body = Buffer.from(data.toString("utf8").replaceAll("__SW_VERSION__", swSha).replaceAll("__SW_BUILT__", swBuilt));
      }
      res.writeHead(200, { ...headers, "content-type": mime(file) });
      res.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, state, url: "http://127.0.0.1:" + address.port + "/" });
    });
  });
}

async function shaOf(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const worker = navigator.serviceWorker.controller;
    if (!worker) { resolve(""); return; }
    const timer = setTimeout(() => resolve(""), 4000);
    const onMsg = (event) => {
      const data = event.data || {};
      if (data.type !== "sw-version" || !data.sha) return;
      navigator.serviceWorker.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve(String(data.sha));
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    worker.postMessage({ type: "sw-version" });
  }));
}

async function waitControlled(page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 60000 });
}

async function openAt(browser, url, expected) {
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();
  page.on("console", (msg) => {
    const text = msg.text();
    if (/shell update|failed|http-|missing/i.test(text)) console.log("page:", text.slice(0, 240));
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitControlled(page);
  const sha = await shaOf(page);
  assert(sha === expected, "worker was " + sha + ", expected " + expected);
  return { context, page };
}

async function openApp(browser, url) {
  return openAt(browser, url, OLD);
}

async function offerUpdate(page) {
  await page.evaluate(() => window.ViktorychUpdate.poke());
}

async function registrationState(page) {
  return page.evaluate(() => navigator.serviceWorker.getRegistration().then((registration) => {
    const root = document.getElementById("upd-root");
    const go = document.getElementById("upd-go");
    const pill = document.getElementById("upd-pill");
    const overlay = document.getElementById("upd-overlay");
    const phase = root ? root.getAttribute("data-phase") || "" : "";
    const waiting = registration && registration.waiting;
    const screen = !!(root && overlay && go && !root.hidden && !overlay.hidden && !go.hidden);
    /* The new worker stays waiting for the whole download. A second
       apply-update aborts that download, so this only reports state. */
    return {
      phase: phase,
      installing: !!(registration && registration.installing),
      waiting: !!waiting,
      failed: !!(screen && phase === "error" && !(registration && registration.installing)),
      offer: !!(root && !root.hidden && phase === "offer" && ((pill && !pill.hidden) || screen))
    };
  })).catch(() => null);
}

async function waitSha(page, expected) {
  const start = Date.now();
  let last = "";
  let nudgedAt = 0;
  let nudged = 0;
  let detail = null;
  while (Date.now() - start < 180000) {
    try { last = await shaOf(page); } catch (err) { last = ""; }
    if (last === expected) return;
    if (nudged < 5 && Date.now() - start > 12000 && Date.now() - nudgedAt > 12000) {
      nudgedAt = Date.now();
      detail = await registrationState(page);
      if (detail && (detail.failed || detail.offer)) {
        nudged += 1;
        const pill = await page.$("#upd-pill");
        if (pill && await pill.isVisible()) throw new Error("a tap-to-update prompt was shown");
        const go = await page.$("#upd-go");
        if (go && await go.isVisible()) await page.click("#upd-go").catch(() => {});
      }
    }
    await page.waitForTimeout(300);
  }
  detail = await registrationState(page);
  const info = await page.evaluate(() => {
    const text = (id) => {
      const el = document.getElementById(id);
      return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
    };
    const root = document.getElementById("upd-root");
    return {
      title: text("upd-title"),
      detail: text("upd-detail"),
      error: text("upd-error"),
      phase: root ? root.getAttribute("data-phase") || "" : ""
    };
  }).catch(() => ({}));
  const extra = detail ? " (phase=" + detail.phase + " installing=" + detail.installing + " waiting=" + detail.waiting + ")" : "";
  throw new Error((last ? "worker stayed on the previous build" : "worker never reported a build") + extra + " " + JSON.stringify(info));
}

async function testCleanUpdate(browser) {
  const { server, state, url } = await startServer();
  const { context, page } = await openApp(browser, url);
  try {
    // Media saved under an older versioned cache name moves into the stable cache.
    await page.evaluate(async () => {
      const old = await caches.open("media-viktorych-a277-old");
      await old.put("https://pbs.twimg.com/media/kept.jpg", new Response("img", { headers: { "content-type": "image/jpeg" } }));
    });
    state.version = NEW;
    state.built = NEW_BUILT;
    await offerUpdate(page);
    await waitSha(page, NEW);
    let moved = null;
    for (let i = 0; i < 40; i++) {
      moved = await page.evaluate(async () => {
        const keys = await caches.keys();
        const hit = await caches.match("https://pbs.twimg.com/media/kept.jpg", { cacheName: "media-v1" });
        return { old: keys.includes("media-viktorych-a277-old"), hit: !!hit };
      }).catch(() => null);
      if (moved && moved.hit && !moved.old) break;
      await page.waitForTimeout(250);
    }
    assert(moved && moved.hit && !moved.old, "saved media must survive an update " + JSON.stringify(moved));
  } finally {
    await context.close();
    server.close();
  }
  console.log("update from an old worker succeeded");
}

async function testRetryRecovers(browser) {
  const { server, state, url } = await startServer();
  const { context, page } = await openApp(browser, url);
  try {
    state.css = [];
    state.version = NEW;
    state.built = NEW_BUILT;
    state.fail = { path: "/styles.css", sha: NEW, remaining: 1 };
    await offerUpdate(page);
    await waitSha(page, NEW);
    const hits = state.css.filter((query) => query.indexOf("sw=" + NEW) >= 0);
    assert(hits.length >= 2, "the failed file was not fetched again (" + hits.length + ")");
  } finally {
    await context.close();
    server.close();
  }
  console.log("one failed file was retried and the update finished");
}

async function workerLog(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), 4000);
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data && event.data.type === "update-log") { clearTimeout(timer); resolve(event.data.log || []); }
    });
    navigator.serviceWorker.controller.postMessage({ type: "update-log" });
  })).catch(() => []);
}

async function waitLogged(page, file, reason) {
  for (let i = 0; i < 120; i++) {
    const log = await workerLog(page);
    if (Array.isArray(log) && log.some((row) => row.path === file && row.reason === reason)) return log;
    await page.waitForTimeout(1000);
  }
  throw new Error("the worker never logged " + file + " " + reason);
}

async function shownState(page) {
  return page.evaluate(() => {
    const root = document.getElementById("upd-root");
    const go = document.getElementById("upd-go");
    const pill = document.getElementById("upd-pill");
    const overlay = document.getElementById("upd-overlay");
    const title = document.getElementById("upd-title");
    const screen = !!(root && overlay && go && !root.hidden && !overlay.hidden && !go.hidden);
    return {
      visible: screen,
      pill: !!(root && !root.hidden && pill && !pill.hidden),
      error: !!(screen && title && /didn't finish/.test(title.textContent || "")),
      notes: !!(document.getElementById("upd-notes") && !document.getElementById("upd-notes").hidden && overlay && !overlay.hidden)
    };
  });
}

/* A file that keeps failing: nothing is shown (no error, no Retry, no
   tap prompt) while the new version downloads in the background. Once the
   file is back, the update applies itself. What's new follows. */
async function testSilentUntilReady(browser) {
  const { server, state, url } = await startServer();
  const { context, page } = await openApp(browser, url);
  try {
    state.version = NEW;
    state.built = NEW_BUILT;
    state.fail = { path: "/styles.css", sha: NEW, remaining: -1 };
    await page.evaluate(() => window.ViktorychUpdate.poke());
    await waitLogged(page, "styles.css", "http-503");
    const during = await shownState(page);
    assert(!during.visible && !during.pill && !during.error, "an update that is still downloading was shown: " + JSON.stringify(during));
    state.fail = null;
    await page.evaluate(() => window.ViktorychUpdate.poke());
    let prompted = false;
    const started = Date.now();
    let sha = "";
    while (Date.now() - started < 180000) {
      const shown = await shownState(page);
      if (shown.pill) prompted = true;
      try { sha = await shaOf(page); } catch (err) { sha = ""; }
      if (sha === NEW) break;
      await page.waitForTimeout(300);
    }
    assert(!prompted, "a tap-to-update prompt was shown");
    assert(sha === NEW, "the ready update did not apply itself (" + sha + ")");
    await page.waitForSelector("#upd-notes-sheet", { timeout: 8000 });
    await page.click("#upd-gotit");
    await page.waitForFunction(() => !document.getElementById("upd-notes-sheet"));
  } finally {
    await context.close();
    server.close();
  }
  console.log("a failing file stayed silent, then the update applied itself and What's new showed once");
}

/* With a manifest, the next update downloads only the files that changed,
   and Retry keeps what the failed attempt already saved. */
async function testOnlyChangedFiles(browser) {
  const { server, state, url } = await startServer();
  state.manifest = true;
  const { context, page } = await openApp(browser, url);
  try {
    state.version = NEW;
    state.built = NEW_BUILT;
    await offerUpdate(page);
    await waitSha(page, NEW);
    const NEWER = "c".repeat(40);
    state.hits = {};
    state.version = NEWER;
    state.built = "2026-10-28T00:00:00Z";
    state.patch["/styles.css"] = "/* changed */ body { color: inherit; }";
    state.patch["/dock.css"] = "/* changed */ .x { color: inherit; }";
    state.fail = { path: "/dock.css", sha: NEWER, remaining: -1 };
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitControlled(page);
    await page.evaluate(() => window.ViktorychUpdate.poke());
    await waitLogged(page, "dock.css", "http-503");
    const first = Object.assign({}, state.hits);
    const pulled = Object.keys(first).filter((rel) => rel !== "/shell-manifest.json");
    assert(pulled.join() === "/styles.css", "an unchanged file was downloaded again: " + pulled.slice(0, 5).join(" "));
    state.fail = null;
    state.hits = {};
    await offerUpdate(page);
    await waitSha(page, NEWER);
    const again = Object.keys(state.hits).filter((rel) => rel !== "/shell-manifest.json");
    assert(again.join() === "/dock.css", "Retry started over: " + again.slice(0, 5).join(" "));
    const log = await workerLog(page);
    assert(Array.isArray(log) && log.some((row) => row.path === "dock.css" && row.reason === "http-503"), "the worker did not log the failure");
  } finally {
    await context.close();
    server.close();
  }
  console.log("only changed files downloaded, Retry resumed");
}

/* A deploy that lands mid-download moves the update to the newest build
   instead of mixing builds or failing. */
async function testDeployMidDownload(browser) {
  const { server, state, url } = await startServer();
  state.manifest = true;
  const { context, page } = await openApp(browser, url);
  try {
    state.version = NEW;
    state.built = NEW_BUILT;
    state.hits = {};
    // Hold one file so the deploy lands while the background download runs.
    state.fail = { path: "/styles.css", sha: NEW, remaining: 2 };
    await page.evaluate(() => window.ViktorychUpdate.poke());
    const NEWER = "d".repeat(40);
    for (let i = 0; i < 100 && !Object.keys(state.hits).some((rel) => rel !== "/shell-manifest.json"); i++) await page.waitForTimeout(100);
    state.version = NEWER;
    state.built = "2026-10-28T00:00:00Z";
    state.patch["/styles.css"] = "/* newer */ body { color: inherit; }";
    state.fail = null;
    await waitSha(page, NEWER);
    const shown = await shownState(page);
    assert(!shown.error, "a deploy mid-download showed an error");
  } finally {
    await context.close();
    server.close();
  }
  console.log("a deploy mid-download moved the update to the newest build");
}

async function assertStaysIdle(page, ms, label) {
  let navs = 0;
  let watch = true;
  const onNav = () => { if (watch) navs += 1; };
  page.on("framenavigated", onNav);
  const started = Date.now();
  await page.evaluate(() => window.ViktorychUpdate.poke());
  while (Date.now() - started < ms) {
    const shown = await shownState(page);
    assert(!shown.visible && !shown.pill && !shown.error, label + " offered an update " + JSON.stringify(shown));
    await page.waitForTimeout(250);
  }
  watch = false;
  assert(navs === 0, label + " reloaded the page " + navs + " times");
  return shaOf(page);
}

/* version.json lagging, leading, or matching the running worker must not
   open an update or reload the page. A missing file stays idle too. */
async function testVersionMismatchIdle(browser) {
  const same = await startServer();
  const opened = await openApp(browser, same.url);
  try {
    let sha = await assertStaysIdle(opened.page, 2000, "same sha");
    assert(sha === OLD, "same sha left the worker");
    same.state.version = NEW;
    same.state.built = NEW_BUILT;
    same.state.swSha = OLD;
    same.state.swBuilt = OLD_BUILT;
    sha = await assertStaysIdle(opened.page, 2500, "version.json newer than the worker");
    assert(sha === OLD, "version.json newer than the worker changed the build");
    same.state.versionMissing = true;
    sha = await assertStaysIdle(opened.page, 1500, "missing version.json");
    assert(sha === OLD, "missing version.json changed the build");
  } finally {
    await opened.context.close();
    same.server.close();
  }

  const ahead = await startServer();
  ahead.state.version = NEW;
  ahead.state.built = NEW_BUILT;
  const running = await openAt(browser, ahead.url, NEW);
  try {
    ahead.state.version = OLD;
    ahead.state.built = OLD_BUILT;
    ahead.state.swSha = NEW;
    ahead.state.swBuilt = NEW_BUILT;
    await running.page.reload({ waitUntil: "domcontentloaded" });
    await waitControlled(running.page);
    const sha = await assertStaysIdle(running.page, 2500, "worker newer than version.json");
    assert(sha === NEW, "worker newer than version.json changed the build");
    let extra = 0;
    const onNav = () => { extra += 1; };
    running.page.on("framenavigated", onNav);
    await running.page.evaluate(() => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      window.ViktorychUpdate.onControllerChange();
      window.ViktorychUpdate.poke();
    });
    await running.page.waitForTimeout(1500);
    assert(extra === 0, "version.json older than the service worker reloaded the page");
    const again = await shownState(running.page);
    assert(!again.visible && !again.pill && !again.error, "version.json older than the service worker showed an update");
    assert(await shaOf(running.page) === NEW, "the running build changed after the stale version file");
  } finally {
    await running.context.close();
    ahead.server.close();
  }
  console.log("a version.json mismatch stayed idle");
}

/* The live loop: service worker c2b9cb09, version.json still 3a6f2de. */
async function testLiveLag(browser) {
  const sw = "c2b9cb0959b7a68187171bda4af3af0fd596d274";
  const manifest = "3a6f2de18453d5416d9ed99ab622047825a105db";
  const { server, state, url } = await startServer();
  state.version = sw;
  state.built = "2026-11-03T23:25:36Z";
  const opened = await openAt(browser, url, sw);
  try {
    state.version = manifest;
    state.built = "2026-11-03T23:13:36Z";
    state.swSha = sw;
    state.swBuilt = "2026-11-03T23:25:36Z";
    await opened.page.reload({ waitUntil: "domcontentloaded" });
    await waitControlled(opened.page);
    const sha = await assertStaysIdle(opened.page, 2000, "live version.json lag");
    assert(sha === sw, "the live lag changed the service worker");
    let extra = 0;
    opened.page.on("framenavigated", () => { extra += 1; });
    await opened.page.evaluate(() => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      window.ViktorychUpdate.onControllerChange();
      window.ViktorychUpdate.poke();
    });
    await opened.page.waitForTimeout(1200);
    assert(extra === 0, "the live lag reloaded the page");
    const shown = await shownState(opened.page);
    assert(!shown.visible && !shown.pill && !shown.error, "the live lag showed the update screen");
  } finally {
    await opened.context.close();
    server.close();
  }
  console.log("live version.json lag did not reload");
}

/* What's new is one sheet per build: it comes back for a new build, and not
   for one the device already dismissed. */
async function testNotesOnce(browser) {
  const { server, url } = await startServer();
  const { context, page } = await openApp(browser, url);
  try {
    // The classic bottom sheet is the update_notice switch turned off; the
    // full-screen page has its own test (scripts/update_notice_test.mjs).
    await page.evaluate(() => {
      localStorage.setItem("viktorychapp-server-off", JSON.stringify(["update_notice"]));
      localStorage.setItem("viktorychapp-server-off-at", String(Date.now()));
    });
    const show = (sha, notes) => page.evaluate(({ sha, notes }) => {
      sessionStorage.setItem("viktorychapp-update-toast", JSON.stringify({ sha, notes }));
    }, { sha, notes });
    await show(OLD, ["A test note", "Second line"]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#upd-notes-sheet", { timeout: 8000 });
    await page.addStyleTag({ path: path.join(root, "styles.css") });
    await page.waitForTimeout(400);
    const text = await page.locator("#upd-notes-sheet").innerText();
    assert(text.includes("What's new"), "the sheet has no title: " + text);
    assert(text.includes("A test note") && text.includes("Second line"), "the sheet missed the changelog: " + text);
    assert(text.includes("Got it"), "the sheet has no Got it button: " + text);
    const open = await page.evaluate(() => document.body.classList.contains("upd-open"));
    assert(!open, "What's new blocked the page");
    const placed = await page.evaluate(() => {
      const sheet = document.getElementById("upd-notes-sheet");
      const card = sheet && sheet.querySelector(".upd-sheet-card");
      const read = (theme) => {
        if (theme) document.documentElement.setAttribute("data-theme", theme);
        else document.documentElement.removeAttribute("data-theme");
        return card ? getComputedStyle(card).backgroundColor : "";
      };
      const dark = read("");
      const light = read("default");
      read("");
      return {
        fixed: !!(sheet && getComputedStyle(sheet).position === "fixed"),
        height: document.documentElement.scrollHeight,
        dark,
        light
      };
    });
    assert(placed.fixed, "What's new is in the page flow");
    assert(placed.dark && placed.light && placed.dark !== placed.light, "What's new ignored the theme " + JSON.stringify(placed));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    const phone = await page.locator(".upd-sheet-card").boundingBox();
    assert(phone && phone.y > 420, "the phone sheet is not along the bottom " + JSON.stringify(phone));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(100);
    const desk = await page.locator(".upd-sheet-card").boundingBox();
    assert(desk && Math.abs(desk.x + desk.width / 2 - 640) < 100, "the desktop sheet is not centered " + JSON.stringify(desk));
    const tall = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.click("#upd-gotit");
    await page.waitForFunction(() => !document.getElementById("upd-notes-sheet"));
    const short = await page.evaluate(() => document.documentElement.scrollHeight);
    assert(short === tall, "What's new shifted the page " + tall + " -> " + short);
    await show(OLD, ["A test note"]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    assert(!(await page.$("#upd-notes-sheet")), "What's new showed again for the same build");
    const other = "e".repeat(40);
    const opened = await page.evaluate((sha) => window.ViktorychUpdate.showReleaseNotes(sha, ["Newer note"]), other);
    assert(opened === true, "a new build did not open What's new");
    await page.waitForSelector("#upd-notes-sheet");
    const newer = await page.locator("#upd-notes-sheet").innerText();
    assert(newer.includes("Newer note"), newer);
    const again = await page.evaluate((sha) => window.ViktorychUpdate.showReleaseNotes(sha, ["Newer note"]), other);
    assert(again === false, "the same build opened a second sheet");
    assert(await page.locator("#upd-notes-sheet").count() === 1, "sheets stacked");
    await page.click("#upd-gotit");
    const after = await page.evaluate((sha) => window.ViktorychUpdate.showReleaseNotes(sha, ["Newer note"]), other);
    assert(after === false, "a dismissed build opened What's new again");
  } finally {
    await context.close();
    server.close();
  }
  console.log("What's new showed once per build");
}

async function setLifecycle(page, state) {
  const visible = state === "active" || state === "visible";
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => next });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible ? "visible" : "hidden");
}

/* A composer holds the apply. There is no tap prompt. Closing it applies
   once, the draft is saved, and a second hide does not reload again. */
async function testDismissThenHide(browser) {
  const { server, state, url } = await startServer();
  const { context, page } = await openApp(browser, url);
  try {
    await page.evaluate(() => {
      const modal = document.createElement("div");
      modal.className = "xc-modal";
      modal.id = "hold-modal";
      document.body.appendChild(modal);
      const area = document.createElement("textarea");
      area.id = "hold-text";
      area.value = "draft";
      document.body.appendChild(area);
    });
    state.version = NEW;
    state.built = NEW_BUILT;
    await page.evaluate(() => window.ViktorychUpdate.poke());
    await page.waitForFunction(() => document.documentElement.getAttribute("data-update") === "ready", null, { timeout: 60000 });
    const prompted = await page.locator("#upd-pill").isVisible().catch(() => false);
    assert(!prompted, "a tap-to-update prompt was shown while composing");
    assert(await shaOf(page) === OLD, "the build applied while composing");
    await page.evaluate(() => {
      location.hash = "#/compose";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await page.waitForTimeout(500);
    assert(await shaOf(page) === OLD, "navigation applied the build while composing");
    await setLifecycle(page, "hidden");
    await page.waitForTimeout(600);
    assert(await shaOf(page) === OLD, "hiding the app applied the build while composing");
    await page.evaluate(() => {
      const modal = document.getElementById("hold-modal");
      if (modal) modal.remove();
    });
    let reloads = 0;
    page.on("framenavigated", () => { reloads += 1; });
    await setLifecycle(page, "active");
    const started = Date.now();
    let sha = "";
    while (Date.now() - started < 180000) {
      try { sha = await shaOf(page); } catch (err) { sha = ""; }
      if (sha === NEW) break;
      await page.waitForTimeout(300);
    }
    if (sha !== NEW) {
      const detail = await page.evaluate(() => {
        const root = document.getElementById("upd-root");
        const nodes = Array.from(document.querySelectorAll(".xc-modal, .modal-back, .modal, [role='dialog'], [role='alertdialog']"));
        return {
          update: document.documentElement.getAttribute("data-update") || "",
          phase: root ? (root.getAttribute("data-phase") || "") : "",
          visibility: document.visibilityState,
          dialogs: nodes.slice(0, 8).map((el) => (el.id || el.className || el.tagName) + (el.hidden ? ":hidden" : ""))
        };
      }).catch((err) => ({ error: String(err && err.message || err) }));
      assert(false, "closing the composer did not apply the downloaded build (" + sha + ") " + JSON.stringify(detail));
    }
    await page.waitForSelector("#upd-notes-sheet", { timeout: 8000 });
    const saved = await page.evaluate(() => (sessionStorage.getItem("viktorychapp-update-restore") || "") + (localStorage.getItem("viktorychapp-update-restore") || ""));
    assert(saved.includes("draft"), "the draft was not saved before reload");
    const notes = await page.locator("#upd-notes-sheet").innerText();
    assert(notes.includes("What's new") && notes.includes("Continue"), "What's new did not follow the apply: " + notes);
    assert(!/tap to/i.test(notes), "What's new asked for a tap: " + notes);
    await page.click("#upd-gotit");
    await page.waitForFunction(() => !document.getElementById("upd-notes-sheet"));
    const again = await page.evaluate((sha) => window.ViktorychUpdate.showReleaseNotes(sha, ["A test note"]), NEW);
    assert(again === false, "What's new showed again for the applied build");
    const before = reloads;
    await setLifecycle(page, "hidden");
    await page.waitForTimeout(1200);
    assert(await shaOf(page) === NEW, "a second hide left the new build");
    assert(reloads === before, "a second hide reloaded again (" + (reloads - before) + ")");
  } finally {
    await context.close();
    server.close();
  }
  console.log("compose held the update, then it applied once and kept the draft");
}

const browser = await chromium.launch({
  headless: true,
  executablePath: chromeBin(),
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});
try {
  await testDismissThenHide(browser);
  await testVersionMismatchIdle(browser);
  await testLiveLag(browser);
  await testNotesOnce(browser);
  await testCleanUpdate(browser);
  await testRetryRecovers(browser);
  await testSilentUntilReady(browser);
  await testOnlyChangedFiles(browser);
  await testDeployMidDownload(browser);
} finally {
  await browser.close();
}
console.log("service worker update checks passed");
