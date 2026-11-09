/* For You can be turned fully off in Settings: the tab is gone, Home opens
   on Following, shared/for-you.js is never requested and its saved memory is
   cleared. Turning it on brings it back. The owner switch foryou_off off
   hides the choice and keeps For You on. Demo data only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

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




async function run(browser, origin) {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const seen = [];
  context.on("request", (req) => seen.push(req.url()));
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, body: "" }));
  await context.route("**/v1/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[],"stories":[],"ok":true}' }));
  await context.addInitScript(() => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
  });
  let page = await context.newPage();
  const settle = async () => {
    await page.waitForSelector("#app .topbar", { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => { if (location.hash !== "#/") location.hash = "#/"; });
    // The first paint is a loading shell with a top bar and no tabs. The tab
    // row replaces it, then the For You module still needs a moment to load.
    await page.waitForSelector("#app [data-hscroll='home-tabs'] [data-act='htab']", { timeout: 20000 });
    await page.waitForTimeout(2000);
  };
  const fresh = async () => {
    await page.evaluate(() => { location.hash = "#/"; localStorage.removeItem("viktorych-screen-v1"); });
    await page.close();
    seen.length = 0;
    page = await context.newPage();
    await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
    await settle();
  };
  const flip = async (want) => {
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => { const el = document.querySelector('[data-act="home-feature"][data-key="forYou"]'); if (el) el.click(); }).catch(() => {});
      await page.waitForTimeout(1200);
      const now = await page.evaluate(() => { const el = document.querySelector('[data-act="home-feature"][data-key="forYou"]'); return el && el.getAttribute("aria-checked"); }).catch(() => null);
      const flag = await page.evaluate(() => localStorage.getItem("viktorychapp-off-foryou")).catch(() => null);
      if (now === want && (flag === "1") === (want === "false")) { await page.waitForLoadState("domcontentloaded"); await page.waitForTimeout(1500); return; }
    }
    fail("the For You switch turns " + (want === "true" ? "on" : "off"));
  };
  const state = () => page.evaluate(() => ({
    tab: !!document.querySelector('#app [data-act="htab"][data-tab="foryou"]'),
    on: (document.querySelector('#app [data-act="htab"].on') || {}).dataset ? document.querySelector('#app [data-act="htab"].on').dataset.tab : "",
    mod: !!window.ForYou,
    memory: localStorage.getItem("viktorychapp-foryou-v1")
  }));
  const loadedFy = () => seen.some((u) => /\/shared\/for-you\.js/.test(u));

  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  await settle();
  let s = await state();
  if (!s.tab || !s.mod || s.on !== "foryou") fail("For You shows and runs by default " + JSON.stringify(s));
  await page.evaluate(() => localStorage.setItem("viktorychapp-foryou-v1", JSON.stringify({ version: 1, demo: true })));

  await page.goto(origin + "/#/settings/display", { waitUntil: "domcontentloaded" });
  await page.locator('[data-act="home-feature"][data-key="forYou"]').waitFor({ timeout: 20000 });
  await flip("false");
  if (await page.evaluate(() => localStorage.getItem("viktorychapp-foryou-v1"))) fail("turning For You off clears its saved memory");

  await fresh();
  s = await state();
  if (s.tab || s.mod || s.on !== "following") fail("For You off: no tab, no module, Home opens on Following " + JSON.stringify(s));
  if (loadedFy()) fail("For You off: shared/for-you.js is not requested");
  await page.evaluate(() => { location.hash = "#/home"; });
  await page.waitForTimeout(800);
  s = await state();
  if (s.on !== "following") fail("For You off: #/home opens Following " + JSON.stringify(s));

  await page.goto(origin + "/#/settings/display", { waitUntil: "domcontentloaded" });
  await page.locator('[data-act="home-feature"][data-key="forYou"]').waitFor({ timeout: 20000 });
  await flip("true");
  await fresh();
  s = await state();
  if (!s.tab || !s.mod || s.on !== "foryou") fail("For You comes back when turned on " + JSON.stringify(s));
  if (!loadedFy()) fail("For You on: shared/for-you.js loads again");

  // Owner switch foryou_off off: the choice is hidden and For You stays on.
  await page.evaluate(() => {
    localStorage.setItem("viktorychapp-off-foryou", "1");
    localStorage.setItem("viktorychapp-server-off", JSON.stringify(["foryou_off"]));
    localStorage.setItem("viktorychapp-server-off-at", String(Date.now()));
  });
  await fresh();
  s = await state();
  if (!s.tab || !s.mod) fail("owner switch off keeps For You on " + JSON.stringify(s));
  await page.goto(origin + "/#/settings/display", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-act="home-feature"][data-key="stories"]', { timeout: 20000 });
  if (await page.locator('[data-act="home-feature"][data-key="forYou"]').count()) fail("owner switch off hides the For You choice");
  await context.close();
  console.log("foryou off ok");
}

async function main() {
  const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  if (!sw.includes('forYou: ["./shared/for-you.js"]')) fail("the service worker shell download skips shared/for-you.js when off");
  const flags = fs.readFileSync(path.join(root, "worker", "src", "feature-flags.js"), "utf8");
  if (!/foryou_off: \{ paths: \[\] \}/.test(flags)) fail("feature-flags.js lists foryou_off");
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    await run(browser, origin);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message);
});
