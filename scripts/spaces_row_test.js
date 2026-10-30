/* Follow gate, audio allowlist, and marquee plan for Spaces. */
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const context = { console, URL };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync("spaces.js", "utf8"), context);
const L = context.SpacesLogic;
assert.ok(L, "spaces.js exports SpacesLogic without a document");

const host = {
  platform: "telegram",
  handle: "quietharbor",
  followId: "telegram:quietharbor"
};
const live = { id: "superintelmusic", live: true, followId: host.followId, host, kind: "space" };
const video = { id: "clip", live: true, followId: "youtube:news", kind: "video", host: {} };

assert.strictEqual(L.homePills([live], [host.followId]).length, 1);
assert.strictEqual(L.homePills([live], []).length, 0);
assert.strictEqual(L.homePills([live], [host.followId]).length, 1);
assert.strictEqual(L.homePills([{ ...live, live: false }], [host.followId]).length, 0);
assert.strictEqual(L.profileLive(live, "telegram", "@quietharbor"), true);
assert.strictEqual(L.homePills([live], []).length, 0);
assert.strictEqual(L.profileLive({ ...live, live: false }, "telegram", host.handle), false);
assert.strictEqual(L.profileLive(live, "x", host.handle), false);
assert.strictEqual(L.homePills([video], ["youtube:news"]).length, 1);
assert.strictEqual(L.homePills([video], []).length, 0);

const allow = ["trycloudflare.com"];
const ok = L.allowedAudio("https://abc.trycloudflare.com/live/a.m3u8", "", allow);
assert.ok(ok.startsWith("https://abc.trycloudflare.com/"));
assert.strictEqual(L.allowedAudio("https://radio.trycloudflare.com/a.m3u8", "", ["*.trycloudflare.com"]).includes("radio.trycloudflare.com"), true);
assert.strictEqual(L.allowedAudio("http://abc.trycloudflare.com/a.m3u8", "", allow), "");
assert.strictEqual(L.allowedAudio("https://evil.com/a.m3u8", "", allow), "");
assert.strictEqual(L.allowedAudio("https://nottrycloudflare.com/a.m3u8", "", allow), "");
assert.strictEqual(L.allowedAudio("https://abc.trycloudflare.com.evil.com/a.m3u8", "", allow), "");
assert.strictEqual(L.allowedAudio("https://abc.trycloudflare.com/a.m3u8", "", []), "");
assert.strictEqual(L.allowedAudio("//abc.trycloudflare.com/a.m3u8", "", allow), "");
const relative = L.allowedAudio("audio.m3u8", "https://abc.trycloudflare.com/radio/", allow);
assert.strictEqual(relative, "https://abc.trycloudflare.com/radio/audio.m3u8");
assert.strictEqual(L.allowedAudio("audio.m3u8", "http://abc.trycloudflare.com/radio/", allow), "");

const at = Date.parse("2026-10-21T20:00:00.000Z");
const parsed = L.audioFromStatus({
  live: true,
  title: "Some Song",
  artist: "Someone",
  base: "https://abc.trycloudflare.com/radio/",
  hls: { audio: "a.m3u8" },
  listeners: 4,
  updated: "2026-10-21T20:00:00.000Z"
}, allow, at);
assert.strictEqual(parsed.live, true);
assert.strictEqual(parsed.url, "https://abc.trycloudflare.com/radio/a.m3u8");
assert.strictEqual(parsed.listeners, 4);
assert.strictEqual(parsed.title, undefined);
assert.strictEqual(L.audioFromStatus({ live: true, base: "", hls: { audio: "" } }, allow).live, false);
assert.strictEqual(L.listenersOf({}), null);
assert.strictEqual(L.audioFromStatus({
  live: true,
  base: "https://abc.trycloudflare.com/radio/",
  hls: { audio: "a.m3u8" },
  updated: "2026-10-21T20:00:00.000Z"
}, allow, at + 2 * 60 * 1000).live, true);
assert.strictEqual(L.audioFromStatus({
  live: true,
  base: "https://abc.trycloudflare.com/radio/",
  hls: { audio: "a.m3u8" },
  updated: "2026-10-21T20:00:00.000Z"
}, allow, at + 2 * 60 * 1000).reconnecting, false);
const stale = L.audioFromStatus({
  live: true,
  base: "https://abc.trycloudflare.com/radio/",
  hls: { audio: "a.m3u8" },
  listeners: 4,
  updated: "2026-10-21T20:00:00.000Z"
}, allow, at + 2 * 60 * 1000 + 1);
assert.strictEqual(stale.live, true);
assert.strictEqual(stale.reconnecting, true);
assert.strictEqual(stale.url, "https://abc.trycloudflare.com/radio/a.m3u8");
assert.strictEqual(stale.listeners, 4);
const held = L.audioFromStatus({
  live: true,
  base: "https://abc.trycloudflare.com/radio/",
  hls: { audio: "a.m3u8" },
  updated: "2026-10-21T20:00:00.000Z"
}, allow, at + 8 * 60 * 1000);
assert.strictEqual(held.live, true);
assert.strictEqual(held.reconnecting, true);
const offline = L.audioFromStatus({
  live: true,
  base: "https://abc.trycloudflare.com/radio/",
  hls: { audio: "a.m3u8" },
  updated: "2026-10-21T20:00:00.000Z"
}, allow, at + 8 * 60 * 1000 + 1);
assert.strictEqual(offline.live, false);
assert.strictEqual(offline.url, "");
assert.strictEqual(offline.reconnecting, false);
assert.strictEqual(L.audioFromStatus({
  live: false,
  base: "https://abc.trycloudflare.com/radio/",
  hls: { audio: "a.m3u8" },
  updated: "2026-10-21T20:00:00.000Z"
}, allow, at).live, false);
assert.strictEqual(L.statusStale({ updated: "nope" }, at), true);
assert.strictEqual(L.statusStale({ live: true }, at), false);
assert.strictEqual(L.statusOffline({ live: false, updated: "2026-10-21T20:00:00.000Z" }, at), true);
assert.strictEqual(L.statusOffline({ live: true, updated: "2026-10-21T20:00:00.000Z" }, at + 3 * 60 * 1000), false);
assert.strictEqual(L.statusOffline({ live: true, updated: "2026-10-21T20:00:00.000Z" }, at + 8 * 60 * 1000 + 1), true);
assert.strictEqual(L.playlistJumped(null, 10, 6), false);
assert.strictEqual(L.playlistJumped(10, 11, 6), false);
assert.strictEqual(L.playlistJumped(10, 17, 6), false);
assert.strictEqual(L.playlistJumped(10, 18, 6), true);
assert.strictEqual(L.playlistJumped(20, 10, 6), true);
assert.strictEqual(L.recoverPlan("media", { hasHls: true, mediaFixes: 0, softLoads: 0 }), "media");
assert.strictEqual(L.recoverPlan("media", { hasHls: true, mediaFixes: 1, softLoads: 0 }), "reload");
assert.strictEqual(L.recoverPlan("network", { hasHls: true, mediaFixes: 0, softLoads: 0 }), "reload");
assert.strictEqual(L.recoverPlan("stall", { hasHls: true, mediaFixes: 0, softLoads: 0 }), "recreate");
assert.strictEqual(L.recoverPlan("watch", { hasHls: true, mediaFixes: 0, softLoads: 0 }), "recreate");
assert.strictEqual(L.recoverPlan("network", { hasHls: true, mediaFixes: 0, softLoads: 1 }), "recreate");
assert.strictEqual(L.recoverPlan("jump", { hasHls: true, mediaFixes: 0, softLoads: 0 }), "recreate");
assert.strictEqual(L.recoverPlan("ended", { hasHls: true, mediaFixes: 0, softLoads: 0 }), "recreate");
assert.strictEqual(L.recoverPlan("network", { hasHls: false, mediaFixes: 0, softLoads: 0 }), "recreate");

const pubHost = "pub-bf9b5e3ebb2b421aa49e7af484f3c22d.r2.dev";
const radioAllow = [pubHost, "r2.dev", "trycloudflare.com"];
const statusUrl = "https://" + pubHost + "/status.json";
const playlist = "https://" + pubHost + "/hls/stream.m3u8";
assert.strictEqual(L.remoteStatusUrl(statusUrl, radioAllow, 42), statusUrl + "?_=42");
assert.strictEqual(L.remoteStatusUrl(statusUrl, [pubHost], 42), statusUrl + "?_=42");
assert.ok(L.remoteStatusUrl(statusUrl + "?x=1", radioAllow, 9).includes("_=9"));
assert.strictEqual(L.remoteStatusUrl(statusUrl, ["trycloudflare.com"], 1), "");
assert.strictEqual(L.remoteStatusUrl("http://" + pubHost + "/status.json", radioAllow, 1), "");
assert.strictEqual(L.remoteStatusUrl("//" + pubHost + "/status.json", radioAllow, 1), "");
assert.strictEqual(L.remoteStatusUrl("https://user:pass@" + pubHost + "/status.json", radioAllow, 1), "");
assert.strictEqual(L.remoteStatusUrl("live/superintelmusic.json", radioAllow, 1), "");
assert.strictEqual(L.allowedAudio(playlist, "", [pubHost]), playlist);
assert.strictEqual(L.allowedAudio("https://pub-other.r2.dev/hls/stream.m3u8", "", [pubHost]), "");
assert.strictEqual(L.allowedAudio("https://not" + pubHost + "/hls/a.m3u8", "", [pubHost]), "");
assert.strictEqual(L.allowedAudio(playlist, "", radioAllow), playlist);
assert.strictEqual(L.allowedAudio("https://" + pubHost + "/hls/seg_1.ts", playlist, radioAllow).endsWith("/seg_1.ts"), true);
assert.strictEqual(L.allowedAudio("seg_1.ts", "https://" + pubHost + "/hls/", [pubHost]), "https://" + pubHost + "/hls/seg_1.ts");
assert.strictEqual(L.allowedAudio("https://" + pubHost + "/hls/key.key", playlist, radioAllow).endsWith("/key.key"), true);
assert.strictEqual(L.allowedAudio("https://evil.example/seg.ts", playlist, radioAllow), "");
assert.ok(L.allowedAudio("https://pub-abc.r2.dev/live/seg.m4s", "", radioAllow).includes(".r2.dev/"));

const still = L.marqueePlan(0, false);
assert.strictEqual(still.animate, false);
assert.strictEqual(L.marqueePlan(40, true).animate, false);
const move = L.marqueePlan(40, false);
assert.strictEqual(move.animate, true);
assert.strictEqual(move.duration, 18);
assert.strictEqual(move.easing, "linear");
assert.strictEqual(move.from, "0%");
assert.strictEqual(move.to, "-100%");

const src = fs.readFileSync("spaces.js", "utf8");
assert.ok(src.includes('createElement("audio")'));
assert.ok(!src.includes('createElement("video")') && !src.includes("<video"));
assert.ok(!src.includes("livestream"));
assert.ok(!src.includes("t.me/"));
assert.ok(src.includes("spaces-demo"));
assert.ok(src.includes('host !== "localhost"') && src.includes('"127.0.0.1"'));
assert.ok(src.includes("https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"));
assert.ok(src.includes("https://www.youtube-nocookie.com/embed/live_stream?channel="));
assert.ok(src.includes("xhrSetup: (xhr, requestUrl)"));
assert.ok(src.includes("allowedAudio(requestUrl, url, allow)"));
assert.ok(src.includes("source.fallback"));
assert.ok(src.includes("STATUS_MAX_AGE = 2 * 60 * 1000"));
assert.ok(src.includes("STATUS_OFFLINE_AGE = 8 * 60 * 1000"));
assert.ok(src.includes("liveSyncDurationCount: 3"));
assert.ok(src.includes("maxBufferLength: 60"));
assert.ok(src.includes("recoverMediaError"));
assert.ok(src.includes("startLoad"));
assert.ok(src.includes("Reconnecting…"));
assert.ok(src.includes("mediaSession.playbackState"));

const status = JSON.parse(fs.readFileSync("live/superintelmusic.json", "utf8"));
assert.strictEqual(status.live, false);
assert.strictEqual(status.base, "");
assert.strictEqual(status.hls.audio, "");
assert.ok(!/trycloudflare|http:\/\//i.test(JSON.stringify(status)));

const config = JSON.parse(fs.readFileSync("feeds.config.json", "utf8"));
const feed = config.feeds.find((item) => item.id === "telegram:quietharbor");
assert.ok(feed, "telegram host feed");
assert.strictEqual(feed.profile.name, "Harbor");
const space = config.spaces.find((item) => item.id === "superintelmusic");
assert.strictEqual(space.title, "ViktorychMusic");
assert.strictEqual(space.host.followId, "telegram:quietharbor");
assert.strictEqual(space.source.type, "loop");
assert.strictEqual(space.source.loopUrl, "https://pub-bf9b5e3ebb2b421aa49e7af484f3c22d.r2.dev/loop/current.json");
assert.ok(!space.source.statusUrl);
assert.ok(!space.source.fallback);
assert.deepStrictEqual(space.source.allow, ["pub-bf9b5e3ebb2b421aa49e7af484f3c22d.r2.dev", "r2.dev"]);
assert.ok(!space.source.url);

const bed = {
  live: true,
  mode: "loop",
  url: "https://" + pubHost + "/loop/v202610220722/index.m3u8",
  duration: 2344.663692,
  epoch: 1792627200,
  version: "v202610220722",
  updated: "2020-01-01T00:00:00Z"
};
const bedNow = Date.parse("2026-10-22T12:00:00.000Z");
assert.strictEqual(L.statusStale(bed, bedNow), true);
const loop = L.loopFromDoc(bed, [pubHost]);
assert.strictEqual(loop.live, true);
assert.strictEqual(loop.reconnecting, false);
assert.strictEqual(loop.url, bed.url);
assert.strictEqual(loop.version, bed.version);
assert.strictEqual(loop.duration, bed.duration);
assert.strictEqual(L.loopFromDoc({ ...bed, live: false }, [pubHost]).live, false);
assert.strictEqual(L.loopFromDoc({ ...bed, live: false }, [pubHost]).url, "");
assert.strictEqual(L.loopFromDoc({ ...bed, url: "https://evil.example/loop/index.m3u8" }, [pubHost]).live, false);
assert.strictEqual(L.loopFromDoc({ ...bed, duration: 0 }, [pubHost]).live, false);
assert.strictEqual(L.loopFromDoc({ ...bed, epoch: "nope" }, [pubHost]).live, false);
const clock = { duration: 100, epoch: 1000 };
assert.strictEqual(L.loopPosition(clock, 1000 * 1000), 0);
assert.strictEqual(L.loopPosition(clock, (1000 + 40) * 1000), 40);
assert.strictEqual(L.loopPosition(clock, (1000 + 250) * 1000), 50);
assert.ok(Math.abs(L.loopPosition(clock, (1000 - 10) * 1000) - 90) < 1e-9);
assert.strictEqual(L.loopSeek(clock, (1000 + 99.7) * 1000), 0);
assert.ok(Math.abs(L.loopSeek(clock, (1000 + 99.2) * 1000) - 99.2) < 1e-9);
const circle = L.loopDrift(1, { duration: 2344.663692, epoch: 0 }, (2344.663692 - 1) * 1000);
assert.ok(Math.abs(circle - 2) < 0.001, circle);
assert.ok(src.includes("LOOP_DRIFT_S = 5"));
assert.ok(src.includes("LOOP_RECHECK_MS = 3 * 60 * 1000"));
assert.ok(src.includes("startPosition:"));
assert.ok(src.includes("function loopFromDoc("));
assert.ok(src.includes("function loopRecovery("));
assert.ok(src.includes("function refreshLoopSource("));
assert.ok(src.includes("doc.mode !== \"loop\""));
const recoverAt = src.indexOf("async function recoverPlayback(");
const refreshCall = src.indexOf("refreshLoopSource(", recoverAt);
const liveGuard = src.indexOf("!item.live", recoverAt);
assert.ok(recoverAt > 0 && refreshCall > recoverAt && liveGuard > refreshCall, "refresh the loop manifest before the live guard");
assert.ok(!src.includes("pub-bf9b5e3ebb2b421aa49e7af484f3c22d.r2.dev/status.json"));

const nextBed = {
  ...bed,
  url: "https://" + pubHost + "/loop/v202610220909/index.m3u8",
  version: "v202610220909",
  updated: "2026-10-22T09:11:08Z"
};
const statusJson = {
  live: false,
  station: "ViktorychMusic",
  hls: { audio: "" },
  updated: "2026-10-22T08:06:32Z"
};
assert.strictEqual(L.loopManifestDoc(bed), true);
assert.strictEqual(L.loopManifestDoc(nextBed), true);
assert.strictEqual(L.loopManifestDoc(statusJson), false);
assert.strictEqual(L.loopNeedsRefresh("fatal", 0), true);
assert.strictEqual(L.loopNeedsRefresh("stall", 0), true);
assert.strictEqual(L.loopNeedsRefresh("watch", 0), true);
assert.strictEqual(L.loopNeedsRefresh("network", 404), true);
assert.strictEqual(L.loopNeedsRefresh("media", 404), true);
assert.strictEqual(L.loopNeedsRefresh("media", 0), false);
assert.strictEqual(L.loopNeedsRefresh("play", 0), false);
const swapped = L.loopRecovery(loop, nextBed, [pubHost], "network", 404);
assert.strictEqual(swapped.refresh, true);
assert.strictEqual(swapped.swap, true);
assert.strictEqual(swapped.live, true);
assert.strictEqual(swapped.seek, true);
assert.strictEqual(swapped.url, nextBed.url);
assert.strictEqual(swapped.version, "v202610220909");
const stalled = L.loopRecovery(loop, nextBed, [pubHost], "stall", 0);
assert.strictEqual(stalled.swap, true);
assert.strictEqual(stalled.seek, true);
const sameBed = L.loopRecovery(loop, bed, [pubHost], "fatal", 404);
assert.strictEqual(sameBed.refresh, true);
assert.strictEqual(sameBed.swap, false);
assert.strictEqual(sameBed.live, true);
assert.strictEqual(sameBed.url, bed.url);
const poisoned = L.loopRecovery(loop, statusJson, [pubHost], "network", 404);
assert.strictEqual(poisoned.live, true, "status.json live:false must not take the loop offline");
assert.strictEqual(poisoned.swap, false);
assert.strictEqual(poisoned.url, bed.url);
const turnedOff = L.loopRecovery(loop, { ...nextBed, live: false }, [pubHost], "fatal", 404);
assert.strictEqual(turnedOff.live, false);
assert.strictEqual(turnedOff.swap, false);
assert.strictEqual(turnedOff.url, "");
const flacBed = {
  ...nextBed,
  codec: "flac",
  sample_rate: 44100,
  bits: 16,
  fallback: "https://" + pubHost + "/loop/v202610220909/aac/index.m3u8"
};
const primaryChoice = L.loopPlayChoice(flacBed, [pubHost], true);
assert.strictEqual(primaryChoice.url, flacBed.url);
assert.strictEqual(primaryChoice.primary, flacBed.url);
assert.strictEqual(primaryChoice.fallback, flacBed.fallback);
assert.strictEqual(primaryChoice.source, "r2");
assert.strictEqual(L.loopPlayChoice({ ...flacBed, primary: "tg" }, [pubHost], true).source, "tg");
assert.strictEqual(L.loopPlayChoice({ ...flacBed, primary: "TG" }, [pubHost], true).source, "tg");
assert.strictEqual(L.loopPlayChoice({ ...flacBed, primary: "nope" }, [pubHost], true).source, "r2");
assert.strictEqual(L.loopPrimaryName(undefined), "r2");
const aacChoice = L.loopPlayChoice(flacBed, [pubHost], false);
assert.strictEqual(aacChoice.live, true);
assert.strictEqual(aacChoice.url, flacBed.fallback);
assert.strictEqual(aacChoice.version, flacBed.version);
const keepPrimary = L.loopPlayChoice(nextBed, [pubHost], false);
assert.strictEqual(keepPrimary.url, nextBed.url);
const foreignFallback = L.loopPlayChoice({ ...flacBed, fallback: "https://evil.example/aac.m3u8" }, [pubHost], false);
assert.strictEqual(foreignFallback.url, flacBed.url);
const swappedAac = L.loopRecovery({ live: true, url: bed.url, version: bed.version }, flacBed, [pubHost], "fatal", 0, false);
assert.strictEqual(swappedAac.swap, true);
assert.strictEqual(swappedAac.seek, true);
assert.strictEqual(swappedAac.url, flacBed.fallback);
const stayAac = L.loopRecovery({ live: true, url: flacBed.fallback, version: flacBed.version }, flacBed, [pubHost], "unsupported", 0, false);
assert.strictEqual(stayAac.swap, false);
assert.strictEqual(stayAac.url, flacBed.fallback);
assert.ok(src.includes("function loopPlayChoice("));
assert.ok(src.includes("function flacInMp4("));
assert.ok(src.includes("function loopMirrorPlan("));
assert.ok(src.includes("maxNumRetry: 1"));

const loopApi = "https://viktorych-accounts.example.workers.dev";
const loopR2 = "https://" + pubHost + "/loop/v202610221300/index.m3u8";
const loopTg = loopApi + "/tg/loop/v202610221300/index.m3u8";
const once = L.loopMirrorPlan({
  r2Url: loopR2,
  api: loopApi,
  version: "v202610221300",
  via: "r2",
  failures: 1,
  status: 502,
  position: 42.5
});
assert.strictEqual(once.switched, false);
assert.strictEqual(once.url, loopR2);
assert.strictEqual(once.seek, 42.5);
const fallen = L.loopMirrorPlan({
  r2Url: loopR2,
  api: loopApi,
  version: "v202610221300",
  via: "r2",
  failures: 2,
  status: 404,
  position: 42.5
});
assert.strictEqual(fallen.switched, true);
assert.strictEqual(fallen.via, "telegram");
assert.strictEqual(fallen.url, loopTg);
assert.strictEqual(fallen.seek, 42.5);
const networkDown = L.loopMirrorPlan({
  r2Url: loopR2,
  api: loopApi,
  version: "v202610221300",
  via: "r2",
  failures: 2,
  network: true,
  position: 42.5
});
assert.strictEqual(networkDown.switched, true);
assert.strictEqual(networkDown.url, loopTg);
assert.strictEqual(networkDown.seek, 42.5);
const aacR2 = "https://" + pubHost + "/loop/v202610221300/aac/index.m3u8";
const aacMirror = L.loopMirrorPlan({
  r2Url: aacR2,
  api: loopApi,
  version: "v202610221300",
  via: "r2",
  failures: 2,
  status: 502,
  position: 42.5
});
assert.strictEqual(aacMirror.url, loopApi + "/tg/loop/v202610221300/aac/index.m3u8");
const nextLoop = L.loopMirrorPlan({
  r2Url: loopR2,
  api: loopApi,
  version: "v202610221300",
  nextVersion: "v202610221400",
  via: "telegram",
  failures: 2,
  status: 502,
  position: 42.5
});
assert.strictEqual(nextLoop.switched, false);
assert.strictEqual(nextLoop.via, "r2");
assert.strictEqual(nextLoop.url, loopR2);
const stayTg = L.loopMirrorPlan({
  r2Url: loopR2,
  api: loopApi,
  version: "v202610221300",
  via: "telegram",
  failures: 1,
  status: 502,
  position: 42.5
});
assert.strictEqual(stayTg.switched, false);
assert.strictEqual(stayTg.via, "telegram");
assert.strictEqual(stayTg.url, loopTg);
const backToR2 = L.loopMirrorPlan({
  r2Url: loopR2,
  api: loopApi,
  version: "v202610221300",
  via: "telegram",
  failures: 2,
  status: 502,
  position: 42.5
});
assert.strictEqual(backToR2.switched, true);
assert.strictEqual(backToR2.via, "r2");
assert.strictEqual(backToR2.url, loopR2);
assert.strictEqual(backToR2.seek, 42.5);
const startTg = L.loopMirrorPlan({
  r2Url: loopR2,
  api: loopApi,
  version: "v202610221300",
  primary: "tg",
  via: "tg",
  failures: 0,
  position: 42.5
});
assert.strictEqual(startTg.switched, false);
assert.strictEqual(startTg.via, "telegram");
assert.strictEqual(startTg.url, loopTg);
assert.strictEqual(startTg.seek, 42.5);
const tgDown = L.loopMirrorPlan({
  r2Url: loopR2,
  api: loopApi,
  version: "v202610221300",
  primary: "tg",
  via: "telegram",
  failures: 2,
  status: 503,
  position: 42.5
});
assert.strictEqual(tgDown.switched, true);
assert.strictEqual(tgDown.via, "r2");
assert.strictEqual(tgDown.url, loopR2);
assert.strictEqual(tgDown.seek, 42.5);
const r2DownAgain = L.loopMirrorPlan({
  r2Url: loopR2,
  api: loopApi,
  version: "v202610221300",
  primary: "tg",
  via: "r2",
  failures: 2,
  network: true,
  position: 42.5
});
assert.strictEqual(r2DownAgain.switched, true);
assert.strictEqual(r2DownAgain.via, "telegram");
assert.strictEqual(r2DownAgain.url, loopTg);
assert.strictEqual(r2DownAgain.seek, 42.5);
const nextTg = L.loopMirrorPlan({
  r2Url: loopR2,
  api: loopApi,
  version: "v202610221300",
  nextVersion: "v202610221400",
  primary: "tg",
  via: "r2",
  failures: 2,
  status: 500,
  position: 42.5
});
assert.strictEqual(nextTg.switched, false);
assert.strictEqual(nextTg.via, "telegram");
assert.strictEqual(nextTg.url, loopTg);
const attachR2 = L.loopAttachPlan({ playUrl: loopR2, api: loopApi, version: "v202610221300" });
assert.strictEqual(attachR2.via, "r2");
assert.strictEqual(attachR2.url, loopR2);
assert.strictEqual(attachR2.primary, "r2");
const attachTg = L.loopAttachPlan({ playUrl: loopR2, api: loopApi, version: "v202610221300", primary: "tg" });
assert.strictEqual(attachTg.via, "telegram");
assert.strictEqual(attachTg.url, loopTg);
assert.strictEqual(attachTg.primary, "tg");
const flipToTg = L.loopAttachPlan({
  playUrl: loopR2,
  api: loopApi,
  version: "v202610221300",
  primary: "tg",
  savedPrimary: "r2",
  savedVersion: "v202610221300",
  savedPlayUrl: loopR2,
  savedVia: "r2"
});
assert.strictEqual(flipToTg.via, "telegram");
assert.strictEqual(flipToTg.url, loopTg);
const keepFallback = L.loopAttachPlan({
  playUrl: loopR2,
  api: loopApi,
  version: "v202610221300",
  primary: "r2",
  savedPrimary: "r2",
  savedVersion: "v202610221300",
  savedPlayUrl: loopR2,
  savedVia: "telegram"
});
assert.strictEqual(keepFallback.via, "telegram");
assert.strictEqual(keepFallback.url, loopTg);
const versionResets = L.loopAttachPlan({
  playUrl: loopR2,
  api: loopApi,
  version: "v202610221400",
  primary: "r2",
  savedPrimary: "r2",
  savedVersion: "v202610221300",
  savedPlayUrl: loopR2,
  savedVia: "telegram"
});
assert.strictEqual(versionResets.via, "r2");
assert.strictEqual(versionResets.url, loopR2);
const noApi = L.loopMirrorPlan({
  r2Url: loopR2,
  api: "",
  version: "v202610221300",
  via: "r2",
  failures: 2,
  network: true,
  position: 42.5
});
assert.strictEqual(noApi.switched, false);
assert.strictEqual(noApi.url, loopR2);
const badApi = L.loopMirrorPlan({
  r2Url: loopR2,
  api: "http://accounts.example",
  version: "v202610221300",
  via: "r2",
  failures: 2,
  status: 500,
  position: 3
});
assert.strictEqual(badApi.switched, false);
assert.strictEqual(badApi.url, loopR2);
assert.ok(src.includes('audio/mp4; codecs="flac"'));
assert.ok(src.includes("MediaSource.isTypeSupported"));
assert.ok(src.includes(".canPlayType("));
assert.strictEqual(src.includes('"/hls/stream.m3u8"'), src.includes('server + "/hls/stream.m3u8"'));

const worker = fs.readFileSync("sw.js", "utf8");
assert.ok(worker.includes('VERSION = "viktorych-a260-__SW_VERSION__"'));
assert.ok(worker.includes("./spaces.js") && worker.includes("./spaces.css"));
assert.ok(!worker.includes("superintelmusic.json"));
assert.ok(worker.includes("isSpaceStatus"));
assert.ok(worker.includes("function isSpaceAsset(url)"));
assert.ok(worker.includes("isSpaceStatus(url) || isSpaceAsset(url)"));
space.source.allow.forEach((host) => {
  assert.ok(worker.includes('"' + host + '"'), host);
});
const branchAt = worker.indexOf("if (isSpaceStatus(url) || isSpaceAsset(url))");
const branch = worker.slice(branchAt, branchAt + 180);
assert.ok(branch.includes('cache: "no-store"'));
assert.ok(!branch.includes("cache.put") && !branch.includes("caches.open"));
assert.ok(worker.includes("function isLoopPointer("));
assert.ok(worker.includes("function isLoopVersionMedia("));
assert.ok(worker.includes("function forgetLoopCaches("));
assert.ok(worker.includes("loop/current.json"));
const pointerAt = worker.indexOf("if (isLoopPointer(url))");
assert.ok(pointerAt > 0 && pointerAt < branchAt);
const pointerFn = worker.slice(worker.indexOf("async function fetchLoopPointer"), worker.indexOf("async function fetchLoopPointer") + 700);
assert.ok(pointerFn.includes('cache: "no-store"'));
assert.ok(!pointerFn.includes("cache.put") && !pointerFn.includes("caches.open"));
assert.ok(!new RegExp("supa" + "base|sb_" + "publishable|nadjniz" + "sdaskttxahclp", "i").test(src + worker + JSON.stringify(config)));

console.log("spaces row tests ok");
