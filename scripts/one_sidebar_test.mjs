/* Desktop and tablet keep one left sidebar. The edge drawer stays on a phone. */
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
  { name: "desktop", width: 1280, height: 800, wide: true },
  { name: "tablet", width: 820, height: 1180, wide: true },
  { name: "phone", width: 360, height: 740, wide: false }
];

async function checkWide(page, label) {
  const before = await page.evaluate(() => ({
    drawer: !!document.querySelector(".drawer-x"),
    bookmarks: !!document.querySelector("header.nav a[href='#/bookmarks']"),
    profile: [...document.querySelectorAll("header.nav .nav-label")].some((node) => (node.textContent || "") === "Profile"),
    pill: document.querySelector("header.nav:not(.nav-land) button.account-pill") && document.querySelector("header.nav:not(.nav-land) button.account-pill").getAttribute("data-act")
  }));
  if (before.drawer) fail(label + " opened the edge drawer");
  if (!before.bookmarks || !before.profile) fail(label + " sidebar is missing a menu item");
  if (before.pill !== "account-menu") fail(label + " profile pill still opens the drawer");
  await page.locator("header.nav:not(.nav-land) button.account-pill").click();
  await page.waitForSelector(".acct-menu", { timeout: 5000 });
  const menu = await page.evaluate(() => {
    const box = document.querySelector(".acct-menu");
    return {
      settings: !!document.querySelector(".acct-menu a[href='#/settings']"),
      leave: !!document.querySelector(".acct-menu [data-acct='logout'], .acct-menu [data-acct='login']"),
      drawer: !!document.querySelector(".drawer-x"),
      text: box ? box.innerText : ""
    };
  });
  if (!menu.settings || !menu.leave || menu.drawer) fail(label + " account popup is wrong");
  if (menu.text.length > 80) fail(label + " account popup is too large");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".acct-menu", { state: "detached", timeout: 5000 });
}

async function checkPhone(page, label) {
  if (await page.locator(".drawer-x").count()) fail(label + " drawer is open before a tap");
  await page.locator("button.m-ava").locator("visible=true").click();
  await page.waitForSelector(".drawer-x", { timeout: 5000 });
  const info = await page.evaluate(() => {
    const drawer = document.querySelector(".drawer-x");
    return {
      fold: !!drawer.querySelector("[data-act='drawer-fold']"),
      logout: !!drawer.querySelector(".drawer-scroll [data-acct='logout']"),
      bookmarks: !!drawer.querySelector("a[href='#/bookmarks']")
    };
  });
  if (!info.fold || !info.bookmarks || info.logout) fail(label + " phone drawer changed");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".drawer-x", { state: "detached", timeout: 5000 });
}

async function checkHidden(page, label) {
  const shown = await page.evaluate(() => ({
    bookmarks: !!document.querySelector("header.nav a[href='#/bookmarks']"),
    drawer: !!document.querySelector(".drawer-x")
  }));
  if (shown.bookmarks) fail(label + " hidden bookmarks is in the sidebar");
  if (shown.drawer) fail(label + " the edge drawer opened");
  await page.locator("header.nav:not(.nav-land) button.account-pill").click();
  await page.waitForSelector(".acct-menu a[href='#/settings']", { timeout: 5000 });
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    for (const size of SIZES) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
      const page = await context.newPage();
      await page.addInitScript(() => {
        localStorage.setItem("viktorychapp-lang-user-picked", "1");
        localStorage.setItem("superintelapp-lang", "en");
      });
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("http://127.0.0.1")) route.continue();
        else route.abort();
      });
      await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => [...document.querySelectorAll("header.nav, button.m-ava")].some((el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return style.display !== "none" && box.width > 0 && box.height > 0;
      }));
      if (size.wide) await checkWide(page, size.name);
      else await checkPhone(page, size.name);
      await context.close();
    }
    const hidden = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await hidden.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("viktorychapp-lang-user-picked", "1");
      localStorage.setItem("superintelapp-lang", "en");
      localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({
        version: 1,
        initialized: true,
        drawerMenu: { sections: [], order: [], hidden: ["bookmarks"], at: 1 }
      }));
    });
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("http://127.0.0.1")) route.continue();
      else route.abort();
    });
    await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("header.nav:not(.nav-land) button.account-pill");
    await checkHidden(page, "hidden");
    await hidden.close();
    console.log("one sidebar ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
