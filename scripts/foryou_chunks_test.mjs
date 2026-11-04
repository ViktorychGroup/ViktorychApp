/* For You loads in small chunks: the first paint draws a few cards, later
   feed arrivals near the top repaint only that first batch, the rest of the
   page is added a few cards at a time when idle, and scrolling adds more.
   Uses the repo's own feed files; prints counts only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pw = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : "playwright-core");
const chromium = pw.chromium || pw.default.chromium;
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml" };
function fail(msg) { throw new Error("foryou chunks: " + msg); }

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  setTimeout(() => fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  }), 40);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-a", account: { handle: "user_a", displayName: "User A" } }));
    window.__fy = { maxBatch: 0 };
    new MutationObserver((recs) => {
      const seen = new Set();
      const take = (a) => { if (a.isConnected && !(a.parentElement && a.parentElement.closest("article.post"))) seen.add(a); };
      recs.forEach((r) => r.addedNodes.forEach((x) => {
        if (x.nodeType !== 1) return;
        if (x.matches("article.post")) take(x);
        x.querySelectorAll("article.post").forEach(take);
      }));
      if (seen.size > window.__fy.maxBatch) window.__fy.maxBatch = seen.size;
    }).observe(document, { childList: true, subtree: true });
  });
  await ctx.route("**/v1/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port + "/index.html#/home", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#app article.post").length >= 3, null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll("#app article.post").length >= 20, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const rest = await page.evaluate(() => document.querySelectorAll("#app article.post").length);
  const ids = await page.evaluate(() => Array.from(document.querySelectorAll("#app article.post[data-id]")).map((a) => a.getAttribute("data-id")));
  if (new Set(ids).size !== ids.length) fail("a card was added twice");
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(700); }
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => ({ maxBatch: window.__fy.maxBatch, after: document.querySelectorAll("#app article.post").length }));
  if (rest < 20) fail("first page did not fill in after the first batch " + JSON.stringify({ rest }));
  if (info.maxBatch > 8) fail("too many cards added at once " + JSON.stringify(info));
  if (info.after <= rest) fail("scrolling did not add more posts " + JSON.stringify({ rest, ...info }));
  console.log("foryou chunks check passed", JSON.stringify({ rest, ...info }));
} finally {
  await browser.close();
  server.close();
}
