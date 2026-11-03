/* Home stays on the phone bar and in the drawer, even when a saved menu hid it. */
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

const SIZES = [
  { name: "360", width: 360, height: 740 },
  { name: "iphone-14", width: 390, height: 844 },
  { name: "iphone-14-pro", width: 393, height: 852 },
  { name: "iphone-14-plus", width: 430, height: 932 }
];

function savedMenu() {
  return JSON.stringify({
    version: 1,
    initialized: true,
    bottomNavCustom: true,
    bottomNav: {
      order: ["communities", "lists", "feeds", "settings", "tv", "messages", "explore", "notifications", "home"],
      hidden: ["home"]
    },
    navCustom: {
      folders: [],
      order: ["explore", "notifications", "messages", "feeds", "lists"],
      hidden: ["home"]
    },
    drawerMenu: {
      sections: [],
      order: ["profile", "bookmarks", "settings", "logout", "customize"],
      hidden: ["home"],
      at: 1
    }
  });
}

async function check(page, label) {
  const bar = await page.evaluate(() => {
    const link = document.querySelector('nav.bottom-nav a[href="#/"]');
    if (!link) return null;
    const box = link.getBoundingClientRect();
    const style = getComputedStyle(link);
    return {
      w: box.width,
      h: box.height,
      display: style.display,
      label: link.getAttribute("aria-label") || ""
    };
  });
  if (!bar || bar.w < 24 || bar.h < 24 || bar.display === "none") fail(label + " bottom Home is missing");
  if (bar.label !== "Home") fail(label + " bottom Home label");
  await page.locator("button.m-ava").locator("visible=true").click();
  await page.waitForSelector('.drawer-x a[href="#/"]', { timeout: 5000 });
  const drawerHome = await page.evaluate(() => {
    const link = document.querySelector('.drawer-x a[href="#/"]');
    const box = link.getBoundingClientRect();
    return { w: box.width, h: box.height, hidden: !!document.querySelector('[data-drawer-key="home"] [data-act="drawer-vis"]') };
  });
  if (drawerHome.w < 8 || drawerHome.h < 8) fail(label + " drawer Home is missing");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".drawer-x", { state: "detached", timeout: 5000 });
  await page.locator(".page-head h1").click();
  await page.waitForFunction(() => {
    const hash = location.hash || "#/";
    return hash === "#/" || hash === "#" || hash === "";
  });
  await page.goto(page.url().split("#")[0] + "#/lists", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("a.m-logo");
  await page.locator("a.m-logo").click();
  await page.waitForFunction(() => {
    const hash = location.hash || "#/";
    return hash === "#/" || hash === "#" || hash === "";
  });
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    for (const size of SIZES) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        isMobile: true,
        hasTouch: true,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      });
      const page = await context.newPage();
      await page.addInitScript((raw) => {
        localStorage.setItem("viktorychapp-lang-user-picked", "1");
        localStorage.setItem("superintelapp-lang", "en");
        localStorage.setItem("viktorychapp-settings-v1", raw);
      }, savedMenu());
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("http://127.0.0.1")) route.continue();
        else route.abort();
      });
      await page.goto("http://127.0.0.1:" + port + "/index.html#/lists", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("nav.bottom-nav a");
      await check(page, size.name);
      await context.close();
    }
    console.log("home reach ok");
    // The Explore nav check rides along here so it runs in the nav workflow.
    const { spawnSync } = await import("node:child_process");
    const explore = spawnSync(process.execPath, [path.join(root, "scripts", "explore_nav_test.mjs")], { stdio: "inherit", env: process.env });
    if (explore.status !== 0) throw new Error("explore nav check failed");
    const features = spawnSync(process.execPath, [path.join(root, "scripts", "home_features_test.mjs")], { stdio: "inherit", env: process.env });
    if (features.status !== 0) throw new Error("home features check failed");
    const serverOff = spawnSync(process.execPath, [path.join(root, "scripts", "server_off_test.mjs")], { stdio: "inherit", env: process.env });
    if (serverOff.status !== 0) throw new Error("server off check failed");
    const feedInput = spawnSync(process.execPath, [path.join(root, "scripts", "feed_load_input_test.mjs")], { stdio: "inherit", env: process.env });
    if (feedInput.status !== 0) throw new Error("feed load input check failed");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
