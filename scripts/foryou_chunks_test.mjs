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
    window.__fy = { maxBatch: 0, maxNew: 0, maxReplacementBatch: 0, events: [], counts: [], first: [], replaced: [], tasks: [], byPost: new Map() };
    const nodes = new WeakMap();
    let serial = 0;
    const identity = (node) => { if (!nodes.has(node)) nodes.set(node, ++serial); return nodes.get(node); };
    new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__fy.tasks.push(e.duration))).observe({ type: "longtask", buffered: true });
    new MutationObserver((recs) => {
      const seen = new Set();
      const take = (a) => { if (a.isConnected && !(a.parentElement && a.parentElement.closest("article.post"))) seen.add(a); };
      recs.forEach((r) => r.addedNodes.forEach((x) => {
        if (x.nodeType !== 1) return;
        if (x.matches("article.post")) take(x);
        x.querySelectorAll("article.post").forEach(take);
      }));
      const cards = Array.from(document.querySelectorAll("#app article.post[data-post]"));
      const fresh = Array.from(seen).filter((node) => !window.__fy.byPost.has(node.dataset.post));
      const replacements = [];
      cards.forEach((node) => {
        const id = node.dataset.post;
        const token = identity(node);
        const before = window.__fy.byPost.get(id);
        if (before && before !== token && seen.has(node)) replacements.push(id);
        window.__fy.byPost.set(id, token);
      });
      if (!seen.size) return;
      const count = cards.length;
      window.__fy.maxBatch = Math.max(window.__fy.maxBatch, seen.size);
      window.__fy.maxNew = Math.max(window.__fy.maxNew, fresh.length);
      window.__fy.maxReplacementBatch = Math.max(window.__fy.maxReplacementBatch, replacements.length);
      window.__fy.events.push({ count, added: seen.size, fresh: fresh.length, replaced: replacements.length });
      if (count) window.__fy.counts.push(count);
      if (window.__fy.first.length) {
        const current = new Map(cards.map((node) => [node.dataset.post, identity(node)]));
        window.__fy.first.forEach((card) => { if (current.has(card.id) && current.get(card.id) !== card.node && !window.__fy.replaced.includes(card.id)) window.__fy.replaced.push(card.id); });
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await ctx.route("**/v1/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto("http://127.0.0.1:" + server.address().port + "/index.html#/home", { waitUntil: "domcontentloaded" });
  const firstPostsAt = Date.now();
  await page.waitForFunction(() => document.querySelectorAll("#app article.post").length >= 3, null, { timeout: 60000 });
  const firstThreeMs = Date.now() - firstPostsAt;
  // New feed arrivals can legitimately enter ahead of the initial cards.
  // Sample once the first batch has settled instead of tracking a moving head.
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__fy.first = Array.from(document.querySelectorAll("#app article.post[data-post]")).slice(0, 6).map((node) => ({ id: node.dataset.post, node: window.__fy.byPost.get(node.dataset.post) })); });
  await page.waitForFunction(() => document.querySelectorAll("#app article.post").length >= 20, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const rest = await page.evaluate(() => document.querySelectorAll("#app article.post").length);
  const ids = await page.evaluate(() => Array.from(document.querySelectorAll("#app article.post[data-post]")).map((a) => a.getAttribute("data-post")));
  if (new Set(ids).size !== ids.length) fail("a card was added twice " + JSON.stringify({ ids, events: await page.evaluate(() => window.__fy.events) }));
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(700); }
  await page.waitForTimeout(1500);
  await page.evaluate((ms) => { window.__fyFirstThreeMs = ms; }, firstThreeMs);
  const info = await page.evaluate(() => {
    const current = new Map(Array.from(document.querySelectorAll("#app article.post[data-post]"), (node) => [node.dataset.post, node]));
    const first = window.__fy.first.map((card) => ({ ...card, stillPresent: current.has(card.id) }));
    return { firstThreeMs: window.__fyFirstThreeMs, maxBatch: window.__fy.maxBatch, maxNew: window.__fy.maxNew, maxReplacementBatch: window.__fy.maxReplacementBatch, events: window.__fy.events, replaced: window.__fy.replaced, backwards: window.__fy.counts.some((count, i, all) => i && count < all[i - 1]), first, tasks: window.__fy.tasks, after: document.querySelectorAll("#app article.post").length };
  });
  if (rest < 20) fail("first page did not fill in after the first batch " + JSON.stringify({ rest }));
  if (info.maxReplacementBatch > 6) fail("too many mounted cards replaced at once " + JSON.stringify(info));
  if (info.backwards) fail("a refresh took visible cards away " + JSON.stringify(info.events));
  if (info.replaced.length || info.first.length < 3 || info.first.some((card) => !card.stillPresent)) fail("background work replaced or lost mounted cards " + JSON.stringify(info));
  if (info.after <= rest) fail("scrolling did not add more posts " + JSON.stringify({ rest, ...info }));
  console.log("foryou chunks check passed", JSON.stringify({ rest, ...info }));
} finally {
  await browser.close();
  server.close();
}
