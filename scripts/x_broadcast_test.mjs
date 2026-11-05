/* URL shapes, playback allow-list, autoplay rules and the Watch on X card. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  broadcastId, openUrl, playbackAllowed, posterAllowed, shouldAutoplay, present, cardHtml,
  playbackForBroadcast, normalizeState, extractFor, BLOCKED_HOSTS
} from "../shared/x-broadcast.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ID = "1BBBBBBBBBBBB";
const PAGE = "https://x.com/i/broadcasts/" + ID;

const shapes = [
  ["https://x.com/i/broadcasts/" + ID, ID],
  ["https://twitter.com/i/broadcasts/" + ID + "?t=1", ID],
  ["https://mobile.x.com/i/broadcasts/" + ID + "/", ID],
  ["https://mobile.twitter.com/i/broadcasts/" + ID, ID],
  ["https://www.x.com/i/broadcasts/" + ID, ID],
  ["https://www.periscope.tv/w/" + ID, ID],
  ["https://www.pscp.tv/w/" + ID, ID],
  ["https://www.pscp.tv/example/" + ID, ID],
  ["https://www.periscope.tv/example/" + ID + "?t=2", ID],
  ["https://pscp.tv/w/" + ID + "#t=1", ID]
];
shapes.forEach(([url, id]) => {
  assert.equal(broadcastId(url), id, url);
  assert.equal(openUrl(id), PAGE);
});

[
  "https://x.com.evil.example/i/broadcasts/" + ID,
  "https://notx.com/i/broadcasts/" + ID,
  "https://x.com/i/spaces/" + ID,
  "https://x.com/i/broadcasts/short",
  "https://api.periscope.tv/api/v2/getAccessPublic?broadcast_id=" + ID,
  "https://twitter.com/example/status/1000000000000001",
  "javascript:alert(1)",
  "https://www.pscp.tv/w/../../etc",
  ""
].forEach((url) => assert.equal(broadcastId(url), "", url));

assert.equal(playbackAllowed("https://video.twimg.com/ext_tw_video/1/pl/a.m3u8"), true);
assert.equal(playbackAllowed("https://video.twimg.com/ext_tw_video/1/vid/a.mp4"), true);
assert.equal(playbackAllowed("https://prod-fastly-us-east-1.video.pscp.tv/Transcoding/v1/hls/example/master.m3u8"), true);
assert.equal(playbackAllowed("https://prod-fastly-us-east-1.video.pscp.tv/example/file.mp4"), false);
assert.equal(playbackAllowed("http://video.twimg.com/a.m3u8"), false);
assert.equal(playbackAllowed("https://evil.example/a.m3u8"), false);
assert.equal(playbackAllowed("https://api.periscope.tv/a.m3u8"), false);
assert.equal(playbackAllowed("https://user:pass@video.twimg.com/a.m3u8"), false);
BLOCKED_HOSTS.forEach((host) => assert.equal(playbackAllowed("https://" + host + "/a.m3u8"), false, host));

assert.equal(posterAllowed("https://pbs.twimg.com/media/example.jpg"), true);
assert.equal(posterAllowed("https://pbs.twimg.com/media/example.png"), true);
assert.equal(posterAllowed("http://pbs.twimg.com/media/example.jpg"), false);
assert.equal(posterAllowed("https://evil.example/example.jpg"), false);

assert.equal(normalizeState("RUNNING", ""), "live");
assert.equal(normalizeState("ENDED", "https://video.pscp.tv/a.m3u8?type=replay"), "replay");
assert.equal(normalizeState("ENDED", ""), "ended");
assert.equal(normalizeState("", "https://video.twimg.com/a.m3u8?type=replay"), "replay");
assert.equal(normalizeState("", ""), "unknown");

const stolen = extractFor({
  mediaDetails: [{ video_info: { variants: [{ url: "https://video.twimg.com/ext_tw_video/1/pl/a.m3u8" }] } }]
}, ID, false);
assert.equal(stolen.hls, "");
const named = extractFor({
  url: PAGE,
  state: "live",
  thumbnail_url: "https://pbs.twimg.com/media/example.jpg",
  variants: [{ url: "https://evil.example/x.m3u8" }, { url: "https://video.twimg.com/ext_tw_video/1/pl/b.m3u8" }]
}, ID, false);
assert.equal(named.hls, "https://video.twimg.com/ext_tw_video/1/pl/b.m3u8");
assert.equal(named.state, "live");
assert.equal(named.poster, "https://pbs.twimg.com/media/example.jpg");

const known = playbackForBroadcast([
  { type: "video", hls: "https://video.twimg.com/ext_tw_video/1/pl/other.m3u8" },
  { type: "broadcast", url: PAGE, hls: "https://video.twimg.com/amplify_video/1/pl/cast.m3u8", poster: "https://pbs.twimg.com/media/example.webp" }
], ID);
assert.equal(known.hls, "https://video.twimg.com/amplify_video/1/pl/cast.m3u8");
assert.equal(playbackForBroadcast([{ type: "video", url: "https://video.twimg.com/a.mp4", hls: "https://video.twimg.com/a.m3u8" }], ID).hls, "");

function html(model) {
  return cardHtml(model, { tr: (key) => key, esc: (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])) });
}

const pending = html({ id: ID, statusId: "1000000000000001" });
assert.match(pending, /data-xcast="1BBBBBBBBBBBB"/);
assert.match(pending, /data-xcast-mode="pending"/);
assert.match(pending, /data-act="xcast-play"/);
assert.match(pending, /href="https:\/\/x\.com\/i\/broadcasts\/1BBBBBBBBBBBB"/);
assert.equal(pending.includes("<iframe"), false);
assert.equal(pending.includes("<video"), false);
assert.equal(pending.includes("autoplay"), false);
assert.match(pending, /hidden>Watch on X</);

const play = html({
  id: ID,
  hls: "https://video.twimg.com/ext_tw_video/1/pl/a.m3u8?type=replay",
  poster: "https://pbs.twimg.com/media/example.jpg",
  state: "replay",
  title: "Evening",
  width: 1280,
  height: 720
});
assert.match(play, /data-xcast-mode="play"/);
assert.match(play, /data-xcast-hls="https:\/\/video\.twimg\.com\/ext_tw_video\/1\/pl\/a\.m3u8\?type=replay"/);
assert.match(play, /loading="lazy"/);
assert.match(play, />Replay</);
assert.equal(play.includes("<iframe"), false);
assert.equal(play.includes("<video"), false);
assert.equal(play.includes("autoplay"), false);
assert.equal(play.includes("This broadcast plays on X."), false);

const fallback = html({ id: ID, checked: true, state: "ended", title: "Done" });
assert.match(fallback, /data-xcast-mode="fallback"/);
assert.match(fallback, />Watch on X</);
assert.match(fallback, /This broadcast plays on X\./);
assert.equal(fallback.includes("xcast-go"), false);
assert.equal(fallback.includes("<iframe"), false);
assert.equal(fallback.includes("<video"), false);
assert.equal(fallback.includes("autoplay"), false);
assert.equal(html({ id: "bad/id" }), "");

const base = { inView: true, hasPlayback: true, setting: "all", type: "wifi", saveData: false, effectiveType: "4g" };
assert.equal(shouldAutoplay(base), true);
assert.equal(shouldAutoplay(Object.assign({}, base, { type: "cellular" })), false);
assert.equal(shouldAutoplay(Object.assign({}, base, { type: "cellular", setting: "all" })), false);
assert.equal(shouldAutoplay(Object.assign({}, base, { setting: "never" })), false);
assert.equal(shouldAutoplay(Object.assign({}, base, { saveData: true })), false);
assert.equal(shouldAutoplay(Object.assign({}, base, { effectiveType: "3g" })), false);
assert.equal(shouldAutoplay(Object.assign({}, base, { effectiveType: "2g" })), false);
assert.equal(shouldAutoplay(Object.assign({}, base, { inView: false })), false);
assert.equal(shouldAutoplay(Object.assign({}, base, { reducedMotion: true })), false);
assert.equal(shouldAutoplay(Object.assign({}, base, { hasPlayback: false })), false);

const keys = [
  "X broadcast",
  "Play broadcast",
  "This broadcast plays on X.",
  "Could not load this broadcast.",
  "X broadcasts",
  "Public X broadcasts play in the feed when a public stream is available. Otherwise the card opens the broadcast on X."
];
const packs = ["en", "es", "ru", "hi"].map((code) => readFileSync(join(root, "i18n", code + ".js"), "utf8"));
keys.forEach((key) => {
  packs.forEach((pack, index) => assert.ok(pack.includes(JSON.stringify(key) + ":"), key + " missing in pack " + index));
});
const es = packs[1];
assert.ok(es.includes('"X broadcast": "Emisión de X"'));
assert.ok(es.includes('"This broadcast plays on X.": "Esta emisión se ve en X."'));
assert.notEqual(present({ id: ID, checked: true }).mode, "play");

console.log("x_broadcast_test: " + shapes.length + " url shapes ok");
