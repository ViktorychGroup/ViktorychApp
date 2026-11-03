/* Store, stickers, terms, purchases and the gift sheet without payment keys:
   prices show, money says Coming soon, nothing locks, no page errors. Placeholders only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const widths = [
  { width: 390, height: 844, name: "phone" },
  { width: 1280, height: 800, name: "desktop" }
];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function mime(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".ico")) return "image/x-icon";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
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
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}


const CATALOG = {
  payments: { enabled: false, providers: [], currency: "eur" },
  tiers: { free: { cents: 0 }, small: { cents: 99 }, medium: { cents: 299 }, premium: { cents: 699 } },
  refundDays: 14,
  limited: [{ id: "unicorn_gold", sold: 3, limit: 250, open: true }, { id: "pumpkin_2026", sold: 0, limit: 1000, open: true }, { id: "crown_founders", sold: 0, limit: 500, open: true }],
  stickers: [{ id: "starter", owned: true }, { id: "critters", owned: false }],
  emojis: [{ id: "flame", emoji: "\u{1F525}", name: "Flame status", tier: "small", viktorychs: 20, popular: true, owned: true }, { id: "rocket", emoji: "\u{1F680}", name: "Rocket status", tier: "medium", viktorychs: 40, popular: true, owned: false }],
  balance: 120,
  owner: false
};

async function check(page, origin, vp) {
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err && err.message || err)));
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/v1/store/catalog") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CATALOG) });
      return;
    }
    if (url.pathname === "/v1/store/orders") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ orders: [] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[],"ok":true,"balance":120,"history":[]}' });
  });
  for (const hash of ["#/store", "#/store/stickers", "#/store/emojis", "#/store/terms", "#/store/orders", "#/points"]) {
    await page.goto(origin + "/" + hash, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector(".store-page, .points-page, .vkg"), null, { timeout: 20000 });
    await page.waitForTimeout(400);
    const text = await page.evaluate(() => document.body.innerText);
    if (hash === "#/store" && text.indexOf("Card payments are coming soon") < 0) fail(vp.name + " store has no coming-soon note");
    if (hash === "#/store/stickers" && text.indexOf("Cute critters") < 0) fail(vp.name + " sticker packs missing");
    if (hash === "#/store/emojis" && (text.indexOf("Rocket status") < 0 || text.indexOf("Status emojis") < 0)) fail(vp.name + " status emojis missing");
    if (hash === "#/store/terms" && text.indexOf("no cash value") < 0) fail(vp.name + " terms missing");
    if (hash === "#/points" && text.indexOf("never sold") < 0) fail(vp.name + " points page missing the earn rules");
    if (/buy viktorychs|viktorych pack/i.test(text)) fail(vp.name + " a buy-Viktorychs path is visible on " + hash);
  }
  await page.goto(origin + "/#/settings", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("main.center .topbar", { timeout: 20000 });
  const base = await page.evaluate(() => Math.round(document.querySelector("main.center").getBoundingClientRect().width));
  for (const hash of ["#/store", "#/store/stickers", "#/points"]) {
    for (const theme of ["lightsout", "dim", "default"]) {
      await page.goto(origin + "/" + hash, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector(".store-page, .points-page"), null, { timeout: 20000 });
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      const shell = await page.evaluate(() => {
        const center = document.querySelector("main.center");
        const page = document.querySelector(".store-page, .points-page");
        const head = page.querySelector(".topbar .page-head");
        const back = head && head.querySelector("[data-act='back'], a.icon-btn");
        const css = (el, prop) => el ? getComputedStyle(el).getPropertyValue(prop) : "";
        const bottom = document.querySelector(".bottom-nav");
        return {
          app: document.querySelector(".app").className,
          nav: !!document.querySelector(".app > nav, .app > header, .app .left-nav, .app nav"),
          side: !!document.querySelector(".app > aside.side"),
          centerWidth: center ? Math.round(center.getBoundingClientRect().width) : 0,
          pageWidth: Math.round(page.getBoundingClientRect().width),
          head: !!head,
          back: !!back,
          sticky: css(page.querySelector(".topbar"), "position"),
          pageBg: css(page, "background-color"),
          bodyBg: css(document.body, "background-color"),
          rootBg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
          headFont: css(head, "font-family"),
          gradient: Array.from(page.querySelectorAll("*")).filter((el) => !el.classList.contains("topbar") && getComputedStyle(el).backgroundImage.indexOf("gradient") >= 0).map((el) => el.tagName + "." + el.className).join(" "),
          bottom: bottom ? getComputedStyle(bottom).display !== "none" && bottom.getBoundingClientRect().height > 0 : false
        };
      });
      const tag = vp.name + " " + theme + " " + hash;
      if (/gifts-mode|\bwide\b/.test(shell.app)) fail(tag + " leaves the standard shell: " + shell.app);
      if (!shell.head || !shell.back) fail(tag + " has no X header with a back arrow");
      if (shell.sticky !== "sticky" && shell.sticky !== "fixed") fail(tag + " header is not sticky: " + shell.sticky);
      if (shell.pageBg !== "rgba(0, 0, 0, 0)" && shell.pageBg !== shell.bodyBg) fail(tag + " page background " + shell.pageBg + " is not the theme background " + shell.bodyBg);
      if (theme === "lightsout" && shell.bodyBg !== "rgb(0, 0, 0)") fail(tag + " is not pure black: " + shell.bodyBg);
      if (shell.gradient) fail(tag + " uses a gradient: " + shell.gradient);
      if (shell.headFont.indexOf("TwitterChirp") < 0) fail(tag + " header font is not the X font");
      if (vp.name === "desktop") {
        if (!shell.side) fail(tag + " lost the right sidebar");
        if (shell.centerWidth !== base) fail(tag + " primary column is " + shell.centerWidth + "px, Settings is " + base + "px");
        if (shell.pageWidth > base) fail(tag + " page is wider than the column");
      } else if (!shell.bottom) fail(tag + " hides the bottom tab bar");
    }
  }
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "lightsout"));
  await page.goto(origin + "/#/store", { waitUntil: "domcontentloaded" });
  const tile = page.locator("[data-gift='pick']").first();
  await tile.waitFor({ timeout: 20000 });
  await tile.click();
  await page.locator(".gift-sheet").waitFor({ timeout: 10000 });
  await page.locator("[data-gift='for-me']").click();
  const money = page.locator("input[data-gift-pay][value='money']");
  if (await money.count()) {
    await money.check();
    const sheet = await page.locator(".gift-sheet").innerText();
    if (sheet.indexOf("Coming soon") < 0) fail(vp.name + " money option is not marked Coming soon");
  }
  await page.locator(".gift-sheet [data-gift='close']").click();
  await page.waitForFunction(() => !document.querySelector(".gift-sheet"));
  await page.goto(origin + "/#/store/emojis", { waitUntil: "domcontentloaded" });
  const getEmoji = page.locator("[data-gift='emoji'][data-emoji-id='rocket']");
  await getEmoji.waitFor({ timeout: 20000 });
  await getEmoji.click();
  await page.locator(".gift-sheet").waitFor({ timeout: 10000 });
  const emojiSheet = await page.locator(".gift-sheet").innerText();
  if (emojiSheet.indexOf("Rocket status") < 0) fail(vp.name + " status emoji sheet has no name");
  if (await page.locator(".gift-sheet input[data-gift-pay='money']").count()) fail(vp.name + " status emojis offer a money price");
  await page.locator(".gift-sheet [data-gift='close']").click();
  await page.waitForFunction(() => !document.querySelector(".gift-sheet"));
  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  const opener = page.locator(vp.name === "phone" ? "button.fab" : "button.post-btn").first();
  await opener.waitFor({ state: "visible", timeout: 20000 });
  await opener.click();
  await page.locator(".xc-modal #compose-text").waitFor({ timeout: 15000 });
  await page.locator(".xc-modal [data-act='xc-emoji']").first().click();
  const pick = page.locator(".xc-modal [data-act='xc-sticker-add']").first();
  await pick.waitFor({ timeout: 10000 });
  await pick.click();
  const typed = await page.locator(".xc-modal #compose-text").inputValue();
  if (!/\[\[sticker:starter\/[a-z_]+\]\]/.test(typed)) fail(vp.name + " sticker was not added to the post: " + typed);
  await page.keyboard.press("Escape");
  if (errors.length) fail(vp.name + " page errors: " + errors.join(" | "));
  await page.unroute("**/v1/**");
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    for (const vp of widths) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await page.addInitScript(() => {
        localStorage.setItem("viktorychapp-lang-user-picked", "1");
        localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
        localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
          token: "local-test-token",
          account: { publicId: "100000000001", handle: "user_a", displayName: "User A", avatar: "" }
        }));
        window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true };
      });
      await check(page, origin, vp);
      await page.close();
    }
    console.log("store page ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
