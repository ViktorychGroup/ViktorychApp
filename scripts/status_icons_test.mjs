/* Header status icons (status_icons): off until picked in Display settings;
   on phones one row centred with the Local AI button, on tablets just before
   the tab settings button, never on computers; battery only where the
   browser has it; offline shows; the owner switch hides them all. */
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


const ALL = { clock: true, battery: true, network: true, unread: true };
const NOTES = [{ id: "n1", at: Date.now(), handle: "news", name: "News", text: "x", hash: "#/" }, { id: "n2", at: Date.now(), handle: "news", name: "News", text: "y", hash: "#/" }];

async function open(browser, origin, opts) {
  const touch = opts.view !== "computer";
  const size = opts.view === "phone" ? { width: 390, height: 844 } : opts.view === "tablet" ? { width: 820, height: 1180 } : { width: 1366, height: 900 };
  const context = await browser.newContext({ viewport: size, hasTouch: touch, isMobile: touch, serviceWorkers: "block" });
  await context.addInitScript((o) => {
    try {
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      if (!sessionStorage.getItem("st-seed")) {
        sessionStorage.setItem("st-seed", "1");
        if (o.settings) localStorage.setItem("viktorychapp-settings-v1", JSON.stringify(o.settings));
        if (o.ownerOff) localStorage.setItem("viktorychapp-server-off", JSON.stringify(["status_icons"]));
      }
    } catch (err) {}
    if (o.battery) {
      const bat = { level: 0.72, charging: false, addEventListener() {} };
      Object.defineProperty(Navigator.prototype, "getBattery", { configurable: true, value: () => Promise.resolve(bat) });
    } else {
      delete Navigator.prototype.getBattery;
    }
    Object.defineProperty(Navigator.prototype, "connection", { configurable: true, get: () => ({ type: "wifi", effectiveType: "4g", addEventListener() {} }) });
  }, opts);
  const page = await context.newPage();
  await page.goto(origin + "/#/" + (opts.route || ""), { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .tabs-bar .tab.on", { timeout: 20000 }).catch(() => {});
  await sleep(900);
  return { context, page };
}

const READ = `(() => {
  const box = [...document.querySelectorAll(".sticons")].find((el) => el.getBoundingClientRect().width > 0);
  if (!box) return null;
  const r = box.getBoundingClientRect();
  const kids = [...box.children].map((el) => { const k = el.getBoundingClientRect(); return { st: el.dataset.st, cy: k.top + k.height / 2, h: k.height, off: el.classList.contains("is-off") }; });
  const ai = document.querySelector(".mhead .m-ai");
  const a = ai && ai.getBoundingClientRect();
  const manage = document.querySelector(".tabs-bar .tab-manage");
  const m = manage && manage.getBoundingClientRect();
  return { inMhead: !!box.closest(".mhead"), inTabs: !!box.closest(".tabs-bar"), cy: r.top + r.height / 2, right: r.right, kids,
    ai: a && a.width ? { left: a.left, cy: a.top + a.height / 2 } : null,
    manage: m && m.width ? { left: m.left, cy: m.top + m.height / 2 } : null,
    nextIsManage: !!(box.nextElementSibling && box.nextElementSibling.classList.contains("tab-manage")) };
})()`;

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    // 1. Off by default; picking Clock in Display settings shows it.
    {
      const { context, page } = await open(browser, origin, { view: "phone", battery: true });
      if (await page.evaluate(READ)) fail("status icons show before any is picked");
      await page.goto(origin + "/#/settings/display");
      await page.waitForSelector('[data-act="status-icon"][data-key="clock"]', { timeout: 15000 });
      const keys = await page.$$eval('[data-act="status-icon"]', (els) => els.map((el) => el.dataset.key + ":" + el.getAttribute("aria-checked")));
      if (keys.join() !== "clock:false,battery:false,network:false,unread:false") fail("settings switches wrong " + keys.join());
      await page.click('[data-act="status-icon"][data-key="clock"]');
      await sleep(300);
      // A fresh load: Home may stand in its last saved screen while posts load.
      await page.goto(origin + "/#/");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".mhead .sticons", { state: "visible", timeout: 15000 }).catch(() => {});
      await sleep(300);
      const got = await page.evaluate(READ);
      if (!got || got.kids.map((k) => k.st).join() !== "clock") fail("picking Clock did not show only the clock " + JSON.stringify(got));
      await context.close();
    }
    // 2. Phone: all picked, one row, centred with the AI button, left of it.
    {
      const { context, page } = await open(browser, origin, { view: "phone", battery: true, settings: { statusIcons: ALL, bellNotes: NOTES } });
      const got = await page.evaluate(READ);
      if (!got || !got.inMhead) fail("phone: icons not in the header row " + JSON.stringify(got));
      if (got.kids.map((k) => k.st).join() !== "clock,battery,network,unread") fail("phone: wrong icons " + JSON.stringify(got.kids));
      for (const k of got.kids) if (Math.abs(k.cy - got.cy) > 1 || k.h > 22) fail("phone: icons not in one small row " + JSON.stringify(got.kids));
      if (!got.ai || Math.abs(got.cy - got.ai.cy) > 1) fail("phone: icons not centred with the AI button " + JSON.stringify(got));
      if (got.right > got.ai.left || got.ai.left - got.right > 12) fail("phone: spacing to the AI button is off " + JSON.stringify(got));
      if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + "/phone.png", clip: { x: 0, y: 0, width: 390, height: 160 } });
      await context.close();
    }
    // 3. No Battery API (iOS): no battery icon or switch.
    {
      const { context, page } = await open(browser, origin, { view: "phone", battery: false, settings: { statusIcons: ALL } });
      const got = await page.evaluate(READ);
      if (!got || got.kids.some((k) => k.st === "battery")) fail("battery shows without the Battery API " + JSON.stringify(got));
      if (got.kids.some((k) => k.st === "unread")) fail("unread shows with nothing unread");
      await page.goto(origin + "/#/settings/display");
      await page.waitForSelector('[data-act="status-icon"][data-key="clock"]', { timeout: 15000 });
      if (await page.$('[data-act="status-icon"][data-key="battery"]')) fail("battery switch offered without the Battery API");
      await context.setOffline(true);
      await page.goto(origin + "/#/").catch(() => {});
      await page.evaluate(() => { location.hash = "#/"; window.dispatchEvent(new Event("offline")); });
      await sleep(700);
      const off = await page.evaluate(READ);
      const net = off && off.kids.find((k) => k.st === "network");
      if (!net || !net.off) fail("offline is not shown " + JSON.stringify(off));
      await context.close();
    }
    // 4. Tablet: before the tab settings button, centred with it.
    {
      const { context, page } = await open(browser, origin, { view: "tablet", battery: true, settings: { statusIcons: ALL, bellNotes: NOTES } });
      const got = await page.evaluate(READ);
      if (!got || !got.inTabs || !got.nextIsManage) fail("tablet: icons not just before the tab settings button " + JSON.stringify(got));
      if (!got.manage || Math.abs(got.cy - got.manage.cy) > 1) fail("tablet: icons not centred with the tab settings button " + JSON.stringify(got));
      if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + "/tablet.png", clip: { x: 0, y: 0, width: 820, height: 200 } });
      await context.close();
    }
    // 5. Computer: never.
    {
      const { context, page } = await open(browser, origin, { view: "computer", battery: true, settings: { statusIcons: ALL, bellNotes: NOTES } });
      if (await page.evaluate(READ)) fail("status icons show on a computer");
      await context.close();
    }
    // 6. Owner switch off hides them all.
    {
      const { context, page } = await open(browser, origin, { view: "phone", battery: true, ownerOff: true, settings: { statusIcons: ALL, bellNotes: NOTES } });
      if (await page.evaluate(READ)) fail("status icons show with the owner switch off");
      await context.close();
    }
    console.log("status icons ok");
  } finally {
    await browser.close();
    if (server.close && !sharedStaticServer()) server.close();
  }
}

main().catch((err) => { if (!process.exitCode) process.exitCode = 1; console.error(err && err.message || err); });
