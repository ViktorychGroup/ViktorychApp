/* Visible updates (switch update_notice): What's new is a full-screen,
   edge-to-edge dark page with our logo, one card per changelog line and one
   Continue button; Escape, a swipe or Continue closes it; it shows once per
   version and on a cold start into a new build; no animation with reduced
   motion; the switch off keeps the classic sheet. The Updating toast is
   small and never takes taps. Made-up changelog lines only. */
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


const SHOTS = process.env.SHOT_DIR || "";
const feeds = JSON.parse(fs.readFileSync(path.join(root, "feeds.json"), "utf8"));
const xFeed = feeds.posts.find((p) => p.platform === "x").feedId;
feeds.posts = [1, 2, 3].map((n) => ({
  id: "92000000000000000" + n, statusId: "92000000000000000" + n, platform: "x", feedId: xFeed, kind: "post", author: "Demo Writer " + n, handle: "demo" + n, avatar: "",
  text: "A made-up demo post number " + n, date: new Date(Date.now() - n * 60000).toISOString(), url: "https://x.com/i/status/92000000000000000" + n, media: [], stats: { likes: n, reposts: 0, replies: 0 }
}));
const SHA = "a".repeat(40);
const NOTES = ["Fixed the grey gap above the phone header", "Faster, smoother For you loading", "Tab strips like the X app", "Swipe between your tabs"];

async function open(browser, origin, { off, reduce } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: reduce ? "reduce" : "no-preference" });
  await ctx.addInitScript((o) => {
    if (sessionStorage.getItem("un-seeded")) return;
    sessionStorage.setItem("un-seeded", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-server-off", JSON.stringify(o || []));
    localStorage.setItem("viktorychapp-server-off-at", String(Date.now()));
  }, off || null);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  await page.route("**/feeds.json*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(feeds) }));
  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-shell") && window.ViktorychUpdate, null, { timeout: 20000 });
  await sleep(500);
  return { ctx, page };
}

const chromium = await loadPlaywright();
const server = await startServer();
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
try {
  // 1. What's new is a full-screen, edge-to-edge dark page with cards and one Continue.
  {
    const { ctx, page } = await open(browser, origin);
    const opened = await page.evaluate(([sha, notes]) => window.ViktorychUpdate.showReleaseNotes(sha, notes), [SHA, NOTES]);
    if (opened !== true) fail("update notice: What's new did not open");
    await sleep(700);
    const facts = await page.evaluate(() => {
      const el = document.getElementById("upd-notes-sheet");
      const r = el.getBoundingClientRect();
      const go = [...el.querySelectorAll("button")].filter((b) => b.textContent.trim());
      return {
        cls: el.className, x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight,
        bg: getComputedStyle(el).backgroundColor, modal: el.getAttribute("aria-modal"),
        cards: [...el.querySelectorAll(".upd-wn-card")].map((c) => c.getAttribute("data-icon") + ":" + c.textContent.trim()),
        icons: el.querySelectorAll(".upd-wn-card .upd-wn-ic svg").length,
        logo: !!el.querySelector("img.upd-wn-logo"),
        buttons: go.map((b) => b.textContent.trim()),
        focus: document.activeElement && document.activeElement.id,
        title: el.querySelector("h2").textContent
      };
    });
    if (!/upd-wn/.test(facts.cls)) fail("update notice: not the full-screen page " + facts.cls);
    if (facts.x !== 0 || facts.y !== 0 || facts.w !== facts.vw || facts.h !== facts.vh) fail("update notice: not edge to edge " + JSON.stringify(facts));
    if (facts.bg !== "rgb(0, 0, 0)") fail("update notice: background is not dark " + facts.bg);
    if (facts.modal !== "true") fail("update notice: page is not modal");
    if (facts.cards.length !== NOTES.length || facts.icons !== NOTES.length) fail("update notice: cards " + JSON.stringify(facts.cards));
    if (!facts.cards[0].startsWith("fix:") || !facts.cards[1].startsWith("fast:")) fail("update notice: icons " + JSON.stringify(facts.cards));
    if (!facts.logo) fail("update notice: logo missing");
    if (facts.buttons.join("|") !== "Continue") fail("update notice: buttons " + facts.buttons.join("|"));
    if (facts.focus !== "upd-gotit") fail("update notice: Continue not focused");
    if (facts.title !== "What's new") fail("update notice: title " + facts.title);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "whats-new.png") });
    await page.click("#upd-gotit");
    if (await page.$("#upd-notes-sheet")) fail("update notice: Continue did not close");
    if (await page.evaluate(() => document.documentElement.classList.contains("upd-wn-open"))) fail("update notice: scroll lock stayed");
    // Once per version.
    const again = await page.evaluate(([sha, notes]) => window.ViktorychUpdate.showReleaseNotes(sha, notes), [SHA, NOTES]);
    if (again !== false) fail("update notice: What's new showed twice for one version");
    // Escape and a swipe down close a newer one.
    await page.evaluate((notes) => window.ViktorychUpdate.showReleaseNotes("b".repeat(40), notes), NOTES);
    await page.keyboard.press("Escape");
    if (await page.$("#upd-notes-sheet")) fail("update notice: Escape did not close");
    await page.evaluate((notes) => window.ViktorychUpdate.showReleaseNotes("c".repeat(40), notes), NOTES);
    await page.evaluate(() => {
      const el = document.getElementById("upd-notes-sheet");
      const t = (y) => new Touch({ identifier: 1, target: el, clientX: 200, clientY: y });
      el.dispatchEvent(new TouchEvent("touchstart", { touches: [t(200)], changedTouches: [t(200)], bubbles: true }));
      el.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [t(400)], bubbles: true }));
    });
    if (await page.$("#upd-notes-sheet")) fail("update notice: swipe down did not close");
    // A build the device has not run before opens What's new; the first run does not.
    await page.evaluate(() => window.ViktorychUpdate.onWorkerMessage({ type: "sw-version", sha: "d".repeat(40) }));
    await sleep(600);
    if (await page.$("#upd-notes-sheet")) fail("update notice: first run opened What's new");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-shell") && window.ViktorychUpdate, null, { timeout: 20000 });
    await page.evaluate(() => window.ViktorychUpdate.onWorkerMessage({ type: "sw-version", sha: "e".repeat(40) }));
    await page.waitForSelector("#upd-notes-sheet.upd-wn", { timeout: 5000 }).catch(() => fail("update notice: a new build on cold start did not open What's new"));
    const generic = await page.locator(".upd-wn-card").count();
    if (generic < 1) fail("update notice: cold start page has no cards");
    // The Updating toast: small, near the top, out of the way of taps.
    await page.click("#upd-gotit");
    await page.evaluate(() => {
      const el = document.getElementById("upd-status");
      el.hidden = false;
      document.getElementById("upd-status-text").textContent = "Updating ViktorychApp…";
    });
    await sleep(300);
    const toast = await page.evaluate(() => {
      const el = document.getElementById("upd-status");
      const r = el.getBoundingClientRect();
      return { h: r.height, top: r.top, pe: getComputedStyle(el).pointerEvents, live: el.getAttribute("aria-live") };
    });
    if (!(toast.h > 0 && toast.h <= 40 && toast.top < 60) || toast.pe !== "none" || toast.live !== "polite") fail("update notice: toast " + JSON.stringify(toast));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "updating-toast.png") });
    if (page.errors.length) fail("update notice: page errors " + page.errors.join(" | "));
    await ctx.close();
  }
  // 2. Reduced motion: no animation.
  {
    const { ctx, page } = await open(browser, origin, { reduce: true });
    await page.evaluate(([sha, notes]) => window.ViktorychUpdate.showReleaseNotes(sha, notes), [SHA, NOTES]);
    const anim = await page.evaluate(() => [getComputedStyle(document.getElementById("upd-notes-sheet")).animationName, getComputedStyle(document.querySelector(".upd-wn-card")).animationName]);
    if (anim.some((name) => name !== "none")) fail("update notice: animates with reduced motion " + anim.join(","));
    await ctx.close();
  }
  // 3. The owner switch off keeps the classic bottom sheet.
  {
    const { ctx, page } = await open(browser, origin, { off: ["update_notice"] });
    await page.evaluate(([sha, notes]) => window.ViktorychUpdate.showReleaseNotes(sha, notes), [SHA, NOTES]);
    if (!(await page.$("#upd-notes-sheet .upd-sheet-card")) || (await page.$(".upd-wn"))) fail("update notice: switch off did not keep the classic sheet");
    await ctx.close();
  }
  console.log("update notice ok");
} finally {
  await browser.close();
  if (!sharedStaticServer()) server.close();
}
