/* Desktop side panel (side_panel): on the right by default; the Display
   switch moves it left of the timeline next to the icon bar; dragging its
   inner edge resizes it within limits and the width survives a reload; Who
   to follow folds from its title and stays folded; the owner switch removes
   the handle, the folds and the switch. */
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

async function open(browser, origin, opts) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript((o) => {
    try {
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      if (!sessionStorage.getItem("sp-seed")) {
        sessionStorage.setItem("sp-seed", "1");
        if (o.settings) localStorage.setItem("viktorychapp-settings-v1", JSON.stringify(o.settings));
        if (o.ownerOff) localStorage.setItem("viktorychapp-server-off", JSON.stringify(["side_panel"]));
      }
    } catch (err) {}
  }, opts);
  const page = await context.newPage();
  await page.goto(origin + "/#/" + (opts.route || ""), { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .side", { timeout: 20000 }).catch(() => {});
  await sleep(900);
  return { context, page };
}

const READ = `(() => {
  const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return b.width ? { left: b.left, right: b.right, width: b.width } : null; };
  const sec = document.querySelector(".side [data-side-sec]");
  return { side: r(".side"), center: r(".center"), nav: r(".nav"), split: r(".side-split"),
    sec: sec ? { key: sec.dataset.sideSec, folded: sec.classList.contains("is-folded"), rows: [...sec.querySelectorAll(".card > :not(.side-fold-head)")].filter((el) => el.getBoundingClientRect().height > 0).length } : null };
})()`;

async function drag(page, from, to) {
  const box = await page.locator(".side-split").boundingBox();
  if (!box) fail("no side panel handle");
  const y = box.y + 200;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + (to - from) / 2, y, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + (to - from), y, { steps: 4 });
  await page.mouse.up();
  await sleep(400);
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    // 1. Default: right of the timeline, stock width, handle on its left edge.
    {
      const { context, page } = await open(browser, origin, {});
      const got = await page.evaluate(READ);
      if (!got.side || !got.center || got.side.left < got.center.right - 1) fail("default panel is not on the right " + JSON.stringify(got));
      if (Math.abs(got.side.width - 350) > 2) fail("default width changed " + JSON.stringify(got.side));
      if (!got.split || Math.abs(got.split.left - got.side.left) > 1) fail("handle not on the panel's left edge " + JSON.stringify(got));
      // Drag the left edge 80px left: the panel grows by 80.
      await drag(page, 0, -80);
      let now = await page.evaluate(READ);
      if (Math.abs(now.side.width - 430) > 6) fail("drag did not widen the panel " + JSON.stringify(now.side));
      // Way past the max: clamped at 520.
      await drag(page, 0, -400);
      now = await page.evaluate(READ);
      if (Math.abs(now.side.width - 520) > 2) fail("max width not kept " + JSON.stringify(now.side));
      await drag(page, 0, 500);
      now = await page.evaluate(READ);
      if (Math.abs(now.side.width - 280) > 2) fail("min width not kept " + JSON.stringify(now.side));
      await drag(page, 0, -60);
      const kept = (await page.evaluate(READ)).side.width;
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#app .side", { timeout: 20000 });
      await sleep(700);
      now = await page.evaluate(READ);
      if (Math.abs(now.side.width - kept) > 2) fail("width not remembered " + kept + " vs " + now.side.width);
      // Fold Who to follow: rows hide, survives a reload.
      if (now.sec && now.sec.key === "who") {
        if (now.sec.folded || now.sec.rows === 0) fail("Who to follow starts folded " + JSON.stringify(now.sec));
        await page.click('.side [data-act="side-fold"][data-key="who"]');
        await sleep(400);
        let f = await page.evaluate(READ);
        if (!f.sec.folded || f.sec.rows !== 0) fail("fold did not hide the section " + JSON.stringify(f.sec));
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#app .side [data-side-sec]", { timeout: 20000 });
        await sleep(500);
        f = await page.evaluate(READ);
        if (!f.sec.folded) fail("fold not remembered");
        await page.click('.side [data-act="side-fold"][data-key="who"]');
        await sleep(400);
        f = await page.evaluate(READ);
        if (f.sec.folded || f.sec.rows === 0) fail("unfold did not show the section " + JSON.stringify(f.sec));
      } else console.log("note: no Who to follow section in this snapshot; fold not checked");
      await context.close();
    }
    // 2. Switch in Display: moves the panel left, next to the icon bar.
    {
      const { context, page } = await open(browser, origin, { route: "settings/display" });
      await page.waitForSelector('[data-act="side-left"]', { timeout: 15000 });
      if ((await page.getAttribute('[data-act="side-left"]', "aria-checked")) !== "false") fail("left placement is on by default");
      await page.click('[data-act="side-left"]');
      await sleep(300);
      await page.goto(origin + "/#/");
      await page.waitForSelector("#app .side", { timeout: 15000 });
      await sleep(800);
      const got = await page.evaluate(READ);
      if (!got.side || !got.nav || !got.center) fail("left: layout missing " + JSON.stringify(got));
      if (Math.abs(got.side.left - got.nav.right) > 2 || got.side.right > got.center.left + 1) fail("left: panel not between the icon bar and the timeline " + JSON.stringify(got));
      if (!got.split || Math.abs(got.split.right - got.side.right) > 1) fail("left: handle not on the panel's right edge " + JSON.stringify(got));
      const before = got.side.width;
      await drag(page, 0, 60);
      const after = (await page.evaluate(READ)).side.width;
      if (Math.abs(after - before - 60) > 6) fail("left: dragging right did not widen " + before + " -> " + after);
      if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + "/left.png", clip: { x: 0, y: 0, width: Math.round(got.side.right) + 4, height: 600 } });
      await context.close();
    }
    // 3. Owner switch off: right side, no handle, no fold, no setting.
    {
      const { context, page } = await open(browser, origin, { ownerOff: true, settings: { sidePanelLeft: true, sideFold: { who: true } } });
      const got = await page.evaluate(READ);
      if (!got.side || got.side.left < got.center.right - 1) fail("owner off: panel moved " + JSON.stringify(got));
      if (got.split || got.sec) fail("owner off: handle or folds still there " + JSON.stringify(got));
      await page.goto(origin + "/#/settings/display");
      await sleep(1200);
      if (await page.$('[data-act="side-left"]')) fail("owner off: setting still offered");
      await context.close();
    }
    console.log("side panel ok");
  } finally {
    await browser.close();
    if (server.close && !sharedStaticServer()) server.close();
  }
}

main().catch((err) => { if (!process.exitCode) process.exitCode = 1; console.error(err && err.message || err); });
