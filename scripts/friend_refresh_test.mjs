/* A friends-list answer that only changes who may be added, or the mutual
   count, still updates the profile. The friends tab itself stays closed.
   Fixture accounts only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ME = "100000000001";
const THEM = "200000000002";

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

const CASES = [
  {
    name: "friendsOff",
    account: { friendsOff: false, canRequest: true, viewerFriendStatus: "none", friendsCount: 4, mutualFriendsCount: 0 },
    friends: { friends: [], friendsCount: 4, friendsOff: true, canRequest: true, mutualCount: 0 },
    before: "Add Friend",
    after: "Not accepting friend requests"
  },
  {
    name: "canRequest",
    account: { friendsOff: false, canRequest: true, viewerFriendStatus: "none", friendsCount: 4, mutualFriendsCount: 0 },
    friends: { friends: [], friendsCount: 4, friendsOff: false, canRequest: false, mutualCount: 0 },
    before: "Add Friend",
    after: "Not accepting friend requests"
  },
  {
    name: "mutual",
    account: { friendsOff: false, canRequest: true, viewerFriendStatus: "none", friendsCount: 4, mutualFriendsCount: 1 },
    friends: { friends: [], friendsCount: 4, friendsOff: false, canRequest: true, mutualCount: 3 },
    before: "1 mutual friend",
    after: "3 mutual friends"
  }
];

async function runCase(browser, port, width, spec) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: "block" });
  await context.addInitScript((me) => {
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "local-test-token",
      account: { publicId: me, handle: "user_a", displayName: "User A", avatar: "" }
    }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
  }, ME);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1:" + port)) return route.continue();
    return route.abort();
  });
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const send = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/v1/profile/user_b") {
      return send({
        account: Object.assign({
          publicId: THEM, handle: "user_b", displayName: "User B",
          followersCount: 5, followingCount: 1
        }, spec.account),
        reposts: []
      });
    }
    if (url.pathname === "/v1/friends" && String(url.searchParams.get("id") || "").indexOf(THEM) >= 0) {
      await gate;
      return send(spec.friends);
    }
    return send({ ok: true, posts: [], incoming: [], outgoing: [], friends: [] });
  });
  await page.goto("http://127.0.0.1:" + port + "/index.html#/@user_b", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=" + spec.before, { timeout: 15000 });
  const early = await page.evaluate((text) => document.body.innerText.includes(text), spec.after);
  if (spec.before !== spec.after && early) throw new Error(spec.name + " showed the update before the friends answer");
  release();
  await page.waitForSelector("text=" + spec.after, { timeout: 8000 }).catch(async () => {
    const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
    throw new Error(spec.name + " did not update the profile: " + text);
  });
  if (errors.length) throw new Error(spec.name + " page errors " + errors.slice(0, 2).join(" | "));
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
    for (const width of [390, 1280]) {
      for (const item of CASES) await runCase(browser, port, width, item);
    }
    console.log("friend refresh ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
