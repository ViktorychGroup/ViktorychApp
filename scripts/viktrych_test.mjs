/* Viktrych (the on-device AI): its name, its logo on the AI button, the phone button lined up with the + button, and one AI button per post. Demo data only. */
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

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    let { context, page } = await open(browser, origin, { width: 390, height: 844 }, { aiFab: true, theme: "lightsout" });
    const m = await page.evaluate(() => {
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
      const fab = document.querySelector(".fab");
      const ai = document.getElementById("lai-fab");
      const bylines = [...document.querySelectorAll("article.post .byline-end, article.post .status-end")];
      return {
        fab: box(fab), ai: box(ai), logo: !!(ai && ai.querySelector("svg.vk-logo")), label: ai ? ai.getAttribute("aria-label") : "",
        most: bylines.reduce((n, el) => Math.max(n, el.querySelectorAll(".explain-btn").length), 0), posts: bylines.length
      };
    });
    if (!m.logo) fail("the AI button shows the Viktrych logo");
    if (m.label !== "Viktrych") fail("the AI button is called Viktrych, got " + m.label);
    if (!m.fab || !m.ai) fail("both corner buttons are on the page " + JSON.stringify(m));
    const near = (a, b) => Math.abs(a - b) <= 1;
    if (!near(m.ai.w, m.fab.w) || !near(m.ai.h, m.fab.h)) fail("the Viktrych button is the + button's size " + JSON.stringify(m));
    if (!near(m.ai.r, m.fab.r)) fail("the Viktrych button shares the + button's right edge " + JSON.stringify(m));
    if (!near(m.fab.t - m.ai.b, 12)) fail("the Viktrych button sits 12px above the + button " + JSON.stringify(m));
    if (!m.posts) fail("posts rendered");
    if (m.most > 1) fail("a post shows " + m.most + " AI buttons, not one");
    console.log("viktrych ok phone");
    if (SHOTS) await page.screenshot({ path: SHOTS + "/phone-buttons.png" });
    await context.close();
    for (const lang of ["es", "ru", "hi"]) {
      ({ context, page } = await open(browser, origin, { width: 390, height: 844 }, { aiFab: true }, lang));
      const label = await page.evaluate(() => document.getElementById("lai-fab").getAttribute("aria-label"));
      if (label !== "Viktrych") fail(lang + ": the AI button is called Viktrych, got " + label);
      await context.close();
    }
    console.log("viktrych ok languages");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message);
});
