/* Emoji stay text. Complex sequences are one run. The fallback face is
   not requested for ordinary text. Desktop and phone. */
import fs from "node:fs";
import vm from "node:vm";
import http from "node:http";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONT = "https://cdn.jsdelivr.net/npm/@fontsource/noto-color-emoji@5.2.8/files/noto-color-emoji-emoji-400-normal.woff2";
function fail(message) { console.error(message); process.exitCode = 1; throw new Error(message); }

const sandbox = { console };
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(root, "emoji.js"), "utf8"), sandbox);
const api = sandbox.ViktorychEmoji;
if (!api) fail("emoji helper did not load");
const literal = api.text('a < b & "c"');
if (literal.indexOf("<") >= 0 || literal.indexOf("&lt;") < 0 || literal.indexOf("&amp;") < 0) fail("literal text was not escaped " + literal);
const family = "👨‍👩‍👧‍👦";
const skin = "👍🏽";
const flag = "🇬🇧";
const keycap = "0️⃣";
const heart = "❤️";
const newer = "🩷";
const html = api.text("Hi " + family + " " + skin + " " + flag + " " + keycap + " " + heart + " " + newer);
for (const seq of [family, skin, flag, keycap, heart, newer]) {
  if (html.indexOf(seq) < 0) fail("missing sequence " + seq);
}
if ((html.match(new RegExp(family, "g")) || []).length !== 1) fail("the family was split");
const span = html.match(/<span class="emo">([^<]+)<\/span>/);
if (!span || span[1] !== family) fail("the family is not one run " + html);
if (api.mark("<b>" + family + "</b>").indexOf("<b><span class=\"emo\">" + family + "</span></b>") < 0) fail("a tag was rewritten");
if (api.mark("a &amp; " + flag).indexOf("&amp;amp;") >= 0) fail("escaped text was escaped again");
console.log("emoji text ok");

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  return mod.chromium || (mod.default && mod.default.chromium);
}

function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    const file = path.normalize(path.join(root, rel === "/" ? "/emoji.js" : rel));
    if (!file.startsWith(root + path.sep) && file !== path.join(root, "emoji.js")) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const type = file.endsWith(".css") ? "text/css" : "text/javascript";
      res.writeHead(200, { "content-type": type + "; charset=utf-8", "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  let fontBytes = 0;
  try {
    const head = await fetch(FONT, { method: "HEAD" });
    fontBytes = Number(head.headers.get("content-length")) || 0;
    console.log("fallback font bytes " + fontBytes);
    if (fontBytes && fontBytes > 8 * 1024 * 1024) fail("the fallback face is larger than 8 MB");
  } catch (err) {
    console.log("fallback font size was not measured");
  }
  try {
    for (const size of [{ name: "phone", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 800 }]) {
      const context = await browser.newContext({ viewport: size });
      const page = await context.newPage();
      const hits = [];
      await page.route("**/noto-color-emoji*", (route) => { hits.push(route.request().url()); return route.abort(); });
      await page.goto("http://127.0.0.1:" + port + "/emoji.js", { waitUntil: "domcontentloaded" });
      await page.setContent(`<!doctype html><html><head><style>
        body { font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", emoji, sans-serif; }
        .emo.fb { font-family: "Viktorych Emoji", emoji, sans-serif; }
        @font-face { font-family: "Viktorych Emoji"; font-display: swap; src: url("${FONT}") format("woff2"); unicode-range: U+200D, U+FE0F, U+20E3, U+1F1E6-1FAFF, U+E0020-E007F; }
      </style><script src="http://127.0.0.1:${port}/emoji.js"></script></head><body><p id="plain">Just words</p></body></html>`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(200);
      if (hits.length) fail(size.name + " asked for the fallback face with no emoji");
      const sample = "Hi " + family + " " + skin + " " + flag + " " + keycap + " " + heart + " " + newer + " <tag>";
      await page.evaluate((value) => {
        document.body.insertAdjacentHTML("beforeend", '<div id="post">' + window.ViktorychEmoji.text(value) + "</div>");
        window.ViktorychEmoji.settle();
      }, sample);
      const read = await page.evaluate((seq) => {
        const post = document.getElementById("post");
        const span = post.querySelector(".emo");
        return {
          text: post.textContent,
          family: span ? span.textContent : "",
          html: post.innerHTML.indexOf("<tag>")
        };
      }, family);
      if (read.text.indexOf(family) < 0 || read.text.indexOf(skin) < 0 || read.text.indexOf(flag) < 0 || read.text.indexOf(keycap) < 0 || read.text.indexOf(newer) < 0) fail(size.name + " dropped an emoji");
      if (read.family !== family) fail(size.name + " family run " + read.family);
      if (read.html >= 0) fail(size.name + " kept a raw tag");
      const box = await page.locator("#post .emo").first().boundingBox();
      if (!box || box.width < 4 || box.height < 4) fail(size.name + " emoji run has no box");
      await context.close();
    }
    console.log("emoji display ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
