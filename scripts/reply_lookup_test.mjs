/* A thread reply loaded for one account must not come back through share,
   bookmarks, history, or the media viewer for another account or after sign-out.
   A reply that arrives after the switch is dropped. Dummy accounts only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const A = "100000000001";
const B = "500000000005";
const PARENT = "ab".repeat(16);
const REPLY = "cd".repeat(16);
const LATE_PARENT = "ef".repeat(16);
const LATE_REPLY = "a1".repeat(16);
const SECRET = "Restricted reply for A only";
const LATE = "Late restricted reply for A only";
const IMG = "https://example.com/a-only-reply.png";
const parent = (id, body) => ({
  id, authorId: "200000000002", authorHandle: "user_b", authorName: "User B",
  body, createdAt: Date.parse("2026-11-01T12:00:00Z"), audience: "everyone"
});
const reply = (id, parentId, body) => ({
  id, parentId, authorId: "200000000002", authorHandle: "user_b", authorName: "User B",
  body, createdAt: Date.parse("2026-11-02T12:00:00Z"), audience: "friends",
  media: [{ mime: "image/png", url: IMG, alt: "restricted" }]
});

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
function gate() {
  let open = null;
  const ready = new Promise((resolve) => { open = resolve; });
  return { ready, open };
}

async function arm(page, lateGate) {
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const send = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const token = String(req.headers().authorization || "");
    const mine = token.indexOf("token-" + A) >= 0;
    if (url.pathname === "/v1/posts" && req.method() === "GET") {
      return send(200, { posts: [parent(PARENT, "Parent fixture"), parent(LATE_PARENT, "Late parent fixture")], ok: true });
    }
    if (url.pathname === "/v1/posts/thread") {
      const id = url.searchParams.get("id") || "";
      if (id === LATE_PARENT) {
        if (mine) await lateGate.ready;
        return send(200, { post: parent(LATE_PARENT, "Late parent fixture"), replies: mine ? [reply(LATE_REPLY, LATE_PARENT, LATE)] : [] });
      }
      if (id === PARENT) return send(200, { post: parent(PARENT, "Parent fixture"), replies: mine ? [reply(REPLY, PARENT, SECRET)] : [] });
    }
    return send(200, { ok: true, posts: [], replies: [] });
  });
}

async function useAccount(page, id, handle) {
  await page.evaluate(({ id, handle }) => {
    if (id) {
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
        token: "token-" + id,
        account: { publicId: id, handle: handle, displayName: handle === "user_a" ? "User A" : "User C" }
      }));
    } else localStorage.removeItem("viktorychapp-account-v1");
    location.hash = "#/";
  }, { id, handle });
  await page.waitForTimeout(250);
}

async function openStatus(page, id) {
  await page.evaluate((postId) => { location.hash = "#/app/user_b/status/" + postId; }, id);
}

async function act(page, name, id) {
  await page.evaluate(({ name, id }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.act = name;
    btn.dataset.kind = "post";
    btn.dataset.id = id;
    btn.dataset.mi = "0";
    document.body.appendChild(btn);
    btn.click();
    btn.remove();
  }, { name, id });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function leaked(page, words) {
  const blob = await page.evaluate(() => {
    const viewer = document.getElementById("viewer");
    return (document.body.innerText || "") + "\n" + (viewer ? viewer.innerHTML : "");
  });
  return words.filter((word) => blob.indexOf(word) >= 0);
}

async function lookups(page, id, words, label) {
  await act(page, "share", id);
  let hit = await leaked(page, words);
  if (hit.length) throw new Error(label + " share showed " + hit.join(", "));
  await act(page, "close-share", id);
  await act(page, "bookmark", id);
  await page.evaluate(() => { location.hash = "#/history/bookmarks"; });
  await page.waitForTimeout(300);
  hit = await leaked(page, words);
  if (hit.length) throw new Error(label + " history showed " + hit.join(", "));
  await act(page, "view", id);
  hit = await leaked(page, words);
  if (hit.length) throw new Error(label + " viewer showed " + hit.join(", "));
}

async function run(browser, port, width) {
  const lateGate = gate();
  const context = await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: "block" });
  await context.addInitScript((id) => {
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "token-" + id,
      account: { publicId: id, handle: "user_a", displayName: "User A" }
    }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
  }, A);
  const page = await context.newPage();
  await page.route("**/*", (route) => route.request().url().startsWith("http://127.0.0.1:" + port) ? route.continue() : route.abort());
  await arm(page, lateGate);
  await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Parent fixture", { timeout: 15000 });
  await openStatus(page, PARENT);
  await page.waitForSelector("text=" + SECRET, { timeout: 8000 });

  await useAccount(page, B, "user_c");
  await lookups(page, REPLY, [SECRET, IMG], "other account");
  await useAccount(page, "", "");
  await lookups(page, REPLY, [SECRET, IMG], "signed out");

  await useAccount(page, A, "user_a");
  await page.waitForSelector("text=Late parent fixture", { timeout: 8000 });
  await openStatus(page, LATE_PARENT);
  await page.waitForTimeout(200);
  await useAccount(page, B, "user_c");
  lateGate.open();
  await page.waitForTimeout(400);
  await lookups(page, LATE_REPLY, [LATE, IMG], "late reply");
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
    await run(browser, port, 390);
    await run(browser, port, 1280);
    console.log("reply lookup ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
