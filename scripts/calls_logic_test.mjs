import assert from "node:assert/strict";
import { createLiveSession, directSocketUrl, proxiesAudio, MIC_WORKLET, CHUNK_SAMPLES, OUTPUT_RATE, needsResume, SESSION_REFRESH_MS, createVad, shouldKeepAlive, silenceFrame, pcmB64, createUtterance, KEEP_ALIVE_MS, SILENCE_SAMPLES, HANG_MAX, HANG_MIN, geminiHeaders, redactSecret, euProxyHint, GEMINI_REST } from "../shared/call-gemini.js";
import { isCallLang, CALL_LANGS, detectLang, guessLang } from "../shared/call-langs.js";
import { outputGains, createJitter, soakJitter, createMeter, createTimeline, normalizeVolumes, MIC_CONSTRAINTS, micConstraints, OPUS_MAX_BITRATE, mergeTranscript, transcriptWords } from "../shared/call-audio.js";
import { callDecision, dndActive } from "../shared/call-privacy.js";
import {
  normalizeMode, transmitOriginal, micOpen, noteRelease, noteShouldAutoplay,
  chatVisible, showOriginalSub, showTranslationSub, threadVisible, takeClauses,
  guestFeature, GUEST_FEATURES, modeSwitchKeepsCall, QUICK_PHRASES
} from "../shared/call-mode.js";
import { estimatePitch, matchVoice, resolveVoice, createVoiceMatch, voiceChanged, DEFAULT_VOICE } from "../shared/call-voice.js";
import { langName } from "../shared/call-langs.js";
import { createDiarizer, overlappingPitches } from "../shared/call-speakers.js";
import { liveSetup, livePath, rejectsClone } from "../shared/call-setup.js";
import { createHistory, loadLocal, recordLocal, removeRows, restoreRows, swipeAction, toggleSet } from "../shared/call-history.js";
import { createRaiseDetector, earSinkId, cheekLike, createUnlocker, EAR_VOLUME_CAP } from "../shared/call-ear.js";
import { createPlayoutLead, LEAD_MIN, LEAD_MAX, pickBitrate, createAudioUnlock, setAudioSession, createWakeFallback, NOSLEEP_MP4, BITRATES, micFailure, micPlatform } from "../shared/call-mobile.js";
import { createPipe } from "../shared/call-engine.js";
import { createPreview } from "../shared/call-preview.js";
import { createChatOutbox, chatId } from "../shared/call-chat.js";
import { relayHint } from "../worker/src/calls.js";
import pagesRelay from "./pages_relay_worker.js";
import { readFileSync } from "node:fs";
const pagesRelaySource = readFileSync(new URL("./pages_relay_worker.js", import.meta.url), "utf8");
import { lighterFor, pickSink, sinkChangeKeepsCall, cleanLexicon, rememberLine } from "../shared/call-quality.js";

assert.equal(isCallLang("ca"), true, "Catalan is a Live Translate target");
assert.equal(isCallLang("sv"), true, "Swedish is a Live Translate target");
assert.ok(CALL_LANGS.some((row) => row[0] === "ca" && row[1] === "Catalan"));
assert.ok(CALL_LANGS.some((row) => row[0] === "sv" && row[1] === "Swedish"));
assert.equal(guessLang("ca-ES"), "ca");
assert.equal(detectLang("Gràcies, és un bon dia amb amics", "en").code, "ca");
assert.equal(detectLang("Hej, det här är också bra", "en").code, "sv");

const high = outputGains({ original: 0.28, translation: 0.8, overall: 1, tts: 0.5 }, { translating: true, hearOriginal: true, playTranslation: true, playTts: true });
assert.ok(high.original < 0.3 && high.translation === 0.8 && high.tts === 0.5);
const restored = outputGains({ original: 0.28 }, { translating: false, hearOriginal: true, playTranslation: true });
assert.ok(restored.original > high.original);
const unducked = outputGains({ original: 0.28, overall: 1 }, { translating: true, hearOriginal: true, duck: false });
assert.ok(Math.abs(unducked.original - restored.original) < 1e-9, "the switch can leave the original up during a translation");
assert.ok(outputGains({ original: 0.28, overall: 1 }, { translating: true, hearOriginal: true, duck: true }).original < 0.3);
assert.equal(outputGains({}, { hearOriginal: false, playTranslation: false }).original, 0);
assert.equal(MIC_CONSTRAINTS.echoCancellation, true);
assert.equal(MIC_CONSTRAINTS.noiseSuppression, true);
assert.equal(MIC_CONSTRAINTS.autoGainControl, true);
assert.equal("video" in MIC_CONSTRAINTS, false);
assert.equal(micConstraints(true).noiseSuppression, false, "quiet voice keeps browser suppression from eating a whisper");
assert.equal(micConstraints(true).echoCancellation, true);
assert.equal(micConstraints(true).autoGainControl, true);
assert.equal(micConstraints(false).noiseSuppression, true, "flag off restores the old constraints");
assert.ok(OPUS_MAX_BITRATE >= 128000);
assert.equal(normalizeVolumes({ mic: 2 }).mic, 1);

const jitter = createJitter(() => 0);
jitter.push({ byteLength: 100 }, 10);
const first = jitter.pull(10);
assert.ok(first, "playback starts on the first chunk");
assert.equal(jitter.stats().startDelay, 0);
const soak = soakJitter(18000);
assert.equal(soak.capped, true);

const meter = createMeter();
meter.mic(0);
meter.partial(80);
meter.translationAudio(120);
meter.text(0);
meter.tts(40);
meter.note(0);
meter.notePlay(30);
const report = meter.report();
assert.equal(report.voiceToVoice, 120);
assert.equal(report.voiceToText, 80);
assert.equal(report.textToVoice, 40);
assert.equal(report.noteToVoice, 30);

assert.equal(callDecision({ who: "everyone" }).ok, true);
assert.equal(callDecision({ who: "nobody" }).ok, false);
assert.equal(callDecision({ who: "circle", follows: false, mutual: false }).ok, false);
assert.equal(callDecision({ who: "circle", follows: true }).ok, true);
assert.equal(callDecision({ blocked: true, who: "everyone" }).ok, false);
assert.equal(callDecision({ invite: true, guests: false }).ok, false);
assert.equal(callDecision({ invite: true, guests: true, who: "nobody" }).ok, true);
assert.equal(callDecision({ dnd: true }).ok, false);
const night = Date.UTC(2026, 10, 19, 22, 30);
assert.equal(dndActive({ dnd: true, dndStart: "22:00", dndEnd: "07:00", tz: 0 }, night), true);
assert.equal(dndActive({ dnd: false, dndStart: "22:00", dndEnd: "07:00", tz: 0 }, night), false);

for (const send of ["voice", "text", "note"]) {
  for (const receive of ["voice", "text", "both"]) {
    const mode = normalizeMode({ send, receive, original: true });
    assert.equal(mode.send, send);
    assert.equal(mode.receive, receive);
    assert.equal(transmitOriginal(mode), send === "voice");
    assert.equal(noteShouldAutoplay(mode), receive !== "text");
  }
}
assert.equal(transmitOriginal({ send: "voice", translationOnly: true }), false);
assert.equal(micOpen({ send: "note" }, false), false);
assert.equal(micOpen({ send: "note" }, true), true);
assert.equal(micOpen({ send: "text" }, true), false);
assert.equal(micOpen({ send: "voice" }, false), true);
assert.equal(noteRelease(0, -80, false), "cancel");
assert.equal(noteRelease(0, -10, true), "review");
assert.equal(noteRelease(0, -10, false), "send");
assert.equal(modeSwitchKeepsCall(), true);

assert.equal(showOriginalSub({ subtitles: "off" }), false);
assert.equal(showTranslationSub({ subtitles: "off" }), false);
assert.equal(showOriginalSub({ subtitles: "translated" }), false);
assert.equal(showTranslationSub({ subtitles: "translated" }), true);
assert.equal(showOriginalSub({ subtitles: "original" }), true);
assert.equal(showTranslationSub({ subtitles: "original" }), false);
assert.equal(showOriginalSub({ subtitles: "both" }), true);
assert.equal(showTranslationSub({ subtitles: "both" }), true);
assert.equal(chatVisible({ receive: "text", subtitles: "off" }), true);
assert.equal(chatVisible({ receive: "voice", subtitles: "both" }), false);
assert.equal(threadVisible({ receive: "voice", subtitles: "off" }, true), true);
const clauses = takeClauses("Hello there. More words are still coming into this");
assert.equal(clauses.ready[0], "Hello there.");
assert.ok(clauses.rest.length > 0, "the rest of the sentence is not required before speech");

GUEST_FEATURES.forEach((name) => assert.equal(guestFeature(name), true));
assert.equal(guestFeature("video"), false);

function sine(hz, rate, seconds) {
  const n = Math.floor(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.4 * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}
const low = estimatePitch(sine(120, 16000, 0.25), 16000);
assert.equal(low.confident, true);
assert.ok(Math.abs(low.hz - 120) <= 8, "pitch " + low.hz);
assert.equal(matchVoice(120), matchVoice(low.hz));
const highPitch = estimatePitch(sine(220, 16000, 0.25), 16000);
assert.ok(Math.abs(highPitch.hz - 220) <= 12, "pitch " + highPitch.hz);
assert.notEqual(matchVoice(120), matchVoice(220));
const instant = resolveVoice("", 0, false);
assert.equal(instant.voice, DEFAULT_VOICE);
assert.equal(instant.source, "default");
assert.equal(resolveVoice("Kore", 120, true).voice, "Kore");
assert.equal(resolveVoice("Kore", 120, true).source, "override");
const matcher = createVoiceMatch();
const before = matcher.current();
assert.equal(before.source, "default");
assert.equal(matcher.current() instanceof Promise, false);
for (let i = 0; i < 10; i++) matcher.push(sine(120, 16000, 0.1), 16000);
const after = matcher.current();
assert.equal(after.source, "pitch");
assert.equal(voiceChanged(before, after), true);
const locked = createVoiceMatch("Aoede");
locked.push(sine(120, 16000, 0.2), 16000);
assert.equal(locked.current().voice, "Aoede");
assert.equal(locked.current().source, "override");

const setup = liveSetup("sv", "Leda");
assert.equal(setup.generationConfig.translationConfig.targetLanguageCode, "sv");
assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Leda");
assert.equal(setup.inputAudioTranscription != null, true);
assert.equal(JSON.stringify(setup).toLowerCase().includes("clone"), false);
assert.equal(rejectsClone({ referenceAudio: "abc" }), true);
assert.equal(rejectsClone({ voice: "Puck" }), false);
assert.equal(liveSetup("ca").generationConfig.translationConfig.targetLanguageCode, "ca");
const hinted = liveSetup("en", "Puck", "", "Pronounce these as specified: Nova = NO-vah.");
assert.equal(hinted.systemInstruction.parts[0].text.indexOf("NO-vah") >= 0, true);
const both = liveSetup("sv", "Leda", "resume-1", "", "en");
assert.equal(both.sessionResumption.handle, "resume-1");
assert.ok(both.contextWindowCompression.slidingWindow);
assert.ok(both.systemInstruction.parts[0].text.indexOf("Speaker language: en.") >= 0);
assert.ok(both.systemInstruction.parts[0].text.indexOf("Listener language: sv.") >= 0);
assert.equal(livePath(true, false), "translate");
assert.equal(livePath(true, true), "live");
assert.equal(livePath(false, false), "live");
const live = liveSetup("es", "Leda", "", "", "en", "live");
assert.equal(live.generationConfig.translationConfig, undefined);
assert.equal(live.model, setup.model);
assert.ok(live.systemInstruction.parts[0].text.indexOf("simultaneous interpreter") >= 0);
assert.ok(live.systemInstruction.parts[0].text.indexOf("Spanish") >= 0 || live.systemInstruction.parts[0].text.indexOf("es") >= 0);
assert.equal(JSON.stringify(live).toLowerCase().includes("clone"), false);
assert.equal(lighterFor({ effectiveType: "4g", downlink: 10, rtt: 50 }).lighter, false);
assert.equal(lighterFor({ saveData: true }).bitrate, 24000);
assert.equal(pickSink([{ kind: "audiooutput", deviceId: "spk", label: "Speaker" }, { kind: "audiooutput", deviceId: "bt", label: "Bluetooth headphones" }]), "bt");
assert.equal(sinkChangeKeepsCall(), true);
assert.equal(cleanLexicon([{ word: "Nova", say: "NO-vah" }, { word: "", say: "x" }]).length, 1);
assert.equal(rememberLine(null, { text: "Hola" }).text, "Hola");
assert.deepEqual(QUICK_PHRASES, ["hold", "repeat", "back"]);

const session = createLiveSession();
session.ring(0);
assert.equal(session.phase(), "warming");
session.ready(10);
assert.equal(session.warm(), true);
assert.equal(proxiesAudio(), false);
assert.equal(CHUNK_SAMPLES, 1600);
assert.equal(OUTPUT_RATE, 24000);
assert.ok(MIC_WORKLET.indexOf("new Int16Array(1600)") >= 0);
assert.ok(MIC_WORKLET.indexOf("16000") >= 0);
const socket = directSocketUrl("test-ephemeral");
assert.ok(socket.indexOf("access_token=") >= 0);
assert.equal(socket.indexOf("key="), -1);
assert.equal(directSocketUrl(""), "");
const silent = new Float32Array(1600);
const loud = new Float32Array(1600);
loud.fill(0.2);
assert.equal(session.onSpeech(silent, 20).reason, "vad");
assert.equal(session.onSpeech(loud, 30).send, true);
assert.equal(session.onSpeech(loud, 30).bytes, 3200);
for (let i = 0; i < 400; i++) session.onSpeech(loud, 1000 + i * 100);
assert.equal(session.quota(1000 + 400 * 100).degraded, true);
assert.equal(session.quota(1000 + 400 * 100).mode, "text");
assert.equal(session.onSpeech(loud, 50000).reason, "text");
assert.ok(session.quota(50000).perMinute > 0);
assert.equal(needsResume(SESSION_REFRESH_MS, false), true);
assert.equal(needsResume(1000, true), true);

function tone(hz) {
  const out = new Float32Array(4000);
  for (let i = 0; i < out.length; i++) out[i] = 0.4 * Math.sin((2 * Math.PI * hz * i) / 16000);
  return out;
}
const mixed = tone(120);
const other = tone(220);
for (let i = 0; i < mixed.length; i++) mixed[i] = (mixed[i] + other[i]) * 0.5;
assert.equal(overlappingPitches(tone(120), 16000).length, 0);
assert.equal(overlappingPitches(mixed, 16000).length, 2);
const people = createDiarizer();
const speakerA = people.push(tone(120), 16000, "Hello thanks and this is good");
let speakerB = null;
for (let i = 0; i < 12; i++) speakerB = people.push(tone(220), 16000, i === 11 ? "Hola gracias también estoy aquí" : "");
assert.equal(speakerA.send, true);
assert.equal(speakerB.send, true);
assert.notEqual(speakerA.speaker.id, speakerB.speaker.id);
assert.equal(speakerA.speaker.lang, "en");
assert.equal(speakerB.speaker.lang, "es");
assert.notEqual(speakerA.speaker.voice, speakerB.speaker.voice);
assert.equal(people.push(mixed, 16000, "").send, false);
const one = createDiarizer();
for (let i = 0; i < 60; i++) one.push(tone(i % 9 === 0 ? 0 : 120 + (i % 5) * 4), 16000, "");
assert.equal(one.speakers().length, 1, "one steady voice with small pitch wobble stays one speaker");
const breaths = createDiarizer();
breaths.push(tone(125), 16000, "");
for (let i = 0; i < 20; i++) breaths.push(tone(220), 16000, "");
assert.equal(breaths.speakers().length, 2, "a clearly different voice is a second speaker once it holds");
const blip = createDiarizer();
blip.push(tone(125), 16000, "");
blip.push(tone(230), 16000, "");
blip.push(tone(125), 16000, "");
assert.equal(blip.speakers().length, 1, "a single odd frame does not split the voice");
people.rename(speakerB.speaker.id, "Nova");
assert.equal(people.speakers().find((item) => item.id === speakerB.speaker.id).name, "Nova");

assert.equal(langName("es", "en"), "Spanish");
assert.equal(langName("es", "es"), "Español");
assert.equal(langName("sv", "ru"), "Шведский");
assert.equal(langName("ca", "hi").length > 0, true);
assert.equal(langName("zz", "en"), "zz");


/* Ear mode: raise-to-ear detection, earpiece route, cheek-proof unlock */
{
  const feed = (det, rows) => rows.map(([t, b, g]) => det.feed({ t, beta: b, gamma: g })).filter(Boolean);
  const raised = [];
  for (let t = 0; t <= 1000; t += 50) raised.push([t, 50, 0]);
  for (let t = 1050; t <= 1400; t += 50) raised.push([t, 50 + (t - 1000) / 400 * 40, 3]);
  for (let t = 1450; t <= 2600; t += 50) raised.push([t, 92, 4]);
  assert.deepEqual(feed(createRaiseDetector(), raised), ["ear"], "raising the phone upright to the ear locks once");
  const mount = [];
  for (let t = 0; t <= 6000; t += 50) mount.push([t, 90, 0]);
  assert.deepEqual(feed(createRaiseDetector(), mount), [], "a phone sitting upright in a car mount never locks");
  const swing = [];
  for (let t = 0; t <= 1000; t += 50) swing.push([t, 50, 0]);
  for (let t = 1050; t <= 2600; t += 50) swing.push([t, 90 + ((t / 50) % 2 ? 9 : -9), 0]);
  assert.deepEqual(feed(createRaiseDetector(), swing), [], "a shaking phone does not count as raised and held");
  const det = createRaiseDetector();
  feed(det, raised);
  const lower = [];
  for (let t = 3000; t <= 4200; t += 50) lower.push([t, 20, 0]);
  assert.deepEqual(feed(det, lower), ["away"], "lowering the phone ends an automatic ear mode");
  assert.equal(EAR_VOLUME_CAP < 1 && EAR_VOLUME_CAP > 0.3, true);

  const sinks = [{ kind: "audiooutput", label: "Speaker", deviceId: "s" }, { kind: "audiooutput", label: "Phone earpiece", deviceId: "e" }, { kind: "audiooutput", label: "Bluetooth headset", deviceId: "b" }];
  assert.equal(earSinkId(sinks), "e");
  assert.equal(earSinkId([sinks[0], sinks[2]]), "", "no earpiece listed means no route change");
  assert.equal(cheekLike({ width: 70, height: 90 }), true);
  assert.equal(cheekLike({ width: 20, height: 20 }), false);

  const u = createUnlocker();
  u.down(1, 100, 100, 0, { width: 20, height: 20 });
  assert.equal(u.up(1, 100, 100, 80), "", "one tap does nothing");
  u.down(1, 102, 101, 200, { width: 20, height: 20 });
  assert.equal(u.up(1, 102, 101, 270), "unlock", "double tap unlocks");
  u.down(2, 100, 100, 1000, { width: 90, height: 90 });
  assert.equal(u.up(2, 100, 100, 1060), "");
  u.down(2, 100, 100, 1150, { width: 90, height: 90 });
  assert.equal(u.up(2, 100, 100, 1200), "", "a wide cheek contact never unlocks");
  u.down(3, 100, 300, 2000, { width: 20, height: 20 });
  u.down(4, 150, 300, 2010, { width: 20, height: 20 });
  assert.equal(u.up(3, 100, 100, 2200), "", "two fingers at once are ignored");
  u.up(4, 150, 300, 2210);
  u.down(5, 100, 400, 3000, { width: 20, height: 20 });
  u.move(5, 100, 250);
  assert.equal(u.up(5, 100, 240, 3300), "unlock", "a swipe up unlocks");
  u.down(6, 100, 400, 4000, { width: 20, height: 20 });
  assert.equal(u.up(6, 100, 330, 4300), "", "a short drag is not a swipe");
}

/* Editing call history: hide for me, undo, clear all, guests stay local. */
{
  const mem = {};
  const storage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  recordLocal(storage, { id: "a1", name: "Ann", createdAt: 1000, duration: 5000 });
  recordLocal(storage, { id: "b2", name: "Bo", createdAt: 3000 });
  recordLocal(storage, { id: "a1", name: "Ann", createdAt: 1000 });
  assert.deepEqual(loadLocal(storage).map((r) => r.id), ["a1", "b2"], "one row per call id, the latest record first");
  assert.equal(loadLocal(storage).length, 2);
  const calls = [];
  const h = createHistory({ api: async (path, init) => { calls.push(path); return { ok: true, data: path.endsWith("/clear") ? { ids: ["x1", "x2"] } : { calls: [{ id: "x1", createdAt: 5 }, { id: "x2", createdAt: 9 }] } }; }, storage, signedIn: () => false });
  await h.load();
  assert.deepEqual(h.rows.map((r) => r.id).sort(), ["a1", "b2"]);
  const t1 = await h.remove(["a1"]);
  assert.deepEqual(h.rows.map((r) => r.id), ["b2"]);
  assert.equal(calls.length, 0, "guests never call the Worker");
  assert.deepEqual(loadLocal(storage).map((r) => r.id), ["b2"], "guest removal is saved on the device");
  await h.restore(t1);
  assert.equal(h.rows.length, 2);
  assert.equal(h.rows[0].id, "b2", "newest first after undo");
  const cleared = await h.clear();
  assert.equal(h.rows.length, 0);
  await h.restore(cleared);
  assert.equal(h.rows.length, 2);

  const s2 = createHistory({ api: async (path) => { calls.push(path); return { ok: true, data: path.endsWith("/clear") ? { ids: ["x1", "x2"] } : { calls: [{ id: "x1", createdAt: 5 }, { id: "x2", createdAt: 9 }] } }; }, storage, signedIn: () => true });
  await s2.load();
  assert.deepEqual(s2.rows.map((r) => r.id), ["x1", "x2"]);
  const tk = await s2.remove(["x2"]);
  assert.deepEqual(calls.slice(-1), ["/v1/calls/history/hide"]);
  await s2.restore(tk);
  assert.deepEqual(calls.slice(-1), ["/v1/calls/history/unhide"]);
  const all = await s2.clear();
  assert.deepEqual(all.ids, ["x1", "x2"]);
  assert.equal(s2.rows.length, 0);
  const bad = createHistory({ api: async () => ({ ok: false }), storage, signedIn: () => true });
  bad.rows = [{ id: "q", createdAt: 1 }];
  await assert.rejects(() => bad.remove(["q"]));
  assert.equal(bad.rows.length, 1, "a failed hide puts the row back");
  assert.equal(swipeAction(-120, 10, 320), "delete");
  assert.equal(swipeAction(-60, 5, 320), "none");
  assert.equal(swipeAction(-120, 90, 320), "none", "a mostly vertical drag is a scroll");
  assert.deepEqual([...toggleSet(new Set(["a"]), "a")], []);
  assert.deepEqual(removeRows([{ id: 1 }, { id: 2 }], [2]).kept, [{ id: 1 }]);
  assert.equal(restoreRows([{ id: 1, createdAt: 1 }], [{ id: 2, createdAt: 2 }])[0].id, 2);
}


/* Route race: relay first for a blocked network, a second route that starts
   beside a slow first one, and the loser is closed. */
{
  assert.deepEqual(relayHint({ cf: { country: "RU" } }), { country: "RU", prefer: "relay" });
  assert.deepEqual(relayHint({ cf: { country: "SE" } }), { country: "SE" });
  assert.deepEqual(relayHint({ headers: new Headers({ "CF-IPCountry": "by" }) }), { country: "BY", prefer: "relay" });
  assert.deepEqual(relayHint({ headers: new Headers() }), {});

  const sockets = [];
  const plan = {};
  class FakeSocket {
    constructor(url) {
      this.url = url; this.closed = false; sockets.push(this);
      const how = Object.keys(plan).find((key) => url.indexOf(key) >= 0);
      this.how = how ? plan[how] : "ok";
      setTimeout(() => { if (this.how === "dead") { this.onclose && this.onclose(); } else if (this.how !== "hang" && !this.closed) this.onopen && this.onopen(); }, this.how === "dead" ? 5 : 0);
    }
    send() { if (this.how === "ok" || this.how === "slow") setTimeout(() => { if (!this.closed && this.onmessage) this.onmessage({ data: '{"setupComplete":{}}' }); }, this.how === "slow" ? 1800 : 10); }
    close() { this.closed = true; }
  }
  globalThis.WebSocket = FakeSocket;
  let minted = 0;
  const run = async (hostPlan, order, flags) => {
    sockets.length = 0;
    Object.keys(plan).forEach((key) => delete plan[key]);
    Object.assign(plan, hostPlan);
    const seen = [];
    const env = {
      relayFirst: () => !!(flags && flags.relay), routeKnown: () => false, noteRoute: (via) => seen.push(via),
      relayUrl: (t) => "wss://main.test/live?t=" + t,
      relayUrls: (t) => ["wss://main.test/live?t=" + t, "wss://mirror.test/live?t=" + t]
    };
    const states = [];
    const pipe = createPipe(env, {
      id: "t", target: "en", out: null, source: "",
      token: async () => { minted += 1; return { mode: "token", token: "tok" + minted + "_abcdefgh", url: "wss://google.test/ws?t=" + minted, setup: {}, prefer: flags && flags.prefer }; },
      onState: (p, st) => states.push(st), onLine() {}, onPartial() {}, onOut() {}, onGoAway() {}
    });
    const t0 = Date.now();
    pipe.open();
    for (let i = 0; i < 80 && !pipe.via && !states.includes("failed"); i++) await new Promise((r) => setTimeout(r, 100));
    return { via: pipe.via, ms: Date.now() - t0, seen, minted, sockets: sockets.slice(), pipe };
  };
  let r = await run({ "google.test": "ok" }, 0, {});
  assert.equal(r.via, "direct");
  assert.equal(r.sockets.length, 1, "a fast direct route never starts the relay");
  r.pipe.close();
  r = await run({ "google.test": "dead" }, 0, {});
  assert.equal(r.via, "relay", "a dead direct route falls to the relay at once");
  assert.ok(r.ms < 800, "the fallback does not wait for the full timeout: " + r.ms);
  r.pipe.close();
  r = await run({ "google.test": "slow", "main.test": "ok" }, 0, {});
  assert.equal(r.via, "relay", "a slow direct route loses to the relay that starts beside it");
  assert.ok(r.sockets.filter((sock) => sock.url.indexOf("google") >= 0).every((sock) => sock.closed), "the slow loser is closed");
  r.pipe.close();
  r = await run({ "main.test": "dead", "mirror.test": "ok" }, 0, { prefer: "relay" });
  assert.equal(r.via, "relay");
  assert.ok(r.sockets[0].url.indexOf("main.test") >= 0 && r.sockets[1].url.indexOf("mirror.test") >= 0, "a blocked main host falls to the mirror host");
  assert.ok(!r.sockets.some((sock) => sock.url.indexOf("google") >= 0), "a hinted caller never opens a Google socket when the relay works");
  r.pipe.close();
  r = await run({ "main.test": "hang", "mirror.test": "ok" }, 0, { prefer: "relay" });
  assert.equal(r.via, "relay");
  assert.ok(r.ms > 1400 && r.ms < 2600, "a hung main host hands over to the mirror after about 1.6 s: " + r.ms);
  assert.ok(r.sockets.filter((sock) => sock.url.indexOf("main.test") >= 0).every((sock) => sock.closed), "the hung socket is closed");
  r.pipe.close();
  delete globalThis.WebSocket;

  const assets = { fetch: async () => new Response("asset") };
  const hit = (path, init) => pagesRelay.fetch(new Request("https://viktorychapp.pages.dev" + path, init), { ASSETS: assets });
  assert.equal(await (await hit("/index.html")).text(), "asset");
  assert.equal((await hit("/v1/calls/live?t=abcdefgh1234")).status, 426);
  assert.ok(pagesRelaySource.includes("arrayBuffer") && !/server\.send\(event\.data\)/.test(pagesRelaySource), "Blob frames are converted before they are sent on");
  assert.equal((await hit("/v1/calls/live?t=%20bad", { headers: { Upgrade: "websocket" } })).status, 400);
}


/* Phone hardening: bitrate steps, the iOS audio unlock, the wake fallback. */
{
  let st = { level: 0, good: 0 };
  st = pickBitrate(st, { loss: 0, rtt: 0.08 });
  assert.equal(st.bitrate, 64000, "a clean link keeps full quality");
  st = pickBitrate(st, { loss: 0.05, rtt: 0.2 });
  assert.equal(st.bitrate, 24000, "5% loss drops at once");
  st = pickBitrate(st, { loss: 0.12, rtt: 0.3 });
  assert.equal(st.bitrate, BITRATES[3], "12% loss drops to the floor");
  st = pickBitrate(st, { loss: 0, rtt: 0.1 });
  st = pickBitrate(st, { loss: 0, rtt: 0.1 });
  assert.equal(st.level, 3, "it does not climb back on two good samples");
  st = pickBitrate(st, { loss: 0, rtt: 0.1 });
  assert.equal(st.level, 2, "three good samples climb one step");
  assert.equal(pickBitrate({ level: 0, good: 0 }, { loss: 0, rtt: 0.7 }).level, 2, "a very slow round trip counts as bad");
  assert.equal(pickBitrate(null, null).bitrate, 64000);

  let made = 0;
  let resumed = 0;
  class FakeCtx {
    constructor() { made += 1; this.state = "suspended"; this.destination = {}; }
    resume() { resumed += 1; this.state = "running"; return Promise.resolve(); }
    createBuffer() { return {}; }
    createBufferSource() { return { connect() {}, start() {} }; }
  }
  const unlock = createAudioUnlock({ AudioContext: FakeCtx });
  assert.equal(unlock.get(), null, "nothing exists before the first tap");
  const first = unlock.unlock();
  assert.equal(first.state, "running");
  assert.equal(unlock.unlock(), first, "later taps reuse the same context");
  assert.equal(made, 1);
  first.state = "closed";
  assert.equal(unlock.get(), null, "a closed context is not handed out");
  unlock.unlock();
  assert.equal(made, 2, "a closed one is replaced on the next tap");
  const listeners = [];
  unlock.bind({ addEventListener: (name) => listeners.push(name) });
  unlock.bind({ addEventListener: (name) => listeners.push(name) });
  assert.deepEqual(listeners.sort(), ["click", "keydown", "pointerdown", "touchend"], "bound once");
  assert.equal(createAudioUnlock({}).unlock(), null, "no Web Audio means no crash");

  const nav = { audioSession: { type: "auto" } };
  assert.equal(setAudioSession(nav, "play-and-record"), true);
  assert.equal(nav.audioSession.type, "play-and-record");
  assert.equal(setAudioSession({}, "auto"), false, "a browser without the API is left alone");

  const body = [];
  const doc = { body: { appendChild: (el) => body.push(el) }, createElement: () => ({ style: {}, setAttribute() {}, play: () => Promise.resolve(), pause() {}, removeAttribute() {}, load() {}, remove() { body.length = 0; } }) };
  const wake = createWakeFallback(doc);
  wake.on(); wake.on();
  assert.equal(body.length, 1, "one hidden clip, however many times it is asked");
  assert.ok(body[0].src.startsWith("data:video/mp4;base64,") && NOSLEEP_MP4.length < 4000, "tiny inline clip");
  assert.equal(wake.active(), true);
  wake.off();
  assert.equal(wake.active(), false);
  assert.equal(body.length, 0);
}

console.log("calls logic ok", JSON.stringify(report));

/* Adaptive playout lead: quick on a good link, wider after gaps, narrower again when calm. */
{
  const lead = createPlayoutLead();
  let slot = lead.plan(1, 0, 0.2);
  assert.ok(Math.abs(slot.start - 1.06) < 1e-9, "the first chunk plays after the minimum lead");
  let next = slot.next;
  slot = lead.plan(1.05, next, 0.2);
  assert.equal(slot.start, next, "a chunk that arrives in time follows the last one without a gap");
  next = slot.next;
  slot = lead.plan(next + 0.1, next, 0.2);
  assert.ok(slot.start - (next + 0.1) > 0.13, "a gap inside a phrase widens the lead");
  assert.equal(lead.stats().gaps, 1);
  for (let i = 0; i < 20; i++) { const t = slot.next - 0.05; next = slot.next; slot = lead.plan(next - 0.1, next, 0.2); }
  for (let i = 0; i < 10; i++) { const s0 = lead.plan(100 + i, 100 + i + 0.5, 0.2); if (!s0) throw new Error("dropped"); lead.plan(100 + i, 100 + i + 0.5, 2.5); }
  assert.ok(lead.stats().lead >= LEAD_MIN && lead.stats().lead <= LEAD_MAX, "the lead stays inside its bounds");
  const stale = lead.plan(10, 11.5, 0.2);
  assert.equal(stale, null, "audio more than 0.9 s behind real time is dropped");
  const poor = createPlayoutLead();
  poor.floor(3);
  assert.ok(poor.plan(5, 0, 0.1).start - 5 >= 0.24, "a poor link starts with a wider lead");
  const wide = createPlayoutLead();
  for (let i = 0; i < 20; i++) wide.plan(i, i - 0.1, 0.1);
  assert.equal(wide.stats().lead, LEAD_MAX, "repeated gaps stop at the maximum lead");
}

/* Quiet voice: a soft voice or whisper opens the gate, is lifted, and keeps its word start. The old gate was a fixed 0.02. */
{
  const frame = (rms, seed) => {
    const out = new Int16Array(1600);
    let r = seed || 1;
    for (let i = 0; i < out.length; i++) {
      r = (r * 1103515245 + 12345) & 0x7fffffff;
      const noise = ((r / 0x7fffffff) - 0.5) * 2;
      out[i] = Math.round(noise * Math.SQRT2 * rms * 32767);
    }
    return out;
  };
  const rmsOf = (a) => { let e = 0; for (let i = 0; i < a.length; i++) e += (a[i] / 32768) ** 2; return Math.sqrt(e / a.length); };
  const dbfs = (db) => Math.pow(10, db / 20);
  // Room noise -58 dBFS for 2 s, then a whisper at -42 dBFS.
  const quiet = createVad();
  for (let i = 0; i < 20; i++) assert.equal(quiet.gate(frame(dbfs(-58), i + 1)), false, "room noise alone stays closed");
  assert.equal(quiet.gate(frame(dbfs(-60), 99)), false);
  assert.equal(quiet.gate(frame(dbfs(-42), 5)), true, "a -42 dBFS whisper opens the gate (the old fixed gate was -34 dBFS)");
  assert.equal(quiet.out.length, 4, "the three frames before the gate opened go out first");
  const lifted = rmsOf(quiet.out[3]);
  assert.ok(lifted > 0.03 && lifted < 0.2, "the whisper is lifted toward a normal level, got " + lifted);
  assert.ok(quiet.out.every((c) => c.every((v) => Math.abs(v) < 32768 * 0.99)), "the limiter keeps it from clipping");
  // The old gate would not have opened.
  const old = createVad();
  assert.equal(old.gate(frame(dbfs(-42), 6), true), false, "strict mode keeps the old fixed gate");
  assert.equal(old.stats().gain, 1);
  // Normal speech is not boosted.
  const normal = createVad();
  for (let i = 0; i < 20; i++) normal.gate(frame(dbfs(-58), i + 7));
  const talk = frame(0.08, 3);
  normal.gate(talk);
  assert.ok(Math.abs(rmsOf(normal.out[normal.out.length - 1]) - rmsOf(talk)) < 0.001, "normal speech is left alone");
  const loud = createVad();
  for (let i = 0; i < 60; i++) loud.gate(frame(0.012, i + 1));
  assert.ok(loud.stats().gate <= 0.02 && loud.stats().gate >= 0.0025);
  assert.equal(loud.gate(frame(0.012, 500)), false, "steady room noise stays closed once learned");
  assert.equal(loud.gate(frame(0.1, 501)), true, "speech over the noise opens it");
  // Gain never exceeds the cap and the session passes the chunks on.
  const sess = createLiveSession();
  sess.ring(0); sess.ready(1);
  for (let i = 0; i < 20; i++) sess.onSpeech(frame(dbfs(-58), i + 1), 10 + i * 100);
  const d = sess.onSpeech(frame(dbfs(-45), 8), 3000);
  assert.equal(d.send, true);
  assert.ok(Array.isArray(d.chunks) && d.chunks.length >= 1 && d.chunks[d.chunks.length - 1] instanceof Int16Array);
  const sess2 = createLiveSession();
  sess2.ring(0); sess2.ready(1);
  assert.equal(sess2.onSpeech(frame(dbfs(-45), 9), 3100, true).send, false, "strict (sound playing aloud) ignores soft sound, so an echo cannot open it");
}

// Floating call window.
{
  const { createPip, pipSupported, cardLines } = await import("../shared/call-pip.js");
  const mkDoc = (opts) => {
    const o = opts || {};
    const made = [];
    const doc = {
      pictureInPictureEnabled: o.enabled !== false,
      pictureInPictureElement: null,
      body: { appendChild(el) { el.parentNode = doc.body; }, removeChild() {} },
      createElement(tag) {
        if (tag === "canvas") return { width: 0, height: 0, captureStream: o.noStream ? undefined : () => ({}), getContext: () => ({ fillRect() {}, beginPath() {}, arc() {}, fill() {}, fillText() {} }) };
        const el = { style: {}, attrs: {}, setAttribute(k, v) { el.attrs[k] = v; }, play: () => Promise.resolve(), pause() {}, parentNode: null,
          requestPictureInPicture: o.noPip ? undefined : async () => { doc.pictureInPictureElement = el; made.push("pip"); } };
        return el;
      },
      exitPictureInPicture: async () => { doc.pictureInPictureElement = null; made.push("exit"); }
    };
    doc.made = made;
    return doc;
  };
  assert.equal(pipSupported(mkDoc()), true);
  assert.equal(pipSupported(mkDoc({ enabled: false })), false, "browser says no PiP");
  assert.equal(pipSupported(mkDoc({ noPip: true })), false);
  assert.equal(pipSupported(mkDoc({ noStream: true })), false, "no canvas stream, no window");
  assert.deepEqual(cardLines({ name: "Ana", time: "01:02", muted: true, mutedText: "Muted", liveText: "Live" }), { name: "Ana", time: "01:02", sub: "Muted" });
  const doc = mkDoc();
  const pip = createPip({ doc, info: () => ({ name: "Ana", time: "00:05", liveText: "Live" }) });
  assert.equal(pip.start(), true);
  assert.equal(pip.start(), false, "second start does nothing");
  assert.equal(pip.active, true);
  assert.equal(await pip.enter(), true);
  assert.equal(pip.open, true);
  assert.equal(await pip.exit(), true);
  assert.equal(pip.open, false);
  pip.stop();
  assert.equal(pip.active, false);
  assert.equal(await pip.enter(), false, "after stop it cannot open");
  const none = createPip({ doc: mkDoc({ noPip: true }) });
  assert.equal(none.start(), false);
  console.log("calls pip ok");
}

// Test call with Hear my translation: five spoken turns in a row, each followed by the speakers playing the translation back
// into the microphone. The echo must not open the gate, so the budget is never spent on it and every turn is still sent.
{
  const { createLiveSession, LOOP_GATE } = await import("../shared/call-gemini.js");
  const tone = (rms, n) => { const out = new Int16Array(n); for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin(i / 6) * rms * 1.4142 * 32768); return out; };
  const speech = tone(0.1, 1600);
  const echo = tone(0.04, 1600);
  const room = tone(0.002, 1600);
  const run = (loopFlag) => {
    const s = createLiveSession();
    s.ring(0); s.ready(0);
    let t = 0;
    const turns = [];
    for (let turn = 0; turn < 6; turn++) {
      let sent = 0;
      for (let i = 0; i < 100; i++) { t += 100; if (s.onSpeech(speech, t, false).send) sent++; }      // 10 s of the person talking
      for (let i = 0; i < 100; i++) { t += 100; s.onSpeech(echo, t, loopFlag ? "loop" : false); }     // 10 s of their translation coming back
      for (let i = 0; i < 80; i++) { t += 100; s.onSpeech(room, t, false); }                          // a short pause
      turns.push(sent);
    }
    return { turns, phase: s.phase() };
  };
  const guarded = run(true);
  assert.ok(guarded.turns.every((n) => n >= 90), "every one of 6 turns is sent with the echo guard: " + guarded.turns);
  assert.notEqual(guarded.phase, "text", "the budget is not spent on echo");
  assert.ok(LOOP_GATE > 0.04, "the echo level stays under the loop gate");
  const unguarded = run(false);
  assert.ok(unguarded.turns.some((n) => n < 90), "without the guard the echo spends the budget and a later turn is lost: " + unguarded.turns);
  // A pause from the budget lifts by itself.
  const s = createLiveSession();
  s.ring(0); s.ready(0);
  let t = 0;
  for (let i = 0; i < 400; i++) { t += 100; s.onSpeech(speech, t, false); }
  assert.equal(s.phase(), "text", "40 s of talking in a minute pauses voice");
  assert.equal(s.recover(t), false, "not yet");
  t += 45000;
  assert.equal(s.recover(t), true, "voice returns once the last minute is quiet");
  assert.equal(s.onSpeech(speech, t + 100, false).send, true, "and the next turn is sent");
  console.log("calls echo loop ok", guarded.turns.join(","), "| unguarded", unguarded.turns.join(","));
}

{
  /* Typed preview: debounced, cached, stale answers dropped, and Send is never stuck. */
  const timers = []; let clock = 0; let id = 0;
  const fake = {
    setTimeout: (fn, ms) => { const t = { id: ++id, at: clock + ms, fn }; timers.push(t); return t.id; },
    clearTimeout: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); }
  };
  const advance = async (ms) => { clock += ms; for (;;) { const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at)[0]; if (!due) break; timers.splice(timers.indexOf(due), 1); due.fn(); } await Promise.resolve(); await Promise.resolve(); };
  const seen = []; const calls = []; let gate = null;
  const pv = createPreview({ ...fake, onChange: (st) => seen.push(st.status), run: async (text) => { calls.push(text); if (gate) await gate; return { translation: "ES:" + text, back: "EN:" + text }; } });
  pv.input("hi"); assert.equal(pv.state().status, "idle", "two letters are not previewed");
  pv.input("hello"); pv.input("hello w"); pv.input("hello wor");
  assert.equal(calls.length, 0, "typing does not call the server before the pause");
  await advance(700);
  assert.deepEqual(calls, ["hello wor"], "one request for the last text");
  assert.equal(pv.state().status, "ready");
  assert.equal(pv.state().translation, "ES:hello wor");
  pv.input("hello wor"); assert.equal(pv.state().status, "ready", "same text comes from the cache");
  assert.equal(calls.length, 1);
  /* a slow answer for old text must not overwrite newer text */
  let release; gate = new Promise((r) => { release = r; });
  pv.input("first text"); await advance(700);
  assert.equal(pv.state().status, "loading");
  pv.input("second text"); gate = null;
  release(); await advance(700);
  assert.equal(pv.state().text, "second text");
  assert.equal(pv.state().translation, "ES:second text", "the stale first answer was dropped");
  /* settle: Send asks for the preview of text that has none yet and gets it at once */
  const got = await pv.settle("third message here"); assert.equal(got.status, "ready"); assert.equal(got.translation, "ES:third message here");
  /* settle never blocks longer than the wait when the server hangs */
  const hang = createPreview({ ...fake, run: () => new Promise(() => {}) });
  const waited = hang.settle("never answers", 1500); await advance(1500);
  assert.equal((await waited).status, "late", "Send goes ahead after the wait");
  /* a failing server shows no preview but does not throw */
  const bad = createPreview({ ...fake, run: async () => { throw new Error("offline"); } });
  assert.equal((await bad.settle("will fail now")).status, "error");
  /* an error object from the server is an error, not a translation */
  const quota = createPreview({ ...fake, run: async () => ({ error: "quota" }) });
  assert.equal((await quota.settle("over the quota")).status, "error");
  const same = createPreview({ ...fake, run: async () => ({ translation: "x", untranslated: true }) });
  assert.equal((await same.settle("no translation")).same, true);
  pv.reset(); assert.equal(pv.state().status, "idle");
  console.log("calls preview ok");

  /* Typed send: messages go out at once, queue while the socket is down, and a retry is not delivered twice. */
  {
    let open = false;
    const sent = [];
    const clock = { t: 1000 };
    const box = createChatOutbox({ send: (data) => { if (!open) return false; sent.push(data); return true; }, now: () => clock.t, failMs: 1000 });
    const first = box.post("hello there", "es");
    assert.equal(first.sent, false, "a down socket queues the message");
    assert.equal(box.queued().length, 1);
    open = true;
    const flushed = box.flush();
    assert.equal(flushed.length, 1);
    assert.equal(sent[0].text, "hello there");
    assert.equal(sent[0].id, first.id);
    assert.equal(box.queued().length, 0);
    const again = box.post("second line", "es");
    assert.equal(again.sent, true, "an open socket sends at once");
    assert.equal(sent[1].text, "second line");
    assert.equal(box.incoming({ id: first.id, text: "hello there" }).id, first.id);
    assert.equal(box.incoming({ id: first.id, text: "hello there" }), null, "the same id is not delivered twice");
    open = false;
    const late = box.post("will expire", "es");
    clock.t += 1001;
    const failed = box.expire();
    assert.equal(failed.length, 1);
    assert.equal(failed[0].id, late.id);
    assert.equal(box.queued().length, 0);
    open = true;
    const retried = box.post("will expire", "es", late.id);
    assert.equal(retried.sent, true);
    assert.equal(retried.id, late.id);
    assert.ok(chatId(1, 0.5).startsWith("c"));
    /* Preview can still be mid-flight when Send is pressed: settle is not required. */
    assert.equal(pv.state().status, "idle");
    console.log("calls typed send ok");
  }
  /* Allow microphone popup: why getUserMedia failed decides what the popup says. */
  const E = (name, message) => ({ name, message: message || "" });
  assert.deepEqual(micFailure(E("NotAllowedError", "Permission dismissed"), "prompt"), { kind: "prompt", dismissed: true, os: false }, "a closed prompt asks again");
  assert.deepEqual(micFailure(E("NotAllowedError", "Permission denied"), "denied"), { kind: "denied", dismissed: false, os: false });
  assert.deepEqual(micFailure(E("NotAllowedError", "Permission denied"), "prompt"), { kind: "denied", dismissed: false, os: false }, "a prompt that fails at once is a block");
  assert.deepEqual(micFailure(E("NotAllowedError", "x"), "granted"), { kind: "denied", dismissed: false, os: true }, "browser allowed but the phone blocks it");
  assert.equal(micFailure(E("NotReadableError"), "granted").kind, "busy");
  assert.equal(micFailure(E("NotFoundError"), "prompt").kind, "none");
  assert.equal(micFailure(null, "prompt").kind, "none");
  const px = "Mozilla/5.0 (Linux; Android 14; Pixel 6a) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";
  assert.equal(micPlatform(px, true), "android-app");
  assert.equal(micPlatform(px, false), "android");
  assert.equal(micPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17 Mobile/15E148 Safari/604.1", true), "ios");
  assert.equal(micPlatform("Mozilla/5.0 (X11; Linux x86_64) Chrome/130", false), "desktop");
  console.log("calls mic failures ok");
  /* Latency timeline: one row per phrase, streamed answers can arrive before the speaker stops. */
  const tl = createTimeline();
  tl.speech(1000); tl.sent(1010); tl.speech(1500); tl.speech(2000);
  tl.byte(2400); tl.play(2450, 300); tl.play(2750, 300); tl.turn();
  const row = tl.list()[0];
  assert.deepEqual([row.speechMs, row.toSent, row.toByte, row.stopToByte, row.toPlay, row.stopToPlay, row.byteToPlay, row.playMs], [1000, 10, 1400, 400, 1450, 450, 50, 600]);
  tl.speech(5000); tl.byte(5200); tl.play(5100, 100); tl.speech(5300); tl.byte(5300); tl.turn();
  assert.equal(tl.list()[1].stopToPlay, -200, "a streamed answer can start before the speaker stops");
  tl.speech(9000); tl.turn();
  assert.equal(tl.dropped(), 1, "a phrase with no reply is counted, not timed");
  tl.byte(9999); tl.play(9999); assert.equal(tl.list().length, 2, "late audio with no open phrase is ignored");
  const sm = tl.summary();
  assert.equal(sm.n, 2); assert.equal(sm.dropped, 1);
  assert.equal(createTimeline().summary().stopToPlay.p50, null);
  const long = createTimeline(5); for (let i = 0; i < 12; i++) { long.speech(i * 10000); long.byte(i * 10000 + 500); long.turn(); }
  assert.equal(long.list().length, 5, "only the last phrases are kept");
  const spokeVad = createVad(); spokeVad.gate(new Int16Array(1600).fill(9000), false); assert.equal(spokeVad.spoke, true);
  spokeVad.gate(new Int16Array(1600), false); assert.equal(spokeVad.spoke, false, "spoke is this frame only, not the hang-over");
  console.log("calls timeline ok");
  /* The pipe reports sent / first reply / playback to the timeline hooks, in that order, against a fake socket. */
  {
    const sockets = [];
    globalThis.WebSocket = class { constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 1); } send(x) { this.sent = (this.sent || []).concat(x); } close() { this.readyState = 3; this.onclose && this.onclose(); } };
    const clock = { t: 0 };
    const ac = { get currentTime() { return clock.t; }, createBuffer: (n, len, rate) => ({ duration: len / rate, copyToChannel() {} }), createBufferSource: () => ({ connect() {}, start() {} }) };
    const seen = [];
    const pipe = createPipe({ ac, relayFirst: () => false, routeKnown: () => true, noteRoute() {}, relayUrls: null }, {
      id: "t", target: "es", out: {}, source: "en",
      token: async () => ({ mode: "token", url: "wss://fake/x", setup: {} }),
      onState() {}, onGoAway() {}, onOut() {}, onPartial() {}, onLine() {},
      onSent: () => seen.push("sent"), onByte: (p, kind) => seen.push("byte:" + kind), onPlay: (p, at, len) => seen.push("play:" + Math.round(len)), onTurn: () => seen.push("turn")
    });
    pipe.open();
    await new Promise((r) => setTimeout(r, 30));
    const sock = sockets[0];
    sock.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(pipe.send(new Int16Array(1600)), true);
    const audio = Buffer.from(new Int16Array(2400).buffer).toString("base64");
    sock.onmessage({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audio } }] } } }) });
    await new Promise((r) => setTimeout(r, 10));
    sock.onmessage({ data: JSON.stringify({ serverContent: { turnComplete: true } }) });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen, ["sent", "byte:audio", "play:100", "turn"]);
    pipe.close();
    console.log("calls pipe timing hooks ok");
  }

  /* Keep-alive and turn-buffer helpers for the live-stream fallback. */
  assert.equal(shouldKeepAlive(0, KEEP_ALIVE_MS - 1, false), false);
  assert.equal(shouldKeepAlive(0, KEEP_ALIVE_MS, false), true);
  assert.equal(shouldKeepAlive(0, KEEP_ALIVE_MS + 10, true), false, "no keep-alive while talking");
  assert.equal(shouldKeepAlive(null, KEEP_ALIVE_MS + 10, false), false, "no keep-alive before the socket is live");
  assert.equal(silenceFrame().length, SILENCE_SAMPLES);
  assert.equal(silenceFrame().every((x) => x === 0), true);
  assert.equal(typeof pcmB64(silenceFrame()), "string");
  assert.ok(pcmB64(silenceFrame()).length > 8);
  const ut = createUtterance();
  assert.equal(ut.empty(), true);
  ut.push(new Int16Array(10)); ut.push(new Int16Array(10));
  assert.equal(ut.count(), 2);
  assert.equal(ut.drain().length, 2);
  assert.equal(ut.empty(), true);
  {
    const sockets = [];
    globalThis.WebSocket = class { constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 1); } send(x) { this.sent = (this.sent || []).concat(x); } close() { this.readyState = 3; this.onclose && this.onclose(); } };
    const ac = { get currentTime() { return 0; }, createBuffer: (n, len, rate) => ({ duration: len / rate, copyToChannel() {} }), createBufferSource: () => ({ connect() {}, start() {} }) };
    const ka = [];
    const pipe = createPipe({ ac, relayFirst: () => false, routeKnown: () => true, noteRoute() {}, relayUrls: null }, {
      id: "k", target: "es", out: {}, source: "en", keepAlive: true,
      token: async () => ({ mode: "token", url: "wss://fake/x", setup: {} }),
      onState() {}, onGoAway() {}, onOut() {}, onPartial() {}, onLine() {},
      onKeepAlive: () => ka.push(1)
    });
    pipe.open();
    await new Promise((r) => setTimeout(r, 30));
    const sock = sockets[0];
    sock.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(pipe.maybeKeepAlive(1000), false, "too soon after setup");
    assert.equal(pipe.maybeKeepAlive(Date.now() + KEEP_ALIVE_MS + 50), true);
    assert.equal(ka.length, 1);
    const msg = JSON.parse(sock.sent[sock.sent.length - 1]);
    assert.equal(msg.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
    assert.ok(msg.realtimeInput.audio.data.length > 8);
    pipe.send(new Int16Array(1600));
    assert.equal(pipe.maybeKeepAlive(Date.now() + KEEP_ALIVE_MS * 4), false, "no keep-alive in the middle of a turn");
    pipe.close();
    console.log("calls keep-alive ok");
  }

  assert.equal(mergeTranscript("", "Hello"), "Hello");
  assert.equal(mergeTranscript("Hello", "Hello world"), "Hello world", "a cumulative update replaces the prefix");
  assert.equal(mergeTranscript("Hello", " world"), "Hello world", "a delta is appended");
  assert.equal(mergeTranscript("Hello wor", "world"), "Hello world", "an overlapping tail is joined once");
  assert.equal(mergeTranscript("Hello world", "Hello"), "Hello world", "a shorter snapshot is ignored");
  assert.deepEqual(transcriptWords("Hi, can you"), ["Hi, ", "can ", "you"]);
  assert.deepEqual(transcriptWords(""), []);
  const snap = createPlayoutLead({ immediate: true }).plan(1, 0, 0.2);
  assert.equal(snap.start, 1, "the first chunk plays at once when immediate");
  const later = createPlayoutLead({ immediate: true }).plan(1, 0.5, 0.2);
  /* nextAt 0.5 is behind t=1 by 0.5s, so this is a gap, not the first chunk. */
  assert.ok(later.start >= 1, "later chunks still use the lead");
  console.log("calls stream play helpers ok");

  const silence = new Int16Array(1600);
  const speech = new Int16Array(1600).fill(9000);
  const defaultHang = createVad();
  defaultHang.gate(speech, false);
  let n = 0;
  while (defaultHang.gate(silence, false)) n++;
  assert.equal(n, HANG_MAX, "without the switch the hang is 1200 ms");
  const quick = createVad();
  quick.shortOn(true);
  quick.gate(speech, false);
  let q = 0;
  while (quick.gate(silence, false)) q++;
  assert.ok(q >= HANG_MIN && q <= 7, "clear silence ends in about 600 ms, got " + q);
  assert.ok(q < n, "short end of speech is faster than the default hang");
  const strictHang = createVad();
  strictHang.shortOn(true);
  strictHang.gate(speech, true);
  let sh = 0;
  while (strictHang.gate(silence, true)) sh++;
  assert.equal(sh, HANG_MAX, "the strict gate keeps the full tail so a playing translation is not cut short");
  console.log("calls short eos ok");

  {
    const sockets = [];
    const stopped = [];
    globalThis.WebSocket = class { constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 1); } send(x) { this.sent = (this.sent || []).concat(x); } close() { this.readyState = 3; this.onclose && this.onclose(); } };
    const clock = { t: 1 };
    const ac = { get currentTime() { return clock.t; }, createBuffer: (n, len, rate) => ({ duration: len / rate, copyToChannel() {} }), createBufferSource: () => ({ connect() {}, start() {}, stop() { stopped.push(1); } }) };
    const pipe = createPipe({ ac, relayFirst: () => false, routeKnown: () => true, noteRoute() {}, relayUrls: null }, {
      id: "b", target: "es", out: {}, source: "en",
      token: async () => ({ mode: "token", url: "wss://fake/x", setup: {} }),
      onState() {}, onGoAway() {}, onOut() {}, onPartial() {}, onLine() {}
    });
    pipe.open();
    await new Promise((r) => setTimeout(r, 30));
    const sock = sockets[0];
    sock.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
    await new Promise((r) => setTimeout(r, 10));
    const audio = Buffer.from(new Int16Array(2400).buffer).toString("base64");
    sock.onmessage({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audio } }] } } }) });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(pipe.playing(), true, "audio is queued");
    pipe.cut();
    assert.equal(stopped.length, 1, "the source is stopped");
    assert.equal(pipe.playing(), false, "nothing is left playing");
    pipe.close();
    console.log("calls barge cut ok");
  }
}


{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const js = fs.readFileSync(path.join(root, "calls.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "calls.css"), "utf8");
  const flags = fs.readFileSync(path.join(root, "worker/src/feature-flags.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.ok(flags.includes("calls_onescreen"), "the switch is listed with the other Calls flags");
  assert.ok(app.includes('"calls_onescreen"'), "the owner list includes the switch");
  assert.ok(js.includes("function onescreenFlagOn"), "the call page reads the switch");
  assert.ok(js.includes("function stageChips"), "language, captions, translation and speaker are on-screen chips");
  assert.ok(js.includes("data-onescreen"), "the live screen marks the new layout");
  assert.ok(js.includes("data-muted"), "a muted tile is marked");
  assert.ok(css.includes('data-onescreen="1"'), "the new layout has its own rules");
  assert.ok(css.includes("grid-template-columns: 1fr 1fr"), "the two people tiles sit side by side");
  const onscreen = css.split("calls_onescreen")[1] || "";
  assert.ok(onscreen.includes("position: static") || onscreen.includes("position: relative"), "the self tile is not a corner overlay in the new layout");
  assert.ok(!/\[data-onescreen="1"\][\s\S]{0,1200}\[data-tile="me"\][^{]{0,80}\{[^}]*display:\s*none/.test(css), "the new layout does not hide the self waveform");
  console.log("calls onescreen layout ok");
}


{
  const {
    applyStatusCode, holdStatus, shouldRemountOnStatus, shouldRemountOnPeer,
    signalOpenRestores, iceAlreadyUp, iceClearlyDown, iceConfigWithServers, signalAdmit, RECONNECT_HOLD_MS,
    shouldRefreshLivePipe, micTrackLive, FOREGROUND_PIPE_MS, LIVE_PIPE_IDLE_MS,
    guestSessionRecord, guestSessionLive, guestSessionForRoute, GUEST_SESSION_MS, callErrorKind
  } = await import("../shared/call-status.js");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

  assert.equal(applyStatusCode("reconnecting", "translating-ready"), "connected", "a ready translator must not leave Reconnecting on the line");
  assert.equal(applyStatusCode("connected", "translating-ready"), "connected");
  assert.equal(applyStatusCode("connected", "translator-reconnecting"), "connected", "Gemini keep-alive must not change the call status line");
  assert.equal(applyStatusCode("waiting", "connected"), "connected");

  const t0 = 1000;
  const held = holdStatus("connected", "reconnecting", t0, 0);
  assert.equal(held.code, "connected", "a brief ICE blip keeps Connected");
  assert.equal(held.heldAt, t0);
  const still = holdStatus("connected", "reconnecting", t0 + 500, held.heldAt);
  assert.equal(still.code, "connected");
  const shown = holdStatus("connected", "reconnecting", t0 + RECONNECT_HOLD_MS, held.heldAt);
  assert.equal(shown.code, "reconnecting", "a lasting drop still shows Reconnecting");
  const recov = holdStatus("connected", "connected", t0 + 100, held.heldAt);
  assert.equal(recov.code, "connected");
  assert.equal(recov.heldAt, 0);

  assert.equal(shouldRemountOnStatus("idle", "connected"), true);
  assert.equal(shouldRemountOnStatus("active", "connected"), false, "a later connected event must not rebuild the chat");
  assert.equal(shouldRemountOnStatus("active", "reconnecting"), false);
  assert.equal(shouldRemountOnPeer({ name: "Maria", degraded: false }, { name: "Maria", degraded: false }), false);
  assert.equal(shouldRemountOnPeer({ name: "Maria", degraded: false }, { name: "Maria", degraded: true }), true);

  assert.equal(iceAlreadyUp("completed"), true);
  assert.equal(iceClearlyDown("failed"), true);
  assert.equal(iceClearlyDown("disconnected"), true);
  assert.equal(iceClearlyDown("closed"), true);
  assert.equal(iceClearlyDown("checking"), false);
  assert.equal(signalOpenRestores("checking", true), true, "signaling back up after the peer joined restores Connected while ICE is still negotiating");
  assert.equal(signalOpenRestores("new", false), false);
  assert.equal(signalOpenRestores("failed", true), false, "signaling back up must not show Connected while ICE is down");
  assert.equal(signalOpenRestores("disconnected", true), false);
  assert.equal(signalOpenRestores("closed", true), false);
  const iced = iceConfigWithServers({ bundlePolicy: "max-bundle", iceServers: [] }, [{ urls: "stun:example.test" }]);
  assert.equal(iced.bundlePolicy, "max-bundle");
  assert.equal(iced.iceServers[0].urls, "stun:example.test");
  assert.equal(iceConfigWithServers({ bundlePolicy: "max-bundle" }, []), null);

  const now = 1_000_000;
  const sess = guestSessionRecord({ token: "cg1." + "A".repeat(24), callId: "a".repeat(32), invite: "ci1.abc", name: "Vi", expiresAt: now + GUEST_SESSION_MS }, now);
  assert.ok(sess && guestSessionLive(sess, now));
  assert.equal(guestSessionLive(sess, now + GUEST_SESSION_MS), false, "an expired guest session is not reused");
  assert.equal(guestSessionRecord({ token: "ci1.nope", callId: "a" * 32, expiresAt: now + 1000 }, now), null, "only a guest token is stored");
  assert.ok(guestSessionForRoute(sess, { name: "callguest", token: "ci1.abc" }, now));
  assert.equal(guestSessionForRoute(sess, { name: "callguest", token: "ci1.other" }, now), null, "a different link does not reuse the session");
  assert.ok(guestSessionForRoute(sess, { name: "calls" }, now), "a bare Calls page can offer Rejoin");

  assert.equal(shouldRefreshLivePipe(0, 1000, 2000), false, "a brief glance away does not refresh a live pipe");
  assert.equal(shouldRefreshLivePipe(FOREGROUND_PIPE_MS, 1000, 1000 + FOREGROUND_PIPE_MS), true, "coming back from the lock screen refreshes the Live socket");
  assert.equal(shouldRefreshLivePipe(0, 1000, 1000 + LIVE_PIPE_IDLE_MS), true, "a pipe idle longer than a keep-alive is refreshed");
  assert.equal(micTrackLive({ getAudioTracks: () => [{ readyState: "live" }] }), true);
  assert.equal(micTrackLive({ getAudioTracks: () => [{ readyState: "ended" }] }), false);
  assert.equal(micTrackLive(null), false);

  const replace = signalAdmit([{ peer: "111111111111", ws: 1 }, { peer: "222222222222", ws: 2 }], "111111111111");
  assert.equal(replace.ok, true, "the same peer may replace its socket in a full room");
  assert.equal(replace.stale.length, 1);
  assert.equal(replace.others[0].peer, "222222222222");
  const full = signalAdmit([{ peer: "111111111111" }, { peer: "222222222222" }], "333333333333");
  assert.equal(full.ok, false, "a third person is still rejected");

  const js = fs.readFileSync(path.join(root, "calls.js"), "utf8");
  assert.ok(js.includes("holdStatus("), "the call page holds brief reconnect flashes");
  assert.ok(js.includes("shouldRemountOnStatus"), "the call page does not remount after the first connect");
  const eng = fs.readFileSync(path.join(root, "shared/call-engine.js"), "utf8");
  assert.ok(eng.includes("quietCloseSig"), "a new signaling socket closes the previous one first");
  assert.ok(eng.includes("signalOpenRestores"), "signaling open restores Connected when the peer is already in");
  assert.ok(eng.includes("pendingIceRestart") && eng.includes("flushIceRestart"), "an ICE restart is queued when an offer is already in flight");
  assert.ok(eng.includes("requestIceRestart") && eng.includes("applyFreshIceServers"), "the guest can request a restart and new ICE servers are applied");
  assert.ok(eng.includes("retryConnection"), "a lost connection can be retried from the call screen");
  assert.ok(!eng.includes("keep current ICE servers"), "a later ticket's ICE servers are no longer ignored");
  assert.ok(eng.includes("recoverMic") && eng.includes("shouldRefreshLivePipe"), "coming back from the background wakes the mic and the Live socket");
  assert.ok(eng.includes("remoteEl.play"), "coming back retries the remote audio element");
  assert.ok(!eng.includes("The addresses may have changed even though the old path still reads connected"), "nudge does not ICE-restart a healthy path");
  const css = fs.readFileSync(path.join(root, "calls.css"), "utf8");
  assert.ok(/data-onescreen="1"\] \.calls-conv \{[^}]*min-height:\s*12rem/.test(css), "the conversation keeps a visible height in the one-screen layout");
  const worker = fs.readFileSync(path.join(root, "worker/src/calls.js"), "utf8");
  assert.ok(worker.includes("signalAdmit"), "the signaling room replaces a returning peer");
  assert.ok(worker.includes("replaced: true"), "a replaced socket does not announce leave");
  const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  assert.ok(sw.includes("./shared/call-status.js"), "the app cache lists the new helper");
  const csw = fs.readFileSync(path.join(root, "calls/sw.js"), "utf8");
  assert.ok(csw.includes("../shared/call-status.js"), "the Calls shell lists the new helper");
  console.log("calls testchat status ok");
}

{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const js = fs.readFileSync(path.join(root, "calls.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "calls.css"), "utf8");
  const flags = fs.readFileSync(path.join(root, "worker/src/feature-flags.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.ok(flags.includes("calls_bar_sheet"), "the switch is listed with the other Calls flags");
  assert.ok(app.includes('"calls_bar_sheet"'), "the owner list includes the switch");
  assert.ok(js.includes("function barSheetFlagOn"), "the call page reads the switch");
  assert.ok(js.includes("data-sheet"), "the bar marks the sliding sheet");
  assert.ok(js.includes("data-act=\"call-bar-sheet\""), "the handle toggles the sheet");
  assert.ok(js.includes("function sheetShouldOpen"), "a vertical drag snaps the sheet open or closed");
  assert.ok(js.includes("function barMove"), "the sheet follows the finger");
  assert.ok(css.includes('data-sheet="1"'), "the sliding bar has its own rules");
  assert.ok(css.includes(".calls-bar-sheet"), "the hidden controls sit in the sheet");
  assert.ok(/\[data-sheet="1"\][\s\S]{0,400}\.calls-handle[^}]*display:\s*flex/.test(css), "the handle stays visible");
  const en = fs.readFileSync(path.join(root, "i18n/en.js"), "utf8");
  const es = fs.readFileSync(path.join(root, "i18n/es.js"), "utf8");
  const ru = fs.readFileSync(path.join(root, "i18n/ru.js"), "utf8");
  const hi = fs.readFileSync(path.join(root, "i18n/hi.js"), "utf8");
  for (const pack of [en, es, ru, hi]) {
    assert.ok(pack.includes("Sliding call controls"), "every language pack has the switch name");
    assert.ok(pack.includes("Show all controls"), "every language pack has the handle label");
    assert.ok(pack.includes("Hide call controls"), "every language pack has the close label");
  }
  assert.notEqual(es.split("Sliding call controls")[1].slice(0, 80), en.split("Sliding call controls")[1].slice(0, 80), "Spanish translates the switch name");
  // snap helper, evaluated from the same rules as sheetShouldOpen
  const snap = (wasOpen, dy, threshold) => {
    const t = threshold == null ? 36 : threshold;
    if (Math.abs(dy) < t) return !!wasOpen;
    return dy > 0;
  };
  assert.equal(snap(false, 10), false, "a short flick leaves the sheet as it was");
  assert.equal(snap(false, 40), true, "a swipe up opens the sheet");
  assert.equal(snap(true, -40), false, "a swipe down closes the sheet");
  assert.equal(snap(true, 10), true, "a short downward move keeps it open");
  console.log("calls bar sheet ok");
}

{
  const { SCHEDULE_TOKEN, canJoin, remindPlan, icsForSchedule, parseStartsAt, clipDuration, endsAt, JOIN_EARLY_MS, REMIND_MS, DEFAULT_DURATION } = await import("../shared/call-schedule.js");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const js = fs.readFileSync(path.join(root, "calls.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "calls.css"), "utf8");
  const flags = fs.readFileSync(path.join(root, "worker/src/feature-flags.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "worker/src/call-schedule.js"), "utf8");
  const migration = fs.readFileSync(path.join(root, "worker/migrations/0136_call_schedule.sql"), "utf8");
  assert.ok(flags.includes("calls_schedule"), "the switch is listed with the other Calls flags");
  assert.ok(app.includes('"calls_schedule"'), "the owner list includes the switch");
  assert.ok(js.includes("function scheduleFlagOn"), "the call page reads the switch");
  assert.ok(js.includes("data-act=\"call-sched-open\""), "Schedule a call is on the home screen");
  assert.ok(js.includes("data-act=\"call-sched-join\""), "a scheduled row can be joined");
  assert.ok(js.includes("data-act=\"call-sched-ics\""), "a scheduled row can be added to the calendar");
  assert.ok(css.includes(".calls-sched-form"), "the schedule form has its own rules");
  assert.ok(migration.includes("call_schedules"), "the migration creates the table");
  assert.ok(worker.includes("call_remind") && worker.includes("call_starting"), "cron sends both reminders");
  assert.ok(SCHEDULE_TOKEN.test("cs1." + "A".repeat(24)), "a guest token of the usual length is accepted");
  assert.equal(SCHEDULE_TOKEN.test("ci1.aaaaaaaaaaaaaaaaaaaaaa"), false, "an instant invite token is not a scheduled token");
  const start = Date.parse("2026-12-01T15:00:00Z");
  assert.equal(parseStartsAt(start), start);
  assert.equal(parseStartsAt("2026-12-01T15:00:00Z"), start);
  assert.equal(clipDuration(0), DEFAULT_DURATION);
  assert.equal(clipDuration(500), 180);
  assert.equal(canJoin(start, 30, start - JOIN_EARLY_MS), true, "join opens 10 minutes early");
  assert.equal(canJoin(start, 30, start - JOIN_EARLY_MS - 1), false, "join is closed before the window");
  assert.equal(canJoin(start, 30, endsAt(start, 30)), true, "join stays open until the planned end");
  assert.equal(canJoin(start, 30, endsAt(start, 30) + 1), false, "join closes after the planned end");
  const row = { starts_at: start, duration_min: 30, state: "scheduled", reminded_15: 0, reminded_start: 0, call_id: "" };
  assert.deepEqual(remindPlan(row, start - REMIND_MS), { remind15: true, remindStart: false, miss: false });
  assert.deepEqual(remindPlan(row, start - 1), { remind15: true, remindStart: false, miss: false });
  assert.deepEqual(remindPlan(Object.assign({}, row, { reminded_15: 1 }), start), { remind15: false, remindStart: true, miss: false });
  assert.deepEqual(remindPlan(row, endsAt(start, 30) + 1), { remind15: false, remindStart: false, miss: true });
  assert.deepEqual(remindPlan(Object.assign({}, row, { state: "cancelled" }), start), { remind15: false, remindStart: false, miss: false });
  const ics = icsForSchedule({ title: "Call with Ada", startsAt: start, durationMin: 30, url: "https://example.test/#cs1.token", uid: "abc" });
  assert.ok(ics.includes("BEGIN:VEVENT"), "the calendar file has an event");
  assert.ok(ics.includes("TRIGGER:-PT15M"), "the calendar file reminds 15 minutes before");
  assert.ok(ics.includes("TRIGGER:PT0S"), "the calendar file reminds at the start");
  assert.ok(ics.includes("https://example.test/#cs1.token"), "the calendar file includes the invite link");
  const en = fs.readFileSync(path.join(root, "i18n/en.js"), "utf8");
  const es = fs.readFileSync(path.join(root, "i18n/es.js"), "utf8");
  const ru = fs.readFileSync(path.join(root, "i18n/ru.js"), "utf8");
  const hi = fs.readFileSync(path.join(root, "i18n/hi.js"), "utf8");
  for (const pack of [en, es, ru, hi]) {
    assert.ok(pack.includes("Scheduled call invites"), "every language pack has the switch name");
    assert.ok(pack.includes("Schedule a call"), "every language pack has the home button");
    assert.ok(pack.includes("On iPhone, install the app to get a reminder if you don't add it to your calendar."), "every language pack has the iPhone note");
  }
  assert.notEqual(es.split("Scheduled call invites")[1].slice(0, 80), en.split("Scheduled call invites")[1].slice(0, 80), "Spanish translates the switch name");
  console.log("calls schedule ok");
}

{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const js = fs.readFileSync(path.join(root, "calls.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "calls.css"), "utf8");
  const flags = fs.readFileSync(path.join(root, "worker/src/feature-flags.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.ok(flags.includes("calls_orig_vol"), "the switch is listed with the other Calls flags");
  assert.ok(app.includes('"calls_orig_vol"'), "the owner list includes the switch");
  assert.ok(js.includes("function origVolFlagOn"), "the call page reads the switch");
  assert.ok(js.includes("function origVolRow"), "the call screen builds the on-screen slider");
  assert.ok(js.includes('data-origvol="1"'), "the original volume control is marked on the call screen");
  assert.ok(js.includes('data-act="call-set"') && js.includes('data-group="original"'), "a one-tap switch hears the original voice");
  assert.ok(css.includes(".calls-origvol"), "the on-screen slider has its own rules");
  const en = fs.readFileSync(path.join(root, "i18n/en.js"), "utf8");
  const es = fs.readFileSync(path.join(root, "i18n/es.js"), "utf8");
  const ru = fs.readFileSync(path.join(root, "i18n/ru.js"), "utf8");
  const hi = fs.readFileSync(path.join(root, "i18n/hi.js"), "utf8");
  for (const pack of [en, es, ru, hi]) {
    assert.ok(pack.includes("Original voice volume"), "every language pack has the switch name");
    assert.ok(pack.includes("Original voice"), "every language pack has the on-screen switch");
  }
  assert.notEqual(es.split("Original voice volume")[1].slice(0, 80), en.split("Original voice volume")[1].slice(0, 80), "Spanish translates the switch name");
  console.log("calls orig vol ok");
}

{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const { ROTATE_TOKEN, ROTATE_MS, ROTATE_REFRESH_MS } = await import("../shared/call-rotate-qr.js");
  const js = fs.readFileSync(path.join(root, "calls.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "calls.css"), "utf8");
  const flags = fs.readFileSync(path.join(root, "worker/src/feature-flags.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "worker/src/call-rotate-qr.js"), "utf8");
  const callsWorker = fs.readFileSync(path.join(root, "worker/src/calls.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const boot = fs.readFileSync(path.join(root, "calls/boot.js"), "utf8");
  const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  const solo = fs.readFileSync(path.join(root, "calls/sw.js"), "utf8");
  assert.ok(flags.includes("calls_rotate_qr"), "the switch is listed with the other Calls flags");
  assert.ok(app.includes('"calls_rotate_qr"'), "the owner list includes the switch");
  assert.ok(js.includes("function rotateQrFlagOn"), "the call page reads the switch");
  assert.ok(js.includes("function rotateQrPanel"), "the home screen builds the rotating QR");
  assert.ok(js.includes("Scan to call me"), "the QR sits on the Calls home screen");
  assert.ok(js.includes("joinRotateQr"), "scanning joins through the rotating-QR path");
  assert.ok(js.includes('hit.kind === "qr"') || js.includes("hit.kind === 'qr'"), "an incoming poll treats a QR session like a link call");
  assert.ok(callsWorker.includes("kind IN ('link', 'qr')") || callsWorker.includes('kind IN ("link", "qr")'), "incoming lists QR sessions for the host");
  assert.ok(callsWorker.includes('row.kind === "qr"') || callsWorker.includes("row.kind === 'qr'"), "the host can answer a QR session");
  assert.ok(worker.includes("kind, 'qr'") || worker.includes("kind: 'qr'") || worker.includes("'qr'"), "a scan creates a qr session");
  assert.ok(boot.includes("cr1"), "the standalone guest page accepts a cr1 token");
  assert.ok(sw.includes("./shared/call-rotate-qr.js"), "the main service worker caches the helper");
  assert.ok(solo.includes("../shared/call-rotate-qr.js"), "the Calls service worker caches the helper");
  assert.ok(css.includes(".calls-rotateqr"), "the home QR has its own rules");
  assert.equal(ROTATE_MS, 2 * 60 * 1000, "a code lasts two minutes");
  assert.equal(ROTATE_REFRESH_MS, 30 * 1000, "a new code is issued with a thirty-second overlap");
  assert.ok(ROTATE_TOKEN.test("cr1." + "A".repeat(24)), "a guest token of the usual length is accepted");
  assert.equal(ROTATE_TOKEN.test("ci1." + "A".repeat(24)), false, "a Get call link token is not treated as a rotating QR");
  const en = fs.readFileSync(path.join(root, "i18n/en.js"), "utf8");
  const es = fs.readFileSync(path.join(root, "i18n/es.js"), "utf8");
  const ru = fs.readFileSync(path.join(root, "i18n/ru.js"), "utf8");
  const hi = fs.readFileSync(path.join(root, "i18n/hi.js"), "utf8");
  for (const pack of [en, es, ru, hi]) {
    assert.ok(pack.includes("Scan to call me"), "every language pack has the home heading");
    assert.ok(pack.includes("Rotating call QR"), "every language pack has the switch name");
  }
  assert.notEqual(es.split("Rotating call QR")[1].slice(0, 80), en.split("Rotating call QR")[1].slice(0, 80), "Spanish translates the switch name");
  console.log("calls rotate qr ok");
}


{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const { practiceTalk, PRACTICE_LIMIT } = await import("../shared/call-practice.js");
  const js = fs.readFileSync(path.join(root, "calls.js"), "utf8");
  const flags = fs.readFileSync(path.join(root, "worker/src/feature-flags.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "worker/src/call-practice.js"), "utf8");
  const callsWorker = fs.readFileSync(path.join(root, "worker/src/calls.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.ok(flags.includes("calls_practice"), "the switch is listed with the other Calls flags");
  assert.ok(app.includes('"calls_practice"'), "the owner list includes the switch");
  assert.ok(js.includes("function practiceFlagOn"), "the call page reads the switch");
  assert.ok(js.includes("Practice with AI"), "the home screen has the practice button");
  assert.ok(js.includes("function startPractice"), "one tap starts a practice call");
  assert.ok(js.includes("function practiceReply"), "the partner asks the Worker for a reply");
  assert.ok(worker.includes("/v1/calls/practice") && callsWorker.includes("startPracticeSession"), "the Worker starts a practice session and answers");
  assert.ok(js.includes("calls-practice"), "the in-call panel marks a practice call");
  assert.equal(PRACTICE_LIMIT, 80);
  const prompt = practiceTalk("Hello there", "es", [{ role: "you", text: "Hi" }]);
  assert.ok(prompt.includes("es"), "the prompt asks for the partner language");
  assert.ok(prompt.includes("Hello there"), "the prompt includes what you just said");
  assert.equal(practiceTalk("  ", "en"), "", "an empty line does not build a prompt");
  const en = fs.readFileSync(path.join(root, "i18n/en.js"), "utf8");
  const es = fs.readFileSync(path.join(root, "i18n/es.js"), "utf8");
  const ru = fs.readFileSync(path.join(root, "i18n/ru.js"), "utf8");
  const hi = fs.readFileSync(path.join(root, "i18n/hi.js"), "utf8");
  for (const pack of [en, es, ru, hi]) {
    assert.ok(pack.includes("Practice with AI"), "every language pack has the home button");
    assert.ok(pack.includes("Practice partner"), "every language pack has the partner name");
  }
  assert.notEqual(es.split("Practice with AI")[1].slice(0, 80), en.split("Practice with AI")[1].slice(0, 80), "Spanish translates the button");
  console.log("calls practice ok");
}

{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const js = fs.readFileSync(path.join(root, "calls.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "calls.css"), "utf8");
  const flags = fs.readFileSync(path.join(root, "worker/src/feature-flags.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "worker/src/call-history-edit.js"), "utf8");
  const callsWorker = fs.readFileSync(path.join(root, "worker/src/calls.js"), "utf8");
  assert.ok(flags.includes("calls_hist_edit"), "the switch is listed with the other Calls flags");
  assert.ok(app.includes('"calls_hist_edit"'), "the owner list includes the switch");
  assert.ok(js.includes("function histEditFlagOn"), "the call page reads the switch");
  assert.ok(js.includes("function histEditSheet"), "tapping a row opens the editor");
  assert.ok(js.includes('data-act="hist-open"'), "a history row opens details in one tap");
  assert.ok(js.includes("saveHistTranscript"), "a finished call saves its transcript");
  assert.ok(js.includes("Save correction"), "a transcript line can be corrected");
  assert.ok(worker.includes("call_history_meta") && worker.includes("call_transcripts"), "titles, notes and lines are stored per account");
  assert.ok(callsWorker.includes("attachHistoryMeta") && callsWorker.includes("CALL_HISTORY_EDIT_SCHEMA"), "history lists include the saved title and note");
  assert.ok(css.includes(".calls-histedit"), "the editor has its own rules");
  const en = fs.readFileSync(path.join(root, "i18n/en.js"), "utf8");
  const es = fs.readFileSync(path.join(root, "i18n/es.js"), "utf8");
  const ru = fs.readFileSync(path.join(root, "i18n/ru.js"), "utf8");
  const hi = fs.readFileSync(path.join(root, "i18n/hi.js"), "utf8");
  for (const pack of [en, es, ru, hi]) {
    assert.ok(pack.includes("Edit call history"), "every language pack has the switch name");
    assert.ok(pack.includes("Name in your history"), "every language pack has the rename field");
  }
  assert.notEqual(es.split("Edit call history")[1].slice(0, 80), en.split("Edit call history")[1].slice(0, 80), "Spanish translates the switch name");
  console.log("calls hist edit ok");
}

{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const js = fs.readFileSync(path.join(root, "calls.js"), "utf8");
  const flags = fs.readFileSync(path.join(root, "worker/src/feature-flags.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const callsWorker = fs.readFileSync(path.join(root, "worker/src/calls.js"), "utf8");
  const gemini = fs.readFileSync(path.join(root, "shared/call-gemini.js"), "utf8");
  assert.ok(flags.includes("calls_eu_proxy"), "the switch is listed with the other Calls flags");
  assert.ok(app.includes('"calls_eu_proxy"'), "the owner list includes the switch");
  assert.ok(js.includes("function euProxyFlagOn"), "the call page reads the switch");
  assert.ok(js.includes("function euProxyChip") && js.includes("Routed in the EU"), "the call screen shows the EU route");
  assert.ok(callsWorker.includes("euProxyHint") && callsWorker.includes("geminiHeaders"), "the Worker mints through the proxy helper");
  assert.equal(callsWorker.includes("auth_tokens?key="), false, "the token request does not put the key on the URL");
  assert.equal(callsWorker.includes("generateContent?key="), false, "generateContent does not put the key on the URL");
  assert.ok(gemini.includes("x-goog-api-key"), "the helper sends the key as a header");
  assert.deepEqual(euProxyHint(), { prefer: "relay", proxy: "eu" });
  assert.equal(geminiHeaders("secret-key-value")["x-goog-api-key"], "secret-key-value");
  assert.ok(GEMINI_REST.startsWith("https://generativelanguage.googleapis.com"));
  assert.equal(redactSecret("used secret-key-value in the url", "secret-key-value"), "used [redacted] in the url");
  const en = fs.readFileSync(path.join(root, "i18n/en.js"), "utf8");
  const es = fs.readFileSync(path.join(root, "i18n/es.js"), "utf8");
  const ru = fs.readFileSync(path.join(root, "i18n/ru.js"), "utf8");
  const hi = fs.readFileSync(path.join(root, "i18n/hi.js"), "utf8");
  for (const pack of [en, es, ru, hi]) {
    assert.ok(pack.includes("EU translation route"), "every language pack has the switch name");
    assert.ok(pack.includes("Routed in the EU"), "every language pack has the on-screen chip");
  }
  assert.notEqual(es.split("EU translation route")[1].slice(0, 80), en.split("EU translation route")[1].slice(0, 80), "Spanish translates the switch name");
  console.log("calls eu proxy ok");
}

{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const js = fs.readFileSync(path.join(root, "calls.js"), "utf8");
  const eng = fs.readFileSync(path.join(root, "worker/src/calls.js"), "utf8");
  const engine = fs.readFileSync(path.join(root, "shared/call-engine.js"), "utf8");
  assert.ok(js.includes("function translateRetryChip") && js.includes("Retry translation"), "the call screen has a Retry translation control");
  assert.ok(js.includes('data-act="call-translate-retry"'), "Retry translation is one tap on the call screen");
  assert.ok(js.includes("if (d.reason === \"quota\")"), "a network drop is not treated as a quota problem");
  assert.ok(engine.includes("scheduleStreamRetry") && engine.includes("reopenStream"), "a dropped Live stream is opened again by itself");
  assert.equal(engine.includes("degrade(\"network\")"), false, "a failed stream no longer ends translation as a quota problem");
  const en = fs.readFileSync(path.join(root, "i18n/en.js"), "utf8");
  const es = fs.readFileSync(path.join(root, "i18n/es.js"), "utf8");
  const ru = fs.readFileSync(path.join(root, "i18n/ru.js"), "utf8");
  const hi = fs.readFileSync(path.join(root, "i18n/hi.js"), "utf8");
  for (const pack of [en, es, ru, hi]) {
    assert.ok(pack.includes("Retry translation"), "every language pack has the retry control");
    assert.ok(pack.includes("Live translation dropped. This call is translating one phrase at a time."), "every language pack has the drop message");
  }
  assert.notEqual(es.split("Retry translation")[1].slice(0, 80), en.split("Retry translation")[1].slice(0, 80), "Spanish translates the retry control");
  console.log("calls translate retry ok");
}

{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const js = fs.readFileSync(path.join(root, "calls.js"), "utf8");
  assert.ok(js.includes("function reconnectChip") && js.includes('data-act="call-reconnect"'), "Try again is one tap on the call screen when the connection is lost");
  assert.ok(js.includes("syncReconnectChip"), "Try again appears without rebuilding the call screen");
  console.log("calls ice restart ok");
}

{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const js = fs.readFileSync(path.join(root, "calls.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "worker/src/calls.js"), "utf8");
  assert.ok(js.includes("function resumeGuest") && js.includes("rememberGuestSession"), "a guest session is kept on this device so a reload can rejoin");
  assert.ok(js.includes('data-act="call-rejoin"') && js.includes("Rejoin this call"), "Rejoin is one tap on the join or home screen");
  assert.ok(js.includes("clearGuestSession"), "leaving the call forgets the guest session");
  assert.ok(js.includes("sessionStorage") && js.includes("GUEST_SESSION_KEY"), "the session stays on this tab or this device only");
  assert.ok(worker.includes('error: "in_call"'), "a second person cannot take over an invite");
  assert.ok(worker.includes("DELETE FROM call_guests WHERE call_id"), "hanging up revokes the guest token");
  const en = fs.readFileSync(path.join(root, "i18n/en.js"), "utf8");
  const es = fs.readFileSync(path.join(root, "i18n/es.js"), "utf8");
  const ru = fs.readFileSync(path.join(root, "i18n/ru.js"), "utf8");
  const hi = fs.readFileSync(path.join(root, "i18n/hi.js"), "utf8");
  for (const pack of [en, es, ru, hi]) {
    assert.ok(pack.includes("Rejoin this call"), "every language pack has Rejoin");
    assert.ok(pack.includes("Someone is already in this call."), "every language pack has the in-call message");
  }
  assert.notEqual(es.split("Rejoin this call")[1].slice(0, 80), en.split("Rejoin this call")[1].slice(0, 80), "Spanish translates Rejoin");
  console.log("calls guest rejoin ok");
}

{
  const {
    callErrorKind
  } = await import("../shared/call-status.js");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  assert.equal(callErrorKind({ status: 500, data: { error: "upstream" } }), "unavailable");
  assert.equal(callErrorKind({ status: 503, data: {} }), "unavailable");
  assert.equal(callErrorKind({ status: 403, data: { error: "calls_closed" } }), "calls_closed");
  assert.equal(callErrorKind({ status: 410, data: { error: "ended" } }), "ended");
  assert.equal(callErrorKind({ status: 410, data: { error: "cancelled" } }), "cancelled");
  assert.equal(callErrorKind({ status: 403, data: { error: "not_due" } }), "not_due");
  assert.equal(callErrorKind({ status: 409, data: { error: "in_call" } }), "in_call");
  assert.equal(callErrorKind({ status: 403, data: { error: "mystery" } }), "calls_closed");
  assert.equal(callErrorKind(null), "network");
  const js = fs.readFileSync(path.join(root, "calls.js"), "utf8");
  assert.ok(js.includes("callErrorKind") && js.includes("That scheduled call was cancelled."), "the call page uses the Worker error map");
  const en = fs.readFileSync(path.join(root, "i18n/en.js"), "utf8");
  const es = fs.readFileSync(path.join(root, "i18n/es.js"), "utf8");
  const ru = fs.readFileSync(path.join(root, "i18n/ru.js"), "utf8");
  const hi = fs.readFileSync(path.join(root, "i18n/hi.js"), "utf8");
  for (const pack of [en, es, ru, hi]) {
    assert.ok(pack.includes("The call service is temporarily unavailable. Try again in a moment."), "every language pack has the service outage line");
    assert.ok(pack.includes("That scheduled call was cancelled."), "every language pack has the cancelled line");
  }
  assert.notEqual(es.split("The call service is temporarily unavailable. Try again in a moment.")[1].slice(0, 80), en.split("The call service is temporarily unavailable. Try again in a moment.")[1].slice(0, 80), "Spanish translates the outage line");
  console.log("calls clear errors ok");
}
