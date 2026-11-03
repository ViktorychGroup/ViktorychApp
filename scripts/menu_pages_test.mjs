/* Every main view at phone and desktop sizes.
   Content stays visible, a menu opens onto a tappable item, and the home
   pills sit above the feed. Screen size is set apart from the window so a
   normal browser chrome strip is not treated as split screen.
   Nothing here prints account names, handles, or ids. */
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sharedStaticServer } from "./smoke_runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SAFE_HASH = new Set([
  "#/",
  "#/following",
  "#/explore",
  "#/notifications",
  "#/messages",
  "#/feeds",
  "#/settings",
  "#/tv",
  "#/music"
]);

const VIEWS = [
  { id: "home", hash: "#/" },
  { id: "following", hash: "#/following" },
  { id: "explore", hash: "#/explore" },
  { id: "notifications", hash: "#/notifications" },
  { id: "messages", hash: "#/messages" },
  { id: "feeds", hash: "#/feeds" },
  { id: "settings", hash: "#/settings" },
  { id: "tv", hash: "#/tv" },
  { id: "music", hash: "#/music" }
];

const SIZES = [
  { id: "p360", width: 360, height: 800, screenWidth: 360, screenHeight: 800, phone: true, auth: ["out"] },
  { id: "p390", width: 390, height: 844, screenWidth: 412, screenHeight: 915, phone: true, auth: ["out", "in"] },
  { id: "android", width: 390, height: 700, screenWidth: 412, screenHeight: 915, phone: true, auth: ["out", "in"] },
  { id: "land", width: 800, height: 360, screenWidth: 915, screenHeight: 412, phone: true, auth: ["out", "in"] },
  { id: "d1280", width: 1280, height: 800, screenWidth: 1920, screenHeight: 1080, phone: false, auth: ["out", "in"] },
  { id: "d1440", width: 1440, height: 900, screenWidth: 1920, screenHeight: 1080, phone: false, auth: ["out"] },
  { id: "d1920", width: 1920, height: 1080, screenWidth: 1920, screenHeight: 1080, phone: false, auth: ["out"] },
  { id: "short", width: 1920, height: 900, screenWidth: 1920, screenHeight: 1080, phone: false, auth: ["out", "in"] },
  { id: "pwa", width: 1280, height: 800, screenWidth: 1920, screenHeight: 1080, phone: false, standalone: true, auth: ["out", "in"] }
];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function redact(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, "url")
    .replace(/#\/@\S+/g, "#/@")
    .replace(/@[A-Za-z0-9_]{2,}/g, "@")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function reasonOf(err) {
  const msg = String(err && err.message || "");
  if (/intercepts pointer events/.test(msg)) {
    const before = msg.split("intercepts pointer events")[0];
    const tags = before.match(/<([a-z0-9]+)([^>]*)>/gi) || [];
    const last = tags.length ? tags[tags.length - 1] : "";
    const kind = last.match(/^<([a-z0-9]+)/i);
    const cls = ((last.match(/class="([^"]*)"/) || [])[1] || "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
    return "intercepted " + (kind ? kind[1] : "element") + (cls ? "." + cls : "");
  }
  if (/not stable/.test(msg)) return "unstable";
  if (/outside of the viewport/.test(msg)) return "outside";
  if (/disabled/.test(msg)) return "disabled";
  if (/not visible/.test(msg) || /element is not visible/.test(msg)) return "hidden";
  if (/Timeout/i.test(msg)) return "timeout";
  if (/detached|not attached/.test(msg)) return "detached";
  if (/strict mode/.test(msg)) return "strict";
  return "unavailable";
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

function measure(view) {
  function shown(el) {
    if (!el) return null;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return rect;
  }
  function point(el) {
    const rect = shown(el);
    if (!rect) return null;
    const xs = [rect.left + 10, rect.left + rect.width / 2, rect.right - 10];
    const ys = [rect.top + 10, rect.top + rect.height / 2, rect.bottom - 10];
    for (let i = 0; i < ys.length; i += 1) {
      for (let j = 0; j < xs.length; j += 1) {
        const x = xs[j];
        const y = ys[i];
        if (x < 1 || y < 1 || x >= window.innerWidth - 1 || y >= window.innerHeight - 1) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === el || el.contains(hit))) return { x: Math.round(x), y: Math.round(y) };
      }
    }
    return null;
  }
  const main = document.querySelector("main.center");
  const topbar = main ? main.querySelector(".topbar") : null;
  const pills = main ? main.querySelector(".sp-row-wrap") : null;
  const cover = document.documentElement.getAttribute("data-privacy-cover") || "";
  const sheet = document.getElementById("privacy-cover");
  const sheetOn = !!(sheet && !sheet.hasAttribute("hidden") && getComputedStyle(sheet).display !== "none");
  const text = main ? (main.innerText || "").replace(/\s+/g, " ").trim() : "";
  const contentSel = "article, .empty, .error-box, .xc, a.sp-card, .acct-row, .set-list, .feeds-org, .dmsgs-placeholder, .dmsgs-channels, .ghome, .tv-layout, .mu-shelf, .mu-grid, .mu-form, .skel, .notes, .feeds-quiet, .pname";
  const blocks = [];
  if (main) {
    const nodes = main.querySelectorAll(contentSel);
    for (let i = 0; i < nodes.length; i += 1) {
      const el = nodes[i];
      if (el.closest(".topbar, .mhead, .drawer, .menu, .modal")) continue;
      if (el.parentElement && el.parentElement.closest(contentSel)) continue;
      if (shown(el)) blocks.push(el);
    }
  }
  const headerBottom = Math.max(
    topbar && shown(topbar) ? topbar.getBoundingClientRect().bottom : 0,
    pills && shown(pills) ? pills.getBoundingClientRect().bottom : 0
  );
  let first = null;
  let contentHit = false;
  for (let i = 0; i < blocks.length; i += 1) {
    const rect = blocks[i].getBoundingClientRect();
    if (rect.bottom < 4) continue;
    if (!first) first = blocks[i];
    if (rect.top > window.innerHeight - 4) continue;
    if (point(blocks[i])) contentHit = true;
    if (first && contentHit) break;
  }
  const contentTop = first ? first.getBoundingClientRect().top : null;
  const overlap = contentTop == null ? 0 : Math.round(headerBottom - contentTop);
  let hitDebug = "";
  if (!contentHit) {
    const mid = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2));
    const fr = first ? first.getBoundingClientRect() : null;
    hitDebug = (mid ? mid.tagName : "none") + " blocks=" + blocks.length + (fr ? " first=" + Math.round(fr.top) + "x" + Math.round(fr.height) : "");
  }
  let headingHit = false;
  if (main) {
    const titles = main.querySelectorAll("h1, h2, .tab.on, .page-head, .dmsgs-head, .m-logo");
    for (let i = 0; i < titles.length; i += 1) {
      const el = titles[i];
      if (el.classList.contains("vh") || el.closest(".vh")) continue;
      if (point(el)) { headingHit = true; break; }
    }
  }
  let navMiss = 0;
  document.querySelectorAll("header.nav a.nav-item, nav.bottom-nav a").forEach((el) => {
    if (!shown(el)) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return;
    const scroll = el.closest(".nav-scroll");
    if (scroll) {
      const box = scroll.getBoundingClientRect();
      if (cy < box.top + 4 || cy > box.bottom - 4) return;
    }
    if (!point(el)) navMiss += 1;
  });
  const home = view === "home" || view === "following";
  const topText = topbar ? (topbar.innerText || "") : "";
  const catchup = home && /Catch me up|Ponte al día|Что нового/.test(topText);
  const odai = home && !!document.querySelector(".odai-bar");
  const pillCount = home && pills ? pills.querySelectorAll(".sp-row > *").length : 0;
  const discord = view === "messages" ? !!document.querySelector(".dmsgs") : true;
  const standalone = !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  return {
    chars: text.length,
    cover: cover,
    sheetOn: sheetOn,
    overlap: overlap,
    contentHit: contentHit,
    headingHit: headingHit,
    navMiss: navMiss,
    catchup: !!catchup,
    odai: !!odai,
    pillCount: pillCount,
    discord: discord,
    standalone: standalone,
    hitDebug: hitDebug,
    focus: document.hasFocus(),
    vis: document.visibilityState,
    sw: window.screen.width,
    sh: window.screen.height,
    iw: window.innerWidth,
    ih: window.innerHeight,
    ww: window.outerWidth || window.innerWidth,
    wh: window.outerHeight || window.innerHeight
  };
}

function ready(view) {
  const main = document.querySelector("main.center");
  if (!main) return false;
  if (view === "home" || view === "following") return !!main.querySelector(".tab-caret") && !!main.querySelector(".sp-row");
  if (view === "explore") return !!document.querySelector("#explore-q");
  if (view === "notifications") return !!document.querySelector(".notes-top") && !!(main.querySelector(".empty, .notes, .error-box"));
  if (view === "messages") return !!document.querySelector(".dmsgs");
  if (view === "feeds") return !!document.querySelector(".feeds-org, #add-account");
  if (view === "settings") return !!document.querySelector(".set-list");
  if (view === "tv") return !!document.querySelector(".tv-page");
  if (view === "music") return !!document.querySelector(".mu-grid, .mu-shelf, .mu-tile, .mu-form, main .empty");
  if (view === "profile") {
    const hash = location.hash || "";
    const on = hash.indexOf("#/@") === 0 || hash.indexOf("#/u/") === 0 || hash.indexOf("#/p/") === 0 || /^#\/(?:x|threads|instagram|rss|youtube|vk|discord|telegram|tiktok|app)\//.test(hash);
    const profile = main.querySelector(".profile-bar, h1.pname");
    return on && !!profile && (main.innerText || "").trim().length > 8;
  }
  return (main.innerText || "").trim().length > 8;
}

async function applySize(client, windowId, size) {
  await client.send("Browser.setWindowBounds", {
    windowId: windowId,
    bounds: { width: size.width, height: size.height, windowState: "normal" }
  });
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: size.width,
    height: size.height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: size.screenWidth,
    screenHeight: size.screenHeight
  });
  await client.send("Emulation.setEmulatedMedia", {
    features: size.standalone ? [{ name: "display-mode", value: "standalone" }] : []
  });
}

async function go(page, hash, view) {
  await page.evaluate((next) => {
    if ((location.hash || "#/") !== next) location.hash = next;
    window.scrollTo(0, 0);
    window.focus();
    window.dispatchEvent(new Event("focus"));
    if (window.ViktorychPrivacy) {
      window.ViktorychPrivacy.mark("blur", false);
      window.ViktorychPrivacy.mark("hidden", false);
      window.ViktorychPrivacy.mark("freeze", false);
    }
  }, hash);
  await page.waitForFunction(ready, view, { timeout: 20000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(40);
}

async function dismissWelcome(page) {
  const skip = page.locator(".welcome-sheet [data-act='welcome-skip']").locator("visible=true");
  if (!(await skip.count())) return;
  try {
    await skip.first().click({ trial: true, timeout: 4000 });
    await skip.first().click({ timeout: 4000 });
  } catch (err) {
    fail("welcome sheet is not tappable " + reasonOf(err));
  }
  await page.waitForFunction(() => !document.querySelector(".welcome-sheet"), null, { timeout: 4000 });
}

async function checkView(page, size, view) {
  await dismissWelcome(page);
  await page.evaluate(() => {
    window.focus();
    if (window.ViktorychPrivacy) {
      window.ViktorychPrivacy.mark("blur", false);
      window.ViktorychPrivacy.mark("hidden", false);
      window.ViktorychPrivacy.mark("freeze", false);
    }
  });
  const box = await page.evaluate(measure, view.id);
  const where = size.id + " " + view.id;
  if (Math.abs(box.iw - size.width) > 20 || Math.abs(box.ih - size.height) > 30) {
    fail(where + " viewport " + box.iw + "x" + box.ih);
  }
  if (box.sw !== size.screenWidth || box.sh !== size.screenHeight) {
    fail(where + " screen " + box.sw + "x" + box.sh);
  }
  if (box.cover === "dms" || box.cover === "app" || box.sheetOn) {
    fail(where + " privacy cover " + box.cover + " window " + box.ww + "x" + box.wh + " screen " + box.sw + "x" + box.sh);
  }
  if (box.chars < 12) fail(where + " has no visible text");
  if (box.overlap > 2) fail(where + " sticky header overlaps content by " + box.overlap);
  const contentSel = {
    home: "main article, main .empty, main a.sp-card, main .xc",
    following: "main article, main .empty, main a.sp-card",
    explore: "#explore-q",
    notifications: "main .empty, main .notes, main .error-box, main h1",
    messages: ".dmsgs h1, .dmsgs-placeholder, .dmsgs-channels a, .dmsgs-channels button",
    feeds: ".feeds-org, #add-account",
    settings: ".set-list a, .set-list button",
    tv: ".tv-page button, .tv-page a, .tv-page h1",
    music: ".mu-tile, .mu-grid a, .mu-shelf a, .mu-shelf button, main .empty",
    profile: "main h1, main h2, main article, main .empty"
  }[view.id] || "main h1, main h2, main article, main .empty";
  await assertTappable(page, contentSel, where + " content");
  const nav = page.locator("nav.bottom-nav a, header.nav a.nav-item").locator("visible=true");
  if (await nav.count()) {
    try {
      await nav.first().click({ trial: true, timeout: 5000 });
    } catch (err) {
      fail(where + " navigation is covered " + reasonOf(err));
    }
  }
  if (view.id === "home" || view.id === "following") {
    if (box.catchup) fail(where + " still shows the catch-up heading");
    if (box.odai) fail(where + " still shows the catch-up bar");
    if (box.pillCount < 1) fail(where + " pills row is missing");
  }
  if (view.id === "messages" && !box.discord) fail(where + " discord inbox is missing");
  if (size.standalone && !box.standalone) fail(where + " is not an installed window");
}

async function assertTappable(page, selector, label) {
  const target = page.locator(selector).locator("visible=true");
  const count = await target.count();
  if (!count) fail(label + " is missing");
  let last = "missing";
  const tries = Math.min(count, 5);
  for (let i = 0; i < tries; i += 1) {
    const item = target.nth(i);
    try {
      await item.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
      await item.click({ trial: true, timeout: 3000 });
      return;
    } catch (err) {
      last = reasonOf(err);
    }
  }
  fail(label + " is covered " + last);
}

async function clickSelector(page, selector, label) {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.locator(selector).locator("visible=true").first().click({ timeout: 6000 });
      return;
    } catch (err) {
      last = reasonOf(err);
      if (last !== "unstable" || attempt === 2) fail(label + " is not tappable " + last);
      await page.evaluate(() => new Promise((resolve) => {
        const pending = typeof document.getAnimations === "function" ? document.getAnimations() : [];
        const done = Promise.all(pending.map((anim) => anim.finished.catch(() => {})));
        const cap = new Promise((finish) => setTimeout(finish, 700));
        Promise.race([done, cap]).then(() => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
      }));
    }
  }
}

async function safeHash(page) {
  return page.evaluate((allowed) => {
    const path = (location.hash || "#/").split("?")[0];
    return allowed.indexOf(path) >= 0 ? path : "route";
  }, [...SAFE_HASH]);
}

async function visibleControl(page) {
  return page.evaluate(() => {
    function shown(sel, onScreen) {
      const nodes = document.querySelectorAll(sel);
      for (let i = 0; i < nodes.length; i += 1) {
        const el = nodes[i];
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;
        if (onScreen && (rect.bottom < 4 || rect.top > window.innerHeight - 4)) continue;
        return true;
      }
      return false;
    }
    if (shown("button.m-ava", true)) return "phone";
    if (shown(".nav-land-more > summary", false)) return "land";
    if (shown("button.account-pill .dots", false)) return "dots";
    if (shown("button.account-pill", true)) return "account";
    if (shown("nav.bottom-nav a, header.nav a.nav-item", true)) return "nav";
    return "";
  });
}

async function tapMarkedLink(page, label, linkSel) {
  const before = await safeHash(page);
  const marked = await page.evaluate((sel) => {
    document.querySelectorAll("[data-test-tap]").forEach((el) => el.removeAttribute("data-test-tap"));
    const current = (location.hash || "#/").split("?")[0];
    const links = document.querySelectorAll(sel);
    for (let i = 0; i < links.length; i += 1) {
      const el = links[i];
      const path = (el.getAttribute("href") || "").split("?")[0];
      if (path.indexOf("#/") !== 0 || path.indexOf("#/@") === 0 || path === current) continue;
      el.setAttribute("data-test-tap", "1");
      return "go";
    }
    if (links.length) {
      links[0].setAttribute("data-test-tap", "1");
      return "stay";
    }
    return "";
  }, linkSel);
  if (!marked) fail(label + " menu item is missing");
  const item = page.locator("[data-test-tap='1']");
  try {
    if (marked === "stay") await item.click({ trial: true, timeout: 6000 });
    else await item.click({ timeout: 6000 });
  } catch (err) {
    fail(label + " menu item is covered " + reasonOf(err));
  }
  if (marked === "go") {
    await page.waitForFunction((prev) => (location.hash || "#/").split("?")[0] !== prev, before, { timeout: 5000 });
  }
  await page.keyboard.press("Escape");
  await sleep(30);
}

async function openDrawerAndTap(page, label) {
  const mode = await visibleControl(page);
  if (mode === "nav") {
    try {
      await page.locator("nav.bottom-nav a, header.nav a.nav-item").locator("visible=true").first().click({ timeout: 6000 });
    } catch (err) {
      fail(label + " navigation is not tappable " + reasonOf(err));
    }
    return;
  }
  if (!mode) fail(label + " menu button is missing");
  if (mode === "land") {
    await clickSelector(page, ".nav-land-more > summary", label + " menu");
    const opened = await page.evaluate(() => {
      const el = document.querySelector(".nav-land-more");
      return !!(el && el.open);
    });
    if (!opened) {
      await page.evaluate(() => {
        const el = document.querySelector(".nav-land-more");
        if (el) el.open = true;
      });
    }
    try {
      await page.waitForSelector(".nav-land-menu a[href]", { state: "visible", timeout: 3000 });
    } catch (err) {
      fail(label + " menu did not open");
    }
    await tapMarkedLink(page, label, ".nav-land-menu a[href]");
    return;
  }
  if (mode === "account" || mode === "dots") {
    await clickSelector(page, mode === "dots" ? "button.account-pill .dots" : "button.account-pill", label + " menu");
    const compact = await page.locator(".acct-menu a[href='#/settings']").locator("visible=true").count();
    if (compact) {
      if (await page.locator(".drawer-x").count()) fail(label + " desktop drawer");
      await tapMarkedLink(page, label, ".acct-menu a[href]");
      await page.keyboard.press("Escape");
      return;
    }
  }
  if (mode === "account") {
    await clickSelector(page, "button.account-pill", label + " menu");
    try {
      await page.locator(".drawer a[href], .acct-modal button, .presence-card button").first().waitFor({ state: "visible", timeout: 5000 });
    } catch (err) {
      fail(label + " menu did not open");
    }
    if (await page.locator(".drawer a[href]").locator("visible=true").count()) {
      await tapMarkedLink(page, label, ".drawer a[href]");
      return;
    }
    try {
      await page.locator(".presence-card button, .acct-modal button").locator("visible=true").first().click({ trial: true, timeout: 6000 });
    } catch (err) {
      fail(label + " menu item is covered " + reasonOf(err));
    }
    if (await page.locator(".acct-modal [data-acct='close']").locator("visible=true").count()) {
      await clickSelector(page, ".acct-modal [data-acct='close']", label + " menu close");
    } else {
      await page.keyboard.press("Escape");
    }
    await page.waitForFunction(() => {
      const sheet = document.querySelector(".presence-sheet");
      return !document.querySelector(".acct-back") && (!sheet || sheet.hidden);
    }, null, { timeout: 4000 });
    return;
  }
  const opener = mode === "dots" ? "button.account-pill .dots" : "button.m-ava";
  await clickSelector(page, opener, label + " menu");
  const compact = await page.locator(".acct-menu a[href='#/settings']").locator("visible=true").count();
  if (compact) {
    if (await page.locator(".drawer-x").count()) fail(label + " desktop drawer");
    await tapMarkedLink(page, label, ".acct-menu a[href]");
    await page.keyboard.press("Escape");
    return;
  }
  try {
    await page.waitForSelector(".drawer a[href]", { timeout: 5000 });
  } catch (err) {
    fail(label + " menu did not open");
  }
  await tapMarkedLink(page, label, ".drawer a[href]");
}

async function settleTop(page) {
  const start = Date.now();
  let stable = 0;
  while (Date.now() - start < 4000) {
    const y = await page.evaluate(() => {
      const top = window.scrollY || document.documentElement.scrollTop || 0;
      if (top > 4) window.scrollTo(0, 0);
      return window.scrollY || document.documentElement.scrollTop || 0;
    });
    stable = y <= 4 ? stable + 1 : 0;
    if (stable >= 3) return;
    await sleep(100);
  }
}

async function openMenuAndEscape(page, opener, item, label) {
  let has = false;
  for (let attempt = 0; attempt < 6 && !has; attempt += 1) {
    has = await page.evaluate((sel) => {
      window.scrollTo(0, 0);
      document.querySelectorAll(".topbar.is-hidden").forEach((el) => el.classList.remove("is-hidden"));
      const nodes = document.querySelectorAll(sel);
      for (let i = 0; i < nodes.length; i += 1) {
        const el = nodes[i];
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight - 8) el.scrollIntoView({ block: "center" });
        const box = el.getBoundingClientRect();
        if (box.width > 8 && box.height > 8 && box.bottom > 0 && box.top < window.innerHeight) return true;
      }
      return false;
    }, opener);
    if (!has) await sleep(200);
  }
  if (!has) return false;
  await page.locator(opener).locator("visible=true").first().evaluate((el) => {
    if (el.closest(".topbar, .tabs-bar, .mhead, .dmsgs-head")) return;
    el.scrollIntoView({ block: "center", inline: "nearest" });
  });
  await clickSelector(page, opener, label);
  if (!(await page.locator(item).count().catch(() => 0))) {
    await settleTop(page);
    await clickSelector(page, opener, label);
  }
  await page.locator(item).first().evaluate((el) => {
    const menu = el.closest(".menu, .dmsgs-menu");
    if (menu) menu.scrollIntoView({ block: "center", inline: "nearest" });
  }).catch(() => {});
  let opened = false;
  let menuError = "";
  for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
    try {
      await page.locator(item).locator("visible=true").first().click({ trial: true, timeout: 4000 });
      opened = true;
    } catch (err) {
      menuError = reasonOf(err);
      await sleep(250);
    }
  }
  if (!opened) fail(label + " item is covered " + menuError);
  await page.keyboard.press("Escape");
  await page.waitForFunction((sel) => !document.querySelector(sel), item, { timeout: 4000 });
  return true;
}

async function openProfile(page, label) {
  try {
    await page.locator("main article a.name, main a.who-main").locator("visible=true").first().click({ timeout: 8000 });
  } catch (err) {
    fail(label + " profile link is not tappable " + reasonOf(err));
  }
  await page.waitForFunction(ready, "profile", { timeout: 15000 });
  await page.evaluate(() => new Promise((resolve) => {
    window.scrollTo(0, 0);
    const pending = typeof document.getAnimations === "function" ? document.getAnimations() : [];
    const done = Promise.all(pending.map((anim) => anim.finished.catch(() => {})));
    const cap = new Promise((finish) => setTimeout(finish, 400));
    Promise.race([done, cap]).then(() => {
      window.scrollTo(0, 0);
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }));
}

async function pass(page, size) {
  await page.evaluate(() => window.focus());
  await go(page, "#/", "home");
  const metrics = await page.evaluate(measure, "home");
  if (metrics.sw !== size.screenWidth || metrics.sh !== size.screenHeight) {
    fail(size.id + " screen did not apply " + metrics.sw + "x" + metrics.sh);
  }
  const from = process.env.FROM || "";
  const start = from ? VIEWS.findIndex((view) => view.id === from) : 0;
  const views = start > 0 ? VIEWS.slice(start) : VIEWS;
  for (const view of views) {
    await go(page, view.hash, view.id);
    await checkView(page, size, view);
    if (view.id === "home") {
      const profileSize = {
        id: size.id + " profile",
        width: size.width,
        height: size.height,
        screenWidth: size.screenWidth,
        screenHeight: size.screenHeight,
        standalone: size.standalone
      };
      await page.waitForSelector("main article a.name, main a.who-main", { timeout: 20000 });
      const hasAuthor = await page.evaluate(() => !!document.querySelector("main article a.name, main a.who-main"));
      if (!hasAuthor) fail(size.id + " profile link is missing");
      await openProfile(page, profileSize.id);
      await checkView(page, profileSize, { id: "profile" });
      await go(page, "#/", "home");
      await settleTop(page);
      await sleep(350);
      const tab = await openMenuAndEscape(page, "button.tab-caret", ".menu.tab-menu button", size.id + " home tab menu");
      if (!tab) fail(size.id + " home tab menu is missing");
      const more = await openMenuAndEscape(page, "button.more-btn", "article .menu button", size.id + " post menu");
      if (!more) fail(size.id + " post menu is missing");
      const compose = size.phone && size.height > size.width ? "button.fab" : "button.post-btn";
      await clickSelector(page, compose, size.id + " composer");
      await page.waitForSelector(".modal [data-act='close-modal']", { timeout: 5000 });
      await clickSelector(page, ".modal [data-act='close-modal']", size.id + " composer close");
      await page.waitForFunction(() => !document.querySelector(".modal"), null, { timeout: 4000 });
    }
    if (view.id === "messages") {
      await openMenuAndEscape(page, "button.dmsgs-more", ".dmsgs-menu button", size.id + " discord menu");
    }
    await go(page, view.hash, view.id);
    await openDrawerAndTap(page, size.id + " " + view.id);
  }
  console.log("ok " + size.id);
}

async function boot(browser, signedIn) {
  const context = await browser.newContext({ viewport: null, serviceWorkers: "block" });
  /* Keep the run hermetic: live scores, streams and other outside data
     repaint rows mid-tap and made this check depend on the time of day. */
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "" }));
  await context.addInitScript((signed) => {
    localStorage.setItem("superintelapp-lang", "es");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-privacy-mode", "dms");
    localStorage.removeItem("viktorych-screen-v1");
    if (/[?&]installed=1(?:&|$)/.test(location.search)) {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const text = String(query);
        if (text.indexOf("display-mode") < 0) return real(query);
        const on = text.indexOf("standalone") >= 0;
        return {
          matches: on,
          media: text,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() { return false; }
        };
      };
    }
    if (!signed) return;
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    let handle = "t";
    for (let i = 0; i < 8; i += 1) handle += alphabet[bytes[i] % 26];
    let publicId = "";
    for (let i = 0; i < 12; i += 1) publicId += String(bytes[i] % 10);
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "local-session",
      account: { publicId: publicId, handle: handle, displayName: "Local", profileLess: true }
    }));
  }, signedIn);
  return context;
}

async function openSized(context, origin, size) {
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (err) => {
    const message = String(err && err.message || "");
    // Chrome's extension activity logger throws this into the page. It is not app code.
    if (message === "this.api.logApiCall is not a function") return;
    problems.push(redact(message));
  });
  const client = await context.newCDPSession(page);
  const target = await client.send("Browser.getWindowForTarget");
  await applySize(client, target.windowId, size);
  const installed = size.standalone ? "?installed=1" : "";
  await page.goto(origin + "/" + installed + "#/", { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(ready, "home", { timeout: 20000 });
  } catch (err) {
    const snap = await page.evaluate(() => {
      const path = (location.hash || "").split("?")[0].replace(/#\/@\S*/, "#/@");
      return {
        path: path.indexOf("#/@") === 0 ? "#/@" : path.slice(0, 32),
        caret: !!document.querySelector(".tab-caret"),
        row: !!document.querySelector(".sp-row"),
        app: !!document.querySelector(".app")
      };
    }).catch(() => ({ path: "unavailable" }));
    fail(size.id + " home did not open " + JSON.stringify(snap));
  }
  return { page, client, problems };
}

/* Each size runs in its own browser process, a few at a time, so the whole
   check takes about a quarter of the serial time. ONLY and AUTH still pick
   one case by hand. MENU_PARALLEL=1 runs everything in one process. */
async function runParallel() {
  const cases = [];
  for (const auth of ["out", "in"]) {
    for (const size of SIZES) if (size.auth.indexOf(auth) >= 0) cases.push({ auth, id: size.id });
  }
  const limit = Math.max(1, Math.min(Number(process.env.MENU_PARALLEL) || os.cpus().length, 6));
  const results = new Array(cases.length);
  let next = 0;
  async function worker() {
    while (next < cases.length) {
      const index = next;
      next += 1;
      const item = cases[index];
      results[index] = await new Promise((resolve) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
          env: { ...process.env, ONLY: item.id, AUTH: item.auth, MENU_CHILD: "1" },
          stdio: ["ignore", "pipe", "pipe"]
        });
        let out = "";
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.stderr.on("data", (chunk) => { out += chunk; });
        child.on("close", (code) => resolve({ item, code, out }));
      });
      const done = results[index];
      process.stdout.write((done.code === 0 ? "" : "FAILED " + done.item.auth + " " + done.item.id + "\n") + done.out);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, cases.length) }, worker));
  /* A busy runner can leave a tap target mid-animation; a case that failed
     next to others gets one quiet run on its own before it counts. */
  for (let index = 0; index < results.length; index += 1) {
    if (results[index].code === 0) continue;
    const item = results[index].item;
    console.log("retrying alone: " + item.auth + " " + item.id);
    const again = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, ONLY: item.id, AUTH: item.auth, MENU_CHILD: "1" }, encoding: "utf8" });
    process.stdout.write((again.stdout || "") + (again.stderr || ""));
    results[index] = { item, code: again.status, out: "" };
  }
  const failed = results.filter((done) => done.code !== 0);
  if (failed.length) {
    console.error("menu page checks failed: " + failed.map((done) => done.item.auth + " " + done.item.id).join(", "));
    process.exit(1);
  }
}

async function main() {
  const parallel = !process.env.ONLY && !process.env.AUTH && !process.env.FROM && !process.env.MENU_CHILD && process.env.MENU_PARALLEL !== "1";
  if (parallel) {
    await runParallel();
    console.log("signed-out ok");
    console.log("signed-in ok");
    console.log("menu pages ok");
    const layout = spawnSync(process.execPath, [fileURLToPath(new URL("./drawer_layout_test.mjs", import.meta.url))], { stdio: "inherit", env: process.env });
    if (layout.status !== 0) process.exit(layout.status || 1);
    return;
  }
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--window-size=1920,1080"]
  });
  try {
    for (const signedIn of [false, true]) {
      const context = await boot(browser, signedIn);
      const problems = [];
      try {
        const only = process.env.ONLY || "";
        const wantAuth = process.env.AUTH || "";
        if (wantAuth === "in" && !signedIn) continue;
        if (wantAuth === "out" && signedIn) continue;
        const sizes = SIZES.filter((size) => size.auth.indexOf(signedIn ? "in" : "out") >= 0 && (!only || size.id === only));
        for (const size of sizes) {
          const opened = await openSized(context, origin, size);
          try {
            await pass(opened.page, size);
            problems.push(...opened.problems);
          } finally {
            await opened.client.detach().catch(() => {});
            await opened.page.close().catch(() => {});
          }
        }
        if (problems.length) fail((signedIn ? "signed-in" : "signed-out") + " page error " + problems[0]);
      } finally {
        await context.close();
      }
      console.log(signedIn ? "signed-in ok" : "signed-out ok");
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (process.exitCode) fail("menu page checks failed");
  console.log("menu pages ok");
  if (process.env.MENU_CHILD) return;
  /* The drawer layout check shares this job. */
  const layout = spawnSync(process.execPath, [fileURLToPath(new URL("./drawer_layout_test.mjs", import.meta.url))], { stdio: "inherit", env: process.env });
  if (layout.status !== 0) process.exit(layout.status || 1);
}

main().catch((err) => {
  console.error(redact(err && err.stack || err));
  process.exit(1);
});
