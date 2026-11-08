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

test("a Twitter small picture upgrades to the original, not the large display size", () => {
  const small = "https://pbs.twimg.com/media/AbC.jpg?format=jpg&name=small";
  const list = copy.originalCandidates({ src: small, source: small.replace("name=small", "name=large") });
  assert.equal(list[0], "https://pbs.twimg.com/media/AbC.jpg?format=jpg&name=orig");
  assert.equal(list.includes(small), false);
});

test("a YouTube thumbnail upgrades to the largest still of the same video", () => {
  const hq = "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg";
  const list = copy.originalCandidates({ src: hq });
  assert.equal(list[0], "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg");
  assert.equal(list.includes(hq), false);
});

test("the full file listed beside a thumbnail is chosen over the picture on screen", () => {
  const record = { src: "https://cdn.test/thumb.png", currentSrc: "https://cdn.test/thumb.png", source: "https://cdn.test/full.png" };
  assert.equal(copy.originalCandidates(record)[0], "https://cdn.test/full.png");
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
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta charset="utf-8"><title>copy</title>
        <style>img{width:20px;height:10px}</style>
        <div class="media"><div class="tile"><img id="photo" alt="" src="/thumb.png" data-source="/full.png"></div></div>
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
      document.getElementById("photo").dataset.source = "/missing.png";
      window.__copies.length = 0;
    });
    await page.locator(".image-copy-menu button", { hasText: "Copy image" }).click();
    await page.waitForFunction(() => document.querySelector(".image-copy-note").textContent.indexOf("did not load") >= 0);
    const failed = await page.evaluate(() => ({ copies: window.__copies.length, texts: window.__texts.length }));
    if (failed.copies || failed.texts) throw new Error("failed copy still wrote the clipboard " + JSON.stringify(failed));
    await page.locator("[data-act='image-copy-screen']").click();
    await page.waitForFunction(() => window.__copies.length === 1);
    const screen = await page.evaluate(async () => {
      const bmp = await createImageBitmap(window.__copies[0].blob);
      return { width: bmp.width, height: bmp.height, note: document.querySelector(".image-copy-note").textContent };
    });
    if (screen.width !== 1 || screen.height !== 1) throw new Error("on-screen copy was not the thumbnail " + JSON.stringify(screen));
    if (screen.note.indexOf("not the full file") < 0) throw new Error("on-screen copy was labeled as the full file");
    await page.keyboard.press("Escape");
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
