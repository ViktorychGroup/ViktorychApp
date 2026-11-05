/* Sideways swipe between Home tabs on a phone: the timeline follows the
   finger, the underline moves, a long or quick swipe switches, a short one
   springs back, vertical scrolling is untouched, reduced motion still
   switches without sliding, and the owner switch turns it off.
   Nothing here prints account names. */
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


async function drag(cdp, from, to, steps, holdMs) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from[0], y: from[1] }] });
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + (to[0] - from[0]) * i / steps;
    const y = from[1] + (to[1] - from[1]) * i / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x, y: y }] });
    await sleep(16);
  }
  if (holdMs) await sleep(holdMs);
}
async function release(cdp) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
const STATE = `(() => {
  const on = document.querySelector("#app .topbar .tabs [role='tab'][aria-selected='true']");
  const list = document.querySelector("#app .topbar .tabs[role='tablist']");
  const bar = list && list.closest(".topbar");
  const next = bar && bar.nextElementSibling;
  return {
    hash: location.hash,
    tab: on ? on.getAttribute("data-tab") : "",
    swiping: !!(list && list.classList.contains("swiping")),
    ind: list ? list.style.getPropertyValue("--swipe-ind") : "",
    moved: next ? next.style.transform : ""
  };
})()`;

async function openHome(browser, origin, extra, off) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, serviceWorkers: "block", ...extra });
  if (off) await context.addInitScript(() => { try { localStorage.setItem("viktorychapp-server-off", JSON.stringify(["swipe_tabs"])); } catch (err) {} });
  const page = await context.newPage();
  const errors = [];
  // Only errors thrown by the app's own files count; a browser add-on on the
  // test machine can throw into the page too.
  page.on("pageerror", (err) => {
    const message = String(err && err.message || err);
    // Chrome's extension activity logger throws this into the page. It is not app code.
    if (message === "this.api.logApiCall is not a function") return;
    if (/127\.0\.0\.1/.test(String(err && err.stack || ""))) errors.push(message.slice(0, 200));
  });
  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .topbar .tabs [role='tab'][data-tab='following']", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll("#app article").length > 2, null, { timeout: 20000 });
  await sleep(300);
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp, errors };
}
async function waitTab(page, tab) {
  return page.waitForFunction((want) => {
    const on = document.querySelector("#app .topbar .tabs [role='tab'][aria-selected='true']");
    return !!on && on.getAttribute("data-tab") === want;
  }, tab, { timeout: 5000 }).then(() => true, () => false);
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    let run = await openHome(browser, origin, {});
    const y = 640;
    // Mid-drag: the timeline follows the finger and the underline moves.
    await drag(run.cdp, [320, y], [150, y + 6], 10, 0);
    const mid = await run.page.evaluate(STATE);
    if (!mid.swiping || !mid.ind || mid.ind === "0px") fail("underline did not follow the swipe " + JSON.stringify(mid));
    if (!/translate3d\(-/.test(mid.moved)) fail("timeline did not follow the finger " + JSON.stringify(mid));
    await drag(run.cdp, [150, y + 6], [60, y + 8], 4, 0);
    await release(run.cdp);
    if (!(await waitTab(run.page, "following"))) fail("swipe left did not open Following " + JSON.stringify(await run.page.evaluate(STATE)));
    await sleep(500);
    const after = await run.page.evaluate(STATE);
    if (after.swiping || /translate3d\(-3/.test(after.moved)) fail("swipe left a moved timeline behind " + JSON.stringify(after));
    if (process.env.SHOT) await run.page.screenshot({ path: process.env.SHOT });
    // A short drag springs back and stays on the tab.
    await run.page.waitForFunction(() => document.querySelectorAll("#app article").length > 0, null, { timeout: 15000 }).catch(() => {});
    await drag(run.cdp, [300, y], [250, y], 5, 300);
    await release(run.cdp);
    await sleep(400);
    if ((await run.page.evaluate(STATE)).tab !== "following") fail("a short drag switched tabs");
    // Swipe right goes back.
    await drag(run.cdp, [80, y], [330, y], 8, 0);
    await release(run.cdp);
    if (!(await waitTab(run.page, "foryou"))) fail("swipe right did not return to For you");
    await sleep(400);
    // Up and down scrolling is never taken, even with a little sideways drift.
    await drag(run.cdp, [300, 700], [270, 300], 10, 0);
    await release(run.cdp);
    await sleep(400);
    const vert = await run.page.evaluate(STATE);
    if (vert.tab !== "foryou" || vert.swiping) fail("a vertical scroll switched tabs " + JSON.stringify(vert));
    // At the first tab a right swipe has nowhere to go.
    await run.page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    await drag(run.cdp, [80, y], [330, y], 8, 0);
    await release(run.cdp);
    await sleep(500);
    if ((await run.page.evaluate(STATE)).tab !== "foryou") fail("a right swipe on the first tab moved away");
    if (run.errors.length) fail("page errors: " + run.errors.join(" | "));
    await run.context.close();

    // Reduced motion: the swipe still switches, with nothing sliding.
    run = await openHome(browser, origin, { reducedMotion: "reduce" });
    await drag(run.cdp, [320, y], [100, y], 8, 0);
    const still = await run.page.evaluate(STATE);
    if (still.moved && still.moved !== "none") fail("reduced motion still slid the timeline " + JSON.stringify(still));
    await release(run.cdp);
    if (!(await waitTab(run.page, "following"))) fail("reduced motion swipe did not switch");
    await run.context.close();

    // The owner switch turns it off.
    run = await openHome(browser, origin, {}, true);
    await drag(run.cdp, [320, y], [60, y], 8, 0);
    await release(run.cdp);
    await sleep(600);
    if ((await run.page.evaluate(STATE)).tab !== "foryou") fail("swipe worked with swipe_tabs off");
    await run.context.close();
    console.log("swipe tabs ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message ? err.message : err);
});
