/* Scrollbars stay hidden. The page, the tab strip, and a menu that is taller
   than its box still move. Fixture only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posts = [];
const feeds = [];
for (let i = 0; i < 16; i++) {
  const id = "p" + String(i).padStart(2, "0");
  feeds.push({ id: "lane" + i, platform: "rss", handle: "lane" + i, name: "Lane " + i });
  posts.push({
    id, statusId: id, platform: "rss", feedId: "lane" + i, kind: "post",
    date: new Date(Date.now() - i * 3600000).toISOString(),
    text: "Fixture line " + i + " for scrolling.",
    author: "Lane " + i, handle: "lane" + i, media: [],
    stats: { replies: 0, reposts: 0, likes: 1, views: 1 }
  });
}
const catalog = JSON.stringify({ updated: "2026-11-08T00:00:00.000Z", feeds, posts });

function mime(file) {
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".html")) return "text/html";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json";
  return "text/javascript";
}
function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/feeds.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(catalog);
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": mime(file) + "; charset=utf-8", "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function run(browser, port, width, height, name) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block", hasTouch: width < 500 });
  await context.addInitScript(() => {
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
  });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.request().url().startsWith("http://127.0.0.1:" + port) ? route.continue() : route.abort());
  await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".tab-arrow").length >= 2, null, { timeout: 15000 });
  await page.waitForSelector("article.post", { timeout: 15000 });
  const bars = await page.evaluate(() => {
    const html = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const nav = document.querySelector(".nav-scroll");
    const navCss = nav ? getComputedStyle(nav) : null;
    return {
      htmlOverflow: html.overflowY,
      bodyOverflow: body.overflowY,
      htmlBar: html.scrollbarWidth,
      navBar: navCss ? navCss.scrollbarWidth : "",
      navOverflow: navCss ? navCss.overflowY : "",
      arrows: document.querySelectorAll(".tab-arrow").length
    };
  });
  if (bars.htmlOverflow === "hidden" || bars.bodyOverflow === "hidden") throw new Error(name + " page scrolling turned off " + JSON.stringify(bars));
  if (bars.htmlBar !== "none" || (bars.navBar && bars.navBar !== "none")) throw new Error(name + " a bar is still shown " + JSON.stringify(bars));
  if (bars.arrows < 2) throw new Error(name + " tab arrows removed " + bars.arrows);
  const before = await page.evaluate(() => window.scrollY);
  await page.mouse.move(width / 2, height / 2);
  await page.mouse.wheel(0, 500);
  await page.waitForFunction((y) => window.scrollY > y + 20, before, { timeout: 4000 });
  const wheeled = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => {
    const posts = document.querySelectorAll("article.post");
    posts[Math.min(8, posts.length - 1)].scrollIntoView({ block: "start" });
  });
  await page.waitForFunction((y) => window.scrollY > y + 40, wheeled, { timeout: 4000 });
  const keyed = await page.evaluate(() => window.scrollY);
  await page.keyboard.press("j");
  await page.waitForFunction((y) => window.scrollY !== y || document.querySelector("article.post.kb-focus"), keyed, { timeout: 4000 });
  if (width >= 1000) {
    await page.evaluate(() => {
      const scroller = document.querySelector(".tabs");
      const extra = document.createElement("button");
      extra.className = "tab";
      extra.type = "button";
      extra.style.minWidth = "2400px";
      extra.textContent = "Extra";
      scroller.appendChild(extra);
      const right = document.querySelector(".tab-arrow.right");
      right.hidden = false;
      right.click();
    });
    await page.waitForFunction(() => document.querySelector(".tabs").scrollLeft > 20, null, { timeout: 4000 });
    await page.locator('article[data-post="p02"] button[data-act="menu"]').click();
    await page.waitForSelector(".menu.post-menu");
    await page.evaluate(() => {
      const menu = document.querySelector(".menu.post-menu");
      menu.style.maxHeight = "120px";
    });
    const menuBar = await page.evaluate(() => {
      const menu = document.querySelector(".menu.post-menu");
      const css = getComputedStyle(menu);
      return { overflow: css.overflowY, bar: css.scrollbarWidth, top: menu.scrollTop };
    });
    if (menuBar.overflow === "hidden" || menuBar.bar !== "none") throw new Error(name + " menu " + JSON.stringify(menuBar));
    await page.locator(".menu.post-menu").hover();
    await page.mouse.wheel(0, 200);
    await page.waitForFunction(() => document.querySelector(".menu.post-menu").scrollTop > 10, null, { timeout: 4000 });
  }
  await context.close();
}

async function main() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    await run(browser, port, 1280, 800, "desktop");
    await run(browser, port, 390, 844, "phone");
    console.log("scrollbar hidden ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
