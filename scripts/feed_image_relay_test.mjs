/* A failed srcset candidate must not delete a picture the relay already
   returned. A relay that also refuses still ends as the picture placeholder.
   An Instagram file that refuses still paints through the public media
   redirect. Fixture hosts only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const now = Date.now();
let failures = 0;
function fail(message) { console.error("FAIL " + message); failures += 1; process.exitCode = 1; }

function post(id, platform, text, media, url) {
  return {
    id, statusId: id, platform, feedId: platform + ":lane1", kind: "post",
    author: "Lane One", handle: "lane1", text, lang: "en",
    url: url || "", date: new Date(now).toISOString(),
    media, stats: { replies: 0, reposts: 0, likes: 1, views: 2 }
  };
}

const FIXTURE = {
  updated: new Date(now).toISOString(),
  feeds: [
    { id: "x:lane1", platform: "x", handle: "lane1", name: "Lane One" },
    { id: "instagram:lane1", platform: "instagram", handle: "lane1", name: "Lane One" }
  ],
  posts: [
    post("good1", "x", "Direct picture", [{ type: "photo", url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", width: 480, height: 360 }]),
    post("srcset1", "x", "Srcset picture", [{ type: "photo", url: "https://pbs.twimg.com/media/fixture.jpg?name=large", width: 1200, height: 800 }]),
    post("dead1", "x", "Dead picture", [{ type: "photo", url: "https://pbs.twimg.com/media/dead.jpg?name=large", width: 1200, height: 800 }]),
    post("Abcd1234", "instagram", "Cover picture", [{ type: "photo", url: "https://scontent.cdninstagram.com/v/demo.jpg", width: 1080, height: 1350 }], "https://www.instagram.com/p/Abcd1234/")
  ]
};

function mime(file) {
  if (/\.m?js$/.test(file)) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.endsWith("/feeds.json")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(FIXTURE));
    }
    if (url.pathname === "/v1/media") {
      const target = decodeURIComponent(url.searchParams.get("url") || "");
      if (target.indexOf("dead.jpg") >= 0 || target.indexOf("cdninstagram.com") >= 0) {
        res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
        return res.end("no");
      }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      return res.end(PNG);
    }
    if (url.pathname.startsWith("/v1/")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end('{"ok":true,"posts":[]}');
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function loadChromium() {
  const specs = [process.env.PLAYWRIGHT_CORE, "/tmp/pw156/node_modules/playwright-core/index.js", "/tmp/pw/node_modules/playwright-core/index.js"].filter(Boolean);
  for (const spec of specs) {
    try {
      const mod = await import(pathToFileURL(spec).href);
      const chromium = mod.chromium || (mod.default && mod.default.chromium);
      if (chromium) return chromium;
    } catch (err) { /* try the next copy */ }
  }
  return null;
}

async function run(chromium, port, vp) {
  const origin = "http://127.0.0.1:" + port;
  const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || "chrome", args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      deviceScaleFactor: vp.mobile ? 2 : 1,
      serviceWorkers: "block"
    });
    await ctx.route(/^https:\/\/i\.ytimg\.com\//, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    await ctx.route(/^https:\/\/pbs\.twimg\.com\//, (route) => route.fulfill({ status: 403, contentType: "text/plain", body: "no" }));
    await ctx.route(/^https:\/\/scontent\.cdninstagram\.com\//, (route) => route.fulfill({ status: 403, contentType: "text/plain", body: "no" }));
    const page = await ctx.newPage();
    page.on("pageerror", (err) => fail(vp.name + " page error " + String(err && err.message).slice(0, 160)));
    await page.addInitScript(() => {
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token", account: { publicId: "100000000001", handle: "user_a", displayName: "User A" } }));
      window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
    });
    await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('article[data-post="srcset1"]', { timeout: 20000 });
    await page.locator('article[data-post="srcset1"]').scrollIntoViewIfNeeded();
    const painted = await page.waitForFunction(() => {
      function width(id) {
        const img = document.querySelector('article[data-post="' + id + '"] .tile img, article[data-post="' + id + '"] .media img');
        return img ? img.naturalWidth : 0;
      }
      return width("good1") > 0 && width("srcset1") > 0 && width("Abcd1234") > 0;
    }, null, { timeout: 12000 }).then(() => true).catch(() => false);
    const view = await page.evaluate(() => {
      function one(id) {
        const article = document.querySelector('article[data-post="' + id + '"]');
        const img = article && article.querySelector(".tile img, .media img");
        return {
          src: img ? (img.getAttribute("src") || "") : "",
          cur: img ? (img.currentSrc || "").slice(-70) : "",
          set: img ? (img.getAttribute("srcset") ? "1" : "0") : "",
          complete: img ? img.complete : false,
          w: img ? img.naturalWidth : -1,
          broken: article ? !!article.querySelector(".tile.broken, .media-gone") : false,
          empty: article ? [...article.querySelectorAll(".media .tile")].filter((tile) => !tile.querySelector("img,video,iframe,.media-gone")).length : 0
        };
      }
      return { good: one("good1"), srcset: one("srcset1"), dead: one("dead1"), cover: one("Abcd1234") };
    });
    if (!painted) fail(vp.name + " a recoverable picture did not paint " + JSON.stringify(view));
    if (view.srcset && view.srcset.src.indexOf("/v1/media?url=") < 0) fail(vp.name + " the failed srcset picture did not use the relay");
    if (view.srcset && view.srcset.broken) fail(vp.name + " the relay picture was marked broken");
    if (view.cover && view.cover.src.indexOf("instagram.com") < 0) fail(vp.name + " the refused Instagram file did not use the public media redirect");
    const deadOk = await page.waitForFunction(() => {
      const article = document.querySelector('article[data-post="dead1"]');
      if (!article || !article.querySelector(".media-gone")) return false;
      return ![...article.querySelectorAll("img")].some((img) => img.getAttribute("src") && img.complete && img.naturalWidth === 0);
    }, null, { timeout: 10000 }).then(() => true).catch(() => false);
    if (!deadOk) {
      const again = await page.evaluate(() => {
        const article = document.querySelector('article[data-post="dead1"]');
        return article ? article.innerHTML.slice(0, 300) : "";
      });
      fail(vp.name + " a refused relay did not end as the picture placeholder " + again);
    }
    if (view.good && view.good.empty) fail(vp.name + " an empty media frame remained");
    console.log(vp.name + " image relay ok");
  } finally {
    await browser.close();
  }
}

const chromium = await loadChromium();
if (!chromium) { console.log("skip image relay (no playwright)"); process.exit(0); }
const server = await startServer();
try {
  const port = server.address().port;
  await run(chromium, port, { name: "desktop", width: 1280, height: 800, mobile: false });
  await run(chromium, port, { name: "phone", width: 390, height: 844, mobile: true });
} finally {
  server.close();
}
if (!failures) console.log("feed image relay ok");
