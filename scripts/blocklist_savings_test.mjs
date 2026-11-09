/* Muted & blocked saves data: with 20 of 40 sample accounts blocked, the
   Worker drops their posts before they are sent (hashed X-Block header), the
   app never requests their avatars or media, blocked sources are not fetched,
   and the first post shows no later than without blocks. Prints the numbers.
   Neutral fake handles only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pw = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : "playwright-core");
const chromium = pw.chromium || pw.default.chromium;
const blocks = (await import(pathToFileURL(path.join(root, "shared", "blocklist.js")).href)).default;
const { withBlocks } = await import(pathToFileURL(path.join(root, "worker", "src", "index.js")).href);
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml" };

function fail(msg) { throw new Error("blocklist savings: " + msg); }

const ACCOUNTS = 40;
const PER = 4;
const handles = Array.from({ length: ACCOUNTS }, (_, i) => "sample_acct_" + String(i).padStart(2, "0"));
const blocked = handles.slice(0, 20);
const IMG = Buffer.alloc(24 * 1024, 7);
const AVA = Buffer.alloc(6 * 1024, 3);
let base = "";

function catalog() {
  const now = Date.now();
  const feeds = handles.map((h) => ({ id: "x:" + h, platform: "x", handle: h, name: "Sample " + h.slice(-2), avatar: base + "/ava/" + h + ".jpg", configured: true }));
  const posts = [];
  // A fixed shuffle, so blocked and kept accounts are mixed through the feed.
  const order = handles.map((h, i) => i).sort((a, b) => ((a * 37 + 11) % 41) - ((b * 37 + 11) % 41));
  for (let n = 0; n < PER; n++) {
    order.forEach((i, slot) => {
      const h = handles[i];
      const id = String(9000000 + n * 100 + i);
      posts.push({
        id, statusId: id, platform: "x", feedId: "x:" + h, kind: "post", author: "Sample " + h.slice(-2), handle: h,
        avatar: base + "/ava/" + h + ".jpg", text: "Sample post " + n + " from account " + i + " with some words to make it a normal size.",
        links: [], date: new Date(now - (n * ACCOUNTS + slot) * 60000).toISOString(), url: "", repostedBy: null, replyingTo: null, quoted: null,
        media: [{ type: "photo", url: base + "/m/" + id + ".jpg", width: 1200, height: 800 }], images: [base + "/m/" + id + ".jpg"],
        stats: { replies: 2, reposts: 3, likes: 10 }
      });
    });
  }
  return { updated: new Date(now).toISOString(), feeds, posts };
}

const tally = { reset() { this.feedBytes = 0; this.media = 0; this.mediaBytes = 0; this.ava = 0; this.blockedMedia = 0; this.blockedAva = 0; this.live = 0; this.liveBlocked = 0; this.header = ""; this.all = 0; this.allBytes = 0; this.ext = 0; this.extBlocked = 0; } };
tally.reset();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let p = decodeURIComponent(url.pathname);
  const send = (status, body, type, extra) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    tally.all += 1;
    tally.allBytes += buf.length;
    res.writeHead(status, Object.assign({ "content-type": type || "application/octet-stream", "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-expose-headers": "x-block-removed" }, extra || {}));
    res.end(buf);
    return buf.length;
  };
  if (req.method === "OPTIONS") return send(204, "");
  if (p === "/v1/data/feeds.json") {
    tally.header = String(req.headers["x-block"] || "");
    const request = new Request("https://accounts.test" + p, { headers: tally.header ? { "X-Block": tally.header } : {} });
    const out = await withBlocks(request, new Response(JSON.stringify(catalog()), { status: 200, headers: { "content-type": "application/json" } }));
    const text = await out.text();
    tally.feedBytes += send(200, text, "application/json", { "x-block-removed": out.headers.get("x-block-removed") || "0" });
    return;
  }
  if (p.startsWith("/v1/data/live/")) {
    tally.live += 1;
    if (blocked.some((h) => p.indexOf(h) >= 0)) tally.liveBlocked += 1;
    return send(200, JSON.stringify({ posts: [] }), "application/json");
  }
  if (p.startsWith("/v1/")) return send(200, "{}", "application/json");
  if (p.startsWith("/m/") || p.startsWith("/ava/")) {
    const ava = p.startsWith("/ava/");
    const body = ava ? AVA : IMG;
    if (ava) tally.ava += 1; else tally.media += 1;
    tally.mediaBytes += body.length;
    const id = p.replace(/^\/(?:m|ava)\//, "").replace(/\.jpg$/, "");
    const who = ava ? id : handles[Number(id) % 100];
    if (blocked.indexOf(who) >= 0) { if (ava) tally.blockedAva += 1; else tally.blockedMedia += 1; }
    return send(200, body, "image/jpeg");
  }
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(root, p);
  if (!file.startsWith(root)) return send(403, "");
  fs.readFile(file, (err, body) => {
    if (err) { send(404, ""); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
base = "http://127.0.0.1:" + server.address().port;

const settingsFor = (withBlocksOn) => ({
  version: 1, initialized: true, follows: handles.map((h) => "x:" + h), seenFeeds: handles.map((h) => "x:" + h), seenDefaults: handles.map((h) => "x:" + h),
  lists: [], likes: {}, bookmarks: {}, reposts: {}, savedPosts: {}, mutedWords: [], mutedAccounts: [], repostOff: [],
  blocks: { at: 1, accounts: withBlocksOn ? blocked.map((h) => "x:" + h) : [], posts: [], sources: [], types: {}, showHidden: false }
});

async function visit(browser, withBlocksOn) {
  tally.reset();
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 2400 } });
  const settings = settingsFor(withBlocksOn);
  const header = withBlocksOn ? blocks.headerValue(blocks.rulesFromSettings(settings)) : "";
  await ctx.addInitScript(([api, settingsText, headerText]) => {
    window.VIKTORYCH_ACCOUNTS = { api: api, backupApi: "", gate: true, tiktokAudience: "owner" };
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-a", account: { handle: "user_a", displayName: "User A" } }));
    localStorage.setItem("viktorychapp-settings-v1", settingsText);
    if (headerText) localStorage.setItem("viktorychapp-block-h", headerText);
    window.__firstPost = 0;
    const seen = () => {
      if (!window.__firstPost && document.querySelector("#app article.post")) window.__firstPost = performance.now();
      if (!window.__firstPost) requestAnimationFrame(seen);
    };
    requestAnimationFrame(seen);
  }, [base, JSON.stringify(settings), header]);
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
    const u = route.request().url();
    tally.ext += 1;
    if (blocked.some((h) => u.indexOf(h) >= 0)) tally.extBlocked += 1;
    route.abort();
  });
  const page = await ctx.newPage();
  await page.goto(base + "/index.html#/home", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__firstPost > 0, null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => ({
    first: Math.round(window.__firstPost),
    shown: Array.from(document.querySelectorAll("#app article.post .handle")).map((a) => a.textContent.replace(/^@/, "")),
    stats: window.ViktorychBlockStats ? window.ViktorychBlockStats() : null,
  }));
  await ctx.close();
  return Object.assign({ header: tally.header, feedBytes: tally.feedBytes, media: tally.media, ava: tally.ava, mediaBytes: tally.mediaBytes, blockedMedia: tally.blockedMedia, blockedAva: tally.blockedAva, live: tally.live, liveBlocked: tally.liveBlocked, ext: tally.ext, extBlocked: tally.extBlocked, requests: tally.all, bytes: tally.allBytes }, info);
}

const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || "chrome" });
try {
  // Warm the disk cache of app files once so both runs compare the same way.
  await visit(browser, false);
  // Alternate runs and keep the median time to first post.
  const runs = { off: [], on: [] };
  for (let i = 0; i < 5; i++) {
    runs.off.push(await visit(browser, false));
    runs.on.push(await visit(browser, true));
  }
  const median = (list) => list.map((r) => r.first).sort((a, b) => a - b)[Math.floor(list.length / 2)];
  const before = Object.assign({}, runs.off[0], { first: median(runs.off) });
  const after = Object.assign({}, runs.on[0], { first: median(runs.on) });
  if (after.first > before.first * 1.5 + 200) fail("blocking slowed the first post " + before.first + " -> " + after.first);
  if (before.header) fail("no rules should send no header");
  if (!after.header || /sample_acct/.test(after.header)) fail("the header must carry hashes only: " + after.header.slice(0, 40));
  if (after.header.length > 220) fail("20 accounts should fit in a small header, got " + after.header.length);
  if (after.shown.some((h) => blocked.indexOf(h) >= 0)) fail("a blocked account was drawn");
  if (after.blockedMedia || after.blockedAva) fail("blocked accounts still loaded media or avatars " + JSON.stringify({ media: after.blockedMedia, ava: after.blockedAva }));
  if (after.liveBlocked || after.extBlocked) fail("a blocked source was fetched " + JSON.stringify({ live: after.liveBlocked, ext: after.extBlocked }));
  if (!(after.feedBytes < before.feedBytes * 0.7)) fail("the Worker did not drop blocked posts " + before.feedBytes + " -> " + after.feedBytes);
  const wanted = (list) => list.filter((h) => blocked.indexOf(h) < 0).length;
  if (!(wanted(after.shown) > wanted(before.shown))) fail("blocked posts used up the page " + wanted(before.shown) + " -> " + wanted(after.shown));
  const wasted = before.blockedMedia + before.blockedAva;
  const saved = {
    feedBytes: before.feedBytes + " -> " + after.feedBytes + " (" + Math.round(100 - after.feedBytes * 100 / before.feedBytes) + "% less)",
    blockedBytes: (before.blockedMedia * IMG.length + before.blockedAva * AVA.length + before.feedBytes - after.feedBytes) + " -> 0",
    bytesPerWantedPost: Math.round(before.bytes / Math.max(1, wanted(before.shown))) + " -> " + Math.round(after.bytes / Math.max(1, wanted(after.shown))),
    requestsPerWantedPost: (before.requests / Math.max(1, wanted(before.shown))).toFixed(1) + " -> " + (after.requests / Math.max(1, wanted(after.shown))).toFixed(1),
    mediaAndAvatars: (before.media + before.ava) + " -> " + (after.media + after.ava),
    blockedMediaRequests: wasted + " -> " + (after.blockedMedia + after.blockedAva) + " (" + Math.round(wasted * 100 / Math.max(1, before.media + before.ava)) + "% of the first page's media was for blocked accounts)",
    sourceFetchesOfBlocked: (before.liveBlocked + before.extBlocked) + " -> " + (after.liveBlocked + after.extBlocked),
    skippedBlockedFeedFetches: after.stats ? after.stats.skippedFeeds : 0,
    wantedPostsOnFirstPage: wanted(before.shown) + " -> " + wanted(after.shown),
    firstPostMs: before.first + " -> " + after.first + " (median of " + runs.on.length + "; runs " + runs.off.map((r) => r.first).join("/") + " vs " + runs.on.map((r) => r.first).join("/") + ")",
    headerBytes: after.header.length,
    shown: before.shown.length + " / " + after.shown.length
  };
  console.log("blocklist savings check passed", JSON.stringify(saved));

  // Blocking from a post's "..." menu applies to every open tab at once.
  {
    const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 1600 } });
    await ctx.addInitScript(([api, settingsText]) => {
      window.VIKTORYCH_ACCOUNTS = { api: api, backupApi: "", gate: true, tiktokAudience: "owner" };
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-a", account: { handle: "user_a", displayName: "User A" } }));
      if (!sessionStorage.getItem("seeded")) {
        sessionStorage.setItem("seeded", "1");
        if (!localStorage.getItem("viktorychapp-settings-v1")) localStorage.setItem("viktorychapp-settings-v1", settingsText);
      }
    }, [base, JSON.stringify(settingsFor(false))]);
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
    const a = await ctx.newPage();
    const b = await ctx.newPage();
    for (const pg of [a, b]) {
      await pg.goto(base + "/index.html#/home", { waitUntil: "domcontentloaded" });
      await pg.waitForFunction(() => document.querySelectorAll("#app article.post").length >= 5, null, { timeout: 30000 });
    }
    const target = await a.evaluate(() => {
      const art = document.querySelector("#app article.post[data-post]");
      const handle = art.querySelector(".handle").textContent.replace(/^@/, "");
      art.querySelector('[data-act="menu"]').click();
      return handle;
    });
    await a.waitForSelector('[data-act="block-account"]', { timeout: 5000 });
    await a.click('[data-act="block-account"]');
    const gone = (h) => !Array.from(document.querySelectorAll("#app article.post .handle")).some((el) => el.textContent.replace(/^@/, "") === h);
    await a.waitForFunction(gone, target, { timeout: 8000 }).catch(async (err) => {
      console.log(await a.evaluate((h) => ({ h, blocks: JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}").blocks, rows: Array.from(document.querySelectorAll("#app article.post")).slice(0, 6).map((el) => (el.querySelector(".handle") || {}).textContent + " " + el.className), toast: (document.getElementById("toast") || {}).textContent }), target));
      throw err;
    });
    const t0 = Date.now();
    await b.waitForFunction(gone, target, { timeout: 8000 }).catch(() => fail("blocking in one tab did not reach the other tab"));
    const header = await b.evaluate(() => localStorage.getItem("viktorychapp-block-h") || "");
    const hook = await b.evaluate((h) => {
      const list = window.ViktorychBlocklist;
      if (!list || typeof list.hides !== "function") return "missing";
      const reply = { id: "r1", platform: "x", handle: h, feedId: "x:" + h, kind: "reply", text: "a reply" };
      const other = { id: "r2", platform: "x", handle: "sample_other", kind: "reply", text: "a reply" };
      return list.hides(reply) && !list.hides(other) ? "ok" : "wrong";
    }, target);
    if (hook !== "ok") fail("window.ViktorychBlocklist.hides must hide a blocked account's reply and keep others (" + hook + ")");
    if (!header || header.indexOf(target) >= 0) fail("the stored header must be hashes only");
    // The other tab still holds the settings it loaded. Saving that copy must
    // not put the empty block list back. Wait until that save is on disk.
    await b.evaluate(() => { location.hash = "#/home?reposts=0"; });
    await a.waitForFunction((h) => {
      const settings = JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}");
      if (settings.forYouReposts !== false) return false;
      const kept = ((settings.blocks || {}).accounts || []).some((item) => String(item).indexOf(h) >= 0);
      const shown = Array.from(document.querySelectorAll("#app article.post .handle")).some((el) => el.textContent.replace(/^@/, "") === h);
      return kept && !shown;
    }, target, { timeout: 8000 }).catch(() => fail("a save on the other tab removed the block or showed the posts again"));
    console.log("cross-tab block check passed", JSON.stringify({ otherTabMs: Date.now() - t0 }));
    // A later write of the settings from before the block (another tab still
    // holding that copy) must not bring the posts back.
    await b.evaluate((text) => { localStorage.setItem("viktorychapp-settings-v1", text); }, JSON.stringify(settingsFor(false)));
    await a.waitForFunction((h) => {
      const settings = JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}");
      const kept = ((settings.blocks || {}).accounts || []).some((item) => String(item).indexOf(h) >= 0);
      const shown = Array.from(document.querySelectorAll("#app article.post .handle")).some((el) => el.textContent.replace(/^@/, "") === h);
      return kept && !shown;
    }, target, { timeout: 8000 }).catch(() => fail("an older settings write brought a blocked account back"));
    console.log("older settings write kept the block");
    const shownHandles = await a.evaluate(() => Array.from(document.querySelectorAll("#app article.post .handle")).map((el) => el.textContent.replace(/^@/, "")));
    const muteHandle = shownHandles.find((h) => h !== target);
    const wordHandle = shownHandles.find((h) => h !== target && h !== muteHandle);
    if (!muteHandle || !wordHandle) fail("the feed had no second account to mute");
    const phrase = "from account " + String(Number(wordHandle.slice(-2))) + " with";
    const repostKey = "x:" + handles.find((h) => h !== target && h !== muteHandle && h !== wordHandle);
    const withFilters = await a.evaluate(() => JSON.parse(localStorage.getItem("viktorychapp-settings-v1")));
    withFilters.blocks = { at: 1, accounts: [], posts: [], sources: [], types: {}, showHidden: false };
    withFilters.mutedWords = [phrase];
    withFilters.mutedAccounts = ["x:" + muteHandle];
    withFilters.repostOff = [repostKey];
    await b.evaluate((text) => { localStorage.setItem("viktorychapp-settings-v1", text); }, JSON.stringify(withFilters));
    await a.waitForFunction((spec) => {
      const settings = JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}");
      const blocks = settings.blocks || {};
      const kept = (blocks.accounts || []).some((item) => String(item).indexOf(spec.target) >= 0);
      const words = settings.mutedWords || [];
      const accounts = settings.mutedAccounts || [];
      const reposts = settings.repostOff || [];
      if (!kept || words.indexOf(spec.phrase) < 0 || accounts.indexOf("x:" + spec.mute) < 0 || reposts.indexOf(spec.repost) < 0) return false;
      const handlesNow = Array.from(document.querySelectorAll("#app article.post .handle")).map((el) => el.textContent.replace(/^@/, ""));
      if (handlesNow.indexOf(spec.target) >= 0 || handlesNow.indexOf(spec.mute) >= 0 || handlesNow.indexOf(spec.word) >= 0) return false;
      const api = window.ViktorychBlocklist;
      if (!api || typeof api.reason !== "function") return false;
      const word = api.reason({ id: "w", platform: "x", handle: "sample_other", text: "note " + spec.phrase + " here" });
      const account = api.reason({ id: "m", platform: "x", handle: spec.mute, feedId: "x:" + spec.mute, text: "hello" });
      const repost = api.reason({ id: "p", platform: "x", handle: "sample_other", text: "hello", repostedBy: { handle: spec.repost.slice(2), platform: "x", feedId: spec.repost } });
      return word === "word" && account === "account" && repost === "type";
    }, { target: target, mute: muteHandle, word: wordHandle, phrase: phrase, repost: repostKey }, { timeout: 8000 }).catch(() => fail("an older block list dropped the new mute filters or the block"));
    console.log("older blocks kept and new filters applied");
    const memAt = await a.evaluate(() => Number(JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}").blocks.at) || 0);
    const baseSettings = await a.evaluate(() => JSON.parse(localStorage.getItem("viktorychapp-settings-v1")));
    const stale = Object.assign({}, baseSettings, { blocks: { at: 1, accounts: [], posts: [], sources: [], types: {}, showHidden: false } });
    const unblockPhrase = "from account " + String(Number(handles.find((h) => h !== target && h !== muteHandle && h !== wordHandle).slice(-2))) + " with";
    const unblocked = Object.assign({}, baseSettings, {
      blocks: { at: memAt + 1000, accounts: [], posts: [], sources: [], types: {}, showHidden: false },
      mutedWords: [unblockPhrase],
      mutedAccounts: [],
      repostOff: baseSettings.repostOff || []
    });
    await a.evaluate((pair) => {
      localStorage.setItem("viktorychapp-settings-v1", pair.fresh);
      window.__settingsReads = [pair.stale, pair.fresh];
      window.dispatchEvent(new StorageEvent("storage", { key: "viktorychapp-settings-v1", newValue: pair.fresh }));
    }, { stale: JSON.stringify(stale), fresh: JSON.stringify(unblocked) });
    await a.waitForFunction((spec) => {
      const settings = JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}");
      const accounts = (settings.blocks || {}).accounts || [];
      if (accounts.some((item) => String(item).indexOf(spec.target) >= 0)) return false;
      if ((Number(settings.blocks && settings.blocks.at) || 0) !== spec.at) return false;
      if ((settings.mutedWords || []).indexOf(spec.phrase) < 0) return false;
      const handlesNow = Array.from(document.querySelectorAll("#app article.post .handle")).map((el) => el.textContent.replace(/^@/, ""));
      if (handlesNow.indexOf(spec.target) < 0) return false;
      const api = window.ViktorychBlocklist;
      return api && api.reason({ id: "w2", platform: "x", handle: "sample_other", text: "note " + spec.phrase + " here" }) === "word";
    }, { target: target, at: memAt + 1000, phrase: unblockPhrase }, { timeout: 8000 }).catch(() => fail("a newer unblock between the two reads was overwritten"));
    console.log("newer unblock between reads kept");
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
