/* Profile banner buttons at phone and tablet widths. Placeholders only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

async function openProfile(browser, port, size) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
  });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1")) route.continue();
    else route.abort();
  });
  await page.goto("http://127.0.0.1:" + port + "/index.html#/x/user_a", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".profile-chrome", { timeout: 15000 });
  return { context, page };
}

async function check(page, label) {
  const bare = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".profile-chrome .pfloat-btn")];
    const name = document.querySelector(".profile-chrome-copy");
    const avatar = document.querySelector(".pava, .pname");
    const first = buttons[0] ? buttons[0].getBoundingClientRect() : null;
    const face = avatar ? avatar.getBoundingClientRect() : null;
    return {
      oldBar: !!document.querySelector(".topbar, .page-head"),
      banner: !!document.querySelector(".pbanner"),
      buttons: buttons.length,
      nameHidden: !!(name && name.hidden),
      clear: !!(first && face && face.top >= first.bottom - 1)
    };
  });
  if (bare.oldBar) fail(label + " still has the old header");
  if (bare.banner) fail(label + " drew a banner placeholder");
  if (bare.buttons !== 4) fail(label + " button count " + bare.buttons);
  if (!bare.nameHidden) fail(label + " shows the name before scrolling");
  if (!bare.clear) fail(label + " buttons overlap the profile");
  const laid = await page.evaluate(() => {
    const top = document.querySelector(".profile-top");
    top.classList.remove("no-banner");
    top.classList.add("has-banner");
    const img = document.createElement("img");
    img.className = "pbanner";
    img.alt = "";
    img.src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"></svg>');
    top.appendChild(img);
    const banner = img.getBoundingClientRect();
    const buttons = [...document.querySelectorAll(".profile-chrome .pfloat-btn")].map((btn) => btn.getBoundingClientRect());
    const ratio = banner.height / banner.width;
    return {
      ratio: ratio,
      over: buttons.every((item) => item.top >= banner.top - 2 && item.bottom <= banner.bottom + 2),
      wide: Math.round(banner.width) >= Math.round(document.querySelector("main").getBoundingClientRect().width) - 2
    };
  });
  if (Math.abs(laid.ratio - 1 / 3) > 0.04) fail(label + " banner size changed");
  if (!laid.over) fail(label + " buttons are not over the banner");
  if (!laid.wide) fail(label + " banner is not full width");
  await page.click("[data-act='profile-tools']");
  await page.waitForSelector(".profile-menu", { timeout: 5000 });
  const tools = await page.evaluate(() => {
    const menu = document.querySelector(".profile-menu");
    const text = menu ? menu.innerText : "";
    const broken = [...menu.querySelectorAll("a")].some((link) => !link.getAttribute("href") || link.getAttribute("href") === "#");
    return { feeds: text.indexOf("View in Feeds") >= 0, original: text.indexOf("Open original") >= 0, broken: broken };
  });
  if (!tools.feeds || !tools.original || tools.broken) fail(label + " feed tools");
  await page.click("[data-act='close-profile-menu']");
  await page.click("[data-act='profile-search']");
  await page.waitForSelector("#profile-q", { timeout: 5000 });
  await page.click("[data-act='profile-more']");
  await page.waitForSelector(".profile-menu [data-act='share']", { timeout: 5000 });
  const more = await page.evaluate(() => {
    const menu = document.querySelector(".profile-menu");
    const report = menu && [...menu.querySelectorAll("button")].some((btn) => /report/i.test(btn.textContent || ""));
    const block = menu && [...menu.querySelectorAll("[data-act='profile-block']")].length;
    return { report: report, block: block };
  });
  if (more.report || more.block) fail(label + " unpaid actions are visible");
  await page.click("[data-act='close-profile-menu']");
  await page.evaluate(() => {
    document.body.style.minHeight = "3000px";
    window.scrollTo(0, 500);
  });
  await page.waitForFunction(() => {
    const bar = document.querySelector(".profile-chrome");
    const copy = document.querySelector(".profile-chrome-copy");
    return !!(bar && bar.classList.contains("is-solid") && copy && !copy.hidden);
  }, null, { timeout: 5000 });
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    for (const size of SIZES) {
      const opened = await openProfile(browser, port, size);
      try {
        await check(opened.page, size.name);
      } finally {
        await opened.context.close();
      }
    }
    console.log("profile chrome ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().then(async () => {
  if (process.exitCode) return;
  // @mention suggestions ride along so the smoke workflow runs them.
  const { spawnSync } = await import("node:child_process");
  const mentions = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "mention_suggest_test.mjs")], { stdio: "inherit", env: process.env });
  if (mentions.status !== 0) process.exitCode = 1;
  const friendState = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "friend_state_test.mjs")], { stdio: "inherit", env: process.env });
  if (friendState.status !== 0) process.exitCode = 1;
  const myDevices = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "my_devices_test.mjs")], { stdio: "inherit", env: process.env });
  if (myDevices.status !== 0) process.exitCode = 1;
  const feedsPage = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "feeds_page_test.mjs")], { stdio: "inherit", env: process.env });
  if (feedsPage.status !== 0) process.exitCode = 1;
  const feedRequests = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "feed_requests_approve_test.mjs")], { stdio: "inherit", env: process.env });
  if (feedRequests.status !== 0) process.exitCode = 1;
}).catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
