/* Composer writing tools. The sparkle stays in the toolbar, works from the
   on-device path, and stays off the screen when that path is off.
   Checked at phone, tablet, and desktop widths. Nothing here names an account. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const widths = [
  { width: 390, height: 844, name: "phone" },
  { width: 768, height: 1024, name: "tablet" },
  { width: 1280, height: 800, name: "desktop" }
];

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

async function tune(page, level, lang) {
  await page.evaluate(() => {
    if (window.ViktorychDevice && window.ViktorychDevice.normalize) return;
    return new Promise((resolve, reject) => {
      const tag = document.createElement("script");
      tag.src = "device.js";
      tag.onload = () => resolve();
      tag.onerror = () => reject(new Error("device script failed"));
      (document.body || document.documentElement).appendChild(tag);
    });
  });
  await page.waitForFunction(() => window.ViktorychDevice && window.ViktorychDevice.normalize, null, { timeout: 15000 });
  await page.evaluate(({ level, lang }) => {
    const device = window.ViktorychDevice;
    const next = device.normalize(device.read());
    next.level = level;
    next.autoLight = false;
    next.toggles.ai = level !== "light";
    next.aiFeatures.compose = level !== "light";
    const saved = device.persist(next);
    if (window.STATE && window.STATE.settings) window.STATE.settings.devicePerf = saved;
    try { localStorage.setItem("viktorychapp-lang-user-picked", "1"); } catch (err) { /* the language still switches */ }
    if (window.SI18n) window.SI18n.setLang(lang || "en");
  }, { level: level, lang: lang });
}

async function measure(page) {
  return page.evaluate(() => {
    const note = document.getElementById("compose-note");
    const ava = document.querySelector(".xc .ava");
    const text = document.querySelector("#compose-text");
    const spark = document.querySelector(".xc .xc-ai-btn");
    const emoji = document.querySelector(".xc [data-act='xc-emoji']");
    const tools = document.querySelector(".xc .xc-tools");
    if (!note || !ava || !text || !spark || !emoji || !tools) return { missing: true };
    const ns = getComputedStyle(note);
    const ss = getComputedStyle(spark);
    const es = getComputedStyle(emoji);
    const nr = note.getBoundingClientRect();
    const ar = ava.getBoundingClientRect();
    const tr = text.getBoundingClientRect();
    const sr = spark.getBoundingClientRect();
    const overlap = nr.left < ar.right - 1 && nr.right > ar.left + 1 && nr.top < ar.bottom - 1 && nr.bottom > ar.top + 1;
    const blue = ss.color.match(/\d+/g) || [];
    return {
      missing: false,
      font: parseFloat(ns.fontSize),
      noteColor: ns.color,
      textColor: getComputedStyle(text).color,
      overlap: overlap,
      noteBelow: nr.top >= tr.bottom - 2,
      chips: document.querySelectorAll(".odai-chips").length,
      inTools: !!spark.closest(".xc-tools"),
      sparkW: Math.round(sr.width),
      sparkH: Math.round(sr.height),
      sameBlue: ss.color === es.color,
      blue: blue.map(Number),
      bg: ss.backgroundColor,
      border: ss.borderTopWidth
    };
  });
}

/* The home composer is redrawn while the page settles. A locator that was
   stable a moment ago can detach mid-scroll. Re-query and try again. */
async function openMenu(page) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const field = page.locator("#compose-text");
      await field.waitFor({ state: "visible", timeout: 5000 });
      await field.scrollIntoViewIfNeeded({ timeout: 5000 });
      const spark = page.locator(".xc .xc-ai-btn");
      await spark.waitFor({ state: "visible", timeout: 5000 });
      await spark.click({ timeout: 5000 });
      await page.locator(".xc-ai-pop").waitFor({ timeout: 5000 });
      return;
    } catch (err) {
      last = err;
      const text = String(err && err.message || err);
      if (attempt === 3 || !/not attached|not stable|detached/i.test(text)) throw err;
      await page.waitForTimeout(300);
    }
  }
  throw last;
}

async function layout(page, vp) {
  const row = await measure(page);
  if (row.missing) fail(vp.name + " composer is missing pieces");
  if (row.chips) fail(vp.name + " still shows the old chips");
  if (row.font > 13.5) fail(vp.name + " helper text is " + row.font + "px");
  if (!row.noteBelow || row.overlap) fail(vp.name + " helper still meets the avatar");
  if (row.noteColor === row.textColor) fail(vp.name + " helper uses the primary text color");
  if (!row.inTools) fail(vp.name + " sparkle is outside the toolbar");
  if (row.sparkW < 32 || row.sparkH < 32) fail(vp.name + " sparkle is too small");
  if (!row.sameBlue) fail(vp.name + " sparkle color does not match the toolbar");
  if (!(row.blue[2] > row.blue[0] && row.blue[2] > 120)) fail(vp.name + " sparkle is not accent blue");
  if (row.bg !== "rgba(0, 0, 0, 0)" && row.bg !== "transparent") fail(vp.name + " sparkle has a filled background");
  await openMenu(page);
  const box = await page.locator(".xc-ai-pop").boundingBox();
  if (!box || box.width < 160 || box.height < 80) fail(vp.name + " menu is not visible");
  if (box.x < -1 || box.x + box.width > vp.width + 1) fail(vp.name + " menu overflows horizontally");
  const labels = await page.locator(".xc-ai-pop").innerText();
  if (/Suggest replies|Sugerir respuestas/.test(labels)) fail(vp.name + " shows reply suggestions on a new post");
  if (!/Fix grammar|Corregir la gramática/.test(labels)) fail(vp.name + " menu is missing grammar");
  await page.locator(".xc-ai-pop [data-act='xc-ai-tones']").click();
  const tones = await page.locator(".xc-ai-sub").innerText();
  if (!/More friendly|Más cercano/.test(tones) || !/More formal|Más formal/.test(tones) || !/Shorter|Más breve/.test(tones)) {
    fail(vp.name + " tone submenu is incomplete");
  }
  await page.keyboard.press("Escape");
  if (await page.locator(".xc-ai-pop").count()) await page.locator(".xc .xc-ai-btn").click();
  await page.waitForFunction(() => !document.querySelector(".xc-ai-pop"), null, { timeout: 5000 });
}

async function behavior(page) {
  await page.locator("#compose-text").click();
  await page.locator(".xc .xc-ai-btn").click();
  await page.getByRole("menuitem", { name: "Fix grammar" }).click();
  await page.locator(".xc-ai-toast").waitFor({ timeout: 5000 });
  const empty = await page.locator(".xc-ai-toast").innerText();
  if (empty !== "Write something first.") fail("empty draft did not explain itself");

  await page.locator("#compose-text").fill("teh parcel recieve care");
  await openMenu(page);
  await page.getByRole("menuitem", { name: "Fix grammar" }).click();
  await page.locator(".xc-ai-preview .xc-ai-apply").waitFor({ timeout: 15000 });
  const preview = await page.locator(".xc-ai-preview p").innerText();
  if (preview.indexOf("The") !== 0 || preview.indexOf("receive") < 0 || preview.indexOf("teh") >= 0) fail("grammar preview was not the on-device correction");
  await page.locator(".xc-ai-apply").click();
  const applied = await page.locator("#compose-text").inputValue();
  if (applied.indexOf("The") !== 0 || applied.indexOf("receive") < 0) fail("apply did not update the draft");

  await openMenu(page);
  await page.locator(".xc-ai-pop [data-act='xc-ai-tones']").click();
  await page.getByRole("menuitem", { name: "Shorter" }).click();
  await page.locator(".xc-ai-preview .xc-ai-dismiss").waitFor({ timeout: 15000 });
  await page.locator(".xc-ai-dismiss").click();
  await page.waitForFunction(() => !document.querySelector(".xc-ai-preview"));
  const kept = await page.locator("#compose-text").inputValue();
  if (kept !== applied) fail("dismiss changed the draft");

  await tune(page, "balanced", "es");
  await page.locator(".xc .xc-ai-btn").waitFor();
  /* Only the language in use ships with the app, so Spanish arrives a moment later. */
  await page.waitForFunction(() => { const b = document.querySelector(".xc .xc-ai-btn"); return b && b.getAttribute("aria-label") === "Herramientas de escritura"; }, null, { timeout: 15000 }).catch(() => {});
  const esLabel = await page.locator(".xc .xc-ai-btn").getAttribute("aria-label");
  if (esLabel !== "Herramientas de escritura") fail("Spanish sparkle label is missing");
  const note = await page.locator("#compose-note").innerText();
  if (note.indexOf("borrador") < 0) fail("Spanish helper line is missing");
  await openMenu(page);
  const esMenu = await page.locator(".xc-ai-pop").innerText();
  if (esMenu.indexOf("Corregir la gramática") < 0 || esMenu.indexOf("Cambiar el tono") < 0) fail("Spanish menu is missing");
  if (esMenu.indexOf("Sugerir respuestas") >= 0) fail("Spanish new post offers reply suggestions");
  await page.keyboard.press("Escape");

  await tune(page, "light", "en");
  try {
    await page.waitForFunction(() => !document.querySelector(".xc-ai-btn") && !document.querySelector(".odai-chips") && document.getElementById("compose-text"), null, { timeout: 5000 });
  } catch (err) {
    fail("sparkle stayed visible when on-device writing tools are off");
  }
  await tune(page, "balanced", "en");
  await page.locator(".xc .xc-ai-btn").waitFor();

  await page.evaluate(() => {
    window.ViktorychXCompose.openReply({ text: "The parcel arrived yesterday and the gate was open for everyone." });
  });
  await page.locator(".xc-modal .xc-ai-btn").waitFor();
  await page.locator(".xc-modal .xc-ai-btn").click();
  await page.locator(".xc-modal .xc-ai-pop").getByRole("menuitem", { name: "Suggest replies" }).click();
  await page.locator(".xc-modal .xc-ai-choice").first().waitFor({ timeout: 15000 });
  const choices = await page.locator(".xc-modal .xc-ai-choice").count();
  if (choices < 2) fail("reply suggestions did not preview");
  await page.locator(".xc-modal .xc-ai-choice").nth(1).click();
  await page.locator(".xc-modal .xc-ai-apply").click();
  const reply = await page.locator("#reply-draft").inputValue();
  if (!reply.trim()) fail("applying a suggestion left the reply empty");
  await page.locator(".xc-modal [data-act='close-modal']").click();
  const discard = page.locator("[data-act='xc-discard']");
  if (await discard.count()) await discard.click();
  await page.waitForFunction(() => !document.querySelector(".xc-modal"));
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"]
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => {
    ["Proofreader", "Rewriter", "Writer", "LanguageModel"].forEach((name) => {
      const api = {
        availability() { return Promise.resolve("unavailable"); },
        create() { return new Promise(() => {}); }
      };
      try { Object.defineProperty(window, name, { configurable: true, writable: true, value: api }); }
      catch (err) { window[name] = api; }
    });
  });
  try {
    for (const vp of widths) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#compose-text, [data-act='xc-expand']", { timeout: 20000 });
      const slim = page.locator("[data-act='xc-expand']");
      if (await slim.count()) {
        await slim.first().click();
        await page.waitForSelector("#compose-text", { timeout: 20000 });
      }
      await tune(page, "balanced", "en");
      await page.locator(".xc .xc-ai-btn").waitFor({ timeout: 10000 });
      await layout(page, vp);
      if (vp.name === "phone") await behavior(page);
    }
    console.log("composer writing tools ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message ? err.message : err);
});
