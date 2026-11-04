/* In-app post authors show the picture the server lets this viewer see (a
   /v1/media/view URL), plus the lock and official badge from their profile, on
   the card and on the post page. Placeholders only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const widths = [
  { width: 390, height: 844, name: "phone" },
  { width: 1280, height: 800, name: "desktop" }
];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

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

const VIEW = "/v1/media/view/" + "a".repeat(32);
const LOCKED = { id: "c".repeat(32), body: "Locked official author", createdAt: Date.now() - 60000, authorId: "100000000002", authorName: "User B", authorHandle: "user_b", authorAvatar: VIEW, authorLocked: true, authorOfficial: true, media: [] };
const PLAIN = { id: "e".repeat(32), body: "Plain author", createdAt: Date.now() - 120000, authorId: "100000000003", authorName: "User C", authorHandle: "user_c", authorAvatar: "", authorLocked: false, authorOfficial: false, media: [] };

async function marks(page, id) {
  return page.evaluate((pid) => {
    const card = document.querySelector('article.post[data-post="' + pid + '"]');
    if (!card) return null;
    const img = card.querySelector("img.ava");
    return {
      lock: !!card.querySelector(".protected-badge svg"),
      official: !!card.querySelector(".vbadge.exclusive"),
      img: img ? img.getAttribute("src") || "" : "",
      loaded: img ? img.complete && img.naturalWidth > 0 : false
    };
  }, id);
}

async function run(browser, vp, origin) {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: vp.width, height: vp.height } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error(vp.name + " page error: " + (err && err.message)));
  await page.addInitScript(() => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "local-test-token",
      account: { publicId: "100000000001", handle: "user_a", displayName: "User A", avatar: "" }
    }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
  });
  LOCKED.authorAvatar = origin + VIEW;
  await page.route("**/v1/**", async (route) => {
    const where = new URL(route.request().url()).pathname;
    if (where === VIEW) { await route.fulfill({ status: 200, contentType: "image/png", body: PNG }); return; }
    if (where === "/v1/posts") { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ posts: [LOCKED, PLAIN], communitiesHome: true }) }); return; }
    if (where.indexOf("/v1/posts/") === 0) { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ post: LOCKED, replies: [] }) }); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[],"ok":true}' });
  });
  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction((id) => !!document.querySelector('article.post[data-post="' + id + '"]'), LOCKED.id, { timeout: 20000 })
    .catch(() => fail(vp.name + " the in-app post did not render"));
  await page.waitForFunction((id) => { const img = document.querySelector('article.post[data-post="' + id + '"] img.ava'); return img && img.complete && img.naturalWidth > 0; }, LOCKED.id, { timeout: 8000 }).catch(() => {});
  const a = await marks(page, LOCKED.id);
  if (!a.lock) fail(vp.name + " locked author has no lock on the card");
  if (!a.official) fail(vp.name + " official author has no badge on the card");
  if (a.img.indexOf(VIEW) < 0 || !a.loaded) fail(vp.name + " the author picture did not load: " + a.img);
  const b = await marks(page, PLAIN.id);
  if (b.lock || b.official) fail(vp.name + " a plain author shows a lock or badge");
  if (process.env.SHOTS) {
    fs.mkdirSync(process.env.SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.SHOTS, vp.name + "-home.png") });
  }
  await context.close();
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    for (const vp of widths) await run(browser, vp, origin);
    console.log("post author marks ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message ? err.message : err);
});
