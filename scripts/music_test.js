/* ViktorychMusic library rules. No document, no playback. */
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const context = { console, URL };
context.globalThis = context;
vm.createContext(context);
["i18n.js", "i18n/en.js", "i18n/ru.js", "i18n/es.js", "marks.js", "music.js"].forEach(function (file) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context);
});
const L = context.MusicLogic;
assert.ok(L, "music.js exports MusicLogic without a document");
assert.strictEqual(typeof context.SIntelMusic.install, "function");

const src = fs.readFileSync("music.js", "utf8");
const css = fs.readFileSync("music.css", "utf8");
const data = fs.readFileSync("data/music.json", "utf8");
const logo = fs.readFileSync("logo/viktorychmusic.svg", "utf8");
const mark = fs.readFileSync("logo/v.svg", "utf8");
assert.ok(src.includes("ViktorychMarks"), "the wordmark comes from the shared marks");
assert.ok(src.includes('productName("music")'), "the music name comes from the language packs");
assert.ok(src.includes('productName("pwa")'), "the back link uses the short app name");
assert.ok(src.includes('productName("musicShort")'), "tight music labels use the short name");
assert.ok(src.includes("has-img") && css.includes(".has-img .mu-letter"), "a loaded cover hides the letter");
const phoneCss = fs.readFileSync("styles.css", "utf8");
assert.ok(phoneCss.includes(".m-logo .logo-full { display: none; }"));
assert.ok(phoneCss.includes(".m-logo .logo-short { display: block;"));
assert.ok(!phoneCss.includes(".m-logo .logo-short { display: none; }"));
assert.ok(!src.includes("ViktorychMusic") && !src.includes("ViktrychMusic"));
assert.ok(!src.includes("SuperintelMusic"));
assert.ok(!src.includes("SIntelMusic") || src.includes("root.SIntelMusic"));
assert.ok(!css.includes("SuperintelMusic"));
assert.ok(logo.includes('aria-label="ViktorychMusic"'));
assert.ok(mark.includes("currentColor") || mark.includes("d="));
const catalog = JSON.parse(data);
assert.ok(!data.includes("SuperintelMusic"));
const release = catalog.songs.find((song) => song.id === "america-dont-sit-still");
assert.ok(release, "the release is in the catalog");
assert.strictEqual(release.title, "America Don't Sit Still");
assert.strictEqual(release.artist, "ViktorychMusic");
assert.strictEqual(release.kind, "hls");
assert.strictEqual(release.lossless, true);
assert.strictEqual(release.duration, 222.11);
assert.strictEqual(release.released, "2026-10-22");
assert.ok(release.stream.endsWith("/index.m3u8"));
assert.ok(release.cover.endsWith("/cover.png?v=sq1"));
assert.ok(!release.stream.includes("?v="));
assert.ok(!src.includes(release.stream));
assert.ok(!src.includes("50c1862ca9927cdd5731d34f80d42669"));
assert.ok(!src.includes("download="));
assert.ok(src.includes('controlsList", "nodownload"') || src.includes('controlsList", "nodownload"'));
assert.ok(src.includes("nodownload"));
assert.ok(src.includes("hls-1.7.3.min.js"));
assert.ok(src.includes("sintel-music-offline"));
assert.ok(logo.includes('aria-label="ViktorychMusic"'));

assert.strictEqual(L.classifySource("http://example.com/a.mp3").ok, false);
assert.strictEqual(L.classifySource("javascript:alert(1)").ok, false);
assert.strictEqual(L.classifySource("https://user:pass@example.com/a.mp3").ok, false);
assert.strictEqual(L.classifySource("https://localhost/a.mp3").ok, false);
assert.strictEqual(L.classifySource("https://www.youtube.com/watch?v=dQw4w9WgXcQ").kind, "youtube");
assert.strictEqual(L.youtubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
const archive = L.classifySource("https://archive.org/download/example/tone.mp3");
assert.strictEqual(archive.kind, "audio");
assert.strictEqual(archive.publish, true);
assert.strictEqual(L.classifySource("https://archive.org/details/example").kind, "archive");
assert.strictEqual(L.classifySource("idb:song1:audio").publish, false);

const remote = {
  songs: [
    { id: "a", title: "A", artist: "One", source: "https://example.com/a.mp3", kind: "audio" },
    { id: "b", title: "B", artist: "Two", source: "https://example.com/b.mp3", kind: "audio" }
  ],
  playlists: [{ id: "p", name: "Remote", songIds: ["a"] }]
};
const merged = L.mergeLibrary(remote, { hidden: ["b"], edits: { a: { title: "Edited" } }, songs: [{ id: "c", title: "Local", artist: "", source: "idb:c:audio", kind: "audio" }], order: ["c", "a"] });
assert.strictEqual(merged.songs.map((song) => song.id).join(","), "c,a");
assert.strictEqual(merged.songs[1].title, "Edited");
assert.strictEqual(merged.playlists[0].name, "Remote");
const localLists = L.mergeLibrary(remote, { playlistTouched: true, playlists: [{ id: "mine", name: "Mine", songIds: [] }], songs: [] });
assert.strictEqual(localLists.playlists[0].id, "mine");
assert.strictEqual(localLists.playlists[1].id, "p");
assert.strictEqual(L.reorder(["a", "b", "c"], "a", "c").join(","), "b,c,a");
assert.strictEqual(L.formatTime(65), "1:05");
assert.strictEqual(L.formatTime(222.11), "3:42");
assert.strictEqual(L.formatReleased("2026-10-22"), "Oct 22, 2026");
assert.strictEqual(L.streamReady({ stream: "" }), false);
assert.strictEqual(L.streamReady({ stream: "https://localhost/a.m3u8" }), false);
assert.strictEqual(L.streamReady({ stream: "http://cdn.example/a.m3u8" }), false);
assert.strictEqual(L.streamReady({ stream: "https://cdn.example/music/index.m3u8" }), true);
const sample = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  "#EXT-X-MAP:URI=\"init.mp4\"",
  "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1",
  "#EXTINF:6.0,",
  "a.m4s",
  "#EXTINF:6.0,",
  "b.m4s",
  "#EXT-X-ENDLIST"
].join("\n");
const assets = L.hlsAssets(sample, "https://cdn.example/music/x/index.m3u8");
assert.strictEqual(assets.playlists.length, 0);
assert.strictEqual(assets.files.slice().sort().join("\n"), [
  "https://cdn.example/music/x/a.m4s",
  "https://cdn.example/music/x/b.m4s",
  "https://cdn.example/music/x/init.mp4",
  "https://cdn.example/music/x/key.bin"
].join("\n"));
const r2 = "https://pub-example.r2.dev/music/abc/index.m3u8";
const tg = "https://accounts.example.workers.dev/tg/music/abc/index.m3u8";
const rewritten = L.rewriteMusicPlaylist(sample.replace('URI="key.bin"', 'URI="cf1373b0cf10db5ae3fe8dd7.bin"').replace('URI="init.mp4"', 'URI="29647c55f231793f9991.mp4"').replace("a.m4s", "c099e79892e9b2f248f9.m4s"), r2, tg);
assert.ok(rewritten.includes("https://pub-example.r2.dev/music/abc/cf1373b0cf10db5ae3fe8dd7.bin"));
assert.ok(rewritten.includes("https://accounts.example.workers.dev/tg/music/abc/29647c55f231793f9991.mp4"));
assert.ok(rewritten.includes("https://accounts.example.workers.dev/tg/music/abc/c099e79892e9b2f248f9.m4s"));
assert.ok(!rewritten.includes("/tg/music/abc/cf1373b0cf10db5ae3fe8dd7.bin"));
assert.strictEqual(L.musicObjectKey(r2), "music/abc/index.m3u8");
const foreign = L.hlsAssets('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example/key.bin"\nseg.m4s\n', "https://cdn.example/music/x/index.m3u8");
assert.strictEqual(foreign.files.join("\n"), "https://cdn.example/music/x/seg.m4s");
const master = L.hlsAssets("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\naudio.m3u8\n", "https://cdn.example/music/x/index.m3u8");
assert.strictEqual(master.playlists.join("\n"), "https://cdn.example/music/x/audio.m3u8");
const card = L.releaseHtml({
  id: "america-dont-sit-still",
  title: "America Don't Sit Still",
  artist: "ViktorychMusic",
  cover: "https://cdn.example/cover.png",
  stream: "https://cdn.example/music/secret/index.m3u8",
  kind: "hls",
  duration: 222.11,
  released: "2026-10-22",
  genre: "Rock",
  style: "American rock anthem",
  lossless: true
});
assert.ok(card.includes("New release"));
assert.ok(card.includes("Lossless"));
assert.ok(card.includes("America Don"));
assert.ok(card.includes("3:42"));
assert.ok(card.includes("Download"));
assert.ok(!card.includes("index.m3u8"));
assert.ok(!card.includes("secret"));
assert.ok(!card.includes("download="));
const hlsSong = { id: "h", title: "H", artist: "A", source: "", stream: "https://cdn.example/music/index.m3u8", kind: "hls", duration: 222.11, lossless: true };
assert.strictEqual(L.publishable([hlsSong]).length, 1);
assert.strictEqual(L.publishable([hlsSong])[0].stream, hlsSong.stream);
assert.strictEqual(L.sameSection({ name: "music", section: "home", id: "" }, "#/music"), true);
assert.strictEqual(L.sameSection({ name: "music", section: "home", id: "" }, "#/music/search"), false);
assert.strictEqual(L.sameSection({ name: "music", section: "home", id: "" }, "#/"), false);
assert.strictEqual(L.publishable(merged.songs).length, 1);

const worker = fs.readFileSync("sw.js", "utf8");
assert.ok(worker.includes('VERSION = "viktorych-a276-__SW_VERSION__"'));
assert.ok(worker.includes("./marks.js") && !worker.includes("./brand.js"));
assert.ok(worker.includes("./icons/music-192.png"));
assert.ok(worker.includes("sintel-music-offline"));
assert.ok(worker.includes("function isCatalogMedia(url)"));
const fetchAt = worker.indexOf('self.addEventListener("fetch"');
const catalogAt = worker.indexOf("if (isCatalogMedia(url)) return;");
const spaceAt = worker.indexOf("if (isSpaceStatus(url) || isSpaceAsset(url))");
assert.ok(fetchAt >= 0 && catalogAt > fetchAt && catalogAt < spaceAt);
assert.ok(worker.includes("key !== OFFLINE_MUSIC"));
assert.ok(!card.includes(release.stream));

console.log("music tests ok");
