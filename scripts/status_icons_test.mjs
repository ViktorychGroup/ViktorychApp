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
  const size = opts.width ? { width: opts.width, height: opts.view === "tablet" ? 1180 : 844 } : opts.view === "phone" ? { width: 390, height: 844 } : opts.view === "tablet" ? { width: 820, height: 1180 } : { width: 1366, height: 900 };
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
  if (opts.route === "") {
    await page.waitForSelector('.mhead a.m-ai[href="#/ai"]', { state: "visible", timeout: 15000 });
    await page.waitForSelector('.mhead .sticons', { state: "visible", timeout: 15000 });
  }
  return { context, page };
}

const READ = `(() => {
  const box = [...document.querySelectorAll(".sticons")].find((el) => el.getBoundingClientRect().width > 0);
  if (!box) return null;
  const r = box.getBoundingClientRect();
  const kids = [...box.children].map((el) => {
    const k = el.getBoundingClientRect();
    const svg = el.querySelector("svg");
    const v = svg && svg.getBoundingClientRect();
    return { st: el.dataset.st, left: k.left, right: k.right, cy: k.top + k.height / 2, h: k.height,
      fontSize: parseFloat(getComputedStyle(el).fontSize), lineHeight: parseFloat(getComputedStyle(el).lineHeight),
      svg: v && { width: v.width, height: v.height, cy: v.top + v.height / 2, strokeWidth: parseFloat(getComputedStyle(svg).strokeWidth) },
      off: el.classList.contains("is-off") };
  });
  const ai = document.querySelector(".mhead .m-icon");
  const a = ai && ai.getBoundingClientRect();
  const manage = document.querySelector(".tabs-bar .tab-manage");
  const m = manage && manage.getBoundingClientRect();
  const glyphBox = (el) => {
    const svg = el && el.querySelector("svg");
    if (!svg) return null;
    const v = svg.getBoundingClientRect();
    const drawn = svg.querySelector("g") || svg;
    return { width: v.width, height: v.height, cy: v.top + v.height / 2, strokeWidth: getComputedStyle(drawn).stroke === "none" ? null : parseFloat(getComputedStyle(drawn).strokeWidth) || null };
  };
  const logo = box.closest(".mhead") && box.closest(".mhead").querySelector(".m-logo");
  const l = logo && logo.getBoundingClientRect();
  return { inMhead: !!box.closest(".mhead"), inTabs: !!box.closest(".tabs-bar"), cy: r.top + r.height / 2, left: r.left, right: r.right, gap: parseFloat(getComputedStyle(box).columnGap), kids,
    logo: l && l.width ? { left: l.left, right: l.right } : null,
    compact: !!box.closest(".compact-head"), statusBar: document.documentElement.hasAttribute("data-status-bar"),
    ai: a && a.width ? { left: a.left, cy: a.top + a.height / 2, glyph: glyphBox(ai) } : null,
    manage: m && m.width ? { left: m.left, cy: m.top + m.height / 2, glyph: glyphBox(manage) } : null,
    nextIsManage: !!(box.nextElementSibling && box.nextElementSibling.classList.contains("tab-manage")) };
})()`;

function checkVisualGroup(got, label) {
  const ref = got.inMhead ? got.ai : got.manage;
  if (!ref || !ref.glyph) fail(label + ": comparison control is missing " + JSON.stringify(got));
  if (Math.abs(got.cy - ref.cy) > 0.5) fail(label + ": row and control centers differ " + JSON.stringify(got));
  for (const [i, k] of got.kids.entries()) {
    if (Math.abs(k.cy - got.cy) > 0.5) fail(label + ": row is not on one centerline " + JSON.stringify(k));
    if (k.h > 22) fail(label + ": status item is oversized " + JSON.stringify(k));
    if (k.svg) {
      if (Math.abs(k.svg.cy - ref.glyph.cy) > 0.5) fail(label + ": glyph centerlines differ " + JSON.stringify(k));
      if (k.svg.width > 22 || k.svg.height > 22) fail(label + ": status symbol is oversized " + JSON.stringify(k));
      if (Math.abs(k.svg.width - ref.glyph.width) > 0.5 || Math.abs(k.svg.height - ref.glyph.height) > 0.5) fail(label + ": symbol size does not match the control " + JSON.stringify({ icon: k, control: ref }));
      if (k.svg.strokeWidth && ref.glyph.strokeWidth && Math.abs(k.svg.strokeWidth - ref.glyph.strokeWidth) > 0.1) fail(label + ": stroke weights do not match " + JSON.stringify({ icon: k, control: ref }));
    }
    if (k.st === "clock" && (k.fontSize !== 15 || k.lineHeight !== 20)) fail(label + ": clock typography does not fit the row " + JSON.stringify(k));
    if (i && Math.abs(k.left - got.kids[i - 1].right - 8) > 0.5) fail(label + ": inconsistent 8px item spacing " + JSON.stringify(got.kids));
  }
  const gap = ref.left - got.right;
  if (gap < 7.5 || gap > 8.5) fail(label + ": control spacing is not 8px: " + gap);
  if (got.logo && got.inMhead && got.logo.right > got.left) fail(label + ": classic app name overlaps status icons " + JSON.stringify(got));
}

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
      checkVisualGroup(got, "phone");
      if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + "/phone.png", clip: { x: 0, y: 0, width: 390, height: 160 } });
      await context.close();
    }
    // 3. Press and hold opens the existing controls; tap, movement and cancel do not.
    {
      const { context, page } = await open(browser, origin, { view: "phone", battery: true, settings: { statusIcons: ALL } });
      const selector = '.mhead a.m-ai[href="#/ai"]';
      if (await page.getAttribute(selector, "aria-keyshortcuts") !== "Shift+F10") fail("AI long-press keyboard shortcut is not exposed");
      await page.click(selector);
      await page.waitForURL(/#\/ai$/, { timeout: 10000 });
      await page.goto(origin + "/#/");
      const cdp = await context.newCDPSession(page);
      const aim = async () => {
        await page.waitForSelector(selector, { state: "visible" });
        await page.waitForSelector('.mhead .sticons', { state: "visible", timeout: 15000 });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        return page.$eval(selector, (el) => {
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
      };
      let point = await aim();
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
      await sleep(200);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      await sleep(500);
      if (await page.locator(selector).count() !== 1) fail("cancelled AI hold opened another page");
      await page.tap(selector);
      await page.waitForURL(/#\/ai$/, { timeout: 10000 });
      await page.goto(origin + "/#/");
      point = await aim();

      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
      await sleep(150);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y + 30, id: 1 }] });
      await sleep(500);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(150);
      if (await page.locator(selector).count() !== 1) fail("moved AI hold opened another page");
      await page.waitForSelector('.mhead .sticons', { state: "visible", timeout: 15000 });

      await page.evaluate(() => { window.dispatchEvent(new Event("resize")); });
      await sleep(300);
      point = await aim();
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
      await page.waitForURL(/#\/settings\/display$/, { timeout: 10000 });
      await page.waitForSelector('[data-act="status-icon"][data-key="clock"]', { state: "visible", timeout: 15000 });
      await page.waitForFunction(() => document.activeElement?.dataset.key === "clock" && document.getElementById("status-icons-settings"));
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }).catch(() => {});
      await sleep(200);
      if (!/#\/settings\/display$/.test(page.url())) fail("AI hold release activated another control");
      await context.close();
    }
    // 4. Keyboard and the equivalent computer hold reach the same controls.
    {
      const { context, page } = await open(browser, origin, { view: "computer", battery: true, settings: { statusIcons: ALL } });
      const selector = '.mhead a.m-ai[href="#/ai"]';
      await page.locator(selector).evaluate((el) => { el.style.display = "block"; el.closest(".mhead").style.display = "flex"; });
      await page.focus(selector);
      await page.keyboard.press("Shift+F10");
      await page.waitForURL(/#\/settings\/display$/, { timeout: 10000 });
      await page.waitForSelector('[data-act="status-icon"][data-key="clock"]', { state: "visible", timeout: 15000 });
      await page.goto(origin + "/#/");
      await page.waitForSelector(selector, { state: "attached" });
      await page.locator(selector).evaluate((el) => { el.style.display = "block"; el.closest(".mhead").style.display = "flex"; });
      await sleep(1600);
      const box = await page.locator(selector).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await sleep(700);
      await page.mouse.up();
      await page.waitForURL(/#\/settings\/display$/, { timeout: 10000 });
      await page.waitForSelector('[data-act="status-icon"][data-key="clock"]', { state: "visible", timeout: 15000 });
      await sleep(150);
      if (!/#\/settings\/display$/.test(page.url())) fail("computer AI hold's click opened Local AI");
      await context.close();
    }
    // 5. No Battery API (iOS): no battery icon or switch.
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
    // 6. Tablet: before the tab settings button, centred with it.
    {
      const { context, page } = await open(browser, origin, { view: "tablet", battery: true, settings: { statusIcons: ALL, bellNotes: NOTES } });
      const got = await page.evaluate(READ);
      if (!got || !got.inTabs || !got.nextIsManage) fail("tablet: icons not just before the tab settings button " + JSON.stringify(got));
      checkVisualGroup(got, "tablet");
      if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + "/tablet.png", clip: { x: 0, y: 0, width: 820, height: 200 } });
      await context.close();
    }
    // 7. Computer: never.
    {
      const { context, page } = await open(browser, origin, { view: "computer", battery: true, settings: { statusIcons: ALL, bellNotes: NOTES } });
      if (await page.evaluate(READ)) fail("status icons show on a computer");
      await context.close();
    }
    // 8. Owner switch off hides them all.
    {
      const { context, page } = await open(browser, origin, { view: "phone", battery: true, ownerOff: true, settings: { statusIcons: ALL, bellNotes: NOTES } });
      if (await page.evaluate(READ)) fail("status icons show with the owner switch off");
      await context.close();
    }
    // 7. The same visual rhythm at narrow/wide phone widths, in the classic
    // header, and with the optional phone status bar. The reference control is
    // Viktrych in compact mode and Settings in classic mode.
    for (const item of [
      { name: "phone-320-classic", width: 320, settings: { classicHeader: true, statusIcons: ALL, bellNotes: NOTES } },
      { name: "phone-430-status-bar", width: 430, settings: { statusBar: true, statusIcons: ALL, bellNotes: NOTES } },
      { name: "tablet-600-compact", width: 600, view: "tablet", settings: { statusIcons: ALL, bellNotes: NOTES } }
    ]) {
      const view = item.view || "phone";
      const { context, page } = await open(browser, origin, { view, width: item.width, battery: true, settings: item.settings });
      const got = await page.evaluate(READ);
      if (!got) fail(item.name + ": no visible status group");
      if (got.compact !== !item.settings.classicHeader) fail(item.name + ": wrong compact/classic mode " + JSON.stringify(got));
      if (got.statusBar !== !!item.settings.statusBar) fail(item.name + ": wrong status-bar mode " + JSON.stringify(got));
      checkVisualGroup(got, item.name);
      if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + "/" + item.name + ".png", clip: { x: 0, y: 0, width: item.width, height: view === "tablet" ? 160 : 150 } });
      await context.close();
    }
    console.log("status icons ok");
  } finally {
    await browser.close();
    if (server.close && !sharedStaticServer()) server.close();
  }
}

main().catch((err) => { if (!process.exitCode) process.exitCode = 1; console.error(err && err.stack || err); });
