/* Compact Home header on a phone: no app name, the drawer button stays, the
   right icon opens Local AI, and when the header slides away on scroll the
   tab row stays pinned at the top. Classic header brings the name back, and
   installed app always paints its native status bar in the opaque theme colour
   (light, dim, dark), avoiding Android's grey transparent fallback. The owner switch turns the
   compact header off. Nothing here prints account names. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sharedStaticServer } from "./smoke_runtime.mjs";

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
  if (file.endsWith(".ico")) return "image/x-icon";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

function startServer() {
  const shared = sharedStaticServer();
  if (shared) return Promise.resolve(shared);
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

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}



const HEAD = `(() => {
  const bar = document.querySelector("#app .topbar.tall");
  const icon = bar && bar.querySelector(".mhead .m-icon");
  const tabs = bar && bar.querySelector(".tabs-bar");
  const r = tabs ? tabs.getBoundingClientRect() : null;
  const meta = document.querySelector('meta[name="theme-color"]');
  return {
    compact: !!(bar && bar.classList.contains("compact-head")),
    hidden: !!(bar && bar.classList.contains("is-hidden")),
    logo: !!(bar && bar.querySelector(".m-logo")),
    ava: !!(bar && bar.querySelector(".mhead .m-ava")),
    href: icon ? icon.getAttribute("href") : "",
    label: icon ? icon.getAttribute("aria-label") : "",
    tabsTop: r ? r.top : null,
    tabsBottom: r ? r.bottom : null,
    color: meta ? meta.getAttribute("content") : ""
  };
})()`;

async function open(browser, origin, opts) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, serviceWorkers: "block" });
  const seed = { settings: opts.settings || null, off: opts.off || null };
  await context.addInitScript((s) => {
    try {
      if (s.off) localStorage.setItem("viktorychapp-server-off", JSON.stringify(s.off));
      if (s.settings && !sessionStorage.getItem("hdr-seeded")) {
        sessionStorage.setItem("hdr-seeded", "1");
        localStorage.setItem("viktorychapp-settings-v1", JSON.stringify(s.settings));
      }
    } catch (err) {}
  }, seed);
  // An installed app: the page reports display-mode standalone.
  if (opts.standalone) await context.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => {
      if (/display-mode:\s*standalone/.test(String(q))) return { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent() { return false; } };
      return real(q);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => {
    const message = String(err && err.message || err);
    // YouTube's embed player throws this inside its own script. It is not
    // the header, and it must not fail this check.
    if (/isExternalMethodAvailable/.test(message)) return;
    // Chrome's extension activity logger throws this into the page. It is not the header.
    if (message === "this.api.logApiCall is not a function") return;
    if (/127\.0\.0\.1/.test(String(err && err.stack || ""))) errors.push(message.slice(0, 200));
  });
  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .topbar.tall .mhead .m-ava", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll("#app article").length > 2, null, { timeout: 20000 });
  await sleep(300);
  return { context, page, errors };
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    let run = await open(browser, origin, {});
    let h = await run.page.evaluate(HEAD);
    if (!h.compact || h.logo) fail("compact header still shows the app name " + JSON.stringify(h));
    if (!h.ava) fail("the drawer button is missing");
    if (h.href !== "#/ai" || !h.label) fail("the right icon does not open Local AI " + JSON.stringify(h));
    const topBefore = h.tabsTop;
    // Scroll down: the header slides away, the tab row stays pinned at the top.
    for (let i = 0; i < 6; i++) { await run.page.mouse.wheel(0, 300); await sleep(120); }
    await run.page.waitForFunction(() => { const b = document.querySelector("#app .topbar.tall"); return !!b && b.classList.contains("is-hidden"); }, null, { timeout: 5000 }).catch(() => {});
    await sleep(450);
    h = await run.page.evaluate(HEAD);
    if (!h.hidden) fail("header did not slide away on scroll");
    if (Math.abs(h.tabsTop) > 1) fail("tabs are not pinned at the top when the header hides " + JSON.stringify({ before: topBefore, after: h.tabsTop }));
    if (process.env.SHOT) await run.page.screenshot({ path: process.env.SHOT, clip: { x: 0, y: 0, width: 390, height: 96 } });
    // Scrolling back up brings the header back.
    for (let i = 0; i < 3; i++) { await run.page.mouse.wheel(0, -300); await sleep(120); }
    await sleep(450);
    h = await run.page.evaluate(HEAD);
    if (h.hidden || Math.abs(h.tabsTop - topBefore) > 1) fail("header did not come back on scroll up " + JSON.stringify(h));
    // The icon opens Local AI.
    await run.page.locator("#app .topbar.tall .mhead .m-icon").click();
    await run.page.waitForFunction(() => location.hash.indexOf("#/ai") === 0, null, { timeout: 5000 }).catch(() => fail("Local AI did not open"));
    // Classic header from Display settings.
    await run.page.goto(origin + "/#/settings/display", { waitUntil: "domcontentloaded" });
    await run.page.waitForSelector('[data-act="classic-header"]', { timeout: 15000 });
    await run.page.locator('[data-act="classic-header"]').click();
    await run.page.waitForSelector('[data-act="classic-header"][aria-checked="true"]', { timeout: 5000 }).catch(() => fail("classic header switch did not turn on"));
    await run.page.evaluate(() => { location.hash = "#/"; });
    // A parked Home view is refreshed a moment after it comes back.
    await run.page.waitForSelector("#app .topbar.tall:not(.compact-head) .mhead .m-ava", { timeout: 5000 }).catch(() => {});
    h = await run.page.evaluate(HEAD);
    if (h.compact || !h.logo || h.href !== "#/settings") fail("classic header did not come back " + JSON.stringify(h));
    if (run.errors.length) fail("page errors: " + run.errors.join(" | "));
    await run.context.close();

    // Installed app: the native strip is always opaque. Android turns a
    // transparent theme-color into a flat grey band above the Home header.
    const want = { default: "#FFFFFF", dim: "#15202B", lightsout: "#010101" };
    run = await open(browser, origin, { standalone: true, settings: { appearance: "lightsout" } });
    h = await run.page.evaluate(HEAD);
    if (String(h.color).toUpperCase() !== "#010101") fail("installed app must not fall back to Android's grey default, got " + h.color);
    await run.context.close();
    for (const mode of Object.keys(want)) {
      run = await open(browser, origin, { standalone: true, settings: { appearance: mode, statusBar: mode === "dim" } });
      h = await run.page.evaluate(HEAD);
      if (String(h.color).toUpperCase() !== want[mode]) fail("status bar colour for " + mode + " is " + h.color);
      await run.context.close();
    }

    // Owner switch off: the classic header for everyone.
    run = await open(browser, origin, { off: ["compact_header"] });
    h = await run.page.evaluate(HEAD);
    if (h.compact || !h.logo) fail("compact header showed with the switch off");
    await run.context.close();
    console.log("compact header ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message ? err.message : err);
});
