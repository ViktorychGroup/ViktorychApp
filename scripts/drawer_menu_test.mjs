/* Drawer customize mode at phone and tablet widths. Placeholders only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
  { name: "tablet", width: 820, height: 1180 }
];

async function openDrawer(page) {
  const wide = await page.evaluate(() => window.innerWidth >= 500);
  if (wide) return "wide";
  await page.waitForFunction(() => [...document.querySelectorAll(".m-ava")].some((el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }));
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".m-ava")].find((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    if (el) el.click();
  });
  await page.waitForSelector(".drawer-x", { timeout: 8000 });
  return "phone";
}

async function openEditor(page, scope) {
  /* The menu's Customize row opens the Customize page; its Edit menu row opens the editor. */
  await page.locator(scope + " [data-act='customize-page']").first().click();
  await page.waitForSelector(".pz-page [data-act='drawer-edit']");
  await page.locator(".pz-page [data-act='drawer-edit']").click();
}

async function checkSidebar(page, label) {
  const before = await page.evaluate(() => ({
    drawer: !!document.querySelector(".drawer-x"),
    customize: !!document.querySelector("header.nav:not(.nav-land) [data-act='customize-page']"),
    bookmarks: !!document.querySelector("header.nav a[href='#/bookmarks']"),
    profile: [...document.querySelectorAll("header.nav .nav-label")].some((node) => (node.textContent || "") === "Profile"),
    tv: !!document.querySelector("header.nav a[href='#/tv']")
  }));
  if (before.drawer || !before.customize || !before.bookmarks || !before.profile || !before.tv) fail(label + " sidebar is missing a core row");
  await openEditor(page, "header.nav:not(.nav-land)");
  await page.waitForSelector(".nav-customize-modal .drawer-edit-list");
  const listed = await page.evaluate(() => ({
    profile: !!document.querySelector("[data-drawer-key='profile']"),
    premium: !!document.querySelector("[data-drawer-key='premium']"),
    explore: !!document.querySelector("[data-drawer-key='explore']"),
    homeEye: !!document.querySelector("[data-drawer-key='home'] [data-act='drawer-vis']")
  }));
  if (!listed.profile || !listed.premium || !listed.explore || listed.homeEye) fail(label + " editor is missing a sidebar item");
  const places = await page.evaluate(() => ({
    home: !!document.querySelector(".drawer-edit-list[data-place='sidebar'] [data-drawer-key='home']"),
    settings: !!document.querySelector(".drawer-edit-list[data-place='popup'] [data-drawer-key='settings']"),
    logout: !!document.querySelector(".drawer-edit-list[data-place='popup'] [data-drawer-key='logout']"),
    settingsMove: !!document.querySelector("[data-drawer-key='settings'] [data-act='drawer-place']"),
    homeMove: !!document.querySelector("[data-drawer-key='home'] [data-act='drawer-place']")
  }));
  if (!places.home || !places.settings || !places.logout || places.settingsMove || places.homeMove) fail(label + " locked items are in the wrong place");
  if (await page.locator(".drawer-x").count()) fail(label + " edit opened the edge drawer");
  const locked = await page.evaluate(() => {
    const row = (id) => document.querySelector(`[data-drawer-key="${id}"]`);
    return {
      settingsEye: !!(row("settings") && row("settings").querySelector("[data-act='drawer-vis']")),
      logoutEye: !!(row("logout") && row("logout").querySelector("[data-act='drawer-vis']")),
      customizeEye: !!(row("customize") && row("customize").querySelector("[data-act='drawer-vis']")),
      grips: document.querySelectorAll(".drawer-grip").length
    };
  });
  if (locked.settingsEye || locked.logoutEye || locked.customizeEye) fail(label + " a locked item can be hidden");
  if (locked.grips < 3) fail(label + " drag handles missing");
  await page.click("[data-drawer-key='bookmarks'] [data-act='drawer-vis']");
  await page.locator(".drawer-edit-bar [data-act='drawer-edit-done']").click();
  const hidden = await page.evaluate(() => !!document.querySelector("header.nav a[href='#/bookmarks']"));
  if (hidden) fail(label + " hidden item is still shown");
  const back = await page.evaluate(() => ({
    customize: !!document.querySelector("header.nav:not(.nav-land) [data-act='customize-page']"),
    profile: [...document.querySelectorAll("header.nav .nav-label")].some((node) => (node.textContent || "") === "Profile"),
    drawer: !!document.querySelector(".drawer-x")
  }));
  if (!back.customize || !back.profile || back.drawer) fail(label + " core items disappeared");
  await openEditor(page, "header.nav:not(.nav-land)");
  await page.click("[data-act='drawer-add-section']");
  await page.waitForSelector(".drawer-section-name");
  await page.waitForSelector(".drawer-section-emoji");
  await page.click("[data-act='drawer-reset']");
  await page.locator(".drawer-edit-bar [data-act='drawer-edit-done']").click();
  const restored = await page.evaluate(() => !!document.querySelector("header.nav a[href='#/bookmarks']"));
  if (!restored) fail(label + " reset did not restore the menu");
  await openEditor(page, "header.nav:not(.nav-land)");
  await page.click("[data-drawer-key='bookmarks'] [data-act='drawer-place']");
  await page.locator(".drawer-edit-bar [data-act='drawer-edit-done']").click();
  const moved = await page.evaluate(() => !!document.querySelector("header.nav a[href='#/bookmarks']"));
  if (moved) fail(label + " popup item stayed in the sidebar");
  await page.locator("header.nav:not(.nav-land) button.account-pill").click();
  await page.waitForSelector(".acct-menu");
  const popupText = await page.locator(".acct-menu").innerText();
  if (popupText.indexOf("Bookmarks") < 0) fail(label + " popup is missing the moved item");
}

async function check(page, label) {
  const kind = await openDrawer(page);
  if (kind === "wide") {
    await checkSidebar(page, label);
    return;
  }
  const before = await page.evaluate(() => ({
    customize: !!document.querySelector(".drawer-x [data-act='customize-page']"),
    bookmarks: [...document.querySelectorAll(".drawer-label")].some((node) => node.textContent === "Bookmarks"),
    settings: [...document.querySelectorAll(".drawer-label")].some((node) => /Settings/.test(node.textContent || "")),
    fold: !!document.querySelector("[data-act='drawer-fold']"),
    tv: !!document.querySelector('.drawer a[href="#/tv"]'),
    logoutInBody: !!document.querySelector(".drawer-scroll [data-acct='logout']")
  }));
  if (!before.customize || !before.bookmarks || !before.settings || !before.fold || !before.tv || before.logoutInBody) fail(label + " menu is missing a core row");
  await openEditor(page, ".drawer-x");
  await page.waitForSelector(".drawer-edit-list");
  const locked = await page.evaluate(() => {
    const row = (id) => document.querySelector(`[data-drawer-key="${id}"]`);
    return {
      settingsEye: !!(row("settings") && row("settings").querySelector("[data-act='drawer-vis']")),
      logoutEye: !!(row("logout") && row("logout").querySelector("[data-act='drawer-vis']")),
      customizeEye: !!(row("customize") && row("customize").querySelector("[data-act='drawer-vis']")),
      grips: document.querySelectorAll(".drawer-grip").length
    };
  });
  if (locked.settingsEye || locked.logoutEye || locked.customizeEye) fail(label + " a locked item can be hidden");
  if (locked.grips < 3) fail(label + " drag handles missing");
  await page.click("[data-drawer-key='bookmarks'] [data-act='drawer-vis']");
  await page.locator(".drawer-edit-bar [data-act='drawer-edit-done']").click();
  const hidden = await page.evaluate(() => [...document.querySelectorAll(".drawer-label")].some((node) => node.textContent === "Bookmarks"));
  if (hidden) fail(label + " hidden item is still shown");
    const back = await page.evaluate(() => ({
    customize: !!document.querySelector(".drawer-x [data-act='customize-page']"),
    settings: [...document.querySelectorAll(".drawer-label")].some((node) => /Settings/.test(node.textContent || "")),
    fold: !!document.querySelector("[data-act='drawer-fold']")
  }));
  if (!back.customize || !back.settings || !back.fold) fail(label + " core items disappeared");
  await openEditor(page, ".drawer-x");
  await page.click("[data-act='drawer-add-section']");
  await page.waitForSelector(".drawer-section-name");
  await page.waitForSelector(".drawer-section-emoji");
  await page.click("[data-act='drawer-reset']");
  await page.locator(".drawer-edit-bar [data-act='drawer-edit-done']").click();
  const restored = await page.evaluate(() => [...document.querySelectorAll(".drawer-label")].some((node) => node.textContent === "Bookmarks"));
  if (!restored) fail(label + " reset did not restore the menu");
  await page.click("[data-act='close-drawer']");
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    for (const size of SIZES) {
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
      await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector(".m-ava, .account-pill"));
      try {
        await check(page, size.name);
      } finally {
        await context.close();
      }
    }
    console.log("drawer menu ok");
    /* The menu's Customize row opens the Customize page; its own check runs here so CI covers it. */
    const pz = spawnSync(process.execPath, [path.join(root, "scripts", "customize_page_test.mjs")], { stdio: "inherit", env: process.env });
    if (pz.status !== 0) fail("customize page check failed");
    // The installed desktop app checks ride along here so the smoke workflow runs them.
    const desk = spawnSync(process.execPath, [path.join(root, "scripts", "desktop_app_test.mjs")], { stdio: "inherit", env: process.env });
    if (desk.status !== 0) fail("desktop app check failed");
    const lai = spawnSync(process.execPath, [path.join(root, "scripts", "local_ai_page_test.mjs")], { stdio: "inherit", env: process.env });
    if (lai.status !== 0) fail("local ai page check failed");
    const laiSetup = spawnSync(process.execPath, [path.join(root, "scripts", "local_ai_setup_test.mjs")], { stdio: "inherit", env: process.env });
    if (laiSetup.status !== 0) fail("local ai setup check failed");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
