/* Full-screen video viewer: one player. A clip in our YouTube-style player
   has a single control bar (one red progress line, play, time, speed,
   sound, settings, exit full screen), no second bar under it, and the post
   text and X action pills sit right above that bar without overlapping it.
   On a touch screen a tap hides and shows the controls and the text
   together. Synthetic posts only; the clip file never loads, so nothing is
   decoded or re-encoded. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = (message) => { console.error(message); process.exitCode = 1; throw new Error(message); };

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

const feeds = JSON.parse(fs.readFileSync(path.join(root, "feeds.json"), "utf8"));
const now = Date.now();
const xFeed = feeds.posts.find((p) => p.platform === "x").feedId;
const fake = [1, 2].map((n) => ({
  id: "90000000000000000" + n, statusId: "90000000000000000" + n, platform: "x", feedId: xFeed,
  kind: "post", author: "Test Author " + n, handle: "tester" + n, avatar: "", verifiedType: "blue",
  text: "Clip " + n + " title line\n\n" + "A longer body of text so the viewer has to clamp it and offer Show more. ".repeat(3),
  date: new Date(now - n * 60000).toISOString(), url: "https://x.com/i/status/90000000000000000" + n,
  media: [{ type: "video", url: "https://video.twimg.com/ext_tw_video/" + n + "/pu/vid/320x568/clip" + n + ".mp4", poster: "", duration: 12 }],
  stats: { likes: 5, reposts: 2, replies: 1 }
}));
feeds.posts = fake.concat(feeds.posts.filter((p) => p.platform !== "youtube"));

const chromium = await loadPlaywright();
const server = await startServer();
const ROOT = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ["--no-sandbox"] });
try {
  for (const vp of [{ name: "phone", width: 390, height: 844, touch: true }, { name: "landscape", width: 844, height: 390, touch: true }, { name: "desktop", width: 1280, height: 860, touch: false }]) {
    const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: vp.width, height: vp.height }, isMobile: vp.touch, hasTouch: vp.touch });
    await ctx.addInitScript(() => { try { localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true })); } catch (err) {} });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.route("**/feeds.json*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(feeds) }));
    await page.route((u) => /clip\d\.mp4/.test(u.href), () => { /* the file never arrives; the player still mounts */ });
    await page.goto(ROOT + "/#/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('.vplay[data-preview="feed"][data-pid="900000000000000001"] .vexpand', { state: "attached", timeout: 20000 });
    await page.evaluate(() => {
      const tile = document.querySelector('.vplay[data-preview="feed"][data-pid="900000000000000001"]');
      tile.scrollIntoView({ block: "center" });
      tile.querySelector(".vexpand").click();
    });
    await page.waitForSelector("#viewer.xv.xv-yt .xv-cur .html5-video-player .ytp-chrome-bottom", { timeout: 15000 });
    await page.evaluate(() => { const st = document.querySelector("#viewer .xv-cur .xv-media"); st._ytPlayer.resetAutoHide_(); });
    await page.waitForTimeout(400);
    const geo = await page.evaluate(() => {
      const box = document.getElementById("viewer");
      const rect = (s) => { const e = box.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
      const shown = (e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden" && getComputedStyle(e).display !== "none";
      return {
        bars: box.querySelectorAll(".xv-bar").length,
        progress: [...box.querySelectorAll(".xv-cur .ytp-progress-bar, .xv-prog")].filter(shown).length,
        fill: getComputedStyle(box.querySelector(".xv-cur .ytp-play-progress")).backgroundColor,
        chrome: rect(".xv-cur .ytp-chrome-bottom"), info: rect(".xv-cur .xv-info"), pills: rect(".xv-cur .xv-pills"),
        player: rect(".xv-cur .html5-video-player"),
        speed: !!box.querySelector(".ytp-pill-right .xv-speed"), exit: !!box.querySelector('.ytp-pill-right [data-act="close-viewer"]'),
        title: [...box.querySelectorAll(".xv-cur .ytp-chrome-top")].filter(shown).length,
        name: (box.querySelector(".xv-cur .xv-name") || {}).textContent || "",
        actions: box.querySelectorAll(".xv-cur .xv-pills .action").length,
        more: shown(box.querySelector(".xv-cur .xv-more-cue")) ? 1 : 0
      };
    });
    const tag = vp.name + ": ";
    if (geo.bars !== 0) fail(tag + "the old bar under the clip is still there");
    if (geo.progress !== 1) fail(tag + "expected one progress line, saw " + geo.progress);
    if (geo.fill !== "rgb(255, 0, 0)") fail(tag + "progress line is not red: " + geo.fill);
    if (!geo.speed || !geo.exit) fail(tag + "speed or exit full screen did not move into the player");
    if (geo.title) fail(tag + "the player's own title pill doubles the post text");
    if (!/Test Author 1/.test(geo.name) || geo.actions < 4) fail(tag + "post author or action pills missing");
    if (!geo.more) fail(tag + "Show more cue missing on a clamped post");
    if (geo.pills.bottom > geo.chrome.top + 1 || geo.info.bottom > geo.chrome.top + 1) fail(tag + "post text or pills overlap the controls " + JSON.stringify(geo));
    if (Math.abs(geo.player.bottom - vp.height) > 1) fail(tag + "player does not reach the bottom of the screen " + JSON.stringify(geo.player));
    await page.evaluate(() => document.querySelector("#viewer .xv-cur .xv-media")._ytPlayer.resetAutoHide_());
    await page.click('#viewer .ytp-pill-right [data-act="xv-speed"]');
    await page.waitForFunction(() => document.querySelector("#viewer .xv-cur video"), null, { timeout: 5000 });
    const rate = await page.evaluate(() => [document.querySelector("#viewer .xv-cur video").playbackRate, document.querySelector("#viewer .xv-speed").textContent]);
    if (rate[0] !== 1.25 || rate[1] !== "1.25x") fail(tag + "speed button did not step to 1.25x: " + rate);
    if (vp.touch) {
      await page.evaluate(() => { const st = document.querySelector("#viewer .xv-cur .xv-media"); st._ytPlayer.setAutoHide_(false); });
      await page.touchscreen.tap(Math.round(vp.width / 2), Math.round(vp.height / 4));
      await page.waitForTimeout(350);
      const hidden = await page.evaluate(() => { const b = document.getElementById("viewer"); return [b.classList.contains("xv-chrome-off"), getComputedStyle(b.querySelector(".xv-cur .xv-info")).opacity, getComputedStyle(b.querySelector(".xv-cur .ytp-chrome-bottom")).opacity]; });
      if (!hidden[0] || hidden[1] !== "0" || hidden[2] !== "0") fail(tag + "tap did not hide controls and text together: " + hidden);
      await page.touchscreen.tap(Math.round(vp.width / 2), Math.round(vp.height / 4));
      await page.waitForTimeout(350);
      const back = await page.evaluate(() => document.getElementById("viewer").classList.contains("xv-chrome-off"));
      if (back) fail(tag + "second tap did not bring the controls back");
    }
    await page.click('#viewer .ytp-pill-right [data-act="close-viewer"]');
    await page.waitForTimeout(500);
    if (!(await page.evaluate(() => document.getElementById("viewer").hidden))) fail(tag + "exit full screen did not close the viewer");
    if (errors.length) fail(tag + "page errors: " + errors.join(" | "));
    await ctx.close();
    console.log(tag + "ok");
  }
  console.log("xv one player test ok");
} finally {
  await browser.close();
  server.close();
}
