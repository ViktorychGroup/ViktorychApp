/* A reply is on the post page before the server answers, then confirmed or removed. Fixture only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ME = "100000000001";
const OTHER = "200000000002";
const POST = "ab".repeat(16);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const parent = {
  id: POST, authorId: OTHER, authorHandle: "user_b", authorName: "User B",
  body: "Parent fixture", createdAt: Date.parse("2026-11-01T12:00:00Z"), audience: "everyone"
};

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

async function run(browser, port, width) {
  const held = gate();
  const failed = gate();
  const later = gate();
  let photoBytes = 0;
  const context = await browser.newContext({ viewport: { width: width, height: 800 }, serviceWorkers: "block" });
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
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1:" + port)) return route.continue();
    return route.abort();
  });
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const send = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/v1/posts" && req.method() === "GET") return send(200, { posts: [parent], ok: true });
    if (url.pathname === "/v1/posts" && req.method() === "POST") {
      const raw = req.postDataBuffer() || Buffer.alloc(0);
      if (raw.includes(png)) photoBytes = raw.length;
      const posted = String(req.postData() || "");
      if (posted.includes("fail this reply")) {
        await failed.ready;
        return send(400, { error: "no" });
      }
      if (posted.includes("Later reply")) await later.ready;
      else if (!raw.includes(png)) await held.ready;
      const text = raw.includes(png) ? "Photo reply" : posted.includes("Later reply") ? "Later reply" : "Held reply";
      return send(201, { post: { id: "cd".repeat(16), authorId: ME, authorHandle: "user_a", authorName: "User A", body: text, parentId: POST, createdAt: Date.now(), media: [] } });
    }
    return send(200, { ok: true, posts: [], replies: [] });
  });
  await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Parent fixture", { timeout: 15000 });
  await page.evaluate((id) => { location.hash = "#/app/user_b/status/" + id; }, POST);
  await page.waitForSelector('button[data-act="public-reply"]', { timeout: 15000 });

  await page.locator('button[data-act="public-reply"]').first().click();
  await page.locator("#reply-draft").fill("Held reply");
  await page.locator('[data-act="xc-publish"][data-slot="reply"]').click();
  await page.waitForFunction(() => {
    return [...document.querySelectorAll("article")].some((el) => (el.textContent || "").includes("Held reply") && (el.textContent || "").includes("Sending"));
  }, null, { timeout: 4000 });
  const beforeAck = await page.evaluate(() => document.body.innerText.includes("Held reply") && document.body.innerText.includes("Sending"));
  if (!beforeAck) throw new Error("reply was not pending before the server answer");
  held.open();
  await page.waitForFunction(() => {
    const hit = [...document.querySelectorAll("article")].find((el) => (el.textContent || "").includes("Held reply"));
    return hit && !(hit.textContent || "").includes("Sending");
  }, null, { timeout: 4000 });

  await page.evaluate(() => {
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "local-test-token-b",
      account: { publicId: "500000000005", handle: "user_c", displayName: "User C", avatar: "" }
    }));
    location.hash = "#/";
  });
  await page.waitForTimeout(200);
  await page.evaluate((id) => { location.hash = "#/app/user_b/status/" + id; }, POST);
  await page.waitForTimeout(300);
  const leaked = await page.evaluate(() => document.body.innerText.includes("Held reply"));
  if (leaked) throw new Error("the other account saw the reply");

  await page.evaluate((me) => {
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "local-test-token",
      account: { publicId: me, handle: "user_a", displayName: "User A", avatar: "" }
    }));
    location.hash = "#/";
  }, ME);
  await page.waitForSelector("text=Parent fixture", { timeout: 8000 });
  await page.evaluate((id) => { location.hash = "#/app/user_b/status/" + id; }, POST);
  await page.waitForSelector('button[data-act="public-reply"]', { timeout: 8000 });
  await page.locator('button[data-act="public-reply"]').first().click();
  await page.locator("#reply-draft").fill("fail this reply");
  await page.locator('[data-act="xc-publish"][data-slot="reply"]').click();
  await page.waitForFunction(() => document.body.innerText.includes("fail this reply") && document.body.innerText.includes("Sending"), null, { timeout: 4000 });
  failed.open();
  await page.waitForFunction(() => !document.body.innerText.includes("fail this reply"), null, { timeout: 4000 });

  const file = "/tmp/reply-pending-pixel.png";
  fs.writeFileSync(file, png);
  await page.locator('button[data-act="public-reply"]').first().click();
  await page.locator("#reply-draft").fill("Photo reply");
  await page.locator('input[data-xc="file"][data-slot="reply"][data-kind="image"]').setInputFiles(file);
  const uploaded = page.waitForResponse((res) => res.url().indexOf("/v1/posts") >= 0 && res.request().method() === "POST");
  await page.locator('[data-act="xc-publish"][data-slot="reply"]').click();
  await page.waitForSelector("article img[data-local-preview='1']", { timeout: 4000 });
  await uploaded;
  if (!photoBytes || photoBytes < png.length) throw new Error("the upload did not keep the original bytes");

  await page.locator('button[data-act="public-reply"]').first().click();
  await page.locator("#reply-draft").fill("Later reply");
  await page.locator('[data-act="xc-publish"][data-slot="reply"]').click();
  await page.waitForFunction(() => document.body.innerText.includes("Later reply") && document.body.innerText.includes("Sending"), null, { timeout: 4000 });
  await page.evaluate(() => { location.hash = "#/"; });
  await page.waitForTimeout(100);
  later.open();
  await page.waitForTimeout(200);
  await page.evaluate((id) => { location.hash = "#/app/user_b/status/" + id; }, POST);
  await page.waitForFunction(() => {
    const hit = [...document.querySelectorAll("article")].find((el) => (el.textContent || "").includes("Later reply"));
    return hit && !(hit.textContent || "").includes("Sending");
  }, null, { timeout: 4000 });

  await context.setOffline(true);
  await page.locator('button[data-act="public-reply"]').first().click();
  await page.locator("#reply-draft").fill("Offline reply");
  await page.locator('[data-act="xc-publish"][data-slot="reply"]').click();
  await page.waitForTimeout(300);
  const offlineShown = await page.evaluate(() => document.body.innerText.includes("Offline reply") && document.body.innerText.includes("Sending"));
  if (offlineShown) throw new Error("an offline reply was shown as sending");
  await context.setOffline(false);
  await context.close();
  return { width: width, photoBytes: photoBytes };
}

async function main() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const phone = await run(browser, port, 390);
    const desktop = await run(browser, port, 1280);
    console.log("reply pending ok", JSON.stringify({ phone, desktop }));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
