/* Pinch-zoom lock on a phone: the viewport meta forbids page zoom, an iOS
   gesturestart is cancelled, double tap is off through touch-action, every text
   field on the checked pages is 16px or more (so iOS never zooms on focus), and
   a two finger pinch in the photo viewer still zooms the photo. "Allow page
   zoom" and the owner switch both reopen page zoom. Uses made-up posts only. */
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

const feeds = JSON.parse(fs.readFileSync(path.join(root, "feeds.json"), "utf8"));
const xFeed = feeds.posts.find((p) => p.platform === "x").feedId;
const PID = "910000000000000001";
feeds.posts = [{
  id: PID, statusId: PID, platform: "x", feedId: xFeed, kind: "post", author: "Test Author", handle: "tester1", avatar: "",
  text: "A test photo", date: new Date().toISOString(), url: "https://x.com/i/status/" + PID,
  media: [{ type: "photo", url: "https://pbs.twimg.com/media/zoomtest.png", width: 400, height: 300 }], stats: { likes: 1, reposts: 0, replies: 0 }
}].concat(feeds.posts);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const LOCKED = "maximum-scale=1, user-scalable=no";

async function open(browser, origin, hash, { settings, off } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(([s, o]) => {
    if (sessionStorage.getItem("zl-seeded")) return;
    sessionStorage.setItem("zl-seeded", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    if (s) localStorage.setItem("viktorychapp-settings-v1", JSON.stringify(s));
    if (o) localStorage.setItem("viktorychapp-server-off", JSON.stringify(o));
  }, [settings || null, off || null]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  await page.route("**/feeds.json*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(feeds) }));
  await page.route((u) => u.hostname.endsWith("twimg.com"), (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await page.goto(origin + "/" + hash, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-shell"), null, { timeout: 20000 });
  await sleep(800);
  return { ctx, page };
}

const viewportOf = (page) => page.evaluate(() => document.querySelector('meta[name="viewport"]').getAttribute("content"));

const chromium = await loadPlaywright();
const server = await startServer();
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
try {
  // 1. Locked by default: meta, attribute, touch-action, gesturestart cancelled.
  {
    const { ctx, page } = await open(browser, origin, "#/");
    const meta = await viewportOf(page);
    if (!meta.includes(LOCKED)) fail("zoom lock: viewport meta is not locked: " + meta);
    const facts = await page.evaluate(() => {
      const ev = new Event("gesturestart", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return { attr: document.documentElement.getAttribute("data-zoom-lock"), touch: getComputedStyle(document.body).touchAction, cancelled: ev.defaultPrevented };
    });
    if (facts.attr !== "1") fail("zoom lock: html[data-zoom-lock] missing");
    if (facts.touch !== "manipulation") fail("zoom lock: body touch-action is " + facts.touch);
    if (!facts.cancelled) fail("zoom lock: gesturestart was not cancelled");

    // 2. The photo viewer still zooms with two fingers.
    // Home can repaint between queries and while Playwright waits for stability.
    // Resolve and activate the control in one retried page task instead.
    await page.waitForFunction((id) => {
      const el = document.querySelector(`[data-act="view"][data-id="${id}"]`);
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.click();
      return true;
    }, PID, { timeout: 20000 });
    await page.waitForSelector("#viewer-img", { timeout: 10000 });
    await sleep(300);
    const cdp = await ctx.newCDPSession(page);
    const cx = 195, cy = 420;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx - 40, y: cy, id: 1 }, { x: cx + 40, y: cy, id: 2 }] });
    for (let i = 1; i <= 8; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx - 40 - i * 10, y: cy, id: 1 }, { x: cx + 40 + i * 10, y: cy, id: 2 }] });
      await sleep(16);
    }
    const zoomed = await page.evaluate(() => document.getElementById("viewer-img").style.transform);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const scale = Number((/scale\(([\d.]+)\)/.exec(zoomed) || [])[1] || 1);
    if (!(scale > 1.5)) fail("zoom lock: viewer pinch did not zoom the photo: " + zoomed);
    if (page.errors.length) fail("zoom lock: page errors " + page.errors.join(" | "));
    await ctx.close();
  }

  // 3. Text fields are 16px or more on the pages that had smaller ones.
  for (const hash of ["#/settings", "#/messages", "#/bookmarks", "#/feeds", "#/settings/privacy"]) {
    const { ctx, page } = await open(browser, origin, hash);
    await sleep(1500);
    const small = await page.evaluate(() => [...document.querySelectorAll("input, textarea, select")].filter((el) => {
      const t = (el.type || "").toLowerCase();
      if (["checkbox", "radio", "range", "color", "hidden", "file", "button", "submit"].includes(t)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && parseFloat(getComputedStyle(el).fontSize) < 16;
    }).map((el) => el.tagName + (el.id ? "#" + el.id : "") + "." + String(el.className).split(" ")[0] + "=" + getComputedStyle(el).fontSize));
    if (small.length) fail("zoom lock: fields under 16px on " + hash + ": " + small.join(", "));
    await ctx.close();
  }

  // 4. "Allow page zoom" reopens zoom, from the setting and right after the tap.
  {
    const { ctx, page } = await open(browser, origin, "#/", { settings: { pageZoom: true } });
    const meta = await viewportOf(page);
    if (meta.includes("user-scalable=no")) fail("zoom lock: Allow page zoom still locked: " + meta);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, origin, "#/settings/display");
    const sw = page.locator('[data-act="page-zoom"]');
    await sw.waitFor({ timeout: 10000 });
    if ((await sw.getAttribute("aria-checked")) !== "false") fail("zoom lock: Allow page zoom should start off");
    await sw.click();
    await sleep(300);
    if ((await viewportOf(page)).includes("user-scalable=no")) fail("zoom lock: tapping Allow page zoom did not unlock");
    if (await page.evaluate(() => document.documentElement.hasAttribute("data-zoom-lock"))) fail("zoom lock: attribute stayed after unlock");
    await ctx.close();
  }

  // 5. The owner switch turns the lock off and hides the setting.
  {
    const { ctx, page } = await open(browser, origin, "#/settings/display", { off: ["zoom_lock"] });
    const meta = await viewportOf(page);
    if (meta.includes("user-scalable=no")) fail("zoom lock: switch off still locked: " + meta);
    if (await page.locator('[data-act="page-zoom"]').count()) fail("zoom lock: setting shown while the switch is off");
    const cancelled = await page.evaluate(() => { const ev = new Event("gesturestart", { bubbles: true, cancelable: true }); document.body.dispatchEvent(ev); return ev.defaultPrevented; });
    if (cancelled) fail("zoom lock: gesturestart cancelled while the switch is off");
    await ctx.close();
  }
  console.log("zoom lock ok");
} finally {
  await browser.close();
  if (!sharedStaticServer()) server.close();
}
