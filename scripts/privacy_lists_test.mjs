/* Following, followers, notifications, and the side menu stay readable
   with the privacy screen off and on. The cover is an overlay only while
   the window is in the background. Placeholders only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { runScripts, sharedStaticServer } from "./smoke_runtime.mjs";

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
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
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
  { name: "phone", width: 390, height: 844, mobile: true },
  { name: "desktop", width: 1280, height: 800, mobile: false }
];

function sessionScript(privacyMode) {
  const settings = { version: 1, initialized: true };
  const account = { handle: "user_a", displayName: "User A" };
  const modeLine = privacyMode
    ? `localStorage.setItem("viktorychapp-privacy-mode", ${JSON.stringify(privacyMode)});`
    : `localStorage.removeItem("viktorychapp-privacy-mode");`;
  return `(() => {
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-settings-v1", ${JSON.stringify(JSON.stringify(settings))});
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-a", account: ${JSON.stringify(account)} }));
    ${modeLine}
    window.VIKTORYCH_ACCOUNTS = { api: "https://accounts.test", gate: true, tiktokAudience: "owner" };
  })()`;
}

function installRoutes(page) {
  return page.route("**/v1/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/v1/notifications")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [{ id: "n1", at: 1, kind: "like", handle: "user_b", name: "User B", text: "a short note", hash: "#/" }],
          unread: 1,
          readUntil: 0,
          cursor: 1,
          tabs: []
        })
      });
      return;
    }
    if (url.includes("/v1/follows") && url.includes("tab=followers")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accounts: [{ id: "app:@user_d", handle: "user_d", name: "User D", displayName: "User D" }],
          followersCount: 1,
          cursor: ""
        })
      });
      return;
    }
    if (url.includes("/v1/follows") && url.includes("tab=following")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accounts: [
            { id: "app:@user_b", handle: "user_b", name: "User B", displayName: "User B", avatar: "https://example.com/user_b.png", avatarFace: "photo" },
            { id: "x:user_c", handle: "user_c", name: "User C", displayName: "User C" }
          ],
          followingCount: 2,
          cursor: ""
        })
      });
      return;
    }
    if (url.includes("/v1/profile/")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ account: { handle: "user_a", displayName: "User A" }, reposts: [] })
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

function readIdentity(sel) {
  const el = document.querySelector(sel);
  if (!el) return { missing: true };
  el.scrollIntoView({ block: "center", inline: "nearest" });
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const x = Math.min(window.innerWidth - 2, Math.max(2, rect.left + Math.min(Math.max(rect.width - 2, 1), 12)));
  const y = Math.min(window.innerHeight - 2, Math.max(2, rect.top + rect.height / 2));
  const hit = document.elementFromPoint(x, y);
  const cover = document.getElementById("privacy-cover");
  const row = el.closest(".connect-row, .note-row, .drawer-x, .notes-state");
  return {
    text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
    w: rect.width,
    h: rect.height,
    color: style.color,
    visibility: style.visibility,
    display: style.display,
    filter: style.filter,
    opacity: style.opacity,
    inline: el.getAttribute("style") || "",
    rowInline: row ? (row.getAttribute("style") || "") : "",
    hitCover: !!(hit && hit.closest && hit.closest("#privacy-cover")),
    coverOpen: !!(cover && !cover.hasAttribute("hidden") && getComputedStyle(cover).display !== "none"),
    coverAttr: document.documentElement.getAttribute("data-privacy-cover") || "",
    modeAttr: document.documentElement.getAttribute("data-privacy-mode") || "",
    sensitive: !!document.querySelector("[data-privacy='sensitive']")
  };
}

function assertShown(info, label, text) {
  if (!info || info.missing) fail(label + " missing");
  if (info.w < 8 || info.h < 8) fail(label + " has no size");
  if (!info.text || info.text.indexOf(text) < 0) fail(label + " text");
  if (info.visibility !== "visible" || info.display === "none") fail(label + " hidden " + info.visibility + " " + info.display);
  if (info.filter && info.filter !== "none") fail(label + " filtered");
  if (info.opacity === "0") fail(label + " transparent");
  if (info.color === "transparent" || info.color === "rgba(0, 0, 0, 0)") fail(label + " colorless");
  if (info.inline || info.rowInline) fail(label + " inline style");
  if (info.hitCover || info.coverOpen) fail(label + " covered");
  if (info.coverAttr || info.modeAttr) fail(label + " privacy attribute");
  if (info.sensitive) fail(label + " sensitive mark");
}

async function readBox(page, selector) {
  return page.evaluate(readIdentity, selector);
}

async function openApp(browser, port, size, privacyMode) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    isMobile: !!size.mobile,
    hasTouch: !!size.mobile,
    serviceWorkers: "block",
    userAgent: size.mobile
      ? "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
      : undefined
  });
  const page = await context.newPage();
  await installRoutes(page);
  await page.addInitScript(sessionScript(privacyMode));
  await page.goto("http://127.0.0.1:" + port + "/index.html#/@user_a/following", { waitUntil: "domcontentloaded" });
  return { context, page };
}

async function settle(page) {
  await page.evaluate(() => {
    window.focus();
    document.hasFocus = () => true;
    if (window.ViktorychPrivacy && window.ViktorychPrivacy.clear) window.ViktorychPrivacy.clear();
  });
}

async function checkLists(page, label) {
  await settle(page);
  await page.waitForSelector(".connect-row .name", { timeout: 15000 });
  const names = await page.locator(".connect-row .name").allInnerTexts();
  if (!names.some((text) => text.includes("User B"))) fail(label + " following name");
  if (!names.some((text) => text.includes("User C"))) fail(label + " second following name");
  const handles = await page.locator(".connect-row .handle").allInnerTexts();
  if (!handles.some((text) => text.includes("@user_b"))) fail(label + " following handle");
  if (!handles.some((text) => text.includes("@user_c"))) fail(label + " second following handle");
  const avatars = await page.locator(".connect-row .ava").count();
  if (avatars < 2) fail(label + " following avatars");
  const avatarBox = await page.evaluate(() => {
    const el = document.querySelector(".connect-row .ava");
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { w: rect.width, h: rect.height, visibility: style.visibility, filter: style.filter };
  });
  if (!avatarBox || avatarBox.w < 24 || avatarBox.h < 24) fail(label + " avatar size");
  if (avatarBox.visibility !== "visible" || (avatarBox.filter && avatarBox.filter !== "none")) fail(label + " avatar style");
  assertShown(await readBox(page, ".connect-row .name"), label + " following", "User");
  const buttons = await page.locator(".connect-row .follow").count();
  if (buttons < 1) fail(label + " follow button");

  await page.goto(page.url().split("#")[0] + "#/@user_a/followers", { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.waitForFunction(() => {
    const name = document.querySelector(".connect-row .name");
    return !!(name && name.textContent && name.textContent.indexOf("User D") >= 0);
  }, null, { timeout: 15000 });
  assertShown(await readBox(page, ".connect-row .name"), label + " followers", "User D");
  const followerHandle = await page.locator(".connect-row .handle").first().innerText();
  if (!followerHandle.includes("@user_d")) fail(label + " follower handle");
  if (await page.locator(".connect-row .ava").count() < 1) fail(label + " follower avatar");

  await page.goto(page.url().split("#")[0] + "#/notifications", { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.waitForSelector(".note-line", { timeout: 15000 });
  assertShown(await readBox(page, ".note-line"), label + " notifications", "User B");

  const wide = await page.evaluate(() => window.innerWidth >= 500);
  if (wide) {
    assertShown(await readBox(page, "header.nav:not(.nav-land) button.account-pill"), label + " sidebar account", "User A");
    const handle = await page.locator("header.nav:not(.nav-land) button.account-pill").innerText();
    if (!handle.includes("@user_a")) fail(label + " sidebar handle");
    if (!(await page.locator("header.nav a.nav-item[href='#/bookmarks']").count())) fail(label + " sidebar bookmarks");
    await page.locator("header.nav:not(.nav-land) button.account-pill").click();
    await page.waitForSelector(".acct-menu a[href='#/settings']", { timeout: 5000 });
    if (await page.locator(".drawer-x").count()) fail(label + " desktop drawer");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".acct-menu", { state: "detached", timeout: 5000 });
    return;
  }
  await page.locator("[data-act='drawer']").locator("visible=true").first().click();
  await page.waitForSelector(".drawer-x .drawer-name", { timeout: 5000 });
  assertShown(await readBox(page, ".drawer-x .drawer-name"), label + " menu name", "User A");
  assertShown(await readBox(page, ".drawer-x .drawer-handle"), label + " menu handle", "@user_a");
  const row = await page.locator(".drawer-x .drawer-label").first();
  if (!(await row.count())) fail(label + " menu rows");
  const rowText = (await row.innerText()).trim();
  if (!rowText) fail(label + " menu row text");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".drawer-x", { state: "detached", timeout: 5000 });
}

async function checkBackgroundClears(page, label) {
  await page.goto(page.url().split("#")[0] + "#/@user_a/following", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".connect-row .name", { timeout: 15000 });
  const during = await page.evaluate(() => {
    document.hasFocus = () => false;
    window.ViktorychPrivacy.setMode("app");
    window.ViktorychPrivacy.mark("blur", true);
    const el = document.querySelector(".connect-row .name");
    const style = getComputedStyle(el);
    const cover = document.getElementById("privacy-cover");
    return {
      open: !!(cover && !cover.hasAttribute("hidden")),
      visibility: style.visibility,
      display: style.display,
      filter: style.filter,
      inline: el.getAttribute("style") || "",
      attr: document.documentElement.getAttribute("data-privacy-cover") || ""
    };
  });
  if (!during.open) fail(label + " background cover");
  if (during.visibility !== "visible" || during.display === "none") fail(label + " background restyle");
  if (during.filter && during.filter !== "none") fail(label + " background blur");
  if (during.inline || during.attr) fail(label + " background mark");
  await page.evaluate(() => {
    document.hasFocus = () => true;
    window.ViktorychPrivacy.clear();
  });
  await page.evaluate(() => { location.hash = "#/notifications"; });
  await page.waitForSelector(".note-line", { timeout: 15000 });
  assertShown(await readBox(page, ".note-line"), label + " after route", "User B");
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    for (const size of SIZES) {
      const off = await openApp(browser, port, size, "");
      try {
        const mode = await off.page.evaluate(() => window.ViktorychPrivacy && window.ViktorychPrivacy.mode());
        if (mode !== "off") fail(size.name + " default mode " + mode);
        await checkLists(off.page, size.name + " off");
      } finally {
        await off.context.close();
      }

      const on = await openApp(browser, port, size, "app");
      try {
        const mode = await on.page.evaluate(() => window.ViktorychPrivacy.mode());
        if (mode !== "app") fail(size.name + " opted-in mode " + mode);
        await checkLists(on.page, size.name + " on");
        if (size.name === "desktop") await checkBackgroundClears(on.page, size.name + " on");
      } finally {
        await on.context.close();
      }
    }

    const kept = await openApp(browser, port, SIZES[1], "dms");
    try {
      const mode = await kept.page.evaluate(() => window.ViktorychPrivacy.mode());
      if (mode !== "dms") fail("explicit choice was dropped");
      await kept.page.waitForSelector(".connect-row .name", { timeout: 15000 });
      assertShown(await readBox(kept.page, ".connect-row .name"), "explicit messages mode", "User");
    } finally {
      await kept.context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (process.exitCode) fail("privacy list checks failed");
  console.log("privacy lists ok");
  // External Following / Followers pages ride along here (same browser setup).
  const [ext] = await runScripts(path.join(root, "scripts"), ["external_following_test.mjs"]);
  if (ext !== 0) fail("external following checks failed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
