import assert from "node:assert/strict";
import test from "node:test";
import { admitRecord, fresh, needsUpload, recordingAllowed, shouldRememberLive, uploaderStale, uploadsPaused, watchDecision, watchHandles } from "../src/live-watch.js";
import { allowRecord, nextPlayable, parseCap, proxyBlocked, sinkPaused, stepCap } from "../../shared/viewer-cap.js";
import { after, chain, embedUrl } from "../../shared/shorts-play.js";
import { bestSource, concatBytes, concatFlv, copyPlan, parseHls } from "../../shared/live-copy.js";
import { clampBurst, frameBox, uniqueFrames } from "../../shared/live-grab.js";
import { tiktokSaveProblems } from "../src/tiktok-save-health.js";
import { FEATURES } from "../src/feature-flags.js";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const ISO = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

test("the watcher rotates a large directory instead of skipping names", () => {
  const doc = { live: { c_name: {}, a_name: {}, b_name: {}, d_name: {}, e_name: {} } };
  assert.deepEqual(watchHandles(doc, 2, 0), ["a_name", "b_name"]);
  assert.deepEqual(watchHandles(doc, 2, 1), ["c_name", "d_name"]);
  assert.deepEqual(watchHandles(doc, 2, 2), ["e_name", "a_name"]);
  assert.deepEqual(watchHandles({ live: { one: {} } }, 6, 4), ["one"]);
});

test("a fresh dispatch marker stops a second recorder", () => {
  const marker = { roomId: "7699647509498710801", at: ISO(NOW - 60 * 1000) };
  assert.equal(watchDecision({}, marker, "7699647509498710801", NOW).action, "skip");
  const old = { roomId: "7699647509498710801", at: ISO(NOW - 11 * 60 * 1000) };
  assert.equal(watchDecision({}, old, "7699647509498710801", NOW).action, "record");
});

test("a saved room is not recorded again", () => {
  const job = { saved: [{ roomId: "7699647509498710801", key: "tiktok/name/7699647509498710801/live" }] };
  assert.equal(watchDecision(job, {}, "7699647509498710801", NOW).why, "saved");
});

test("a live capture with a fresh heartbeat is left alone", () => {
  const job = { active: { state: "recording", roomId: "7699647509498710801", part: 1, capturing: true, heartbeat: ISO(NOW - 60 * 1000) } };
  assert.equal(watchDecision(job, {}, "7699647509498710801", NOW).action, "skip");
});

test("a dead capture is restarted at the current part", () => {
  const job = { active: { state: "recording", roomId: "7699647509498710801", part: 3, capturing: true, heartbeat: ISO(NOW - 30 * 60 * 1000) } };
  const choice = watchDecision(job, {}, "7699647509498710801", NOW);
  assert.equal(choice.action, "record");
  assert.equal(choice.part, 3);
});

test("a finished part asks for the next part once", () => {
  const job = { active: { state: "recording", roomId: "7699647509498710801", part: 2, needsPart: true, capturing: false, dispatchedAt: ISO(NOW - 60 * 1000) } };
  assert.equal(watchDecision(job, {}, "7699647509498710801", NOW).action, "skip");
  job.active.dispatchedAt = ISO(NOW - 10 * 60 * 1000);
  const choice = watchDecision(job, {}, "7699647509498710801", NOW);
  assert.equal(choice.action, "part");
  assert.equal(choice.part, 2);
});

test("a finished capture waits for the uploader instead of recording again", () => {
  const job = { active: { state: "recording", roomId: "7699647509498710801", part: 1, capturing: false, captureDone: true, segments: 40 } };
  assert.equal(watchDecision(job, {}, "7699647509498710801", NOW).why, "captureDone");
});

test("a different room does not replace a live capture", () => {
  const job = { active: { state: "recording", roomId: "111111111111111111", capturing: true, heartbeat: ISO(NOW - 60 * 1000) } };
  assert.equal(watchDecision(job, {}, "7699647509498710801", NOW).action, "skip");
  job.active.heartbeat = ISO(NOW - 60 * 60 * 1000);
  assert.equal(watchDecision(job, {}, "7699647509498710801", NOW).action, "record");
});

test("a dispatch that never opened its capture waits, then retries", () => {
  const job = { active: { state: "recording", roomId: "7699647509498710801", part: 1, capturing: false, captureDone: false, dispatchedAt: ISO(NOW - 30 * 1000) } };
  assert.equal(watchDecision(job, {}, "7699647509498710801", NOW).why, "waiting");
  job.active.dispatchedAt = ISO(NOW - 11 * 60 * 1000);
  const choice = watchDecision(job, {}, "7699647509498710801", NOW);
  assert.equal(choice.action, "record");
  assert.equal(choice.part, 1);
});

test("a blocked empty capture retries after backoff, and a partial save can resume", () => {
  const stuck = { active: { state: "blocked", roomId: "7699647509498710801", captureDone: true, segments: 0, capturing: false } };
  assert.equal(watchDecision(stuck, {}, "7699647509498710801", NOW).why, "unblocked");
  const waiting = { backoffUntil: ISO(NOW + 60 * 1000), active: { state: "blocked", roomId: "7699647509498710801", captureDone: false, segments: 0 } };
  assert.equal(watchDecision(waiting, {}, "7699647509498710801", NOW).why, "backoff");
  const partial = { saved: [{ roomId: "7699647509498710801", partial: true, parts: 2 }] };
  assert.equal(watchDecision(partial, {}, "7699647509498710801", NOW).why, "partial");
  assert.equal(watchDecision(partial, {}, "7699647509498710801", NOW).part, 3);
  const done = { saved: [{ roomId: "7699647509498710801", parts: 2 }] };
  assert.equal(watchDecision(done, {}, "7699647509498710801", NOW).why, "saved");
});

test("a blocked pick that left the row unlabeled still retries", () => {
  const job = { active: { state: "recording", roomId: "7699647509498710801", capturing: false, captureDone: false } };
  const choice = watchDecision(job, {}, "7699647509498710801", NOW);
  assert.equal(choice.action, "record");
  assert.equal(choice.why, "retry");
});

test("fresh rejects old and future stamps", () => {
  assert.equal(fresh(ISO(NOW - 1000), NOW, 5000), true);
  assert.equal(fresh(ISO(NOW - 6000), NOW, 5000), false);
  assert.equal(fresh(ISO(NOW + 6000), NOW, 5000), false);
  assert.equal(fresh("", NOW, 5000), false);
});

test("an uploader runs for buffered segments or a live capture, not a bare live flag", () => {
  assert.equal(needsUpload(null, NOW), false);
  assert.equal(needsUpload({ captureDone: true, segments: 0 }, NOW), false);
  assert.equal(needsUpload({ state: "recording", segments: 0, capturing: false }, NOW), false);
  assert.equal(needsUpload({ segments: 4, captureDone: true, capturing: false }, NOW), true);
  assert.equal(needsUpload({ state: "recording", segments: 4, captureDone: false, capturing: false, needsPart: false }, NOW), false);
  assert.equal(needsUpload({ state: "blocked", segments: 4, captureDone: true, capturing: false }, NOW), false);
  assert.equal(needsUpload({ capturing: true, segments: 0, heartbeat: ISO(NOW - 60 * 1000) }, NOW), true);
  assert.equal(needsUpload({ capturing: true, segments: 0, heartbeat: ISO(NOW - 30 * 60 * 1000) }, NOW), false);
});

test("viewer changes from a detection are stored without another check", () => {
  const prev = { live: true, roomId: "7699647509498710801", viewers: 4, title: "now", checkedAt: ISO(NOW - 60 * 1000) };
  assert.equal(shouldRememberLive(prev, Object.assign({}, prev, { viewers: 9 }), NOW), true);
  assert.equal(shouldRememberLive(prev, prev, NOW), false);
  assert.equal(shouldRememberLive(prev, Object.assign({}, prev, { checkedAt: ISO(NOW) }), NOW - 6 * 60 * 1000), true);
});

test("the uploader heartbeat is stale after five quiet minutes", () => {
  assert.equal(uploaderStale({ at: ISO(NOW - 60 * 1000) }, NOW), false);
  assert.equal(uploaderStale({ at: ISO(NOW - 10 * 60 * 1000) }, NOW), true);
  assert.equal(uploaderStale(null, NOW), true);
});

test("sixteen recorders leave a new live queued and keep a live that already started", () => {
  const full = Array.from({ length: 16 }, (_, index) => "h" + String(index).padStart(2, "0"));
  const fresh = { action: "record", why: "new", part: 1 };
  const queued = { action: "record", why: "queued", part: 1 };
  const again = { action: "record", why: "stale", part: 2 };
  const part = { action: "part", why: "part", part: 2 };
  assert.equal(admitRecord(fresh, "new_name", full, 16), false);
  assert.equal(admitRecord(queued, "new_name", full, 16), false);
  assert.equal(admitRecord(fresh, "h00", full, 16), true);
  assert.equal(admitRecord(again, "h00", full, 16), true);
  assert.equal(admitRecord(part, "h00", full, 16), true);
  assert.equal(admitRecord(fresh, "new_name", full.slice(0, 15), 16), true);
  const waiting = { active: { state: "queued", roomId: "7699647509498710801", part: 1, capturing: false } };
  assert.equal(watchDecision(waiting, {}, "7699647509498710801", NOW).why, "queued");
  assert.equal(watchDecision(waiting, {}, "7699647509498710801", NOW).action, "record");
});

test("a viewer cap pauses playback after two high counts and does not restart recording", () => {
  assert.equal(parseCap(undefined), 20);
  assert.equal(parseCap("off"), "off");
  const spike = stepCap(null, 40, 20);
  assert.equal(spike.paused, false);
  assert.equal(spike.over, 1);
  const held = stepCap(spike, 21, 20, { wantedRecord: true });
  assert.equal(held.paused, true);
  assert.equal(held.holdRecord, true);
  assert.equal(proxyBlocked({ capState: held }), true);
  assert.equal(allowRecord(held, false, true), false);
  const one = stepCap(held, 20, 20, { wantedRecord: true, autoRestart: false });
  const back = stepCap(one, 19, 20, { wantedRecord: true, autoRestart: false });
  assert.equal(back.paused, false);
  assert.equal(allowRecord(back, false, true), false);
  const opted = stepCap(stepCap(held, 10, 20, { wantedRecord: true, autoRestart: true }), 10, 20, { wantedRecord: true, autoRestart: true });
  assert.equal(allowRecord(opted, true, true), true);
  assert.equal(stepCap(held, 90, "off").paused, false);
  assert.equal(recordingAllowed(null, {}), false);
  assert.equal(recordingAllowed({}, { server: true }), true);
  assert.equal(uploadsPaused(null), false);
  assert.equal(uploadsPaused({ server: true }), false);
  assert.equal(uploadsPaused({ uploadsPaused: true }), true);
  const rows = [{ handle: "alpha" }, { handle: "beta", capPaused: true }, { handle: "gamma" }];
  const sunk = sinkPaused(rows, (row) => row.capPaused);
  assert.deepEqual(sunk.map((row) => row.handle), ["alpha", "gamma", "beta"]);
  assert.equal(nextPlayable(sunk, 1, 1, (row) => row.capPaused), -1);
  assert.equal(nextPlayable(sunk, 0, 1, (row) => row.capPaused), 1);
});

test("a short tries the saved file, then the R2 copy, then the official embed", () => {
  const post = { platform: "tiktok", statusId: "7000000000000000001", url: "https://www.tiktok.com/@alpha_one/video/7000000000000000001" };
  const steps = chain(post, { key: "tiktok/id/1/7000000000000000001/video", r2: "https://pub.example.r2.dev/copy.mp4" });
  assert.deepEqual(steps.map((step) => step.kind), ["tg", "r2", "embed"]);
  assert.equal(after(steps, "tg").kind, "r2");
  assert.equal(after(steps, "r2").kind, "embed");
  assert.equal(after(steps, "embed"), null);
  assert.match(embedUrl("7000000000000000001"), /^https:\/\/www\.tiktok\.com\/player\/v1\/7000000000000000001\?/);
  assert.match(steps[2].url, /controls=0/);
  assert.match(steps[2].url, /music_info=0/);
  assert.match(steps[2].url, /loop=1/);
  assert.equal(chain({ platform: "x", id: "1" }, {}).length, 0);
});

test("a live copy joins original segments and a grab stays the native frame", () => {
  const playlist = parseHls("#EXTM3U\n#EXTINF:2,\nhttps://cdn.example/a.ts\n#EXTINF:2,\nseg.ts\n", "https://cdn.example/live.m3u8");
  assert.deepEqual(playlist.segments, ["https://cdn.example/a.ts", "https://cdn.example/seg.ts"]);
  const plan = copyPlan(playlist);
  assert.equal(plan.ok, true);
  assert.equal(plan.reencode, false);
  assert.equal(plan.method, "concat-ts");
  const joined = concatBytes([new Uint8Array([1, 2]), new Uint8Array([3])]);
  assert.deepEqual(Array.from(joined), [1, 2, 3]);
  const header = new Uint8Array(13);
  header[0] = 0x46; header[1] = 0x4c; header[2] = 0x56; header[5] = 0; header[6] = 0; header[7] = 0; header[8] = 9; header[12] = 7;
  const flv = concatFlv([header, header]);
  assert.equal(flv[flv.length - 1], 7);
  assert.equal(bestSource({ variants: [{ quality: "ld", hls: "https://cdn.example/l.m3u8" }, { quality: "origin", hls: "https://cdn.example/o.m3u8" }] }).url, "https://cdn.example/o.m3u8");
  assert.equal(clampBurst(3), 10);
  assert.equal(clampBurst(40), 30);
  assert.equal(clampBurst(12), 12);
  assert.deepEqual(frameBox({ videoWidth: 1080, videoHeight: 1920 }), { width: 1080, height: 1920, png: true, scaled: false });
  assert.equal(uniqueFrames([{ timestamp: 1 }, { timestamp: 1 }, { timestamp: 2 }]).length, 2);
  assert.equal(tiktokSaveProblems({ lines: ["TikTok save queue: 2 videos failed and will retry."] }).length, 1);
  assert.equal(FEATURES.live_frame_grab.defaultOff, undefined);
  assert.ok(FEATURES.shorts);
});
