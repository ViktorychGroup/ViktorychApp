/* Fixture timing for a like on the open feed. Localhost only. Not production. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = process.env.BENCH_OUT || "";
const posts = [];
const feeds = [];
for (let i = 0; i < 20; i++) {
  const id = "p" + String(i).padStart(2, "0");
  feeds.push({ id: "lane" + i, platform: "rss", handle: "lane" + i, name: "Lane " + i });
  posts.push({
    id, statusId: id, platform: "rss", feedId: "lane" + i, kind: "post",
    date: new Date(Date.now() - i * 3600000).toISOString(),
    text: "Fixture line for a speed check.",
    author: "Lane " + i, handle: "lane" + i, media: [],
    stats: { replies: 1, reposts: 0, likes: 2, views: 3 }
  });
}
const catalog = JSON.stringify({ updated: "2026-11-07T00:00:00.000Z", feeds, posts });

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
    if (url.pathname === "/feeds.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(catalog);
    }
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
function median(list) {
  const s = list.filter((n) => typeof n === "number").slice().sort((a, b) => a - b);
  if (!s.length) return null;
  return Number(s[Math.floor(s.length / 2)].toFixed(2));
}
function p95(list) {
  const s = list.filter((n) => typeof n === "number").slice().sort((a, b) => a - b);
  if (!s.length) return null;
  return Number(s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)].toFixed(2));
}

async function prep(page, port) {
  await page.addInitScript(() => {
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    const follows = [];
    for (let i = 0; i < 20; i++) follows.push("lane" + i);
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, follows, lists: [], feedTabs: [], likes: {}, bookmarks: {}, reposts: {} }));
  });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1:" + port)) return route.continue();
    return route.abort();
  });
  const t0 = Date.now();
  await page.goto("http://127.0.0.1:" + port + "/index.html#/following", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button[data-act="like"]', { timeout: 20000 });
  return Date.now() - t0;
}

async function likeOnce(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const btn = document.querySelector('button[data-act="like"]');
    const app = document.getElementById("app");
    if (!btn || !app) { resolve({ missing: true }); return; }
    const startCount = btn.querySelector(".count") ? btn.querySelector(".count").textContent : "";
    const renders0 = window.__renders || 0;
    let mutations = 0;
    const mo = new MutationObserver(() => { mutations += 1; });
    mo.observe(app, { childList: true });
    const t0 = performance.now();
    let paintMs = null;
    btn.click();
    const clickMs = Number((performance.now() - t0).toFixed(2));
    const tick = () => {
      const live = document.querySelector('button[data-act="like"]');
      const count = live && live.querySelector(".count") ? live.querySelector(".count").textContent : "";
      if (paintMs == null && count !== startCount) paintMs = Number((performance.now() - t0).toFixed(2));
      if (performance.now() - t0 < 900) requestAnimationFrame(tick);
      else {
        mo.disconnect();
        resolve({
          clickMs,
          paintMs,
          mutations,
          renders: (window.__renders || 0) - renders0,
          on: !!(live && live.classList.contains("on")),
          count
        });
      }
    };
    requestAnimationFrame(tick);
  }));
}

async function main() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const sizes = [
    { name: "phone", width: 390, height: 844, clicks: 7, cpu: 1 },
    { name: "phone-cpu4x", width: 390, height: 844, clicks: 5, cpu: 4 },
    { name: "desktop", width: 1280, height: 800, clicks: 7, cpu: 1 }
  ];
  const cases = [];
  try {
    for (const size of sizes) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, serviceWorkers: "block" });
      const page = await context.newPage();
      if (size.cpu > 1) {
        const client = await context.newCDPSession(page);
        await client.send("Emulation.setCPUThrottlingRate", { rate: size.cpu });
      }
      const readyMs = await prep(page, port);
      const clicks = [];
      for (let i = 0; i < size.clicks; i++) clicks.push(await likeOnce(page));
      const mutations = clicks.map((row) => row.mutations);
      const renders = clicks.map((row) => row.renders);
      cases.push({
        name: size.name,
        cpuRate: size.cpu,
        n: clicks.length,
        readyMs,
        windowMs: 900,
        clicks,
        mutationMedian: median(mutations),
        mutationP95: p95(mutations),
        renderMedian: median(renders),
        renderP95: p95(renders),
        paintMedianMs: median(clicks.map((row) => row.paintMs)),
        clickMedianMs: median(clicks.map((row) => row.clickMs))
      });
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  const doc = {
    label: "Synthetic fixture, localhost, not production.",
    node: process.version,
    cases
  };
  const text = JSON.stringify(doc, null, 2);
  if (outPath) fs.writeFileSync(outPath, text);
  console.log(text);
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
