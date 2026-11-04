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

/* Per-frame header check on a phone. The header is recorded on every
   animation frame while the page scrolls down (with Chrome's URL bar
   collapsing mid-scroll in a browser tab), then scrolls up again.
   On every frame: the header is never taller (its bottom edge never lower)
   than at rest, its own height never changes, nothing but the header sits
   at the top edge (no grey band), and it never drops below the top edge.
   Once hidden, the compact header leaves exactly the tab row pinned under
   the safe area, with nothing of the avatar row or stories tray showing in
   the strip above it. Covers the browser tab, standalone and fullscreen, the
   compact and classic header, the status bar mode, safe-area insets of 0,
   24 and 48px, and the home stories tray (demo accounts) that signed-in
   people always have. FULL=1 runs every combination. */
const DEMO_STORIES = {
  accounts: [1, 2, 3, 4, 5].map((n) => ({
    id: "app:demo" + n, platform: "app", handle: "demo" + n, name: "Demo " + n,
    avatar: "https://example.invalid/a" + n + ".png",
    items: [{ id: "s" + n, url: "https://example.invalid/s" + n + ".jpg", type: "photo" }]
  }))
};

function cases() {
  const out = [];
  for (const mode of ["tab", "standalone", "fullscreen"]) for (const classic of [false, true]) for (const statusBar of [false, true]) for (const inset of [0, 24, 48]) for (const stories of [true, false]) {
    out.push({ mode, classic, statusBar, inset, stories });
  }
  if (process.env.FULL) return out;
  /* The quick set: every display mode and header style with the tray at a
     48px inset, the status bar mode at 24px, and a no-tray and a no-inset
     control. */
  return out.filter((c) => (c.stories && c.inset === 48 && !c.statusBar)
    || (c.stories && c.inset === 24 && c.statusBar && c.mode !== "fullscreen")
    || (!c.stories && c.inset === 24 && !c.statusBar && !c.classic && c.mode === "tab")
    || (c.stories && c.inset === 0 && !c.statusBar && !c.classic && c.mode === "standalone"));
}

async function run(browser, origin, c) {
  const label = `${c.mode}/${c.classic ? "classic" : "compact"}/${c.statusBar ? "statusbar" : "nobar"}/inset${c.inset}/${c.stories ? "stories" : "notray"}`;
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 412, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript((o) => {
    if (sessionStorage.getItem("hf-seeded")) return;
    sessionStorage.setItem("hf-seeded", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-server-off", JSON.stringify(o.classic ? ["compact_header"] : []));
    localStorage.setItem("viktorychapp-server-off-at", String(Date.now()));
  }, { classic: c.classic });
  /* Installed display modes: the media query answers for the mode and the
     screen reports a phone whose status bar is (standalone) or is not
     (fullscreen) taken out of the available height. */
  await ctx.addInitScript((o) => {
    if (o.mode === "tab") return;
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => {
      const m = String(q).match(/display-mode:\s*([a-z-]+)/);
      if (!m) return real(q);
      return { matches: m[1] === o.mode, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } };
    };
    const full = 800 + o.inset + 48;
    Object.defineProperty(Screen.prototype, "height", { configurable: true, get() { return full; } });
    Object.defineProperty(Screen.prototype, "availHeight", { configurable: true, get() { return o.mode === "fullscreen" ? full : full - o.inset; } });
  }, { mode: c.mode, inset: c.inset });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  if (c.inset) await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: c.inset, topMax: c.inset } });
  await page.route((u) => !u.hostname.startsWith("127."), (r) => r.abort());
  if (c.mode !== "tab") {
    await page.route("**/styles.css*", async (r) => {
      const res = await r.fetch();
      const body = (await res.text())
        .replace(/\(display-mode:\s*standalone\)/g, c.mode === "standalone" ? "(min-width: 0px)" : "(max-width: 0px)")
        .replace(/\(display-mode:\s*fullscreen\)/g, c.mode === "fullscreen" ? "(min-width: 0px)" : "(max-width: 0px)");
      r.fulfill({ status: 200, contentType: "text/css", body });
    });
  }
  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#app article").length > 3 && document.querySelector("#app .topbar.tall"), null, { timeout: 45000 });
  if (c.statusBar) {
    await page.goto(origin + "/#/settings/display");
    await page.waitForSelector('[data-act="status-bar"]', { timeout: 15000 });
    await page.click('[data-act="status-bar"]');
    await sleep(300);
    await page.goto(origin + "/#/");
    await page.waitForFunction(() => document.querySelectorAll("#app article").length > 3, null, { timeout: 30000 });
  }
  if (c.stories) {
    await page.evaluate((doc) => {
      const fresh = new Date(Date.now() - 3600e3).toISOString();
      doc.updated = fresh;
      doc.accounts.forEach((a) => a.items.forEach((it) => { it.date = fresh; }));
      window.Stories.apply(doc);
      location.hash = "#/explore";
    }, DEMO_STORIES);
    await sleep(500);
    await page.evaluate(() => { location.hash = "#/"; });
    await page.waitForSelector("#app .topbar.tall .story-shell", { timeout: 10000 });
  }
  await sleep(1000);
  await page.evaluate(() => {
    window.__hf = [];
    const tick = () => {
      const bar = document.querySelector("#app .topbar.tall");
      if (bar) {
        const r = bar.getBoundingClientRect();
        const tabs = bar.querySelector(".tabs-bar");
        const el = document.elementFromPoint(Math.round(innerWidth / 2), 1);
        window.__hf.push({
          y: Math.round(scrollY), top: r.top, bottom: r.bottom, h: r.height,
          pad: parseFloat(getComputedStyle(bar).paddingTop) || 0,
          tabsTop: tabs ? tabs.getBoundingClientRect().top : NaN,
          hid: bar.classList.contains("is-hidden"),
          topEl: el ? (bar.contains(el) ? "bar" : el.tagName + "." + String(el.className).slice(0, 40)) : "none",
          /* The tab row's own backdrop: the first non-transparent background
             from the tab row up to the header, and the backdrop filter there. */
          ...(() => {
            if (!tabs) return { tabsAlpha: NaN, tabsBf: "", tabsHit: true, below: false };
            let alpha = 0, bf = "none";
            for (let e = tabs; e && alpha === 0; e = e === bar ? null : e.parentElement) {
              const cs = getComputedStyle(e);
              const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
              const parts = m ? m[1].split(/[ ,\/]+/).filter(Boolean) : [];
              alpha = parts.length === 4 ? parseFloat(parts[3]) : (parts.length === 3 ? 1 : 0);
              bf = cs.backdropFilter || cs.webkitBackdropFilter || "none";
              /* The compact header keeps its tint on a layer behind it. */
              if (alpha === 0 && e === bar) {
                const after = getComputedStyle(bar, "::after");
                const am = after.content !== "none" ? after.backgroundColor.match(/rgba?\(([^)]+)\)/) : null;
                const ap = am ? am[1].split(/[ ,\/]+/).filter(Boolean) : [];
                alpha = ap.length === 4 ? parseFloat(ap[3]) : (ap.length === 3 ? 1 : 0);
                bf = after.backdropFilter || after.webkitBackdropFilter || "none";
              }
            }
            const tr = tabs.getBoundingClientRect();
            const visTop = Math.max(0, tr.top), visBottom = Math.min(innerHeight, tr.bottom);
            const mid = Math.round((visTop + visBottom) / 2);
            const onScreen = visBottom - visTop >= 2;
            const hitTabs = onScreen ? document.elementFromPoint(Math.round(innerWidth / 2), mid) : null;
            const hitBelow = onScreen ? document.elementFromPoint(Math.round(innerWidth / 2), Math.round(tr.bottom + 8)) : null;
            return { tabsAlpha: alpha, tabsBf: bf, tabsHit: !onScreen || !!(hitTabs && bar.contains(hitTabs)), below: !!(hitBelow && bar.contains(hitBelow)), tabsBottom: tr.bottom };
          })(),
          /* What shows in the safe-area strip above the tab row. */
          inset: (() => {
            const pad = parseFloat(getComputedStyle(bar).paddingTop) || 0;
            if (pad < 4) return "";
            const hit = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(pad / 2));
            return hit && hit.closest(".mhead, .story-shell") ? hit.closest(".mhead, .story-shell").className.split(" ")[0] : "";
          })()
        });
      }
      window.__hfRaf = requestAnimationFrame(tick);
    };
    tick();
  });
  const shotDir = process.env.SHOT_DIR || "";
  const shot = async (name) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, label.replace(/\//g, "_") + "-" + name + ".png"), clip: { x: 0, y: 0, width: 412, height: 320 } }); };
  /* Mouse-sourced gestures: synthetic touch gestures in headless Chrome
     raise a long-press contextmenu that opens the post sheet. */
  const swipe = (dy) => cdp.send("Input.synthesizeScrollGesture", { x: 206, y: 600, yDistance: dy, speed: 1400, gestureSourceType: "mouse" });
  await shot("rest");
  await swipe(-700);
  if (c.mode === "tab") await page.setViewportSize({ width: 412, height: 856 });
  await swipe(-700);
  await shot("mid");
  await sleep(1600);
  await swipe(-500);
  await sleep(400);
  const down = await page.evaluate(() => window.__hf.length);
  await sleep(1200);
  await swipe(400);
  await sleep(800);
  await shot("up");
  const rec = await page.evaluate(() => { cancelAnimationFrame(window.__hfRaf); return window.__hf; });
  await ctx.close();
  const rest = rec[0];
  const problems = [];
  const grow = rec.find((f) => f.bottom > rest.bottom + 0.5);
  if (grow) problems.push(`header grew past its at-rest bottom ${rest.bottom} to ${grow.bottom} at scrollY ${grow.y}`);
  const resized = rec.find((f) => Math.abs(f.h - rest.h) > 0.5);
  if (resized) problems.push(`header height changed from ${rest.h} to ${resized.h} at scrollY ${resized.y}`);
  const band = rec.find((f) => f.topEl !== "bar" && f.bottom > 1);
  if (band) problems.push(`something other than the header (${band.topEl}) sits at the top edge at scrollY ${band.y}`);
  const gap = rec.find((f) => f.top > 0.5);
  if (gap) problems.push(`header dropped ${gap.top}px below the top edge at scrollY ${gap.y}`);
  const hidden = rec.slice(0, down).filter((f) => f.hid);
  if (!hidden.length) problems.push("header never tucked away while scrolling down");
  const settled = rec[down - 1];
  if (!c.classic && settled && settled.hid && Math.abs(settled.tabsTop - settled.pad) > 1) problems.push(`tucked compact header should leave the tab row at ${settled.pad}px, found ${settled.tabsTop}px`);
  if (!c.classic && settled && settled.hid && settled.inset) problems.push(`tucked compact header still shows ${settled.inset} in the safe-area strip above the tabs`);
  /* Every frame: the tab row has a solid-enough background of its own (the
     header's tint at 80% or more), so labels stay readable over any post. */
  const thin = rec.find((f) => !(f.tabsAlpha >= 0.8));
  if (thin) problems.push(`tab row background is too transparent (alpha ${thin.tabsAlpha}, backdrop ${thin.tabsBf}) at scrollY ${thin.y}`);
  const covered = rec.find((f) => !f.tabsHit);
  if (covered) problems.push(`something covers the tab row at scrollY ${covered.y}`);
  /* Every frame with the compact header tucked and the tabs pinned: nothing of
     the header (the pills row) shows under the tab row over the posts. */
  if (!c.classic) {
    const band = rec.find((f) => f.hid && Math.abs(f.tabsTop - f.pad) <= 1 && f.below);
    if (band) problems.push(`tucked compact header still shows a band under the tab row (below ${band.tabsBottom}px) at scrollY ${band.y}`);
  }
  const last = rec[rec.length - 1];
  if (last.hid) problems.push("header did not come back on the way up");
  return { label, problems, rest: Math.round(rest.h), frames: rec.length };
}

const server = await startServer();
const origin = `http://127.0.0.1:${server.address().port}`;
const chromium = await loadPlaywright();
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const failures = [];
try {
  for (const c of cases()) {
    const out = await run(browser, origin, c);
    console.log((out.problems.length ? "FAIL " : "ok   ") + out.label + ` (rest ${out.rest}px, ${out.frames} frames)` + (out.problems.length ? ": " + out.problems.join("; ") : ""));
    if (out.problems.length) failures.push(out.label);
  }
} finally {
  await browser.close();
  if (server.close && !sharedStaticServer()) server.close();
}
if (failures.length) fail(`header frames: ${failures.length} combination(s) failed: ${failures.join(", ")}`);
console.log("header frames ok");
