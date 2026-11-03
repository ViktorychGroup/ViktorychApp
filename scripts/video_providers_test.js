/* Golden URL-matching tests for video-providers.js. Every id, slug, channel,
   and host below is made up. */
"use strict";
const assert = require("assert");
const p = require("../video-providers.js");

const O = { origin: "https://app.example", host: "app.example" };
const YT = "Zz0Yy1Xx2Ww";
const nocookie = (extra) => "https://www.youtube-nocookie.com/embed/" + YT + "?autoplay=1&playsinline=1&rel=0&enablejsapi=1&origin=https%3A%2F%2Fapp.example" + (extra || "");

const golden = [
  // YouTube: every URL shape, with and without timestamps.
  ["https://www.youtube.com/watch?v=" + YT, "youtube", nocookie(), "16:9"],
  ["https://youtube.com/watch?v=" + YT + "&t=90", "youtube", nocookie("&start=90"), "16:9"],
  ["https://m.youtube.com/watch?feature=share&v=" + YT + "&t=1m30s", "youtube", nocookie("&start=90"), "16:9"],
  ["https://music.youtube.com/watch?v=" + YT + "&list=FAKELIST", "youtube", nocookie(), "16:9"],
  ["https://youtu.be/" + YT, "youtube", nocookie(), "16:9"],
  ["https://youtu.be/" + YT + "?si=fakeShare&t=1h2m3s", "youtube", nocookie("&start=3723"), "16:9"],
  ["https://www.youtube.com/shorts/" + YT, "youtube", nocookie(), "9:16"],
  ["https://youtube.com/shorts/" + YT + "?feature=share", "youtube", nocookie(), "9:16"],
  ["https://www.youtube.com/live/" + YT + "?t=42", "youtube", nocookie("&start=42"), "16:9"],
  ["https://www.youtube.com/embed/" + YT + "?start=7", "youtube", nocookie("&start=7"), "16:9"],
  ["https://www.youtube.com/watch?v=" + YT + "#t=2m", "youtube", nocookie("&start=120"), "16:9"],
  // Vimeo
  ["https://vimeo.com/987654321", "vimeo", "https://player.vimeo.com/video/987654321?autoplay=1&playsinline=1&dnt=1", "16:9"],
  ["https://vimeo.com/987654321/abc123def0", "vimeo", "https://player.vimeo.com/video/987654321?h=abc123def0&autoplay=1&playsinline=1&dnt=1", "16:9"],
  ["https://vimeo.com/channels/fakechannel/987654321#t=30s", "vimeo", "https://player.vimeo.com/video/987654321?autoplay=1&playsinline=1&dnt=1#t=30s", "16:9"],
  ["https://player.vimeo.com/video/987654321", "vimeo", "https://player.vimeo.com/video/987654321?autoplay=1&playsinline=1&dnt=1", "16:9"],
  // Dailymotion
  ["https://www.dailymotion.com/video/x9fake1", "dailymotion", "https://www.dailymotion.com/embed/video/x9fake1?autoplay=1&queue-enable=false", "16:9"],
  ["https://dai.ly/x9fake1", "dailymotion", "https://www.dailymotion.com/embed/video/x9fake1?autoplay=1&queue-enable=false", "16:9"],
  // Twitch clips and VODs carry parent=
  ["https://clips.twitch.tv/FakeClipSlug-AbC123", "twitch", "https://clips.twitch.tv/embed?clip=FakeClipSlug-AbC123&parent=app.example&autoplay=true", "16:9"],
  ["https://www.twitch.tv/examplechannel/clip/FakeClipSlug-AbC123?filter=clips", "twitch", "https://clips.twitch.tv/embed?clip=FakeClipSlug-AbC123&parent=app.example&autoplay=true", "16:9"],
  ["https://www.twitch.tv/videos/1234567890", "twitch", "https://player.twitch.tv/?video=v1234567890&parent=app.example&autoplay=true", "16:9"],
  ["https://m.twitch.tv/videos/1234567890?t=1h0m5s", "twitch", "https://player.twitch.tv/?video=v1234567890&parent=app.example&autoplay=true&time=1h0m5s", "16:9"],
  // Streamable
  ["https://streamable.com/fake12", "streamable", "https://streamable.com/e/fake12?autoplay=1", "16:9"],
  ["https://streamable.com/e/fake12", "streamable", "https://streamable.com/e/fake12?autoplay=1", "16:9"],
  // Kick (live channels only)
  ["https://kick.com/examplechannel", "kick", "https://player.kick.com/examplechannel?autoplay=true", "16:9"],
  // Odysee
  ["https://odysee.com/@FakeChannel:a/fake-video-title:b", "odysee", "https://odysee.com/$/embed/@FakeChannel:a/fake-video-title:b?autoplay=true", "16:9"],
  ["https://odysee.com/$/embed/@FakeChannel:a/fake-video-title:b", "odysee", "https://odysee.com/$/embed/@FakeChannel:a/fake-video-title:b?autoplay=true", "16:9"],
  // BitChute
  ["https://www.bitchute.com/video/FaKeVid0001/", "bitchute", "https://www.bitchute.com/embed/FaKeVid0001/", "16:9"],
  // Rumble embed URL (page URLs need the page's oEmbed, below)
  ["https://rumble.com/embed/v9fake/", "rumble", "https://rumble.com/embed/v9fake/?autoplay=2", "16:9"],
  // TikTok
  ["https://www.tiktok.com/@example.user/video/7000000000000000001", "tiktok", "https://www.tiktok.com/player/v1/7000000000000000001?autoplay=1&loop=1&controls=0&progress_bar=0&play_button=0&volume_control=0&fullscreen_button=0&timestamp=0&music_info=0&description=0&rel=0&closed_caption=0", "9:16"],
  // Facebook video and reels
  ["https://www.facebook.com/watch/?v=100000000000001", "facebook", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fwatch%2F%3Fv%3D100000000000001&show_text=false&autoplay=true&mute=0", "16:9"],
  ["https://www.facebook.com/ExamplePage/videos/100000000000001/", "facebook", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2FExamplePage%2Fvideos%2F100000000000001%2F&show_text=false&autoplay=true&mute=0", "16:9"],
  ["https://www.facebook.com/reel/100000000000001", "facebook", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Freel%2F100000000000001&show_text=false&autoplay=true&mute=0", "9:16"],
  ["https://fb.watch/FaKe01/", "facebook", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Ffb.watch%2FFaKe01%2F&show_text=false&autoplay=true&mute=0", "16:9"],
  // Instagram reels
  ["https://www.instagram.com/reel/FaKeReel01/", "instagram", "https://www.instagram.com/reel/FaKeReel01/embed/", "9:16"],
  ["https://www.instagram.com/reels/FaKeReel01/?igsh=fake", "instagram", "https://www.instagram.com/reel/FaKeReel01/embed/", "9:16"]
];

golden.forEach(([url, provider, embed, aspect]) => {
  const hit = p.resolve(url, null, O);
  assert.ok(hit, "no match: " + url);
  assert.strictEqual(hit.provider, provider, url);
  assert.strictEqual(hit.embed, embed, url);
  assert.strictEqual(hit.aspect, aspect, url);
  assert.strictEqual(hit.open, new URL(url).href, url);
  assert.ok(p.known(url), "known: " + url);
});

// YouTube posters come from i.ytimg.com; others use the preview card image.
assert.strictEqual(p.resolve("https://youtu.be/" + YT, null, O).thumb, "https://i.ytimg.com/vi/" + YT + "/hqdefault.jpg");
assert.strictEqual(p.resolve("https://vimeo.com/987654321", { image: "https://img.example/poster.jpg" }, O).thumb, "https://img.example/poster.jpg");
assert.strictEqual(p.resolve("https://vimeo.com/987654321", { image: "http://img.example/poster.jpg" }, O).thumb, "");

// Not videos, or no official embed: stay a link.
[
  "https://www.youtube.com/",
  "https://www.youtube.com/@examplechannel",
  "https://www.youtube.com/watch?v=short",
  "https://www.youtube.com/playlist?list=FAKELIST",
  "https://youtu.be/",
  "https://notyoutube.com/watch?v=" + YT,
  "https://youtube.com.evil.example/watch?v=" + YT,
  "https://vimeo.com/fakeuser",
  "https://www.twitch.tv/examplechannel",
  "https://www.twitch.tv/directory",
  "https://kick.com/categories",
  "https://kick.com/examplechannel?clip=clip_FAKE01",
  "https://kick.com/examplechannel/clips/clip_FAKE01",
  "https://www.tiktok.com/@example.user",
  "https://www.facebook.com/ExamplePage",
  "https://www.instagram.com/p/FaKePost01/",
  "https://rumble.com/v9fake-some-title.html",
  "https://example.com/videos/watch/0f0f0f0f-0000-4000-8000-000000000000",
  "https://example.com/article",
  "ftp://youtu.be/" + YT,
  "javascript:alert(1)",
  "not a url"
].forEach((url) => assert.strictEqual(p.resolve(url, null, O), null, "should not embed: " + url));

// Rumble page URLs and PeerTube instances resolve through the page's own
// oEmbed / og:video player.
const rumble = p.resolve("https://rumble.com/v9fake-some-title.html", { embed: { src: "https://rumble.com/embed/v9fake0/?pub=fake", width: 640, height: 360 }, image: "https://img.example/r.jpg" }, O);
assert.strictEqual(rumble.provider, "rumble");
assert.strictEqual(rumble.embed, "https://rumble.com/embed/v9fake0/?pub=fake");
assert.strictEqual(rumble.thumb, "https://img.example/r.jpg");
assert.ok(p.candidate("https://rumble.com/v9fake-some-title.html"));

const peer = p.resolve("https://tube.example/w/FaKePeerTube01", { video: "https://tube.example/videos/embed/0f0f0f0f-0000-4000-8000-000000000000", videoType: "text/html", videoWidth: 1280, videoHeight: 720 }, O);
assert.strictEqual(peer.provider, "peertube");
assert.strictEqual(peer.embed, "https://tube.example/videos/embed/0f0f0f0f-0000-4000-8000-000000000000");
assert.strictEqual(peer.aspect, "16:9");
assert.ok(p.candidate("https://tube.example/videos/watch/0f0f0f0f-0000-4000-8000-000000000000"));

// Any site with an og:video player page or an oEmbed "video" iframe.
const og = p.resolve("https://news.example/story", { video: "https://player.news.example/embed/fake1", videoType: "text/html", videoWidth: 720, videoHeight: 1280, site: "News Example" }, O);
assert.strictEqual(og.provider, "embed");
assert.strictEqual(og.aspect, "9:16");
assert.strictEqual(og.name, "News Example");
const oembed = p.resolve("https://news.example/story", { embed: { src: "https://player.news.example/v/fake2", width: 480, height: 270 } }, O);
assert.strictEqual(oembed.embed, "https://player.news.example/v/fake2");

// Raw files are never played from og:video: official players only.
[
  { video: "https://cdn.example/fake.mp4" },
  { video: "https://cdn.example/fake.m3u8?sig=1" },
  { video: "https://cdn.example/stream", videoType: "video/mp4" },
  { video: "http://player.example/embed/fake" },
  { video: "https://cdn.example/watch/fake" },
  { embed: { src: "javascript:alert(1)" } },
  { embed: { src: "http://player.example/embed/fake" } }
].forEach((meta) => assert.strictEqual(p.resolve("https://news.example/story", meta, O), null, JSON.stringify(meta)));

// Timestamps
assert.strictEqual(p.seconds("90"), 90);
assert.strictEqual(p.seconds("1m30s"), 90);
assert.strictEqual(p.seconds("1h2m3s"), 3723);
assert.strictEqual(p.seconds("01:30"), 90);
assert.strictEqual(p.seconds("soon"), 0);

// Pause messages for players that support them; others unload.
assert.strictEqual(JSON.parse(p.pauseMessage("youtube")).func, "pauseVideo");
assert.strictEqual(JSON.parse(p.pauseMessage("vimeo")).method, "pause");
assert.strictEqual(p.pauseMessage("tiktok"), "");

assert.ok(p.frameHosts().indexOf("www.youtube-nocookie.com") >= 0);
console.log("video_providers_test: " + golden.length + " golden URLs ok");
