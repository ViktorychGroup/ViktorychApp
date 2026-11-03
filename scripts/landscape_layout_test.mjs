/* Layout checks for the phone landscape rail and a full-width page.
   Viewports are the short landscape sizes, the matching portraits, and tablets.
   Nothing here prints account names. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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

const MEASURE = `(() => {
  const doc = document.documentElement;
  const appEl = document.querySelector(".app");
  const center = document.querySelector(".center");
  const rail = document.querySelector("header.nav.nav-land");
  const mainNav = document.querySelector("header.nav:not(.nav-land)");
  const side = document.querySelector("aside.side");
  const tabs = document.querySelector(".tabs-bar");
  const bar = document.querySelector("nav.bottom-nav");
  const dock = document.querySelector("#dock-root");
  const problems = [];
  function shown(el) {
    if (!el) return null;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return rect;
  }
  function clip(rect, limit) {
    if (!rect || !limit) return null;
    const left = Math.max(rect.left, limit.left);
    const right = Math.min(rect.right, limit.right);
    const top = Math.max(rect.top, limit.top);
    const bottom = Math.min(rect.bottom, limit.bottom);
    const width = right - left;
    const height = bottom - top;
    if (width < 1 || height < 1) return null;
    return { left, right, top, bottom, width, height };
  }
  function hits(a, b) {
    if (!a || !b) return false;
    const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return width > 1 && height > 1;
  }
  const appBox = appEl.getBoundingClientRect();
  const cBox = center.getBoundingClientRect();
  const appStyle = getComputedStyle(appEl);
  const padL = parseFloat(appStyle.paddingLeft) || 0;
  const padR = parseFloat(appStyle.paddingRight) || 0;
  const gapLeft = appBox.left + window.scrollX;
  const gapRight = doc.clientWidth - (appBox.right + window.scrollX);
  const sideBox = shown(side);
  const edge = sideBox ? Math.max(sideBox.right, cBox.right) : cBox.right;
  const centerGap = (appBox.right - padR) - edge;
  const overflow = doc.scrollWidth > doc.clientWidth + 1;
  const wide = window.innerWidth >= 1280;
  if (overflow) problems.push("horizontal overflow " + doc.scrollWidth + ">" + doc.clientWidth);
  if (wide) {
    if (Math.abs(gapLeft - gapRight) > 3) problems.push("desktop margin is uneven " + gapLeft + " " + gapRight);
  } else {
    if (Math.abs(gapLeft) > 2) problems.push("left gap " + gapLeft);
    if (Math.abs(gapRight) > 2) problems.push("right gap " + gapRight);
    if (Math.abs(centerGap) > 2) problems.push("content misses the right edge " + centerGap);
  }
  if (side && getComputedStyle(side).display === "none" && side.getBoundingClientRect().width > 1) {
    problems.push("hidden right column still has width");
  }
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta || !meta.content.includes("viewport-fit=cover")) problems.push("viewport-fit=cover missing");
  const railBox = shown(rail);
  const phoneRail = !!(railBox && window.innerWidth <= 1100 && window.innerHeight <= 520);
  if (phoneRail) {
    const scrollEl = rail.querySelector(".nav-scroll");
    const scrollBox = scrollEl.getBoundingClientRect();
    const logo = rail.querySelector(".logo");
    const post = rail.querySelector(".post-btn");
    const account = rail.querySelector(".account-pill");
    const logoBox = shown(logo);
    const postBox = shown(post);
    const accountBox = shown(account);
    const rows = [...rail.querySelectorAll(".nav-scroll > a.nav-item, .nav-scroll > .nav-land-more")];
    const targets = [logo, ...rows, post, account].filter(Boolean);
    targets.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 44 || rect.height < 44) problems.push("tap target " + Math.round(rect.width) + "x" + Math.round(rect.height));
    });
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1].getBoundingClientRect();
      const next = rows[i].getBoundingClientRect();
      const gap = next.top - prev.bottom;
      if (gap < 2 || gap > 12) problems.push("rail spacing " + gap);
      if (hits(clip(prev, scrollBox), clip(next, scrollBox))) problems.push("rail items overlap");
    }
    if (!logoBox || logoBox.bottom > scrollBox.top + 2) problems.push("logo is not at the top");
    if (!postBox || postBox.top < scrollBox.bottom - 2) problems.push("post button is not under the icons");
    if (!accountBox || !postBox || accountBox.top < postBox.bottom - 2) problems.push("account button is not at the bottom");
    if (!accountBox || railBox.bottom - accountBox.bottom > 20) problems.push("account is not pinned to the rail bottom");
    const label = rail.querySelector(".nav-scroll > a.nav-item .nav-label");
    if (!label || getComputedStyle(label).display !== "none") problems.push("rail is not icon-only");
    const scrollStyle = getComputedStyle(scrollEl);
    if (scrollStyle.overflowY !== "auto" && scrollStyle.overflowY !== "scroll") problems.push("rail cannot scroll");
    if (window.innerHeight <= 430 && scrollEl.scrollHeight <= scrollEl.clientHeight + 4) problems.push("short rail does not scroll");
    if (cBox.width < 280) problems.push("timeline is too narrow " + Math.round(cBox.width));
    if (sideBox) problems.push("right column is visible on a phone");
    const tabsBox = shown(tabs);
    const barBox = shown(bar);
    const panels = dock ? [...dock.querySelectorAll(".xdock-panel")].map(shown).filter(Boolean) : [];
    if (tabsBox && hits(tabsBox, railBox)) problems.push("tabs overlap the rail");
    if (barBox && hits(barBox, railBox)) problems.push("bottom nav overlaps the rail");
    if (barBox && tabsBox && hits(barBox, tabsBox)) problems.push("bottom nav overlaps the tabs");
    if (!panels.length) problems.push("dock squares are missing");
    panels.forEach((panel, index) => {
      if (hits(panel, railBox)) problems.push("dock overlaps the rail");
      if (tabsBox && hits(panel, tabsBox)) problems.push("dock overlaps the tabs");
      if (barBox && hits(panel, barBox)) problems.push("dock overlaps the bottom nav");
      for (let j = index + 1; j < panels.length; j += 1) {
        if (hits(panel, panels[j])) problems.push("dock squares overlap");
      }
      if (panel.width < 44 || panel.height < 44) problems.push("dock tap target under 44");
      if (panel.right > window.innerWidth - padR + 1) problems.push("dock crosses the right inset");
      if (panel.bottom > window.innerHeight + 1) problems.push("dock crosses the bottom edge");
    });
    rows.forEach((row) => {
      const visible = clip(row.getBoundingClientRect(), scrollBox);
      if (visible && postBox && hits(visible, postBox)) problems.push("icons overlap the post button");
      if (visible && accountBox && hits(visible, accountBox)) problems.push("icons overlap the account button");
      if (visible && logoBox && hits(visible, logoBox)) problems.push("icons overlap the logo");
    });
  }
  if (window.innerWidth < 500 && window.innerHeight > window.innerWidth) {
    const mainBox = shown(mainNav);
    const landBox = shown(rail);
    if (mainBox || landBox) problems.push("portrait phone still shows a sidebar");
    if (cBox.width < 280) problems.push("portrait timeline is too narrow");
  }
  return {
    problems,
    gapLeft: Math.round(gapLeft * 10) / 10,
    gapRight: Math.round(gapRight * 10) / 10,
    centerGap: Math.round(centerGap * 10) / 10,
    overflow,
    center: Math.round(cBox.width),
    padL,
    padR,
    rail: railBox ? Math.round(railBox.width) : 0,
    side: sideBox ? "shown" : "hidden"
  };
})()`;

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"]
  });
  const page = await browser.newPage();
  const client = await page.context().newCDPSession(page);
  page.on("pageerror", (err) => {
    console.error("page error", err && err.message ? err.message : err);
  });

  async function emulate(width, height, options) {
    const opts = options || {};
    await client.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: true,
      screenOrientation: width >= height
        ? { type: "landscapePrimary", angle: 90 }
        : { type: "portraitPrimary", angle: 0 }
    });
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    const features = [
      { name: "hover", value: "none" },
      { name: "pointer", value: "coarse" }
    ];
    if (opts.standalone) features.push({ name: "display-mode", value: "standalone" });
    await client.send("Emulation.setEmulatedMedia", { features });
    await page.evaluate((safe) => {
      const root = document.documentElement;
      ["l", "r", "b"].forEach((side) => {
        const name = "--safe-" + side;
        if (safe[side]) root.style.setProperty(name, safe[side] + "px");
        else root.style.removeProperty(name);
      });
    }, { l: opts.safeL || 0, r: opts.safeR || 0, b: opts.safeB || 0 });
    await sleep(60);
  }

  try {
    await emulate(390, 844);
    await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".app .center .tabs-bar", { timeout: 20000 });
    await page.waitForSelector("#dock-root", { state: "attached", timeout: 20000 });
    await sleep(150);

    const viewports = [
      [844, 390],
      [915, 412],
      [740, 360],
      [932, 430],
      [390, 844],
      [412, 915],
      [360, 740],
      [430, 932],
      [768, 1024],
      [820, 1180],
      [1024, 1366],
      [1024, 768],
      [1180, 820],
      [1366, 1024]
    ];
    for (const [width, height] of viewports) {
      await emulate(width, height);
      const info = await page.evaluate(MEASURE);
      if (info.problems.length) fail(width + "x" + height + " " + info.problems.join("; ") + " " + JSON.stringify(info));
      console.log("layout", width + "x" + height, "ok", info.center + "px");
    }

    await emulate(844, 390, { safeL: 47, safeR: 24, safeB: 16, standalone: true });
    const inset = await page.evaluate(MEASURE);
    if (inset.problems.length) fail("safe area " + inset.problems.join("; ") + " " + JSON.stringify(inset));
    if (inset.padL !== 47 || inset.padR !== 24) fail("safe area padding " + JSON.stringify(inset));
    const pinned = await page.evaluate(`(() => {
      const rail = document.querySelector("header.nav.nav-land");
      const account = rail.querySelector(".account-pill").getBoundingClientRect();
      const railBox = rail.getBoundingClientRect();
      return { lift: Math.round(railBox.bottom - account.bottom), standalone: matchMedia("(display-mode: standalone)").matches };
    })()`);
    if (pinned.lift < 16) fail("account ignores the bottom inset " + JSON.stringify(pinned));
    console.log("safe area ok", pinned.standalone ? "standalone" : "coarse");
    console.log("landscape layout ok");
    // The personal sidebar logo runs here because this step has Playwright.
    const logo = spawnSync(process.execPath, [path.join(root, "scripts", "logo_text_test.mjs")], { stdio: "inherit", env: process.env });
    if (logo.status !== 0) fail("logo text checks failed");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
