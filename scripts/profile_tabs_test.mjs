/* Own profile tabs reorder with a pointer, on a phone and a desktop window. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sharedStaticServer } from "./smoke_runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(message);
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
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}

function idsOf(page) {
  return page.evaluate(() => [...document.querySelectorAll(".ptabs [data-ptab-id]")].map((el) => el.getAttribute("data-ptab-id")));
}

async function drag(page, id, dx) {
  /* A profile re-render replaces the tab strip. Wait until the same tabs
     have stayed on screen, then read the grip that is attached now. */
  const live = await page.waitForFunction((tabId) => {
    const bar = document.querySelector(".ptabs");
    const grip = document.querySelector('[data-ptab-id="' + tabId + '"] .ptab-grip');
    if (!bar || !grip || !grip.isConnected) return false;
    const ids = [...bar.querySelectorAll("[data-ptab-id]")].map((el) => el.getAttribute("data-ptab-id")).join(",");
    if (window.__ptabIds !== ids) {
      window.__ptabIds = ids;
      window.__ptabAt = performance.now();
      return false;
    }
    if (performance.now() - (window.__ptabAt || 0) < 50) return false;
    grip.scrollIntoView({ block: "nearest", inline: "nearest" });
    const box = grip.getBoundingClientRect();
    const strip = bar.getBoundingClientRect();
    if (box.width < 1 || box.height < 1 || strip.width < 1) return false;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, barX: strip.x, barW: strip.width };
  }, id, { timeout: 5000 });
  const box = await live.jsonValue().catch(() => null);
  if (!box) fail("missing tab " + id);
  const x = box.x;
  const y = box.y;
  const end = dx < 0 ? box.barX + 8 : Math.min(box.barX + box.barW - 8, x + dx);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(end, y, { steps: 16 });
  for (let i = 0; i < 16; i++) await page.mouse.move(end, y);
  await page.mouse.up();
}

async function check(page, label) {
  await page.waitForSelector("[data-ptab='edit']", { timeout: 15000 });
  const before = await idsOf(page);
  if (before[0] !== "posts") fail(label + " posts is not first");
  if (!before.includes("replies") || !before.includes("media") || !before.includes("highlights")) fail(label + " tabs missing");
  const height = await page.evaluate(() => {
    const tab = document.querySelector(".ptabs .tab");
    return tab ? tab.getBoundingClientRect().height : 0;
  });
  if (height < 40 || height > 48) fail(label + " tabs are not thin " + height);
  await page.locator("[data-ptab='edit']").click();
  await page.waitForSelector("[data-ptab='reset']");
  const share = await page.locator("[data-ptab='share']").getAttribute("aria-pressed");
  if (share !== "false") fail(label + " visitor order is on by default");
  await drag(page, "media", -280);
  await page.waitForFunction(() => {
    const ids = [...document.querySelectorAll(".ptabs [data-ptab-id]")].map((el) => el.getAttribute("data-ptab-id"));
    return ids[0] === "media";
  }, null, { timeout: 5000 });
  await page.locator("[data-ptab='vis'][data-id='highlights']").click();
  await page.locator("[data-ptab='done']").click();
  const after = await idsOf(page);
  if (after[0] !== "media") fail(label + " drag did not stick");
  if (after.includes("highlights")) fail(label + " hidden tab still shows");
  await page.locator("[data-ptab='edit']").click();
  await page.locator("[data-ptab='reset']").click();
  await page.locator("[data-ptab='done']").click();
  const reset = await idsOf(page);
  if (reset[0] !== "posts" || !reset.includes("highlights")) fail(label + " reset did not restore the tabs");
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const sizes = [
    { name: "phone", width: 390, height: 844 },
    { name: "desktop", width: 1280, height: 800 }
  ];
  try {
    for (const size of sizes) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
      const page = await context.newPage();
      page.on("pageerror", (err) => console.log("PAGE", err.message));
      await page.addInitScript(() => {
        localStorage.setItem("viktorychapp-lang-user-picked", "1");
        localStorage.setItem("superintelapp-lang", "en");
        localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
          token: "tok",
          account: { publicId: "111122223333", handle: "user_a", displayName: "User A", repostsLoaded: true }
        }));
      });
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("http://127.0.0.1")) route.continue();
        else route.abort();
      });
      await page.goto("http://127.0.0.1:" + port + "/index.html#/@user_a", { waitUntil: "domcontentloaded" });
      await check(page, size.name);
      await context.close();
    }
    console.log("profile tabs ok");
    // The profile Games tab rides along, since the workflow files stay as they are.
    const { spawnSync } = await import("node:child_process");
    const games = spawnSync(process.execPath, [path.join(root, "scripts", "profile_games_tab_test.mjs")], { stdio: "inherit", env: process.env });
    if (games.status !== 0) fail("profile games tab check failed");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
