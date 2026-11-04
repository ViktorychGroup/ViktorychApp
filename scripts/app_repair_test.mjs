/* Repair app: the Settings button drops the service worker and the cached
   app and feed files but keeps login, settings, drafts, music downloads and
   Local AI models; a Home that never loads offers the repair; an Android app
   installed before full screen gets a one-time reinstall guide; the owner
   switch app_repair hides all of it. Nothing here prints account names. */
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


async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    // 1. Settings > Display: Repair app drops the worker and the app and
    //    feed caches, keeps login, settings, drafts and downloads, reloads.
    let context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    let page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err && err.message || err).slice(0, 200)));
    await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#app .topbar .tabs[role='tablist']", { timeout: 20000 });
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => null);
      const put = async (name, key) => (await caches.open(name)).put(key, new Response("x"));
      await put("data-v1", "./__repair-test/feed");
      await put("media-v1", "./__repair-test/pic");
      await put("shell-repair-test-old", "./__repair-test/app.js");
      await put("viktorych-prefs", "./__repair-test/prefs");
      await put("sintel-music-offline", "./__repair-test/song");
      await put("transformers-cache", "./__repair-test/model");
      localStorage.setItem("repair-test-keep", "1");
      await new Promise((resolve) => {
        const req = indexedDB.open("repair-test-drafts", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("d");
        req.onsuccess = () => { const db = req.result; const tx = db.transaction("d", "readwrite"); tx.objectStore("d").put("draft text", "k"); tx.oncomplete = () => { db.close(); resolve(); }; };
        req.onerror = () => resolve();
      });
    });
    await page.goto(origin + "/#/settings/display", { waitUntil: "domcontentloaded" });
    const btn = page.locator("#app [data-act='repair-app']").first();
    await btn.waitFor({ timeout: 15000 });
    const label = (await btn.textContent() || "").trim();
    if (!label) fail("Repair app button has no label");
    await Promise.all([
      page.waitForURL(/vapp=/, { timeout: 15000 }).catch(() => {}),
      btn.click()
    ]);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("#app", { timeout: 20000 });
    await sleep(800);
    const after = await page.evaluate(async () => {
      const names = await caches.keys();
      const has = async (name, key) => names.includes(name) && !!(await (await caches.open(name)).match(key));
      const draft = await new Promise((resolve) => {
        const req = indexedDB.open("repair-test-drafts", 1);
        req.onsuccess = () => { const db = req.result; if (!db.objectStoreNames.contains("d")) { resolve(""); return; } const g = db.transaction("d").objectStore("d").get("k"); g.onsuccess = () => { resolve(g.result || ""); db.close(); }; g.onerror = () => resolve(""); };
        req.onerror = () => resolve("");
      });
      return {
        feed: await has("data-v1", "./__repair-test/feed"),
        pic: await has("media-v1", "./__repair-test/pic"),
        oldShell: names.includes("shell-repair-test-old"),
        prefs: await has("viktorych-prefs", "./__repair-test/prefs"),
        song: await has("sintel-music-offline", "./__repair-test/song"),
        model: await has("transformers-cache", "./__repair-test/model"),
        keep: localStorage.getItem("repair-test-keep"),
        draft: draft
      };
    });
    if (after.feed || after.pic || after.oldShell) fail("repair left app or feed caches " + JSON.stringify(after));
    if (!after.prefs || !after.song || !after.model) fail("repair removed settings, downloads or models " + JSON.stringify(after));
    if (after.keep !== "1" || after.draft !== "draft text") fail("repair removed local data " + JSON.stringify(after));
    await context.close();

    // 2. Home that never gets its posts offers the repair.
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    page = await context.newPage();
    await page.route(/feeds\.json|\/v1\//, (route) => route.abort());
    await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.ViktorychAppFix, null, { timeout: 20000 });
    await page.evaluate(() => {
      window.ViktorychAccounts = window.ViktorychAccounts || {};
      window.ViktorychAccounts.token = () => "test-token";
    });
    await sleep(3000);
    const stuck = await page.evaluate(() => window.ViktorychAppFix.stuck());
    if (!stuck) fail("Home with no posts did not count as stuck " + JSON.stringify(await page.evaluate(() => ({ hash: location.hash, tabs: !!document.querySelector("#app .topbar .tabs[role='tablist']"), posts: document.querySelectorAll("#app article").length, modal: !!document.querySelector(".modal") }))));
    if (!(await page.evaluate(() => window.ViktorychAppFix.checkNow()))) fail("stuck Home did not offer repair");
    if (!(await page.locator("#app-fix[data-kind='repair'] [data-act='repair-app']").isVisible())) fail("repair offer is not visible");
    await page.click("#app-fix [data-act='app-fix-close']");
    if (await page.locator("#app-fix").isVisible()) fail("repair offer did not close");
    await context.close();
    // A healthy Home never offers it.
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    page = await context.newPage();
    await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.ViktorychAppFix, null, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll("#app article").length > 0, null, { timeout: 20000 });
    // Same tick as the fake sign-in: a signed-in Home with posts is healthy.
    const healthy = await page.evaluate(() => {
      window.ViktorychAccounts = window.ViktorychAccounts || {};
      const was = window.ViktorychAccounts.token;
      window.ViktorychAccounts.token = () => "test-token";
      const stuckNow = window.ViktorychAppFix.stuck();
      window.ViktorychAccounts.token = was;
      return { stuckNow, posts: document.querySelectorAll("#app article").length };
    });
    if (healthy.stuckNow || !healthy.posts) fail("healthy Home counted as stuck " + JSON.stringify(healthy));
    await context.close();

    // 3. An Android app installed in standalone before full screen: one-time guide.
    const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
    context = await browser.newContext({ viewport: { width: 412, height: 915 }, userAgent: android, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    await context.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => {
        if (/display-mode:\s*standalone/.test(q)) return { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
        if (/display-mode:\s*fullscreen/.test(q)) return { matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
        return real(q);
      };
    });
    page = await context.newPage();
    await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#app-fix[data-kind='reinstall']", { timeout: 15000 });
    const guide = await page.locator("#app-fix").innerText();
    if (!/1\./.test(guide) || !/3\./.test(guide)) fail("reinstall guide lacks steps");
    await page.click("#app-fix [data-act='reinstall-start']");
    const stored = await page.evaluate(() => [localStorage.getItem("viktorychapp-reinstall-seen"), !!localStorage.getItem("viktorychapp-reinstall-pending")]);
    if (stored[0] !== "1" || !stored[1]) fail("reinstall guide was not remembered " + JSON.stringify(stored));
    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(3500);
    if (await page.locator("#app-fix[data-kind='reinstall']").isVisible().catch(() => false)) fail("reinstall guide showed twice");
    await context.close();

    // 4. The owner switch turns all of it off.
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    await context.addInitScript(() => { try { localStorage.setItem("viktorychapp-server-off", JSON.stringify(["app_repair"])); } catch (err) {} });
    page = await context.newPage();
    await page.goto(origin + "/#/settings/display", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#app .theme-row", { timeout: 15000 });
    if (await page.locator("#app [data-act='repair-app']").count()) fail("Repair app shows with app_repair off");
    await context.close();

    if (errors.length) fail("page errors: " + errors.join(" | "));
    console.log("app repair ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message ? err.message : err);
});
