/* Privacy: on a desktop the tab title is only "ViktorychApp" on every page,
   with no page name, count, search or person's name, whoever writes
   document.title. Phones keep page titles. Demo data only. */
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




const ROUTES = ["#/", "#/explore?q=demo", "#/notifications", "#/settings", "#/messages", "#/bookmarks", "#/x/demo_account", "#/spaces"];

async function open(browser, origin, vp) {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: vp, hasTouch: vp.width < 700, isMobile: vp.width < 700 });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, body: "" }));
  await context.route("**/v1/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[],"stories":[],"ok":true}' }));
  await context.addInitScript(() => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
  });
  const page = await context.newPage();
  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .topbar", { timeout: 20000 });
  await page.waitForTimeout(1500);
  return { context, page };
}

async function desktop(browser, origin) {
  const { context, page } = await open(browser, origin, { width: 1280, height: 800 });
  const titles = [];
  await page.exposeFunction("__titleSeen", (t) => titles.push(t));
  await page.evaluate(() => {
    const el = document.querySelector("title");
    new MutationObserver(() => window.__titleSeen(document.title)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  for (const hash of ROUTES) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForTimeout(1200);
    const t = await page.title();
    if (t !== "ViktorychApp") fail("desktop " + hash + ": the tab title is only ViktorychApp, got " + JSON.stringify(t));
  }
  // Any script that writes a page name or a count is put back right away.
  await page.evaluate(() => { document.title = "(3) Demo page / ViktorychApp"; });
  await page.waitForTimeout(300);
  if ((await page.title()) !== "ViktorychApp") fail("desktop: a page title written by another script is put back");
  // Settle check: the guard does not fight itself (no endless rewrites).
  const before = titles.length;
  await page.waitForTimeout(1500);
  if (titles.length - before > 2) fail("desktop: the title stays still once pinned");
  await context.close();
  console.log("title privacy ok desktop (" + ROUTES.length + " pages)");
}

async function phone(browser, origin) {
  const { context, page } = await open(browser, origin, { width: 390, height: 844 });
  await page.evaluate(() => { location.hash = "#/explore"; });
  await page.waitForTimeout(1500);
  const t = await page.title();
  if (!/Explore/.test(t)) fail("phone: page titles stay as they were, got " + JSON.stringify(t));
  await context.close();
  console.log("title privacy ok phone");
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    await desktop(browser, origin);
    await phone(browser, origin);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message);
});
