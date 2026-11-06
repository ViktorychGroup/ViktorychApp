/* Link previews: a post with a link shows an X-style card. Big image card
   for summary_large_image pages, small card for summary pages, an embedded
   post for X and Bluesky links, a video card for YouTube, a domain chip for a
   page with no tags, and no card when the post already has media. Each URL
   is unfurled once and a reload reads the browser cache. With data saving on,
   no card image loads. Synthetic pages only; no accounts or names. */
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdtempSync, statSync, readFileSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { handleUnfurl } from "../worker/src/unfurl.js";
import { parseMeta, safeTarget } from "../shared/unfurl-meta.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;
function check(ok, message) {
  if (ok) { console.log("link preview ok: " + message); return; }
  failed = true;
  console.error("link preview FAIL: " + message);
}

// Pure parser checks.
const big = parseMeta(`<html><head><meta property="og:title" content="Big &amp; bold"><meta property="og:description" content="Desc"><meta property="og:image" content="/img/big.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta property="og:site_name" content="News"></head>`, "https://news.fixture.test/big");
check(big && big.title === "Big & bold" && big.image === "https://news.fixture.test/img/big.jpg" && big.large === true && big.domain === "news.fixture.test", "parser reads og tags, entities, relative images, large card");
const small = parseMeta(`<head><title>Small page</title><meta name="twitter:card" content="summary"><meta name="twitter:image" content="https://cdn.fixture.test/s.png"></head>`, "https://blog.fixture.test/small");
check(small && small.title === "Small page" && small.large === false, "twitter:card summary is a small card");
check(parseMeta("<head><title></title></head>", "https://x.test/") === null, "a page without tags has no card");
check(!safeTarget("http://127.0.0.1/") && !safeTarget("http://localhost:8080/") && !safeTarget("file:///etc/passwd") && !safeTarget("http://[::1]/") && !safeTarget("https://a.internal/") && !!safeTarget("https://example.com/a"), "unfurl refuses private and non-http targets");

const PAGES = {
  "https://news.fixture.test/big": `<head><meta property="og:title" content="Big story headline"><meta property="og:description" content="Story summary"><meta property="og:image" content="https://img.fixture.test/big.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"></head>`,
  "https://blog.fixture.test/small": `<head><title>Small blog post</title><meta name="twitter:card" content="summary"><meta name="twitter:image" content="https://img.fixture.test/small.png"><meta name="description" content="Short note"></head>`,
  "https://dead.fixture.test/none": `<html><body>nothing</body></html>`
};
const pageHits = {};
async function fakeFetch(url) {
  pageHits[url] = (pageHits[url] || 0) + 1;
  if (url.startsWith("https://www.youtube.com/oembed")) return new Response(JSON.stringify({ title: "Fixture video", author_name: "Fixture channel" }), { headers: { "content-type": "application/json" } });
  const body = PAGES[url];
  if (!body) return new Response("no", { status: 404, headers: { "content-type": "text/html" } });
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}
const edge = new Map();
const cache = { async match(req) { const hit = edge.get(req.url); return hit ? hit.clone() : undefined; }, async put(req, res) { edge.set(req.url, res.clone()); } };
const r2 = new Map();
const bucket = { async get(key) { return r2.has(key) ? { text: async () => r2.get(key) } : null; }, async put(key, value) { r2.set(key, value); } };
let unfurlCalls = 0;

const STATUS = "1000000000000000001";
const fxStatus = { code: 200, status: { id: STATUS, url: "https://x.com/someone/status/" + STATUS, text: "Quoted words here\nhttps://news.fixture.test/big", created_at: "Wed Oct 28 10:00:00 +0000 2026", author: { name: "Fixture Person", screen_name: "fixture", avatar_url: "" }, likes: 1, replies: 0, reposts: 0, card: { url: "https://news.fixture.test/big", title: "Big story headline", description: "Story summary", domain: "news.fixture.test", image: { width: 800, height: 419, url: "https://pbs.twimg.com/card_img/1/abc?format=jpg&name=800x419" } } } };
const bskyThread = { thread: { post: { uri: "at://fixture.bsky/app.bsky.feed.post/abc", author: { handle: "fixture.bsky", displayName: "Sky Fixture", avatar: "" }, record: { text: "Hello from the sky", createdAt: "2026-10-28T10:00:00Z" }, embed: null } } };

const post = (id, text, extra) => Object.assign({ id, statusId: id, platform: "rss", feedId: "src-" + id, kind: "post", date: new Date(Date.parse("2026-10-29T07:00:00Z") - Number(id.replace(/\D/g, "")) * 60000).toISOString(), text, title: id, author: "src-" + id, handle: "src-" + id }, extra || {});
const posts = [
  post("p1", "Big one https://news.fixture.test/big"),
  post("p2", "Small one https://blog.fixture.test/small"),
  post("p3", "Quote https://x.com/someone/status/" + STATUS),
  post("p4", "Dead https://dead.fixture.test/none"),
  post("p5", "Video https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
  post("p6", "Sky https://bsky.app/profile/fixture.bsky/post/abc"),
  post("p7", "Has media https://news.fixture.test/big", { media: [{ type: "photo", url: "https://img.fixture.test/photo.jpg", width: 800, height: 600 }] }),
  post("p8", "Same link again https://news.fixture.test/big")
];
const ids = posts.map((row) => row.feedId);
const catalog = { updated: "2026-10-29T07:00:00Z", feeds: ids.map((id) => ({ id, platform: "rss", handle: id, name: id })), posts };
const config = { feeds: ids.map((id) => ({ id, platform: "rss", adapter: "rss", handle: id, source_urls: ["https://fixture.test/" + id] })) };

function contentType(file) {
  return { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" }[extname(file)] || "application/octet-stream";
}

function startServer() {
  const server = createServer(async (req, res) => {
    const full = new URL(req.url, "http://127.0.0.1");
    const p = decodeURIComponent(full.pathname);
    const json = (body, status) => { res.writeHead(status || 200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    if (p === "/feeds.json") return json(catalog);
    if (p === "/feeds.config.json") return json(config);
    if (p === "/v1/unfurl") {
      unfurlCalls += 1;
      const out = await handleUnfurl(new Request("https://api.fixture.test" + req.url), { fetch: fakeFetch, cache, r2: bucket, now: () => Date.now() });
      res.writeHead(out.status, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(await out.text());
    }
    if (p.startsWith("/v1/")) return json({ error: "none" }, 404);
    if (p === "/accounts.config.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      return res.end(readFileSync(join(root, "accounts.config.js"), "utf8").replace('api: ""', 'api: location.origin'));
    }
    const file = join(root, p === "/" ? "index.html" : p.replace(/^\/+/, ""));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  return mod.chromium || (mod.default && mod.default.chromium);
}

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const port = server.address().port;
  const launch = { args: ["--no-sandbox"], viewport: { width: 600, height: 4000 }, serviceWorkers: "block" };
  if (process.env.CHROME) launch.executablePath = process.env.CHROME;
  else launch.channel = "chrome";
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "link-preview-")), launch);
  const imageLoads = [];
  const embedLoads = [];
  try {
    await ctx.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("http://127.0.0.1")) return route.continue();
      if (url.startsWith("https://api.fxtwitter.com/2/status/" + STATUS)) return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(fxStatus) });
      if (url.startsWith("https://public.api.bsky.app/")) return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(bskyThread) });
      if (url.startsWith("https://www.youtube-nocookie.com/embed/")) { embedLoads.push(url); return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>player</title>" }); }
      if (/img\.fixture\.test|i\.ytimg\.com|pbs\.twimg\.com/.test(url)) { imageLoads.push(url); return route.fulfill({ status: 200, contentType: "image/png", body: PIXEL }); }
      return route.fulfill({ status: 404, body: "{}" });
    });
    let page = ctx.pages()[0] || await ctx.newPage();
    page.on("pageerror", (err) => console.error("pageerror", err.message));
    await page.addInitScript((FOLLOWS) => {
      if (location.protocol !== "http:") return;
      localStorage.setItem("viktorychapp-lang-user-picked", "1");
      localStorage.setItem("superintelapp-lang", "en");
      if (!localStorage.getItem("viktorychapp-settings-v1")) localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, follows: FOLLOWS, lists: [], feedTabs: [] }));
    }, ids);
    const read = () => page.evaluate(() => {
      const out = {};
      document.querySelectorAll("#app article.post").forEach((el) => {
        const text = el.textContent || "";
        const m = /\b(Big one|Small one|Quote|Dead|Video|Sky|Has media|Same link again)\b/.exec(text);
        if (!m) return;
        out[m[1]] = {
          large: !!el.querySelector(".link-card.lc-large"),
          small: !!el.querySelector(".link-card.lc-small"),
          text: !!el.querySelector(".link-card.lc-text"),
          chip: !!el.querySelector(".link-chip:not(.lp-slot)"),
          loading: !!el.querySelector(".lp-slot"),
          quote: !!el.querySelector(".quote:not(.lp-post)"),
          quoteText: (el.querySelector(".quote") || {}).textContent || "",
          play: !!el.querySelector(".link-card-play"),
          img: !!el.querySelector(".link-card-img"),
          domain: ((el.querySelector(".link-site") || {}).textContent || "").trim(),
          cards: el.querySelectorAll(".link-card, .link-chip, .quote").length
        };
      });
      return out;
    });
    const base = "http://127.0.0.1:" + port + "/index.html";
    await page.goto(base + "#/");
    let state = {};
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(250);
      state = await read();
      if (Object.keys(state).length >= 8 && !Object.values(state).some((row) => row.loading)) break;
    }
    const s = state; if (process.env.DEBUG) console.log(JSON.stringify(state, null, 1));
    check(s["Big one"] && s["Big one"].large && s["Big one"].img && s["Big one"].domain === "news.fixture.test", "summary_large_image page shows the big card with its domain");
    check(s["Small one"] && s["Small one"].small, "summary page shows the small card");
    check(s["Quote"] && s["Quote"].quote && /Quoted words here/.test(s["Quote"].quoteText), "an X status link embeds the quoted post");
    check(s["Dead"] && s["Dead"].chip && !s["Dead"].large, "a page without tags falls back to a domain chip");
    check(s["Video"] && s["Video"].large && s["Video"].play, "a YouTube link shows a video card with a play button");
    // Tap plays the official player in the card itself: no navigation, no
    // full screen, and the title still links to the page.
    const before0 = page.url();
    const facade = page.locator("#app article.post:has-text('Video') .lv-facade").first();
    const hadFrame = await page.locator("iframe.lv-frame").count();
    check(hadFrame === 0 && embedLoads.length === 0, "no player loads before a tap");
    await facade.click();
    await page.waitForTimeout(600);
    const tapped = await page.evaluate(() => {
      const card = document.querySelector(".lv-card.lv-on");
      const frame = card && card.querySelector("iframe.lv-frame");
      const link = card && card.querySelector("a.lv-copy");
      return { src: frame ? frame.src : "", allow: frame ? frame.getAttribute("allow") : "", link: link ? link.href : "", full: !!document.fullscreenElement, viewer: !!document.querySelector("#viewer:not([hidden])") };
    });
    check(/^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?autoplay=1&playsinline=1/.test(tapped.src) && /autoplay/.test(tapped.allow), "a tap swaps in the YouTube embed with autoplay and playsinline (" + tapped.src + ")");
    check(page.url() === before0 && !tapped.full && !tapped.viewer && /youtube\.com\/watch\?v=dQw4w9WgXcQ/.test(tapped.link), "the tap stays in the feed and the title still opens the video page");
    check(s["Sky"] && s["Sky"].quote && /Hello from the sky/.test(s["Sky"].quoteText), "a Bluesky link embeds the post");
    check(s["Has media"] && s["Has media"].cards === 0, "a post with its own media shows no page card");
    check(s["Same link again"] && s["Same link again"].large, "a repeated link reuses the same card");
    check((pageHits["https://news.fixture.test/big"] || 0) === 1, "each page is fetched once (" + (pageHits["https://news.fixture.test/big"] || 0) + ")");
    check(!imageLoads.some((u) => /name=800x419/.test(u)), "X card images load in original size");
    const before = unfurlCalls;
    await page.reload();
    let again = {};
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(250);
      again = await read();
      if (again["Big one"] && again["Big one"].large) break;
    }
    check(again["Big one"] && again["Big one"].large && unfurlCalls === before, "a reload reads cards from the browser cache (" + (unfurlCalls - before) + " new unfurl calls)");
    // Data saving: no card images load at all. Leave the app first so its
    // pagehide save cannot undo the switch, then edit storage from a plain page.
    await page.goto("about:blank");
    const helper = await ctx.newPage();
    await helper.goto("http://127.0.0.1:" + port + "/offline.html");
    await helper.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}");
      // What the Save data switch writes: the master flag plus text-only link cards.
      raw.saveData = true;
      raw.linkPreviews = "text";
      localStorage.setItem("viktorychapp-settings-v1", JSON.stringify(raw));
      // The shell repaints the last screen on boot; that copy predates the switch.
      localStorage.removeItem("viktorych-screen-v1");
    });
    await helper.close();
    imageLoads.length = 0;
    /* A service worker that claims the page can cancel this navigation.
       The data-saving assertion still runs on the page that finishes loading. */
    try {
      await page.goto(base + "#/", { waitUntil: "domcontentloaded" });
    } catch (err) {
      const msg = String(err && err.message || err);
      if (!/ERR_ABORTED|frame was detached|crashed/i.test(msg)) throw err;
      page = await ctx.newPage();
      await page.goto(base + "#/", { waitUntil: "domcontentloaded" });
    }
    let saving = {};
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(250);
      saving = await read();
      if (saving["Big one"] && !saving["Big one"].img && (saving["Big one"].text || saving["Big one"].small)) break;
    }
    if (process.env.DEBUG) console.log(JSON.stringify(saving["Big one"]), imageLoads);
    check(saving["Big one"] && !saving["Big one"].img && (saving["Big one"].text || saving["Big one"].small) && !imageLoads.some((u) => /big\.jpg|small\.png|ytimg/.test(u)), "with data saving on, cards show text only and load no image");
  } finally {
    await ctx.close();
    server.close();
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
