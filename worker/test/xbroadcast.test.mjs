import test from "node:test";
import assert from "node:assert/strict";
import { featureFor } from "../src/feature-flags.js";
import { handleXBroadcast, resolveXBroadcast } from "../src/xbroadcast.js";
import { BLOCKED_HOSTS } from "../../shared/x-broadcast.js";

const ID = "1BBBBBBBBBBBB";
const STATUS = "1000000000000001";
const HLS = "https://prod-fastly-us-east-1.video.pscp.tv/Transcoding/v1/hls/example/master.m3u8?type=replay";
const POSTER = "https://pbs.twimg.com/media/example.jpg";

function hostOf(url) {
  return new URL(url).hostname;
}

test("the broadcast route is its own switch", () => {
  assert.equal(featureFor("/v1/x-broadcast"), "x_broadcast");
  assert.equal(featureFor("/v1/xv"), "");
});

test("syndication playlist is used only when the document names the broadcast", async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    assert.equal(BLOCKED_HOSTS.includes(hostOf(url)), false, url);
    return new Response(JSON.stringify({
      text: "https://x.com/i/broadcasts/" + ID,
      card: { state: "ENDED", title: "Public replay", thumbnail_url: POSTER },
      mediaDetails: [{ type: "video", video_info: { variants: [{ content_type: "application/x-mpegURL", url: HLS }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const found = await resolveXBroadcast(ID, STATUS, fetcher);
  assert.equal(found.none, false);
  assert.equal(found.hls, HLS);
  assert.equal(found.kind, "hls");
  assert.equal(found.state, "replay");
  assert.equal(found.poster, POSTER);
  assert.equal(found.title, "Public replay");
  assert.equal(found.source, "syndication");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /cdn\.syndication\.twimg\.com/);
});

test("a post document that never mentions the broadcast does not donate its video", async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (hostOf(url) === "publish.twitter.com") {
      return new Response(JSON.stringify({
        html: "<blockquote><a href=\"https://x.com/i/broadcasts/" + ID + "\"></a></blockquote>"
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      mediaDetails: [{ video_info: { variants: [{ url: "https://video.twimg.com/ext_tw_video/1/pl/a.m3u8" }] } }]
    }), { status: 200 });
  };
  const found = await resolveXBroadcast(ID, STATUS, fetcher);
  assert.equal(found.none, true);
  assert.equal(found.hls, "");
  assert.equal(found.openUrl, "https://x.com/i/broadcasts/" + ID);
  assert.ok(calls.some((url) => hostOf(url) === "publish.twitter.com"));
  assert.ok(calls.every((url) => !BLOCKED_HOSTS.includes(hostOf(url))));
});

test("official oEmbed can carry a public twimg playlist and ignores other hosts", async () => {
  const playlist = "https://video.twimg.com/amplify_video/1/pl/a.m3u8";
  const fetcher = async (url) => {
    assert.equal(hostOf(url), "publish.twitter.com");
    return new Response(JSON.stringify({
      title: "Live now",
      thumbnail_url: POSTER,
      html: "<video><source src=\"" + playlist + "\" type=\"application/x-mpegURL\"><source src=\"https://evil.example/secret.m3u8\"></video>"
    }), { status: 200 });
  };
  const found = await resolveXBroadcast(ID, "", fetcher);
  assert.equal(found.hls, playlist);
  assert.equal(found.poster, POSTER);
  assert.equal(found.state, "unknown");
  assert.equal(found.none, false);
});

test("oEmbed without a stream is a fallback, not a player", async () => {
  const fetcher = async () => new Response(JSON.stringify({
    html: "<blockquote class=\"twitter-tweet\"><a href=\"https://x.com/i/broadcasts/" + ID + "\"></a></blockquote>"
  }), { status: 200 });
  const found = await resolveXBroadcast(ID, "", fetcher);
  assert.equal(found.none, true);
  assert.equal(found.hls, "");
  assert.equal(found.openUrl, "https://x.com/i/broadcasts/" + ID);
  const res = await handleXBroadcast(new Request("https://a.test/v1/x-broadcast?id=" + ID), { fetch: fetcher });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).none, true);
});

test("a bad id is rejected and private hosts are never requested", async () => {
  const bad = await handleXBroadcast(new Request("https://a.test/v1/x-broadcast?id=nope"), { fetch: async () => { throw new Error("called"); } });
  assert.equal(bad.status, 400);
  const calls = [];
  await resolveXBroadcast(ID, STATUS, async (url) => {
    calls.push(hostOf(url));
    return new Response("no", { status: 404 });
  });
  assert.deepEqual(calls, ["cdn.syndication.twimg.com", "api.fxtwitter.com", "api.vxtwitter.com", "publish.twitter.com"]);
});
