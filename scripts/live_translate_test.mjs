import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/* Live Translate in a real browser. Google is stubbed: the Gemini Live
   socket gets the setup and 16 kHz PCM and answers with 24 kHz speech and a
   transcript; the fallback runs Speech-to-Text, Translation and
   Text-to-Speech. Checks subtitles, ducking, limits, cross-origin media and
   the settings page. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-key-0000";

function fail(message) {
  console.error("FAIL: " + message);
  process.exitCode = 1;
  throw new Error(message);
}
function wav(seconds, rate, channels, toneSeconds) {
  const frames = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + frames * channels * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + frames * channels * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * channels * 2, 28); buf.writeUInt16LE(channels * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(frames * channels * 2, 40);
  for (let i = 0; i < frames; i++) {
    const v = i / rate < toneSeconds ? Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 12000) : 0;
    for (let c = 0; c < channels; c++) buf.writeInt16LE(v, 44 + (i * channels + c) * 2);
  }
  return buf;
}
const TONE = wav(8, 48000, 2, 2);
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/live-translate.css"></head>
<body style="margin:0;min-height:1200px"><div id="toast" hidden></div><audio id="a" src="/tone.wav" loop></audio><audio id="x" loop></audio><div id="box"></div>
<script src="/live-translate.js"></script></body></html>`;

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  return mod.chromium || (mod.default && mod.default.chromium);
}

const FAKE_WS = `(() => {
  window.__ws = { sent: [], mode: "ok", opened: 0 };
  const b64 = (n) => { const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin(i / 8) * 8000); let s = ""; const u = new Uint8Array(a.buffer); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; window.__ws.url = url; window.__ws.opened++; window.__ws.sock = this; this.audio = 0;
      setTimeout(() => { if (window.__ws.mode === "fail") { this.readyState = 3; this.onclose && this.onclose({ code: 1008, reason: "bad key" }); return; } this.readyState = 1; this.onopen && this.onopen({}); }, 20); }
    send(text) {
      const msg = JSON.parse(text); window.__ws.sent.push(msg);
      if (msg.setup) setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ setupComplete: {} }) }), 20);
      if (msg.realtimeInput && ++this.audio === 4) {
        this.onmessage({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: b64(14400) } }] } } }) });
        this.onmessage({ data: JSON.stringify({ serverContent: { outputTranscription: { text: "Hola " } } }) });
        this.onmessage({ data: JSON.stringify({ serverContent: { outputTranscription: { text: "mundo" }, turnComplete: true } }) });
      }
    }
    close() { this.readyState = 3; }
  }
  window.WebSocket = FakeSocket;
})();`;

async function main() {
  const local = await serve((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.url.indexOf(KEY) >= 0) { res.writeHead(400); res.end(); return; }
    if (url.pathname === "/" || url.pathname === "/lt.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); return; }
    if (url.pathname === "/tone.wav") { res.writeHead(200, { "content-type": "audio/wav" }); res.end(TONE); return; }
    const file = path.join(root, path.basename(url.pathname));
    if (!/^live-translate\.(js|css)$/.test(path.basename(file))) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "text/css" });
    res.end(fs.readFileSync(file));
  });
  const other = await serve((req, res) => { res.writeHead(200, { "content-type": "audio/wav" }); res.end(TONE); });
  const base = "http://127.0.0.1:" + local.address().port;
  const foreign = "http://localhost:" + other.address().port + "/tone.wav";
  const chromium = await loadPlaywright();
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"] });
  const leaks = [];
  const google = { stt: [], mt: [], tts: [] };
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    context.on("request", (req) => { if (req.url().indexOf(KEY) >= 0 && !/^https:\/\/[a-z]+\.googleapis\.com\//.test(req.url())) leaks.push(req.url()); });
    await context.route("https://speech.googleapis.com/**", (route) => { google.stt.push(JSON.parse(route.request().postData())); route.fulfill({ json: { results: [{ alternatives: [{ transcript: "hello world" }] }] } }); });
    await context.route("https://translation.googleapis.com/**", (route) => { google.mt.push(JSON.parse(route.request().postData())); route.fulfill({ json: { data: { translations: [{ translatedText: "hola mundo" }] } } }); });
    await context.route("https://texttospeech.googleapis.com/**", (route) => { google.tts.push(JSON.parse(route.request().postData())); route.fulfill({ json: { audioContent: wav(0.4, 24000, 1, 0.4).toString("base64") } }); });
    await context.addInitScript(FAKE_WS);
    await context.addInitScript(`(() => { if (sessionStorage.getItem("seeded")) return; sessionStorage.setItem("seeded", "1");
      localStorage.setItem("viktorychapp-live-translate-v1", JSON.stringify({ on: true, target: "es", mode: "both", duck: 0.2 }));
      localStorage.setItem("viktorychapp-live-translate-key", "${KEY}"); })();`);
    const page = await context.newPage();
    const slow = Number(process.env.CPU || 0);
    if (slow > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: slow });
    }
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.goto(base + "/lt.html");
    if (await page.locator(".lt-pill").count()) fail("the pill shows before anything plays");
    await page.evaluate(() => document.getElementById("a").play());
    await page.waitForSelector(".lt-pill:not([hidden])", { timeout: 5000 });
    const box = await page.locator(".lt-pill").boundingBox();
    if (!box || box.height > 34) fail("the pill is not thin: " + JSON.stringify(box));

    // Gemini Live.
    await page.locator(".lt-pill").click();
    await page.waitForFunction(() => window.__ws.sent.some((m) => m.realtimeInput), null, { timeout: 8000 });
    const setup = await page.evaluate(() => ({ url: window.__ws.url, first: window.__ws.sent[0], chunk: window.__ws.sent.find((m) => m.realtimeInput) }));
    if (!/^wss:\/\/generativelanguage\.googleapis\.com\/ws\/google\.ai\.generativelanguage\.v1beta\.GenerativeService\.BidiGenerateContent\?key=/.test(setup.url)) fail("wrong Live endpoint");
    const s = setup.first.setup;
    if (s.model !== "models/gemini-3.5-live-translate-preview") fail("wrong model " + s.model);
    const gc = s.generationConfig;
    if (!gc.translationConfig || gc.translationConfig.targetLanguageCode !== "es" || gc.responseModalities[0] !== "AUDIO" || !gc.outputAudioTranscription) fail("wrong setup " + JSON.stringify(s));
    const audio = setup.chunk.realtimeInput.audio;
    if (audio.mimeType !== "audio/pcm;rate=16000") fail("wrong input format");
    const bytes = Buffer.from(audio.data, "base64");
    if (bytes.length !== 3200) fail("chunks are not 100 ms of 16 kHz PCM16: " + bytes.length);
    await page.waitForFunction(() => { const el = document.querySelector(".lt-subs"); return el && !el.hidden && el.textContent === "Hola mundo"; }, null, { timeout: 5000 });
    /* The gain approaches the saved 0.2 target on the audio clock. Poll until
       it is there. A fixed wait reads the ramp mid-way when that clock is slow. */
    const duckLimit = 0.25;
    await page.waitForFunction((limit) => {
      const s = window.ViktorychLiveTranslate.state();
      return !!(s && s.ducked && s.duck <= limit);
    }, duckLimit, { timeout: 4000 });
    const ducked = await page.evaluate(() => window.ViktorychLiveTranslate.state().duck);
    if (!(ducked <= duckLimit)) fail("the original was not ducked: " + ducked);
    await page.waitForFunction(() => !window.ViktorychLiveTranslate.state().ducked, null, { timeout: 4000 });
    const subsBox = await page.locator(".lt-subs").boundingBox();
    if (!subsBox || subsBox.width < 200) fail("subtitles are not placed");
    if (!(await page.locator(".lt-pill.on").count())) fail("the pill does not show it is on");
    await page.locator(".lt-pill").click();
    const off = await page.evaluate(() => window.ViktorychLiveTranslate.state());
    if (off.active || off.duck !== 1) fail("stopping left the sound changed");

    // Paused media costs nothing.
    await page.locator(".lt-pill").click();
    await page.waitForFunction(() => window.ViktorychLiveTranslate.state().ms > 300, null, { timeout: 5000 });
    await page.evaluate(() => document.getElementById("a").pause());
    const before = await page.evaluate(() => window.ViktorychLiveTranslate.state().ms);
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => window.ViktorychLiveTranslate.state().ms);
    if (after !== before) fail("paused media still counts");
    await page.evaluate(() => { window.ViktorychLiveTranslate.stop(); return document.getElementById("a").play(); });

    // Fallback chain when Gemini Live refuses.
    await page.evaluate(() => { window.__ws.mode = "fail"; document.getElementById("a").currentTime = 0; });
    await page.locator(".lt-pill").click();
    await page.waitForFunction(() => window.ViktorychLiveTranslate.state().engine === "chain", null, { timeout: 5000 });
    await page.waitForFunction(() => { const el = document.querySelector(".lt-subs"); return el && el.textContent === "hola mundo"; }, null, { timeout: 12000 });
    const stt = google.stt[0];
    if (!stt || stt.config.encoding !== "LINEAR16" || stt.config.sampleRateHertz !== 16000 || stt.config.languageCode !== "en-US") fail("wrong Speech-to-Text request");
    if (!google.mt[0] || google.mt[0].target !== "es" || google.mt[0].q !== "hello world") fail("wrong Translation request");
    for (let i = 0; i < 30 && !google.tts.length; i++) await page.waitForTimeout(100);
    if (!google.tts[0] || google.tts[0].input.text !== "hola mundo") fail("no Text-to-Speech request");
    await page.evaluate(() => window.ViktorychLiveTranslate.stop());

    // Daily limit.
    await page.evaluate(() => { const d = new Date(); localStorage.setItem("viktorychapp-live-translate-usage", JSON.stringify({ day: d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(), ms: 31 * 60000 })); });
    await page.locator(".lt-pill").click();
    if ((await page.evaluate(() => window.ViktorychLiveTranslate.state().active))) fail("the daily limit did not hold");
    await page.evaluate(() => localStorage.removeItem("viktorychapp-live-translate-usage"));

    // Cross-origin media without CORS is left alone.
    await page.evaluate((src) => { document.getElementById("a").pause(); const x = document.getElementById("x"); x.src = src; return x.play(); }, foreign);
    await page.waitForSelector(".lt-pill:not([hidden])");
    await page.locator(".lt-pill").click();
    const cross = await page.evaluate(() => ({ st: window.ViktorychLiveTranslate.state(), pill: document.querySelector(".lt-pill").textContent }));
    if (cross.st.active || !/captured/.test(cross.st.notice) || !/captured/.test(cross.pill)) fail("cross-origin media was not refused");

    // Settings.
    await page.evaluate(() => { document.getElementById("box").innerHTML = window.ViktorychLiveTranslate.settingsHtml(); });
    const html = await page.locator("#lt-settings").innerHTML();
    if (html.indexOf(KEY) >= 0) fail("the settings page prints the key");
    if (!/…0000/.test(html)) fail("the saved key is not shown masked");
    await page.locator('#lt-settings [data-lt="mode"][data-value="subtitles"]').click();
    await page.locator('#lt-settings [data-lt="engine"][data-value="chain"]').click();
    await page.locator('#lt-settings [data-lt-field="target"]').selectOption("ru");
    await page.locator('#lt-settings [data-lt-field="model"]').fill("gemini-3.8-live");
    await page.locator('#lt-settings [data-lt-field="model"]').dispatchEvent("change");
    let p = await page.evaluate(() => window.ViktorychLiveTranslate.prefs());
    if (p.mode !== "subtitles" || p.engine !== "chain" || p.target !== "ru" || p.model !== "gemini-3.8-live") fail("settings did not save: " + JSON.stringify(p));
    const general = await page.evaluate(() => window.ViktorychLiveTranslate._setup(Object.assign(window.ViktorychLiveTranslate.prefs(), { voice: "g:Kore" })).setup);
    if (general.generationConfig.translationConfig || !general.systemInstruction || !general.outputAudioTranscription || general.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName !== "Kore") fail("general Live models are not set up as interpreters");
    await page.locator('#lt-settings [data-lt="key-forget"]').click();
    await page.locator('#lt-settings [data-lt-field="key"]').fill("AIza-new-1234");
    await page.locator('#lt-settings [data-lt-field="key"]').dispatchEvent("change");
    if ((await page.evaluate(() => localStorage.getItem("viktorychapp-live-translate-key"))) !== "AIza-new-1234") fail("the key did not save on the device");
    const pills = await page.locator("#lt-settings .lt-row .outline").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    if (pills.some((h) => h > 34)) fail("settings pills are not thin");
    await page.locator('#lt-settings [data-lt="on"]').click();
    if ((await page.evaluate(() => window.ViktorychLiveTranslate.prefs().on))) fail("the switch did not turn it off");
    if (await page.locator(".lt-pill:not([hidden])").count()) fail("the pill stays after turning it off");
    if (leaks.length) fail("the key went somewhere other than Google: " + leaks[0]);
    if (errors.length) fail("page errors: " + errors.join("; "));
    console.log("live translate ok");
  } finally {
    await browser.close();
    local.close();
    other.close();
  }
}
main().catch((err) => { if (!process.exitCode) { console.error(err); process.exitCode = 1; } });
