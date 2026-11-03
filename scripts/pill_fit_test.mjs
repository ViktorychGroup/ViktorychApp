/* Pill labels stay inside the existing pill box. Long names scroll. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sharedStaticServer } from "./smoke_runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RU = "Очень длинное название которое не помещается в пилюлю целиком";
const DE = "Ein sehr langer Name der nicht in die bestehende Pille passt";

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function mime(file) {
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function startServer() {
  const shared = sharedStaticServer();
  if (shared) return Promise.resolve(shared);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
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

function marquee(text) {
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return '<span class="sp-marquee" data-sp-marquee><span class="sp-marquee-clip"><span class="sp-marquee-track"><span class="sp-marquee-copy"><span class="sp-marquee-text">' + safe + '</span></span><span class="sp-marquee-copy" aria-hidden="true"><span class="sp-marquee-text">' + safe + '</span></span></span></span></span>';
}

function demo() {
  return '<div id="pill-fit-demo" style="position:fixed;z-index:80;left:0;right:0;top:0;padding:12px;display:flex;flex-direction:column;gap:10px;background:#000">'
    + '<div class="sp-row">'
    + '<a class="sp-pill" href="#/"><span class="sp-pill-text">' + marquee(RU) + "</span></a>"
    + '<button class="sc-pill" type="button"><span class="sc-crest-ring"></span><span class="sc-pill-content"><span class="sc-pill-top"><span class="sc-badge is-live">LIVE</span><span class="sc-pill-title">' + marquee(DE) + '</span></span><span class="sc-pill-bottom"><span class="sc-pill-score">2-1</span><span class="sc-pill-opp">' + marquee(RU) + "</span></span></span></button>"
    + '<button class="sc-pill wx-pill" type="button"><span class="wx-icon-ring"></span><span class="sc-pill-content"><span class="sc-pill-top"><span class="sc-badge wx-badge">12°</span><span class="sc-pill-title">' + marquee(DE) + '</span></span><span class="sc-pill-bottom"><span class="wx-cond">' + marquee(RU) + '</span><span class="wx-range">8 / 14</span></span></span></button>'
    + "</div>"
    + '<div class="story-folders" style="display:flex;gap:8px">'
    + '<button type="button" class="story-folder">' + marquee(DE) + "</button>"
    + '<button type="button" class="story-folder">' + marquee(RU) + "</button>"
    + "</div>"
    + '<div class="cm-filter-bar"><button class="cm-chip" type="button">' + marquee(DE) + "</button></div>"
    + '<div class="yt-chips"><button class="yt-chip" type="button"><span>' + marquee(RU) + "</span></button></div>"
    + '<div class="hist-chips"><button class="hist-chip" type="button">' + marquee(DE) + "</button></div>"
    + '<div class="friends-pills"><button class="friends-pill" type="button">' + marquee(RU) + "</button></div>"
    + '<div class="tabs ptabs"><a class="tab" href="#/"><span>' + marquee(DE) + "</span></a></div>"
    + '<div class="pills"><button class="pill" type="button"><span>' + marquee(RU) + "</span></button></div>"
    + "</div>";
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}

async function measure(page) {
  return page.evaluate(() => {
    const problems = [];
    document.querySelectorAll("#pill-fit-demo .sp-pill, #pill-fit-demo .sc-pill, #pill-fit-demo .story-folder, #pill-fit-demo .cm-chip, #pill-fit-demo .yt-chip, #pill-fit-demo .hist-chip, #pill-fit-demo .friends-pill, #pill-fit-demo .ptabs .tab, #pill-fit-demo .pill").forEach((pill) => {
      const box = pill.getBoundingClientRect();
      const text = pill.querySelector(".sp-marquee-text") || pill;
      const clip = pill.querySelector(".sp-marquee-clip") || text;
      const tb = text.getBoundingClientRect();
      const cb = clip.getBoundingClientRect();
      const name = pill.className;
      if (tb.height > 1 && (tb.top < box.top - 1 || tb.bottom > box.bottom + 1)) problems.push(name + " text escapes vertically");
      if (cb.top < box.top - 1 || cb.bottom > box.bottom + 1 || cb.left < box.left - 1 || cb.right > box.right + 1) {
        problems.push(name + " clip " + JSON.stringify({ box: [box.left, box.top, box.right, box.bottom], clip: [cb.left, cb.top, cb.right, cb.bottom] }));
      }
      const host = pill.querySelector("[data-sp-marquee]");
      if (host && !host.classList.contains("is-on")) problems.push(name + " long text does not scroll");
      if (box.width < 72) {
        const text = pill.querySelector(".sp-pill-text, .sp-marquee");
        const cs = text ? getComputedStyle(text) : null;
        const ps = getComputedStyle(pill);
        problems.push(name + " collapsed to " + Math.round(box.width) + " pill " + [ps.display, ps.width, ps.maxWidth, ps.flex].join("|") + " text " + (cs ? [cs.display, cs.width, cs.maxWidth, cs.flex].join("|") : "none"));
      }
      const copies = [...pill.querySelectorAll(".sp-marquee.is-on .sp-marquee-copy")];
      if (copies.length >= 2) {
        const a = copies[0].getBoundingClientRect();
        const b = copies[1].getBoundingClientRect();
        if (a.width < 80) problems.push(name + " copy is " + Math.round(a.width));
        if (b.left < a.right - 4) problems.push(name + " copies overlap");
      }
      const top = pill.querySelector(".sc-pill-top");
      const bottom = pill.querySelector(".sc-pill-bottom");
      if (top && bottom) {
        const a = top.getBoundingClientRect();
        const b = bottom.getBoundingClientRect();
        if (a.bottom > b.top + 0.5) problems.push(name + " lines overlap");
        [top, bottom].forEach((row) => {
          const glyph = row.querySelector(".sp-marquee-text, .sc-pill-score, .wx-range");
          if (!glyph) return;
          const g = glyph.getBoundingClientRect();
          if (g.top < box.top - 1 || g.bottom > box.bottom + 1) problems.push(name + " glyph clipped " + Math.round(g.top - box.top) + "/" + Math.round(g.bottom - box.bottom));
        });
      }
    });
    const heights = {
      home: Math.round(document.querySelector("#pill-fit-demo .sp-pill").getBoundingClientRect().height),
      score: Math.round(document.querySelector("#pill-fit-demo .sc-pill").getBoundingClientRect().height),
      story: Math.round(document.querySelector("#pill-fit-demo .story-folder").getBoundingClientRect().height),
      filter: Math.round(document.querySelector("#pill-fit-demo .cm-chip").getBoundingClientRect().height)
    };
    return { problems, heights };
  });
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const sizes = [
    { name: "iphone11", width: 414, height: 896 },
    { name: "desktop", width: 1280, height: 800 }
  ];
  try {
    for (const size of sizes) {
      const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
      await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => ["spaces.css", "scores.css", "stories.css", "styles.css"].every((name) => [...document.styleSheets].some((sheet) => (sheet.href || "").includes(name))));
      await page.evaluate(() => {
        if ([...document.styleSheets].some((sheet) => (sheet.href || "").includes("communities.css"))) return;
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "communities.css";
        document.head.appendChild(link);
      });
      await page.waitForFunction(() => [...document.styleSheets].some((sheet) => (sheet.href || "").includes("communities.css")));
      await page.evaluate((html) => {
        document.body.insertAdjacentHTML("afterbegin", html);
      }, demo());
      await page.evaluate(() => {
        document.querySelectorAll("#pill-fit-demo [data-sp-marquee]").forEach((el) => {
          const clip = el.querySelector(".sp-marquee-clip");
          const text = el.querySelector(".sp-marquee-text");
          if (clip && text && text.scrollWidth > clip.clientWidth + 1) {
            el.classList.add("is-on", "is-paused");
          }
        });
      });
      const result = await measure(page);
      if (result.heights.home !== 36 || result.heights.score !== 36) fail(size.name + " home pill size changed " + JSON.stringify(result.heights));
      if (result.heights.story !== 24) fail(size.name + " story folder size changed " + result.heights.story);
      if (result.heights.filter !== 32) fail(size.name + " filter pill size changed " + result.heights.filter);
      if (result.problems.length) fail(size.name + " " + result.problems.join("; "));
      if (process.env.PILL_SHOT) {
        await page.screenshot({ path: process.env.PILL_SHOT + "-" + size.name + ".png" });
        await page.locator("#pill-fit-demo").screenshot({ path: process.env.PILL_SHOT + "-pills-" + size.name + ".png" });
      }
      await page.close();
    }
    console.log("pill fit ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
