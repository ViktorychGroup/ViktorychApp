/* Installed desktop app: Window Controls Overlay title bar, hidden page
   scrollbar, Close button and opt-in full screen. Emulates display-mode with
   CDP and fakes navigator.windowControlsOverlay. Placeholders only.
   SHOTS=/some/dir saves screenshots. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.env.SHOTS || "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error("desktop app: " + message);
  process.exitCode = 1;
  throw new Error(message);
}
function mime(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}
function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
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
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

const W = 1280;
const H = 800;
const CAPTION = 138; // Windows/Linux caption buttons on the right
const TRAFFIC = 78; // macOS traffic lights on the left

/* mode: "tab" | "standalone" | "wco" ; os: "win" | "mac" */
async function open(browser, origin, mode, os) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: os === "win" ? 2 : 1 });
  const page = await context.newPage();
  await page.addInitScript((cfg) => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    window.__fsCalls = [];
    const real = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function (opts) {
      window.__fsCalls.push({ root: this === document.documentElement, navigationUI: opts && opts.navigationUI, at: performance.now() });
      return real.call(this, opts);
    };
    window.__closed = 0;
    window.close = function () { window.__closed += 1; };
    // Headless Chrome ignores CDP display-mode emulation, so answer the
    // display-mode queries the way an installed window would.
    if (cfg.mode !== "tab") {
      const real = window.matchMedia.bind(window);
      const want = cfg.mode === "wco" ? "window-controls-overlay" : "standalone";
      window.matchMedia = (query) => {
        const text = String(query);
        if (text.indexOf("display-mode") < 0) return real(query);
        const hit = text.indexOf("display-mode: " + want) >= 0 && !document.fullscreenElement;
        return { matches: hit, media: text, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } };
      };
    }
    if (cfg.mode === "wco") {
      const target = new EventTarget();
      let rect = cfg.rect;
      target.visible = true;
      target.getTitlebarAreaRect = () => new DOMRect(rect.x, rect.y, rect.width, rect.height);
      target.__set = (next) => {
        rect = next;
        const event = new Event("geometrychange");
        event.titlebarAreaRect = new DOMRect(next.x, next.y, next.width, next.height);
        event.visible = true;
        target.dispatchEvent(event);
      };
      Object.defineProperty(Navigator.prototype, "windowControlsOverlay", { configurable: true, get: () => target });
    }
  }, { mode, rect: os === "mac" ? { x: TRAFFIC, y: 0, width: W - TRAFFIC, height: 28 } : { x: 0, y: 0, width: W - CAPTION, height: 33 } });
  const client = await context.newCDPSession(page);
  const features = mode === "tab" ? [] : [{ name: "display-mode", value: mode === "wco" ? "window-controls-overlay" : "standalone" }];
  await client.send("Emulation.setEmulatedMedia", { features }).catch(() => {});
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith(origin)) route.continue();
    else route.abort();
  });
  await page.goto(origin + "/index.html#/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.ViktorychDesktop && document.querySelector(".account-pill, .m-ava"), null, { timeout: 25000 });
  await sleep(400);
  return { context, page };
}

async function scrollbarState(page) {
  return page.evaluate(() => {
    const html = document.documentElement;
    const cs = getComputedStyle(html);
    return {
      width: cs.scrollbarWidth,
      gutter: window.innerWidth - html.clientWidth,
      wcoShown: getComputedStyle(document.querySelector(".wco")).display !== "none"
    };
  });
}

async function popupRows(page) {
  await page.click(".account-pill");
  await page.waitForSelector(".acct-menu", { timeout: 8000 });
  const rows = await page.evaluate(() => [...document.querySelectorAll(".acct-menu [data-act]")].map((el) => ({ act: el.dataset.act, text: el.textContent.trim() })));
  return rows;
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--no-sandbox", "--disable-gpu"] });
  try {
    // 1. A normal browser tab hides the scrollbar, and has no title bar or Close.
    {
      const { context, page } = await open(browser, origin, "tab");
      // Make the page scroll so a classic scrollbar would otherwise show.
      await page.evaluate(() => { document.body.style.minHeight = "3000px"; });
      await sleep(100);
      const bar = await scrollbarState(page);
      if (bar.width !== "none") fail("normal tab showed the scrollbar");
      if (bar.wcoShown) fail("normal tab shows the custom title bar");
      if (await page.evaluate(() => window.ViktorychDesktop.closeSupported())) fail("Close offered in a normal tab");
      await sleep(1200);
      const auto = await page.evaluate(() => ({ calls: window.__fsCalls.length, fs: !!document.fullscreenElement }));
      if (auto.calls || auto.fs) fail("full screen started on load");
      await shot(page, "normal-tab-unchanged");
      const rows = await popupRows(page);
      if (rows.some((row) => row.act === "desk-close")) fail("menu offers Close app in a normal tab");
      const fsRow = rows.find((row) => row.act === "desk-fullscreen");
      if (!fsRow || fsRow.text !== "Full screen") fail("menu has no Full screen item: " + JSON.stringify(rows));
      await shot(page, "menu-full-screen-item");
      await page.click(".acct-menu [data-act='desk-fullscreen']");
      await page.waitForFunction(() => window.__fsCalls.length === 1, null, { timeout: 5000 });
      const call = await page.evaluate(() => window.__fsCalls[0]);
      if (!call.root || call.navigationUI !== "hide") fail("menu did not call documentElement.requestFullscreen({navigationUI:'hide'})");
      await page.waitForFunction(() => document.fullscreenElement === document.documentElement, null, { timeout: 5000 });
      await page.waitForFunction(() => document.documentElement.classList.contains("vk-fs"));
      await page.mouse.move(640, 300);
      await page.mouse.move(640, 10);
      await page.waitForSelector(".vk-fs-exit.on", { timeout: 3000 });
      await shot(page, "full-screen-view");
      const fsBar = await scrollbarState(page);
      if (fsBar.width !== "none") fail("scrollbar shows in full screen");
      const again = await popupRows(page);
      const exitRow = again.find((row) => row.act === "desk-fullscreen");
      if (!exitRow || exitRow.text !== "Exit full screen") fail("menu label did not switch to Exit full screen");
      await page.click(".acct-menu [data-act='desk-fullscreen']");
      await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 });
      if (await page.evaluate(() => document.documentElement.classList.contains("vk-fs"))) fail("full screen state stuck after exit");
      // Shortcut: Ctrl+Shift+F in, again out.
      await page.keyboard.press("Control+Shift+KeyF");
      await page.waitForFunction(() => document.fullscreenElement === document.documentElement, null, { timeout: 5000 });
      await page.keyboard.press("Control+Shift+KeyF");
      await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 });
      await context.close();
    }
    // 2. Installed without the overlay: scrollbar hidden, Close in the menu, scrolling works.
    {
      const { context, page } = await open(browser, origin, "standalone");
      await page.evaluate(() => { document.body.style.minHeight = "3000px"; });
      const bar = await scrollbarState(page);
      if (bar.width !== "none") fail("installed app still shows the scrollbar " + JSON.stringify(bar));
      if (bar.wcoShown) fail("title bar drawn without the overlay");
      await page.mouse.move(640, 400);
      await page.mouse.wheel(0, 600);
      await page.waitForFunction(() => window.scrollY > 100, null, { timeout: 3000 }).catch(() => fail("wheel did not scroll with the scrollbar hidden"));
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
      await page.keyboard.press("End");
      await page.waitForFunction(() => window.scrollY > 100, null, { timeout: 3000 }).catch(() => fail("keyboard did not scroll with the scrollbar hidden"));
      await page.evaluate(() => window.scrollTo(0, 0));
      const rows = await popupRows(page);
      if (!rows.some((row) => row.act === "desk-close")) fail("installed menu has no Close app");
      await page.keyboard.press("Escape");
      await page.evaluate(() => { const back = document.querySelector(".acct-menu-back"); if (back) back.click(); });
      await context.close();
    }
    // 3. Window Controls Overlay on Windows/Linux (caption buttons right) and macOS (traffic lights left).
    for (const os of ["win", "mac"]) {
      const { context, page } = await open(browser, origin, "wco", os);
      await page.waitForSelector(".wco .wco-close", { timeout: 8000 });
      const box = await page.evaluate(() => {
        const bar = document.querySelector(".wco").getBoundingClientRect();
        const close = document.querySelector(".wco .wco-close").getBoundingClientRect();
        const fsBtn = document.querySelector(".wco [data-desk='fullscreen']");
        const nav = document.querySelector(".nav");
        const drag = getComputedStyle(document.querySelector(".wco"));
        const tools = getComputedStyle(document.querySelector(".wco-tools"));
        const closeSvg = document.querySelector(".wco .wco-close svg");
        return {
          bar: { x: bar.x, y: bar.y, w: bar.width, h: bar.height },
          close: { x: close.x, r: close.right, w: close.width },
          fs: !!fsBtn,
          navTop: nav ? nav.getBoundingClientRect().top : 0,
          drag: drag.webkitAppRegion || drag.getPropertyValue("app-region") || drag.getPropertyValue("-webkit-app-region"),
          noDrag: tools.webkitAppRegion || tools.getPropertyValue("app-region") || tools.getPropertyValue("-webkit-app-region"),
          svgFill: closeSvg ? getComputedStyle(closeSvg.querySelector("path")).fill : "",
          color: getComputedStyle(document.querySelector(".wco .wco-close")).color,
          scrollbar: getComputedStyle(document.documentElement).scrollbarWidth
        };
      });
      if (os === "win") {
        if (box.bar.x !== 0 || box.bar.x + box.bar.w > W - 138 + 0.5) fail("title bar overlaps the caption buttons " + JSON.stringify(box.bar));
      } else if (box.bar.x < 78) fail("title bar overlaps the traffic lights " + JSON.stringify(box.bar));
      if (box.close.r > box.bar.x + box.bar.w + 0.5) fail("Close button outside the title bar area");
      if (!box.fs) fail("title bar has no full screen button");
      if (box.navTop < box.bar.h - 1) fail("app header sits under the title bar");
      if (box.drag && box.drag !== "drag") fail("title bar is not draggable: " + box.drag);
      if (box.noDrag && box.noDrag !== "no-drag") fail("title bar buttons are draggable: " + box.noDrag);
      if (box.svgFill !== box.color) fail("Close icon is not currentColor");
      if (box.scrollbar !== "none") fail("scrollbar shows in the overlay window");
      await shot(page, "installed-wco-" + os);
      if (os === "win") {
        await page.hover(".wco .wco-close");
        await sleep(150);
        await page.screenshot({ path: SHOTS ? path.join(SHOTS, "close-button.png") : path.join("/tmp", "close-button.png"), clip: { x: Math.max(0, box.close.x - 260), y: 0, width: 300 + CAPTION, height: 48 } }).catch(() => {});
        // geometrychange: the bar follows a narrower area.
        await page.evaluate(() => navigator.windowControlsOverlay.__set({ x: 0, y: 0, width: 900, height: 33 }));
        await sleep(100);
        const width = await page.evaluate(() => document.querySelector(".wco").getBoundingClientRect().width);
        if (Math.round(width) !== 900) fail("title bar did not follow geometrychange: " + width);
        // Close: saves text drafts and closes.
        await page.click(".wco .wco-close");
        if (await page.evaluate(() => window.__closed) !== 1) fail("Close did not call window.close()");
        // Something unsaveable: ask first; cancel keeps the window.
        // A reply-parent redraw calls commitApp and replaces #app. Waiting
        // for the Close button to sit still lets that redraw drop the field,
        // and Close then sees nothing to ask about. Plant the field and
        // press the button that is on screen in the same turn.
        const after = await page.evaluate(() => {
          const app = document.getElementById("app");
          const area = document.createElement("textarea");
          area.value = "unsent reply";
          app.appendChild(area);
          window.__asked = 0;
          window.confirm = () => { window.__asked += 1; return false; };
          const btn = document.querySelector(".wco .wco-close");
          if (!btn || !area.isConnected) return { closed: window.__closed, asked: 0 };
          btn.click();
          return { closed: window.__closed, asked: window.__asked };
        });
        if (after.asked !== 1 || after.closed !== 1) fail("unsaved text did not ask before closing " + JSON.stringify(after));
        await page.evaluate(() => { const area = document.querySelector("#app > textarea"); if (area) area.remove(); const t = document.getElementById("toast"); if (t) t.hidden = true; });
        await page.mouse.move(400, 400);
        // Full screen hides the title bar.
        await page.click(".wco [data-desk='fullscreen']");
        await page.waitForFunction(() => document.fullscreenElement === document.documentElement, null, { timeout: 5000 });
        await page.waitForFunction(() => document.documentElement.classList.contains("vk-fs"), null, { timeout: 5000 });
        const hidden = await page.evaluate(() => getComputedStyle(document.querySelector(".wco")).display === "none" || !document.querySelector(".wco").innerHTML);
        if (!hidden) fail("title bar still shows in full screen");
        await page.evaluate(() => document.exitFullscreen());
        await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 });
        // Settings: Show scrollbar toggle brings it back.
        await page.evaluate(() => { location.hash = "#/settings/display"; });
        await page.waitForSelector("[data-act='desk-pref'][data-key='showScrollbar']", { timeout: 8000 });
        await sleep(600);
        await page.evaluate(() => {
          const el = document.querySelector("[data-desk-settings]");
          window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 260);
        });
        await sleep(400);
        await shot(page, "settings-toggles");
        await page.click("[data-act='desk-pref'][data-key='showScrollbar']");
        await sleep(150);
        const shown = await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarWidth);
        if (shown === "none") fail("Show scrollbar toggle did not bring it back");
        await page.waitForSelector("[data-act='desk-pref'][data-key='showScrollbar'][aria-checked='true']", { timeout: 3000 });
      }
      await context.close();
    }
    // 4. iPhone: no full screen item (Safari only allows video full screen there).
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
      const page = await context.newPage();
      await page.route("**/*", (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
      await page.goto(origin + "/index.html#/", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.ViktorychDesktop, null, { timeout: 25000 });
      const info = await page.evaluate(() => ({ fs: window.ViktorychDesktop.fsSupported(), rows: window.ViktorychDesktop.menuRowsHtml("drawer") }));
      if (info.fs || info.rows.indexOf("desk-fullscreen") >= 0) fail("iPhone offers full screen");
      await context.close();
    }
    console.log("desktop app ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
