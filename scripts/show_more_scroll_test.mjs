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

function controlBox(page) {
  return page.evaluate((id) => {
    const btn = document.querySelector('article[data-post="' + id + '"] button.show-more');
    const box = btn.getBoundingClientRect();
    return {
      top: box.top,
      bottom: box.bottom,
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      vh: window.innerHeight,
      expanded: btn.getAttribute("aria-expanded"),
      inView: box.top >= 8 && box.bottom <= window.innerHeight - 8
    };
  }, TARGET);
}

async function expandInPlace(page) {
  await page.evaluate((id) => {
    const btn = document.querySelector('article[data-post="' + id + '"] button.show-more[aria-expanded="false"]');
    btn.focus({ preventScroll: true });
  }, TARGET);
  await page.keyboard.press("Enter");
  await page.locator('article[data-post="' + TARGET + '"] button.show-more[aria-expanded="true"]').waitFor({ timeout: 10000 });
  await page.waitForTimeout(200);
}

async function pushOffscreen(page, label) {
  const before = await topOf(page);
  await page.evaluate((id) => {
    const post = document.querySelector('article[data-post="' + id + '"]');
    const btn = post.querySelector('button.show-more[aria-expanded="true"]');
    const block = document.createElement("div");
    const box = btn.getBoundingClientRect();
    block.style.height = Math.max(120, window.innerHeight - box.top + 40) + "px";
    btn.parentNode.insertBefore(block, btn);
  }, TARGET);
  await page.waitForTimeout(200);
  const after = await topOf(page);
  if (Math.abs(after - before) > 28) fail(label + " a late resize moved the post from " + before + " to " + after);
  const box = await controlBox(page);
  if (box.inView) fail(label + " Show less stayed on screen");
  return after;
}

async function userScroll(page, delta, touch) {
  if (!delta) return;
  if (touch) {
    await page.evaluate((distance) => {
      window.dispatchEvent(new Event("touchstart"));
      window.scrollBy(0, distance);
    }, delta);
  } else {
    await page.mouse.move(200, 420);
    await page.evaluate((distance) => {
      window.dispatchEvent(new WheelEvent("wheel", { deltaY: distance, bubbles: true, cancelable: true }));
      window.scrollBy(0, distance);
    }, delta);
  }
  await page.waitForTimeout(50);
}

async function bringControlOnScreen(page, label, touch) {
  const box = await controlBox(page);
  await userScroll(page, Math.round(box.top - (box.vh - 120)), touch);
  const seen = await controlBox(page);
  if (!seen.inView) fail(label + " the scroll left Show less off screen " + JSON.stringify(seen));
  return topOf(page);
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const port = server.address().port;
    for (const size of [{ name: "phone", width: 390, height: 844, touch: true }, { name: "desktop", width: 1280, height: 800, touch: false }]) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch, serviceWorkers: "block" });
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
      await page.waitForFunction((id) => {
        const el = document.querySelector('article[data-post="' + id + '"]');
        if (!el) return false;
        const top = el.getBoundingClientRect().top;
        if (Math.abs(top - 160) > 30) window.scrollBy(0, top - 160);
        return Math.abs(el.getBoundingClientRect().top - 160) <= 30;
      }, TARGET, { timeout: 5000 });
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
      await pushOffscreen(page, size.name);
      await page.evaluate((id) => {
        const btn = document.querySelector('article[data-post="' + id + '"] button.show-more[aria-expanded="true"]');
        btn.focus({ preventScroll: true });
      }, TARGET);
      await page.keyboard.press("Enter");
      await card.locator('button.show-more[aria-expanded="false"]').waitFor({ timeout: 10000 });
      await page.waitForTimeout(200);
      const closed = await topOf(page);
      if (Math.abs(closed - before) > 28) fail(size.name + " collapse moved the post from " + before + " to " + closed);

      await expandInPlace(page);
      await pushOffscreen(page, size.name + " pointer");
      const pointerBase = await bringControlOnScreen(page, size.name + " pointer", false);
      const pointerBox = await controlBox(page);
      if (!pointerBox.inView) fail(size.name + " pointer click started off screen");
      await page.mouse.click(pointerBox.x, pointerBox.y);
      await card.locator('button.show-more[aria-expanded="false"]').waitFor({ timeout: 10000 });
      await page.waitForTimeout(200);
      const pointerClosed = await topOf(page);
      if (Math.abs(pointerClosed - pointerBase) > 28) fail(size.name + " pointer collapse moved the post from " + pointerBase + " to " + pointerClosed);

      if (size.touch) {
        await expandInPlace(page);
        await pushOffscreen(page, size.name + " tap");
        const tapBase = await bringControlOnScreen(page, size.name + " tap", true);
        const tapBox = await controlBox(page);
        if (!tapBox.inView) fail(size.name + " tap started off screen");
        await page.touchscreen.tap(tapBox.x, tapBox.y);
        await card.locator('button.show-more[aria-expanded="false"]').waitFor({ timeout: 10000 });
        await page.waitForTimeout(200);
        const tapClosed = await topOf(page);
        if (Math.abs(tapClosed - tapBase) > 28) fail(size.name + " tap collapse moved the post from " + tapBase + " to " + tapClosed);
      }
      await context.close();
    }
    console.log("show more scroll ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
