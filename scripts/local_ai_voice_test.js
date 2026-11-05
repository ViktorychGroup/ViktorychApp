/* Hardware talk button and whisper gating. No microphone and no network. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Voice = require("../local-ai-voice.js");

assert.deepStrictEqual(Voice.limitations(), ["power", "volume", "assistant"]);
assert.strictEqual(Voice.fromKey({ code: "Power" }).reason, "os-button");
assert.strictEqual(Voice.fromKey({ code: "VolumeUp" }).reason, "os-button");
assert.strictEqual(Voice.fromKey({ code: "AudioVolumeDown" }).reason, "os-button");
assert.strictEqual(Voice.fromKey({ code: "LaunchAssistant" }).reason, "os-button");
assert.strictEqual(Voice.fromKey({ code: "" }).reason, "empty");
assert.strictEqual(Voice.fromKey({ code: "KeyK", typing: true }).reason, "typing");
const learned = Voice.fromKey({ code: "F8", key: "F8" });
assert.strictEqual(learned.ok, true);
assert.strictEqual(learned.binding.kind, "key");
assert.strictEqual(Voice.matches(learned.binding, { code: "F8" }), true);
assert.strictEqual(Voice.matches(learned.binding, { code: "F8", typing: true }), true);
assert.strictEqual(Voice.matches(learned.binding, { code: "KeyK", typing: true }), false);

const media = Voice.fromMedia("playpause");
assert.strictEqual(media.ok, true);
assert.strictEqual(Voice.matches(media.binding, { kind: "media", action: "playpause" }), true);
assert.strictEqual(Voice.fromMedia("volumeup").ok, false);

const cap = Voice.speechCapability({ speechRecognition: true, processLocally: true, autoGain: true, noiseSuppression: true });
assert.strictEqual(cap.whisperModel, false);
assert.strictEqual(cap.honest, "browser-no-whisper");
assert.strictEqual(cap.onDeviceRecognition, true);
const missing = Voice.speechCapability({});
assert.strictEqual(missing.browserRecognition, false);

const quiet = Voice.calibrate([0.002, 0.004, 0.008]);
assert.strictEqual(quiet.quiet, true);
assert.strictEqual(quiet.sensitivity, 85);
const none = Voice.calibrate([]);
assert.strictEqual(none.heard, false);
const louder = Voice.calibrate([0.02, 0.2, 0.05]);
assert.strictEqual(louder.quiet, false);
assert.ok(louder.sensitivity < 85);

const constraints = Voice.micConstraints({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }, 85);
assert.strictEqual(constraints.audio.noiseSuppression, false);
assert.strictEqual(constraints.audio.autoGainControl, true);
const plain = Voice.micConstraints({}, 85);
assert.strictEqual(plain.audio, true);

const whisper = Voice.gate({ text: "make text bigger", confidence: 0.95, whisper: true });
assert.strictEqual(whisper.send, false);
assert.strictEqual(whisper.readback, true);
const unsure = Voice.gate({ text: "hello", confidence: null, whisper: false });
assert.strictEqual(unsure.send, false);
assert.strictEqual(unsure.reason, "confidence");
const danger = Voice.gate({ text: "block them", confidence: 0.99, whisper: false });
assert.strictEqual(danger.send, false);
assert.strictEqual(danger.reason, "action");
const clear = Voice.gate({ text: "hello there", confidence: 0.9, whisper: false });
assert.strictEqual(clear.send, true);

const src = fs.readFileSync(path.join(__dirname, "..", "local-ai-voice.js"), "utf8");
assert.ok(!/\bfetch\s*\(/.test(src));
assert.ok(!/new Function|\beval\s*\(/.test(src));
const flags = fs.readFileSync(path.join(__dirname, "..", "worker/src/feature-flags.js"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const sw = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");
assert.ok(/ai_voice:\s*\{/.test(flags));
assert.ok(/"ai_voice"/.test(app));
assert.ok(sw.includes('"./local-ai-voice.js"'));
console.log("voice ok");
