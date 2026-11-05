/* Customize page (#/customize) at phone and desktop widths: opens from the
   menu, choices apply at once and are saved, back returns. Placeholders only. */
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
  { name: "desktop", width: 1280, height: 900 }
];

async function check(page, label) {
  const errors = [];
  page.on("pageerror", (err) => {
    const text = String(err && err.message || err);
    /* Sandboxed embed frames cannot read storage; that is not this page. */
    if (!/Access is denied for this document/.test(text)) errors.push(text);
  });
  const wide = await page.evaluate(() => window.innerWidth >= 500);
  if (!wide) {
    await page.evaluate(() => {
      const el = [...document.querySelectorAll(".m-ava")].find((node) => node.getBoundingClientRect().width > 0);
      if (el) el.click();
    });
    await page.waitForSelector(".drawer-x [data-act='customize-page']");
    await page.locator(".drawer-x [data-act='customize-page']").click();
  } else {
    await page.locator("header.nav:not(.nav-land) [data-act='customize-page']").first().click();
  }
  await page.waitForSelector(".pz-page .pz-sample");
  if (!/#\/customize$/.test(await page.evaluate(() => location.hash))) fail(label + " did not open #/customize");
  const parts = await page.evaluate(() => ({
    sections: document.querySelectorAll(".pz-sec").length,
    themes: document.querySelectorAll(".pz-theme").length,
    registry: window.ViktorychThemes ? Object.keys(window.ViktorychThemes.base).length + Object.keys(window.ViktorychThemes.flags || {}).length : 3,
    accents: document.querySelectorAll(".pz-accent").length,
    fonts: document.querySelectorAll(".pz-dot").length,
    edit: !!document.querySelector(".pz-page [data-act='drawer-edit']"),
    drawer: !!document.querySelector(".drawer-x")
  }));
  const ach = await page.evaluate(() => !window.ViktorychAchievements || !!document.querySelector(".pz-page .pz-ach [data-ach-set='sound']"));
  if (!ach) fail(label + " Achievements settings are missing");
  if (parts.sections < 9 || parts.themes !== parts.registry || parts.themes < 3 || parts.accents !== 6 || parts.fonts !== 5 || !parts.edit) fail(label + " page is missing parts " + JSON.stringify(parts));
  const postText = await page.evaluate(() => !!document.querySelector(".pz-page [data-act='pz-look'][data-key='textAlign'][data-value='justify']") && !!document.querySelector(".pz-page [data-act='pz-look'][data-key='textWrapAvatar']"));
  if (!postText) fail(label + " Post text controls are missing");
  if (parts.drawer) fail(label + " the menu stayed open over the page");
  await page.locator(".pz-accent[data-value='pink']").click();
  await page.locator(".pz-dot[data-value='18']").click();
  await page.locator(".pz-page [data-act='pz-look'][data-value='compact']").click();
  const flag = await page.evaluate(() => Object.keys((window.ViktorychThemes && window.ViktorychThemes.flags) || {})[0] || "");
  if (flag) {
    await page.locator(`.pz-theme[data-theme='${flag}']`).click();
    const on = await page.evaluate(() => document.documentElement.getAttribute("data-flag"));
    if (on !== flag) fail(label + " flag theme did not apply " + on);
  }
  await page.locator(".pz-theme[data-theme='default']").click();
  await page.locator(".pz-page [data-act='pz-look'][data-key='reduceMotion']").click();
  await page.locator(".pz-page [data-act='pz-look'][data-key='textAlign'][data-value='justify']").click();
  await page.locator(".pz-page [data-act='pz-look'][data-key='textWrapAvatar']").click();
  const applied = await page.evaluate(() => {
    const root = document.documentElement;
    const saved = JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}");
    const sample = document.querySelector(".pz-sample .post-text");
    return {
      blue: getComputedStyle(root).getPropertyValue("--blue").trim(),
      fs: root.getAttribute("data-fs"),
      density: root.getAttribute("data-density"),
      motion: root.getAttribute("data-motion"),
      theme: root.getAttribute("data-theme"),
      textAlign: root.getAttribute("data-text-align"),
      textWrap: root.getAttribute("data-text-wrap"),
      sampleSize: sample ? getComputedStyle(sample).fontSize : "",
      sampleAlign: sample ? getComputedStyle(sample).textAlign : "",
      saved: [saved.accent, saved.fontSize, saved.density, saved.reduceMotion, saved.appearance, saved.textAlign, !!saved.textWrapAvatar]
    };
  });
  if (applied.blue !== "#f91880" || applied.fs !== "18" || applied.density !== "compact" || applied.motion !== "reduce" || applied.theme !== "default" || applied.textAlign !== "justify" || applied.textWrap !== "avatar") fail(label + " choices did not apply " + JSON.stringify(applied));
  if (applied.sampleSize !== "18px") fail(label + " preview text did not grow " + applied.sampleSize);
  if (applied.sampleAlign !== "justify") fail(label + " preview text was not justified " + applied.sampleAlign);
  if (JSON.stringify(applied.saved) !== JSON.stringify(["pink", 18, "compact", true, "default", "justify", true])) fail(label + " choices were not saved " + JSON.stringify(applied.saved));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".pz-page");
  const kept = await page.evaluate(() => [getComputedStyle(document.documentElement).getPropertyValue("--blue").trim(), document.documentElement.getAttribute("data-fs")]);
  if (kept[0] !== "#f91880" || kept[1] !== "18") fail(label + " choices were lost on reload " + JSON.stringify(kept));
  /* The saved screen paints before the click handlers are bound. */
  /* Slow runners bind late, so tap back again until it takes. */
  let left = false;
  for (let i = 0; i < 8 && !left; i++) {
    await page.waitForTimeout(1500);
    const btn = page.locator(".pz-page [data-act='back']");
    if (await btn.count()) await btn.click().catch(() => {});
    left = await page.waitForFunction(() => !document.querySelector(".pz-page"), null, { timeout: 2500 }).then(() => true, () => false);
  }
  if (!left) fail(label + " back stayed on " + await page.evaluate(() => location.hash + " " + history.length));
  if (errors.length) fail(label + " page errors: " + errors.slice(0, 3).join(" | "));
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
    console.log("customize page ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
