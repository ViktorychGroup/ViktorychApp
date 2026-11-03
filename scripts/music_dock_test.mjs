/* ViktorychMusic keeps playing while the user moves around the app. The mini
   player is one more small corner square, the size of the chat squares and
   the compose button, in their row with the same gap and never on top of
   them, above the phone bottom bar;
   controls work, the queue and position survive a reload, and other sound in
   the app pauses the music. Generated tone and placeholder titles only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

/* 40 seconds of a quiet 8 kHz tone, 8-bit mono. */
function tone(seconds) {
  const rate = 8000;
  const count = rate * seconds;
  const buf = Buffer.alloc(44 + count);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + count, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write("data", 36); buf.writeUInt32LE(count, 40);
  for (let i = 0; i < count; i += 1) buf[44 + i] = 128 + Math.round(6 * Math.sin(i / 6));
  return buf;
}
const WAV = tone(40);

function mime(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.indexOf("/media/test-tone") === 0) {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), WAV.length - 1) : WAV.length - 1;
        res.writeHead(206, { "content-type": "audio/wav", "accept-ranges": "bytes", "content-range": "bytes " + start + "-" + end + "/" + WAV.length, "content-length": end - start + 1 });
        res.end(WAV.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { "content-type": "audio/wav", "accept-ranges": "bytes", "content-length": WAV.length });
      res.end(WAV);
      return;
    }
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

/* A busy runner can land an evaluate on a page that is still settling after
   a navigation; run it again on the new document instead of failing. */
async function ev(page, fn, arg) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await page.evaluate(fn, arg); }
    catch (err) {
      if (attempt >= 3 || !/context was destroyed|navigat/i.test(String(err && err.message))) throw err;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }
  }
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}

const state = () => {
  const a = document.getElementById("mu-audio");
  const dock = document.getElementById("mu-dock");
  const box = dock && !dock.hidden ? dock.getBoundingClientRect() : null;
  const nav = document.querySelector("nav.bottom-nav");
  const navBox = nav && getComputedStyle(nav).display !== "none" ? nav.getBoundingClientRect() : null;
  return {
    paused: !a || a.paused,
    t: a ? a.currentTime : 0,
    mini: document.documentElement.classList.contains("music-mini"),
    shown: !!box && box.height > 20,
    bottom: box ? box.bottom : 0,
    top: box ? box.top : 0,
    left: box ? box.left : 0,
    right: box ? box.right : 0,
    width: box ? box.width : 0,
    height: box ? box.height : 0,
    vw: window.innerWidth,
    side: !!document.querySelector(".side") && getComputedStyle(document.querySelector(".side")).display !== "none",
    pad: (() => { const c = document.querySelector(".center"); return c ? parseFloat(getComputedStyle(c).paddingBottom) || 0 : 0; })(),
    center: (() => { const c = document.querySelector(".center"); if (!c) return null; const r = c.getBoundingClientRect(); return { left: r.left, right: r.right }; })(),
    fill: parseFloat((document.getElementById("mu-pop-fill") || { style: {} }).style.width || "0") || 0,
    navTop: navBox && navBox.height ? navBox.top : 0,
    vh: window.innerHeight,
    title: (document.getElementById("mu-dock-title") || {}).textContent || "",
    /* The other small corner squares: the chat row tiles and the compose button. */
    squares: Array.from(document.querySelectorAll("#dock-root .xdock-panel:not(.is-open), .fab")).filter((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
    }).map((el) => { const r = el.getBoundingClientRect(); return { kind: el.classList.contains("fab") ? "fab" : "chat", left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; }),
    inRow: !!(dock && dock.classList.contains("in-row")),
    hash: location.hash
  };
};

async function wait(page, label, fn, arg, opts) {
  try {
    return await page.waitForFunction(fn, arg, opts);
  } catch (err) {
    const snap = await ev(page, state).catch(() => ({}));
    const seek = await ev(page, () => { const s = document.getElementById("mu-seek"); const a = document.getElementById("mu-audio"); return s ? s.max + "/" + s.value + " dur " + a.duration + " seekable " + (a.seekable.length ? a.seekable.end(0) : 0) : ""; }).catch(() => "");
    fail(label + " timed out " + JSON.stringify(snap) + " " + seek);
  }
}

async function exercise(browser, origin, vp) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, serviceWorkers: "block" });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "" }));
  await context.addInitScript(() => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    if (!localStorage.getItem("viktorych-music-v1")) {
      localStorage.setItem("viktorych-music-v1", JSON.stringify({
        songs: [
          { id: "tone-a", title: "Tone A", artist: "Test", source: "media/test-tone-a.wav", kind: "audio" },
          { id: "tone-b", title: "Tone B", artist: "Test", source: "media/test-tone-b.wav", kind: "audio" }
        ],
        volume: 0.2
      }));
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err && err.message || err).slice(0, 160)));
  const where = vp.name;
  await page.goto(origin + "/#/music", { waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector(".mu-tile[data-id='tone-a']", { timeout: 45000 });
  } catch (err) {
    const info = await ev(page, () => {
      const keys = [];
      try { for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); if (k && k.indexOf("music") >= 0) keys.push(k); } } catch (e) { keys.push(String(e)); }
      return {
        hash: location.hash,
        ready: document.readyState,
        tiles: document.querySelectorAll(".mu-tile").length,
        grid: !!document.querySelector(".mu-grid"),
        songsKey: keys.join(","),
        appBooted: !!document.querySelector("#timeline-out, #mu-grid, nav.bottom-nav")
      };
    }).catch(() => ({}));
    fail(where + " music page did not list the test song " + JSON.stringify(info) + " pageErrors=" + JSON.stringify(errors.slice(0, 3)));
  }
  await page.click(".mu-tile[data-id='tone-a']");
  await wait(page, where + " step 134", () => { const a = document.getElementById("mu-audio"); return a && !a.paused && a.currentTime > 0.2; }, null, { timeout: 15000 });

  /* Move around the app. The audio element and its playback survive. */
  for (const hash of ["#/explore", "#/notifications", "#/"]) {
    await ev(page, (next) => { location.hash = next; }, hash);
    await wait(page, where + " step 139", (next) => location.hash === next && !document.querySelector(".mu-grid, .mu-shelf"), hash, { timeout: 15000 });
    const before = await ev(page, state);
    await page.waitForTimeout(700);
    const after = await ev(page, state);
    if (after.paused) fail(where + " music stopped on " + hash);
    if (!(after.t > before.t)) fail(where + " music is not moving on " + hash);
    if (!after.mini || !after.shown) fail(where + " mini player is missing on " + hash);
    if (after.title !== "Tone A") fail(where + " mini player title " + after.title);
    if (after.navTop && after.bottom > after.navTop + 1) fail(where + " mini player covers the bottom bar");
    if (Math.abs(after.width - after.height) > 1 || after.width > 60 || after.width < 44) fail(where + " mini player is not a small square " + after.width + "x" + after.height);
    for (const sq of after.squares) {
      if (Math.abs(sq.width - after.width) > 1 || Math.abs(sq.height - after.height) > 1) fail(where + " mini player " + after.width + "px is not the size of the " + sq.kind + " square " + sq.width + "px");
      if (after.left < sq.right && after.right > sq.left && after.top < sq.bottom && after.bottom > sq.top) fail(where + " mini player overlaps the " + sq.kind + " square");
    }
    const row = after.squares.filter((sq) => Math.abs(sq.bottom - after.bottom) < 1);
    if (!row.length) fail(where + " mini player is not in a row with the other squares " + JSON.stringify(after.squares));
    const gap = Math.min(...row.map((sq) => Math.max(sq.left - after.right, after.left - sq.right)));
    if (Math.abs(gap - 12) > 1) fail(where + " mini player gap to its neighbour is " + gap + ", not 12");
    if (where === "desktop" && !after.inRow) fail(where + " mini player is not in the chat squares row");
    if (after.right > after.vw + 1 || after.bottom > after.vh + 1 || after.left < 0 || after.top < 0) fail(where + " mini player is off screen");
    if (after.side && after.center && after.left < after.center.right && after.right > after.center.left) fail(where + " mini player covers the timeline");
    if (after.pad < after.height + 8) fail(where + " the page leaves no room under the mini player " + after.pad);
    if (!(after.fill > 0)) fail(where + " mini player progress line did not move");
  }

  /* Controls in the mini player. */
  await page.click("#mu-dock #mu-play");
  await wait(page, where + " step 153", () => document.getElementById("mu-audio").paused, null, { timeout: 5000 });
  await page.click("#mu-dock #mu-play");
  await wait(page, where + " step 155", () => !document.getElementById("mu-audio").paused, null, { timeout: 5000 });
  await page.click("#mu-dock .mu-id");
  await wait(page, where + " open for next", () => { const n = document.getElementById("mu-now"); return n && !n.hidden; }, null, { timeout: 5000 });
  await page.click("#mu-now [data-act='music-next']");
  await page.click("#mu-now [data-act='music-now-close']");
  await wait(page, where + " step 157", () => (document.getElementById("mu-dock-title") || {}).textContent === "Tone B" && !document.getElementById("mu-audio").paused, null, { timeout: 8000 });
  await ev(page, () => {
    const seek = document.getElementById("mu-seek");
    seek.max = String(Math.max(Number(seek.max) || 0, 30));
    seek.value = "12";
    seek.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await wait(page, where + " step 163", () => document.getElementById("mu-audio").currentTime >= 11.5, null, { timeout: 5000 });

  /* The mini player opens the full now playing view. */
  await page.click("#mu-dock .mu-id");
  await wait(page, where + " step 167", () => { const n = document.getElementById("mu-now"); return n && !n.hidden; }, null, { timeout: 5000 });
  await page.click("#mu-now [data-act='music-now-close']");
  await wait(page, where + " step 169", () => document.getElementById("mu-now").hidden, null, { timeout: 5000 });

  /* Other sound in the app pauses the music. */
  await ev(page, () => {
    const other = document.createElement("audio");
    other.id = "other-sound";
    other.src = "media/test-tone-c.wav";
    other.volume = 0.1;
    document.body.appendChild(other);
    const started = other.play();
    if (started && started.catch) started.catch(() => {});
  });
  await wait(page, where + " step 180", () => document.getElementById("mu-audio").paused, null, { timeout: 8000 });
  await ev(page, () => { const o = document.getElementById("other-sound"); o.pause(); o.remove(); });

  /* The queue and the position survive a reload. */
  await ev(page, () => window.dispatchEvent(new Event("pagehide")));
  await page.reload({ waitUntil: "domcontentloaded" });
  await wait(page, where + " step 186", () => document.documentElement.classList.contains("music-mini") && (document.getElementById("mu-dock-title") || {}).textContent === "Tone B", null, { timeout: 20000 });
  await page.click("#mu-dock #mu-play");
  await wait(page, where + " step 188", () => { const a = document.getElementById("mu-audio"); return !a.paused && a.currentTime >= 11; }, null, { timeout: 10000 });

  /* Close stops playback and removes the mini player. */
  if (where === "desktop") {
    await page.hover("#mu-dock .mu-id");
    await page.click("#mu-dock .mu-mini-x");
  } else {
    await page.click("#mu-dock .mu-id");
    await wait(page, where + " open to close", () => { const n = document.getElementById("mu-now"); return n && !n.hidden; }, null, { timeout: 5000 });
    await page.click("#mu-now [data-act='music-stop']");
  }
  await wait(page, where + " step 192", () => document.getElementById("mu-audio").paused && document.getElementById("mu-dock").hidden && !document.documentElement.classList.contains("music-mini"), null, { timeout: 5000 });
  if (errors.length) fail(where + " page error " + errors[0]);
  await context.close();
  console.log("ok music dock " + where);
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
  try {
    await Promise.all([
      exercise(browser, origin, { name: "phone", width: 390, height: 844 }),
      exercise(browser, origin, { name: "desktop", width: 1280, height: 800 }),
      exercise(browser, origin, { name: "tablet", width: 820, height: 1180 }),
      exercise(browser, origin, { name: "landscape", width: 844, height: 390 })
    ]);
    console.log("music dock ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message ? err.message : err);
});
