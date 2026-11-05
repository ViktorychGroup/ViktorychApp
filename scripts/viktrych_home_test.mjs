/* Viktrych chat home: once a model is ready the page looks like the Grok app home (a big plain logo, clean empty state, a rounded box pinned to the bottom) and the box has focus so the keyboard opens. Demo data only. */
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
const SHOTS = process.env.SHOTS || "";

async function open(browser, origin, vp, prefs, lang) {
  const mobile = vp.width < 700;
  const context = await browser.newContext({ serviceWorkers: "block", viewport: vp, hasTouch: mobile, isMobile: mobile });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, body: "" }));
  await context.route("**/v1/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[],"stories":[],"ok":true}' }));
  await context.addInitScript((a) => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", a.lang);
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    const k = "viktorychapp-settings-v1";
    const st = JSON.parse(localStorage.getItem(k) || "{}");
    localStorage.setItem(k, JSON.stringify(Object.assign(st, a.prefs)));
  }, { prefs, lang: lang || "en" });
  const page = await context.newPage();
  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .topbar", { timeout: 20000 });
  await page.waitForSelector("#lai-fab", { timeout: 20000 });
  await page.waitForTimeout(1500);
  return { context, page };
}

const READY = { aiFab: true, theme: "lightsout", aiSetup: { v: 1, done: true, model: "instant", lang: "en", canChange: true, history: "keep" } };

function look() {
  const root = document.querySelector(".lai");
  const vis = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0;
  const bar = document.querySelector(".lai-bar");
  const r = bar ? bar.getBoundingClientRect() : null;
  const mark = document.querySelector(".lai-hero-mark");
  const mr = mark ? mark.getBoundingClientRect() : null;
  const browse = document.querySelector(".lai-browse");
  return {
    empty: !!root && root.classList.contains("is-empty"),
    focused: !!document.activeElement && document.activeElement.classList.contains("lai-input"),
    logo: !!document.querySelector(".lai-hero-mark svg.vk-logo"),
    markW: mr ? mr.width : 0, markMid: mr ? mr.left + mr.width / 2 : 0,
    barBottom: r ? r.bottom : 0, radius: bar ? parseFloat(getComputedStyle(bar).borderTopLeftRadius) : 0,
    browse: vis(browse), qs: vis(document.querySelector(".lai-chip-qs")), h: innerHeight, w: innerWidth
  };
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    let { context, page } = await open(browser, origin, { width: 390, height: 844 }, READY);
    await page.tap("#lai-fab");
    await page.waitForSelector(".lai .lai-input", { timeout: 20000 });
    await page.waitForTimeout(800);
    let m = await page.evaluate(look);
    if (!m.empty) fail("a new chat starts empty " + JSON.stringify(m));
    if (!m.focused) fail("phone: the message box has focus so the keyboard opens " + JSON.stringify(m));
    if (!m.logo || m.markW < 60) fail("phone: a large Viktrych logo sits in the middle " + JSON.stringify(m));
    if (Math.abs(m.markMid - m.w / 2) > 2) fail("phone: the logo is centred " + JSON.stringify(m));
    if (m.browse) fail("phone: the empty chat is clean, quick settings stay behind their chip " + JSON.stringify(m));
    if (!m.qs) fail("phone: the Quick settings chip is there " + JSON.stringify(m));
    if (m.barBottom < m.h - 80) fail("phone: the message box is pinned to the bottom " + JSON.stringify(m));
    if (m.radius < 24) fail("phone: the message box is rounded " + JSON.stringify(m));
    if (SHOTS) await page.screenshot({ path: SHOTS + "/phone-home.png" });
    await page.tap(".lai-chip-qs");
    await page.waitForTimeout(300);
    m = await page.evaluate(look);
    if (!m.browse) fail("phone: the Quick settings chip opens quick settings " + JSON.stringify(m));
    console.log("viktrych-home ok phone");
    await context.close();

    ({ context, page } = await open(browser, origin, { width: 1280, height: 800 }, READY));
    await page.goto(origin + "/#/ai", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".lai .lai-input", { timeout: 20000 });
    await page.waitForTimeout(800);
    m = await page.evaluate(look);
    if (!m.focused) fail("desktop: the message box has focus " + JSON.stringify(m));
    if (m.qs) fail("desktop: quick settings show inline, no chip " + JSON.stringify(m));
    if (!m.browse) fail("desktop: quick settings still show inline " + JSON.stringify(m));
    console.log("viktrych-home ok desktop");
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message);
});
