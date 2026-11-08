/* Desktop Copy image: full picture versus the thumbnail, PNG pixels, and the
   original file bytes. The clipboard mock is not a Windows clipboard. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL, fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const copy = require("../image-copy.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function chunk(tag, data) {
  const body = Buffer.concat([tag, data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

function png(width, height, pixels) {
  const raw = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);
    for (let x = 0; x < width; x++) raw.push(...pixels[y * width + x]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const body = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk(Buffer.from("IHDR"), ihdr),
    chunk(Buffer.from("IDAT"), zlib.deflateSync(Buffer.from(raw))),
    chunk(Buffer.from("IEND"), Buffer.alloc(0))
  ]);
  return body;
}

const fullPng = png(4, 2, [
  [255, 0, 0, 128], [0, 255, 0, 255], [0, 0, 255, 255], [0, 0, 0, 0],
  [255, 255, 255, 255], [255, 255, 255, 255], [255, 255, 255, 255], [255, 255, 255, 255]
]);
const thumbPng = png(1, 1, [[255, 0, 0, 255]]);
const fullHash = createHash("sha256").update(fullPng).digest("hex");
const waiting = [];
function releaseHold() {
  waiting.splice(0).forEach((res) => {
    try {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(fullPng);
    } catch (err) { /* the browser already aborted */ }
  });
}

test("a Twitter small picture upgrades to the original, not the large display size", () => {
  const small = "https://pbs.twimg.com/media/AbC.jpg?format=jpg&name=small";
  const list = copy.originalCandidates({ src: small, source: small.replace("name=small", "name=large") });
  assert.equal(list[0], "https://pbs.twimg.com/media/AbC.jpg?format=jpg&name=orig");
  assert.equal(list.includes(small), false);
});

test("a YouTube thumbnail selects the largest still and is not called the original file", () => {
  const hq = "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg";
  const picked = copy.plan({ src: hq });
  assert.equal(picked.originals.length, 0);
  assert.equal(picked.downloadOriginal, false);
  assert.equal(picked.sized[0].url, "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg");
  assert.equal(picked.label, "listed");
});

test("a fallback address is not treated as the original file", () => {
  const record = { src: "https://cdn.test/thumb.png", currentSrc: "https://cdn.test/thumb.png", source: "https://cdn.test/full.png" };
  const picked = copy.plan(record);
  assert.equal(picked.originals.length, 0);
  assert.equal(picked.label, "displayed");
  assert.equal(copy.copyOrder(record).includes("https://cdn.test/full.png"), false);
});

test("a srcset width picks 2048 over an earlier 320, and an unknown proxy is not an original", () => {
  const sized = copy.sizedCandidates({ srcset: "https://cdn.test/a.jpg 320w, https://cdn.test/b.jpg 2048w" });
  assert.deepEqual(sized.map((row) => row.width), [2048, 320]);
  assert.equal(sized[0].url, "https://cdn.test/b.jpg");
  const flipped = copy.copyOrder({ srcset: "https://cdn.test/a.jpg 320w, https://cdn.test/b.jpg 2048w" });
  assert.equal(flipped[0], "https://cdn.test/b.jpg");
  assert.deepEqual(copy.copyOrder({
    original: "https://cdn.test/orig.png",
    srcset: "https://cdn.test/a.jpg 320w, https://cdn.test/b.jpg 2048w"
  }), ["https://cdn.test/orig.png", "https://cdn.test/b.jpg", "https://cdn.test/a.jpg"]);
  const proxy = copy.plan({ src: "https://app.test/v1/media?url=https://cdn.test/pic.jpg" });
  assert.equal(proxy.label, "displayed");
  assert.equal(proxy.downloadOriginal, false);
  assert.equal(proxy.originals.length, 0);
});

test("a url that is not on the picture is refused, including another private view and a built proxy", () => {
  const record = { src: "https://app.test/v1/media/view/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  assert.equal(copy.allowedUrl(record, record.src), true);
  assert.equal(copy.allowedUrl(record, "https://app.test/v1/media/view/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), false);
  assert.equal(copy.allowedUrl(record, "https://app.test/v1/media?url=https://evil.test/a.png"), false);
  assert.equal(copy.allowedUrl({ src: "javascript:alert(1)" }, "javascript:alert(1)"), false);
  assert.equal(copy.originalCandidates({ src: "https://evil.test/a.jpg?name=small" }).some((url) => url.includes("/v1/media")), false);
});

test("cross-origin fetches send no cookies and no account token", () => {
  const plan = copy.fetchPlan("https://cdn.test/full.png", "https://app.test/");
  assert.equal(plan.credentials, "omit");
  assert.equal(plan.auth, false);
  const local = copy.fetchPlan("https://app.test/full.png", "https://app.test/home");
  assert.equal(local.credentials, "include");
  assert.equal(local.auth, false);
});

async function browserProof() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/full.png") {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      return res.end(fullPng);
    }
    if (url.pathname === "/thumb.png") {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      return res.end(thumbPng);
    }
    if (url.pathname === "/bad.png") {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      return res.end(Buffer.from("not-a-png"));
    }
    if (url.pathname === "/hold.png") {
      waiting.push(res);
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta charset="utf-8"><title>copy</title>
        <style>img{width:20px;height:10px}</style>
        <div class="media"><div class="tile"><img id="photo" alt="" src="/thumb.png" data-original="/full.png"></div></div>
        <div class="media"><div class="tile"><a id="link" href="/full.png"><img id="linked" alt="" src="/full.png"></a></div></div>
        <script src="/image-copy.js"></script>`);
    }
    const file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      const type = file.endsWith(".css") ? "text/css" : "text/javascript";
      res.writeHead(200, { "content-type": type + "; charset=utf-8" });
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const spec = process.env.PLAYWRIGHT_CORE;
  const mod = await import(pathToFileURL(spec).href);
  const browser = await (mod.chromium || mod.default.chromium).launch({ headless: true, channel: "chrome" });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
    await context.addInitScript(() => {
      window.__copies = [];
      window.__texts = [];
      navigator.clipboard.write = async (items) => {
        const item = items[0];
        const type = item.types[0];
        const blob = await item.getType(type);
        window.__copies.push({ type: type, size: blob.size, blob: blob });
      };
      navigator.clipboard.writeText = async (text) => { window.__texts.push(String(text)); };
    });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("photo").complete);
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    const box = await page.locator("#photo").boundingBox();
    await page.mouse.click(box.x + 4, box.y + 4, { button: "right" });
    const menuBox = await page.locator(".image-copy-menu").boundingBox();
    if (!menuBox || Math.abs(menuBox.x - (box.x + 4)) > 24 || Math.abs(menuBox.y - (box.y + 4)) > 24) {
      throw new Error("menu left the pointer " + JSON.stringify({ box, menuBox }));
    }
    const note = await page.locator(".image-copy-note").innerText();
    if (note.indexOf("not the original file") < 0) throw new Error("note hid the PNG limit " + note);
    await page.locator(".image-copy-menu button", { hasText: "Copy image" }).click();
    await page.waitForFunction(() => window.__copies.length === 1);
    const pixels = await page.evaluate(async () => {
      const item = window.__copies[0];
      const bmp = await createImageBitmap(item.blob);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      return {
        type: item.type,
        width: bmp.width,
        height: bmp.height,
        red: Array.from(ctx.getImageData(0, 0, 1, 1).data),
        clear: Array.from(ctx.getImageData(3, 0, 1, 1).data),
        texts: window.__texts.slice()
      };
    });
    if (pixels.type !== "image/png" || pixels.width !== 4 || pixels.height !== 2) throw new Error("clipboard was not the full PNG " + JSON.stringify(pixels));
    if (pixels.red[0] !== 255 || pixels.red[3] < 100 || pixels.red[3] > 160) throw new Error("alpha pixel lost " + JSON.stringify(pixels));
    if (pixels.clear[3] !== 0) throw new Error("transparent pixel became solid " + JSON.stringify(pixels));
    if (pixels.texts.length) throw new Error("copy wrote text " + JSON.stringify(pixels.texts));
    await page.evaluate(() => {
      window.ViktorychAccounts = {
        gen: 1,
        id: "100000000001",
        sessionGeneration() { return this.gen; },
        account() { return { publicId: this.id }; }
      };
      window.ViktorychAccounts.gen = 2;
    });
    const kept = await page.evaluate(() => window.__copies.length);
    if (kept !== 1) throw new Error("a finished copy was treated as something the page can undo");
    await page.evaluate(() => {
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => { window.__download = blob; return orig.call(URL, blob); };
    });
    await page.locator(".image-copy-menu button", { hasText: "Download original" }).click();
    await page.waitForFunction(() => window.__download);
    const saved = await page.evaluate(async () => {
      const buf = await window.__download.arrayBuffer();
      const hash = await crypto.subtle.digest("SHA-256", buf);
      const hex = Array.from(new Uint8Array(hash)).map((n) => n.toString(16).padStart(2, "0")).join("");
      return { type: window.__download.type, size: buf.byteLength, hex: hex };
    });
    if (saved.type !== "image/png" || saved.size !== fullPng.length || saved.hex !== fullHash) {
      throw new Error("download changed the original bytes " + JSON.stringify(saved));
    }
    await page.evaluate(() => {
      document.getElementById("photo").dataset.original = "/missing.png";
      window.__copies.length = 0;
    });
    await page.locator(".image-copy-menu button", { hasText: "Copy image" }).click();
    await page.waitForFunction(() => document.querySelector(".image-copy-note").textContent.indexOf("did not load") >= 0);
    const failed = await page.evaluate(() => ({ copies: window.__copies.length, texts: window.__texts.length }));
    if (failed.copies || failed.texts) throw new Error("failed copy still wrote the clipboard " + JSON.stringify(failed));
    await page.locator(".image-copy-menu button", { hasText: "Download original" }).click();
    await page.waitForFunction(() => document.querySelector(".image-copy-note").textContent.indexOf("did not load") >= 0);
    const downloadFailed = await page.evaluate(() => ({ note: document.querySelector(".image-copy-note").textContent, copies: window.__copies.length }));
    if (downloadFailed.copies || downloadFailed.note.indexOf("Saves the original") >= 0) throw new Error("a failed download was called a saved original " + JSON.stringify(downloadFailed));
    await page.evaluate(() => {
      const img = document.getElementById("photo");
      img.dataset.original = "/missing.png";
      img.setAttribute("srcset", "/full.png 2048w, /thumb.png 320w");
      window.__copies.length = 0;
    });
    await page.locator(".image-copy-menu button", { hasText: "Copy image" }).click();
    await page.waitForFunction(() => document.querySelector(".image-copy-note").textContent.indexOf("did not load") >= 0);
    const silent = await page.evaluate(() => window.__copies.length);
    if (silent) throw new Error("a failed original silently copied a smaller picture");
    await page.locator("[data-act='image-copy-listed']").click();
    await page.waitForFunction(() => window.__copies.length === 1);
    const listed = await page.evaluate(async () => {
      const bmp = await createImageBitmap(window.__copies[0].blob);
      return { width: bmp.width, height: bmp.height, note: document.querySelector(".image-copy-note").textContent };
    });
    if (listed.width !== 4 || listed.height !== 2) throw new Error("the listed picture was not the 2048 file " + JSON.stringify(listed));
    if (listed.note.indexOf("largest listed") < 0 || listed.note.indexOf("Copied the picture") >= 0) throw new Error("the smaller file was labeled as the full original " + listed.note);
    await page.evaluate(() => {
      const img = document.getElementById("photo");
      img.removeAttribute("srcset");
      img.src = "/thumb.png?shown=1";
      window.__copies.length = 0;
    });
    await page.locator("[data-act='image-copy-screen']").click();
    await page.waitForFunction(() => window.__copies.length === 1);
    const screen = await page.evaluate(async () => {
      const bmp = await createImageBitmap(window.__copies[0].blob);
      return { width: bmp.width, height: bmp.height, note: document.querySelector(".image-copy-note").textContent };
    });
    if (screen.width !== 1 || screen.height !== 1) throw new Error("on-screen copy was not the thumbnail " + JSON.stringify(screen));
    if (screen.note.indexOf("not the full file") < 0) throw new Error("on-screen copy was labeled as the full file");
    const beforePermission = await page.evaluate(() => window.__copies.length);
    await page.evaluate(() => {
      window.__write = navigator.clipboard.write;
      navigator.clipboard.write = function () {
        return Promise.reject(new DOMException("denied", "NotAllowedError"));
      };
      document.getElementById("photo").dataset.original = "/full.png";
    });
    await page.locator(".image-copy-menu button", { hasText: "Copy image" }).click();
    await page.waitForFunction(() => {
      const text = document.querySelector(".image-copy-note").textContent;
      return text.indexOf("permission") >= 0;
    });
    const denied = await page.evaluate(() => ({
      copies: window.__copies.length,
      texts: window.__texts.length,
      note: document.querySelector(".image-copy-note").textContent
    }));
    if (denied.copies !== beforePermission || denied.texts.length) throw new Error("permission denial wrote the clipboard " + JSON.stringify(denied));
    if (denied.note.indexOf("did not load") >= 0 || denied.note.indexOf("Copied the picture") >= 0) throw new Error("permission denial was described as a failed or finished copy " + denied.note);
    await page.evaluate(() => { navigator.clipboard.write = undefined; });
    await page.locator(".image-copy-menu button", { hasText: "Copy image" }).click();
    await page.waitForFunction(() => document.querySelector(".image-copy-note").textContent.indexOf("cannot copy") >= 0);
    const unsupported = await page.evaluate(() => document.querySelector(".image-copy-note").textContent);
    if (unsupported.indexOf("did not load") >= 0 || unsupported.indexOf("Copied") >= 0) throw new Error("unsupported clipboard was called a failed load or a finished copy " + unsupported);
    await page.evaluate(() => { navigator.clipboard.write = window.__write; });
    await page.evaluate(() => {
      navigator.clipboard.write = window.__write;
      window.__copies.length = 0;
      document.getElementById("photo").dataset.original = "/bad.png";
    });
    await page.locator(".image-copy-menu button", { hasText: "Copy image" }).click();
    await page.waitForFunction(() => document.querySelector(".image-copy-note").textContent.indexOf("could not be read") >= 0);
    const unread = await page.evaluate(() => ({ copies: window.__copies.length, note: document.querySelector(".image-copy-note").textContent }));
    if (unread.copies || unread.note.indexOf("Copied") >= 0) throw new Error("a picture that could not be read was called copied " + JSON.stringify(unread));
    await page.evaluate(() => {
      window.ViktorychAccounts = {
        gen: 1,
        id: "100000000001",
        sessionGeneration() { return this.gen; },
        account() { return { publicId: this.id }; }
      };
      window.__clicks = 0;
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { window.__clicks += 1; return click.apply(this, arguments); };
      document.getElementById("photo").dataset.original = "/hold.png";
      window.__copies.length = 0;
    });
    await page.locator(".image-copy-menu button", { hasText: "Download original" }).click();
    await new Promise((resolve) => {
      const start = Date.now();
      const tick = () => { if (waiting.length || Date.now() - start > 2000) resolve(); else setTimeout(tick, 20); };
      tick();
    });
    await page.evaluate(() => {
      window.ViktorychAccounts.gen = 2;
      window.ViktorychAccounts.id = "100000000002";
      window.dispatchEvent(new Event("viktorych-session"));
    });
    releaseHold();
    await page.waitForTimeout(250);
    const switched = await page.evaluate(() => ({ clicks: window.__clicks, copies: window.__copies.length, menu: !!document.querySelector(".image-copy-menu") }));
    if (switched.clicks || switched.copies || switched.menu) throw new Error("a switched account still received the picture " + JSON.stringify(switched));
    await page.evaluate(() => {
      window.ViktorychAccounts.gen = 3;
      window.ViktorychAccounts.id = "100000000003";
      document.getElementById("photo").dataset.original = "/hold.png";
      window.__copies.length = 0;
    });
    const again = await page.locator("#photo").boundingBox();
    await page.mouse.click(again.x + 4, again.y + 4, { button: "right" });
    await page.locator(".image-copy-menu button", { hasText: "Copy image" }).click();
    await new Promise((resolve) => {
      const start = Date.now();
      const tick = () => { if (waiting.length || Date.now() - start > 2000) resolve(); else setTimeout(tick, 20); };
      tick();
    });
    await page.evaluate(() => { location.hash = "#/left"; });
    releaseHold();
    await page.waitForTimeout(250);
    const left = await page.evaluate(() => ({ copies: window.__copies.length, menu: !!document.querySelector(".image-copy-menu") }));
    if (left.copies || left.menu) throw new Error("leaving the page still copied the picture " + JSON.stringify(left));
    await page.evaluate(() => {
      window.ViktorychAccounts.gen = 4;
      window.ViktorychAccounts.id = "100000000001";
      const img = document.getElementById("photo");
      img.removeAttribute("srcset");
      img.dataset.original = "/full.png";
      window.__copies.length = 0;
      window.__realBitmap = window.createImageBitmap.bind(window);
      window.createImageBitmap = function (blob) {
        return new Promise((resolve, reject) => {
          window.__releaseDecode = () => window.__realBitmap(blob).then(resolve, reject);
        });
      };
    });
    const decodeBox = await page.locator("#photo").boundingBox();
    await page.mouse.click(decodeBox.x + 4, decodeBox.y + 4, { button: "right" });
    await page.locator(".image-copy-menu button", { hasText: "Copy image" }).click();
    await page.waitForFunction(() => typeof window.__releaseDecode === "function");
    await page.evaluate(() => {
      window.ViktorychAccounts.gen = 5;
      window.dispatchEvent(new Event("viktorych-session"));
      window.__releaseDecode();
    });
    await page.waitForTimeout(250);
    const decoded = await page.evaluate(() => window.__copies.length);
    if (decoded) throw new Error("a same-account generation change during decode still copied");
    await page.evaluate(() => { window.createImageBitmap = window.__realBitmap; });
    await page.evaluate(() => {
      window.ViktorychAccounts.gen = 6;
      window.ViktorychAccounts.id = "100000000001";
      document.getElementById("photo").dataset.original = "/hold.png";
      window.__copies.length = 0;
    });
    const abaBox = await page.locator("#photo").boundingBox();
    await page.mouse.click(abaBox.x + 4, abaBox.y + 4, { button: "right" });
    await page.locator(".image-copy-menu button", { hasText: "Copy image" }).click();
    await new Promise((resolve) => {
      const start = Date.now();
      const tick = () => { if (waiting.length || Date.now() - start > 2000) resolve(); else setTimeout(tick, 20); };
      tick();
    });
    await page.evaluate(() => {
      window.ViktorychAccounts.gen = 7;
      window.ViktorychAccounts.id = "100000000002";
      window.ViktorychAccounts.gen = 8;
      window.ViktorychAccounts.id = "100000000001";
      window.dispatchEvent(new Event("viktorych-session"));
    });
    releaseHold();
    await page.waitForTimeout(250);
    const aba = await page.evaluate(() => window.__copies.length);
    if (aba) throw new Error("an older generation copied after the account id returned");
    await page.evaluate(() => {
      window.ViktorychAccounts.gen = 9;
      document.getElementById("photo").dataset.original = "/hold.png";
      window.__copies.length = 0;
    });
    const hideBox = await page.locator("#photo").boundingBox();
    await page.mouse.click(hideBox.x + 4, hideBox.y + 4, { button: "right" });
    await page.locator(".image-copy-menu button", { hasText: "Copy image" }).click();
    await new Promise((resolve) => {
      const start = Date.now();
      const tick = () => { if (waiting.length || Date.now() - start > 2000) resolve(); else setTimeout(tick, 20); };
      tick();
    });
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    releaseHold();
    await page.waitForTimeout(250);
    const hidden = await page.evaluate(() => ({ copies: window.__copies.length, menu: !!document.querySelector(".image-copy-menu") }));
    if (hidden.copies || hidden.menu) throw new Error("hiding the page still copied the picture " + JSON.stringify(hidden));
    const linked = await page.evaluate(() => {
      const img = document.getElementById("linked");
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 });
      img.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, menu: !!document.querySelector(".image-copy-menu") };
    });
    if (linked.prevented || linked.menu) throw new Error("a linked picture lost the browser menu " + JSON.stringify(linked));
    await page.evaluate(() => localStorage.setItem("viktorychapp-server-off", JSON.stringify(["image_copy"])));
    const off = await page.evaluate(() => {
      const img = document.getElementById("photo");
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 30 });
      img.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, menu: !!document.querySelector(".image-copy-menu") };
    });
    if (off.prevented || off.menu) throw new Error("the switch off still replaced the browser menu " + JSON.stringify(off));
    await context.close();
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", hasTouch: true });
    const narrow = await phone.newPage();
    await narrow.goto("http://127.0.0.1:" + port + "/", { waitUntil: "domcontentloaded" });
    const native = await narrow.evaluate(() => {
      const img = document.getElementById("photo");
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 8, clientY: 8 });
      img.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, menu: !!document.querySelector(".image-copy-menu"), owns: window.ViktorychImageCopy.owns(img) };
    });
    if (native.prevented || native.menu || native.owns) throw new Error("phone picture menu changed " + JSON.stringify(native));
    await phone.close();
    console.log("image copy browser ok");
  } finally {
    await browser.close();
    server.close();
  }
}

test("browser: full PNG pixels, original bytes, failure, phone menu, and page scale", browserProof);
