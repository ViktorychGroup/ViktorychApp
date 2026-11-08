/* An assigned source list shows for that account without waiting for the
   scheduler. Cached posts paint first. Another account does not see them.
   A failed list can be retried. Fixture accounts only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIST = "sa1b2c3d4";
const TOKEN_A = "local-test-token-a";

function shardFor(text) {
  const doc = {
    v: 1,
    feeds: [{ id: "rss:lane.example", platform: "rss", handle: "lane", name: "Lane", sourceList: true, configured: true }],
    posts: [{ id: "lane-post", statusId: "lane-post", platform: "rss", feedId: "rss:lane.example", kind: "post", author: "Lane", handle: "lane", text, date: "2026-11-08T12:00:00.000Z", sourceList: true }]
  };
  const body = JSON.stringify(doc);
  return { body, hash: createHash("sha256").update(body).digest("hex") };
}
const cached = shardFor("Cached lane post");
const fetched = shardFor("Fetched lane post");

let mode = "cached";
let releaseLists = null;
let listsHeld = null;
let listCalls = 0;

function mime(file) {
  if (/\.m?js$/.test(file)) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function startServer() {
  const catalog = JSON.stringify({
    updated: "2026-11-08T12:00:00.000Z",
    feeds: [{ id: "rss:base.example", platform: "rss", handle: "base", name: "Base" }],
    posts: [{ id: "base1", statusId: "base1", platform: "rss", feedId: "rss:base.example", kind: "post", author: "Base", handle: "base", text: "Base fixture line", date: "2026-11-08T11:00:00.000Z" }]
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const token = String(req.headers.authorization || "");
    const send = (code, body, type) => {
      res.writeHead(code, { "content-type": type || "application/json", "cache-control": "no-store" });
      res.end(body);
    };
    if (url.pathname.endsWith("/feeds.json") || url.pathname === "/v1/data/feeds.json") return send(200, catalog);
    if (url.pathname === "/v1/me/source-lists") {
      listCalls += 1;
      const answer = () => {
        if (!token.includes(TOKEN_A)) return send(200, JSON.stringify({ lists: [] }));
        if (mode === "error" && listCalls === 1) return send(200, JSON.stringify({ lists: [{ id: LIST, name: "Lane list", hash: "", count: 0, status: "error" }] }));
        if (mode === "error") return send(200, JSON.stringify({ lists: [{ id: LIST, name: "Lane list", hash: fetched.hash, size: fetched.body.length, at: 2, count: 1, status: "ready" }] }));
        const row = mode === "cached"
          ? { id: LIST, name: "Lane list", hash: cached.hash, size: cached.body.length, at: 1, count: 1, status: "ready" }
          : { id: LIST, name: "Lane list", hash: fetched.hash, size: fetched.body.length, at: 2, count: 1, status: "ready" };
        return send(200, JSON.stringify({ lists: [row] }));
      };
      if (listsHeld) return listsHeld.then(answer);
      return answer();
    }
    if (url.pathname.startsWith("/v1/me/source-lists/shard/")) {
      if (!token.includes(TOKEN_A)) return send(404, JSON.stringify({ error: "not_found" }));
      const hash = url.pathname.split("/").pop();
      if (hash === cached.hash) return send(200, cached.body);
      if (hash === fetched.hash) return send(200, fetched.body);
      return send(404, JSON.stringify({ error: "not_found" }));
    }
    if (url.pathname.startsWith("/v1/")) return send(200, '{"ok":true,"posts":[]}');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) return send(403, "");
    fs.readFile(file, (err, data) => {
      if (err) return send(404, "");
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
    } catch (err) { /* next */ }
  }
  return null;
}

function fail(message) { console.error("FAIL " + message); process.exitCode = 1; throw new Error(message); }

async function open(browser, port, vp, boot, arg) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.mobile, hasTouch: !!vp.mobile, serviceWorkers: "block" });
  if (boot) await ctx.addInitScript(boot, arg);
  const page = await ctx.newPage();
  return { ctx, page };
}

async function run(chromium, port) {
  const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || "chrome", args: ["--no-sandbox"] });
  try {
    mode = "cached";
    listCalls = 0;
    const desk = await open(browser, port, { width: 1280, height: 800 }, (pack) => {
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token-a", account: { publicId: "100000000001", handle: "user_a", displayName: "User A", avatar: "" } }));
      localStorage.setItem("viktorychapp-private-list-meta-v1:100000000001", JSON.stringify({ lists: [{ id: "sa1b2c3d4", name: "Lane list", hash: pack.hash, size: pack.body.length, at: 1, count: 1, status: "ready" }], checkedAt: Date.now(), account: "100000000001" }));
      localStorage.setItem("viktorychapp-private-list-doc:100000000001:sa1b2c3d4", JSON.stringify({ hash: pack.hash, account: "100000000001", doc: JSON.parse(pack.body) }));
      window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
    }, { hash: cached.hash, body: cached.body });
    const started = Date.now();
    await desk.page.goto("http://127.0.0.1:" + port + "/#/", { waitUntil: "domcontentloaded" });
    await desk.page.waitForSelector("text=Cached lane post", { timeout: 8000 });
    const cachedMs = Date.now() - started;
    if (cachedMs > 8000) fail("cached post was slow " + cachedMs);
    console.log("desktop cached post visible in " + cachedMs + "ms");
    await desk.ctx.close();

    mode = "fetch";
    listCalls = 0;
    const phone = await open(browser, port, { width: 390, height: 844, mobile: true }, () => {
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token-a", account: { publicId: "100000000001", handle: "user_a", displayName: "User A", avatar: "" } }));
      window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
    });
    const fetchStart = Date.now();
    await phone.page.goto("http://127.0.0.1:" + port + "/#/", { waitUntil: "domcontentloaded" });
    await phone.page.waitForSelector("text=Fetched lane post", { timeout: 8000 });
    console.log("phone fetched post visible in " + (Date.now() - fetchStart) + "ms");
    await phone.ctx.close();

    const other = await open(browser, port, { width: 1280, height: 800 }, () => {
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token-b", account: { publicId: "100000000002", handle: "user_b", displayName: "User B", avatar: "" } }));
      window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
    });
    await other.page.goto("http://127.0.0.1:" + port + "/#/", { waitUntil: "domcontentloaded" });
    await other.page.waitForSelector("text=Base fixture line", { timeout: 8000 });
    const leaked = await other.page.locator("text=Fetched lane post").count();
    const leakedCached = await other.page.locator("text=Cached lane post").count();
    if (leaked || leakedCached) fail("another account saw the assigned posts");
    await other.ctx.close();

    mode = "error";
    listCalls = 0;
    const retry = await open(browser, port, { width: 1280, height: 800 }, () => {
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token-a", account: { publicId: "100000000001", handle: "user_a", displayName: "User A", avatar: "" } }));
      window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
    });
    await retry.page.goto("http://127.0.0.1:" + port + "/#/feeds/lists", { waitUntil: "domcontentloaded" });
    await retry.page.waitForSelector("text=Something went wrong. Try again.", { timeout: 8000 });
    const waiting = await retry.page.locator("text=Waiting for the next refresh").count();
    if (waiting) fail("a failed list still says it is waiting for the scheduler");
    await retry.page.locator("[data-sl-act=retry-lists]").click();
    await retry.page.waitForSelector("text=In your timeline", { timeout: 8000 });
    await retry.ctx.close();

    mode = "fetch";
    listCalls = 0;
    listsHeld = new Promise((resolve) => { releaseLists = resolve; });
    const late = await open(browser, port, { width: 1280, height: 800 }, () => {
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token-a", account: { publicId: "100000000001", handle: "user_a", displayName: "User A", avatar: "" } }));
      window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
    });
    await late.page.goto("http://127.0.0.1:" + port + "/#/", { waitUntil: "domcontentloaded" });
    await late.page.waitForSelector("text=Base fixture line", { timeout: 8000 });
    await late.page.evaluate(() => {
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token-b", account: { publicId: "100000000002", handle: "user_b", displayName: "User B", avatar: "" } }));
    });
    releaseLists();
    await late.page.waitForTimeout(1500);
    if (await late.page.locator("text=Fetched lane post").count()) fail("a late list for the previous account was shown");
    await late.ctx.close();
    console.log("source list assign ui ok");
  } finally {
    await browser.close();
  }
}

const chromium = await loadChromium();
if (!chromium) { console.log("skip source list assign ui (no playwright)"); process.exit(0); }
const server = await startServer();
try {
  await run(chromium, server.address().port);
} finally {
  server.close();
}
if (!process.exitCode) console.log("source list assign ok");
