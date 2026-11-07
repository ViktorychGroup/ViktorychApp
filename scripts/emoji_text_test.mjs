/* Emoji stay text. Complex sequences are one run. The fallback face is
   not requested for ordinary text. Desktop and phone. */
import fs from "node:fs";
import vm from "node:vm";
import http from "node:http";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONT = "https://cdn.jsdelivr.net/npm/@fontsource/noto-color-emoji@5.2.8/files/noto-color-emoji-emoji-400-normal.woff2";
const TEST_FONT = "AAEAAAAKAIAAAwAgT1MvMkD2RrsAAAEoAAAAYGNtYXAAHvWhAAABkAAAAFBnbHlmJ1M9lAAAAegAAAAYaGVhZDUQLfoAAACsAAAANmhoZWEK8gibAAAA5AAAACRobXR4CvAAAAAAAYgAAAAIbG9jYQAMAAAAAAHgAAAABm1heHAABAAGAAABCAAAACBuYW1lDgRw3gAAAgAAAAB4cG9zdGZnd9wAAAJ4AAAALAABAAAAAQAAVetplV8PPPUAAwPoAAAAAOcU9P0AAAAA5xT0/QAAAAAH0AMgAAAAAwACAAAAAAAAAAEAAAMg/zgAAAiYAAAAyAfQAAEAAAAAAAAAAAAAAAAAAAACAAEAAAACAAQAAQAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwV4AZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAPz8/PwAA/////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAACWAAACJgAAAAAAAMAAAADAAAAHAADAAEAAAAcAAMACgAAADQABAAYAAAAAgACAAAAAP//AAD//wABAAAADAAAAAAAHAAAAAAAAAABAAH6dwAB+ncAAAABAAAAAAAMAAAAAQAAAAAH0AMgAAMAADERIREH0AMg/OAAAAAEADYAAQAAAAAAAQAPAAAAAQAAAAAAAgAHAA8AAwABBAkAAQAeABYAAwABBAkAAgAOADRWaWt0b3J5Y2ggRW1vamlSZWd1bGFyAFYAaQBrAHQAbwByAHkAYwBoACAARQBtAG8AagBpAFIAZQBnAHUAbABhAHIAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAABAgVoZWFydA==";
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
const hostile = '<a title="😀" href="https://example.com/😀?x=1">hi ' + family + '</a><a title="foo>😀" href="https://example.com/ok">z</a><img alt="😀" src="https://example.com/a.png">';
const kept = api.mark(hostile);
if (kept.indexOf('href="https://example.com/😀?x=1"') < 0) fail("href gained a span " + kept);
if (kept.indexOf('title="😀"') < 0 || kept.indexOf('title="foo>😀"') < 0) fail("title gained a span " + kept);
if (kept.indexOf('alt="😀"') < 0) fail("alt gained a span " + kept);
if (kept.indexOf('title="<span') >= 0 || kept.indexOf('href="<span') >= 0 || kept.indexOf('alt="<span') >= 0) fail("attribute was rewritten " + kept);
const { clipEmoji } = await import("../shared/presence.js");
const savedSeg = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
const clipped = clipEmoji(family + "ABCDEFGH", 2);
if (savedSeg) Object.defineProperty(Intl, "Segmenter", savedSeg);
if (clipped !== family + "A") fail("a missing Segmenter split the family " + clipped);
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
      const type = file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : "text/javascript";
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
      const rich = '<a title="😀" href="https://example.com/😀?x=1">hi ' + family + '</a><a title="foo>😀" href="https://example.com/ok">z</a>';
      const attrs = await page.evaluate((sample) => {
        const html = window.ViktorychEmoji.mark(sample);
        const doc = new DOMParser().parseFromString(html, "text/html");
        const links = [...doc.querySelectorAll("a")];
        return {
          href: links[0] && links[0].getAttribute("href"),
          title: links[0] && links[0].getAttribute("title"),
          title2: links[1] && links[1].getAttribute("title"),
          text: links[0] ? links[0].textContent : ""
        };
      }, rich);
      if (attrs.href !== "https://example.com/😀?x=1" || attrs.title !== "😀" || attrs.title2 !== "foo>😀") fail(size.name + " rich link changed " + JSON.stringify(attrs));
      if (attrs.text.indexOf(family) < 0) fail(size.name + " rich text lost the family");
      await page.setContent(`<!doctype html><meta charset="utf-8"><style>
        .emo.fb { font-family: "Viktorych Emoji", sans-serif; font-size: 32px; }
        @font-face { font-family: "Viktorych Emoji"; src: url(data:font/ttf;base64,${TEST_FONT}) format("truetype"); unicode-range: U+1FA77; }
      </style><script src="http://127.0.0.1:${port}/emoji.js"></script><body><div id="slot"></div></body>`, { waitUntil: "domcontentloaded" });
      await page.evaluate((pink) => {
        window.__viktorychEmojiMiss = function (seq) { return seq === pink; };
        document.getElementById("slot").innerHTML = window.ViktorychEmoji.text(pink);
        window.ViktorychEmoji.settle();
      }, newer);
      await page.evaluate(() => document.fonts.load('32px "Viktorych Emoji"'));
      const drawn = await page.locator("#slot .emo.fb").evaluate((el) => el.getBoundingClientRect().width);
      if (!(drawn > 40)) fail(size.name + " fallback face did not draw the simple emoji " + drawn);
      await context.close();
    }
    const lead = "A".repeat(278);
    const previewText = lead + family + " trailing words after the joined family";
    const fixture = JSON.stringify({
      updated: new Date().toISOString(),
      feeds: [{ id: "rss:lane0", platform: "rss", handle: "lane0", name: "Lane Zero", title: "Lane Zero", avatar: "", bio: "", url: "https://example.com/lane0", configured: true }],
      posts: [{
        id: "preview1", statusId: "preview1", platform: "rss", feedId: "rss:lane0", kind: "post",
        author: "Lane Zero", handle: "lane0", text: previewText, lang: "en", links: [],
        date: new Date().toISOString(), url: "https://example.com/preview1",
        media: [], images: [], repostedBy: null, replyingTo: null, quoted: null,
        stats: { replies: 0, reposts: 0, likes: 0, views: 0 }
      }]
    });
    const preview = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    await preview.addInitScript(() => {
      try { Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true }); } catch (err) { /* the page check reports this */ }
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorychapp-lang-user-picked", "1");
      localStorage.setItem("superintelapp-lang", "en");
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
        token: "tok",
        account: { publicId: "111122223333", handle: "user_a", displayName: "User A", repostsLoaded: true }
      }));
    });
    const card = await preview.newPage();
    await card.route("**/*", (route) => {
      const url = route.request().url();
      if (url.indexOf("feeds.json") >= 0) return route.fulfill({ status: 200, contentType: "application/json", body: fixture });
      if (url.startsWith("http://127.0.0.1:" + port + "/")) return route.continue();
      return route.abort();
    });
    await card.goto("http://127.0.0.1:" + port + "/index.html#/home", { waitUntil: "domcontentloaded" });
    const seg = await card.evaluate(() => typeof Intl.Segmenter);
    if (seg !== "undefined") fail("Segmenter was still available for the preview " + seg);
    await card.waitForFunction(() => document.querySelector('article[data-post="preview1"]'), null, { timeout: 20000 });
    const shown = await card.evaluate(() => document.querySelector('article[data-post="preview1"]').innerText);
    const split = Array.from(previewText).slice(0, 280).join("");
    if (shown.indexOf(lead) < 0) fail("preview lost the letters before the family");
    if (shown.indexOf(family) >= 0 || shown.indexOf("\u200D") >= 0 || shown.indexOf("👨") >= 0) fail("preview split or kept the family " + JSON.stringify(shown.slice(260, 340)));
    if (shown.indexOf(split) >= 0) fail("preview used a code point slice");
    await preview.close();
    console.log("emoji display ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
