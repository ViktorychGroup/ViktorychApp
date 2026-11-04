/* Desktop corner buttons: the + post button and the Local AI button are
   squares like the dock launchers, stacked in one column at the dock's right
   edge without overlapping. Phones keep round buttons. Demo data only. */
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




async function measure(browser, origin, vp, prefs) {
  const mobile = vp.width < 700;
  const context = await browser.newContext({ serviceWorkers: "block", viewport: vp, hasTouch: mobile, isMobile: mobile });
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
  await page.evaluate((p) => { const k = "viktorychapp-settings-v1"; const st = JSON.parse(localStorage.getItem(k) || "{}"); Object.assign(st, p); localStorage.setItem(k, JSON.stringify(st)); }, prefs);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .topbar", { timeout: 20000 });
  await page.waitForSelector("#lai-fab", { timeout: 20000 });
  await page.waitForTimeout(2000);
  const out = await page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return null;
      const r = el.getBoundingClientRect();
      return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, radius: parseFloat(cs.borderTopLeftRadius) };
    };
    const panels = [...document.querySelectorAll(".xdock.side-right .xdock-panel:not(.is-open)")].map(box).filter(Boolean);
    const dock = panels.sort((a, b) => b.r - a.r)[0] || null;
    return { fab: box(document.querySelector(".fab")), ai: box(document.getElementById("lai-fab")), dock };
  });
  await context.close();
  return out;
}

const near = (a, b) => Math.abs(a - b) <= 2;
function column(tag, items) {
  // items: top to bottom
  for (const it of items) {
    if (!it) fail(tag + ": every corner button is on the page");
  }
  for (let i = 1; i < items.length; i++) {
    const up = items[i - 1], down = items[i];
    if (!near(up.r, down.r)) fail(tag + ": the corner buttons share one right edge " + JSON.stringify(items));
    if (up.b > down.t - 4) fail(tag + ": the corner buttons stack without overlapping " + JSON.stringify(items));
  }
}
function square(tag, name, b) {
  if (!near(b.w, 56) || !near(b.h, 56)) fail(tag + ": the " + name + " button is 56px square " + JSON.stringify(b));
  if (!near(b.radius, 16)) fail(tag + ": the " + name + " button has the dock's 16px corners " + JSON.stringify(b));
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    let m = await measure(browser, origin, { width: 1280, height: 800 }, { aiFab: true, accent: "purple" });
    square("desktop", "Local AI", m.ai);
    column("desktop", [m.ai, m.dock]);
    console.log("desktop squares ok 1280");

    m = await measure(browser, origin, { width: 900, height: 1100 }, { aiFab: true, accent: "purple", navLayout: "bar" });
    square("desktop bar", "post", m.fab);
    square("desktop bar", "Local AI", m.ai);
    column("desktop bar", [m.fab, m.ai, m.dock]);
    console.log("desktop squares ok 900 bar");

    m = await measure(browser, origin, { width: 390, height: 844 }, { aiFab: true, navLayout: "bar" });
    if (!m.fab || m.fab.radius < m.fab.w / 2 - 1) fail("phone: the post button stays round " + JSON.stringify(m.fab));
    if (!m.ai || m.ai.radius < m.ai.w / 2 - 1) fail("phone: the Local AI button stays round " + JSON.stringify(m.ai));
    console.log("desktop squares ok phone round");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message);
});
