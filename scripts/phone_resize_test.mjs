/* A desktop window narrowed to phone width must use the phone UI, then
   restore the desktop UI when it widens. Pointer stays fine the whole time.
   Nothing here prints account names. */
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

const MEASURE = `(() => {
  function shown(sel) {
    const el = document.querySelector(sel);
    if (!el) return null;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      display: style.display,
      w: Math.round(rect.width),
      h: Math.round(rect.height)
    };
  }
  const hit = document.querySelector(".m-ava");
  const hitBox = hit ? hit.getBoundingClientRect() : null;
  const open = document.querySelector("#dock-root .xdock-panel.is-open");
  const openBox = open ? open.getBoundingClientRect() : null;
  return {
    shell: document.documentElement.getAttribute("data-shell") || "",
    fine: matchMedia("(pointer: fine)").matches,
    y: Math.round(window.scrollY),
    nav: shown("header.nav:not(.nav-land)"),
    bar: shown("nav.bottom-nav"),
    fab: shown(".fab"),
    mhead: shown(".mhead"),
    dock: shown("#dock-root"),
    hit: hitBox ? { w: Math.round(hitBox.width), h: Math.round(hitBox.height) } : null,
    open: openBox ? { w: Math.round(openBox.width), h: Math.round(openBox.height) } : null,
    vw: window.innerWidth,
    vh: window.innerHeight
  };
})()`;

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"]
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".app .center .tabs-bar", { timeout: 20000 });
    await page.waitForSelector("#dock-root", { state: "attached", timeout: 20000 });
    await sleep(200);

    const desktop = await page.evaluate(MEASURE);
    if (!desktop.fine) fail("expected a fine pointer " + JSON.stringify(desktop));
    if (!desktop.nav || desktop.nav.display === "none" || desktop.nav.w < 200) fail("desktop sidebar missing " + JSON.stringify(desktop));
    if (!desktop.bar || desktop.bar.display !== "none") fail("desktop shows the bottom nav " + JSON.stringify(desktop));
    if (!desktop.dock || desktop.dock.display === "none") fail("desktop dock is hidden " + JSON.stringify(desktop));
    if (desktop.shell !== "desktop") fail("desktop shell is " + desktop.shell);

    await page.evaluate(() => window.scrollTo(0, 480));
    await sleep(40);
    const marked = await page.evaluate(() => Math.round(window.scrollY));
    if (marked < 200) fail("could not scroll the desktop page");

    await page.setViewportSize({ width: 390, height: 800 });
    await sleep(120);
    const phone = await page.evaluate(MEASURE);
    if (!phone.fine) fail("resize changed the pointer " + JSON.stringify(phone));
    if (phone.shell !== "phone") fail("phone shell is " + phone.shell);
    if (!phone.bar || phone.bar.display !== "flex" || phone.bar.h < 44) fail("bottom nav missing at 390 " + JSON.stringify(phone));
    if (!phone.nav || phone.nav.display !== "none") fail("desktop sidebar still visible at 390 " + JSON.stringify(phone));
    if (!phone.dock || phone.dock.display !== "none") fail("dock still visible at 390 " + JSON.stringify(phone));
    if (!phone.mhead || phone.mhead.display !== "flex") fail("mobile top bar missing " + JSON.stringify(phone));
    if (!phone.fab || phone.fab.display !== "flex" || phone.fab.w < 44) fail("mobile compose button missing " + JSON.stringify(phone));
    if (!phone.hit || phone.hit.w < 44 || phone.hit.h < 44) fail("phone tap target under 44 " + JSON.stringify(phone));
    if (phone.y < 200) fail("scroll reset while narrowing " + phone.y);

    await page.setViewportSize({ width: 1280, height: 800 });
    await sleep(120);
    const restored = await page.evaluate(MEASURE);
    if (restored.shell !== "desktop") fail("restored shell is " + restored.shell);
    if (!restored.nav || restored.nav.display === "none" || restored.nav.w < 200) fail("desktop sidebar did not return " + JSON.stringify(restored));
    if (!restored.bar || restored.bar.display !== "none") fail("bottom nav stayed after widening " + JSON.stringify(restored));
    if (!restored.mhead || restored.mhead.display !== "none") fail("mobile top bar stayed after widening " + JSON.stringify(restored));
    if (!restored.fab || restored.fab.display !== "none") fail("compose button stayed after widening " + JSON.stringify(restored));
    if (!restored.dock || restored.dock.display === "none") fail("dock did not return " + JSON.stringify(restored));
    if (restored.y < 200) fail("scroll reset while widening " + restored.y);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click("#dock-root .xdock-launcher");
    await page.waitForSelector("#dock-root .xdock-panel.is-open", { timeout: 5000 });
    await page.setViewportSize({ width: 390, height: 800 });
    let sheet = null;
    const sheetStart = Date.now();
    while (Date.now() - sheetStart < 2000) {
      sheet = await page.evaluate(MEASURE);
      if (sheet.open && sheet.open.w >= 360 && sheet.open.h >= 700) break;
      await sleep(40);
    }
    if (!sheet.open || sheet.open.w < 360 || sheet.open.h < 700) fail("open drawer did not fill the phone " + JSON.stringify(sheet));
    if (sheet.y > 40) fail("opening check moved the page " + sheet.y);
    await page.setViewportSize({ width: 1280, height: 800 });
    await sleep(120);
    const drawer = await page.evaluate(MEASURE);
    if (!drawer.open || drawer.open.w > 800) fail("open drawer did not return to the corner " + JSON.stringify(drawer));
    console.log("phone resize ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message ? err.message : err);
});
