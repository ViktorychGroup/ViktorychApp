/* WebKit at iPhone 11 and iPad sizes. Placeholders only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sharedStaticServer } from "./smoke_runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const devicesWanted = [
  { name: "iPhone 11", key: "iPhone 11" },
  { name: "iPad", key: "iPad (gen 7)" }
];

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
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  if (file.endsWith(".ico")) return "image/x-icon";
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
  const core = mod.default && mod.default.webkit ? mod.default : mod;
  return { webkit: core.webkit, devices: core.devices };
}

async function exercise(page, label, origin) {
  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".topbar, .mhead", { timeout: 20000 });
  const shell = await page.evaluate(() => {
    const html = document.documentElement;
    const viewport = document.querySelector('meta[name="viewport"]');
    const apple = document.querySelector('meta[name="apple-mobile-web-app-capable"]');
    const manifest = document.querySelector('link[rel="manifest"]');
    const touch = document.querySelector('link[rel="apple-touch-icon"]');
    return {
      ios: html.classList.contains("ios"),
      viewport: viewport ? viewport.getAttribute("content") : "",
      apple: apple ? apple.getAttribute("content") : "",
      manifest: manifest ? manifest.getAttribute("href") : "",
      touch: touch ? touch.getAttribute("href") : "",
      stories: !!document.getElementById("stories"),
      timeout: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function",
      idle: typeof requestIdleCallback === "function",
      overflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    };
  });
  if (!shell.ios) fail(label + " did not mark iOS");
  if (shell.viewport.indexOf("viewport-fit=cover") < 0) fail(label + " viewport does not cover the notch");
  if (shell.apple !== "yes") fail(label + " is missing the Home Screen meta");
  if (!shell.manifest || !shell.touch) fail(label + " is missing the manifest or the touch icon");
  if (!shell.stories) fail(label + " is missing the stories root");
  if (!shell.timeout || !shell.idle) fail(label + " is missing a WebKit fallback");
  if (!shell.overflow) fail(label + " scrolls sideways");

  const install = page.locator("#install-banner");
  if (await install.count()) {
    await page.locator("[data-native='install-dismiss']").click();
    await page.waitForFunction(() => !document.getElementById("install-banner"), null, { timeout: 10000 }).catch(() => fail(label + " install banner did not close"));
  }

  const note = page.locator("[data-ios='storage']");
  if (await note.count()) {
    const copy = await note.innerText();
    if (copy.indexOf("Home Screen") < 0 && copy.indexOf("pantalla de inicio") < 0 && copy.indexOf("Домой") < 0) {
      fail(label + " storage note is unclear");
    }
    await page.locator("[data-ios='dismiss']").click();
    // WebKit in CI sometimes lands the tap beside the sticky note; dispatch the
    // click on the button itself when the first tap missed.
    const gone = await page.waitForFunction(() => !document.querySelector("[data-ios='storage']"), null, { timeout: 3000 }).then(() => true, () => false);
    if (!gone) await page.evaluate(() => document.querySelectorAll("[data-ios='dismiss']").forEach((b) => b.click()));
    await page.waitForFunction(() => !document.querySelector("[data-ios='storage']"), null, { timeout: 10000 }).catch(() => fail(label + " storage note did not close"));
  }

  const opener = page.locator("button.fab, button.post-btn").locator("visible=true").first();
  await opener.click();
  await page.locator("#compose-text, .xc-text, textarea").first().waitFor({ timeout: 10000 });
  const font = await page.evaluate(() => {
    const field = document.querySelector("#compose-text, textarea");
    return field ? parseFloat(getComputedStyle(field).fontSize) : 0;
  });
  if (!(font >= 16)) fail(label + " field is " + font + "px");
  const close = page.locator(".modal [data-act='close-modal']").first();
  if (await close.count()) await close.click();

  await page.goto(origin + "/#/settings", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".set-list, .settings", { timeout: 15000 });

  await page.goto(origin + "/#/@user_a", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const main = document.querySelector("main, .center");
    return !!main && (main.innerText || "").trim().length > 0;
  }, null, { timeout: 15000 }).catch(() => fail(label + " profile page stayed empty"));

  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  const opened = await page.waitForFunction(() => {
    window.scrollTo(0, 0);
    document.querySelectorAll(".topbar").forEach((el) => el.classList.remove("is-hidden"));
    const phone = [...document.querySelectorAll("button.m-ava")].find((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && rect.height > 8 && rect.top >= 0 && rect.top < window.innerHeight;
    });
    const side = [...document.querySelectorAll("header.nav a.nav-item")].find((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && rect.height > 8 && rect.top >= 0 && rect.top < window.innerHeight;
    });
    if (phone) phone.click();
    return !!document.querySelector(".drawer") || !!side;
  }, null, { timeout: 15000 }).catch(() => fail(label + " menu did not open"));
  if (await page.locator(".drawer").count()) await page.keyboard.press("Escape");
  else if (!opened) fail(label + " has no menu");

  const caps = await page.evaluate(() => {
    const ios = window.ViktorychIos;
    return {
      heic: !!(ios && ios.isHeic({ name: "photo.heic", type: "" })),
      jpeg: !(ios && ios.isHeic({ name: "photo.jpg", type: "image/jpeg" })),
      mp4: ios && ios.recorderMime ? ios.recorderMime("video") : ""
    };
  });
  if (!caps.heic || !caps.jpeg) fail(label + " HEIC check failed");
}

async function main() {
  const { webkit, devices } = await loadPlaywright();
  if (!webkit || !devices) fail("Playwright WebKit is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await webkit.launch({ headless: true });
  try {
    for (const item of devicesWanted) {
      const device = devices[item.key];
      if (!device) fail("missing device " + item.key);
      const context = await browser.newContext({ ...device });
      await context.addInitScript(() => {
        localStorage.setItem("viktorychapp-lang-user-picked", "1");
        localStorage.setItem("superintelapp-lang", "en");
        localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
        localStorage.setItem("viktorychapp-install-dismissed", "1");
        localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
          token: "local-session",
          account: { publicId: "100000000001", handle: "user_a", displayName: "User A", avatar: "" }
        }));
      });
      const page = await context.newPage();
      await exercise(page, item.name, origin);
      await context.close();
    }
    console.log("ios webkit ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message ? err.message : err);
});
