/* App size is a scale of this page, not the browser's zoom. The window
   guess is simulated: a real Windows maximize is not available here. */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { windowGuess, scaleChoice } = require("../desktop-app.js");

const HD = { outerW: 1920, outerH: 1040, availW: 1920, availH: 1040 };
const pref = { mode: "window", manual: 100, maximized: 150, windowed: 120 };

test("a 1080p work area that the window fills counts as maximized", () => {
  assert.equal(windowGuess(HD), "maximized");
  assert.equal(scaleChoice(pref, "maximized", true), 150);
});

test("a smaller restored window uses the window size", () => {
  assert.equal(windowGuess({ outerW: 1400, outerH: 900, availW: 1920, availH: 1040 }), "window");
  assert.equal(scaleChoice(pref, "window", true), 120);
});

test("a gap that is neither clearly maximized nor clearly restored stays put", () => {
  assert.equal(windowGuess({ outerW: 1880, outerH: 1040, availW: 1920, availH: 1040 }), "unknown");
  assert.equal(scaleChoice(pref, "unknown", true), null);
});

test("full screen is not treated as a maximized window with a toolbar", () => {
  assert.equal(windowGuess(Object.assign({}, HD, { fullscreen: true })), "fullscreen");
  assert.equal(windowGuess(Object.assign({}, HD, { fullDisplay: true })), "fullscreen");
  assert.equal(scaleChoice(pref, "fullscreen", true), null);
});

test("half a screen is a window, not maximized", () => {
  assert.equal(windowGuess({ outerW: 960, outerH: 1040, availW: 1920, availH: 1040 }), "window");
});

test("off, manual and a phone stay predictable", () => {
  assert.equal(scaleChoice({ mode: "off" }, "maximized", true), 100);
  assert.equal(scaleChoice({ mode: "manual", manual: 130 }, "maximized", true), 130);
  assert.equal(scaleChoice(pref, "maximized", false), 100);
  assert.equal(scaleChoice({ mode: "manual", manual: 97 }, "window", true), 100);
  assert.equal(scaleChoice({ mode: "manual", manual: 250 }, "window", true), 200);
});

test("missing screen numbers are not a maximize", () => {
  assert.equal(windowGuess({ outerW: 0, outerH: 0, availW: 1920, availH: 1040 }), "unknown");
});

async function browserScale() {
  if (process.env.APP_SCALE_BROWSER !== "1") return;
  const http = await import("node:http");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const posts = [];
  const feeds = [];
  for (let i = 0; i < 8; i++) {
    const id = "p0" + i;
    feeds.push({ id: "lane" + i, platform: "rss", handle: "lane" + i, name: "Lane " + i });
    posts.push({ id, statusId: id, platform: "rss", feedId: "lane" + i, kind: "post", date: new Date().toISOString(), text: "Fixture line " + i, author: "Lane " + i, handle: "lane" + i, media: [], stats: { replies: 0, reposts: 0, likes: 0, views: 0 } });
  }
  const catalog = JSON.stringify({ updated: "2026-11-07T00:00:00.000Z", feeds, posts });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/feeds.json") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(catalog);
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      const type = file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : "text/javascript";
      res.writeHead(200, { "content-type": type + "; charset=utf-8" });
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const spec = process.env.PLAYWRIGHT_CORE;
  const mod = await import(pathToFileURL(spec).href);
  const browser = await (mod.chromium || mod.default.chromium).launch({ headless: true, channel: "chrome" });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
    await context.addInitScript(() => {
      localStorage.setItem("superintelapp-lang", "en");
      localStorage.setItem("viktorychapp-lang-user-picked", "1");
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorych-desktop-v1", JSON.stringify({ scale: { mode: "manual", manual: 150, maximized: 150, windowed: 120 } }));
    });
    const page = await context.newPage();
    await page.route("**/*", (route) => route.request().url().startsWith("http://127.0.0.1:" + port) ? route.continue() : route.abort());
    await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('article[data-post="p00"] button[data-act="menu"]', { timeout: 15000 });
    const scaled = await page.evaluate(() => ({
      zoom: document.documentElement.style.zoom,
      inner: window.innerWidth,
      guess: window.ViktorychDesktop && window.ViktorychDesktop.windowGuess ? window.ViktorychDesktop.windowGuess() : ""
    }));
    if (scaled.zoom !== "1.5") throw new Error("manual 150 did not scale the page " + JSON.stringify(scaled));
    await page.evaluate(() => document.querySelector('article[data-post="p00"] button[data-act="menu"]').click());
    const hit = await page.evaluate(() => {
      const menu = document.querySelector(".menu.post-menu");
      const btn = document.querySelector('article[data-post="p00"] button[data-act="menu"]');
      if (!menu || !btn) return null;
      const box = menu.getBoundingClientRect();
      const btnBox = btn.getBoundingClientRect();
      return { near: Math.abs(box.top - btnBox.bottom) <= 16 || Math.abs(btnBox.top - box.bottom) <= 16 };
    });
    if (!hit || !hit.near) throw new Error("scaled menu left its button " + JSON.stringify(hit));
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("viktorych-desktop-v1") || "{}");
      raw.scale.mode = "off";
      localStorage.setItem("viktorych-desktop-v1", JSON.stringify(raw));
      window.ViktorychDesktop.applyScale();
    });
    const off = await page.evaluate(() => document.documentElement.style.zoom || "");
    if (off) throw new Error("off still scales " + off);
    await context.close();
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", hasTouch: true });
    await phone.addInitScript(() => {
      localStorage.setItem("superintelapp-lang", "en");
      localStorage.setItem("viktorychapp-lang-user-picked", "1");
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorych-desktop-v1", JSON.stringify({ scale: { mode: "window", manual: 100, maximized: 150, windowed: 120 } }));
    });
    const narrow = await phone.newPage();
    await narrow.route("**/*", (route) => route.request().url().startsWith("http://127.0.0.1:" + port) ? route.continue() : route.abort());
    await narrow.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
    await narrow.waitForTimeout(300);
    const phoneZoom = await narrow.evaluate(() => document.documentElement.style.zoom || "");
    if (phoneZoom) throw new Error("phone was scaled " + phoneZoom);
    await phone.close();
    console.log("app scale browser ok " + JSON.stringify(scaled));
  } finally {
    await browser.close();
    server.close();
  }
}

test("browser: manual size, menu anchor, and a phone stays unscaled", { skip: process.env.APP_SCALE_BROWSER !== "1" }, browserScale);
