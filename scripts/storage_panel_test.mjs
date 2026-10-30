import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/* The Storage usage screen in a real browser: every place the app keeps bytes
   is counted (app files, feeds, media, downloads, large-video files, databases,
   settings), the screen re-measures when it opens, and Clear cache keeps
   settings, drafts and downloaded music. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>window.__renders = 0; window.ViktorychAccounts = { requestRender: () => { window.__renders++; } };</script>
<script src="/storage.js"></script></body></html>`;

function fail(message) { console.error("FAIL: " + message); process.exitCode = 1; throw new Error(message); }

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  return mod.chromium || (mod.default && mod.default.chromium);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/p.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); return; }
  if (url.pathname === "/storage.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(fs.readFileSync(path.join(root, "storage.js"))); return; }
  res.writeHead(404); res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
const chromium = await loadPlaywright();
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
try {
  const page = await browser.newPage();
  await page.goto(base + "/p.html");
  const out = await page.evaluate(async () => {
    const S = window.ViktorychStorage;
    const put = async (name, url, bytes, type) => (await caches.open(name)).put(url, new Response(new Uint8Array(bytes), { headers: { "content-type": type || "application/octet-stream", "content-length": String(bytes) } }));
    await put("shell-viktorych-a264-x", "/app.js", 300000, "text/javascript");
    await put("media-v1", "https://pbs.twimg.com/media/a.jpg", 500000, "image/jpeg");
    await put("data-v1", "/feeds.json", 120000, "application/json");
    await put("viktorych-prefs", "/__prefs/off.json", 20, "application/json");
    await put("sintel-music-offline", "/music/a/song.mp3", 400000, "audio/mpeg");
    const db = await S.openDb();
    await S.putDoc(db, { category: "drafts", id: "compose", body: { text: "hello" } });
    await S.putDoc(db, { category: "feeds", id: "home", body: { posts: "x".repeat(5000) } });
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("vapp-media", { create: true });
    const w = await (await dir.getFileHandle("abc", { create: true })).createWritable();
    await w.write(new Uint8Array(2 * 1024 * 1024)); await w.close();
    await S.putFile(db, { url: "https://video.twimg.com/a.mp4", bytes: 2 * 1024 * 1024, category: "videos", cacheName: "opfs", at: Date.now(), saved: Date.now() });
    localStorage.setItem("k", "v".repeat(1000));
    const wait = async () => { for (let i = 0; i < 100; i++) { const h = S.usageHtml(); if (h.indexOf("Measuring storage") < 0) return h; await new Promise((r) => setTimeout(r, 50)); } return S.usageHtml(); };
    S.usageHtml();
    const html = await wait();
    const div = document.createElement("div"); div.innerHTML = html;
    const sizes = {};
    div.querySelectorAll(".stor-row").forEach((row) => { sizes[row.querySelector("b").textContent] = row.querySelector(".stor-size").textContent; });
    const hero = div.querySelector(".stor-hole b").textContent;
    window.confirm = () => true;
    await S.clearStored("all");
    const keys = async (n) => (await (await caches.open(n)).keys()).length;
    const docs = await S.listDocs(db);
    return { hero, sizes, html, shell: await keys("shell-viktorych-a264-x"), prefs: await keys("viktorych-prefs"), music: await keys("sintel-music-offline"), media: await keys("media-v1"), data: await keys("data-v1"), docs: docs.map((d) => d.category) };
  });
  const need = ["App files", "Feeds and posts", "Photos and videos", "Downloaded music", "Large videos", "Databases", "Settings"];
  need.forEach((label) => { if (!out.sizes[label]) fail("missing store row " + label + " " + JSON.stringify(out.sizes)); });
  if (out.sizes["App files"] !== "293 KB") fail("app files counted: " + out.sizes["App files"]);
  if (out.sizes["Large videos"] !== "2.0 MB") fail("large videos counted: " + out.sizes["Large videos"]);
  const mb = parseFloat(out.hero);
  if (!/MB$/.test(out.hero) || mb < 3.2) fail("hero total too low: " + out.hero);
  if (out.shell !== 1 || out.prefs !== 1 || out.music !== 1) fail("clear cache removed app files, settings or downloads " + JSON.stringify(out));
  if (out.media !== 0 || out.data !== 0) fail("clear cache kept media or feeds " + JSON.stringify(out));
  if (out.docs.join() !== "drafts") fail("clear cache must keep only drafts: " + out.docs.join());
  console.log("storage panel ok", out.hero, JSON.stringify(out.sizes));
} finally {
  await browser.close();
  server.close();
}
