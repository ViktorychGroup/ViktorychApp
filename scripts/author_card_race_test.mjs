/* A channel card can arrive while the Sending card still has a temp id.
   It must replace that card, and the save response must not add a second one.
   A different post and a failed save stay one card or none. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ME = "100000000001";
const OTHER = { id: "d".repeat(32), body: "Someone else", createdAt: Date.now() - 180000, authorId: "100000000004", authorName: "User D", authorHandle: "user_d", media: [] };
const SERVER = "a".repeat(32);
const ELSEWHERE = "e".repeat(32);

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
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}

function note(id, body) {
  return {
    op: "event",
    topic: "posts",
    data: {
      post: {
        id: id,
        body: body,
        parentId: "",
        createdAt: Date.now(),
        authorId: ME,
        authorHandle: "user_a",
        authorName: "User A",
        media: []
      }
    }
  };
}

async function idsFor(page, text) {
  return page.evaluate((needle) => Array.from(document.querySelectorAll("article.post")).filter((el) => (el.textContent || "").indexOf(needle) >= 0).map((el) => el.getAttribute("data-post")), text);
}

async function deliver(page, msg) {
  await page.evaluate((payload) => {
    const sock = window.__sock;
    if (!sock) throw new Error("no socket");
    const event = { data: JSON.stringify(payload) };
    (sock.listeners.message || []).forEach((fn) => fn(event));
  }, msg);
}

async function open(browser, origin, posts) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const gate = posts;
  page.on("pageerror", (err) => console.error("page error: " + (err && err.message)));
  await page.addInitScript(() => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "local-test-token",
      account: { publicId: "100000000001", handle: "user_a", displayName: "User A", avatar: "" }
    }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
    function FakeSocket() {
      window.__sock = this;
      this.readyState = 0;
      this.listeners = {};
      const self = this;
      setTimeout(function () {
        self.readyState = 1;
        (self.listeners.open || []).forEach(function (fn) { fn(); });
      }, 0);
    }
    FakeSocket.prototype.addEventListener = function (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); };
    FakeSocket.prototype.send = function () {};
    FakeSocket.prototype.close = function () { this.readyState = 3; };
    FakeSocket.CONNECTING = 0;
    FakeSocket.OPEN = 1;
    FakeSocket.CLOSING = 2;
    FakeSocket.CLOSED = 3;
    window.WebSocket = FakeSocket;
  });
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === "/v1/channel/ticket") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "ticket.test" }) });
      return;
    }
    if (url.pathname === "/v1/posts" && req.method() === "POST") {
      gate.posts += 1;
      if (gate.hold) await new Promise((resolve) => { gate.release = resolve; });
      if (gate.fail) {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "failed" }) });
        return;
      }
      let body = {};
      try { body = req.postDataJSON() || {}; } catch (err) { body = {}; }
      const post = { id: gate.id, body: body.body || "", createdAt: Date.now(), authorId: ME, authorHandle: "user_a", authorName: "User A", media: [] };
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ post: post }) });
      return;
    }
    if (url.pathname === "/v1/posts" && req.method() === "GET") {
      gate.gets += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ posts: [OTHER], communitiesHome: true }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"posts":[]}' });
  });
  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__sock && window.__sock.readyState === 1, null, { timeout: 20000 });
  await page.waitForSelector("article.post", { timeout: 20000 });
  return { context: context, page: page };
}

async function compose(page, text) {
  await page.locator("button.post-btn").first().click();
  await page.locator(".xc-modal #compose-text").fill(text);
  await page.locator(".xc-modal #compose-post").click();
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const saved = { hold: true, fail: false, id: SERVER, release: null, gets: 0, posts: 0 };
    const first = await open(browser, origin, saved);
    await compose(first.page, "Race post");
    await first.page.waitForFunction(() => {
      const nodes = Array.from(document.querySelectorAll("article.post")).filter((el) => (el.textContent || "").indexOf("Race post") >= 0);
      return nodes.length === 1 && String(nodes[0].getAttribute("data-post") || "").indexOf("tmp-") === 0;
    }, null, { timeout: 15000 }).catch(() => fail("the Sending card was not the only Race post"));
    await deliver(first.page, note(ELSEWHERE, "Other phone"));
    const elsewhere = await idsFor(first.page, "Other phone");
    const stillSending = await idsFor(first.page, "Race post");
    if (elsewhere.length !== 1 || elsewhere[0] !== ELSEWHERE) fail("a different id was not applied: " + elsewhere.join(","));
    if (stillSending.length !== 1 || String(stillSending[0]).indexOf("tmp-") !== 0) fail("the other post replaced the Sending card: " + stillSending.join(","));
    await deliver(first.page, note(SERVER, "Race post"));
    const bound = await idsFor(first.page, "Race post");
    if (bound.length !== 1 || bound[0] !== SERVER) fail("the early card did not replace the Sending card: " + bound.join(","));
    if ((await idsFor(first.page, "Other phone")).join(",") !== ELSEWHERE) fail("the other post disappeared when this send was bound");
    const untilHeld = Date.now() + 5000;
    while (!saved.release && Date.now() < untilHeld) await new Promise((resolve) => setTimeout(resolve, 20));
    if (!saved.release) fail("the save request did not start");
    const gets = saved.gets;
    saved.hold = false;
    saved.release();
    await first.page.waitForFunction((id) => {
      const nodes = Array.from(document.querySelectorAll("article.post")).filter((el) => (el.textContent || "").indexOf("Race post") >= 0);
      return nodes.length === 1 && nodes[0].getAttribute("data-post") === id && !document.querySelector('article.post[data-post^="tmp-"]');
    }, SERVER, { timeout: 15000 }).catch(() => fail("the save response left more than one Race post"));
    await deliver(first.page, { op: "event", topic: "posts", data: { id: SERVER, at: Date.now() } });
    const untilGets = Date.now() + 15000;
    while (saved.gets <= gets && Date.now() < untilGets) await new Promise((resolve) => setTimeout(resolve, 50));
    if (saved.gets <= gets) fail("a count-only note did not refresh");
    await first.context.close();

    const failed = { hold: true, fail: true, id: "b".repeat(32), release: null, gets: 0, posts: 0 };
    const second = await open(browser, origin, failed);
    await compose(second.page, "Ghost post");
    await second.page.waitForFunction(() => Array.from(document.querySelectorAll("article.post")).some((el) => (el.textContent || "").indexOf("Ghost post") >= 0 && String(el.getAttribute("data-post") || "").indexOf("tmp-") === 0), null, { timeout: 15000 });
    await deliver(second.page, note(failed.id, "Ghost post"));
    const early = await idsFor(second.page, "Ghost post");
    if (early.length !== 1 || early[0] !== failed.id) fail("the failed send's early card was not bound: " + early.join(","));
    const untilFail = Date.now() + 5000;
    while (!failed.release && Date.now() < untilFail) await new Promise((resolve) => setTimeout(resolve, 20));
    if (!failed.release) fail("the failed save request did not start");
    failed.hold = false;
    failed.release();
    await second.page.waitForFunction(() => !Array.from(document.querySelectorAll("article.post")).some((el) => (el.textContent || "").indexOf("Ghost post") >= 0), null, { timeout: 15000 })
      .catch(() => fail("a failed send left a ghost card"));
    await second.context.close();
    console.log("author card race ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
