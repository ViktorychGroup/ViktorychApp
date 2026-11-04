/* The post ring (article.post.kb-focus) is a keyboard aid. A tap, a touch
   scroll or a mouse click never paints it, also after the page redraws or a
   post page opens. j still moves it for real keyboard use. Demo data only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.env.SHOTS || "";
let failures = 0;
function fail(message) { console.error("FAIL " + message); failures += 1; process.exitCode = 1; }

function mime(file) {
  if (/\.m?js$/.test(file)) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

const now = Date.now();
const ID = "910000000000000201";
const ME = "100000000001";
const ID2 = "910000000000000202";
const FIXTURE = {
  updated: new Date(now).toISOString(),
  feeds: [{ id: "x:fake_tech", platform: "x", handle: "fake_tech", name: "Fake Tech", title: "Fake Tech", avatar: "", url: "https://x.com/fake_tech", configured: true }],
  posts: [{
    id: ID, statusId: ID, platform: "x", feedId: "x:fake_tech", kind: "post", author: "Fake Tech", handle: "fake_tech", avatar: "",
    text: "La serie Nova está probando la batería de 8000 mAh (fake)", lang: "es", links: [], date: new Date(now - 3600e3).toISOString(),
    url: "https://x.com/fake_tech/status/" + ID, media: [], images: [], repostedBy: null, replyingTo: null, quoted: null,
    stats: { replies: 0, reposts: 0, likes: 0, views: 30 }
  }, {
    id: ID2, statusId: ID2, platform: "x", feedId: "x:fake_tech", kind: "post", author: "Fake Tech", handle: "fake_tech", avatar: "",
    text: "Second demo post (fake)", lang: "en", links: [], date: new Date(now - 7200e3).toISOString(),
    url: "https://x.com/fake_tech/status/" + ID2, media: [], images: [], repostedBy: null, replyingTo: null, quoted: null,
    stats: { replies: 0, reposts: 0, likes: 0, views: 12 }
  }]
};

async function loadChromium() {
  const core = process.env.PLAYWRIGHT_CORE || "/workspace/pwcore/node_modules/playwright-core";
  const entry = /\.m?js$/.test(core) ? core : path.join(core, "index.mjs");
  try {
    const mod = await import(core.startsWith("/") ? pathToFileURL(entry).href : core);
    return mod.chromium || (mod.default && mod.default.chromium);
  } catch (err) { return null; }
}

function startServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel.endsWith("/")) rel += "index.html";
    if (/\/feeds\.json$/.test(rel)) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(FIXTURE));
    }
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

async function run(chromium, port, vp) {
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || "chrome" });
  try {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: vp.mobile ? 2 : 1, serviceWorkers: "block" });
    await ctx.route(/^https?:\/\//, (route) => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    const page = await ctx.newPage();
    page.on("pageerror", (err) => fail(`${vp.name}: page error ${String(err && err.message).slice(0, 160)}`));
    await page.addInitScript((me) => {
      try {
        localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
        localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token", account: { publicId: me, handle: "user_a", displayName: "User A", avatar: "" } }));
      } catch (err) {}
      window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true };
    }, ME);
    await page.route("**/v1/**", (route) => {
      const url = new URL(route.request().url());
      if (/\/v1\/data|feeds/.test(url.pathname)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE) });
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[],"reposts":[],"ok":true}' });
    });
    const settle = (ms) => page.waitForTimeout(ms || 400);
    const rings = () => page.evaluate(() => [...document.querySelectorAll("article.post.kb-focus")].length);
    const outlined = () => page.evaluate(() => [...document.querySelectorAll("article")].filter((a) => { const s = getComputedStyle(a); return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0; }).length);
    const redraw = () => page.evaluate(() => { const d = document.createElement("div"); document.body.appendChild(d); d.remove(); window.dispatchEvent(new Event("resize")); });

    await page.goto(origin + "/#/home");
    await page.waitForSelector(`#app article[data-post="${ID}"]`, { timeout: 25000 });
    await settle(600);

    if (vp.mobile) {
      // Tap Like on a card: the page redraws and that card must not get the ring.
      await page.locator(`#app article[data-post="${ID}"] [data-act="like"]`).first().tap();
      await settle(500);
      await redraw(); await settle(300);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${vp.name}-after-like.png`), clip: { x: 0, y: 0, width: vp.width, height: 560 } });
      if (await rings()) fail(`${vp.name}: tapping Like left the keyboard ring on that post`);
      if (await outlined()) fail(`${vp.name}: a post shows an outline after tapping Like`);
      // Tap a post: it opens, and nothing on the post page gets the ring.
      await page.locator(`#app article[data-post="${ID}"] .post-text`).first().tap();
      await settle(900);
      await redraw(); await settle(300);
      if (await rings()) fail(`${vp.name}: a tap left the keyboard ring on a post`);
      if (await outlined()) fail(`${vp.name}: a post shows an outline after a tap`);
      await page.goBack(); await settle(900);
      await page.mouse.wheel(0, 400).catch(() => {});
      await page.touchscreen.tap(5, Math.round(vp.height * 0.6)); await settle(300);
      await redraw(); await settle(300);
      if (await rings()) fail(`${vp.name}: the ring came back after going back and scrolling`);
      if (await outlined()) fail(`${vp.name}: a post shows an outline while scrolling`);
    } else {
      await page.locator("main.center").first().click({ position: { x: 4, y: 300 } }).catch(() => {});
      await page.keyboard.press("j"); await settle();
      if ((await rings()) !== 1) fail(`${vp.name}: j does not put the ring on a post`);
      await page.mouse.click(Math.round(vp.width / 2), Math.round(vp.height - 20)); await settle(300);
      await redraw(); await settle(300);
      if (await rings()) fail(`${vp.name}: a mouse click left the ring on (or a redraw put it back)`);
      await page.keyboard.press("j"); await settle();
      if ((await rings()) !== 1) fail(`${vp.name}: j does not bring the ring back after a click`);
    }
    console.log(`${vp.name}: post ring ok`);
  } finally {
    await browser.close();
  }
}

const chromium = await loadChromium();
if (!chromium) {
  console.log("post ring test skipped: Playwright is not installed");
} else {
  const server = await startServer();
  const port = server.address().port;
  try {
    for (const vp of [{ name: "phone", width: 412, height: 900, mobile: true }, { name: "desktop", width: 1280, height: 900, mobile: false }]) {
      await run(chromium, port, vp);
    }
  } finally {
    server.close();
  }
  if (failures) process.exit(1);
}
