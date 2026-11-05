/* Home tabs stay full length and pills slim down. Placeholders only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { runScripts, sharedStaticServer } from "./smoke_runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const longName = "🚀 A very long custom feed name that must stay whole on the tab row and scroll it";

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function mime(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
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

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}

const SIZES = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1280, height: 800 }
];

async function openHome(browser, port, size, reduced) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    reducedMotion: reduced ? "reduce" : "no-preference"
  });
  const page = await context.newPage();
  await page.addInitScript((name) => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({
      version: 1,
      initialized: true,
      follows: [],
      lists: [],
      likes: {},
      bookmarks: {},
      reposts: {},
      feedTabs: [{ id: "alpha", name: name, emoji: "🚀", color: "", showHome: true, showNotes: true, members: [] }]
    }));
  }, longName);
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1")) route.continue();
    else route.abort();
  });
  await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".tabs-bar .tab");
  await page.waitForSelector(".sp-pill");
  return { context, page };
}

async function check(page, label, reduced) {
  const box = await page.evaluate((name) => {
    const bar = document.querySelector(".tabs-bar");
    const scroller = document.querySelector(".tabs-bar .tabs");
    const tab = document.querySelector("[data-tab='cat:alpha']");
    const pill = document.querySelector(".sp-pill");
    const icons = tab ? tab.querySelectorAll("svg, img").length : 0;
    return {
      name: tab ? tab.textContent : "",
      bar: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
      pill: pill ? Math.round(pill.getBoundingClientRect().height) : 0,
      scrolls: !!(scroller && scroller.scrollWidth > scroller.clientWidth + 8),
      icons: icons,
      clip: tab ? getComputedStyle(tab.querySelector("span")).textOverflow : ""
    };
  }, longName);
  if (box.name.indexOf(longName) < 0) fail(label + " cut the tab name");
  if (box.bar < 40 || box.bar > 48) fail(label + " tab bar height " + box.bar);
  if (box.pill < 32 || box.pill > 40) fail(label + " pill height " + box.pill);
  if (!box.scrolls) fail(label + " tab row does not scroll");
  if (box.icons) fail(label + " placeholder icon");
  if (box.clip === "ellipsis") fail(label + " ellipsis on the tab");
  const longPill = "A long pill title that should travel instead of being cut off at the edge of the pill";
  // The live row is rebuilt when Spaces or weather finish loading. Put the
  // long title back on each rebuild until the marquee actually starts.
  await page.waitForFunction((spec) => {
    const title = spec.title;
    document.querySelectorAll(".sp-pill .sp-marquee-text, .sc-pill .sp-marquee-text, .wx-pill .sp-marquee-text").forEach((node) => {
      if ((node.textContent || "").length < 40) node.textContent = title;
    });
    const nodes = [...document.querySelectorAll(".sp-pill [data-sp-marquee], .sc-pill [data-sp-marquee], .wx-pill [data-sp-marquee]")].filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 8 && box.height > 8;
    });
    if (!nodes.length) return false;
    return nodes.every((el) => {
      const text = el.querySelector(".sp-marquee-text");
      if (!text || text.textContent.length < 40) return false;
      const on = el.classList.contains("is-on");
      return spec.wantOff ? !on : on;
    });
  }, { title: longPill, wantOff: reduced }, { timeout: 8000 });
  if (!reduced) {
    // A home rebuild can replace the row between a click and a later read.
    // Put the long title back, press the visible space pill at its center,
    // and read that pill's own marquee in the same turn.
    try {
      await page.waitForFunction((title) => {
        document.querySelectorAll(".sp-pill .sp-marquee-text, .sc-pill .sp-marquee-text, .wx-pill .sp-marquee-text").forEach((node) => {
          if ((node.textContent || "").length < 40) node.textContent = title;
        });
        const pills = [...document.querySelectorAll(".sp-pill")].filter((pill) => {
          const box = pill.getBoundingClientRect();
          const marquee = pill.querySelector("[data-sp-marquee]");
          return box.width > 8 && box.height > 8 && marquee && marquee.classList.contains("is-on");
        });
        const pill = pills[0];
        if (!pill) return false;
        const box = pill.getBoundingClientRect();
        pill.dispatchEvent(new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
          pointerType: "mouse",
          button: 0,
          buttons: 1,
          isPrimary: true
        }));
        const marquee = pill.querySelector("[data-sp-marquee]");
        return !!(marquee && marquee.classList.contains("is-held"));
      }, longPill, { timeout: 4000 });
    } catch (err) {
      fail(label + " marquee did not pause");
    }
  }
}

async function main() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const chromium = await loadPlaywright();
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    for (const size of SIZES) {
      const opened = await openHome(browser, port, size, false);
      try {
        await check(opened.page, size.name, false);
      } finally {
        await opened.context.close();
      }
    }
    const reduced = await openHome(browser, port, SIZES[0], true);
    try {
      await check(reduced.page, "reduced", true);
    } finally {
      await reduced.context.close();
    }
    console.log("home tabs ok");
  } finally {
    await browser.close();
    server.close();
  }
  // The boot timing check runs alone, after the other script has exited.
  const [tabs] = await runScripts(dir, ["custom_tab_reload_test.mjs"]);
  if (tabs !== 0) process.exitCode = 1;
  if (process.exitCode) return;
  const [boot] = await runScripts(dir, ["boot_speed_test.mjs"]);
  if (boot !== 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
