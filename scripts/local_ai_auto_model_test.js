/* Auto model choice stays on the device and only uses models already available. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const AI = require("../local-ai.js");

const small = AI.model("Qwen3.5-0.8B-q4f16_1-MLC");
const mid = AI.model("Qwen3.5-2B-q4f16_1-MLC");
const big = AI.model("Qwen3.5-4B-q4f16_1-MLC");
const uncensored = AI.MODELS.filter((m) => m.uncensored)[0];
const have = {};
have[small.id] = 1;
have[mid.id] = 1;
have[big.id] = 1;
have[uncensored.id] = 1;

const info = { mem: 8, lowEnd: false, nano: "downloadable", speed: {} };
assert.strictEqual(AI.taskKind("hi"), "short");
assert.strictEqual(AI.taskKind("dark mode"), "settings");
assert.strictEqual(AI.taskKind("translate this paragraph into Spanish"), "translate");
assert.strictEqual(AI.taskKind("summarize the notes"), "summarize");
assert.strictEqual(AI.taskKind("```js\nconst n = 1\n```"), "code");
assert.strictEqual(AI.pickAuto("hi", { have: have, info: info }).model.id, "instant");
assert.strictEqual(AI.pickAuto("dark mode please", { have: have, info: info }).reason, "settings");

const writing = AI.pickAuto("write an essay about rain", { have: have, info: info });
assert.strictEqual(writing.model.id, big.id);
assert.strictEqual(writing.reason, "write");
assert.notStrictEqual(writing.model.uncensored, true);

const tight = AI.pickAuto("write an essay about rain", { have: have, info: { mem: 4, lowEnd: false, nano: "no" } });
assert.notStrictEqual(tight.model.id, big.id, "a 4B model does not fit a 4 GB device");
assert.ok(tight.model.id === mid.id || tight.model.id === small.id);

const phone = AI.pickAuto("write an essay about rain", { have: have, info: { mem: 2, lowEnd: true, nano: "no" } });
assert.strictEqual(phone.reason, "fallback", "a 2 GB device does not get a model that needs more video memory");

const slow = { mem: 8, lowEnd: false, speed: {} };
slow.speed[big.id] = 2;
slow.speed[mid.id] = 2;
slow.speed[small.id] = 9;
const paced = AI.pickAuto("summarize the thread", { have: have, info: slow });
assert.strictEqual(paced.model.id, small.id);

const none = AI.pickAuto("write an essay about rain", { have: {}, info: info });
assert.strictEqual(none.model.id, "instant");
assert.strictEqual(none.reason, "fallback");

const nano = AI.pickAuto("translate this", { have: {}, info: { mem: 8, nano: "available" } });
assert.strictEqual(nano.model.id, "nano");
const notYet = AI.pickAuto("translate this", { have: {}, info: { mem: 8, nano: "downloadable" } });
assert.strictEqual(notYet.reason, "fallback");

const open = AI.pickAuto("write an essay", { have: have, info: info, allowUncensored: true });
assert.ok(open.model.paramsB >= 1.5 || open.model.id === big.id);

const src = fs.readFileSync(path.join(__dirname, "..", "local-ai.js"), "utf8");
assert.strictEqual(src.indexOf("pickAuto"), src.lastIndexOf("function pickAuto") >= 0 ? src.indexOf("pickAuto") : -1);
assert.ok(!/fetch\(/.test(src.slice(src.indexOf("function pickAuto"), src.indexOf("function pickAuto") + 1800)));

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const flags = fs.readFileSync(path.join(__dirname, "..", "worker/src/feature-flags.js"), "utf8");
assert.ok(/ai_auto_model:\s*\{/.test(flags));
assert.ok(/"ai_auto_model"/.test(app));
console.log("auto model ok");
