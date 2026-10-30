/* Points and the store stay in the page flow on a phone and a tablet. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function staticChecks() {
  const css = read("gifts.css");
  if (/position:\s*fixed/.test(css.slice(0, css.indexOf(".gift-sheet")))) fail("points page must stay in flow");
  if (!css.includes("max-width: 499px") || !css.includes("@media (min-width: 500px) {")) fail("points need phone and tablet rules");
  const app = read("app.js");
  if (!app.includes('name: "points"') || !app.includes('"#/points"')) fail("points route missing");
  if (!app.includes('data-gift="reply"') || !app.includes("giftChip")) fail("a reply needs a gift button and an attached gift");
  if (!read("gifts-ui.js").includes('data-gift="dm"')) fail("messages need a direct gift action");
  const external = app.slice(app.indexOf("function profileView"), app.indexOf("function statusView"));
  if (external.includes("?tab=gifts") || external.includes("ProfileGifts")) fail("external profiles must not show gifts");
  if (!read("sw.js").includes('VERSION = "viktorych-a265-__SW_VERSION__"')) fail("service worker cache was not bumped");
  console.log("ok points layout rules");
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><link rel=\"stylesheet\" href=\"/gifts.css\"><link rel=\"stylesheet\" href=\"/styles.css\"><div id=\"mount\"></div><article id=\"post\">post</article><script src=\"/gifts-ui.js\"></script><script type=\"module\" src=\"/shared/gift-catalog.js\"></script>");
      return;
    }
    const file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep)) {
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
      const type = file.endsWith(".css") ? "text/css" : "text/javascript";
      res.writeHead(200, { "content-type": type + "; charset=utf-8" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function browserChecks() {
  if (!process.env.PLAYWRIGHT_CORE) {
    console.log("points browser check skipped");
    return;
  }
  const mod = await import(pathToFileURL(process.env.PLAYWRIGHT_CORE).href);
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    for (const width of [390, 768]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        const points = ProfileGifts.previewPoints({
          balance: 30,
          rules: [{ id: "login", points: 5, cap: 1, streak: 7 }],
          history: [{ delta: 5, reason: "login", at: 1 }]
        });
        const store = ProfileGifts.previewStore([
          { id: "heart", category: "kindness", price: 10, seasonal: false, svg: "M12 20s-7-4.4-7-9a4 4 0 0 1 7-2 4 4 0 0 1 7 2c0 4.6-7 9-7 9z" },
          { id: "leaf", category: "seasonal", price: 50, seasonal: true, svg: "M5 19c8-1 14-8 14-14-6 0-13 6-14 14z" }
        ]);
        const visible = ProfileGifts.showTab({ handle: "user_a", publicId: "p" });
        const hidden = ProfileGifts.showTab({ handle: "user_a", publicId: "p", gifts: { hidden: true } });
        if (!visible || hidden) throw new Error("gifts tab");
        const quiet = ProfileGifts.banner({ handle: "user_a", publicId: "p", birthdayChecked: true, birthdayToday: false });
        const loud = ProfileGifts.banner({ handle: "user_a", publicId: "p", birthdayChecked: true, birthdayToday: true });
        if (quiet || !loud.includes("Send birthday gift")) throw new Error("birthday banner");
        document.getElementById("mount").innerHTML = points + store + ProfileGifts.dmBar() + loud;
      });
      const box = await page.evaluate(() => {
        const pageBox = document.querySelector(".points-page").getBoundingClientRect();
        const post = document.getElementById("post").getBoundingClientRect();
        const style = getComputedStyle(document.querySelector(".points-page"));
        return {
          position: style.position,
          overlap: pageBox.bottom > post.top && pageBox.top < post.bottom,
          cards: document.querySelectorAll(".gift-card").length,
          text: document.body.innerText
        };
      });
      if (box.position === "fixed" || box.position === "absolute") fail(width + " points cover the page");
      if (box.overlap) fail(width + " points overlap the post");
      if (box.cards < 2) fail(width + " store grid missing");
      if (!box.text.includes("Viktorychs")) fail(width + " currency missing");
      await page.waitForFunction(() => !!window.GiftCatalog);
      const shelf = await page.evaluate(() => {
        document.getElementById("mount").innerHTML = ProfileGifts.previewStore(null, { sub: "" });
        const rows = Array.from(document.querySelectorAll(".vkg-chiprow"));
        const shelves = Array.from(document.querySelectorAll(".vkg-shelf")).map((node) => node.getAttribute("data-shelf"));
        const row = document.querySelector(".vkg-row");
        const head = document.querySelector(".vkg-top .page-head");
        const free = document.querySelectorAll(".vkg-price.is-free").length;
        const seasons = GiftCatalog.activeSeasons();
        const scrolls = row ? row.scrollWidth > row.clientWidth : false;
        const chips = document.querySelectorAll(".vkg-chip").length;
        document.getElementById("mount").innerHTML = ProfileGifts.previewStore(null, { sub: "flowers" });
        const grid = document.querySelectorAll(".vkg-grid .vkg-item").length;
        return {
          chipRows: rows.length,
          chips: chips,
          shelves: shelves,
          seasons: seasons,
          scrolls: scrolls,
          headIcons: head ? head.querySelectorAll(".icon-btn").length : 0,
          free: free,
          grid: grid,
          pageWidth: document.documentElement.scrollWidth
        };
      });
      if (shelf.chipRows !== 2 || shelf.chips < 8) fail(width + " gifts need two chip rows");
      if (shelf.headIcons !== 3) fail(width + " gifts header needs back, history and search");
      if (shelf.shelves.length < 8) fail(width + " gifts shelves missing");
      if (shelf.seasons.some((id) => !shelf.shelves.includes(id))) fail(width + " seasonal shelf missing");
      if (!shelf.scrolls) fail(width + " a shelf should scroll sideways");
      if (shelf.free < 1) fail(width + " free gifts need a label");
      if (shelf.grid < 6) fail(width + " category grid missing");
      if (shelf.pageWidth > width) fail(width + " gifts page overflows the screen");
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log("ok points on phone and tablet");
}

staticChecks();
await browserChecks();
