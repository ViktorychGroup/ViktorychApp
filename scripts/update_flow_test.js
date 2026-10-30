const assert = require("assert");
const update = require("../update.js");

assert.strictEqual(update.shaFromVersion("viktorych-a266-abcdef1234567890"), "abcdef1234567890");
assert.strictEqual(update.shaFromVersion("viktorych-a266-__SW_VERSION__"), "");
assert.strictEqual(update.shaFromVersion(""), "");

assert.deepStrictEqual(update.notesOf({ changelog: [" One ", "One", "", "Two"] }), ["One", "Two"]);
assert.strictEqual(update.notesOf({ changelog: new Array(20).fill("note") }).length, 1);

const now = 1_000_000;
assert.strictEqual(update.decide({ pending: false, phase: "offer" }, now), "idle");
assert.strictEqual(update.decide({ pending: true, phase: "offer", snoozeUntil: now + 10, busy: false }, now), "idle");
assert.strictEqual(update.decide({ pending: true, phase: "offer", snoozeUntil: 0, busy: true }, now), "pill");
assert.strictEqual(update.decide({ pending: true, phase: "offer", snoozeUntil: 0, busy: true, forced: true }, now), "overlay");
assert.strictEqual(update.decide({ pending: true, phase: "offer", snoozeUntil: 0, busy: false }, now), "overlay");
assert.strictEqual(update.decide({ pending: true, phase: "working", snoozeUntil: now + 10, busy: true }, now), "overlay");
assert.strictEqual(update.decide({ pending: true, phase: "error", busy: true }, now), "overlay");
// What's new waits until the new version's files are all downloaded.
assert.strictEqual(update.decide({ pending: true, phase: "offer", ready: false }, now), "idle");
assert.strictEqual(update.decide({ pending: true, phase: "offer", ready: false, forced: true }, now), "idle");
assert.strictEqual(update.decide({ pending: true, phase: "offer", ready: true }, now), "overlay");
assert.strictEqual(update.decide({ pending: true, phase: "working", ready: false }, now), "overlay");
// Background download retries back off and level out at five minutes.
assert.strictEqual(update.predownloadDelay(0), 15000);
assert.strictEqual(update.predownloadDelay(1), 30000);
assert.strictEqual(update.predownloadDelay(10), 5 * 60 * 1000);

assert.strictEqual(update.progressRatio({ files: 0, totalFiles: 4, bytes: 0, totalBytes: 0 }), 0);
assert.strictEqual(update.progressRatio({ files: 4, totalFiles: 4, bytes: 10, totalBytes: 10 }), 1);
const mid = update.progressRatio({ files: 1, totalFiles: 4, bytes: 50, totalBytes: 100 });
assert.ok(mid > 0.4 && mid < 0.6, mid);
assert.strictEqual(update.progressRatio({ files: 9, totalFiles: 1, bytes: 999, totalBytes: 1 }), 1);

assert.strictEqual(update.formatBytes(512), "512 B");
assert.strictEqual(update.formatBytes(2048), "2.0 KB");
assert.strictEqual(update.formatBytes(5 * 1024 * 1024), "5.0 MB");

const fields = update.fieldSnapshot([
  { id: "compose-text", name: "", field: "", value: "hello", type: "text" },
  { id: "secret", value: "nope", type: "password" },
  { id: "empty", value: "", type: "text" },
  { id: "", name: "q", field: "q", value: "draft", type: "text" }
]);
assert.deepStrictEqual(fields.map((row) => row.id || row.field), ["compose-text", "q"]);
assert.ok(!JSON.stringify(fields).includes("nope"));

assert.strictEqual(update.manifestPending("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2026-10-27T00:00:00Z", "2020-01-01T00:00:00Z"), true);
assert.strictEqual(update.manifestPending("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "2020-01-01T00:00:00Z", "2026-10-27T00:00:00Z"), false);
assert.strictEqual(update.manifestPending("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "", ""), false);
// version.json older than the running build (a stuck deploy) stays idle.
assert.strictEqual(update.manifestPending("cccccccccccccccccccccccccccccccccccccccc", "dddddddddddddddddddddddddddddddddddddddd", "2026-10-28T22:08:00Z", "2026-10-29T01:47:00Z"), false);
// A sha already applied on this device is never offered again.
assert.strictEqual(update.manifestPending("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2026-10-27T00:00:00Z", "2020-01-01T00:00:00Z", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), false);
assert.strictEqual(update.manifestPending("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2026-10-27T00:00:00Z", "2020-01-01T00:00:00Z"), false);
assert.strictEqual(update.shouldOfferReset(1), false);
assert.strictEqual(update.shouldOfferReset(2), true);
assert.strictEqual(update.shouldFallback(2), false);
assert.strictEqual(update.shouldFallback(3), true);
assert.deepStrictEqual(update.safeFailure({ url: "./styles.css?sw=1", reason: "http-503" }), { url: "styles.css", reason: "http-503" });
assert.deepStrictEqual(update.safeFailure({ url: "https://example.test/app.js", reason: "typed text" }), { url: "app.js", reason: "network" });
assert.strictEqual(update.safeFailure({ url: "../secret", reason: "http-404" }).url, "");
assert.strictEqual(update.safeFailure({ url: "shared/mirror.js", reason: "quota" }).reason, "quota");

assert.strictEqual(update.restoreFresh({ at: now, hash: "#/home", y: 10 }, now + 1000), true);
assert.strictEqual(update.restoreFresh({ at: now - update.SNOOZE_MS, hash: "#/" }, now), false);
assert.strictEqual(update.restoreFresh(null, now), false);
assert.strictEqual(update.SNOOZE_MS, 30 * 60 * 1000);
assert.strictEqual(update.CHECK_MS, 3 * 60 * 1000);

console.log("update flow ok");
