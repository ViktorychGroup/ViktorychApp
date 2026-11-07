/* A like or bookmark must not rebuild the page. A photo on a new post
   stays on the local preview, and the upload still carries the original bytes.
   Dummy accounts only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ME = "100000000001";
const NEW_ID = "ab".repeat(16);
const posts = [];
const feeds = [];
for (let i = 0; i < 12; i++) {
  const id = "p" + String(i).padStart(2, "0");
  feeds.push({ id: "lane" + i, platform: "rss", handle: "lane" + i, name: "Lane " + i });
  posts.push({
    id, statusId: id, platform: "rss", feedId: "lane" + i, kind: "post",
    date: new Date(Date.now() - i * 3600000).toISOString(),
    text: "Fixture line " + i, author: "Lane " + i, handle: "lane" + i, media: [],
    stats: { replies: 0, reposts: 0, likes: 2, views: 1 }
  });
}
const catalog = JSON.stringify({ updated: "2026-11-07T00:00:00.000Z", feeds, posts });

function fail(message) { console.error(message); process.exitCode = 1; throw new Error(message); }
function mime(file) {
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".html")) return "text/html";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
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

async function likeBurst(page, label) {
  await page.waitForSelector('button[data-act="like"]', { timeout: 20000 });
  await page.waitForTimeout(500);
  const samples = [];
  for (let i = 0; i < 4; i++) {
    const row = await page.evaluate(() => {
      const btn = document.querySelector('button[data-act="like"]');
      const app = document.getElementById("app");
      let mutations = 0;
      const mo = new MutationObserver(() => { mutations += 1; });
      mo.observe(app, { childList: true });
      btn.click();
      return new Promise((resolve) => {
        setTimeout(() => {
          mo.disconnect();
          const live = document.querySelector('button[data-act="like"]');
          const count = live && live.querySelector(".count");
          resolve({ mutations, same: live === btn, on: !!(live && live.classList.contains("on")), count: count ? count.textContent : "" });
        }, 80);
      });
    });
    samples.push(row);
    if (row.mutations !== 0) fail(label + " like rebuilt the page " + JSON.stringify(row));
  }
  if (!samples[0].on || samples[0].count !== "3") fail(label + " like did not count " + JSON.stringify(samples[0]));
  if (samples[1].on || samples[1].count !== "2") fail(label + " unlike did not restore the count " + JSON.stringify(samples[1]));
  if (samples[3].on || samples[3].count !== "2") fail(label + " a burst of likes ended on " + JSON.stringify(samples));
  const bookmark = await page.evaluate(() => {
    const btn = document.querySelector('button[data-act="bookmark"]');
    const app = document.getElementById("app");
    let mutations = 0;
    const mo = new MutationObserver(() => { mutations += 1; });
    mo.observe(app, { childList: true });
    btn.click();
    return new Promise((resolve) => {
      setTimeout(() => {
        mo.disconnect();
        const live = document.querySelector('button[data-act="bookmark"]');
        resolve({ mutations, on: !!(live && live.classList.contains("on")) });
      }, 80);
    });
  });
  if (bookmark.mutations !== 0 || !bookmark.on) fail(label + " bookmark rebuilt or missed " + JSON.stringify(bookmark));
}

async function photo(page, label) {
  const pngPath = "/tmp/action-speed-pixel.png";
  fs.writeFileSync(pngPath, PNG);
  const seen = [];
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.indexOf("/v1/posts/media/") === 0) seen.push(url.pathname);
    if (url.pathname === "/v1/posts" && req.method() === "POST") {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          post: {
            id: NEW_ID, body: "Photo note", createdAt: Date.now(), authorId: ME,
            authorHandle: "user_a", authorName: "User A",
            media: [{ id: "cd".repeat(16), mime: "image/png", url: "/v1/posts/media/" + "cd".repeat(16), alt: "" }]
          }
        })
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[],"ok":true}' });
  });
  const opener = label === "phone" ? "button.fab" : "button.post-btn";
  await page.locator(opener).first().click();
  await page.locator(".xc-modal #compose-text").fill("Photo note");
  await page.locator('.xc-modal input.xc-file[data-kind="image"]').first().setInputFiles(pngPath);
  await page.locator(".xc-modal #compose-post").click();
  await page.waitForFunction((id) => {
    const card = document.querySelector('article[data-post="' + id + '"] img[data-local-preview]');
    return card && String(card.getAttribute("src") || "").indexOf("blob:") === 0;
  }, NEW_ID, { timeout: 8000 });
  await page.waitForTimeout(200);
  if (seen.length) fail(label + " refetched the saved photo " + seen.join(" "));
}

async function main() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    for (const size of [{ name: "phone", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 800 }]) {
      const context = await browser.newContext({ viewport: size, serviceWorkers: "block" });
      const page = await context.newPage();
      page.on("pageerror", (err) => fail(size.name + " " + err.message));
      await page.addInitScript(() => {
        localStorage.setItem("superintelapp-lang", "en");
        localStorage.setItem("viktorychapp-lang-user-picked", "1");
        localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
        const follows = [];
        for (let i = 0; i < 12; i++) follows.push("lane" + i);
        localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, follows, lists: [], feedTabs: [], likes: {}, bookmarks: {}, reposts: {} }));
      });
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("http://127.0.0.1:" + port)) return route.continue();
        return route.abort();
      });
      await page.goto("http://127.0.0.1:" + port + "/index.html#/following", { waitUntil: "domcontentloaded" });
      await likeBurst(page, size.name);
      await context.close();
      const signed = await browser.newContext({ viewport: size, serviceWorkers: "block" });
      const composer = await signed.newPage();
      composer.on("pageerror", (err) => fail(size.name + " " + err.message));
      await composer.addInitScript((me) => {
        localStorage.setItem("superintelapp-lang", "en");
        localStorage.setItem("viktorychapp-lang-user-picked", "1");
        localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
        localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
          token: "local-test-token",
          account: { publicId: me, handle: "user_a", displayName: "User A", avatar: "" }
        }));
        window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
      }, ME);
      await composer.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("http://127.0.0.1:" + port)) return route.continue();
        return route.abort();
      });
      await composer.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
      await photo(composer, size.name);
      await signed.close();
    }
    console.log("action speed ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
