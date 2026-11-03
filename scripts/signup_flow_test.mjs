// Local first-run audit. A static server plus an in-process worker (D1)
// stand in for production. Nothing here signs up on the live site.
//
// Account numbers and handles are created inside the page and stay there.
// This process only prints viewport sizes, timings, and pass/fail.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromWorker = createRequire(path.join(root, "worker/package.json"));
const { Miniflare, Log, LogLevel } = requireFromWorker("miniflare");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8"
};

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1280, height: 800 }
];

let pageOrigin = "";
let worker = null;
let ipCounter = 1;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, pageOrigin || "http://127.0.0.1");
      if (url.pathname === "/accounts.config.js") {
        const body = "window.VIKTORYCH_ACCOUNTS = " + JSON.stringify({
          api: pageOrigin, gate: true, turnstileSiteKey: "",
          emergencyHash: "f".repeat(64),
          // Short sign-up tries so the lost-answer test below runs quickly.
          signupTryMs: [4000, 15000]
        }) + ";\n";
        res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" });
        res.end(body);
        return;
      }
      if (url.pathname.startsWith("/v1/")) {
        const body = await readBody(req);
        const headers = { origin: pageOrigin, "cf-connecting-ip": "203.0.113." + ((ipCounter++ % 200) + 1) };
        for (const name of ["content-type", "authorization", "accept", "x-viktorych-intent"]) {
          if (req.headers[name]) headers[name] = req.headers[name];
        }
        const upstream = await worker.dispatchFetch("https://accounts.test" + url.pathname + url.search, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : body
        });
        const out = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") || "application/json",
          "cache-control": "no-store"
        });
        res.end(out);
        return;
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const file = path.resolve(root, "." + rel);
      if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end("missing"); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("server error");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      pageOrigin = "http://127.0.0.1:" + port;
      resolve(server);
    });
  });
}

function launch() {
  const req = createRequire(import.meta.url);
  const core = process.env.PLAYWRIGHT_CORE || "playwright-core";
  return req(core).chromium.launch({
    channel: "chrome", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });
}

function redact(text) {
  return String(text || "")
    .replace(/\b\d{4}(?: \d{4}){3}\b/g, "[redacted]")
    .replace(/\b\d{12,16}\b/g, "[redacted]")
    .replace(/\breader[a-z]{4,}\b/g, "[redacted]");
}

async function openFresh(browser, viewport, extra = {}) {
  const context = await browser.newContext({
    ...extra,
    viewport: { width: viewport.width, height: viewport.height },
    serviceWorkers: "block",
    permissions: ["clipboard-read", "clipboard-write", "notifications"]
  });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (err) => problems.push(redact(err && err.message || err)));
  return { context, page, problems };
}

async function gotoFresh(page) {
  const started = Date.now();
  await openPage(page, "/");
  await page.getByRole("button", { name: "Sign up" }).first().waitFor({ timeout: 8000 });
  const firstScreen = Date.now() - started;
  await page.waitForFunction(() => window.ViktorychAccounts && window.ViktorychAccounts.blocking, null, { timeout: 20000 });
  return firstScreen;
}

function signedInSession() {
  return `(() => {
    try {
      const session = JSON.parse(localStorage.getItem("viktorychapp-account-v1") || "null");
      return !!(session && session.token && session.account);
    } catch (err) { return false; }
  })()`;
}

async function logOut(page) {
  // Log out lives on the settings page. A full reload to that address can
  // lose the race with the sign-in reload and leave Home on screen under
  // the settings address. Move the hash after the session exists so the
  // page paints Settings, then press the button that is on screen.
  await page.waitForFunction(signedInSession(), null, { timeout: 20000 });
  await page.evaluate(() => {
    const want = "#/settings";
    const title = document.querySelector("#app h1");
    const onSettings = (location.hash || "") === want && title && title.textContent.trim() === "Settings";
    if (!onSettings) {
      if ((location.hash || "") !== want) location.hash = want;
      else window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
  });
  const ready = await page.waitForFunction(() => {
    if (window.__didLogout) return true;
    const title = document.querySelector("#app h1");
    if (!title || title.textContent.trim() !== "Settings") return false;
    const nodes = [...document.querySelectorAll("#app [data-acct='logout']")];
    const el = nodes.find((node) => node.getBoundingClientRect().height > 0) || nodes[0];
    if (!el || !el.isConnected) return false;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    el.click();
    window.__didLogout = true;
    return true;
  }, null, { timeout: 15000 }).then(() => true, () => false);
  await page.evaluate(() => { window.__didLogout = false; });
  if (!ready) {
    const why = await page.evaluate(() => {
      let signed = false;
      try {
        const session = JSON.parse(localStorage.getItem("viktorychapp-account-v1") || "null");
        signed = !!(session && session.account);
      } catch (err) { signed = false; }
      const el = document.querySelector("[data-acct='logout']");
      const app = document.getElementById("app");
      let built = "";
      let builtErr = "";
      try {
        built = window.ViktorychAccounts && window.ViktorychAccounts.settingsHtml ? window.ViktorychAccounts.settingsHtml() : "missing";
      } catch (err) { builtErr = String(err && err.message || err); }
      return {
        signed: signed,
        attached: !!(el && el.isConnected),
        hash: location.hash,
        heading: (app && app.querySelector("h1") && app.querySelector("h1").textContent) || "",
        builtHasLogout: typeof built === "string" && built.indexOf("data-acct=\"logout\"") >= 0,
        builtErr: builtErr
      };
    });
    throw new Error("settings never showed Log out (" + page.url() + ") " + JSON.stringify(why));
  }
}

// Right after a log out the sign-in wall can draw once more while the
// server answers, and a Sign up click that lands on the old wall opens
// nothing (seen on CI). Click again until the welcome step is up.
async function openWelcome(page) {
  const welcome = page.locator("#onb-layer [data-step='welcome'] [data-onb='next']");
  for (let attempt = 0; ; attempt++) {
    await page.getByRole("button", { name: "Sign up" }).first().click({ timeout: 15000 }).catch(() => {});
    if (await welcome.waitFor({ timeout: 6000 }).then(() => true, () => false)) return;
    if (attempt >= 2) throw new Error("Sign up never opened the welcome step");
  }
}

// After Log in the sign-in form is drawn on the next frame; wait for the
// number field rather than reading it straight away (it was null on CI).
async function openLogin(page) {
  await page.waitForFunction(() => !document.querySelector("#account-layer .acct-modal"), null, { timeout: 10000 }).catch(() => {});
  for (let attempt = 0; ; attempt++) {
    await page.getByRole("button", { name: "Log in" }).first().click({ timeout: 15000 }).catch(() => {});
    if (await page.locator("#acct-accountNumber").waitFor({ timeout: 6000 }).then(() => true, () => false)) return;
    if (attempt >= 2) throw new Error("Log in never showed the number field");
  }
}

async function openSignup(page) {
  // Sign up opens the first-time setup, one step per screen: welcome,
  // language, a choice of how to start, then the account steps in the same
  // full-screen frame.
  await openWelcome(page);
  // The welcome screen also offers a temporary account with its delete-time
  // picker; Back returns to the welcome screen.
  await page.locator("#onb-layer [data-step='welcome'] [data-onb='temp']").click({ timeout: 15000 });
  await page.locator(".acct-temp-setup [data-acct='temp-pick'][data-pick='7d']").click();
  await page.locator(".acct-temp-setup [data-acct='temp-setup-back']").click();
  await page.locator("#onb-layer [data-step='welcome'] [data-onb='next']").click({ timeout: 15000 });
  await page.locator("#onb-layer [data-step='language'] [data-onb='next']").click();
  await page.locator("#onb-layer [data-step='choose'] [data-onb='create']").click();
  await page.locator(".acct-setup[data-step='name'] .acct-modal").waitFor();
}

// Esc walks back one step at a time; at the welcome screen it closes setup.
async function leaveSetup(page) {
  for (let i = 0; i < 10; i++) {
    const open = await page.evaluate(() => !!document.querySelector("#account-layer .acct-modal, #onb-layer .oobe"));
    if (!open) return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(450);
  }
  throw new Error("Esc never left setup");
}

// The step's title takes focus and the live region names the step.
async function stepFocused(page, step) {
  return page.waitForFunction((id) => {
    // A touch screen focuses the title; with a mouse the step's one text
    // field takes focus so typing can start.
    const el = document.activeElement;
    const live = document.getElementById("oobe-live");
    const shell = document.querySelector(".oobe[data-step='" + id + "']");
    const title = shell && shell.querySelector("#oobe-title");
    if (!shell || !el || !title || !shell.contains(el)) return false;
    if (el !== title && !(el.matches("input") && el.closest(".oobe-main"))) return false;
    return !!live && live.textContent.indexOf(title.textContent.trim()) >= 0;
  }, step, { timeout: 5000 }).then(() => true, () => false);
}

// Animation names seen while one step changes to the next.
async function stepAnimations(page, selector) {
  return page.evaluate(async (sel) => {
    const seen = new Set();
    const grab = () => { for (const a of document.getAnimations()) if (a.animationName) seen.add(a.animationName); };
    document.querySelector(sel).click();
    for (let i = 0; i < 20; i++) { grab(); await new Promise((r) => setTimeout(r, 20)); }
    return [...seen];
  }, selector);
}

// From the profile step to the timeline. Every post-account step is shown
// once, and a reload resumes the step it was on.
// SHOTS=dir saves a picture of each setup step (for review only).
async function shot(page, name) {
  if (!process.env.SHOTS) return;
  fs.mkdirSync(process.env.SHOTS, { recursive: true });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(process.env.SHOTS, name + ".png") }).catch(() => {});
}

// The settings steps: every row is a switch wired to a real setting, each
// step has Skip, and a change shows at once and survives in the settings.
async function settingsSteps(page, notes, label, step) {
  const scope = "#onb-layer [data-step='" + step + "']";
  await shot(page, "setup-" + step);
  if (!(await page.locator(scope + " .oobe-head [data-onb='skip']").count())) notes.push(`${label}: ${step} step has no Skip`);
  const subs = await page.locator(scope + " .oobe-sub").count();
  if (subs > 1) notes.push(`${label}: ${step} step has more than one line under the title`);
  const sw = (id) => page.locator(scope + " [data-onb='pref'][data-id='" + id + "']");
  const checked = async (id) => (await sw(id).getAttribute("aria-checked")) === "true";
  if (step === "privacy") {
    for (const id of ["protected", "privateFollows", "discoverable", "online"]) {
      if (!(await sw(id).count())) notes.push(`${label}: privacy switch ${id} missing`);
    }
    if (!(await page.locator(scope + " .oobe-foot [data-onb='skip-all']").count())) notes.push(label + ": privacy step has no Skip all");
    if (await checked("protected")) notes.push(label + ": protected posts is on by default");
    if (!(await checked("discoverable"))) notes.push(label + ": suggestions are off by default");
    await sw("protected").click();
    const saved = await page.waitForFunction(() => {
      const a = window.ViktorychAccounts && window.ViktorychAccounts.account && window.ViktorychAccounts.account();
      return !!(a && a.protected);
    }, null, { timeout: 15000 }).then(() => true, () => false);
    if (!saved) notes.push(label + ": protect your posts did not save to the account");
    await sw("protected").click();
    await page.waitForFunction(() => {
      const a = window.ViktorychAccounts && window.ViktorychAccounts.account && window.ViktorychAccounts.account();
      return !!(a && !a.protected);
    }, null, { timeout: 15000 }).catch(() => notes.push(label + ": protect your posts did not turn back off"));
    await sw("online").click();
    const hidden = await page.waitForFunction(() => window.ViktorychPresence && window.ViktorychPresence.seenPrivacy() === "nobody", null, { timeout: 15000 }).then(() => true, () => false);
    if (!hidden) notes.push(label + ": online status switch did not save");
    await sw("online").click();
    await page.waitForFunction(() => window.ViktorychPresence && window.ViktorychPresence.seenPrivacy() === "everyone", null, { timeout: 15000 }).catch(() => {});
  } else if (step === "look") {
    await page.locator(scope + " [data-onb='accent'][data-mode='pink']").click();
    await page.locator(scope + " [data-onb='size'][data-mode='17']").click();
    const look = await page.evaluate(() => ({ accent: document.documentElement.getAttribute("data-accent"), fs: document.documentElement.getAttribute("data-fs"), saved: window.ViktorychSetup.get("accent") + "/" + window.ViktorychSetup.get("fontSize") }));
    if (look.accent !== "pink" || look.fs !== "17" || look.saved !== "pink/17") notes.push(`${label}: accent or text size did not apply (${JSON.stringify(look)})`);
    await page.locator(scope + " [data-onb='accent'][data-mode='blue']").click();
    await page.locator(scope + " [data-onb='size'][data-mode='15']").click();
  } else if (step === "content") {
    if (!(await checked("translateAuto"))) notes.push(label + ": Live Translate is off by default");
    await sw("translateAuto").click();
    if ((await page.evaluate(() => window.ViktorychSetup.get("translateAuto"))) !== false) notes.push(label + ": Live Translate switch did not save");
    await sw("translateAuto").click();
    await page.locator(scope + " [data-onb='autoplay'][data-mode='wifi']").click();
    if ((await page.evaluate(() => window.ViktorychSetup.get("autoplay"))) !== "wifi") notes.push(label + ": autoplay choice did not save");
    await page.locator(scope + " [data-onb='autoplay'][data-mode='all']").click();
  } else if (step === "alerts") {
    for (const id of ["haptics", "names", "preview"]) {
      if (!(await sw(id).count())) notes.push(`${label}: alerts switch ${id} missing`);
      else if (!(await checked(id))) notes.push(`${label}: alerts switch ${id} is off by default`);
    }
    await sw("haptics").click();
    await sw("preview").click();
    const st = await page.evaluate(() => ({ haptics: window.ViktorychSetup.get("haptics"), preview: window.ViktorychSetup.notifPrivacy().preview }));
    if (st.haptics !== false || st.preview !== false) notes.push(`${label}: alert switches did not save (${JSON.stringify(st)})`);
    await sw("haptics").click();
    await sw("preview").click();
  }
}

async function walkSetup(page, notes, label, opts = {}) {
  const at = (id) => page.locator("#onb-layer [data-step='" + id + "']").waitFor({ timeout: 20000 }).then(() => true, () => false);
  if (!(await at("profile"))) { notes.push(label + ": setup did not continue after the account was saved"); return; }
  const named = await page.locator("#onb-layer input[name='onbName']").inputValue();
  if (named !== "Example Reader") notes.push(label + ": setup did not prefill the display name");
  await page.locator("#onb-layer [data-step='profile'] [data-onb='skip']").first().click();
  if (!(await at("privacy"))) { notes.push(label + ": privacy step missing"); return; }
  await settingsSteps(page, notes, label, "privacy");
  await page.locator("#onb-layer [data-step='privacy'] .oobe-foot [data-onb='next']").click();
  if (!(await at("theme"))) { notes.push(label + ": theme step missing"); return; }
  if (opts.reload) {
    await page.reload({ waitUntil: "domcontentloaded" });
    if (!(await at("theme"))) { notes.push(label + ": setup did not resume the same step after reload"); return; }
  }
  // The theme picker lists every theme from window.ViktorychThemes, flag
  // themes included, and picking one applies it live.
  const flagIds = await page.evaluate(() => Object.keys((window.ViktorychThemes && window.ViktorychThemes.flags) || {}));
  for (const id of flagIds) {
    if (!(await page.locator(`#onb-layer [data-onb='theme'][data-mode='${id}']`).count())) notes.push(`${label}: setup theme picker is missing the ${id} theme`);
  }
  if (flagIds.length) {
    await page.locator(`#onb-layer [data-onb='theme'][data-mode='${flagIds[0]}']`).click();
    const applied = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    if (applied !== flagIds[0]) notes.push(label + ": picking a flag theme in setup did not apply it");
  }
  await page.locator("#onb-layer [data-onb='theme'][data-mode='lightsout']").click();
  await page.locator("#onb-layer [data-step='theme'] .oobe-foot [data-onb='next']").click();
  if (!(await at("look"))) { notes.push(label + ": look step missing"); return; }
  await settingsSteps(page, notes, label, "look");
  await page.locator("#onb-layer [data-step='look'] .oobe-foot [data-onb='next']").click();
  if (!(await at("content"))) { notes.push(label + ": content step missing"); return; }
  await settingsSteps(page, notes, label, "content");
  await page.locator("#onb-layer [data-step='content'] [data-onb='skip']").first().click();
  if (!(await at("data"))) { notes.push(label + ": save-data step missing"); return; }
  await page.locator("#onb-layer [data-step='data'] .oobe-foot [data-onb='next']").click();
  if (!(await at("notify"))) { notes.push(label + ": notifications step missing"); return; }
  // Notifications are explained first; nothing asks the browser yet.
  if (!(await page.locator("#onb-layer [data-step='notify'] .oobe-foot [data-onb]").count())) notes.push(label + ": notifications step has no action");
  if (!(await page.locator("#onb-layer [data-step='notify'] .oobe-head [data-onb='skip']").count())) notes.push(label + ": notifications step has no Skip");
  await page.locator("#onb-layer [data-step='notify'] .oobe-foot [data-onb='skip'], #onb-layer [data-step='notify'] .oobe-foot [data-onb='next']").first().click();
  if (!(await at("alerts"))) { notes.push(label + ": alerts step missing"); return; }
  await settingsSteps(page, notes, label, "alerts");
  await page.locator("#onb-layer [data-step='alerts'] .oobe-foot [data-onb='next']").click();
  if (!(await at("install"))) { notes.push(label + ": install step missing"); return; }
  await page.locator("#onb-layer [data-step='install'] [data-onb='skip']").first().click();
  if (!(await at("follow"))) { notes.push(label + ": follow step missing"); return; }
  await page.locator("#onb-layer [data-step='follow'] .oobe-foot [data-onb='next']").click();
  if (!(await at("done"))) { notes.push(label + ": finale missing"); return; }
  await shot(page, "setup-done");
  const doneSub = await page.locator("#onb-layer [data-step='done'] .oobe-sub").textContent().catch(() => "");
  if (!/change these anytime in Settings/.test(doneSub || "")) notes.push(label + ": the finale does not say settings can change later");
  await page.locator("#onb-layer [data-step='done'] [data-onb='finish']").click();
  await page.waitForFunction(() => !document.documentElement.hasAttribute("data-onb-open"), null, { timeout: 10000 });
  const sheet = await page.locator("[data-act='welcome-skip']").count();
  if (sheet) notes.push(label + ": the old welcome sheet opened after setup");
  // Earlier runs share the local server and may have posted, so look for
  // the home timeline itself rather than its empty state.
  const timeline = await page.getByRole("tab", { name: "For you" }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  if (!timeline) {
    const text = await page.evaluate(() => (document.body ? document.body.innerText : "").replace(/\s+/g, " ").slice(0, 400));
    notes.push(label + ": timeline did not open after setup: " + redact(text));
  }
}

// Create an account through the step flow: name, username, passkey, save.
async function createAccount(page, notes, label) {
  await openSignup(page);
  if (!(await stepFocused(page, "name"))) notes.push(label + ": name step title did not take focus");
  await page.locator("#acct-displayName").fill("Example Reader");
  await page.keyboard.press("Enter");
  await page.locator(".acct-setup[data-step='handle'] #acct-handle").waitFor();
  if (!(await stepFocused(page, "handle")) && !(await page.evaluate(() => document.activeElement && document.activeElement.id === "acct-handle"))) notes.push(label + ": handle step lost focus");
  if (!(await typeHandle(page))) notes.push(label + ": signup handle was not filled");
  await page.locator(".acct-setup [data-acct='handle-next']").click();
  const passkey = await page.locator(".acct-setup[data-step='passkey']").waitFor({ timeout: 8000 }).then(() => true, () => false);
  if (passkey) await page.locator(".acct-setup[data-step='passkey'] [data-acct='next']").click();
  const reached = await page.getByText("This number is shown once.").waitFor({ timeout: 20000 }).then(() => true, () => false);
  if (!reached) { notes.push(label + ": signup did not reach the number step"); return false; }
  const codes = await page.locator("[data-recovery-code]").count();
  if (codes !== 10) notes.push(label + ": expected 10 recovery codes, saw " + codes);
  await page.locator(".acct-modal input[name='saved']").check();
  await page.locator(".acct-modal [data-acct='saved']").click();
  await page.waitForFunction(() => document.documentElement.getAttribute("data-wall") !== "1", null, { timeout: 20000 });
  return true;
}

async function fullFlow(page, viewport) {
  const notes = [];
  const label = viewport.name + " full";
  if (!(await createAccount(page, notes, label))) return notes;
  await page.locator("#onb-layer [data-step='profile']").waitFor({ timeout: 20000 }).catch(() => {});
  if (viewport.width >= 960) {
    const rail = await page.locator("#onb-layer .oobe-rail li").count();
    if (rail < 4) notes.push(label + ": desktop step rail missing");
  } else {
    const dots = await page.locator("#onb-layer .oobe-dots i").count();
    if (dots < 8) notes.push(label + ": phone progress dots missing");
  }
  await walkSetup(page, notes, label);
  return notes;
}

// Reduced motion swaps the slides for crossfades.
async function motionPass(page, reduced) {
  const notes = [];
  const label = reduced ? "reduced motion" : "motion";
  await page.getByRole("button", { name: "Sign up" }).first().click();
  await page.locator("#onb-layer [data-step='welcome'] [data-onb='next']").waitFor({ timeout: 15000 });
  const names = await stepAnimations(page, "#onb-layer [data-step='welcome'] [data-onb='next']");
  await page.locator("#onb-layer [data-step='language']").waitFor();
  const slides = names.filter((n) => /^oobe-(in|out)-(fwd|back)$/.test(n));
  if (reduced && slides.length) notes.push(label + ": steps still slide (" + slides.join(", ") + ")");
  if (!reduced && !slides.length) notes.push(label + ": steps change without the slide (" + names.join(", ") + ")");
  if (!(await stepFocused(page, "language"))) notes.push(label + ": language step title did not take focus");
  await page.keyboard.press("Escape");
  if (!(await page.locator("#onb-layer [data-step='welcome']").waitFor({ timeout: 5000 }).then(() => true, () => false))) notes.push(label + ": Esc did not go back");
  if (reduced) {
    await page.locator("#onb-layer [data-step='welcome'] [data-onb='next']").click();
    await page.locator("#onb-layer [data-step='language'] [data-onb='next']").click();
    await page.locator("#onb-layer [data-step='choose'] [data-onb='create']").click();
    await page.locator(".acct-setup[data-step='name']").waitFor();
    await page.locator("#acct-displayName").fill("Example Reader");
    await page.locator(".acct-setup [data-acct='next']").click();
    await page.locator("#acct-handle").waitFor();
    await typeHandle(page);
    await page.locator(".acct-setup [data-acct='handle-next']").click();
    const passkey = await page.locator(".acct-setup[data-step='passkey']").waitFor({ timeout: 8000 }).then(() => true, () => false);
    if (passkey) await page.locator(".acct-setup[data-step='passkey'] [data-acct='next']").click();
    await page.getByText("This number is shown once.").waitFor({ timeout: 20000 });
    await page.locator(".acct-modal input[name='saved']").check();
    await page.locator(".acct-modal [data-acct='saved']").click();
    await walkSetup(page, notes, label);
  }
  return notes;
}

// Quick sign-up: one plain form, defaults for the rest, straight to the
// timeline. The choice holds for the session and Back returns to welcome.
async function quickFlow(page, viewport) {
  const notes = [];
  const label = viewport.name + " quick";
  await page.getByRole("button", { name: "Sign up" }).first().click();
  await page.locator("#onb-layer [data-step='welcome'] [data-onb='quick']").click({ timeout: 15000 });
  await page.locator(".acct-quick #acct-displayName").waitFor();
  for (const want of ["#acct-displayName", "#acct-handle", "[data-acct='quick-create']", "[data-acct='open-temp']", "[data-acct='login']"]) {
    if (!(await page.locator(".acct-quick " + want).count())) notes.push(label + ": quick form is missing " + want);
  }
  await page.locator(".acct-quick [data-acct='quick-back']").click();
  if (!(await page.locator("#onb-layer [data-step='welcome']").waitFor({ timeout: 8000 }).then(() => true, () => false))) notes.push(label + ": Back did not return to welcome");
  await page.locator("#onb-layer [data-step='welcome'] [data-onb='quick']").click();
  await page.locator(".acct-quick [data-acct='open-temp']").click();
  if (!(await page.locator("[data-acct='temp-pick']").first().waitFor({ timeout: 8000 }).then(() => true, () => false))) notes.push(label + ": temporary account is not reachable from the quick form");
  await page.locator("[data-acct='temp-setup-back'], [data-acct='temp-back']").first().click().catch(() => {});
  await page.locator(".acct-quick #acct-displayName").waitFor({ timeout: 8000 }).catch(() => notes.push(label + ": temp Back did not return to the quick form"));
  await page.locator(".acct-quick [data-acct='quick-create']").click();
  if ((await page.locator("#acct-error").innerText().catch(() => "")) !== "What should we call you?") notes.push(label + ": empty name error missing");
  await page.locator("#acct-displayName").fill("Example Reader");
  await typeHandle(page);
  await page.locator(".acct-quick [data-acct='quick-create']").click();
  const reached = await page.getByText("This number is shown once.").waitFor({ timeout: 20000 }).then(() => true, () => false);
  if (!reached) { notes.push(label + ": quick sign-up did not reach the number step"); return notes; }
  await page.locator(".acct-modal input[name='saved']").check();
  await page.locator(".acct-modal [data-acct='saved']").click();
  const timeline = await page.getByRole("tab", { name: "For you" }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  if (!timeline) notes.push(label + ": quick sign-up did not open the timeline");
  const after = await page.evaluate(() => ({
    onb: !!document.querySelector("#onb-layer .oobe"),
    sheet: !!document.querySelector("[data-act='welcome-skip']"),
    doc: localStorage.getItem("viktorychapp-onboard-v1"),
    mode: sessionStorage.getItem("viktorychapp-setup-mode"),
    theme: document.documentElement.getAttribute("data-theme") || ""
  }));
  if (after.onb || after.sheet) notes.push(label + ": quick sign-up still showed setup screens");
  if (after.doc) notes.push(label + ": quick sign-up left setup progress behind");
  if (after.mode !== "quick") notes.push(label + ": the quick choice was not kept for the session");
  await openPage(page, "/#/settings");
  const rerun = await page.locator("[data-act='run-setup']").waitFor({ timeout: 15000 }).then(() => true, () => false);
  if (!rerun) notes.push(label + ": Settings has no Run setup again row");
  else {
    await page.evaluate(() => document.querySelector("[data-act='run-setup']").click());
    const first = await page.locator("#onb-layer [data-step='privacy']").waitFor({ timeout: 15000 }).then(() => true, () => false);
    if (!first) notes.push(label + ": Run setup again did not open the privacy step");
    else {
      // Skip all keeps the defaults and goes straight to the finale.
      await page.locator("#onb-layer [data-step='privacy'] [data-onb='skip-all']").click();
      const done = await page.locator("#onb-layer [data-step='done']").waitFor({ timeout: 10000 }).then(() => true, () => false);
      if (!done) notes.push(label + ": Skip all did not jump to the finale");
      else {
        await page.locator("#onb-layer [data-step='done'] [data-onb='finish']").click();
        const closed = await page.waitForFunction(() => !document.documentElement.hasAttribute("data-onb-open"), null, { timeout: 10000 }).then(() => true, () => false);
        if (!closed) notes.push(label + ": setup stayed open after Skip all");
      }
    }
  }
  return notes;
}

// Temporary accounts in Spanish on a browser set to English: every word on
// the screen is Spanish, a sign-up whose answer is lost is sent again and
// gives back the same account, a failing server says what failed, and each
// delete time (1 hour, 1 day, 7 days, 30 days, a picked date) is kept.
const SPANISH = () => {
  localStorage.setItem("viktorychapp-lang-user-picked", "1");
  localStorage.setItem("superintelapp-lang", "es");
  localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, lang: "es" }));
};
async function freshSpanish(page) {
  // A new session reloads the app on its own, which can cut a navigation
  // short; start over from a page load until a signed-out wall is up.
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(pageOrigin + "/", { waitUntil: "domcontentloaded" });
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await page.evaluate(SPANISH);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.ViktorychAccounts && window.ViktorychAccounts.blocking, null, { timeout: 20000 });
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
      await page.waitForTimeout(1000);
    }
  }
}
// From the sign-in wall, or (via "welcome") from Sign up and the setup's
// welcome step, which draws it in the setup look.
async function openTempScreen(page, via) {
  for (let attempt = 0; ; attempt++) {
    if (via === "welcome") {
      if (!(await page.locator("#onb-layer [data-step='welcome'] [data-onb='temp']").count())) {
        await page.locator("[data-acct='signup']:visible").first().click({ timeout: 15000 }).catch(() => {});
      }
      await page.locator("#onb-layer [data-step='welcome'] [data-onb='temp']").click({ timeout: 8000 }).catch(() => {});
    } else {
      await page.locator("[data-acct='open-temp']:visible").first().click({ timeout: 15000 }).catch(() => {});
    }
    if (await page.locator(".acct-temp-setup [data-acct='do-temp'], #account-layer [data-acct='do-temp']").first().waitFor({ timeout: 6000 }).then(() => true, () => false)) return;
    if (attempt >= 2) throw new Error("the temporary account screen did not open");
  }
}
// The new session, read again until it shows up; the app reloads itself
// once it has an account, so a single read can land mid-navigation.
async function tempSession(page, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const seen = await page.evaluate(() => {
      try {
        const s = JSON.parse(localStorage.getItem("viktorychapp-account-v1") || "null");
        return s && s.token && s.account && s.account.temporary ? { at: Number(s.account.temporary.expiresAt) || Date.parse(s.account.temporary.expiresAt) || 0 } : null;
      } catch (err) { return null; }
    }).catch(() => null);
    if (seen) return seen;
    await page.waitForTimeout(250);
  }
  return null;
}
async function tempFlow(page) {
  const notes = [];
  const label = "phone temp (es)";
  // Before the app's own scripts, since it saves its settings on unload.
  await page.addInitScript(SPANISH);
  await freshSpanish(page);
  await openTempScreen(page);
  const wallTitle = (await page.locator("#account-layer .acct-body h1").first().innerText()).trim();
  if (wallTitle !== "Cuenta temporal") notes.push(label + ": title from the wall is " + JSON.stringify(wallTitle) + ", not Cuenta temporal");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#account-layer .acct-modal"), null, { timeout: 10000 }).catch(() => {});
  await openTempScreen(page, "welcome");
  const title = (await page.locator(".acct-temp-setup #oobe-title").first().innerText()).trim();
  if (title !== "Cuenta temporal") notes.push(label + ": title in setup is " + JSON.stringify(title) + ", not Cuenta temporal");
  const screen = await page.locator("#account-layer").innerText();
  for (const english of ["Temporary account", "Delete after", "Use less data", "Start temporary account", "1 day"]) {
    if (screen.indexOf(english) >= 0) notes.push(label + ": English text on the Spanish screen: " + english);
  }
  // The first sign-up reaches the server but its answer never comes back,
  // the way a stalled worker looks from the phone.
  const posts = [];
  await page.route("**/v1/signup", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts.push(JSON.parse(route.request().postData() || "{}"));
    if (posts.length > 1) return route.continue();
    await route.fetch().catch(() => {});
    await new Promise((r) => setTimeout(r, 6000));
    return route.abort().catch(() => {});
  });
  await page.locator("#account-layer input[name='displayName']").fill("Lector Temporal");
  const started = Date.now();
  await page.locator("[data-acct='do-temp']").first().click();
  const slow = await page.locator("#account-layer .acct-wait").waitFor({ timeout: 10000 }).then(() => page.locator("#account-layer .acct-wait").innerText(), () => "");
  if (slow.indexOf("El servidor va lento") < 0) notes.push(label + ": no Spanish still-trying note while the answer was lost (" + JSON.stringify(slow) + ")");
  const first = await tempSession(page, 30000);
  if (!first) {
    const err = await page.locator("#acct-error").innerText().catch(() => "");
    notes.push(label + ": a lost answer ended without an account: " + JSON.stringify(err));
  } else {
    const want = started + 86400000;
    if (Math.abs(first.at - want) > 120000) notes.push(label + ": 1 day account expires at the wrong time");
  }
  if (posts.length !== 2) notes.push(label + ": expected one retry, saw " + posts.length + " sign-up posts");
  if (!posts[0] || !posts[0].signupKey || !posts[1] || posts[0].signupKey !== posts[1].signupKey) notes.push(label + ": the retry did not carry the same sign-up key");
  const made = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE display_name = ?").bind("Lector Temporal").first();
  if (!made || Number(made.n) !== 1) notes.push(label + ": the retried sign-up made " + (made && made.n) + " accounts, not 1");
  await page.unroute("**/v1/signup");

  // A server that keeps failing gets a specific Spanish message, with the
  // code, after one quiet retry. Never the bare "Algo salió mal".
  await freshSpanish(page);
  let failed = 0;
  await page.route("**/v1/signup", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    failed += 1;
    return route.fulfill({ status: 500, contentType: "text/plain", body: "" });
  });
  await openTempScreen(page);
  await page.locator("[data-acct='do-temp']").first().click();
  await page.locator("#account-layer .acct-error[role='alert']").waitFor({ timeout: 20000 }).catch(() => {});
  const text = (await page.locator("#acct-error").innerText().catch(() => "")).trim();
  if (text !== "Algo salió mal (error 500). Inténtalo de nuevo.") notes.push(label + ": a failing server showed " + JSON.stringify(text));
  if (failed !== 2) notes.push(label + ": a failing server was tried " + failed + " times, not 2");
  await page.unroute("**/v1/signup");
  await page.route("**/v1/signup", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
  });
  await page.locator("[data-acct='do-temp']").first().click();
  await page.waitForFunction(() => /no está disponible/.test((document.getElementById("acct-error") || {}).textContent || ""), null, { timeout: 20000 })
    .catch(() => notes.push(label + ": an unavailable server did not say sign-up is unavailable"));
  await page.unroute("**/v1/signup");

  // Every delete time.
  const span = { "1h": 3600000, "7d": 7 * 86400000, "30d": 30 * 86400000, custom: 3 * 86400000 };
  for (const pick of Object.keys(span)) {
    await freshSpanish(page);
    await openTempScreen(page);
    await page.locator("[data-acct='temp-pick'][data-pick='" + pick + "']").click();
    const at = Date.now();
    await page.locator("[data-acct='do-temp']").first().click();
    const made = await tempSession(page, 20000);
    if (!made) { notes.push(label + ": " + pick + " temporary account was not made: " + JSON.stringify(await page.locator("#acct-error").innerText().catch(() => ""))); continue; }
    if (Math.abs(made.at - (at + span[pick])) > (pick === "custom" ? 10 * 60000 : 120000)) notes.push(label + ": " + pick + " account expires at the wrong time");
  }
  return notes;
}

async function openPage(page, path) {
  const url = pageOrigin + path;
  let last = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return;
    } catch (err) {
      last = err;
      const text = String(err && err.message || err);
      if (text.indexOf("interrupted by another navigation") < 0) throw err;
      const here = page.url();
      if (path && here.indexOf(path.replace(/^\//, "")) >= 0) return;
      await page.waitForTimeout(150);
    }
  }
  throw last;
}

async function layoutPass(page, viewport) {
  const notes = [];
  const metrics = await page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    };
    const create = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Sign up");
    const signIn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Log in");
    const app = document.getElementById("app");
    const appBox = app ? app.getBoundingClientRect() : null;
    return {
      wall: document.documentElement.getAttribute("data-wall"),
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      create: box(create),
      signIn: box(signIn),
      appHidden: !appBox || appBox.width === 0 || getComputedStyle(app).display === "none",
      heading: (document.querySelector(".x-copy h1, .x-land-copy h1") || {}).textContent || ""
    };
  });
  if (metrics.wall !== "1") notes.push(viewport.name + ": wall not up");
  if (!metrics.appHidden) notes.push(viewport.name + ": logged-out app content is visible");
  if (metrics.overflowX > 1) notes.push(viewport.name + ": horizontal overflow " + metrics.overflowX);
  if (metrics.heading.trim() !== "ViktorychApp") notes.push(viewport.name + ": landing heading missing");
  for (const key of ["create", "signIn"]) {
    const b = metrics[key];
    if (!b || b.width < 8 || b.height < 8) { notes.push(viewport.name + ": " + key + " missing"); continue; }
    if (b.top < -1 || b.left < -1 || b.bottom > viewport.height + 1 || b.right > viewport.width + 1) {
      notes.push(viewport.name + ": " + key + " outside the viewport");
    }
  }
  await openSignup(page);
  await page.getByRole("heading", { name: "What's your name?" }).waitFor();
  const fits = await page.evaluate(() => {
    const card = document.querySelector(".oobe-card");
    const r = card.getBoundingClientRect();
    return r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1;
  });
  if (!fits) notes.push(viewport.name + ": setup card does not fit the screen");
  await page.locator("#acct-displayName").fill("");
  await page.locator(".acct-modal [data-acct='next']").click();
  await page.locator("#acct-error").waitFor();
  if ((await page.locator("#acct-error").innerText()) !== "What should we call you?") notes.push(viewport.name + ": empty name error missing");
  await page.locator("#acct-displayName").fill("Example Reader");
  await page.locator(".acct-modal [data-acct='next']").click();
  await page.locator("#acct-handle").waitFor();
  await page.locator("#acct-handle").fill("");
  await page.locator(".acct-modal [data-acct='handle-next']").click();
  if ((await page.locator("#acct-error").innerText()) !== "Choose a handle.") notes.push(viewport.name + ": empty handle error missing");
  await page.locator("#acct-handle").fill("!!");
  await page.locator(".acct-modal [data-acct='handle-next']").click();
  if ((await page.locator("#acct-error").innerText()) !== "That handle is not allowed.") notes.push(viewport.name + ": bad handle error missing");
  await page.locator("#acct-handle").fill("admin");
  await page.locator(".acct-modal [data-acct='handle-next']").click();
  if ((await page.locator("#acct-error").innerText()) !== "That handle is reserved.") notes.push(viewport.name + ": reserved handle error missing");
  const described = await page.locator("#acct-handle").getAttribute("aria-describedby");
  const invalid = await page.locator("#acct-handle").getAttribute("aria-invalid");
  if (described !== "acct-error" || invalid !== "true") notes.push(viewport.name + ": error not tied to the field");
  await leaveSetup(page);
  await page.waitForFunction(() => !document.querySelector(".acct-modal"));
  await page.getByRole("button", { name: "Log in" }).first().click();
  await page.getByRole("heading", { name: "Sign in to ViktorychApp" }).waitFor();
  const loginFields = await page.evaluate(() => {
    const form = document.getElementById("acct-login-form");
    const user = document.getElementById("acct-login-user");
    const pass = document.getElementById("acct-accountNumber");
    return {
      form: !!(form && form.tagName === "FORM"),
      user: !!(user && user.getAttribute("autocomplete") === "username" && getComputedStyle(user).display !== "none"),
      pass: !!(pass && pass.getAttribute("autocomplete") === "current-password" && pass.type === "password" && getComputedStyle(pass).display !== "none")
    };
  });
  if (!loginFields.form || !loginFields.user || !loginFields.pass) notes.push(viewport.name + ": sign-in is not a password-manager form");
  const resetCopy = await page.locator(".acct-modal").innerText();
  if (!/no password to reset/.test(resetCopy)) notes.push(viewport.name + ": password-reset explanation missing");
  await page.locator("#acct-accountNumber").fill("1234");
  await page.locator(".acct-modal [data-acct='do-login']").click();
  if ((await page.locator("#acct-error").innerText()) !== "Account numbers are 16 digits.") notes.push(viewport.name + ": short number error missing");
  await page.keyboard.press("Shift+Tab");
  const trap = await page.evaluate(() => document.activeElement && document.activeElement.closest(".acct-modal") !== null);
  if (!trap) notes.push(viewport.name + ": keyboard focus left the dialog");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".acct-modal"));
  await page.locator("#dock-root").waitFor({ state: "attached", timeout: 4000 }).catch(() => {});
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings" }).waitFor();
  const prefs = await page.locator(".acct-modal").innerText();
  if (prefs.includes("Sign in to ViktorychApp")) notes.push(viewport.name + ": settings opened sign-in");
  if (!/Language and appearance stay on this device/.test(prefs)) notes.push(viewport.name + ": logged-out settings missing");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Terms of Service" }).first().click();
  const terms = await page.locator(".acct-modal").innerText();
  if (!/account number is your login/.test(terms)) notes.push(viewport.name + ": terms page is still a stub");
  await page.keyboard.press("Escape");
  return notes;
}

async function typeHandle(page) {
  return page.evaluate(() => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    let handle = "reader";
    for (const n of bytes) handle += alphabet[n % 26];
    const input = document.querySelector("#acct-handle");
    input.focus();
    input.value = handle;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return /^[a-z]{10,12}$/.test(handle);
  });
}

async function firstRun(page) {
  const notes = [];
  let loginStatus = 0;
  page.on("response", (res) => {
    if (res.url().endsWith("/v1/login")) loginStatus = res.status();
  });
  let signupStatus = 0;
  await page.route("**/v1/signup", async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    const response = await route.fetch();
    signupStatus = response.status();
    await route.fulfill({ response });
  });
  await openSignup(page);
  await page.locator("#acct-displayName").fill("Example Reader");
  await page.locator(".acct-modal [data-acct='next']").click();
  await page.locator("#acct-handle").waitFor();
  const honeypot = await page.evaluate(() => {
    const el = document.querySelector('#account-layer input[name="fax"]');
    if (!el) return "missing";
    return getComputedStyle(el).display;
  });
  if (honeypot === "none" || honeypot === "missing") notes.push("honeypot is missing or hidden with display none");
  if (!(await typeHandle(page))) notes.push("signup handle was not filled");
  await page.locator(".acct-modal [data-acct='handle-next']").click();
  // With passkeys the next screen offers one; the plain path continues.
  const keyStep = await page.locator(".acct-setup[data-step='passkey']").waitFor({ timeout: 8000 }).then(() => true, () => false);
  const next = page.locator(".acct-modal [data-acct='next']");
  await next.click();
  if ((await next.getAttribute("aria-busy")) !== "true") notes.push("signup has no loading state");
  if (!keyStep) notes.push("passkey step did not show");
  const reached = await page.getByText("This number is shown once.").waitFor({ timeout: 20000 }).then(() => true, () => false);
  if (!reached) {
    notes.push("signup did not reach the number step (" + signupStatus + ")");
    return notes;
  }
  await page.unroute("**/v1/signup");
  const manager = await page.evaluate(() => {
    const form = document.getElementById("acct-save-form");
    const user = document.getElementById("acct-username");
    const pass = document.getElementById("acct-new-password");
    const codes = document.querySelectorAll("[data-recovery-code]");
    return {
      form: !!(form && form.tagName === "FORM"),
      user: !!(user && user.getAttribute("autocomplete") === "username" && user.name === "username" && user.value),
      pass: !!(pass && pass.getAttribute("autocomplete") === "new-password" && pass.name === "password" && pass.type === "password"),
      shown: !!user && !!pass && getComputedStyle(user).display !== "none" && getComputedStyle(pass).display !== "none",
      codes: codes.length
    };
  });
  if (!manager.form || !manager.user || !manager.pass || !manager.shown || manager.codes !== 10) notes.push("password manager fields or recovery codes are missing");
  if (!(await page.locator(".acct-modal [data-acct='saved']").isDisabled())) notes.push("next is enabled before the number is saved");
  const copied = await page.evaluate(async () => {
    document.querySelector("[data-acct='copy']").click();
    const text = await navigator.clipboard.readText();
    return /^\d{4} \d{4} \d{4} \d{4}$/.test(text);
  });
  if (!copied) notes.push("copy did not produce a grouped account number");
  const stored = await page.evaluate(() => {
    const pending = JSON.parse(sessionStorage.getItem("viktorychapp-pending-v1") || "{}");
    const number = String(pending.accountNumber || "");
    const handle = String((pending.account && pending.account.handle) || "");
    sessionStorage.setItem("viktorychapp-signup-number", JSON.stringify(number));
    sessionStorage.setItem("viktorychapp-signup-handle", JSON.stringify(handle));
    return {
      digits: /^\d{16}$/.test(number),
      handleOk: /^[a-z0-9_]{4,15}$/.test(handle),
      token: typeof pending.token === "string" && pending.token.length > 20
    };
  });
  if (!stored.digits || !stored.handleOk || !stored.token) notes.push("account number step did not keep a session");
  await page.locator(".acct-modal input[name='saved']").check();
  await page.locator(".acct-modal [data-acct='saved']").click();
  await page.waitForFunction(() => document.documentElement.getAttribute("data-wall") !== "1", null, { timeout: 20000 });
  await walkSetup(page, notes, "phone", { reload: true });
  const welcome = page.locator("[data-act='welcome-skip']");
  if (await welcome.count()) await welcome.click();
  const timeline = await page.getByText("No posts yet").first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  if (!timeline) {
    const state = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : "";
      return {
        wall: document.documentElement.getAttribute("data-wall") || "",
        home: /No posts yet/.test(text),
        missing: /load posts/.test(text),
        follow: /Find accounts to follow/.test(text),
        happening: /ViktorychApp/.test(text)
      };
    });
    notes.push("timeline did not open " + JSON.stringify(state));
    return notes;
  }
  await page.getByRole("tab", { name: "Following" }).click();
  await page.waitForFunction(() => (location.hash || "").indexOf("following") >= 0);
  await page.getByRole("link", { name: "Find accounts to follow" }).waitFor();
  const profile = await page.waitForFunction(() => {
    const session = JSON.parse(localStorage.getItem("viktorychapp-account-v1") || "{}");
    const handle = session.account && session.account.handle;
    const html = window.ViktorychAccounts.profileHtml({ name: "profile", handle: handle }) || "";
    return /Add a photo and bio/.test(html);
  }, null, { timeout: 15000 }).then(() => true, () => false);
  if (!profile) notes.push("own profile empty state is misleading");
  await openPage(page, "/#/settings/device");
  const balanced = page.getByRole("radio", { name: "Balanced" });
  await balanced.waitFor({ timeout: 15000 });
  if ((await balanced.getAttribute("aria-checked")) !== "true") notes.push("device performance is not Balanced");
  await openPage(page, "/#/settings/privacy");
  await page.getByRole("heading", { name: "Privacy and safety" }).waitFor();
  const privacy = await page.evaluate(() => {
    const on = (key) => {
      const btn = document.querySelector("[data-key='" + key + "']");
      return btn ? btn.getAttribute("aria-checked") : "missing";
    };
    return {
      embed: on("privacyEmbedShield"), webrtc: on("privacyWebRTC"), referrer: on("privacyNoReferrer"),
      trackers: on("privacyStripTrackers"), zero: on("privacyZeroTrace"), fingerprint: on("privacyAntiFingerprint")
    };
  });
  const expected = { embed: "false", webrtc: "true", referrer: "true", trackers: "true", zero: "false", fingerprint: "true" };
  if (JSON.stringify(privacy) !== JSON.stringify(expected)) notes.push("privacy defaults differ");
  await openPage(page, "/#/settings/notifications");
  await page.getByRole("button", { name: "Notify me about new posts" }).click();
  await page.getByRole("button", { name: "Notifications on" }).waitFor({ timeout: 10000 });
  await page.locator("[data-act='compose']:visible").first().click();
  await page.locator("#compose-text").waitFor();
  if ((await page.locator("#compose-text").getAttribute("aria-describedby")) !== "compose-note") notes.push("composer does not explain that it stays on device");
  await page.locator("#compose-text").fill("A local note from the first run.");
  await page.keyboard.press("Escape");
  await page.locator("[data-act='xc-save-draft']").click();
  await page.waitForFunction(() => !document.getElementById("compose-text"));
  await page.locator("[data-act='compose']:visible").first().click();
  await page.waitForFunction(() => (document.querySelector("#compose-text") && document.querySelector("#compose-text").value || "").indexOf("local note") >= 0);
  await page.locator("#compose-post").click();
  await page.getByText("Your post was sent.").first().waitFor({ timeout: 15000 });
  await page.waitForFunction(() => {
    const local = window.ViktorychLocal;
    if (!local || !local.readDoc) return false;
    return local.readDoc("drafts", "compose").then((saved) => !saved || String(saved.text || "").indexOf("local note") < 0);
  });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("compose-text"));
  await openPage(page, "/#/settings/resources");
  await page.getByRole("button", { name: "Install app" }).click();
  await page.getByRole("heading", { name: "Install app" }).waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".modal"));
  await openPage(page, "/#/settings");
  await logOut(page);
  await page.getByRole("heading", { name: "ViktorychApp" }).waitFor({ timeout: 20000 });
  await openLogin(page);
  await page.evaluate(() => {
    const input = document.querySelector("#acct-accountNumber");
    input.focus();
    input.value = "9".repeat(16);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("[data-acct='do-login']").click();
  });
  await page.getByText("Could not sign in.").waitFor({ timeout: 20000 });
  await page.keyboard.press("Escape");
  await openLogin(page);
  const reloaded = page.waitForEvent("load", { timeout: 20000 }).catch(() => null);
  const loggedIn = await page.evaluate(() => {
    const number = JSON.parse(sessionStorage.getItem("viktorychapp-signup-number") || "null");
    const input = document.querySelector("#acct-accountNumber");
    input.focus();
    input.value = String(number || "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("[data-acct='do-login']").click();
    return /^\d{16}$/.test(String(number || ""));
  });
  if (!loggedIn) notes.push("saved number was not available for sign-in");
  await reloaded;
  // Sign-in always reloads onto Home. Wait for that load before opening
  // Settings, or the reload lands on top of the settings address and Home
  // stays on screen with no Log out button.
  const back = await page.waitForFunction(() => {
    try {
      const session = JSON.parse(localStorage.getItem("viktorychapp-account-v1") || "null");
      if (!session || !session.token || !session.account) return false;
    } catch (err) { return false; }
    if (document.documentElement.getAttribute("data-wall") === "1") return false;
    const h1 = document.querySelector("#app h1");
    return !!(h1 && h1.textContent.trim() === "Home");
  }, null, { timeout: 20000 }).then(() => true, () => false);
  if (!back) {
    notes.push("sign-in did not open the app (" + loginStatus + ")");
    return notes;
  }
  await openPage(page, "/#/settings");
  await logOut(page);
  await page.getByRole("heading", { name: "ViktorychApp" }).waitFor({ timeout: 20000 });
  await openSignup(page);
  await page.locator("#acct-displayName").fill("Second Reader");
  await page.locator(".acct-modal [data-acct='next']").click();
  await page.locator("#acct-handle").waitFor();
  const reused = await page.evaluate(() => {
    const handle = JSON.parse(sessionStorage.getItem("viktorychapp-signup-handle") || "\"\"");
    const input = document.querySelector("#acct-handle");
    input.focus();
    input.value = String(handle || "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return /^[a-z0-9_]{4,15}$/.test(String(handle || ""));
  });
  if (!reused) notes.push("saved handle was not available");
  await page.locator(".acct-modal [data-acct='handle-next']").click();
  if (await page.locator(".acct-setup[data-step='passkey']").waitFor({ timeout: 8000 }).then(() => true, () => false)) await page.locator(".acct-modal [data-acct='next']").click();
  await page.getByText("That handle is taken.").waitFor({ timeout: 20000 });
  await leaveSetup(page);
  await page.context().setOffline(true);
  await openSignup(page);
  await page.locator("#acct-displayName").fill("Offline Reader");
  await page.locator(".acct-modal [data-acct='next']").click();
  await page.locator("#acct-handle").waitFor();
  await typeHandle(page);
  await page.locator(".acct-modal [data-acct='handle-next']").click();
  if (await page.locator(".acct-setup[data-step='passkey']").waitFor({ timeout: 8000 }).then(() => true, () => false)) await page.locator(".acct-modal [data-acct='next']").click();
  await page.getByText("Can't reach the server.").waitFor({ timeout: 15000 });
  await page.context().setOffline(false);
  return notes;
}

/* TV sign-in end to end against the in-process Worker: a TV asks for an
   account by username, the account's notifications list shows "Approve
   sign-in on TV?", Approve signs the TV in and Deny turns it away. The
   reply to the TV is the same for a name that does not exist. Then the
   desktop "Link a TV" box: paste a code with a dash and it goes on by
   itself. The username is made up inside the page and never printed. */
async function tvWorker(route, body) {
  const res = await worker.dispatchFetch("https://accounts.test" + route, {
    method: "POST",
    headers: { origin: pageOrigin, "content-type": "application/json", "cf-connecting-ip": "198.51.100." + ((ipCounter++ % 200) + 1) },
    body: JSON.stringify(body || {})
  });
  let data = {};
  try { data = await res.json(); } catch (err) { data = {}; }
  return { status: res.status, body: data };
}

async function signUpQuick(page) {
  // The same step flow as fullFlow: account steps, then skip through setup.
  await gotoFresh(page);
  const notes = [];
  if (!(await createAccount(page, notes, "tv ask"))) throw new Error("tv ask signup: " + notes.join("; "));
  await walkSetup(page, [], "tv ask");
}

async function tvNotes(page, code) {
  // A fresh load pulls the list; on a live device the push or the open
  // notifications stream does that.
  await openPage(page, "/#/notifications");
  await page.reload({ waitUntil: "domcontentloaded" });
  return page.locator(`[data-tvn='${code}']`).waitFor({ timeout: 20000 }).then(() => true, () => false);
}

async function tvAskFlow(browser) {
  const notes = [];
  const shots = process.env.SHOTS || "";
  const { context, page, problems } = await openFresh(browser, { width: 390, height: 844 });
  try {
    await signUpQuick(page);
    const handle = await page.evaluate(() => {
      const session = JSON.parse(localStorage.getItem("viktorychapp-account-v1") || "{}");
      return String((session.account && session.account.handle) || "");
    });
    if (!handle) { notes.push("tv ask: no signed-in account"); return notes; }

    // 1. Ask by username. A name that does not exist gets the same reply.
    let tv = (await tvWorker("/v1/tv-pair/start")).body;
    const asked = await tvWorker("/v1/tv-pair/ask", { poll: tv.poll, username: "@" + handle.toUpperCase() });
    const ghostTv = (await tvWorker("/v1/tv-pair/start")).body;
    const ghost = await tvWorker("/v1/tv-pair/ask", { poll: ghostTv.poll, username: "nobodyhere" + Date.now().toString(36) });
    if (asked.status !== 200 || ghost.status !== 200) notes.push("tv ask: replies " + asked.status + "/" + ghost.status);
    if (JSON.stringify(Object.keys(asked.body).sort()) !== JSON.stringify(Object.keys(ghost.body).sort()) || asked.body.sent !== ghost.body.sent) notes.push("tv ask: reply differs for a missing name");

    // 2. The account's notifications show the request; Approve signs the TV in.
    if (!(await tvNotes(page, tv.code))) { notes.push("tv ask: no Approve sign-in on TV? notification"); return notes; }
    const row = await page.locator(`[data-tvn='${tv.code}']`).innerText();
    if (!/Approve sign-in on TV\?/.test(row) || row.replace(/\s/g, "").indexOf(tv.code) < 0) notes.push("tv ask: notification does not show the code");
    if (shots) { await page.waitForTimeout(500); await page.screenshot({ mask: [page.getByText(/^@[a-z0-9_.]+$/)], path: path.join(shots, "phone-approve-notification.png") }); }
    await page.locator(`[data-tvn='${tv.code}'] [data-tvnote='approve']`).click();
    await page.getByText("Approved. Your TV is signing in.").waitFor({ timeout: 15000 });
    const signed = await tvWorker("/v1/tv-pair/poll", { poll: tv.poll });
    if (signed.status !== 200 || !signed.body.token) notes.push("tv ask: approve did not sign the TV in (" + signed.status + ")");

    // 3. Deny: the TV hears "denied" and the code is gone.
    tv = (await tvWorker("/v1/tv-pair/start")).body;
    await tvWorker("/v1/tv-pair/ask", { poll: tv.poll, username: handle });
    if (!(await tvNotes(page, tv.code))) { notes.push("tv ask: second request missing"); return notes; }
    await page.locator(`[data-tvn='${tv.code}'] [data-tvnote='deny']`).click();
    await page.getByText("Denied. The TV was not signed in.").waitFor({ timeout: 15000 });
    const denied = await tvWorker("/v1/tv-pair/poll", { poll: tv.poll });
    if (denied.status !== 403 || denied.body.error !== "denied") notes.push("tv ask: deny was not passed to the TV (" + denied.status + ")");

    // 4. Desktop: Settings > Link a TV, a big box, paste with a dash, no button press.
    await page.setViewportSize({ width: 1280, height: 800 });
    tv = (await tvWorker("/v1/tv-pair/start")).body;
    await openPage(page, "/#/link-tv");
    await page.locator("[data-tvpair-form] input[name=code]").waitFor({ timeout: 15000 });
    const size = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector("[data-tvpair-form] input[name=code]")).fontSize));
    if (!(size >= 40)) notes.push("link a tv: the code box is small on desktop (" + size + "px)");
    await page.locator("[data-tvpair-form] input[name=code]").click();
    await page.keyboard.type(tv.code.slice(0, 3).toLowerCase());
    if (shots) { await page.waitForTimeout(500); await page.screenshot({ mask: [page.getByText(/^@[a-z0-9_.]+$/)], path: path.join(shots, "desktop-link-tv.png") }); }
    await page.evaluate((text) => {
      const input = document.querySelector("[data-tvpair-form] input[name=code]");
      const data = new DataTransfer();
      data.setData("text/plain", text);
      input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, " " + tv.code.slice(0, 3).toLowerCase() + "-" + tv.code.slice(3) + " ");
    await page.locator("[data-tvp-phone='done']").waitFor({ timeout: 15000 });
    if (shots) { await page.waitForTimeout(500); await page.screenshot({ mask: [page.getByText(/^@[a-z0-9_.]+$/)], path: path.join(shots, "desktop-link-tv-done.png") }); }
    const linked = await tvWorker("/v1/tv-pair/poll", { poll: tv.poll });
    if (linked.status !== 200) notes.push("link a tv: pasted code did not sign the TV in (" + linked.status + ")");

    // 5. viktorychapp.pages.dev/tv on a PC: typing the 6th character goes on.
    tv = (await tvWorker("/v1/tv-pair/start")).body;
    await openPage(page, "/tv/");
    await page.locator("#pair-code").waitFor({ timeout: 15000 });
    await page.locator("#pair-code").click();
    await page.keyboard.type(tv.code.slice(0, 3).toLowerCase() + "-" + tv.code.slice(3, 5));
    if (shots) { await page.waitForTimeout(500); await page.screenshot({ mask: [page.getByText(/^@[a-z0-9_.]+$/)], path: path.join(shots, "desktop-tv-code-box.png") }); }
    await page.keyboard.type(tv.code.slice(5));
    const went = await page.waitForFunction((code) => location.href.indexOf("pair=" + code) >= 0 || location.hash.indexOf("code=" + code) >= 0, tv.code, { timeout: 15000 }).then(() => true, () => false);
    if (!went) notes.push("/tv code box did not go on after 6 characters");
    notes.push(...problems.map((p) => "tv ask pageerror: " + p.slice(0, 180)));
  } catch (err) {
    notes.push("tv ask flow failed: " + redact(err && err.stack || err).slice(0, 1200));
  } finally {
    await context.close();
  }
  return notes;
}

const server = await startServer();
worker = new Miniflare({
  scriptPath: path.join(root, "worker/src/index.js"),
  modules: true,
  modulesRoot: root,
  modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
  bindings: {
    ACCOUNT_PEPPER: "local-test-pepper",
    SIGNUP_GUARD: "on",
    OWNER_CLAIM_CODE: "local-test-claim",
    OWNER_HANDLE: "fixtureowner",
    ALLOWED_ORIGINS: pageOrigin,
    PBKDF2_ITERATIONS: "1000"
  },
  d1Databases: ["DB"],
  r2Buckets: ["DATA"],
  compatibilityDate: "2026-01-15",
  log: new Log(LogLevel.NONE)
});
const bindings = await worker.getBindings();
await bindings.DATA.put("feeds.json", JSON.stringify({
  updated: "2026-01-01T00:00:00Z", preview: true,
  feeds: [
    { id: "x:example", platform: "x", handle: "example", name: "Example", configured: true },
    { id: "x:sample", platform: "x", handle: "sample", name: "Sample", configured: true }
  ],
  posts: []
}));
const browser = await launch();
const failures = [];
try {
  for (const viewport of process.env.ONLY ? [] : VIEWPORTS) {
    const { context, page, problems } = await openFresh(browser, viewport);
    try {
      const ms = await gotoFresh(page);
      console.log(viewport.name + " " + viewport.width + "x" + viewport.height + " first-screen " + ms + "ms");
      if (ms > 8000) failures.push(viewport.name + ": first screen took " + ms + "ms");
      failures.push(...await layoutPass(page, viewport));
      if (viewport.name === "phone") failures.push(...await firstRun(page));
      failures.push(...problems.map((p) => viewport.name + " pageerror: " + p.slice(0, 180)));
    } catch (err) {
      failures.push(viewport.name + " failed: " + redact(err && err.stack || err).slice(0, 1200));
    } finally {
      await context.close();
    }
  }
  failures.push(...await tvAskFlow(browser));
  // The whole step flow at phone and desktop size, the quick path at both,
  // and both motion settings.
  const runs = [
    { name: "phone full", viewport: VIEWPORTS[0], run: fullFlow },
    { name: "desktop full", viewport: VIEWPORTS[3], run: fullFlow },
    { name: "phone quick", viewport: VIEWPORTS[0], run: quickFlow },
    { name: "phone temp", viewport: VIEWPORTS[0], run: tempFlow },
    { name: "desktop quick", viewport: VIEWPORTS[3], run: quickFlow },
    { name: "motion", viewport: VIEWPORTS[3], run: (page) => motionPass(page, false) },
    { name: "reduced motion", viewport: VIEWPORTS[0], reduced: true, run: (page) => motionPass(page, true) }
  ];
  for (const item of runs.filter((r) => !process.env.ONLY || process.env.ONLY.split(",").includes(r.name))) {
    // A renderer crash is the browser, not the app (seen once locally on a
    // busy machine); that run starts over once in a new context.
    for (let attempt = 0; attempt < 2; attempt++) {
      const { context, page, problems } = await openFresh(browser, item.viewport, item.reduced ? { reducedMotion: "reduce" } : {});
      let crashed = false;
      page.on("crash", () => { crashed = true; });
      try {
        await gotoFresh(page);
        const started = Date.now();
        failures.push(...await item.run(page, item.viewport));
        console.log(item.name + " " + item.viewport.width + "x" + item.viewport.height + " " + (Date.now() - started) + "ms");
        failures.push(...problems.map((p) => item.name + " pageerror: " + p.slice(0, 180)));
      } catch (err) {
        if (crashed && attempt === 0) { console.log(item.name + ": the page crashed, running it again"); continue; }
        failures.push(item.name + " failed: " + redact(err && err.stack || err).slice(0, 1200));
      } finally {
        await context.close().catch(() => {});
      }
      break;
    }
  }
} finally {
  await browser.close();
  server.close();
  await worker.dispose();
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("signup flow ok");

// Ride-along (workflow files are not edited): TV sign-in on the short address.
{
  const { spawnSync } = await import("node:child_process");
  const tvShort = spawnSync(process.execPath, [path.join(root, "scripts", "tv_short_pair_test.mjs")], { cwd: root, env: process.env, stdio: "inherit" });
  if (tvShort.status !== 0) process.exit(1);
}
