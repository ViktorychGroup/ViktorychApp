/* After the channel drops, the next open sends the posts watch again.
   The first open is not enough: the socket close clears the previous watch. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FOLLOW = "200000000002";

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

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
    await context.addInitScript((follow) => {
      localStorage.setItem("viktorychapp-lang-user-picked", "1");
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
        token: "local-test-token",
        account: { publicId: "100000000001", handle: "user_a", displayName: "User A", avatar: "" }
      }));
      localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({
        version: 1, initialized: true, follows: [], accountFollows: ["app:" + follow], lists: [], feedTabs: [], likes: {}, bookmarks: {}, reposts: {}
      }));
      window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
      window.__sent = [];
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
      FakeSocket.prototype.send = function (data) { window.__sent.push(String(data)); };
      FakeSocket.prototype.close = function () {
        this.readyState = 3;
        (this.listeners.close || []).forEach(function (fn) { fn(); });
      };
      FakeSocket.CONNECTING = 0;
      FakeSocket.OPEN = 1;
      FakeSocket.CLOSING = 2;
      FakeSocket.CLOSED = 3;
      window.WebSocket = FakeSocket;
    }, FOLLOW);
    await context.route("**/v1/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname === "/v1/channel/ticket") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "ticket.test" }) });
        return;
      }
      if (url.pathname === "/v1/follows" && req.method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ids: ["app:" + FOLLOW], followingCount: 1, followersCount: 0, outgoingRequests: [] }) });
        return;
      }
      if (url.pathname === "/v1/posts") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ posts: [], communitiesHome: true }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"posts":[]}' });
    });
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error("page error: " + (err && err.message)));
    await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
    const postsWatch = (follow) => (window.__sent || []).filter((line) => line.indexOf('"topic":"posts"') >= 0 && line.indexOf(follow) >= 0).length;
    await page.waitForFunction(postsWatch, FOLLOW, { timeout: 15000 }).catch(() => fail("the open channel never watched posts"));
    const first = await page.evaluate(postsWatch, FOLLOW);
    await page.evaluate(() => { if (window.__sock) window.__sock.close(); });
    await page.waitForFunction((seen) => {
      const n = (window.__sent || []).filter((line) => line.indexOf('"topic":"posts"') >= 0 && line.indexOf("200000000002") >= 0).length;
      return n > seen;
    }, first, { timeout: 15000 }).catch(() => fail("a reconnect did not send the posts watch again"));
    await context.close();
    console.log("home watch rearm ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
