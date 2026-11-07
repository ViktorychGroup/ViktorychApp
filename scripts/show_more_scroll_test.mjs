/* Show more keeps the opened post on screen. Tall cards above it used to
   be guessed at 220px after the redraw, so the old scroll landed elsewhere.
   Dummy posts only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fail(message) { console.error(message); process.exitCode = 1; throw new Error(message); }
function mime(file) {
  if (/\.m?js$/.test(file)) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}
const LONG = ("A full sentence of a long post so Show more has something to open. ").repeat(12);
const TARGET = "p15";
const posts = [];
const feeds = [];
for (let i = 0; i < 20; i++) {
  const id = "p" + String(i).padStart(2, "0");
  const handle = "lane" + i;
  feeds.push({ id: handle, platform: "rss", handle: handle, name: "Lane " + i });
  posts.push({
    id: id,
    statusId: id,
    platform: "rss",
    feedId: handle,
    kind: "post",
    date: new Date(Date.now() - i * 3600000).toISOString().replace(/\.\d{3}Z$/, ".000Z"),
    text: i === 15 ? LONG : (("Card " + i + "\n").repeat(12)),
    author: "Lane " + i,
    handle: handle,
    media: []
  });
}
const catalog = { updated: "2026-11-07T00:00:00.000Z", feeds: feeds, posts: posts };

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/feeds.json") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(catalog));
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("missing"); return; }
      res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  return mod.chromium || (mod.default && mod.default.chromium);
}
function topOf(page) {
  return page.evaluate((id) => {
    const el = document.querySelector('article[data-post="' + id + '"]');
    return el ? el.getBoundingClientRect().top : null;
  }, TARGET);
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const port = server.address().port;
    for (const size of [{ name: "phone", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 800 }]) {
      const context = await browser.newContext({ viewport: size, serviceWorkers: "block" });
      const page = await context.newPage();
      await page.addInitScript(() => {
        localStorage.setItem("superintelapp-lang", "en");
        localStorage.setItem("viktorychapp-lang-user-picked", "1");
        localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
        const follows = [];
        for (let i = 0; i < 20; i++) follows.push("lane" + i);
        localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, follows: follows, lists: [], feedTabs: [] }));
      });
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("http://127.0.0.1")) route.continue();
        else route.abort();
      });
      await page.goto("http://127.0.0.1:" + port + "/index.html#/following", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("article[data-post]", { timeout: 20000 });
      for (let n = 0; n < 15; n++) {
        const seen = await page.evaluate((id) => !!document.querySelector('article[data-post="' + id + '"]'), TARGET);
        if (seen) break;
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(250);
      }
      await page.waitForFunction((id) => document.querySelector('article[data-post="' + id + '"]'), TARGET, { timeout: 20000 }).catch(async () => {
        const ids = await page.evaluate(() => [...document.querySelectorAll("article[data-post]")].map((el) => el.getAttribute("data-post")).slice(0, 20));
        fail(size.name + " feed ids " + ids.join(","));
      });
      const card = page.locator('article[data-post="' + TARGET + '"]');
      await page.evaluate((id) => {
        const el = document.querySelector('article[data-post="' + id + '"]');
        window.scrollBy(0, el.getBoundingClientRect().top - 160);
      }, TARGET);
      await page.waitForTimeout(100);
      await page.evaluate((id) => {
        const btn = document.querySelector('article[data-post="' + id + '"] button.show-more[data-act="more"]');
        if (btn) btn.focus({ preventScroll: true });
      }, TARGET);
      const before = await topOf(page);
      await page.keyboard.press("Enter");
      await card.locator('button.show-more[aria-expanded="true"]').waitFor({ timeout: 10000 });
      await page.waitForTimeout(200);
      const opened = await topOf(page);
      if (Math.abs(opened - before) > 28) fail(size.name + " expand moved the post from " + before + " to " + opened);
      const focusInside = await page.evaluate((id) => {
        const el = document.activeElement;
        const post = document.querySelector('article[data-post="' + id + '"]');
        return !!(el && post && post.contains(el));
      }, TARGET);
      if (!focusInside) fail(size.name + " focus left the opened post");
      await page.evaluate((id) => {
        const post = document.querySelector('article[data-post="' + id + '"]');
        const btn = post.querySelector('button.show-more[aria-expanded="true"]');
        const block = document.createElement("div");
        block.style.height = "480px";
        btn.parentNode.insertBefore(block, btn);
      }, TARGET);
      await page.waitForTimeout(200);
      const afterMedia = await topOf(page);
      if (Math.abs(afterMedia - before) > 28) fail(size.name + " a late resize moved the post from " + before + " to " + afterMedia);
      const hidden = await page.evaluate((id) => {
        const btn = document.querySelector('article[data-post="' + id + '"] button.show-more[aria-expanded="true"]');
        const box = btn.getBoundingClientRect();
        return box.top >= window.innerHeight;
      }, TARGET);
      if (!hidden) fail(size.name + " Show less stayed on screen");
      // A locator click scrolls an off-screen control into view before the
      // page samples its position, which is the 748 to -20 jump. Press the
      // focused control without moving the feed.
      await page.evaluate((id) => {
        const btn = document.querySelector('article[data-post="' + id + '"] button.show-more[aria-expanded="true"]');
        btn.focus({ preventScroll: true });
      }, TARGET);
      await page.keyboard.press("Enter");
      await card.locator('button.show-more[aria-expanded="false"]').waitFor({ timeout: 10000 });
      await page.waitForTimeout(200);
      const closed = await topOf(page);
      if (Math.abs(closed - before) > 28) fail(size.name + " collapse moved the post from " + before + " to " + closed);
      await context.close();
    }
    console.log("show more scroll ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
