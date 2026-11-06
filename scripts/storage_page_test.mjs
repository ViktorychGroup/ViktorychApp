/* Storage page: one sidebar row, local age unlock, and playback when the browser can. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sharedStaticServer } from "./smoke_runtime.mjs";
import { BACKUP_RECIPIENT } from "../shared/storage-contract.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.env.STORAGE_SHOTS || "/opt/cursor/artifacts";

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
  if (file.endsWith(".mp4")) return "video/mp4";
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
        res.end();
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

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

async function shot(page, name) {
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, name), fullPage: false });
}

async function openStorage(page, port, hash) {
  await page.addInitScript(() => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({
      version: 1,
      initialized: true,
      appearance: "lightsout"
    }));
  });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1")) route.continue();
    else route.abort();
  });
  await page.goto("http://127.0.0.1:" + port + "/index.html" + hash, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#rec-root", { timeout: 20000 });
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const browser = await (await loadPlaywright()).launch({ headless: true, channel: "chrome" });
  const fixDir = path.join(root, "scripts/fixtures/vsr-playback-2");
  const identity = fs.readFileSync(path.join(fixDir, "TEST-ONLY-identity.txt"), "utf8").split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("AGE-SECRET-KEY-"));
  const filesB64 = {};
  for (const name of fs.readdirSync(path.join(fixDir, "package"))) {
    if (name.endsWith(".age")) filesB64[name] = b64(fs.readFileSync(path.join(fixDir, "package", name)));
  }
  try {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await desktop.newPage();
  const logs = [];
  const pageErrors = [];
  page.on("console", (msg) => logs.push(msg.text()));
  page.on("pageerror", (err) => pageErrors.push(String(err && err.stack || err)));
  await openStorage(page, port, "#/storage?preview=1");
  if (pageErrors.length) fail("page error " + pageErrors[0].slice(0, 500));
    const nav = await page.evaluate(() => {
      const links = [...document.querySelectorAll("header.nav a.nav-item[href='#/storage']")].filter((el) => el.getClientRects().length);
      const side = links[0];
      const path = side && side.querySelector("path") ? side.querySelector("path").getAttribute("d") : "";
      const labels = links.map((el) => (el.querySelector(".nav-label, .drawer-label") || el).textContent.trim());
      const recordingNav = [...document.querySelectorAll("a.nav-item, a.drawer-row")].filter((el) => (el.textContent || "").trim() === "Recordings");
      return {
        count: links.length,
        labels,
        path,
        heading: (document.querySelector(".drive h1") || {}).textContent || "",
        recorder: document.querySelector("[data-recorder-status]") ? document.querySelector("[data-recorder-status]").getAttribute("data-recorder-status") : "missing",
        rec: (document.querySelector("#rec-root") || { outerHTML: "" }).outerHTML.slice(0, 240),
        providers: [...document.querySelectorAll("[data-provider]")].map((el) => el.getAttribute("data-provider") + ":" + el.getAttribute("data-provider-state")),
        connect: [...document.querySelectorAll("#rec-root button")].map((el) => el.textContent.trim()).filter((text) => /connect/i.test(text)),
        vaultInRec: !!document.querySelector("#rec-root a[href='#/vault']"),
        kind: document.querySelector("[data-rec-kind]") ? document.querySelector("[data-rec-kind]").getAttribute("data-rec-kind") : "",
        note: document.querySelector(".rec-item .rec-note") ? document.querySelector(".rec-item .rec-note").textContent : ""
      };
    });
    if (nav.count !== 1) fail("storage sidebar count " + nav.count + " " + JSON.stringify(nav));
    if (nav.labels[0] !== "Storage") fail("sidebar label " + nav.labels.join("|"));
    if (!nav.path.startsWith("M12 5c3.2")) fail("storage icon is not the cloud");
    if (!nav.heading.includes("Storage")) fail("heading " + nav.heading);
    if (nav.recorder !== "unlinked") fail("recorder " + nav.recorder);
    const ready = await page.evaluate(() => ({
      recipient: document.querySelector("[data-ready=recipient]").getAttribute("data-ready-state"),
      value: document.querySelector("[data-backup-recipient]").getAttribute("data-backup-recipient"),
      identity: document.querySelector("[data-ready=identity]").getAttribute("data-ready-state"),
      provider: document.querySelector("[data-ready=provider]").getAttribute("data-ready-state"),
      catalog: document.querySelector("[data-ready=catalog]").getAttribute("data-ready-state")
    }));
    if (ready.recipient !== "ready" || ready.value !== BACKUP_RECIPIENT) fail("recipient " + JSON.stringify(ready));
    if (ready.identity !== "needed" || ready.provider !== "absent" || ready.catalog !== "local") fail("readiness " + JSON.stringify(ready));
    const browserUi = await page.evaluate(() => {
      const crumbs = document.querySelector(".drive-crumbs");
      const tree = document.querySelector(".drive-tree");
      const treeBox = tree ? tree.getBoundingClientRect() : { width: 0, height: 0 };
      const names = [...document.querySelectorAll(".drive-card, .drive-row")].map((el) => el.getAttribute("data-drive-name"));
      return {
        crumbs: crumbs ? crumbs.innerText.replace(/\s+/g, " ").trim() : "",
        tree: !!(treeBox.width > 20 && treeBox.height > 20),
        places: document.querySelector(".drive-places") ? getComputedStyle(document.querySelector(".drive-places")).display : "missing",
        names,
        grid: !!document.querySelector(".drive-grid"),
        recJump: [...document.querySelectorAll("[data-drive=show-recordings]")].map((el) => el.textContent.trim()),
        connect: [...document.querySelectorAll("button")].map((el) => el.textContent.trim()).filter((text) => /^connect/i.test(text))
      };
    });
    if (!browserUi.crumbs.includes("Storage")) fail("crumbs " + browserUi.crumbs);
    if (!browserUi.tree) fail("desktop folder tree hidden");
    if (browserUi.places !== "none") fail("places shown beside the tree " + browserUi.places);
    if (browserUi.names[0] !== "Maps") fail("root order " + browserUi.names.join(","));
    if (!browserUi.grid) fail("grid missing");
    if (browserUi.recJump.indexOf("Recordings") < 0) fail("recordings jump missing");
    if (browserUi.connect.length) fail("connect buttons " + browserUi.connect.join(","));
    await page.locator("[data-drive=list]").click();
    await page.waitForSelector(".drive-cols");
    await page.locator("[data-drive=sort][data-sort=size]").click();
    await page.waitForFunction(() => {
      const cols = document.querySelector(".drive-cols");
      return cols && cols.getAttribute("data-sort-field") === "size" && cols.getAttribute("data-sort-dir") === "desc";
    });
    const bySize = await page.locator(".drive-row").evaluateAll((els) => els.map((el) => el.getAttribute("data-drive-name")));
    if (bySize.join("|") !== "Maps|Clip.mp4|Shore.jpg|Voice.m4a|Brief.pdf|Notes.txt") fail("size sort " + bySize.join("|"));
    const sortState = await page.locator(".drive-cols").getAttribute("data-sort-field");
    if (sortState !== "size") fail("sort field " + sortState);
    await shot(page, "storage-desktop-list.png");
    await page.locator(".drive-tree a", { hasText: "Maps" }).click();
    await page.waitForFunction(() => {
      const crumbs = document.querySelector(".drive-crumbs");
      return crumbs && crumbs.textContent.indexOf("Maps") >= 0;
    });
    const folder = await page.evaluate(() => ({
      crumbs: document.querySelector(".drive-crumbs").innerText.replace(/\s+/g, " ").trim(),
      names: [...document.querySelectorAll(".drive-row")].map((el) => el.getAttribute("data-drive-name")),
      rec: !!document.querySelector("#rec-root")
    }));
    if (!folder.crumbs.includes("Maps")) fail("folder crumbs " + folder.crumbs);
    if (folder.names.join("|") !== "Coast|Legend.pdf") fail("folder rows " + folder.names.join("|"));
    if (folder.rec) fail("recordings followed into a folder");
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "storage-desktop-folder.png");
    await page.locator(".drive-tree a", { hasText: "Coast" }).click();
    await page.waitForFunction(() => {
      const crumbs = document.querySelector(".drive-crumbs");
      return crumbs && crumbs.textContent.indexOf("Coast") >= 0;
    });
    const emptyFolder = await page.locator(".drive-empty h2").innerText();
    if (emptyFolder !== "This folder is empty.") fail("empty folder " + emptyFolder);
    await page.locator(".drive-row, .drive-card").first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    await page.locator(".drive-tree a", { hasText: "My Drive" }).click();
    await page.waitForFunction(() => {
      const here = document.querySelector(".drive-crumbs .here");
      return here && here.textContent.trim() === "Storage" && location.hash.indexOf("folder/") < 0;
    });
    const notes = page.locator(".drive-row", { hasText: "Notes.txt" });
    await notes.waitFor();
    await notes.click({ button: "right" });
    await page.waitForSelector(".drive-modal");
    const menuText = await page.locator(".drive-modal").innerText();
    if (!/Download/.test(menuText) || !/Rename/.test(menuText) || !/Move/.test(menuText) || !/Delete/.test(menuText)) fail("menu " + menuText);
    await page.locator(".drive-modal [data-drive=dismiss]").first().click();
    await page.locator("[data-drive=sort][data-sort=name]").click();
    await page.locator("[data-drive=grid]").click();
    await page.waitForSelector(".drive-grid");
    await page.locator(".drive-tree [data-drive=show-recordings]").click();
    await page.locator("#rec-root").scrollIntoViewIfNeeded();
    await shot(page, "storage-desktop-recordings.png");
    await page.evaluate(() => window.scrollTo(0, 0));
    if (nav.providers.length) fail("provider rows " + nav.providers.join(","));
    if (nav.connect.length) fail("connect buttons");
    if (nav.vaultInRec) fail("vault mixed into storage");
    if (nav.kind) fail("example package " + nav.kind);
    const pageText = await page.locator("#rec-root").innerText();
    if (/Google Drive|OneDrive|Cryptomator|Telegram/.test(pageText)) fail("provider names on the page");
    if (nav.recordingNav && nav.recordingNav.length) fail("recordings became a sidebar tool");
    await page.locator("header.nav a.nav-item[href='#/storage']").first().scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "storage-desktop.png");

    const cryptoResult = await page.evaluate(async ({ identity, filesB64 }) => {
      function fromB64(text) {
        const bin = atob(text);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      const files = { "manifest.json": new TextEncoder().encode("{\"codec\":\"avc1.42E01E\"}") };
      Object.keys(filesB64).forEach(function (name) { files[name] = fromB64(filesB64[name]); });
      const age = await window.ViktorychRecordings.loadAge();
      const wrong = await age.generateX25519Identity();
      window.ViktorychRecordings.unlock(wrong);
      const wrongOut = await window.ViktorychRecordings.openPackage({ files: files });
      window.ViktorychRecordings.lock();
      const lockedOut = await window.ViktorychRecordings.openPackage({ files: files });
      window.ViktorychRecordings.unlock(identity);
      const opened = await window.ViktorychRecordings.openPackage({ files: files });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const mime = opened.manifest && opened.manifest.mime;
      const supported = !!(mime && window.MediaSource && MediaSource.isTypeSupported && MediaSource.isTypeSupported(mime));
      let play = { supported: supported, mime: mime, error: opened.error || "" };
      async function landed(seconds) {
        const video = document.getElementById("rec-video");
        if (!video) return { time: -1, index: -1, width: 0, ready: 0 };
        video.currentTime = seconds;
        await new Promise((resolve) => {
          video.addEventListener("seeked", () => resolve(), { once: true });
          setTimeout(resolve, 3000);
        });
        return { time: video.currentTime, index: window.ViktorychRecordings.fragmentIndex(), width: video.videoWidth, ready: video.readyState };
      }
      if (supported) {
        play = Object.assign(play, await window.ViktorychRecordings.playSegments());
        const video = document.getElementById("rec-video");
        await new Promise((resolve) => {
          if (video && video.readyState >= 2) resolve();
          else if (video) video.addEventListener("loadeddata", () => resolve(), { once: true });
          setTimeout(resolve, 4000);
        });
        play.start = { index: window.ViktorychRecordings.fragmentIndex(), width: video ? video.videoWidth : 0, ready: video ? video.readyState : 0 };
        play.at1 = await landed(1);
        play.at2 = await landed(2);
        play.telegram = document.querySelector("[data-telegram-getfile]") ? document.querySelector("[data-telegram-getfile]").getAttribute("data-telegram-getfile") : "";
      } else {
        play.plan = window.ViktorychRecordings.plan().mode;
      }
      const mediaName = Object.keys(files).find((name) => name !== "manifest.age" && name !== "manifest.json" && name.endsWith(".age"));
      const bad = files[mediaName].slice();
      bad[bad.length - 3] ^= 9;
      const tampered = Object.assign({}, files);
      tampered[mediaName] = bad;
      const tamper = await window.ViktorychRecordings.openPackage({ files: tampered });
      const recipient = await age.identityToRecipient(identity);
      const enc = new age.Encrypter();
      enc.addRecipient(recipient);
      const legacyCipher = new Uint8Array(await enc.encrypt(new TextEncoder().encode("hello storage")));
      const legacy = await window.ViktorychRecordings.openLegacy(legacyCipher, "note.age");
      const legacyBytes = await window.ViktorychRecordings.decryptLegacy();
      const legacyPlan = window.ViktorychRecordings.plan().mode;
      const withdrawn = await window.ViktorychRecordings.openPackage({ plainCatalog: "{\"v\":1,\"kind\":\"age-byte-chunks\"}" });
      const dump = JSON.stringify(localStorage) + JSON.stringify(sessionStorage);
      let idb = "";
      if (indexedDB.databases) {
        const dbs = await indexedDB.databases();
        idb = JSON.stringify(dbs.map((row) => row.name));
      }
      const shown = await window.ViktorychRecordings.openPackage({ files: files });
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (shown.manifest && shown.manifest.mime && window.MediaSource && MediaSource.isTypeSupported && MediaSource.isTypeSupported(shown.manifest.mime)) {
        await window.ViktorychRecordings.playSegments();
      }
      return {
        wrong: wrongOut.error,
        locked: lockedOut.error,
        mime: mime,
        invented: mime && mime.indexOf("avc1.42E01E") >= 0,
        tamper: tamper.error,
        legacy: legacy.legacy === true && legacyPlan === "legacy" && legacyBytes.bytes ? new TextDecoder().decode(legacyBytes.bytes) : (legacyBytes.error || legacyPlan),
        withdrawn: withdrawn.error,
        held: window.ViktorychRecordings.held(),
        leaked: dump.includes("AGE-SECRET-KEY-") || dump.includes("hello storage") || idb.includes("AGE-SECRET-KEY-"),
        play: play,
        recorder: document.querySelector("[data-recorder-status]").getAttribute("data-recorder-status"),
        telegram: play.telegram || "",
        openedFlag: !!(opened.manifest && opened.manifest.telegramGetFile)
      };
    }, { identity: identity, filesB64: filesB64 });
    if (cryptoResult.wrong !== "key") fail("wrong key " + cryptoResult.wrong);
    if (cryptoResult.locked !== "locked") fail("locked " + cryptoResult.locked);
    if (!cryptoResult.mime || cryptoResult.mime.indexOf("avc1.64000A") < 0 || cryptoResult.mime.indexOf("mp4a.40.2") < 0) fail("derived codec " + cryptoResult.mime);
    if (cryptoResult.mime.indexOf("42E01E") >= 0 || cryptoResult.mime.indexOf("not probed") >= 0) fail("invented codec " + cryptoResult.mime);
    if (cryptoResult.tamper !== "tamper") fail("tamper " + cryptoResult.tamper);
    if (cryptoResult.legacy !== "hello storage") fail("legacy " + cryptoResult.legacy);
    if (cryptoResult.withdrawn !== "withdrawn") fail("v1 " + cryptoResult.withdrawn);
    if (!cryptoResult.held) fail("identity was dropped before lock");
    if (cryptoResult.leaked) fail("plaintext persisted");
    if (cryptoResult.recorder !== "unlinked") fail("recorder status " + cryptoResult.recorder);
    if (!cryptoResult.play.supported || !cryptoResult.play.ok) fail("play failed " + JSON.stringify(cryptoResult.play));
    if (cryptoResult.play.start.index !== 0 || cryptoResult.play.start.width < 2) fail("start " + JSON.stringify(cryptoResult.play.start));
    if (cryptoResult.play.at1.index !== 1 || Math.abs(cryptoResult.play.at1.time - 1) > 0.3) fail("seek 1s " + JSON.stringify(cryptoResult.play.at1));
    if (cryptoResult.play.at2.index !== 2 || Math.abs(cryptoResult.play.at2.time - 2) > 0.3) fail("seek 2s " + JSON.stringify(cryptoResult.play.at2));
    if (cryptoResult.telegram !== "named") fail("telegram flag " + cryptoResult.telegram + " opened " + cryptoResult.openedFlag);
    if (await page.locator("[data-ready=provider]").getAttribute("data-ready-state") !== "absent") fail("provider became connected");
    if (logs.some((line) => line.includes("AGE-SECRET-KEY-") || line.includes("hello storage"))) fail("logged secret");
    console.log("playback " + JSON.stringify(cryptoResult.play));
    await page.locator("header.nav a.nav-item[href='#/storage']").first().scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const video = document.getElementById("rec-video");
      if (video) video.scrollIntoView({ block: "center", inline: "nearest" });
    });
    await shot(page, "storage-desktop-playing.png");
    const locked = await page.evaluate(() => {
      window.ViktorychRecordings.lock();
      return window.ViktorychRecordings.held();
    });
    if (locked) fail("identity stayed after lock");

    await page.evaluate(() => {
      localStorage.setItem("viktorychapp-server-off", JSON.stringify(["storage_recordings"]));
    });
    await page.goto("http://127.0.0.1:" + port + "/index.html#/drive?preview=1", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => location.hash.startsWith("#/storage"), null, { timeout: 10000 });
    await page.waitForSelector(".drive-grid, .drive-list, .drive-empty", { timeout: 15000 });
    const off = await page.evaluate(() => ({
      hash: location.hash,
      rec: !!document.querySelector("#rec-root"),
      files: !!document.querySelector(".drive")
    }));
    if (!off.hash.startsWith("#/storage")) fail("drive redirect " + off.hash);
    if (off.rec) fail("recordings stayed on when switched off");
    if (!off.files) fail("drive files disappeared");
    await desktop.close();

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mobile = await phone.newPage();
    await openStorage(mobile, port, "#/storage?preview=1");
    const phoneNav = await mobile.evaluate(() => {
      const tree = document.querySelector(".drive-tree");
      const treeBox = tree ? tree.getBoundingClientRect() : { width: 0 };
      const places = document.querySelector(".drive-places");
      return {
        heading: (document.querySelector(".drive h1") || {}).textContent || "",
        tree: treeBox.width,
        places: places ? getComputedStyle(places).display : "missing",
        crumbs: document.querySelector(".drive-crumbs") ? document.querySelector(".drive-crumbs").innerText : "",
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    if (!phoneNav.heading.includes("Storage")) fail("phone heading " + phoneNav.heading);
    if (phoneNav.tree > 0) fail("phone tree width " + phoneNav.tree);
    if (phoneNav.places === "none") fail("phone places hidden");
    if (!phoneNav.crumbs.includes("Storage")) fail("phone crumbs " + phoneNav.crumbs);
    if (phoneNav.overflow > 2) fail("phone overflow " + phoneNav.overflow);
    await shot(mobile, "storage-mobile.png");
    await mobile.locator("[data-drive=list]").click();
    await mobile.waitForSelector(".drive-row");
    const phoneCols = await mobile.evaluate(() => {
      const when = document.querySelector(".drive-col-when");
      const box = when ? when.getBoundingClientRect() : { width: 0, height: 0 };
      return { width: box.width, height: box.height, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    if (phoneCols.width > 0 && phoneCols.height > 0) fail("phone modified column " + JSON.stringify(phoneCols));
    if (phoneCols.overflow > 2) fail("phone list overflow " + phoneCols.overflow);
    await shot(mobile, "storage-mobile-list.png");
    await mobile.locator(".drive-places [data-drive=show-recordings]").click();
    await mobile.locator("#rec-root").scrollIntoViewIfNeeded();
    const phoneRec = await mobile.evaluate(() => ({
      provider: document.querySelector("[data-ready=provider]").getAttribute("data-ready-state"),
      recorder: document.querySelector("[data-recorder-status]").getAttribute("data-recorder-status")
    }));
    if (phoneRec.provider !== "absent" || phoneRec.recorder !== "unlinked") fail("phone provider " + JSON.stringify(phoneRec));
    await shot(mobile, "storage-mobile-recordings.png");
    await phone.close();
    console.log("storage page ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
