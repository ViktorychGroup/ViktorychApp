/* The story bar stays in normal flow at phone, tablet, and desktop widths.
   It must not be fixed, blurred, or drawn over the first post. */
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
  const css = read("stories.css");
  const shell = css.slice(css.indexOf(".story-shell {"), css.indexOf(".story-tray {"));
  if (!shell.includes("position: relative")) fail("story shell must stay in flow");
  if (/position:\s*fixed/.test(shell) || /position:\s*absolute/.test(shell)) fail("story shell must not cover the feed");
  if (!shell.includes("backdrop-filter: none")) fail("story shell must not blur the feed");
  if (!css.includes("height: 112px") || !css.includes("height: 52px") || !css.includes("height: 28px")) fail("collapse heights missing");
  if (!css.includes(".story-shell[data-state=\"slim\"] .note-bubble") || !css.includes(".story-folders") || !css.includes("display: none")) fail("collapsed bar must hide note bubbles and folders");
  if (!css.includes("border-radius: 999px")) fail("story rings must be circles");
  if (!css.includes("max-width: 499px") || !css.includes("min-width: 1000px") || !css.includes("max-width: 999px")) fail("story bar needs phone, tablet, and desktop rules");
  const app = read("app.js");
  const header = app.slice(app.indexOf("function homeHeader"), app.indexOf("function tabChoice"));
  const trayAt = header.indexOf("Stories.homeTray");
  const tabsAt = header.indexOf('class="tabs-bar"');
  if (trayAt < 0 || tabsAt < 0 || trayAt > tabsAt) fail("stories must sit above For you and Following");
  if (!app.includes('getElementById("new-posts")')) fail("new posts pill hook missing");
  if (!read("sw.js").includes('VERSION = "viktorych-a396-__SW_VERSION__"')) fail("service worker cache was not bumped");
  console.log("ok story bar layout rules");
}

function mime(file) {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  return "text/html; charset=utf-8";
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><head><link rel=\"stylesheet\" href=\"/stories.css\"></head><body><div id=\"mount\"></div><article id=\"post\">post</article><div id=\"stories\" hidden></div><script src=\"/stories.js\"></script></body></html>");
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
      res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "";
  if (!spec) return null;
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}

async function browserChecks() {
  const chromium = await loadPlaywright();
  if (!chromium) {
    console.log("story bar browser check skipped");
    return;
  }
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const widths = [390, 768, 1280];
  try {
    for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        localStorage.removeItem("viktorych-stories-bar-v1");
        Stories.bind({
          icon: function () { return "<svg></svg>"; },
          follows: function () { return ["app:user_a"]; },
          owner: function () { return false; },
          account: function () { return { handle: "user_b", displayName: "User B", avatar: "" }; }
        });
        Stories.apply({
          telegramConnected: true,
          accounts: [{
            id: "app:user_a",
            platform: "app",
            handle: "user_a",
            name: "User A",
            items: [{ id: "1", type: "photo", url: "icons/icon-192.png", date: "2026-10-28T00:00:00Z", expires: "2026-10-29T00:00:00Z" }]
          }]
        });
        Stories.setNotes({ mine: { text: "" }, notes: [{ handle: "user_a", name: "User A", text: "hi" }] });
        document.getElementById("mount").innerHTML = Stories.homeTray();
      });
      const before = await page.evaluate(() => {
        const shell = document.querySelector(".story-shell");
        const post = document.getElementById("post");
        const style = getComputedStyle(shell);
        const shellBox = shell.getBoundingClientRect();
        const postBox = post.getBoundingClientRect();
        return {
          position: style.position,
          blur: style.backdropFilter || style.webkitBackdropFilter || "none",
          height: shellBox.height,
          overlap: shellBox.bottom - postBox.top
        };
      });
      if (before.position === "fixed" || before.position === "absolute") fail(width + " shell covers the page");
      if (before.blur && before.blur !== "none") fail(width + " shell blurs the feed");
      if (before.overlap > 1) fail(width + " shell overlaps the post");
      if (before.height < 100) fail(width + " expanded bar is too short");
      const note = await page.evaluate(() => {
        const slot = document.querySelector(".note-slot");
        const bubble = slot && slot.querySelector(".note-bubble");
        const ring = slot && slot.querySelector(".story-ring");
        const shell = document.querySelector(".story-shell");
        if (!bubble || !ring || !shell) return null;
        const b = bubble.getBoundingClientRect();
        const r = ring.getBoundingClientRect();
        const style = getComputedStyle(bubble);
        return {
          overlap: Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top),
          above: b.bottom <= r.top + 1,
          shell: Math.round(shell.getBoundingClientRect().height),
          blur: style.backdropFilter || style.webkitBackdropFilter || "none"
        };
      });
      if (!note) fail(width + " note bubble missing");
      if (note.above || note.overlap < 8) fail(width + " note bubble does not sit on the avatar");
      if (!note.blur || note.blur === "none") fail(width + " note bubble is not translucent");
      if (note.shell !== 112) fail(width + " story row height changed " + note.shell);
      await page.click(".story-fold");
      await page.waitForTimeout(320);
      const after = await page.evaluate(() => {
        const shell = document.querySelector(".story-shell");
        const post = document.getElementById("post");
        return {
          state: localStorage.getItem("viktorych-stories-bar-v1"),
          height: shell.getBoundingClientRect().height,
          overlap: shell.getBoundingClientRect().bottom - post.getBoundingClientRect().top
        };
      });
      if (after.state !== "slim") fail(width + " collapse was not remembered");
      if (after.height > before.height - 20) fail(width + " collapse did not shrink the bar");
      if (after.overlap > 1) fail(width + " collapsed bar overlaps the post");
      const bubbles = await page.evaluate(() => {
        const node = document.querySelector(".note-bubble");
        const folders = document.querySelector(".story-folders");
        if (!node || !folders) return "missing";
        return getComputedStyle(node).display + " " + getComputedStyle(folders).display;
      });
      if (bubbles !== "none none") fail(width + " collapsed bar still shows note bubbles or folders");
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log("ok story bar at phone, tablet, and desktop widths");
}

staticChecks();
await browserChecks();
