import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
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
const PROBE = `(() => {
  const bar = document.querySelector("#app .topbar.tall");
  if (!bar) return null;
  const r = bar.getBoundingClientRect();
  const head = bar.querySelector(".mhead");
  const tabs = bar.querySelector(".tabs-bar");
  const hr = head.getBoundingClientRect();
  const tr = tabs.getBoundingClientRect();
  const hs = getComputedStyle(head);
  const top = document.elementFromPoint(Math.round(innerWidth / 2), 2);
  const meta = document.querySelector('meta[name="theme-color"]');
  return {
    barTop: r.top, barBottom: r.bottom, barH: r.height, pad: parseFloat(getComputedStyle(bar).paddingTop) || 0,
    headTop: hr.top, headH: hr.height, tabsTop: tr.top, rows: r.bottom - tr.top,
    headShown: hs.visibility !== "hidden" && hs.opacity !== "0",
    hidden: bar.classList.contains("is-hidden"),
    topIsBar: !!(top && bar.contains(top)),
    color: meta ? meta.getAttribute("content") : ""
  };
})()`;

const near = (a, b) => Math.abs(a - b) <= 1;

async function open(browser, origin, opts) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, serviceWorkers: "block" });
  await context.addInitScript((o) => {
    try {
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      const settings = {};
      if (o.appearance) settings.appearance = o.appearance;
      if (o.statusIcons) {
        settings.appearance = settings.appearance || "lightsout";
        settings.statusIcons = o.statusIcons;
      }
      if (settings.appearance || settings.statusIcons) localStorage.setItem("viktorychapp-settings-v1", JSON.stringify(settings));
    } catch (err) {}
    if (o.displayMode || o.standalone) {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => {
        if (new RegExp("display-mode:\\s*" + (o.displayMode || "standalone")).test(String(q))) return { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent() { return false; } };
        return real(q);
      };
    }
    if (o.statusIcons) Object.defineProperty(Navigator.prototype, "connection", { configurable: true, get: () => ({ type: "wifi", effectiveType: "4g", addEventListener() {} }) });
    if (o.screen) {
      window.__scr = o.screen;
      Object.defineProperty(Screen.prototype, "height", { configurable: true, get() { return window.__scr.height; } });
      Object.defineProperty(Screen.prototype, "availHeight", { configurable: true, get() { return window.__scr.avail; } });
    }
  }, opts);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const slow = Number(process.env.CPU || 0);
  if (slow > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: slow });
  const inset = async (top) => { await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top, topMax: top } }); await sleep(250); };
  await inset(opts.inset == null ? 24 : opts.inset);
  const errors = [];
  page.on("pageerror", (err) => {
    const message = String(err && err.message || err);
    // YouTube's embed player throws this inside its own script. It is not the header.
    if (/isExternalMethodAvailable/.test(message)) return;
    // Chrome's extension activity logger throws this into the page. It is not the header.
    if (message === "this.api.logApiCall is not a function") return;
    if (/127\.0\.0\.1/.test(String(err && err.stack || ""))) errors.push(message.slice(0, 200));
  });
  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .topbar.tall.compact-head .mhead .m-ava", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll("#app article").length > 2, null, { timeout: 20000 });
  await sleep(400);
  if (process.env.SHOT && opts.capture) await page.screenshot({ path: process.env.SHOT, clip: { x: 0, y: 0, width: 390, height: 190 } });
  return { context, page, errors, inset };
}

async function settle(page) { await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); await sleep(450); }

async function sampleHeader(page) {
  return page.evaluate(`(() => {
    const h = ${PROBE};
    const bar = document.querySelector("#app .topbar.tall");
    let busy = false;
    if (bar && bar.getAnimations) busy = bar.getAnimations({ subtree: true }).some((a) => a.playState === "running");
    return { h: h, busy: busy };
  })()`);
}

/* Two matching samples with no running header animation. A single read can
   land in the 0.2s tuck, while the hide class is already on. */
async function waitHeader(page, match, timeout) {
  const deadline = Date.now() + timeout;
  let last = null;
  let hits = 0;
  while (Date.now() < deadline) {
    const sample = await sampleHeader(page);
    last = sample && sample.h;
    if (sample && !sample.busy && match(sample.h)) {
      hits += 1;
      if (hits >= 2) return sample.h;
    } else hits = 0;
    await sleep(40);
  }
  return last;
}

async function scrollDown(page, rows, sat) {
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 300); await sleep(110); }
  const full = typeof rows === "number" && typeof sat === "number";
  return waitHeader(page, (h) => {
    if (!h || !h.hidden || h.headShown || !h.topIsBar) return false;
    if (!full) return true;
    return near(h.tabsTop, sat) && near(h.barBottom, sat + rows);
  }, 4000);
}

async function scrollUp(page, ref, sat) {
  await page.mouse.wheel(0, -300);
  await page.evaluate(() => window.scrollTo(0, 0));
  const full = typeof ref === "number" && typeof sat === "number";
  return waitHeader(page, (h) => {
    if (!h || h.hidden || !h.headShown || !h.topIsBar || !near(h.barTop, 0)) return false;
    if (!full) return true;
    return near(h.pad, sat) && near(h.headTop, sat) && near(h.barH, ref + sat);
  }, 4000);
}

// At rest: one inset of padding, the avatar row right under it, nothing else
// painting over the status bar area.
function atRest(h, ref, sat, label) {
  if (!h) fail(label + ": no header");
  if (h.hidden) fail(label + ": header is hidden at rest");
  if (!near(h.barTop, 0)) fail(label + ": header does not start at the top " + JSON.stringify(h));
  if (!near(h.pad, sat)) fail(label + ": header padding is not one safe-area inset (" + sat + ") " + JSON.stringify(h));
  if (!near(h.headTop, sat)) fail(label + ": avatar row is not right under the status bar " + JSON.stringify(h));
  if (!near(h.barH, ref + sat)) fail(label + ": header height " + h.barH + " is not the reference " + (ref + sat));
  if (!h.headShown) fail(label + ": avatar row is not shown at rest");
  if (!h.topIsBar) fail(label + ": something other than the header paints behind the status bar");
}

function scrolled(h, rows, sat, label) {
  if (!h.hidden) fail(label + ": header did not hide on scroll");
  if (!near(h.tabsTop, sat)) fail(label + ": tab row is not pinned under the status bar " + JSON.stringify(h));
  if (!near(h.barBottom, sat + rows)) fail(label + ": scrolled header is not tabs-only " + JSON.stringify({ bottom: h.barBottom, want: sat + rows }));
  if (h.headShown) fail(label + ": avatar row still shows behind the status bar");
  if (!h.topIsBar) fail(label + ": scrolled header leaves a band behind the status bar");
}

async function cycle(run, ref, rows, sat, label) {
  atRest(await run.page.evaluate(PROBE), ref, sat, label + " rest");
  scrolled(await scrollDown(run.page, rows, sat), rows, sat, label + " scrolled");
  atRest(await scrollUp(run.page, ref, sat), ref, sat, label + " back");
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    // Browser tab with a 24px status-bar inset.
    let run = await open(browser, origin, {});
    let h = await run.page.evaluate(PROBE);
    const ref = h.barH - h.pad;
    const rows = h.barBottom - h.tabsTop;
    if (!near(h.pad, 24) || ref < 90 || rows < 40) fail("unexpected reference header " + JSON.stringify(h));
    await cycle(run, ref, rows, 24, "tab");
    // Resize: short (keyboard), landscape, and back; the header returns to the same size.
    for (const [w, ht] of [[390, 420], [844, 390], [390, 844]]) {
      await run.page.setViewportSize({ width: w, height: ht });
      await settle(run.page);
    }
    await cycle(run, ref, rows, 24, "after resize");
    // The inset changes mid-session (status bar shown or hidden): still one inset.
    await run.inset(0); await settle(run.page);
    atRest(await run.page.evaluate(PROBE), ref, 0, "no inset");
    await run.inset(40); await settle(run.page);
    await cycle(run, ref, rows, 40, "inset 40");
    await run.inset(24); await settle(run.page);
    atRest(await run.page.evaluate(PROBE), ref, 24, "inset back");
    if (run.errors.length) fail("page errors: " + run.errors.join(" | "));
    await run.context.close();

    // Installed app drawn under the status bar: the page is taller than the
    // free screen area, so the inset stays. The native colour is opaque black;
    // transparent falls back to Android's grey default rather than drawing
    // through to the page.
    run = await open(browser, origin, { standalone: true, screen: { height: 844, avail: 772 } });
    h = await run.page.evaluate(PROBE);
    if (String(h.color).toUpperCase() !== "#010101") fail("installed app under the status bar would show Android's grey fallback " + JSON.stringify(h));
    await cycle(run, ref, rows, 24, "installed under bar");
    await run.context.close();

    // Installed app that Chrome placed below the status bar while env() still
    // reports it: no second gap, and the status bar takes the header colour
    // instead of a grey band.
    run = await open(browser, origin, { standalone: true, screen: { height: 844 + 24 + 48, avail: 844 } });
    h = await run.page.evaluate(PROBE);
    if (!h.color || h.color === "transparent") fail("status bar is left transparent while the page sits below it " + JSON.stringify(h));
    await cycle(run, ref, rows, 0, "installed below bar");
    // Display mode / full screen change: the page now covers the screen.
    await run.page.evaluate(() => { window.__scr.height = 844; window.__scr.avail = 772; window.dispatchEvent(new Event("resize")); });
    await settle(run.page);
    h = await run.page.evaluate(PROBE);
    if (String(h.color).toUpperCase() !== "#010101") fail("bar regained Android's grey fallback after the page moved under it " + JSON.stringify(h));
    await cycle(run, ref, rows, 24, "installed after mode change");
    await run.context.close();

    // Fullscreen install whose transient Android system bar is visible. The
    // page starts below it, so --sat is zero and there is no extra band. The
    // native theme is opaque black even with the optional in-app status icons.
    run = await open(browser, origin, { displayMode: "fullscreen", capture: true, inset: 44, statusIcons: { clock: true, network: true }, screen: { height: 844 + 44 + 28, avail: 844 } });
    h = await run.page.evaluate(PROBE);
    if (String(h.color).toUpperCase() !== "#010101") fail("fullscreen install with its system bar visible would show the grey fallback " + JSON.stringify(h));
    if (!await run.page.$(".mhead .sticons .st-clock")) fail("the in-app status icons were not included in the visual regression");
    await cycle(run, ref, rows, 0, "fullscreen below bar with status icons");
    await run.context.close();

    // Fullscreen install with the OS status bar hidden, but env() still reports
    // the Pixel 6a 50px bar. The page fills the screen (avail == height), so
    // --sat must be zero: no empty dead band above the avatar / in-app icons.
    run = await open(browser, origin, {
      displayMode: "fullscreen",
      inset: 50,
      statusIcons: { clock: true, network: true },
      screen: { height: 915, avail: 915 },
      appearance: "lightsout"
    });
    await run.page.setViewportSize({ width: 412, height: 915 });
    await run.inset(50);
    await settle(run.page);
    h = await run.page.evaluate(PROBE);
    if (!near(h.pad, 0) || !near(h.headTop, 0)) fail("hidden OS status bar still reserved a dead band " + JSON.stringify(h));
    if (String(h.color).toUpperCase() !== "#010101") fail("immersive fullscreen lost the near-black native bar colour " + JSON.stringify(h));
    if (!await run.page.$(".mhead .sticons .st-clock")) fail("in-app status icons missing when the OS bar is hidden");
    const immersiveHit = await run.page.evaluate(() => {
      const head = document.querySelector("#app .mhead");
      const ava = document.querySelector("#app .mhead .m-ava");
      const clock = document.querySelector("#app .mhead .st-clock");
      if (!head || !ava || !clock) return { ava: false, clock: false };
      const hr = head.getBoundingClientRect();
      const ar = ava.getBoundingClientRect();
      const cr = clock.getBoundingClientRect();
      // Status icons are pointer-events: none, so hit-test the avatar only and
      // require the clock to sit in the same header row (not under a dead band).
      const hitA = document.elementFromPoint(Math.round(ar.left + 8), Math.round(ar.top + ar.height / 2));
      return {
        ava: !!(hitA && hitA.closest(".m-ava")),
        clock: cr.width > 8 && cr.height > 8 && cr.top >= hr.top - 1 && cr.bottom <= hr.bottom + 1,
        immersive: document.documentElement.hasAttribute("data-sat-immersive"),
        headTop: Math.round(hr.top),
        clockTop: Math.round(cr.top),
        sat: getComputedStyle(document.documentElement).getPropertyValue("--sat").trim()
      };
    });
    if (!immersiveHit.ava || !immersiveHit.clock || immersiveHit.headTop > 1) fail("avatar or in-app status icons are covered after dropping the dead band " + JSON.stringify(immersiveHit));
    if (!immersiveHit.immersive || immersiveHit.sat !== "0px") fail("immersive hidden-bar did not zero --sat " + JSON.stringify(immersiveHit));
    if (process.env.SHOT_DIR) {
      fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
      await run.page.screenshot({ path: path.join(process.env.SHOT_DIR, "pixel-immersive-hidden-bar-rest.png"), clip: { x: 0, y: 0, width: 412, height: 160 } });
    }
    await cycle(run, ref, rows, 0, "fullscreen hidden bar with status icons");
    if (process.env.SHOT_DIR) {
      await scrollDown(run.page);
      await run.page.screenshot({ path: path.join(process.env.SHOT_DIR, "pixel-immersive-hidden-bar-scrolled.png"), clip: { x: 0, y: 0, width: 412, height: 120 } });
      await scrollUp(run.page);
      await run.page.evaluate(() => window.scrollTo(0, 0));
      await settle(run.page);
    }
    await run.context.close();

    // Same 50px env() with the OS status bar still present (page drawn under
    // it): keep the real safe area so content does not sit under system icons.
    run = await open(browser, origin, {
      displayMode: "fullscreen",
      inset: 50,
      statusIcons: { clock: true, network: true },
      screen: { height: 915, avail: 800 }
    });
    await run.page.setViewportSize({ width: 412, height: 915 });
    await run.inset(50);
    await settle(run.page);
    h = await run.page.evaluate(PROBE);
    if (!near(h.pad, 50) || !near(h.headTop, 50)) fail("visible OS status bar lost its safe-area inset " + JSON.stringify(h));
    await cycle(run, ref, rows, 50, "fullscreen under visible bar");
    await run.context.close();

    // A reported inset taller than every system bar together is capped (fat header).
    run = await open(browser, origin, { standalone: true, inset: 60, screen: { height: 844, avail: 820 } });
    await cycle(run, ref, rows, 24, "installed oversized inset");
    await run.context.close();

    // Pixel 6a: the status bar is 50px (132 device px). That strip is the theme
    // background, at rest and scrolled, in dark and light. The avatar and tabs
    // stay reachable; the strip does not cover them.
    function pngAt(buf, x, y) {
      let pos = 8;
      let w = 0;
      let ctype = 2;
      const idat = [];
      while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.subarray(pos + 4, pos + 8).toString("ascii");
        const chunk = buf.subarray(pos + 8, pos + 8 + len);
        pos += 12 + len;
        if (type === "IHDR") { w = chunk.readUInt32BE(0); ctype = chunk[9]; }
        else if (type === "IDAT") idat.push(chunk);
        else if (type === "IEND") break;
      }
      const bpp = ctype === 6 ? 4 : 3;
      const raw = zlib.inflateSync(Buffer.concat(idat));
      const stride = w * bpp;
      let prev = Buffer.alloc(stride);
      const paeth = (a, b, c) => {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        if (pa <= pb && pa <= pc) return a;
        return pb <= pc ? b : c;
      };
      let i = 0;
      for (let row = 0; row <= y; row++) {
        const filter = raw[i++];
        const cur = Buffer.from(raw.subarray(i, i + stride));
        i += stride;
        if (filter === 1) for (let k = 0; k < stride; k++) cur[k] = (cur[k] + (k >= bpp ? cur[k - bpp] : 0)) & 255;
        else if (filter === 2) for (let k = 0; k < stride; k++) cur[k] = (cur[k] + prev[k]) & 255;
        else if (filter === 3) for (let k = 0; k < stride; k++) cur[k] = (cur[k] + (((k >= bpp ? cur[k - bpp] : 0) + prev[k]) >> 1)) & 255;
        else if (filter === 4) for (let k = 0; k < stride; k++) cur[k] = (cur[k] + paeth(k >= bpp ? cur[k - bpp] : 0, prev[k], k >= bpp ? prev[k - bpp] : 0)) & 255;
        prev = cur;
        if (row === y) {
          const o = x * bpp;
          return [cur[o], cur[o + 1], cur[o + 2]];
        }
      }
      fail("screenshot pixel is out of range");
    }
    async function readStrip(page) {
      return page.evaluate(() => {
        const bar = document.querySelector("#app .topbar.tall");
        const before = getComputedStyle(bar, "::before");
        const veil = getComputedStyle(document.body, "::before");
        const colorOf = (value) => {
          const m = String(value).match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
          return { r: p[0], g: p[1], b: p[2], a: p.length === 4 ? p[3] : 1 };
        };
        const ava = bar.querySelector(".m-ava").getBoundingClientRect();
        const tabs = bar.querySelector(".tabs-bar").getBoundingClientRect();
        const hitAva = document.elementFromPoint(Math.round(ava.left + 8), Math.round(ava.top + ava.height / 2));
        const hitTab = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(tabs.top + 12));
        return {
          pad: parseFloat(getComputedStyle(bar).paddingTop) || 0,
          before: colorOf(before.backgroundColor),
          veil: colorOf(veil.backgroundColor),
          headTop: bar.querySelector(".mhead").getBoundingClientRect().top,
          tabsTop: tabs.top,
          hidden: bar.classList.contains("is-hidden"),
          avaOk: !!(hitAva && hitAva.closest(".m-ava")),
          tabOk: !!(hitTab && hitTab.closest(".tabs-bar, .tab, .tab-pair")),
          color: (document.querySelector('meta[name="theme-color"]') || {}).content || "",
          theme: document.documentElement.getAttribute("data-theme")
        };
      });
    }
    function solid(color, rgb, label) {
      if (!color || color.a < 1) fail(label + ": status strip is not opaque " + JSON.stringify(color));
      if (color.r !== rgb[0] || color.g !== rgb[1] || color.b !== rgb[2]) fail(label + ": status strip is not the theme background " + JSON.stringify(color));
      if (color.r === 19 && color.g === 19 && color.b === 19) fail(label + ": Android grey strip is showing");
    }
    async function pixelCase(appearance, rgb, bar) {
      const shot = await open(browser, origin, { appearance, inset: 50, screen: { height: 915, avail: 800 } });
      await shot.page.setViewportSize({ width: 412, height: 915 });
      await shot.inset(50);
      await settle(shot.page);
      let s = await readStrip(shot.page);
      if (s.theme !== appearance) fail(appearance + ": theme did not apply " + JSON.stringify(s));
      if (!near(s.pad, 50) || !near(s.headTop, 50)) fail(appearance + ": header is not one status-bar inset below the top " + JSON.stringify(s));
      solid(s.before, rgb, appearance + " rest");
      solid(s.veil, rgb, appearance + " veil");
      if (String(s.color).toUpperCase() !== bar) fail(appearance + ": native bar colour " + s.color);
      if (!s.avaOk || !s.tabOk) fail(appearance + ": the strip covers the avatar or the tabs " + JSON.stringify(s));
      const top = await shot.page.screenshot({ clip: { x: 0, y: 0, width: 412, height: 120 } });
      const px = pngAt(top, 400, 16);
      if (Math.abs(px[0] - rgb[0]) > 2 || Math.abs(px[1] - rgb[1]) > 2 || Math.abs(px[2] - rgb[2]) > 2) fail(appearance + ": painted strip is " + px.join(","));
      await scrollDown(shot.page);
      s = await readStrip(shot.page);
      if (!s.hidden || !near(s.tabsTop, 50)) fail(appearance + ": scrolled tabs are not under the status bar " + JSON.stringify(s));
      solid(s.veil, rgb, appearance + " scrolled");
      if (!s.tabOk) fail(appearance + ": scrolled tabs are not reachable");
      const tucked = await shot.page.screenshot({ clip: { x: 0, y: 0, width: 412, height: 120 } });
      const tuckedPx = pngAt(tucked, 400, 16);
      if (Math.abs(tuckedPx[0] - rgb[0]) > 2 || Math.abs(tuckedPx[1] - rgb[1]) > 2 || Math.abs(tuckedPx[2] - rgb[2]) > 2) fail(appearance + ": scrolled strip is " + tuckedPx.join(","));
      if (process.env.SHOT_DIR) {
        fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.SHOT_DIR, "pixel-" + appearance + "-rest.png"), top);
        fs.writeFileSync(path.join(process.env.SHOT_DIR, "pixel-" + appearance + "-scrolled.png"), tucked);
      }
      await scrollUp(shot.page);
      s = await readStrip(shot.page);
      if (s.hidden || !s.avaOk) fail(appearance + ": header did not return " + JSON.stringify(s));
      if (shot.errors.length) fail("page errors: " + shot.errors.join(" | "));
      await shot.context.close();
    }
    await pixelCase("lightsout", [0, 0, 0], "#010101");
    await pixelCase("default", [255, 255, 255], "#FFFFFF");
    console.log("header-stable ok");
  } finally {
    await browser.close();
    if (server.close && !sharedStaticServer()) server.close();
  }
}

main().catch((err) => { if (!process.exitCode) process.exitCode = 1; console.error(err && err.message || err); });
