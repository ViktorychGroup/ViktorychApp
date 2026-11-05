/* Local AI core: device tiers, the instant parser in four languages, and the
   tool-call checks that every engine's answer goes through. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const R = require("../settings-registry.js");
const A = require("../local-ai.js");

// ---- tiers and models ----
function info(o) { return Object.assign({ webgpu: true, f16: true, maxBuffer: 2 * 1024 * 1024 * 1024, mem: 8, cores: 8, mobile: false, saveData: false, slowNet: false, lowEnd: false, nano: "no", wasm: true }, o); }
function pick(o) { const i = info(o); i.tier = A.tierOf(i); return { tier: i.tier, c: A.choices(i) }; }
let p = pick({});
assert.strictEqual(p.tier, "max");
assert.strictEqual(p.c.recommended.id, "Qwen3.5-4B-q4f16_1-MLC");
assert.deepStrictEqual(p.c.list.map((m) => m.id).slice(0, 3), ["Qwen3.5-4B-q4f16_1-MLC", "Qwen3.5-2B-q4f16_1-MLC", "Qwen3.5-0.8B-q4f16_1-MLC"]);
assert.strictEqual(p.c.list[p.c.list.length - 1].id, "instant");
p = pick({ mem: 4 });
assert.strictEqual(p.tier, "high");
assert.strictEqual(p.c.recommended.id, "Qwen3.5-2B-q4f16_1-MLC");
p = pick({ mobile: true, mem: 6, f16: false });
assert.strictEqual(p.tier, "lite");
assert.strictEqual(p.c.recommended.id, "Qwen3.5-0.8B-q4f32_1-MLC", "no shader-f16 uses the f32 build");
p = pick({ webgpu: false });
assert.strictEqual(p.tier, "cpu");
assert.strictEqual(p.c.recommended.engine, "tjs");
p = pick({ webgpu: false, nano: "available" });
assert.strictEqual(p.c.recommended.id, "nano", "Chrome's built-in model beats the slow CPU model");
assert.strictEqual(pick({ saveData: true }).c.recommended.id, "instant", "data saver starts on Instant");
assert.strictEqual(pick({ slowNet: true }).c.recommended.id, "instant");
assert.strictEqual(pick({ mem: 2, lowEnd: true, mobile: true }).c.recommended.id, "instant");
A.MODELS.forEach((m) => {
  if (m.engine === "webllm" || m.engine === "tjs") assert.ok(m.sizeMB > 300 && A.downloadMB(m) > m.sizeMB, m.id + " has a real size");
  else assert.strictEqual(A.downloadMB(m), 0);
});
assert.strictEqual(A.downloadMB(A.model("Qwen3.5-0.8B-q4f16_1-MLC")), 428);

// ---- instant parser ----
const cur = { fontSize: 15, autoplay: "all", friendsRail: true, onlineStatus: "everyone", protected: false, privateFollows: false, discoverable: true, appearance: "lightsout", reduceMotion: false };
function sets(text, values) {
  const out = A.parse(text, values || cur);
  const plan = A.plan(out.calls, values || cur);
  const o = {};
  plan.changes.forEach((c) => { o[c.id] = c.to; });
  return { o, plan };
}
let r = sets("make text bigger and stop autoplay on mobile data");
assert.deepStrictEqual(r.o, { fontSize: 16, autoplay: "wifi" });
r = sets("make it private");
assert.deepStrictEqual(r.o, { protected: true, privateFollows: true, discoverable: false, onlineStatus: "nobody" });
assert.ok(r.plan.changes.every((c) => !c.risky), "going private is never risky");
r = sets("make my account public", { protected: true, privateFollows: true, discoverable: false, onlineStatus: "nobody" });
assert.ok(r.plan.changes.length >= 2 && r.plan.changes.every((c) => c.risky), "going public asks first");
r = sets("hide friends stuff");
assert.strictEqual(r.o.friendsRail, false);
r = sets("dark mode");
assert.ok(r.o.appearance === "dim" || r.o.appearance === undefined, "lights out already counts as dark");
r = sets("dark mode", Object.assign({}, cur, { appearance: "default" }));
assert.ok(r.o.appearance === "lightsout" || r.o.appearance === "dim");
// Spanish, Russian, Hindi
assert.deepStrictEqual(sets("texto más grande").o, { fontSize: 16 });
assert.strictEqual(sets("сделай аккаунт закрытым").o.protected, true);
assert.strictEqual(sets("мой профиль приватный").o.protected, true);
assert.strictEqual(A.langOf("сделай текст крупнее", "en"), "ru");
assert.strictEqual(A.langOf("टेक्स्ट बड़ा करो", "en"), "hi");
assert.strictEqual(A.langOf("hazlo privado por favor", "en"), "es");
// danger never becomes a change
["delete my account", "log me out", "borrar mi cuenta", "удали аккаунт"].forEach((q) => {
  const out = A.parse(q, cur);
  const plan = A.plan(out.calls, cur);
  assert.strictEqual(plan.changes.length, 0, q);
  assert.ok(plan.opens.length >= 1 && plan.opens.every((row) => row.page), q + " opens a page");
});
// questions read, they don't change
r = A.plan(A.parse("is autoplay on?", cur).calls, cur);
assert.strictEqual(r.changes.length, 0);
assert.strictEqual(r.reads[0].row.id, "autoplay");

// ---- tool-call checks (what every model answer goes through) ----
r = A.plan([
  { fn: "set", id: "fontSize", value: 99 },
  { fn: "set", id: "nope", value: 1 },
  { fn: "set", id: "deleteAccount", value: true },
  { fn: "set", id: "logout", value: true },
  { fn: "set", id: "autoplay", value: "sometimes" },
  { fn: "rm", id: "autoplay" },
  { fn: "set", id: "follows", value: [] },
  { fn: "open", id: "mutedWords" }
], cur);
assert.deepStrictEqual(r.changes.map((c) => [c.id, c.to]), [["fontSize", 18]], "numbers clamp to the allowed range");
assert.deepStrictEqual(r.opens.map((row) => row.id).sort(), ["deleteAccount", "logout", "mutedWords"].sort());
assert.ok(r.rejected.length >= 5);
r = A.plan([{ fn: "set", id: "onlineStatus", value: "nobody" }], {});
assert.strictEqual(r.changes[0].from, "everyone", "missing values start from the default");
assert.strictEqual(r.changes[0].risky, false);
r = A.plan([{ fn: "set", id: "fontSize", value: 15 }], cur);
assert.strictEqual(r.changes.length, 0);
assert.strictEqual(r.reads[0].same, true);

// ---- model answers ----
assert.strictEqual(A.partialReply('{"reply":"Done: big'), "Done: big");
assert.deepStrictEqual(A.readAnswer('sure {"reply":"ok","calls":[{"fn":"set","id":"fontSize","value":16}]} thanks').calls.length, 1);
assert.strictEqual(A.readAnswer("<think>hmm</think>no json").bad, true);
const pr = A.prompt("bigger text and no autoplay on wifi", cur, { lang: "es" });
assert.ok(pr.system.indexOf("fontSize") >= 0 && pr.system.indexOf("autoplay") >= 0);
assert.ok(/Spanish/.test(pr.system), "the model answers in the user's language");
assert.ok(pr.system.indexOf("deleteAccount") < 0 || /only open/i.test(pr.system));
assert.ok(pr.system.length < 9000, "prompt fits small context windows");
assert.deepStrictEqual(Object.keys(A.SCHEMA.properties).sort(), ["calls", "reply"]);

// ---- every visible label is translated in all four packs ----
const root = path.join(__dirname, "..");
function packKeys(code) {
  const src = fs.readFileSync(path.join(root, "i18n", code + ".js"), "utf8");
  const keys = new Set();
  const re = /^\s*("(?:[^"\\]|\\.)*")\s*:/gm;
  let m;
  while ((m = re.exec(src))) keys.add(JSON.parse(m[1]));
  return keys;
}
const ENDONYM = /^(English|Español|Français|Deutsch|Português|Italiano|Русский|हिन्दी|日本語|한국어|中文|العربية|Türkçe|Polski|Nederlands|Українська)$/;
const want = new Set();
R.LIST.forEach((row) => {
  if (row.label === row.id && row.desc === "Internal app data.") return; // never shown
  want.add(row.label);
  Object.keys(row.valueLabels || {}).forEach((k) => { if (!ENDONYM.test(row.valueLabels[k])) want.add(row.valueLabels[k]); });
});
const ui = fs.readFileSync(path.join(root, "local-ai-ui.js"), "utf8");
(ui.match(/\btr\("((?:[^"\\]|\\.)*)"/g) || []).forEach((s) => want.add(JSON.parse(s.slice(3))));
["en", "es", "ru", "hi"].forEach((code) => {
  const keys = packKeys(code);
  const gone = [...want].filter((k) => !keys.has(k));
  assert.deepStrictEqual(gone, [], code + " pack lacks Local AI strings");
});

// ---- the page ships offline ----
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
["settings-registry.js", "local-ai.js", "local-ai-ui.js", "local-ai.css", "local-ai-worker.js"].forEach((f) => assert.ok(sw.indexOf('"./' + f + '"') >= 0, f + " is precached"));
const lazy = fs.readFileSync(path.join(root, "shared", "lazy-modules.js"), "utf8");
assert.ok(/localai:\s*\{[^}]*local-ai-ui\.js/.test(lazy), "Local AI is a lazy module");
const worker = fs.readFileSync(path.join(root, "local-ai-worker.js"), "utf8");
assert.ok(worker.indexOf("@mlc-ai/web-llm@" + A.WEBLLM_VERSION) >= 0, "worker and core agree on the WebLLM version");
assert.ok(worker.indexOf("@huggingface/transformers@" + A.TJS_VERSION) >= 0, "worker and core agree on the transformers.js version");
const flags = fs.readFileSync(path.join(root, "worker", "src", "feature-flags.js"), "utf8");
assert.ok(/local_ai:\s*\{/.test(flags), "Local AI has its own switch");
assert.ok(/local_ai_setup:\s*\{/.test(flags), "Local AI setup has its own switch");
const appJs = fs.readFileSync(path.join(root, "app.js"), "utf8");
assert.ok(/SERVER_FEATURES\s*=\s*\[[^\]]*"local_ai_setup"/.test(appJs) && /local_ai_setup:\s*\[tr\(/.test(appJs), "Local AI setup is listed with a label in the owner switches");
const sync = fs.readFileSync(path.join(root, "settings-sync.js"), "utf8");
assert.ok(/"aiSetup"/.test(sync), "setup choices follow the account");

// A page-only setting that fits better wins over a weak toggle match.
for (const q of ["who can send me friend requests", "stop friend requests"]) {
  const got = A.parse(q, {}).calls;
  assert.deepStrictEqual(got.map((c) => c.fn + ":" + c.id), ["open:friendsSwitch"], q);
}
// ---- people: block, mute, unblock, unmute an @account (switch ai_people) ----
{
  const calls = (t) => A.parse(t, {}).calls.map((c) => c.fn === "person" ? (c.on ? "" : "un") + c.act + " " + c.handle : c.fn + ":" + c.id);
  assert.deepStrictEqual(calls("block @demo_one and @Demo.two, mute @demo_three"), ["block @demo_one", "block @demo.two", "mute @demo_three"]);
  assert.deepStrictEqual(calls("unblock @demo_one"), ["unblock @demo_one"]);
  assert.deepStrictEqual(calls("stop muting @demo_three and turn off autoplay"), ["unmute @demo_three", "set:autoplay"]);
  assert.deepStrictEqual(calls("bloquea a @demo_es"), ["block @demo_es"]);
  assert.deepStrictEqual(calls("заблокируй @demo_ru"), ["block @demo_ru"]);
  assert.deepStrictEqual(calls("@demo_hi को म्यूट करो"), ["mute @demo_hi"]);
  assert.deepStrictEqual(calls("@demo_ru заблокируй"), ["block @demo_ru"]);
  assert.deepStrictEqual(calls("म्यूट @demo_hi"), ["mute @demo_hi"]);
  assert.deepStrictEqual(A.parsePeople("@demo_one is great"), [], "a handle without a verb does nothing");
  assert.deepStrictEqual(A.parsePeople("block someone"), [], "no @handle, no change");
  // Plan: only what the person typed; a model or post text can't add people.
  const typed = "block @demo_one";
  let pl = A.plan(A.parse(typed, {}).calls, {}, { typed: typed });
  assert.deepStrictEqual(pl.changes.map((c) => [c.id, c.from, c.to, c.person]), [["person:block:@demo_one", false, true, true]]);
  pl = A.plan([{ fn: "person", act: "block", on: true, handle: "@demo_victim" }], {}, { typed: "summarize this post" });
  assert.strictEqual(pl.changes.length, 0, "untyped person call is rejected");
  assert.strictEqual(pl.rejected[0].why, "untyped");
  pl = A.plan([{ fn: "person", act: "block", on: true, handle: "@demo_one" }], {});
  assert.strictEqual(pl.changes.length, 0, "no typed text, no people changes");
  pl = A.plan([{ fn: "person", act: "block", on: false, handle: "@demo_one" }], {}, { typed: typed });
  assert.strictEqual(pl.changes.length, 0, "the opposite of what was typed is rejected");
  pl = A.plan(A.parse(typed, {}).calls, { "person:block:@demo_one": true }, { typed: typed });
  assert.ok(pl.changes.length === 0 && pl.reads[0].same, "already blocked reads back");
  assert.strictEqual(A.personRow("person:mute:@demo_three").subject, "@demo_three");
  assert.strictEqual(A.personRow("person:delete:@x"), null);
  assert.ok(/ai_people:\s*\{/.test(flags) && /SERVER_FEATURES\s*=\s*\[[^\]]*"ai_people"/.test(appJs), "people actions have their own switch");
  const ui = fs.readFileSync(path.join(root, "local-ai-ui.js"), "utf8");
  assert.ok(/fn === "person"/.test(ui) && /typed:/.test(ui), "the UI drops model people calls and passes the typed text");
}
console.log("local ai tests ok (" + want.size + " strings in 4 packs)");
