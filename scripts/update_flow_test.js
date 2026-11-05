const assert = require("assert");
const update = require("../update.js");

assert.strictEqual(update.shaFromVersion("viktorych-a281-abcdef1234567890"), "abcdef1234567890");
assert.strictEqual(update.shaFromVersion("viktorych-a281-__SW_VERSION__"), "");

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
assert.strictEqual(update.decide({ pending: true, phase: "offer", ready: true }, now), "pill");
assert.strictEqual(update.decide({ pending: true, phase: "offer", ready: true, snoozeUntil: now + 10 }, now), "pill");
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

const NEWER = "b".repeat(40);
const OLDER = "a".repeat(40);
const SAME = "c".repeat(40);
// The running worker is the truth. version.json cannot open an update.
const LIVE_SW = "c2b9cb0959b7a68187171bda4af3af0fd596d274";
const LIVE_MANIFEST = "3a6f2de18453d5416d9ed99ab622047825a105db";
const LIVE_MANIFEST_BUILT = "2026-11-03T23:13:36Z";
const LIVE_SW_BUILT = "2026-11-03T23:25:36Z";
assert.strictEqual(update.versionMismatch(LIVE_MANIFEST, LIVE_SW), true);
assert.strictEqual(update.versionMismatch(LIVE_SW, LIVE_SW), false);
assert.strictEqual(update.offerMismatch(LIVE_SW, LIVE_MANIFEST, "", "", LIVE_MANIFEST_BUILT, LIVE_SW_BUILT), false);
assert.strictEqual(update.offerMismatch(LIVE_SW, LIVE_MANIFEST, LIVE_MANIFEST, "", LIVE_MANIFEST_BUILT, LIVE_SW_BUILT), false);
assert.strictEqual(update.staleManifest(LIVE_MANIFEST, LIVE_SW, LIVE_MANIFEST_BUILT, LIVE_SW_BUILT), true);
assert.strictEqual(update.staleManifest(NEWER, OLDER, "2026-10-27T00:00:00Z", "2020-01-01T00:00:00Z"), false);
assert.strictEqual(update.blocksReloadFor(LIVE_MANIFEST, LIVE_SW, LIVE_SW, "", "", LIVE_MANIFEST_BUILT, LIVE_SW_BUILT), true);
assert.strictEqual(update.blocksReloadFor(LIVE_MANIFEST, LIVE_SW, LIVE_SW, LIVE_SW, ""), true);
assert.strictEqual(update.blocksReloadFor(LIVE_MANIFEST, LIVE_SW, LIVE_SW, "", LIVE_SW), true);
assert.strictEqual(update.reloadAllowed(LIVE_SW, "", ""), true);
assert.strictEqual(update.reloadAllowed(LIVE_SW, LIVE_SW, ""), false);
assert.strictEqual(update.reloadAllowed(LIVE_SW, "", LIVE_SW), false);
assert.strictEqual(update.offerMismatch(NEWER, OLDER, "", ""), false);
assert.strictEqual(update.offerMismatch(OLDER, NEWER, "", ""), false);
assert.strictEqual(update.offerMismatch(SAME, SAME, "", ""), false);
assert.strictEqual(update.offerMismatch(SAME, SAME, SAME, ""), false);
assert.strictEqual(update.offerMismatch(OLDER, NEWER, NEWER, "", "2026-10-27T00:00:00Z", "2020-01-01T00:00:00Z"), true);
assert.strictEqual(update.offerMismatch(OLDER, NEWER, NEWER, NEWER, "2026-10-27T00:00:00Z", "2020-01-01T00:00:00Z"), false);
// version.json older than the running service worker: no offer and no reload signal.
assert.strictEqual(update.offerMismatch(NEWER, OLDER, "", "", "2020-01-01T00:00:00Z", "2026-10-27T00:00:00Z"), false);
assert.strictEqual(update.offerMismatch(NEWER, OLDER, OLDER, "", "2020-01-01T00:00:00Z", "2026-10-27T00:00:00Z"), false);
// The service worker's own newer build still counts when version.json has not caught up.
assert.strictEqual(update.offerMismatch(OLDER, OLDER, NEWER, "", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z"), true);
assert.strictEqual(update.reloadAllowed("", "", ""), false);
assert.strictEqual(update.reloadAllowed(NEWER, "", ""), true);
assert.strictEqual(update.reloadAllowed(NEWER, NEWER, ""), false);
assert.strictEqual(update.reloadAllowed(NEWER, "", NEWER), false);
assert.strictEqual(update.reloadAllowed(OLDER, NEWER, NEWER), true);
assert.strictEqual(update.presentation({ pending: true, phase: "offer", ready: true }, now), "pill");
assert.strictEqual(update.presentation({ pending: true, phase: "offer", ready: true, snoozeUntil: now + 10 }, now), "pill");
assert.strictEqual(update.presentation({ pending: true, phase: "offer", ready: true, critical: true }, now), "blocking");
assert.strictEqual(update.presentation({ pending: true, phase: "offer", ready: true, forced: true }, now), "blocking");
assert.strictEqual(update.presentation({ pending: true, phase: "error" }, now), "blocking");
assert.strictEqual(update.presentation({ pending: true, phase: "offer", ready: false }, now), "idle");
assert.strictEqual(update.presentation({ pending: true, phase: "working", silent: true }, now), "idle");
assert.strictEqual(update.shouldShowNotes(NEWER, []), true);
assert.strictEqual(update.shouldShowNotes(NEWER, [NEWER]), false);
assert.strictEqual(update.shouldShowNotes(NEWER, [NEWER.toUpperCase()]), false);
assert.strictEqual(update.shouldShowNotes(OLDER, [NEWER]), true);
assert.strictEqual(update.shouldShowNotes("", []), false);
assert.strictEqual(update.shouldDeferApply({ modal: true, typed: false }), true);
assert.strictEqual(update.shouldDeferApply({ modal: false, typed: true }), true);
assert.strictEqual(update.shouldDeferApply({ modal: false, typed: false }), false);
assert.strictEqual(update.shouldShowNotes(OLDER, ["nope", ""]), true);

assert.strictEqual(update.restoreFresh({ at: now, hash: "#/home", y: 10 }, now + 1000), true);
assert.strictEqual(update.restoreFresh({ at: now - update.SNOOZE_MS, hash: "#/" }, now), false);
assert.strictEqual(update.restoreFresh(null, now), false);
assert.strictEqual(update.SNOOZE_MS, 30 * 60 * 1000);
assert.strictEqual(update.CHECK_MS, 3 * 60 * 1000);

// Visible updates: the small toast says Updating while the build downloads
// or applies, and stays out of the way of the full screen and of errors.
assert.strictEqual(update.statusKind({ pending: true, phase: "working" }, "idle"), "updating");
assert.strictEqual(update.statusKind({ pending: true, phase: "done" }, "idle"), "updating");
// The background download is quiet; the toast is only for the switch-over, and never for long.
assert.strictEqual(update.statusKind({ pending: true, phase: "offer", preBusy: true, ready: false }, "idle"), "");
assert.strictEqual(update.statusKind({ pending: true, phase: "working", workingSince: 1000 }, "idle", 3000), "updating");
assert.strictEqual(update.statusKind({ pending: true, phase: "working", workingSince: 1000 }, "idle", 6000), "");
assert.strictEqual(update.statusKind({ pending: true, phase: "offer", preBusy: false, ready: true }, "pill"), "");
assert.strictEqual(update.statusKind({ pending: true, phase: "working" }, "blocking"), "");
assert.strictEqual(update.statusKind({ pending: true, phase: "error" }, "idle"), "");
assert.strictEqual(update.statusKind({ pending: true, phase: "working", critical: true }, "idle"), "");
assert.strictEqual(update.statusKind(null, "idle"), "");
assert.strictEqual(update.noteIcon("Fixed the gap above the header"), "fix");
assert.strictEqual(update.noteIcon("Faster, smoother For you loading"), "fast");
assert.strictEqual(update.noteIcon("Tab strips like the X app"), "look");
assert.strictEqual(update.noteIcon("Swipe between custom feeds"), "new");

console.log("update flow ok");
