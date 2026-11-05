#!/usr/bin/env node
/* X video fallback. Synthetic post ids only.
   A missing file mounts the official embed in the click turn.
   A failed mp4 swaps to that embed. An embed error shows Open on X.
   A GIF stays looped and muted. No click shield is added.
   Records element attributes only. Does not read frames. */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const STATUS = "1000000000000001";
const GIF_ID = "1000000000000002";
const EMBED = "https://platform.twitter.com/embed/Tweet.html?id=" + STATUS + "&theme=dark&dnt=true";
const OPEN = "https://x.com/i/status/" + STATUS;
const MP4 = "https://video.twimg.com/ext_tw_video/" + STATUS + "/vid/avc1/1280x720/a.mp4";
const GIF = "https://video.twimg.com/tweet_video/" + GIF_ID + ".mp4";

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>x playback</title>
<style>
  #slot { position: relative; width: 480px; height: 270px; background: #000; }
  .vshield, .ytp-video-click-target { position: absolute; inset: 0; background: transparent; }
</style>
</head>
<body>
<button id="miss" type="button">Missing</button>
<button id="fail" type="button">Fail file</button>
<button id="gif" type="button">GIF</button>
<button id="resolve" type="button">Resolve</button>
<div id="slot"></div>
<script src="/video-embed.js"></script>
<script>
window.__order = [];
window.__sync = null;
window.__file = null;
window.__gif = null;
window.__swapped = null;
var orig = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (name, value) {
  if (this.tagName === "IFRAME") window.__order.push("attr:" + name);
  return orig.apply(this, arguments);
};
var desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
Object.defineProperty(HTMLIFrameElement.prototype, "src", {
  configurable: true,
  get: function () { return desc.get.call(this); },
  set: function (value) {
    window.__order.push("src");
    desc.set.call(this, value);
  }
});
var E = window.ViktorychEmbed;
var slot = document.getElementById("slot");
function reset() {
  slot._gen = (slot._gen || 0) + 1;
  slot.textContent = "";
  slot.className = "";
  window.__swapped = null;
}
new MutationObserver(function () {
  var frame = slot.querySelector("iframe.x-embed-frame");
  if (!frame || window.__swapped) return;
  window.__swapped = snap(frame);
}).observe(slot, { childList: true, subtree: true });
function snap(frame) {
  return {
    src: frame ? (frame.getAttribute("src") || "") : "",
    policy: frame ? (frame.getAttribute("referrerpolicy") || "") : "",
    allow: frame ? (frame.getAttribute("allow") || "") : "",
    playsinline: !!(frame && frame.hasAttribute("playsinline")),
    shield: !!slot.querySelector(".vshield, .ytp-video-click-target"),
    video: !!slot.querySelector("video")
  };
}
document.getElementById("miss").addEventListener("click", function () {
  reset();
  window.__order = [];
  E.runXPlayback(slot, {
    plan: { primary: null, embedUrl: E.xEmbedUrl(${JSON.stringify(STATUS)}), openUrl: E.xOpenUrl(${JSON.stringify(STATUS)}, "status") },
    linkLabel: "Open on X"
  });
  window.__sync = snap(slot.querySelector("iframe.x-embed-frame"));
  window.__sync.order = window.__order.slice();
});
document.getElementById("fail").addEventListener("click", function () {
  reset();
  E.runXPlayback(slot, {
    plan: {
      primary: { kind: "mp4", url: ${JSON.stringify(MP4)}, origin: ${JSON.stringify(MP4)} },
      embedUrl: E.xEmbedUrl(${JSON.stringify(STATUS)}),
      openUrl: E.xOpenUrl(${JSON.stringify(STATUS)}, "status")
    },
    linkLabel: "Open on X",
    stallMs: 3000
  });
  window.__file = slot.querySelector("video") ? "video" : (slot.querySelector("iframe") ? "embed" : "none");
});
document.getElementById("resolve").addEventListener("click", function () {
  reset();
  E.runXPlayback(slot, {
    plan: { primary: null, embedUrl: E.xEmbedUrl(${JSON.stringify(STATUS)}), openUrl: E.xOpenUrl(${JSON.stringify(STATUS)}, "status") },
    gif: true,
    stallMs: 3000,
    refresh: function () {
      return Promise.resolve({ kind: "mp4", url: ${JSON.stringify(MP4)}, alts: [${JSON.stringify(GIF)}] });
    }
  });
  window.__resolving = slot.classList.contains("is-resolving") && !slot.querySelector("iframe");
});
document.getElementById("gif").addEventListener("click", function () {
  reset();
  E.runXPlayback(slot, {
    plan: {
      primary: { kind: "mp4", url: ${JSON.stringify(GIF)}, origin: ${JSON.stringify(GIF)} },
      embedUrl: E.xEmbedUrl(${JSON.stringify(GIF_ID)}),
      openUrl: E.xOpenUrl(${JSON.stringify(GIF_ID)}, "status")
    },
    gif: true,
    preview: true,
    stallMs: 3000
  });
});
</script>
</body>
</html>`;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

function chromeBin() {
  const listed = [process.env.CHROME_PATH, process.env.CHROME_BIN, "/usr/local/bin/google-chrome", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const bin of listed) {
    if (!bin) continue;
    if (bin.includes("/")) {
      try { statSync(bin); return bin; } catch (err) { continue; }
    }
    const found = spawnSync("which", [bin], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error("Chrome is not installed");
}

async function loadChromium() {
  const listed = [
    process.env.PLAYWRIGHT_CORE,
    "/tmp/pw/node_modules/playwright-core/index.mjs",
    "playwright",
    "playwright-core"
  ];
  let last = null;
  for (const name of listed) {
    if (!name) continue;
    const spec = name.startsWith("/") ? pathToFileURL(name).href : name;
    try {
      const mod = await import(spec);
      const chromium = mod.chromium || (mod.default && mod.default.chromium);
      if (chromium) return chromium;
      last = new Error("playwright-core did not export chromium");
    } catch (err) { last = err; }
  }
  throw last || new Error("playwright-core is not installed");
}

/* A 64x64 black H.264 clip. The site shard used to apt-install ffmpeg only
   to build this, and that download used the whole 15 minute job. */
function tinyMp4() {
  return readFileSync(join(import.meta.dirname || ".", "fixtures/black-64.mp4"));
}

function serve(root, helperName) {
  const helper = readFileSync(join(resolve(root), helperName));
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/video-embed.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(helper);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/play.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("missing");
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      done({ server, origin: "http://127.0.0.1:" + address.port });
    });
  });
}

function assertNoHandle(value, label) {
  const text = String(value || "");
  if (/@/.test(text) || /\/i\/status\/[A-Za-z]/.test(text)) throw new Error(label + " includes a handle");
}

async function main() {
  const root = arg("--root", resolve(join(import.meta.dirname || ".", "..")));
  const chromium = await loadChromium();
  const mp4 = tinyMp4();
  const { server, origin } = await serve(root, "video-embed.js");
  const browser = await chromium.launch({
    executablePath: chromeBin(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"]
  });
  const relayed = [];
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    page.on("request", (req) => {
      if (String(req.url()).indexOf("/v1/media") >= 0) relayed.push(req.url());
    });
    await page.route("https://video.twimg.com/**", async (route) => {
      const url = route.request().url();
      if (url.indexOf(GIF_ID) >= 0) {
        await route.fulfill({ status: 200, contentType: "video/mp4", body: mp4 });
        return;
      }
      await route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
    });
    await page.route("https://platform.twitter.com/**", (route) => route.abort("failed"));
    await page.goto(origin + "/play.html", { waitUntil: "domcontentloaded" });

    await page.click("#miss");
    const sync = await page.evaluate(() => window.__sync);
    if (!sync || !sync.src) throw new Error("a missing file did not mount the embed in the click");
    if (sync.src !== EMBED) throw new Error("embed src " + sync.src);
    if (sync.policy !== "strict-origin-when-cross-origin") throw new Error("referrer policy " + sync.policy);
    if (!sync.playsinline) throw new Error("embed is missing playsinline");
    if (sync.allow.indexOf("autoplay") < 0 || sync.allow.indexOf("picture-in-picture") < 0) throw new Error("embed allow " + sync.allow);
    if (sync.shield) throw new Error("a shield covers the embed");
    const policyAt = sync.order.indexOf("attr:referrerpolicy");
    const srcAt = sync.order.indexOf("src");
    if (policyAt < 0 || srcAt < 0 || policyAt > srcAt) throw new Error("referrer policy was not set before src");
    assertNoHandle(sync.src, "embed");

    await page.waitForSelector("a.x-open", { timeout: 8000 });
    const opened = await page.evaluate(() => {
      const link = document.querySelector("a.x-open");
      return { href: link ? link.href : "", text: link ? link.textContent : "", frame: !!document.querySelector("iframe"), shield: !!document.querySelector(".vshield, .ytp-video-click-target") };
    });
    if (opened.href !== OPEN) throw new Error("open link " + opened.href);
    if (opened.text !== "Open on X") throw new Error("open label " + opened.text);
    if (opened.frame) throw new Error("the failed embed stayed on screen");
    if (opened.shield) throw new Error("a shield stayed after the embed failed");
    assertNoHandle(opened.href, "open link");

    await page.click("#fail");
    const during = await page.evaluate(() => window.__file);
    if (during !== "video") throw new Error("the click did not start the file, saw " + during);
    await page.waitForFunction(() => window.__swapped && window.__swapped.src);
    const swapped = await page.evaluate(() => window.__swapped);
    if (swapped.video) throw new Error("the failed file stayed on screen");
    if (swapped.src !== EMBED) throw new Error("swapped src " + swapped.src);
    if (swapped.policy !== "strict-origin-when-cross-origin") throw new Error("swapped policy " + swapped.policy);
    if (!swapped.playsinline) throw new Error("swapped embed is missing playsinline");
    if (swapped.allow.indexOf("autoplay") < 0 || swapped.allow.indexOf("picture-in-picture") < 0) throw new Error("swapped allow " + swapped.allow);
    if (swapped.shield) throw new Error("a shield covers the swapped embed");

    await page.click("#gif");
    await page.waitForFunction(() => {
      const video = document.querySelector("#slot video");
      return !!(video && video.videoWidth > 0);
    }, null, { timeout: 8000 });
    const gif = await page.evaluate(() => {
      const video = document.querySelector("#slot video");
      return {
        loop: !!(video && video.loop),
        muted: !!(video && video.muted),
        playsinline: !!(video && (video.playsInline || video.hasAttribute("playsinline"))),
        policy: video ? (video.getAttribute("referrerpolicy") || "") : "",
        pip: !!(video && video.disablePictureInPicture),
        frame: !!document.querySelector("iframe"),
        shield: !!document.querySelector(".vshield, .ytp-video-click-target")
      };
    });
    if (!gif.loop || !gif.muted) throw new Error("GIF is not looping muted");
    if (!gif.playsinline) throw new Error("GIF is missing playsinline");
    if (gif.policy !== "no-referrer") throw new Error("GIF referrer " + gif.policy);
    if (gif.pip) throw new Error("picture in picture is disabled");
    if (gif.frame) throw new Error("a playing GIF swapped to the embed");
    if (gif.shield) throw new Error("a shield covers the GIF");
    if (relayed.length) throw new Error("playback used the media relay");

    // No file in our data: the resolver finds one, a failed direct file moves
    // to the next route, and our own player plays it. No embed loads.
    await page.click("#resolve");
    if (!(await page.evaluate(() => window.__resolving))) throw new Error("a missing file did not resolve before the embed");
    await page.waitForFunction(() => {
      const video = document.querySelector("#slot video");
      return !!(video && video.videoWidth > 0);
    }, null, { timeout: 10000 });
    const resolved = await page.evaluate(() => ({ frame: !!document.querySelector("#slot iframe, #slot .vembed-tap"), resolving: document.getElementById("slot").classList.contains("is-resolving"), src: (document.querySelector("#slot video") || {}).currentSrc || "" }));
    if (resolved.frame) throw new Error("the embed loaded although a file resolved");
    if (resolved.resolving) throw new Error("the resolving state stayed on");
    if (resolved.src.indexOf(GIF_ID) < 0) throw new Error("resolved file src " + resolved.src);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
  const out = join(tmpdir(), "x-video-play-ok.txt");
  writeFileSync(out, "ok\n");
  console.log("x video playback checks passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
