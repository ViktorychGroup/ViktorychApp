/* Easy voice: screen labels, confirmation, and honest speech limits.
   No microphone, no network, and no screenshot. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Easy = require("../local-ai-easy-voice.js");
const Actions = require("../local-ai-actions.js");
const AI = require("../local-ai.js");

assert.deepStrictEqual(Easy.limitations(), ["power", "volume", "assistant"]);
assert.strictEqual(Easy.fromKey({ code: "Power" }).reason, "os-button");
assert.strictEqual(Easy.fromKey({ code: "VolumeUp" }).reason, "os-button");
assert.strictEqual(Easy.fromKey({ code: "AudioVolumeDown" }).reason, "os-button");
assert.strictEqual(Easy.fromKey({ code: "LaunchAssistant" }).reason, "os-button");
assert.strictEqual(Easy.fromKey({ code: "KeyK", typing: true }).reason, "typing");
const key = Easy.fromKey({ code: "F8", key: "F8" });
assert.strictEqual(key.ok, true);
assert.strictEqual(Easy.matches(key.binding, { code: "F8" }), true);
assert.strictEqual(Easy.matches(null, { code: "F8" }), false);
assert.strictEqual(Easy.fromMedia("playpause").ok, true);
assert.strictEqual(Easy.fromMedia("volumeup").ok, false);

assert.strictEqual(Easy.recognitionChoice({ speechRecognition: true, processLocally: true }).mode, "local");
assert.strictEqual(Easy.recognitionChoice({ speechRecognition: true, processLocally: false }).mode, "typed");
assert.strictEqual(Easy.recognitionChoice({ speechRecognition: true, allowCloud: true }).mode, "cloud");
assert.strictEqual(Easy.recognitionChoice({}).mode, "typed");
assert.strictEqual(Easy.recognitionError("not-allowed").reason, "denied");
assert.strictEqual(Easy.recognitionError("not-allowed").typed, true);
assert.strictEqual(Easy.recognitionError("network").reason, "error");

assert.strictEqual(Easy.see({}).mode, "dom");
assert.strictEqual(Easy.see({ downloaded: true, kind: "vision", local: false }).remote, false);
assert.strictEqual(Easy.see({ downloaded: true, kind: "vision", local: false }).mode, "dom");
assert.strictEqual(Easy.see({ downloaded: true, kind: "vision", local: true }).mode, "local-model");
const localVoice = Easy.pickVoice([{ lang: "en-US", localService: true, name: "local" }, { lang: "en-US", localService: false, name: "remote" }], "en");
assert.strictEqual(localVoice.voice.name, "local");
assert.strictEqual(Easy.pickVoice([{ lang: "en-US", localService: false }], "en").reason, "remote-only");

const quiet = Easy.gate({ text: "open settings", confidence: 0.99, whisper: true });
assert.strictEqual(quiet.send, false);
assert.strictEqual(quiet.reason, "whisper");
assert.strictEqual(Easy.gate({ text: "block @demo_reader", confidence: 0.99, whisper: false }).reason, "action");
assert.strictEqual(Easy.gate({ text: "hello there", confidence: null }).reason, "confidence");
assert.strictEqual(Easy.gate({ text: "hello there", confidence: 0.9, whisper: false }).send, true);
const level = Easy.calibrate([0.002, 0.004]);
assert.strictEqual(level.quiet, true);
assert.strictEqual(level.sensitivity, 85);
assert.strictEqual(Easy.micConstraints({ noiseSuppression: true, autoGainControl: true }, 85).audio.noiseSuppression, false);

const view = { width: 400, height: 800 };
assert.strictEqual(Easy.canHighlight({ left: 20, top: 30, width: 80, height: 40 }, view), true);
assert.strictEqual(Easy.canHighlight({ left: -500, top: 30, width: 40, height: 40 }, view), false);
assert.strictEqual(Easy.canHighlight({ left: 20, top: 900, width: 80, height: 40 }, view), false);

const settings = { label: "Settings", href: "#/settings", visible: true, inView: true };
const hidden = { label: "Settings", href: "#/settings", visible: false, inView: false };
const home = { label: "Home", href: "#/", visible: true, inView: true };
assert.strictEqual(Easy.findGuide("open settings", [settings, home]).target.label, "Settings");
assert.strictEqual(Easy.findGuide("open settings", [hidden]).reason, "offscreen");
assert.strictEqual(Easy.findGuide("open settings", [hidden]).target, null);
assert.strictEqual(Easy.findGuide("open settings", [home]).target, null);
const ambiguous = Easy.findGuide("please notifications", [
  { label: "Notifications", href: "#/a", visible: true, inView: true },
  { label: "Notifications feed", href: "#/b", visible: true, inView: true }
]);
assert.strictEqual(ambiguous.target, null);
assert.strictEqual(ambiguous.reason, "ambiguous");

const ctx = { actions: Actions, ai: AI, current: { fontSize: 15, protected: false }, actionCtx: { tabs: [], lists: [] }, controls: [settings, home], page: "home", readable: "A short post on this screen.", vision: {} };
const open = Easy.decide("open settings", ctx);
assert.strictEqual(open.needsConfirm, true);
assert.strictEqual(open.sensitive, false);
assert.strictEqual(open.posted, false);
assert.strictEqual(open.actions.some((step) => step.name === "nav.open" && step.hash === "#/settings"), true);
assert.strictEqual(open.guide.target.label, "Settings");
assert.strictEqual(open.vision.mode, "dom");
assert.strictEqual(open.vision.remote, false);

const bigger = Easy.decide("make text bigger", ctx);
assert.strictEqual(bigger.settings.changes.some((change) => change.id === "fontSize" && change.to === 16), true);
assert.strictEqual(bigger.needsConfirm, true);

const privacy = Easy.decide("make my account private", Object.assign({}, ctx, { current: { protected: false } }));
assert.strictEqual(privacy.sensitive, true);
assert.strictEqual(privacy.needsConfirm, true);

const block = Easy.decide("block @demo_reader", ctx);
assert.strictEqual(block.actions.some((step) => step.name === "person.block" && step.handle === "@demo_reader"), true);
assert.strictEqual(block.sensitive, true);
assert.strictEqual(block.posted, false);

const profile = Easy.decide("open profile @demo_reader", ctx);
assert.strictEqual(profile.actions.some((step) => step.name === "nav.profile" && step.hash === "#/@demo_reader"), true);
assert.strictEqual(Actions.accepts(profile.actions.filter((step) => step.name === "nav.profile")[0], "open profile @demo_reader", {}), true);

const draft = Easy.decide('write a post: hello from the test', ctx);
assert.strictEqual(draft.actions.some((step) => step.name === "compose.draft" && step.posted !== true), true);
assert.strictEqual(draft.sensitive, true);

const read = Easy.decide("read this", ctx);
assert.strictEqual(read.read.ok, true);
assert.strictEqual(read.read.text.indexOf("short post") >= 0, true);
const pause = Easy.decide("pause the video", ctx);
assert.strictEqual(pause.play, "pause");
assert.strictEqual(pause.needsConfirm, true);
assert.strictEqual(Easy.decide("zzzz-not-a-command", ctx).ok, false);

const src = fs.readFileSync(path.join(__dirname, "..", "local-ai-easy-voice.js"), "utf8");
const ui = fs.readFileSync(path.join(__dirname, "..", "local-ai-easy-voice-ui.js"), "utf8");
assert.ok(!/\bfetch\s*\(|getDisplayMedia|html2canvas|captureStream/.test(src + ui));
assert.ok(!/new Function|\beval\s*\(/.test(src));
const flags = fs.readFileSync(path.join(__dirname, "..", "worker/src/feature-flags.js"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const sw = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");
assert.ok(/ai_easy_voice:\s*\{/.test(flags));
assert.ok(/"ai_easy_voice"/.test(app));
assert.ok(sw.includes('"./local-ai-easy-voice.js"'));
assert.ok(sw.includes('"./easy-voice.css"'));
console.log("easy voice ok");
