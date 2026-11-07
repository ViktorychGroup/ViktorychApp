/* Instagram pictures. The embed page cannot be framed, and the CDN file
   cannot be painted from this site. An expired file or a /media redirect is
   shown through the public media proxy. A miss keeps the caption and
   Open original. Demo posts only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.env.SHOTS || "/tmp/ig-shots";
const ME = "100000000001";
const now = Date.now();
const FRESH = "7FFFFFFF";
const OLD = "10000000";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function post(id, text, hours, media, url) {
  return {
    id, statusId: id, platform: "instagram", feedId: "instagram:orbitfox", kind: "post",
    author: "Orbit Fox", handle: "orbitfox", avatar: "",
    text, lang: "en", links: [], date: new Date(now - hours * 3600e3).toISOString(),
    url: url || ("https://www.instagram.com/p/" + id + "/"),
    media, images: [], repostedBy: null, replyingTo: null, quoted: null,
    stats: { replies: 0, reposts: 0, likes: 1, views: 3 }
  };
}

const FIXTURE = {
  updated: new Date(now).toISOString(),
  feeds: [{
    id: "instagram:orbitfox", platform: "instagram", handle: "orbitfox", name: "Orbit Fox",
    title: "Orbit Fox", avatar: "", bio: "Demo bio line", url: "https://www.instagram.com/orbitfox/", configured: true
  }],
  posts: [
    post("Efgh5678", "Fresh demo photo", 1, [{ type: "photo", url: "https://scontent.cdninstagram.com/v/new.jpg?oe=" + FRESH, width: 1080, height: 1350 }]),
    post("Abcd1234", "Expired demo photo", 2, [{ type: "photo", url: "https://scontent.cdninstagram.com/v/old.jpg?oe=" + OLD, width: 1080, height: 1350 }]),
    post("Vwxyz12ab", "Reel demo", 3, [{ type: "photo", url: "https://scontent.cdninstagram.com/v/reel-old.jpg?oe=" + OLD }], "https://www.instagram.com/reel/Vwxyz12ab/"),
    post("Mnop3456", "Video demo", 4, [{ type: "video", url: "https://scontent.cdninstagram.com/v/clip.mp4?oe=" + FRESH, poster: "https://scontent.cdninstagram.com/v/poster.jpg?oe=" + FRESH, width: 720, height: 1280 }]),
    post("Qrst7890", "Missing demo", 5, [{ type: "photo", url: "https://www.instagram.com/p/Qrst7890/media/?size=l" }]),
    post("Reelclip1", "Expired reel clip", 6, [{ type: "video", url: "https://scontent.cdninstagram.com/o1/v/t2/clip.mp4?oe=" + OLD, poster: "https://scontent.cdninstagram.com/v/poster-old.jpg?oe=" + OLD, width: 720, height: 1280 }], "https://www.instagram.com/reel/Reelclip1/")
  ]
};

let failures = 0;
function fail(message) { console.error("FAIL " + message); failures += 1; process.exitCode = 1; }

function mime(file) {
  if (/\.m?js$/.test(file)) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

function startServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel.endsWith("/")) rel += "index.html";
    if (/\/feeds\.json$/.test(rel)) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(FIXTURE));
    }
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function loadChromium() {
  const specs = [
    process.env.PLAYWRIGHT_CORE,
    process.env.SMOKE_PLAYWRIGHT_CORE,
    "/tmp/pw/node_modules/playwright-core/index.js",
    "playwright-core"
  ].filter(Boolean);
  for (const spec of specs) {
    const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
    try {
      const mod = await import(href);
      const chromium = mod.chromium || (mod.default && mod.default.chromium);
      if (chromium) return chromium;
    } catch (err) { /* try the next copy */ }
  }
  return null;
}

function targetOf(raw) {
  try {
    const url = new URL(raw);
    return decodeURIComponent(url.searchParams.get("url") || "");
  } catch (err) {
    return "";
  }
}

async function run(chromium, port, vp) {
  const origin = "http://127.0.0.1:" + port;
  const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || "chrome", args: ["--no-sandbox", "--disable-gpu"] });
  const media = [];
  const outside = [];
  const profileHits = [];
  try {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      deviceScaleFactor: vp.mobile ? 2 : 1,
      serviceWorkers: "block"
    });
    await ctx.route(/^https?:\/\//, (route) => {
      const raw = route.request().url();
      if (!raw.startsWith(origin + "/")) {
        outside.push(raw);
        return route.abort();
      }
      const url = new URL(raw);
      if (url.pathname.indexOf("/v1/media") >= 0) {
        const target = targetOf(raw);
        media.push(target);
        if (target.indexOf("Qrst7890") >= 0) return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"upstream"}' });
        return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
      }
      if (url.pathname.indexOf("/v1/profile/") === 0) {
        profileHits.push(url.pathname);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ account: { handle: "orbitfox", displayName: "Not This Person", bio: "Invented bio" }, reposts: [] })
        });
      }
      if (url.pathname.indexOf("/v1/") >= 0) {
        if (/feeds/.test(url.pathname)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE) });
        return route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[],"reposts":[],"ok":true}' });
      }
      return route.continue();
    });
    const page = await ctx.newPage();
    page.on("pageerror", (err) => fail(vp.name + ": page error " + String(err && err.message).slice(0, 180)));
    await page.addInitScript((me) => {
      try {
        localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
        localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token", account: { publicId: me, handle: "user_a", displayName: "User A", avatar: "" } }));
      } catch (err) { /* the page still loads the fixture */ }
      window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
    }, ME);
    await page.goto(origin + "/#/home", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('article[data-post="Efgh5678"]', { timeout: 30000 });
    for (const id of ["Efgh5678", "Abcd1234", "Vwxyz12ab", "Mnop3456", "Qrst7890", "Reelclip1"]) {
      const card = page.locator('article[data-post="' + id + '"]');
      await card.scrollIntoViewIfNeeded().catch(() => {});
    }
    const loaded = await page.waitForFunction(() => {
      const img = document.querySelector('article[data-post="Efgh5678"] img');
      return !!(img && img.naturalWidth > 0);
    }, null, { timeout: 15000 }).then(() => true).catch(async () => {
      const info = await page.evaluate(() => {
        const img = document.querySelector('article[data-post="Efgh5678"] img');
        return {
          src: img ? img.getAttribute("src") : "",
          complete: img ? img.complete : false,
          width: img ? img.naturalWidth : -1,
          html: (document.querySelector('article[data-post="Efgh5678"]') || {}).innerHTML || ""
        };
      });
      fail(vp.name + ": fresh image did not paint " + JSON.stringify({ src: info.src, complete: info.complete, width: info.width, media: media.slice(0, 8), html: String(info.html).slice(0, 500) }));
      return false;
    });
    if (!loaded) return;

    const view = await page.evaluate(() => {
      function card(id) {
        const article = document.querySelector('article[data-post="' + id + '"]');
        if (!article) return null;
        const img = article.querySelector("img");
        const frames = [...article.querySelectorAll("iframe")].map((frame) => frame.getAttribute("src") || "");
        return {
          text: article.textContent || "",
          src: img ? img.getAttribute("src") || "" : "",
          broken: !!article.querySelector(".tile.broken"),
          frames,
          play: !!article.querySelector("button.play")
        };
      }
      return {
        fresh: card("Efgh5678"),
        expired: card("Abcd1234"),
        reel: card("Vwxyz12ab"),
        video: card("Mnop3456"),
        missing: card("Qrst7890"),
        reelClip: card("Reelclip1"),
        iframes: [...document.querySelectorAll("iframe")].map((frame) => frame.getAttribute("src") || "").filter((src) => /instagram\.com/i.test(src))
      };
    });
    const decoded = {
      fresh: targetOf(view.fresh.src),
      expired: targetOf(view.expired.src),
      reel: targetOf(view.reel.src),
      reelClip: targetOf(view.reelClip && view.reelClip.src)
    };
    if (!view.fresh || view.fresh.text.indexOf("Fresh demo photo") < 0) fail(vp.name + ": fresh caption missing");
    if (decoded.fresh.indexOf("scontent.cdninstagram.com/v/new.jpg") < 0) fail(vp.name + ": a current file was replaced " + decoded.fresh);
    if (decoded.fresh.indexOf("/media/") >= 0) fail(vp.name + ": a current file used the media redirect");
    if (!view.expired || view.expired.text.indexOf("Expired demo photo") < 0) fail(vp.name + ": expired caption missing");
    if (decoded.expired !== "https://www.instagram.com/p/Abcd1234/media/?size=l") fail(vp.name + ": expired file did not use the public media redirect " + decoded.expired);
    if (!view.reel || decoded.reel !== "https://www.instagram.com/reel/Vwxyz12ab/media/?size=l") fail(vp.name + ": reel did not use its public media redirect " + decoded.reel);
    if (!view.reelClip || view.reelClip.text.indexOf("Expired reel clip") < 0) fail(vp.name + ": expired reel caption missing");
    if (decoded.reelClip !== "https://www.instagram.com/reel/Reelclip1/media/?size=l") fail(vp.name + ": an expired reel clip did not use its public media redirect " + decoded.reelClip);
    if (view.reelClip.play) fail(vp.name + ": an expired reel clip offered a player");
    const painted = await page.evaluate(() => ["Efgh5678", "Abcd1234", "Vwxyz12ab", "Reelclip1"].every((id) => {
      const img = document.querySelector('article[data-post="' + id + '"] img');
      return !!(img && img.naturalWidth > 0);
    }));
    if (!painted) fail(vp.name + ": a current or refreshed picture did not paint");
    if (!view.video || !view.video.play || view.video.text.indexOf("Video demo") < 0) fail(vp.name + ": video card missing " + JSON.stringify(view.video));
    if (view.video.src.indexOf("poster.jpg") < 0 && view.video.src.indexOf("clip.mp4") < 0) fail(vp.name + ": video poster was not the stored file " + view.video.src);
    if (view.iframes.length) fail(vp.name + ": an Instagram embed was framed " + view.iframes.join(" "));
    [view.fresh, view.expired, view.reel, view.reelClip, view.video].forEach((card) => {
      if (card && card.frames.length) fail(vp.name + ": a card framed an embed " + card.frames.join(" "));
    });
    const igDirect = outside.filter((raw) => /instagram\.com/i.test(raw));
    if (igDirect.length) fail(vp.name + ": the page called Instagram directly");

    const missingOk = await page.waitForFunction(() => {
      const article = document.querySelector('article[data-post="Qrst7890"]');
      if (!article || article.querySelector("iframe") || !article.querySelector(".tile.broken")) return false;
      const link = article.querySelector("a.open-original");
      const href = link ? link.getAttribute("href") || "" : "";
      return /instagram\.com\/p\/Qrst7890/.test(href) && /Missing demo/.test(article.textContent || "") && /Open original/.test(link.textContent || "");
    }, null, { timeout: 8000 }).then(() => true).catch(() => false);
    if (!missingOk) {
      const info = await page.evaluate(() => {
        const article = document.querySelector('article[data-post="Qrst7890"]');
        const link = article && article.querySelector("a.open-original");
        return {
          text: article ? (article.textContent || "").slice(0, 240) : "",
          link: link ? link.textContent : "",
          href: link ? link.getAttribute("href") : "",
          broken: article ? article.querySelectorAll(".tile.broken").length : 0
        };
      });
      fail(vp.name + ": a missing image did not stay a caption with Open original " + JSON.stringify(info));
    }

    await page.locator('article[data-post="Mnop3456"]').evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
    const layout = await page.evaluate(() => {
      const card = document.querySelector('article[data-post="Mnop3456"]');
      const tile = card && card.querySelector(".tile");
      const play = card && card.querySelector("button.play");
      const cr = card ? card.getBoundingClientRect() : null;
      const tr = tile ? tile.getBoundingClientRect() : null;
      const pr = play ? play.getBoundingClientRect() : null;
      const viewH = window.innerHeight;
      const onScreen = (box) => !!(box && box.width > 40 && box.bottom > 0 && box.top < viewH);
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tileInside: !!(onScreen(tr) && cr && tr.left >= cr.left - 1 && tr.right <= cr.right + 1),
        playInside: !!(onScreen(pr) && tr && pr.left >= tr.left - 1 && pr.right <= tr.right + 1 && pr.top >= tr.top - 1 && pr.bottom <= tr.bottom + 1)
      };
    });
    if (layout.overflow > 2) fail(vp.name + ": the feed is wider than the screen " + layout.overflow);
    if (!layout.tileInside) fail(vp.name + ": the video frame leaves the card");
    if (!layout.playInside) fail(vp.name + ": the play button leaves the video frame");

    await page.locator('article[data-post="Efgh5678"] a.name').click();
    await page.waitForFunction(() => /#\/instagram\/orbitfox(?:\?|$)/.test(location.hash || ""), null, { timeout: 8000 }).catch(() => {});
    const source = await page.waitForFunction(() => {
      const name = document.querySelector("h1.pname");
      const text = document.body ? document.body.innerText || "" : "";
      return name && /Orbit Fox/.test(name.textContent || "") && /Demo bio line/.test(text);
    }, null, { timeout: 8000 }).then(() => true).catch(() => false);
    const profile = await page.evaluate(() => {
      const text = document.body ? document.body.innerText || "" : "";
      return {
        hash: location.hash || "",
        title: document.title || "",
        text: text.slice(0, 500),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    if (!source) fail(vp.name + ": the source page did not keep the stored name and bio " + JSON.stringify(profile));
    if (profile.hash.indexOf("#/instagram/orbitfox") !== 0) fail(vp.name + ": the source opened an app profile " + profile.hash);
    if (/Not This Person|Invented bio|Edit profile/.test(profile.text)) fail(vp.name + ": the source page used an app account " + profile.text.slice(0, 240));
    if (profileHits.length) fail(vp.name + ": an external source asked /v1/profile " + profileHits.join(" "));
    if (profile.overflow > 2) fail(vp.name + ": the source page is wider than the screen " + profile.overflow);

    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, "instagram-profile-" + vp.name + ".png") });
    await page.goto(origin + "/#/home", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('article[data-post="Efgh5678"]', { timeout: 15000 });
    const shown = page.locator('article[data-post="Efgh5678"]');
    await shown.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
    await page.screenshot({ path: path.join(shots, "instagram-" + vp.name + ".png") });
    await shown.screenshot({ path: path.join(shots, "instagram-card-" + vp.name + ".png") });
    await page.locator('article[data-post="Mnop3456"]').evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
    await page.screenshot({ path: path.join(shots, "instagram-video-" + vp.name + ".png") });
    if (profileHits.length) fail(vp.name + ": going home asked /v1/profile " + profileHits.join(" "));
    console.log("ok " + vp.name);
  } finally {
    await browser.close();
  }
}

const chromium = await loadChromium();
if (!chromium) {
  console.error("Playwright chromium is missing");
  process.exit(1);
}
const server = await startServer();
try {
  const port = server.address().port;
  await run(chromium, port, { width: 1280, height: 800, name: "desktop", mobile: false });
  await run(chromium, port, { width: 390, height: 844, name: "phone", mobile: true });
} finally {
  await new Promise((resolve) => server.close(resolve));
}
if (failures) process.exit(1);
console.log("ok instagram media");
