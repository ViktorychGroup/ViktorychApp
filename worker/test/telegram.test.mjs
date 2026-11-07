import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { buildPlaylist, keptVideoKey, parseRange, safeTelegramPath } from "../src/telegram.js";

const BOT = "123456:probe-token";

function workerOptions(extra) {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    bindings: Object.assign({
      ACCOUNT_PEPPER: "pepper-test",
      OWNER_CLAIM_CODE: "claim-test",
      OWNER_HANDLE: "mirathorn",
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000"
    }, extra || {}),
    outboundService(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/getFile")) {
        const id = url.searchParams.get("file_id") || "";
        if (id === "BAD") {
          return Response.json({ ok: true, result: { file_path: "https://evil.example/secret" } });
        }
        return Response.json({ ok: true, result: { file_path: "documents/" + id } });
      }
      if (url.pathname.includes("/file/bot")) {
        return new Response(new Uint8Array([9, 8, 7, 6]), { headers: { "content-type": "image/jpeg" } });
      }
      return new Response("missing", { status: 404 });
    }
  };
}

async function call(mf, path, opts) {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.80");
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.range) headers.set("Range", opts.range);
  const res = await mf.dispatchFetch("https://accounts.test" + path, { method: opts.method || "GET", headers });
  const bytes = new Uint8Array(await res.arrayBuffer());
  let body = null;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch (err) { body = null; }
  return { status: res.status, body, bytes, headers: res.headers };
}

test("playlist, range, and telegram paths", () => {
  const text = buildPlaylist([
    { kind: "segment", part_index: 1, duration: 4.5 },
    { kind: "init", part_index: -1 },
    { kind: "segment", part_index: 0, duration: 5 }
  ], "clips/a b.mp4", "https://accounts.test");
  assert.match(text, /#EXT-X-VERSION:7/);
  assert.match(text, /#EXT-X-MAP:URI="https:\/\/accounts\.test\/tg\/clips\/a%20b\.mp4\/init"/);
  assert.match(text, /https:\/\/accounts\.test\/tg\/clips\/a%20b\.mp4\/0/);
  assert.match(text, /https:\/\/accounts\.test\/tg\/clips\/a%20b\.mp4\/1/);
  assert.equal(buildPlaylist([], "a", "https://accounts.test"), "");
  assert.deepEqual(parseRange("", 4), null);
  assert.deepEqual(parseRange("bytes=1-2", 4), { start: 1, end: 2 });
  assert.equal(parseRange("bytes=9-10", 4), false);
  assert.deepEqual(parseRange("bytes=-2", 4), { start: 2, end: 3 });
  assert.deepEqual(parseRange("bytes=2-", 4), { start: 2, end: 3 });
  assert.equal(parseRange("bytes=-", 4), false);
  assert.equal(safeTelegramPath("documents/file_0.jpg"), "documents/file_0.jpg");
  assert.equal(safeTelegramPath("../secret"), "");
  assert.equal(safeTelegramPath("https://evil.example/x"), "");
  assert.equal(safeTelegramPath("/etc/passwd"), "");
  assert.equal(keptVideoKey("social/x/abc/video/0"), true);
  assert.equal(keptVideoKey("tiktok/lockclip/7695476356548660503/video"), true);
  assert.equal(keptVideoKey("tiktok/id/123456789/7695476356548660503/video"), true);
  assert.equal(keptVideoKey("feeds.json"), false);
  assert.equal(keptVideoKey("music/abc/index.m3u8"), false);
  assert.equal(keptVideoKey("social/x/abc/photo/0"), false);
});

test("telegram media requires a session and a worker secret", async () => {
  const plain = new Miniflare(workerOptions());
  try {
    const anon = await call(plain, "/tg/photos/a.jpg", { ip: "203.0.113.81" });
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error, "unauthorized");

    const signup = await plain.dispatchFetch("https://accounts.test/v1/signup", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.82",
        "content-type": "application/json"
      },
      body: JSON.stringify({ displayName: "Ada Lovelace", handle: "ada_tg" })
    });
    const session = await signup.json();
    assert.equal(signup.status, 201);
    const missing = await call(plain, "/tg/photos/a.jpg", { ip: "203.0.113.83", token: session.token });
    assert.equal(missing.status, 503);
    assert.equal(missing.body.error, "not_configured");
    const loopMissing = await call(plain, "/tg/loop/v1/index.m3u8", { ip: "203.0.113.84" });
    assert.equal(loopMissing.status, 503);
    assert.equal(loopMissing.body.error, "not_configured");
  } finally {
    await plain.dispose();
  }
});

test("a signed-in viewer receives a ranged telegram file and a playlist", async () => {
  const mf = new Miniflare(workerOptions({ TELEGRAM_BOT_TOKEN: BOT }));
  try {
    const signup = await mf.dispatchFetch("https://accounts.test/v1/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.90", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Grace Hopper", handle: "grace_tg" })
    });
    const session = await signup.json();
    assert.equal(signup.status, 201);
    const db = await mf.getBindings();
    await db.DB.prepare(
      "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES (?, 'single', 0, 'viktorych-data', 'PHOTO', 1, 4, 'abc', 'image/jpeg', 0, 1, 1, 0, 1)"
    ).bind("photos/a.jpg").run();
    await db.DB.prepare(
      "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES (?, 'single', 0, 'viktorych-data', 'HIDDEN', 1, 4, 'abc', 'image/jpeg', 0, 0, 1, 1, 1)"
    ).bind("secret/hidden.jpg").run();
    for (const row of [
      ["clips/a.mp4", "init", -1, "INIT", 0],
      ["clips/a.mp4", "segment", 0, "SEG0", 5],
      ["clips/a.mp4", "segment", 1, "SEG1", 4.5]
    ]) {
      await db.DB.prepare(
        "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES (?, ?, ?, 'viktorych-data', ?, 2, 4, 'abc', 'video/iso.segment', ?, 1, 1, 0, 1)"
      ).bind(row[0], row[1], row[2], row[3], row[4]).run();
    }

    const anon = await call(mf, "/tg/photos/a.jpg", { ip: "203.0.113.91" });
    assert.equal(anon.status, 401);

    const full = await call(mf, "/tg/photos/a.jpg", { ip: "203.0.113.92", token: session.token });
    assert.equal(full.status, 200);
    assert.deepEqual(Array.from(full.bytes), [9, 8, 7, 6]);
    assert.match(full.headers.get("content-type") || "", /image\/jpeg/);
    assert.match(full.headers.get("cache-control") || "", /max-age=31536000/);

    const ranged = await call(mf, "/tg/photos/a.jpg", { ip: "203.0.113.93", token: session.token, range: "bytes=1-2" });
    assert.equal(ranged.status, 206);
    assert.deepEqual(Array.from(ranged.bytes), [8, 7]);
    assert.match(ranged.headers.get("content-range") || "", /bytes 1-2\/4/);

    const badRange = await call(mf, "/tg/photos/a.jpg", { ip: "203.0.113.94", token: session.token, range: "bytes=9-10" });
    assert.equal(badRange.status, 416);

    const hidden = await call(mf, "/tg/secret/hidden.jpg", { ip: "203.0.113.95", token: session.token });
    assert.equal(hidden.status, 404);

    const bad = await call(mf, "/tg/photos/bad.jpg", { ip: "203.0.113.96", token: session.token });
    assert.equal(bad.status, 404);

    const playlist = await call(mf, "/tg/clips/a.mp4/index.m3u8", { ip: "203.0.113.97", token: session.token });
    assert.equal(playlist.status, 200);
    const text = new TextDecoder().decode(playlist.bytes);
    assert.match(text, /#EXTM3U/);
    assert.match(text, /\/tg\/clips\/a\.mp4\/init/);
    assert.match(text, /\/tg\/clips\/a\.mp4\/0/);
    assert.match(text, /\/tg\/clips\/a\.mp4\/1/);
    assert.match(playlist.headers.get("content-type") || "", /mpegurl/);

    const segment = await call(mf, "/tg/clips/a.mp4/0", { ip: "203.0.113.98", token: session.token });
    assert.equal(segment.status, 200);
    assert.equal(segment.bytes.byteLength, 4);

    const unsafe = await call(mf, "/tg/%2e%2e", { ip: "203.0.113.99", token: session.token });
    assert.equal(unsafe.status, 404);
  } finally {
    await mf.dispose();
  }
});

test("the radio loop playlist is public and immutable", async () => {
  const mf = new Miniflare(workerOptions({ TELEGRAM_BOT_TOKEN: BOT }));
  try {
    await mf.dispatchFetch("https://accounts.test/v1/health", { headers: { "CF-Connecting-IP": "203.0.113.71" } });
    const db = await mf.getBindings();
    const insert = "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES (?, ?, ?, 'viktorych-data', ?, 3, 4, 'abc', 'video/iso.segment', ?, 1, 1, 0, 1)";
    for (const row of [
      ["loop/v1", "init", -1, "LOOPINIT", 0],
      ["loop/v1", "segment", 0, "LOOP0", 10.031],
      ["loop/v1", "segment", 1, "LOOP1", 10],
      ["loop/v1/aac", "segment", 0, "AACAAC0", 10]
    ]) {
      await db.DB.prepare(insert).bind(row[0], row[1], row[2], row[3], row[4]).run();
    }

    const playlist = await call(mf, "/tg/loop/v1/index.m3u8", { ip: "203.0.113.72" });
    assert.equal(playlist.status, 200);
    const text = new TextDecoder().decode(playlist.bytes);
    assert.match(text, /#EXT-X-VERSION:7/);
    assert.match(text, /\/tg\/loop\/v1\/init/);
    assert.match(text, /\/tg\/loop\/v1\/0/);
    assert.match(text, /\/tg\/loop\/v1\/1/);
    assert.match(text, /#EXTINF:10\.031,/);
    assert.match(playlist.headers.get("cache-control") || "", /immutable/);
    assert.match(playlist.headers.get("cdn-cache-control") || "", /immutable/);

    const segment = await call(mf, "/tg/loop/v1/0", { ip: "203.0.113.73" });
    assert.equal(segment.status, 200);
    assert.match(segment.headers.get("cache-control") || "", /immutable/);
    assert.match(segment.headers.get("cdn-cache-control") || "", /immutable/);

    const aac = await call(mf, "/tg/loop/v1/aac/index.m3u8", { ip: "203.0.113.74" });
    assert.equal(aac.status, 200);
    const aacText = new TextDecoder().decode(aac.bytes);
    assert.match(aacText, /#EXT-X-VERSION:3/);
    assert.match(aacText, /\/tg\/loop\/v1\/aac\/0/);
    assert.doesNotMatch(aacText, /EXT-X-MAP/);

    const photos = await call(mf, "/tg/photos/a.jpg", { ip: "203.0.113.75" });
    assert.equal(photos.status, 401);
  } finally {
    await mf.dispose();
  }
});

test("shorts stay owner-only, a hidden avatar stays hidden, and a song key is not served", async () => {
  const mf = new Miniflare(workerOptions({ TELEGRAM_BOT_TOKEN: BOT }));
  try {
    const readerSignup = await mf.dispatchFetch("https://accounts.test/v1/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.60", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Reader", handle: "reader_tg" })
    });
    const reader = await readerSignup.json();
    assert.equal(readerSignup.status, 201);
    const ownerSignup = await mf.dispatchFetch("https://accounts.test/v1/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.61", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Owner", handle: "owner_tg" })
    });
    const owner = await ownerSignup.json();
    assert.equal(ownerSignup.status, 201);
    const hiddenSignup = await mf.dispatchFetch("https://accounts.test/v1/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.62", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Hidden", handle: "hidden_tg" })
    });
    const hidden = await hiddenSignup.json();
    assert.equal(hiddenSignup.status, 201);

    const db = await mf.getBindings();
    await db.DB.prepare("UPDATE accounts SET owner = 1 WHERE handle = ?").bind("owner_tg").run();
    const hiddenRow = await db.DB.prepare("SELECT public_id FROM accounts WHERE handle = ?").bind("hidden_tg").first();
    const avatarKey = "media/avatars/" + hiddenRow.public_id + "/" + "ab".repeat(32) + ".webp";
    await db.DB.prepare("UPDATE accounts SET avatar = ?, hide_avatar = 'none' WHERE public_id = ?").bind(avatarKey, hiddenRow.public_id).run();
    const shortKey = "archive/" + "cd".repeat(32) + ".mp4";
    await db.DATA.put("feeds.json", JSON.stringify({
      posts: [
        { id: "1", platform: "x", text: "public", media: [{ url: "https://pub-example.r2.dev/photos/a.jpg" }] },
        { id: "2", platform: "youtube", url: "https://www.youtube.com/shorts/abc", media: [{ url: "https://pub-example.r2.dev/" + shortKey }] }
      ]
    }));
    const insert = "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES (?, 'single', 0, 'viktorych-data', ?, 4, 4, 'abc', 'application/octet-stream', 0, 1, 1, 0, 1)";
    await db.DB.prepare(insert).bind(shortKey, "SHORT").run();
    await db.DB.prepare(insert).bind(avatarKey, "AVATAR").run();
    await db.DB.prepare(insert).bind("music/abc/index.m3u8", "PLAYLIST").run();
    await db.DB.prepare(insert).bind("music/abc/cf1373b0cf10db5ae3fe8dd7.bin", "AESKEY").run();

    const anon = await call(mf, "/tg/" + shortKey, { ip: "203.0.113.63" });
    assert.equal(anon.status, 401);
    const refused = await call(mf, "/tg/" + shortKey, { ip: "203.0.113.64", token: reader.token });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, "forbidden");
    const allowed = await call(mf, "/tg/" + shortKey, { ip: "203.0.113.65", token: owner.token });
    assert.equal(allowed.status, 200);

    const peek = await call(mf, "/tg/" + avatarKey, { ip: "203.0.113.66", token: reader.token });
    assert.equal(peek.status, 404);
    const self = await call(mf, "/tg/" + avatarKey, { ip: "203.0.113.67", token: hidden.token });
    assert.equal(self.status, 200);

    const song = await call(mf, "/tg/music/abc/index.m3u8", { ip: "203.0.113.68", token: reader.token });
    assert.equal(song.status, 200);
    const key = await call(mf, "/tg/music/abc/cf1373b0cf10db5ae3fe8dd7.bin", { ip: "203.0.113.69", token: reader.token });
    assert.equal(key.status, 404);
  } finally {
    await mf.dispose();
  }
});

test("tiktok media on /tg stays behind the sign-up gate and the owner audience", async () => {
  const key = "tiktok/lockclip/7695476356548660503/video";
  const mf = new Miniflare(workerOptions({ TELEGRAM_BOT_TOKEN: BOT }));
  try {
    const readerSignup = await mf.dispatchFetch("https://accounts.test/v1/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.80", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Reader", handle: "reader_tt" })
    });
    const reader = await readerSignup.json();
    const ownerSignup = await mf.dispatchFetch("https://accounts.test/v1/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.81", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Owner", handle: "owner_tt" })
    });
    const owner = await ownerSignup.json();
    const db = await mf.getBindings();
    await db.DB.prepare("UPDATE accounts SET owner = 1 WHERE handle = ?").bind("owner_tt").run();
    await db.DB.prepare("INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES (?, 'single', 0, 'cdn', 'TT1', 9, 4, 'abc', 'video/mp4', 0, 1, 1, 0, 1)").bind(key).run();
    const anon = await call(mf, "/tg/" + key, { ip: "203.0.113.82" });
    assert.equal(anon.status, 401);
    const refused = await call(mf, "/tg/" + key, { ip: "203.0.113.83", token: reader.token });
    assert.equal(refused.status, 403);
    const allowed = await call(mf, "/tg/" + key, { ip: "203.0.113.84", token: owner.token });
    assert.equal(allowed.status, 200);
  } finally {
    await mf.dispose();
  }
  const open = new Miniflare(workerOptions({ TELEGRAM_BOT_TOKEN: BOT, TIKTOK_AUDIENCE: "all" }));
  try {
    const readerSignup = await open.dispatchFetch("https://accounts.test/v1/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.85", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Reader", handle: "reader_all" })
    });
    const reader = await readerSignup.json();
    const db = await open.getBindings();
    await db.DB.prepare("INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES (?, 'single', 0, 'cdn', 'TT2', 10, 4, 'abc', 'video/mp4', 0, 1, 1, 0, 1)").bind(key).run();
    const anon = await call(open, "/tg/" + key, { ip: "203.0.113.86" });
    assert.equal(anon.status, 401);
    const allowed = await call(open, "/tg/" + key, { ip: "203.0.113.87", token: reader.token });
    assert.equal(allowed.status, 200);
  } finally {
    await open.dispose();
  }
});

test("an owner playback counts once and a cached segment is free", async () => {
  const mf = new Miniflare(workerOptions({ TELEGRAM_BOT_TOKEN: BOT, TG_USER_LIMIT: "2" }));
  try {
    const ownerSignup = await mf.dispatchFetch("https://accounts.test/v1/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.40", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Owner", handle: "owner_budget" })
    });
    const owner = await ownerSignup.json();
    assert.equal(ownerSignup.status, 201);
    const readerSignup = await mf.dispatchFetch("https://accounts.test/v1/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.41", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Reader", handle: "reader_budget" })
    });
    const reader = await readerSignup.json();
    assert.equal(readerSignup.status, 201);
    const db = await mf.getBindings();
    await db.DB.prepare("UPDATE accounts SET owner = 1 WHERE handle = ?").bind("owner_budget").run();
    const insert = "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES (?, ?, ?, 'viktorych-data', ?, 8, 4, ?, 'video/iso.segment', ?, 1, 1, 0, 1)";
    const parts = [
      ["clips/budget.mp4", "init", -1, "BINIT", "sha-init", 0],
      ["clips/budget.mp4", "segment", 0, "B0", "sha-0", 2],
      ["clips/budget.mp4", "segment", 1, "B1", "sha-1", 2],
      ["clips/budget.mp4", "segment", 2, "B2", "sha-2", 2]
    ];
    for (const row of parts) {
      await db.DB.prepare(insert).bind(row[0], row[1], row[2], row[3], row[4], row[5]).run();
    }
    await db.DB.prepare(
      "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES (?, 'single', 0, 'viktorych-data', ?, 8, 4, ?, 'image/jpeg', 0, 1, 1, 0, 1)"
    ).bind("photos/one.jpg", "ONE", "sha-one").run();
    await db.DB.prepare(
      "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES (?, 'single', 0, 'viktorych-data', ?, 8, 4, ?, 'image/jpeg', 0, 1, 1, 0, 1)"
    ).bind("photos/two.jpg", "TWO", "sha-two").run();
    await db.DB.prepare(insert).bind("clips/reader.mp4", "segment", 0, "R0", "sha-reader", 2).run();

    const playlist = await call(mf, "/tg/clips/budget.mp4/index.m3u8", { ip: "203.0.113.42", token: owner.token });
    assert.equal(playlist.status, 200);
    for (const part of ["0", "1", "2"]) {
      const segment = await call(mf, "/tg/clips/budget.mp4/" + part, { ip: "203.0.113.42", token: owner.token });
      assert.equal(segment.status, 200);
    }
    const first = await call(mf, "/tg/photos/one.jpg", { ip: "203.0.113.42", token: owner.token });
    assert.equal(first.status, 200);
    const blocked = await call(mf, "/tg/photos/two.jpg", { ip: "203.0.113.42", token: owner.token });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, "rate_limited");

    const cold = await call(mf, "/tg/clips/reader.mp4/0", { ip: "203.0.113.43", token: reader.token });
    assert.equal(cold.status, 200);
    const warm = await call(mf, "/tg/clips/reader.mp4/0", { ip: "203.0.113.43", token: reader.token });
    assert.equal(warm.status, 200);
    const photo = await call(mf, "/tg/photos/one.jpg", { ip: "203.0.113.43", token: reader.token });
    assert.equal(photo.status, 200);
    const over = await call(mf, "/tg/photos/two.jpg", { ip: "203.0.113.43", token: reader.token });
    assert.equal(over.status, 429);

    const refreshed = await call(mf, "/v1/session/refresh", { method: "POST", ip: "203.0.113.44", token: owner.token });
    assert.equal(refreshed.status, 200);
    assert.equal(typeof refreshed.body.token, "string");
    assert.notEqual(refreshed.body.token, owner.token);
    const oldSession = await call(mf, "/v1/session", { ip: "203.0.113.45", token: owner.token });
    assert.equal(oldSession.status, 200);
    const newSession = await call(mf, "/v1/session", { ip: "203.0.113.46", token: refreshed.body.token });
    assert.equal(newSession.status, 200);
    const anon = await call(mf, "/v1/session/refresh", { method: "POST", ip: "203.0.113.47" });
    assert.equal(anon.status, 401);
  } finally {
    await mf.dispose();
  }
});

test("segments stay in the cache, one in-flight download is shared, and a kept original streams from R2", async () => {
  let gets = 0;
  let files = 0;
  const options = workerOptions({ TELEGRAM_BOT_TOKEN: BOT });
  options.outboundService = (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/getFile")) {
      gets += 1;
      const id = url.searchParams.get("file_id") || "";
      return Response.json({ ok: true, result: { file_path: "documents/" + id } });
    }
    if (url.pathname.includes("/file/bot")) {
      files += 1;
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(new Response(new Uint8Array([9, 8, 7, 6]), { headers: { "content-type": "video/mp4" } }));
        }, 80);
      });
    }
    return new Response("missing", { status: 404 });
  };
  const mf = new Miniflare(options);
  try {
    const signup = await mf.dispatchFetch("https://accounts.test/v1/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.50", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Cache", handle: "cache_tg" })
    });
    const session = await signup.json();
    assert.equal(signup.status, 201);
    const db = await mf.getBindings();
    await db.DB.prepare(
      "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES (?, 'segment', 0, 'viktorych-data', 'CACHE0', 11, 4, 'sha-cache', 'video/iso.segment', 2, 1, 1, 0, 1)"
    ).bind("clips/cache.mp4").run();
    const key = "social/x/abc/video/0";
    await db.DATA.put(key, new Uint8Array([1, 2, 3, 4, 5]), { httpMetadata: { contentType: "video/mp4" } });

    const pair = await Promise.all([
      call(mf, "/tg/clips/cache.mp4/0", { ip: "203.0.113.51", token: session.token }),
      call(mf, "/tg/clips/cache.mp4/0", { ip: "203.0.113.51", token: session.token })
    ]);
    assert.equal(pair[0].status, 200);
    assert.equal(pair[1].status, 200);
    assert.deepEqual(Array.from(pair[0].bytes), [9, 8, 7, 6]);
    assert.equal(gets, 1);
    assert.equal(files, 1);
    assert.match(pair[0].headers.get("cache-control") || "", /private/);
    assert.match(pair[0].headers.get("cache-control") || "", /immutable/);
    assert.match(pair[0].headers.get("cache-control") || "", /max-age=31536000/);
    assert.equal(pair[0].headers.get("cdn-cache-control"), null);

    const warm = await call(mf, "/tg/clips/cache.mp4/0", { ip: "203.0.113.51", token: session.token });
    assert.equal(warm.status, 200);
    assert.equal(gets, 1);
    assert.equal(files, 1);

    const playlist = await call(mf, "/tg/" + key + "/index.m3u8", { ip: "203.0.113.52", token: session.token });
    assert.equal(playlist.status, 404);
    const full = await call(mf, "/tg/" + key, { ip: "203.0.113.52", token: session.token });
    assert.equal(full.status, 200);
    assert.deepEqual(Array.from(full.bytes), [1, 2, 3, 4, 5]);
    assert.match(full.headers.get("content-type") || "", /video\/mp4/);
    assert.match(full.headers.get("cache-control") || "", /immutable/);
    const ranged = await call(mf, "/tg/" + key, { ip: "203.0.113.52", token: session.token, range: "bytes=1-3" });
    assert.equal(ranged.status, 206);
    assert.deepEqual(Array.from(ranged.bytes), [2, 3, 4]);
    const hidden = await call(mf, "/tg/feeds.json", { ip: "203.0.113.52", token: session.token });
    assert.equal(hidden.status, 404);
    const anon = await call(mf, "/tg/" + key, { ip: "203.0.113.53" });
    assert.equal(anon.status, 401);
  } finally {
    await mf.dispose();
  }
});

test("past lives stitch parts and stream held segments", async () => {
  const mf = new Miniflare(workerOptions({ TELEGRAM_BOT_TOKEN: BOT }));
  try {
    const ownerSignup = await mf.dispatchFetch("https://accounts.test/v1/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.60", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Owner", handle: "owner_live" })
    });
    const owner = await ownerSignup.json();
    const readerSignup = await mf.dispatchFetch("https://accounts.test/v1/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.61", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Reader", handle: "reader_live" })
    });
    const reader = await readerSignup.json();
    const db = await mf.getBindings();
    await db.DB.prepare("UPDATE accounts SET owner = 1 WHERE handle = ?").bind("owner_live").run();
    const insert = "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES (?, 'segment', ?, 'viktorych-data', ?, 9, ?, ?, 'video/iso.segment', 2, 1, 1, 0, 1)";
    const initInsert = "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES (?, 'init', -1, 'viktorych-data', ?, 8, 800, ?, 'video/mp4', 0, 1, 1, 0, 1)";
    const room = "tiktok/some_name/7100000000000000002/live";
    await db.DB.prepare(initInsert).bind(room + "/1", "INIT1", "sha-init-1").run();
    await db.DB.prepare(initInsert).bind(room + "/2", "INIT2", "sha-init-2").run();
    await db.DB.prepare(insert).bind(room + "/1", 1, "PART1", 4, "sha-part-1").run();
    await db.DB.prepare(insert).bind(room + "/2", 1, "PART2", 4, "sha-part-2").run();
    await db.DB.prepare(insert).bind(room + "/1", 3, "TOOBIG", 20 * 1024 * 1024, "sha-big").run();
    const objectKey = room + "/1";
    await db.DATA.put("live-buf/0/some_name/7100000000000000002/1/seg00003.m4s", new Uint8Array([1, 2, 3, 4, 5]));
    await db.DATA.put("live-buf/0/some_name/7100000000000000002/1/seg00003.m4s.json", JSON.stringify({
      objectKey,
      index: 3,
      role: "segment",
      size: 5,
      duration: 2,
      oversize: true,
      channelSlot: 0
    }));
    await db.DATA.put("live-buf/0/some_name/7100000000000000002/1/seg00004.m4s", new Uint8Array([1]));
    await db.DATA.put("live-buf/0/some_name/7100000000000000002/1/seg00004.m4s.json", JSON.stringify({
      objectKey,
      index: 4,
      role: "segment",
      size: 1,
      duration: 2,
      channelSlot: 0
    }));
    // An oversized piece is held in the buffer and has no Telegram row.
    // A saved room can still contain it, so a saved playlist must list it
    // and the bytes must play.
    await db.DATA.put("live-buf/1/some_name/7100000000000000002/1/seg00005.m4s", new Uint8Array([7, 7, 7, 7, 7]));
    await db.DATA.put("live-buf/1/some_name/7100000000000000002/1/seg00005.m4s.json", JSON.stringify({
      objectKey,
      index: 5,
      role: "segment",
      size: 5,
      duration: 2,
      oversize: true,
      channelSlot: 1
    }));
    const parent = await call(mf, "/tg/" + room + "/index.m3u8", { ip: "203.0.113.62", token: owner.token });
    assert.equal(parent.status, 200);
    const parentText = new TextDecoder().decode(parent.bytes);
    assert.match(parentText, /#EXT-X-DISCONTINUITY/);
    assert.match(parentText, /\/live\/1\/1/);
    assert.match(parentText, /\/live\/2\/1/);
    assert.match(parentText, /\/live\/1\/3/);
    assert.match(parentText, /\/live\/1\/4/);
    assert.match(parentText, /\/live\/1\/5/);
    const saved = await call(mf, "/tg/" + room + "/index.m3u8?saved=1", { ip: "203.0.113.62", token: owner.token });
    assert.equal(saved.status, 200);
    const savedText = new TextDecoder().decode(saved.bytes);
    assert.match(savedText, /\/live\/1\/1/);
    assert.match(savedText, /\/live\/1\/3/, "a saved playlist keeps the oversized stored segment");
    assert.match(savedText, /\/live\/1\/4/, "a saved playlist keeps a buffer-only segment");
    assert.match(savedText, /\/live\/1\/5/, "a saved playlist keeps an oversized buffer-only segment");
    const held = await call(mf, "/tg/" + room + "/1/5", { ip: "203.0.113.62", token: owner.token });
    assert.equal(held.status, 200);
    assert.deepEqual(Array.from(held.bytes), [7, 7, 7, 7, 7]);
    const denied = await call(mf, "/tg/" + room + "/index.m3u8", { ip: "203.0.113.63", token: reader.token });
    assert.equal(denied.status, 403);
    const tail = await call(mf, "/tg/" + room + "/1/3", { ip: "203.0.113.62", token: owner.token, range: "bytes=-2" });
    assert.equal(tail.status, 206);
    assert.deepEqual(Array.from(tail.bytes), [4, 5]);
    assert.match(tail.headers.get("content-type") || "", /video\/mp4/);
  } finally {
    await mf.dispose();
  }
});
