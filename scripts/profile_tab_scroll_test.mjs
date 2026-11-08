/* Profile tabs on a wide screen use the same arrows as Home. They show only
   when the strip overflows, and a phone keeps touch scrolling. Fixture only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ME = "100000000001";

function mime(file) {
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".html")) return "text/html";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json";
  return "text/javascript";
}
function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": mime(file) + "; charset=utf-8", "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function account() {
  return {
    publicId: ME, handle: "user_a", displayName: "User A",
    followersCount: 2, followingCount: 2, friendsCount: 4,
    aboutPreview: "A short bio", gifts: { hidden: false }
  };
}

async function openProfile(browser, port, width, height, hidden) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block", hasTouch: width < 500 });
  await context.addInitScript((payload) => {
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "local-test-token",
      account: { publicId: payload.me, handle: "user_a", displayName: "User A", avatar: "" }
    }));
    const settings = { version: 1, initialized: true, follows: [], lists: [], likes: {}, bookmarks: {}, reposts: {} };
    if (payload.hidden) settings.profileTabs = { order: ["posts", "replies", "media", "games", "highlights", "friends", "about", "gifts"], hidden: payload.hidden, share: false, at: 1 };
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify(settings));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
  }, { me: ME, hidden: hidden || null });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.request().url().startsWith("http://127.0.0.1:" + port) ? route.continue() : route.abort());
  await page.route("**/v1/**", (route) => {
    const url = new URL(route.request().url());
    const send = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/v1/profile/user_a") return send({ account: account(), reposts: [] });
    return send({ ok: true, posts: [], friends: [], incoming: [], outgoing: [] });
  });
  await page.goto("http://127.0.0.1:" + port + "/index.html#/@user_a", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".ptabs .tab", { timeout: 15000 });
  return { context, page };
}

function strip(page) {
  return page.evaluate(() => {
    const bar = document.querySelector(".ptabs-bar");
    const scroller = document.querySelector(".ptabs");
    const right = bar && bar.querySelector(".tab-arrow.right");
    const left = bar && bar.querySelector(".tab-arrow.left");
    const tabs = [...scroller.querySelectorAll(".tab")].map((el) => el.textContent.replace(/\s+/g, " ").trim());
    return {
      tabs,
      max: scroller.scrollWidth - scroller.clientWidth,
      leftHidden: !left || left.hidden,
      rightHidden: !right || right.hidden,
      leftDisplay: left ? getComputedStyle(left).display : "",
      rightDisplay: right ? getComputedStyle(right).display : "",
      overflow: getComputedStyle(scroller).overflowX
    };
  });
}

async function main() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const desk = await openProfile(browser, port, 1000, 700, null);
    let info = await strip(desk.page);
    if (info.max <= 2) {
      await desk.page.setViewportSize({ width: 1000, height: 700 });
      await desk.page.waitForTimeout(200);
      info = await strip(desk.page);
    }
    if (info.max <= 2) throw new Error("profile tabs did not overflow on a desktop column " + JSON.stringify(info));
    if (info.overflow === "hidden") throw new Error("profile tabs cannot scroll");
    if (info.rightHidden) throw new Error("right arrow stayed hidden " + JSON.stringify(info));
    if (!info.leftHidden) throw new Error("left arrow showed at the start");
    await desk.page.locator(".ptabs-bar").hover();
    const before = await desk.page.evaluate(() => document.querySelector(".ptabs").scrollLeft);
    await desk.page.locator(".ptabs-bar .tab-arrow.right").click();
    await desk.page.waitForFunction((n) => document.querySelector(".ptabs").scrollLeft > n + 20, before);
    const mid = await desk.page.evaluate(() => {
      const scroller = document.querySelector(".ptabs");
      const left = document.querySelector(".ptabs-bar .tab-arrow.left");
      return { at: scroller.scrollLeft, leftHidden: left.hidden };
    });
    if (mid.leftHidden) throw new Error("left arrow stayed hidden after scrolling right");
    await desk.page.locator(".ptabs-bar .tab-arrow.left").focus();
    await desk.page.keyboard.press("Enter");
    await desk.page.waitForFunction((n) => document.querySelector(".ptabs").scrollLeft < n - 10, mid.at);
    await desk.page.mouse.move(0, 0);
    await desk.page.locator(".ptabs-bar .tab-arrow.right").focus();
    const focused = await desk.page.evaluate(() => {
      const el = document.activeElement;
      const scroller = document.querySelector(".ptabs");
      return { tag: el && el.className, act: el && el.getAttribute && el.getAttribute("data-act"), at: scroller.scrollLeft, hidden: el && el.hidden, pe: el ? getComputedStyle(el).pointerEvents : "" };
    });
    if (focused.hidden || focused.act !== "tab-scroll") throw new Error("right arrow could not take keyboard focus " + JSON.stringify(focused));
    await desk.page.keyboard.press("Space");
    await desk.page.waitForFunction((n) => document.querySelector(".ptabs").scrollLeft > n + 20, focused.at);
    const afterKey = await desk.page.evaluate(() => document.querySelector(".ptabs").scrollLeft);
    if (afterKey < 10) throw new Error("keyboard did not scroll profile tabs " + JSON.stringify(focused) + " after " + afterKey);
    const last = info.tabs[info.tabs.length - 1];
    await desk.page.evaluate((label) => {
      const tab = [...document.querySelectorAll(".ptabs .tab")].find((el) => (el.textContent || "").indexOf(label) >= 0);
      if (tab) tab.click();
    }, last);
    const seen = await desk.page.waitForFunction((label) => {
      const scroller = document.querySelector(".ptabs");
      const tab = [...scroller.querySelectorAll(".tab")].find((el) => (el.textContent || "").indexOf(label) >= 0);
      if (!tab || tab.getAttribute("aria-selected") !== "true") return false;
      const box = tab.getBoundingClientRect();
      const host = scroller.getBoundingClientRect();
      const ok = box.left >= host.left - 8 && box.right <= host.right + 8;
      if (!ok) window.__tabSee = { left: Math.round(box.left), right: Math.round(box.right), hostL: Math.round(host.left), hostR: Math.round(host.right), scroll: scroller.scrollLeft, max: scroller.scrollWidth - scroller.clientWidth };
      return ok;
    }, last, { timeout: 4000 }).then(() => true).catch(() => false);
    if (!seen) {
      const detail = await desk.page.evaluate(() => window.__tabSee || null);
      throw new Error("active profile tab stayed out of view " + JSON.stringify(detail));
    }
    await desk.page.locator(".ptabs .tab").first().click();
    await desk.page.waitForFunction(() => {
      const tab = document.querySelector(".ptabs .tab");
      return tab && tab.getAttribute("aria-selected") === "true" && document.activeElement === tab;
    });
    for (let step = 0; step < info.tabs.length; step++) {
      const state = await desk.page.evaluate(() => {
        const tabs = [...document.querySelectorAll(".ptabs [role='tab']")];
        const at = tabs.findIndex((el) => el.getAttribute("aria-selected") === "true");
        const selected = tabs[at];
        const next = tabs[at + 1];
        return {
          id: selected ? selected.getAttribute("data-ptab-id") : "",
          focused: document.activeElement === selected,
          next: next ? next.getAttribute("data-ptab-id") : ""
        };
      });
      if (!state.focused) throw new Error("focus was not on the selected profile tab before the next key " + JSON.stringify(state));
      if (!state.next) break;
      await desk.page.keyboard.press("ArrowRight");
      await desk.page.waitForFunction((id) => {
        const tabs = [...document.querySelectorAll(".ptabs [role='tab']")];
        const tab = tabs.find((el) => el.getAttribute("data-ptab-id") === id);
        return tab && tab.getAttribute("aria-selected") === "true" && document.activeElement === tab;
      }, state.next);
    }
    const keyed = await desk.page.waitForFunction((label) => {
      const scroller = document.querySelector(".ptabs");
      const tab = [...scroller.querySelectorAll(".tab")].find((el) => (el.textContent || "").indexOf(label) >= 0);
      if (!tab || tab.getAttribute("aria-selected") !== "true" || document.activeElement !== tab) return false;
      const box = tab.getBoundingClientRect();
      const host = scroller.getBoundingClientRect();
      const ok = box.left >= host.left - 8 && box.right <= host.right + 8;
      if (!ok) window.__keySee = { left: Math.round(box.left), right: Math.round(box.right), hostR: Math.round(host.right), scroll: scroller.scrollLeft };
      return ok;
    }, last, { timeout: 4000 }).then(() => true).catch(() => false);
    if (!keyed) {
      const detail = await desk.page.evaluate(() => window.__keySee || null);
      throw new Error("keyboard did not keep the active profile tab in view " + JSON.stringify(detail));
    }
    const beforeLeft = await desk.page.evaluate(() => {
      const tabs = [...document.querySelectorAll(".ptabs [role='tab']")];
      return tabs.findIndex((el) => el.getAttribute("aria-selected") === "true");
    });
    await desk.page.keyboard.press("ArrowLeft");
    await desk.page.waitForFunction((at) => {
      const tabs = [...document.querySelectorAll(".ptabs [role='tab']")];
      const now = tabs.findIndex((el) => el.getAttribute("aria-selected") === "true");
      return now >= 0 && now < at && document.activeElement === tabs[now];
    }, beforeLeft);
    await desk.page.screenshot({ path: "/opt/cursor/artifacts/profile-tabs-desktop.png" });
    await desk.context.close();

    const few = await openProfile(browser, port, 1280, 800, ["replies", "media", "games", "highlights", "friends", "about", "gifts"]);
    const quiet = await strip(few.page);
    if (quiet.max > 2) throw new Error("a single profile tab overflowed " + JSON.stringify(quiet));
    if (!quiet.leftHidden || !quiet.rightHidden) throw new Error("arrows showed without overflow " + JSON.stringify(quiet));
    await few.context.close();

    const phone = await openProfile(browser, port, 390, 844, null);
    const mobile = await strip(phone.page);
    if (mobile.leftDisplay !== "none" || mobile.rightDisplay !== "none") throw new Error("phone showed tab arrows " + JSON.stringify(mobile));
    if (mobile.overflow === "hidden") throw new Error("phone profile tabs cannot scroll");
    const moved = await phone.page.evaluate(() => {
      const scroller = document.querySelector(".ptabs");
      const max = scroller.scrollWidth - scroller.clientWidth;
      if (max <= 2) return true;
      scroller.scrollLeft = Math.min(40, max);
      return scroller.scrollLeft > 0;
    });
    if (!moved) throw new Error("phone profile tabs did not scroll");
    await phone.context.close();
    console.log("profile tab scroll ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
