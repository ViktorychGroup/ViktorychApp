/* X-style line icons: Profile, Friends and Feeds outlines, the post button and the Viktorychs coin. Demo data only. */
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

async function open(browser, origin, vp, prefs) {
  const mobile = vp.width < 700;
  const context = await browser.newContext({ serviceWorkers: "block", viewport: vp, hasTouch: mobile, isMobile: mobile });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, body: "" }));
  await context.route("**/v1/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[],"stories":[],"ok":true}' }));
  await context.addInitScript((p) => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    const k = "viktorychapp-settings-v1";
    const st = JSON.parse(localStorage.getItem(k) || "{}");
    localStorage.setItem(k, JSON.stringify(Object.assign(st, p)));
  }, prefs);
  const page = await context.newPage();
  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .topbar", { timeout: 20000 });
  await page.waitForTimeout(1500);
  return { context, page };
}

function lineIcon(tag, html) {
  if (!/class="xline/.test(html || "")) fail(tag + " uses an X-style line icon: " + String(html).slice(0, 120));
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const I = { context: null };
    let { context, page } = await open(browser, origin, { width: 390, height: 844 }, { theme: "lightsout" });
    I.context = context;
    const got = await page.evaluate(() => {
      const V = window.ViktorychIcons;
      const fab = document.querySelector(".fab");
      return {
        folder: V.svg("folder"), folderOpen: V.svg("folderOpen"), profile: V.svg("profile"), friends: V.svg("friends"),
        feeds: V.svg("feeds"), spark: V.svg("spark"), coin: V.svg("coin"), fab: fab ? fab.innerHTML : "",
        giftCoin: window.ViktorychGifts && window.ViktorychGifts.coin ? window.ViktorychGifts.coin() : V.svg("coin")
      };
    });
    ["folder", "folderOpen", "profile", "friends", "feeds", "fab"].forEach((k) => lineIcon(k, got[k]));
    if (got.profile === got.friends) fail("Profile and Friends icons differ");
    if (got.feeds === got.spark) fail("Feeds and Local AI icons differ");
    if (!/fill="#000"/.test(got.coin) || !/stroke="#fff"/.test(got.coin) || !/stroke="rgba\(255,255,255/.test(got.coin)) fail("coin is black with white lines and a light rim");
    if (got.giftCoin !== got.coin) fail("the Viktorychs amount uses the same coin");
    const fill = await page.evaluate(() => {
      const g = document.querySelector(".fab svg.xline g");
      return g ? getComputedStyle(g).fill : "";
    });
    if (fill !== "none") fail("the post button icon is an outline, fill " + fill);
    console.log("x icons ok phone");
    if (SHOTS) {
      await page.screenshot({ path: SHOTS + "/phone-home.png" });
      const ava = await page.$(".m-ava[data-act='drawer']");
      if (ava) { await ava.click(); await page.waitForTimeout(800); await page.screenshot({ path: SHOTS + "/phone-drawer.png" }); }
    }
    await context.close();
    ({ context, page } = await open(browser, origin, { width: 1280, height: 800 }, { theme: "lightsout" }));
    if (SHOTS) await page.screenshot({ path: SHOTS + "/desktop.png" });
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
