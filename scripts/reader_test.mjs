/* Reading view: a post keeps its external link and offers Read. Phone and
   desktop layouts, font size, theme, progress, saved position, a paywall
   fallback, and a client that strips scripts the server should never send.
   Fixture pages only. */
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

function widePng() {
  const w = 320;
  const h = 180;
  const rgb = [28, 58, 92];
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x += 1) {
      const i = row + 1 + x * 3;
      raw[i] = rgb[0];
      raw[i + 1] = rgb[1] + Math.round((x / w) * 30);
      raw[i + 2] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shots = "/opt/cursor/artifacts";
let failed = false;
function check(ok, message) {
  if (ok) { console.log("reader ok: " + message); return; }
  failed = true;
  console.error("reader FAIL: " + message);
}

const STORY = "https://news.fixture.test/world/harbour-lights-after-the-storm";
const PAID = "https://news.fixture.test/world/members-only-harbour-report";
const paras = Array.from({ length: 28 }, (_, i) => `<p>Paragraph ${i + 1}. The harbour lights stayed on, and the public page kept a long calm column for reading.</p>`).join("");
const dirty = `<p>The harbour was calm after the rain.</p><figure><img src="https://cdn.fixture.test/hero.jpg" alt="Pier lights"><figcaption>Lights along the east pier.</figcaption></figure>` + paras + `<script>alert(1)</script><img src="x" onerror="alert(1)"><p onclick="alert(1)">Still public.</p><a href="javascript:alert(2)">bad link</a><iframe src="https://evil.fixture.test/ad"></iframe>`;
const article = {
  url: STORY,
  requested: STORY,
  mode: "article",
  reason: "",
  title: "Harbour lights return after the storm",
  byline: "Ada Fixture",
  date: "2026-11-05T08:00:00Z",
  site: "Example News",
  domain: "news.fixture.test",
  description: "A short public summary of the harbour story.",
  image: "https://cdn.fixture.test/hero.jpg",
  caption: "Lights along the east pier.",
  html: dirty,
  wordCount: 400,
  lang: "en"
};
const paywall = {
  url: PAID,
  requested: PAID,
  mode: "preview",
  reason: "paywall",
  title: "Members only harbour report",
  byline: "Should Not Show",
  date: "2026-11-05T08:00:00Z",
  site: "Example News",
  domain: "news.fixture.test",
  description: "The public summary stops here.",
  image: "https://cdn.fixture.test/hero.jpg",
  caption: "",
  html: "<p>SECRET GATED BODY</p><script>alert(1)</script>",
  wordCount: 0,
  lang: "en"
};

const post = (id, text) => ({ id, statusId: id, platform: "rss", feedId: "src-" + id, kind: "post", date: "2026-11-05T08:00:00Z", text, title: id, author: "src-" + id, handle: "src-" + id });
const posts = [
  post("p1", "Harbour notes " + STORY),
  post("p2", "Clip https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
  post("p3", "Members " + PAID)
];
const ids = posts.map((row) => row.feedId);
const catalog = { updated: "2026-11-05T08:00:00Z", feeds: ids.map((id) => ({ id, platform: "rss", handle: id, name: id })), posts };
const config = { feeds: ids.map((id) => ({ id, platform: "rss", adapter: "rss", handle: id, source_urls: ["https://fixture.test/" + id] })) };

function contentType(file) {
  return { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" }[extname(file)] || "application/octet-stream";
}

function startServer() {
  const server = createServer((req, res) => {
    const full = new URL(req.url, "http://127.0.0.1");
    const p = decodeURIComponent(full.pathname);
    const json = (body, status) => {
      res.writeHead(status || 200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    if (p === "/feeds.json") return json(catalog);
    if (p === "/feeds.config.json") return json(config);
    if (p === "/v1/features") return json({ off: [] });
    if (p === "/v1/reader") {
      const url = full.searchParams.get("url");
      if (url === STORY) return json(article);
      if (url === PAID) return json(paywall);
      return json({ mode: "preview", reason: "extract", url: url || "", html: "", title: "", domain: "news.fixture.test" });
    }
    if (p === "/v1/unfurl") {
      const url = full.searchParams.get("url") || "";
      const title = url === PAID ? "Members only harbour report" : "Harbour lights return after the storm";
      return json({ url, title, description: "A short public summary.", image: "https://cdn.fixture.test/hero.jpg", site: "Example News", domain: "news.fixture.test", large: true });
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

async function shot(page, name) {
  try {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, name), fullPage: false });
  } catch (err) {
    console.error("screenshot skipped: " + (err && err.message));
  }
}

async function waitFor(page, fn, tries) {
  let value = null;
  for (let i = 0; i < (tries || 40); i += 1) {
    value = await fn();
    if (value) return value;
    await page.waitForTimeout(250);
  }
  return value;
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const port = server.address().port;
  const launch = { args: ["--no-sandbox"], viewport: { width: 390, height: 844 }, serviceWorkers: "block" };
  if (process.env.CHROME) launch.executablePath = process.env.CHROME;
  else launch.channel = "chrome";
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "reader-")), launch);
  try {
    await ctx.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("http://127.0.0.1")) return route.continue();
      if (/cdn\.fixture\.test/.test(url)) return route.fulfill({ status: 200, contentType: "image/png", body: widePng() });
      return route.fulfill({ status: 404, body: "{}" });
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.addInitScript((follows) => {
      localStorage.setItem("viktorychapp-lang-user-picked", "1");
      localStorage.setItem("superintelapp-lang", "en");
      localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, follows, lists: [], feedTabs: [] }));
    }, ids);
    await page.goto("http://127.0.0.1:" + port + "/index.html#/");
    const ready = await waitFor(page, () => page.evaluate((story) => {
      const card = document.querySelector('.rd-launch[data-url="' + story + '"]');
      const link = document.querySelector('a[href="' + story + '"]');
      if (!card || !link) return null;
      return { outside: !link.contains(card), blank: link.target === "_blank", rel: link.rel || "", youtube: document.body.innerText.includes("Clip") && !document.querySelector('.rd-launch[data-url*="youtube.com"]') };
    }, STORY), 50);
    check(!!ready && ready.outside && ready.blank && /noopener/.test(ready.rel) && ready.youtube, "Read sits outside the link, which still opens in a new tab");
    await page.locator('.rd-launch[data-url="' + STORY + '"]').first().click();
    const opened = await waitFor(page, () => page.evaluate(() => {
      const box = document.querySelector(".rd-root");
      if (!box) return null;
      const body = box.querySelector(".rd-body");
      const text = body ? body.textContent : "";
      return {
        title: (box.querySelector(".rd-title") || {}).textContent || "",
        byline: (box.querySelector(".rd-byline") || {}).textContent || "",
        note: (box.querySelector(".rd-note") || {}).textContent || "",
        open: (box.querySelector("a.rd-open") || {}).href || "",
        blank: (box.querySelector("a.rd-open") || {}).target || "",
        rel: (box.querySelector("a.rd-open") || {}).rel || "",
        script: body ? body.querySelectorAll("script, iframe, form").length : -1,
        js: body ? !!body.querySelector('a[href^="javascript:"]') : true,
        onerror: body ? /onerror|onclick/.test(body.innerHTML) : true,
        calm: text.includes("The harbour was calm after the rain."),
        dialog: box.getAttribute("role") === "dialog",
        modal: box.getAttribute("aria-modal") === "true",
        progress: !!box.querySelector("[role=progressbar]")
      };
    }));
    check(opened && opened.title === "Harbour lights return after the storm" && /Ada Fixture/.test(opened.byline), "the reader shows the title and byline");
    check(opened && /not the publisher/.test(opened.note) && opened.blank === "_blank" && /noopener/.test(opened.rel) && opened.open === STORY, "the reader names itself and links out to the original");
    check(opened && opened.script === 0 && !opened.js && !opened.onerror && opened.calm && opened.dialog && opened.modal && opened.progress, "unsafe markup is stripped and the dialog is labeled");
    const phone = await page.evaluate(() => {
      const sheet = document.querySelector(".rd-sheet").getBoundingClientRect();
      const copy = document.querySelector(".rd-copy").getBoundingClientRect();
      return { sheet: Math.round(sheet.width), copy: Math.round(copy.width), view: window.innerWidth };
    });
    check(Math.abs(phone.sheet - phone.view) <= 2 && phone.copy < phone.view && phone.copy >= 280, "on a phone the reader fills the width and keeps a readable measure (" + phone.sheet + "/" + phone.copy + ")");
    await shot(page, "reader-phone.png");
    await page.locator("[data-rd=larger]").click();
    await page.locator("[data-rd-theme=sepia]").click();
    const styled = await page.evaluate(() => {
      const sheet = document.querySelector(".rd-sheet");
      const pref = JSON.parse(localStorage.getItem("viktorychapp-reader-pref") || "{}");
      return { theme: sheet.getAttribute("data-theme"), size: getComputedStyle(sheet).getPropertyValue("--rd-size").trim(), pref };
    });
    check(styled.theme === "sepia" && styled.size === "20px" && styled.pref.theme === "sepia" && styled.pref.size === 2, "font size and theme are adjustable and saved");
    await page.locator(".rd-scroll").evaluate((el) => { el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.62); el.dispatchEvent(new Event("scroll")); });
    await page.waitForTimeout(400);
    const progressed = await page.evaluate(() => {
      const bar = document.querySelector(".rd-progress");
      const pref = JSON.parse(localStorage.getItem("viktorychapp-reader-pref") || "{}");
      const url = document.querySelector("a.rd-open").href;
      return { now: Number(bar.getAttribute("aria-valuenow")), saved: pref.pos && pref.pos[url] && pref.pos[url].r };
    });
    check(progressed.now > 40 && progressed.now < 90 && progressed.saved > 0.4, "reading progress and position are saved (" + progressed.now + ")");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check(await page.locator(".rd-root").count() === 0, "Escape closes the reader and leaves the post");
    await page.locator('.rd-launch[data-url="' + STORY + '"]').first().click();
    await waitFor(page, () => page.locator(".rd-root").count());
    await page.waitForTimeout(350);
    const restored = await page.evaluate(() => {
      const el = document.querySelector(".rd-scroll");
      const max = el.scrollHeight - el.clientHeight;
      return max > 0 ? el.scrollTop / max : 0;
    });
    check(restored > 0.35, "reopening restores the reading position (" + restored.toFixed(2) + ")");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(200);
    const desktop = await page.evaluate(() => {
      const sheet = document.querySelector(".rd-sheet").getBoundingClientRect();
      const copy = document.querySelector(".rd-copy").getBoundingClientRect();
      return { sheet: Math.round(sheet.width), copy: Math.round(copy.width), view: window.innerWidth };
    });
    check(desktop.sheet < desktop.view - 40 && desktop.sheet > 500 && desktop.copy <= 760, "on a desktop the reader is a centered column (" + desktop.sheet + "/" + desktop.copy + ")");
    await shot(page, "reader-desktop.png");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.rd-launch[data-url="' + PAID + '"]').first().click();
    const fallback = await waitFor(page, () => page.evaluate(() => {
      const box = document.querySelector(".rd-root");
      if (!box) return null;
      const text = box.innerText || "";
      if (!text.includes("subscribers")) return null;
      return { gated: text.includes("SECRET GATED BODY"), byline: (box.querySelector(".rd-byline") || {}).textContent || "", open: !!box.querySelector("a.rd-open[href]") };
    }));
    check(fallback && !fallback.gated && !fallback.byline && fallback.open, "a paywall stops at the public preview and still offers the original");
    await shot(page, "reader-fallback.png");
    await page.keyboard.press("Escape");
    await page.goto("about:blank");
    const helper = await ctx.newPage();
    await helper.goto("http://127.0.0.1:" + port + "/offline.html");
    await helper.evaluate(() => {
      localStorage.setItem("viktorychapp-server-off", JSON.stringify(["article_reader"]));
      localStorage.removeItem("viktorych-screen-v1");
    });
    await helper.close();
    await page.goto("http://127.0.0.1:" + port + "/index.html#/");
    const back = await waitFor(page, () => page.evaluate(() => (document.body.innerText || "").includes("Harbour notes") ? "yes" : ""), 50);
    const off = await page.evaluate((story) => document.querySelectorAll('.rd-launch[data-url="' + story + '"]').length, STORY);
    check(back === "yes" && off === 0, "the owner switch hides Read (" + off + ")");
    check(!errors.some((msg) => /reader|rd-/.test(msg)), "the reader adds no page errors");
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
