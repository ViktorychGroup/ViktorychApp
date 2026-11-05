/* Device and data-plan setup: detection, recommendations, and revert.
   No browser permission prompts and no carrier claims. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Setup = require("../local-ai-device-setup.js");

const cellular = Setup.readSignals({
  connection: { type: "cellular", effectiveType: "4g", saveData: false },
  onLine: true,
  deviceMemory: 8,
  hardwareConcurrency: 8,
  mobile: true,
  vibrate: true
});
assert.strictEqual(cellular.link, "cellular");
assert.strictEqual(cellular.linkWhy, "type");
const cellPlan = Setup.recommend(cellular, {
  saveData: false, autoplay: "all", videoHd: true, imageLoad: "always", imageSize: "auto",
  linkPreviews: "full", preload: "idle", syncEvery: "normal", backgroundLive: true,
  updateDownload: "always", livePreview: "auto", reactionsData: "auto", communityNotesData: "auto",
  homePills: true, haptics: true, reduceMotion: false
});
assert.strictEqual(cellPlan.plan, true);
assert.strictEqual(cellPlan.needsChoice, false);
const ids = cellPlan.rows.map((row) => row.id);
assert.ok(ids.includes("saveData") && ids.includes("autoplay") && ids.includes("imageLoad") && ids.includes("updateDownload"));
assert.strictEqual(cellPlan.rows.find((row) => row.id === "autoplay").to, "wifi");
assert.ok(!ids.includes("notify"), "notifications are not turned on");
assert.ok(!ids.includes("protected"));
assert.deepStrictEqual(cellPlan.outside, ["carrier", "os-data", "permissions", "os-autoplay"]);
assert.ok(cellPlan.rows.every((row) => cellPlan.outside.indexOf(row.id) < 0));

const saver = Setup.readSignals({ connection: { saveData: true }, onLine: true, deviceMemory: 4, hardwareConcurrency: 8 });
assert.strictEqual(saver.link, "constrained");
assert.strictEqual(saver.linkWhy, "saveData");
assert.strictEqual(Setup.recommend(saver, { saveData: false, autoplay: "all" }).plan, true);

const missing = Setup.readSignals({ onLine: true, deviceMemory: 4, hardwareConcurrency: 8, mobile: false, vibrate: false });
assert.strictEqual(missing.link, "unknown");
const wait = Setup.recommend(missing, { haptics: true, saveData: false });
assert.strictEqual(wait.needsChoice, true);
assert.strictEqual(wait.plan, null);
assert.ok(!wait.rows.some((row) => row.id === "saveData"), "no data change until the person picks");
assert.ok(wait.rows.some((row) => row.id === "haptics" && row.to === false));
const picked = Setup.recommend(missing, { saveData: false, autoplay: "all", videoHd: true }, "cellular");
assert.strictEqual(picked.plan, true);
assert.ok(picked.rows.some((row) => row.id === "saveData" && row.to === true));

const wifi = Setup.readSignals({ connection: { type: "wifi", effectiveType: "4g" }, onLine: true, deviceMemory: 8, hardwareConcurrency: 8 });
const wifiPlan = Setup.recommend(wifi, { saveData: false, autoplay: "all", videoHd: true, imageLoad: "always", imageSize: "auto", linkPreviews: "full", preload: "idle", syncEvery: "normal", backgroundLive: true, updateDownload: "always", livePreview: "auto", reactionsData: "auto", communityNotesData: "auto", homePills: true, haptics: false });
assert.strictEqual(wifiPlan.plan, false);
assert.ok(!wifiPlan.rows.some((row) => row.id === "saveData"));

const slow = Setup.readSignals({
  connection: { effectiveType: "2g" },
  onLine: true,
  deviceMemory: 2,
  hardwareConcurrency: 4,
  reducedMotion: true,
  mobile: true,
  vibrate: false,
  battery: 0.1,
  charging: false
});
const low = Setup.recommend(slow, { reduceMotion: false, haptics: true, syncEvery: "normal", deviceLevel: "balanced", saveData: false, autoplay: "all" });
assert.strictEqual(low.rows.find((row) => row.id === "reduceMotion").why, "motion");
assert.strictEqual(low.rows.find((row) => row.id === "deviceLevel").to, "light");
assert.strictEqual(low.rows.filter((row) => row.id === "syncEvery").length, 1);
assert.strictEqual(low.rows.find((row) => row.id === "haptics").to, false);

const same = Setup.recommend(cellular, { saveData: true, autoplay: "wifi", videoHd: false, imageLoad: "wifi", imageSize: "small", linkPreviews: "text", preload: "defer", syncEvery: "slow", backgroundLive: false, updateDownload: "wifi", livePreview: "off", reactionsData: "lite", communityNotesData: "lite", homePills: false, haptics: true });
assert.ok(!same.rows.some((row) => row.why === "data"), "settings already suited to cellular are not listed again");

assert.strictEqual(Setup.asked("set up this device for my data plan"), true);
assert.strictEqual(Setup.asked("configura este dispositivo"), true);
assert.strictEqual(Setup.asked("настрой это устройство"), true);
assert.strictEqual(Setup.asked("इस डिवाइस को सेट करो"), true);
assert.strictEqual(Setup.asked("make text bigger"), false);
assert.strictEqual(Setup.asked("set up local ai"), false);

const bag = {};
const store = {
  get: (key) => (key in bag ? bag[key] : null),
  set: (key, value) => { bag[key] = value; },
  remove: (key) => { delete bag[key]; }
};
Setup.saveRevert([{ id: "autoplay", from: "all", to: "wifi" }, { id: "saveData", from: false, to: true, on: false }], store);
const saved = Setup.loadRevert(store);
assert.strictEqual(saved.rows[0].from, "all");
assert.strictEqual(saved.rows[1].to, true);
Setup.clearRevert(store);
assert.strictEqual(Setup.loadRevert(store), null);

const chosen = cellPlan.rows.map((row) => Object.assign({}, row, { on: row.id !== "homePills" }));
assert.ok(!Setup.selected({ rows: chosen }).some((row) => row.id === "homePills"));

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const flags = fs.readFileSync(path.join(root, "worker/src/feature-flags.js"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
assert.ok(/ai_device_setup:\s*\{/.test(flags));
assert.ok(/"ai_device_setup"/.test(app));
assert.ok(sw.includes('"./local-ai-device-setup.js"'));
assert.ok(!/new Function|\beval\s*\(/.test(fs.readFileSync(path.join(root, "local-ai-device-setup.js"), "utf8")));
console.log("device setup ok");
