/* Tab strips look like the X app's: one thin rounded underline under the
   active label only (as wide as the label, not the menu caret), bold active
   label, gray others, a hairline under the row, and no hover box on touch
   screens. Home and Notifications, phone and computer. No account names. */
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

const LOOK = `(() => {
  const bar = [...document.querySelectorAll("#app .tabs-bar")].find((el) => el.getBoundingClientRect().height > 20);
  if (!bar) return null;
  const lines = [];
  for (const el of bar.querySelectorAll("*")) {
    const cs = getComputedStyle(el, "::after");
    if (cs.content === "none" || cs.content === "normal" || el.closest(".tab-arrow")) continue;
    if (el.classList.contains("tab-arrow")) continue;
    const h = parseFloat(cs.height) || 0;
    if (!h || cs.position !== "absolute" || cs.backgroundColor === "rgba(0, 0, 0, 0)") continue;
    lines.push({ owner: el.tagName + "." + el.className, w: parseFloat(cs.width) || 0, h, radius: cs.borderRadius, label: el.tagName === "SPAN" ? el.getBoundingClientRect().width : -1 });
  }
  const on = bar.querySelector(".tab.on");
  const off = bar.querySelector(".tab:not(.on)");
  return {
    lines,
    onWeight: on ? Number(getComputedStyle(on).fontWeight) : 0,
    onColor: on ? getComputedStyle(on).color : "",
    offColor: off ? getComputedStyle(off).color : "",
    hairline: getComputedStyle(bar).borderBottomWidth,
    manage: !!bar.querySelector(".tab-manage"),
    plus: !!bar.querySelector(".tab-add, [data-act='tab-add']")
  };
})()`;

async function check(browser, origin, view, route, label) {
  const context = await browser.newContext({ viewport: view.size, hasTouch: view.touch, isMobile: view.touch, serviceWorkers: "block" });
  await context.addInitScript(() => { try { localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true })); } catch (err) {} });
  const page = await context.newPage();
  await page.goto(origin + "/#/" + route, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .tabs-bar .tab.on", { timeout: 20000 });
  await sleep(600);
  const look = await page.evaluate(LOOK);
  if (!look) fail(label + ": no tab strip");
  if (look.lines.length !== 1) fail(label + ": want exactly one underline, got " + JSON.stringify(look.lines));
  const line = look.lines[0];
  if (line.h < 2 || line.h > 3) fail(label + ": underline is not thin " + JSON.stringify(line));
  if (line.label < 0 || Math.abs(line.w - line.label) > 1) fail(label + ": underline is not the label width " + JSON.stringify(line));
  if (parseFloat(line.radius) < 2) fail(label + ": underline is not rounded " + JSON.stringify(line));
  if (look.onWeight < 700) fail(label + ": active label is not bold");
  if (look.offColor && look.offColor === look.onColor) fail(label + ": inactive labels are not gray");
  if (look.hairline !== "1px") fail(label + ": no hairline under the strip " + look.hairline);
  if (look.plus) fail(label + ": a + button was added to the strip");
  if (route === "" && !look.manage) fail(label + ": the customize button at the end of Home tabs is gone");
  if (route === "") {
    // The active tab's chevron sits snug after its label, centred on it, short and long names alike.
    for (const name of [null, "Fútbol del fin de semana"]) {
      const chev = await page.evaluate((name) => {
        const pair = [...document.querySelectorAll("#app .tabs-bar .tab-pair.on")].find((el) => el.getBoundingClientRect().width > 0);
        if (!pair) return null;
        const span = pair.querySelector(".tab.on > span:not(.tab-grip)");
        if (name) span.textContent = name;
        const s = span.getBoundingClientRect(), g = pair.querySelector(".tab-caret svg").getBoundingClientRect(), c = pair.querySelector(".tab-caret").getBoundingClientRect();
        return { gap: g.left - s.right, dy: (g.top + g.height / 2) - (s.top + s.height / 2), tail: c.right - g.right };
      }, name);
      if (!chev) fail(label + ": no menu chevron on the active Home tab");
      if (chev.gap < 2 || chev.gap > 6 || Math.abs(chev.dy) > 1.5 || chev.tail > 3) fail(label + ": the tab chevron is not snug next to the label " + JSON.stringify(chev));
    }
  }
  if (view.touch) {
    const box = await page.evaluate(() => {
      const tab = document.querySelector("#app .tabs-bar .tab:not(.on)");
      tab.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      return getComputedStyle(tab).backgroundColor;
    });
    await page.hover("#app .tabs-bar .tab:not(.on)").catch(() => {});
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector("#app .tabs-bar .tab:not(.on)")).backgroundColor);
    if (bg !== "rgba(0, 0, 0, 0)" || box !== "rgba(0, 0, 0, 0)") fail(label + ": a tab shows a box behind it on a touch screen " + bg);
  }
  await context.close();
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const views = [
      { name: "phone", size: { width: 390, height: 844 }, touch: true },
      { name: "tablet", size: { width: 800, height: 1000 }, touch: true },
      { name: "computer", size: { width: 1366, height: 900 }, touch: false }
    ];
    for (const view of views) {
      for (const route of ["", "notifications"]) await check(browser, origin, view, route, view.name + " " + (route || "home"));
    }
    console.log("tabs look ok");
  } finally {
    await browser.close();
    if (server.close && !sharedStaticServer()) server.close();
  }
}

main().catch((err) => { if (!process.exitCode) process.exitCode = 1; console.error(err && err.message || err); });
