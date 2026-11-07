/* Adding an account to a Home tab shows that account at once.
   A post already on the device appears before a slow profile fetch.
   A first fetch is a loading state, then the post, and a fetch that
   never answers stops loading and offers Try again. Dummy accounts only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fail(message) { console.error(message); process.exitCode = 1; throw new Error(message); }
function mime(file) {
  if (/\.m?js$/.test(file)) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
function startServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("missing"); return; }
      res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  return mod.chromium || (mod.default && mod.default.chromium);
}

const CACHED_ID = "ab".repeat(16);
const LATE_ID = "cd".repeat(16);
const B = "200000000002";
const C = "300000000003";
const D = "400000000004";
const post = (id, authorId, handle, name, body) => ({
  id, authorId, authorHandle: handle, authorName: name, body, createdAt: Date.parse("2026-11-01T12:00:00Z"), stats: {}
});

function session(publicId) {
  const tabs = [
    { id: "crew", name: "Crew", showHome: true, showNotes: false, members: [], updatedAt: 10, memberAdds: {} },
    { id: "late", name: "Late", showHome: true, showNotes: false, members: ["app:" + C], updatedAt: 11, memberAdds: { ["app:" + C]: 11 } },
    { id: "quiet", name: "Quiet", showHome: true, showNotes: false, members: ["app:" + D], updatedAt: 12, memberAdds: { ["app:" + D]: 12 } }
  ];
  return `(() => {
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, follows: [], lists: [], feedTabs: ${JSON.stringify(tabs)} }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-${publicId}", account: { publicId: ${JSON.stringify(publicId)}, handle: "user_a", displayName: "User A" } }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
  })()`;
}

async function arm(page, gate) {
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/v1/posts" && req.method() === "GET") {
      const by = url.searchParams.get("by") || "";
      if (by === B) {
        gate.cachedHits += 1;
        await gate.cached;
        gate.cachedDone = true;
        return json(200, { posts: [post(CACHED_ID, B, "user_b", "User B", "Cached note from user b")], ok: true });
      }
      if (by === C) {
        const started = Date.now();
        gate.lateStarted = started;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        gate.lateMs = Date.now() - started;
        return json(200, { posts: [post(LATE_ID, C, "user_c", "User C", "Late note from user c")], ok: true });
      }
      if (by === D) {
        gate.quietHits += 1;
        await gate.quiet;
        return json(200, { posts: [], ok: true });
      }
      return json(200, { posts: [post(CACHED_ID, B, "user_b", "User B", "Cached note from user b")], ok: true });
    }
    return json(200, { ok: true, posts: [] });
  });
}

async function run(page, label, hang) {
  await page.goto(page.url().split("#")[0] + "#/", { waitUntil: "domcontentloaded" });
  await page.locator("article", { hasText: "Cached note from user b" }).first().waitFor({ timeout: 15000 });
  await page.locator("article", { hasText: "Cached note from user b" }).first().locator('button[data-act="menu"]').click();
  await page.locator('button[data-act="add-to-tab"]').click();
  await page.locator('button[data-act="feed-tab-member"][data-tab="crew"]').click();
  const started = Date.now();
  await page.goto(page.url().split("#")[0] + "#/cat/crew", { waitUntil: "domcontentloaded" });
  await page.locator("article", { hasText: "Cached note from user b" }).first().waitFor({ timeout: 4000 });
  const shownMs = Date.now() - started;
  if (shownMs > 2500) fail(label + " cached post took " + shownMs + "ms");
  if (gateOf(page).cachedDone) fail(label + " waited for the profile fetch");
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem("viktorychapp-settings-v1") || "{}"));
  const crew = (stored.feedTabs || []).find((tab) => tab.id === "crew");
  if (!crew || crew.members.filter((id) => id === "app:" + B).length !== 1) fail(label + " member was not stored once " + JSON.stringify(crew && crew.members));
  if (!crew.memberAdds || !crew.memberAdds["app:" + B]) fail(label + " member add was not stamped");

  await page.locator('button[data-act="manage-tabs"]').click();
  await page.locator('button[data-act="feed-tab-edit"][data-id="crew"]').click();
  await page.locator("#feed-tab-q").fill("user_b");
  await page.locator('button[data-act="feed-tab-pick"][data-id="app:' + B + '"]').waitFor({ timeout: 5000 });
  await page.keyboard.press("Escape");

  const lateAt = Date.now();
  await page.goto(page.url().split("#")[0] + "#/cat/late", { waitUntil: "domcontentloaded" });
  await page.locator(".tab-loading").waitFor({ timeout: 4000 });
  await page.locator("article", { hasText: "Late note from user c" }).first().waitFor({ timeout: 5000 });
  const lateShown = Date.now() - lateAt;
  if (lateShown < 1000 || lateShown > 5000) fail(label + " late post timing " + lateShown);

  if (hang) {
    const quietAt = Date.now();
    await page.goto(page.url().split("#")[0] + "#/cat/quiet", { waitUntil: "domcontentloaded" });
    await page.locator('button[data-act="tab-retry"][data-tab="cat:quiet"]').waitFor({ timeout: 12000 });
    const quietMs = Date.now() - quietAt;
    if (quietMs > 10000) fail(label + " quiet tab spun for " + quietMs + "ms");
    if (await page.locator(".tab-loading").count()) fail(label + " quiet tab kept the loading state");
  }

  await page.goto(page.url().split("#")[0] + "#/cat/crew", { waitUntil: "domcontentloaded" });
  await page.locator("article", { hasText: "Cached note from user b" }).first().waitFor({ timeout: 8000 });
  if (await page.locator("article", { hasText: "Cached note from user b" }).count() !== 1) fail(label + " duplicate cards");
  console.log(label + " shownMs " + shownMs + " lateMs " + lateShown);
}

function gateOf(page) { return page._gate; }

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const port = server.address().port;
  try {
    for (const size of [{ name: "phone", width: 390, height: 844, hang: true }, { name: "desktop", width: 1280, height: 800, hang: false }]) {
      const gate = { cached: null, quiet: null, cachedHits: 0, quietHits: 0, lateMs: 0, lateStarted: 0, cachedDone: false };
      let releaseCached;
      let releaseQuiet;
      gate.cached = new Promise((resolve) => { releaseCached = resolve; });
      gate.quiet = new Promise((resolve) => { releaseQuiet = resolve; });
      const context = await browser.newContext({ viewport: size, serviceWorkers: "block" });
      const page = await context.newPage();
      page._gate = gate;
      page.on("pageerror", (err) => fail(size.name + " " + err.message));
      await page.addInitScript(session("100000000001"));
      await arm(page, gate);
      await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
      await run(page, size.name, size.hang);
      releaseCached();
      const other = await browser.newContext({ viewport: size, serviceWorkers: "block" });
      const stranger = await other.newPage();
      stranger.on("pageerror", (err) => fail(size.name + " stranger " + err.message));
      await stranger.addInitScript(`(() => {
        localStorage.setItem("superintelapp-lang", "en");
        localStorage.setItem("viktorychapp-lang-user-picked", "1");
        localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
        localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, follows: [], lists: [], feedTabs: [] }));
        localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-other", account: { publicId: "500000000005", handle: "user_e", displayName: "User E" } }));
        window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
      })()`);
      await arm(stranger, { cached: Promise.resolve(), quiet: Promise.resolve(), cachedHits: 0, quietHits: 0 });
      await stranger.goto("http://127.0.0.1:" + port + "/index.html#/cat/crew", { waitUntil: "domcontentloaded" });
      await stranger.waitForTimeout(600);
      const raw = await stranger.evaluate(() => localStorage.getItem("viktorychapp-settings-v1") || "");
      if (raw.indexOf(B) >= 0) fail(size.name + " other account stored the member");
      if (await stranger.locator("article", { hasText: "Cached note from user b" }).count()) fail(size.name + " other account saw the filtered post");
      releaseQuiet();
      await other.close();
      await context.close();
    }
    console.log("tab member ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
