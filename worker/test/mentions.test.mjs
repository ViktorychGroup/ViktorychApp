import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { extractMentions } from "../../shared/mentions.js";
import { matchDiscordMessage, quietEndsAt } from "../../shared/discord-alerts.js";
import { emitNotification } from "../src/notifications.js";

let mf;
let alpha;
let bravo;
let charlie;
let pushStatus = 201;

function workerOptions() {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    durableObjects: {
      ACCOUNT_CHANNEL: { className: "AccountChannel", useSQLite: true }
    },
    bindings: {
      ACCOUNT_PEPPER: "pepper-test",
      OWNER_CLAIM_CODE: "claim-test",
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000",
      PUSH_SINK: "d1"
    },
    async outboundService(request) {
      const url = new URL(request.url);
      if (url.hostname === "push.example") return new Response("ok", { status: pushStatus });
      return new Response("no", { status: 404 });
    }
  };
}

async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.80");
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.body) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch (err) { body = { raw: true }; }
  return { status: res.status, body };
}

async function one(sql, ...args) {
  const bindings = await mf.getBindings();
  let query = bindings.DB.prepare(sql);
  if (args.length) query = query.bind(...args);
  return query.first();
}

async function run(sql, ...args) {
  const bindings = await mf.getBindings();
  let query = bindings.DB.prepare(sql);
  if (args.length) query = query.bind(...args);
  return query.run();
}

async function signup(ip, handle, name) {
  const created = await call("/v1/signup", {
    method: "POST",
    ip,
    body: { displayName: name, handle }
  });
  if (created.status !== 201 || !created.body || !created.body.token || !created.body.account) throw new Error("signup failed");
  return created.body;
}

function b64url(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function pushKeys() {
  const key = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
  return { p256dh: b64url(raw), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) };
}

function skeletons(text) {
  return extractMentions(text).map((row) => row.skeleton);
}

test("mention parser skips code, urls, and duplicate skeletons", () => {
  assert.deepEqual(skeletons("hello @alphaone"), ["alphaone"]);
  assert.deepEqual(skeletons("@AlphaOne @alphaone"), ["alphaone"]);
  assert.deepEqual(skeletons("@alphaone @\u0430lphaone"), ["alphaone"]);
  assert.deepEqual(skeletons("mail alphaone@bravotwo.com and @charliethree"), ["charliethree"]);
  assert.deepEqual(skeletons("see `@alphaone` and @bravotwo"), ["bravotwo"]);
  assert.deepEqual(skeletons("```\n@alphaone\n```\nhello @bravotwo"), ["bravotwo"]);
  assert.deepEqual(skeletons("```\n@alphaone stays fenced"), []);
  assert.deepEqual(skeletons("https://example.com/@alphaone/path and @bravotwo"), ["bravotwo"]);
  assert.deepEqual(skeletons("www.example.com/@alphaone @charliethree"), ["charliethree"]);
  assert.deepEqual(skeletons("@alphaone @alphaone"), ["alphaone"]);
});

test("discord matcher covers mentions, keywords, scope, and quiet hours", () => {
  const base = {
    mentionUser: true,
    mentionRoles: true,
    mentionEveryone: true,
    mentionHere: true,
    discordUserId: "200000000000000002",
    roleIds: ["300000000000000003"],
    keywords: [{ phrase: "zephyrword", whole: true, regex: false }],
    exclude: ["drill"],
    scope: "all",
    channels: [],
    fromUsers: [],
    mutedChannels: [],
    mutedServers: [],
    quietStart: 0,
    quietEnd: 0
  };
  const message = (content, extra) => Object.assign({
    id: "400000000000000004",
    content,
    authorId: "500000000000000005",
    channelId: "600000000000000006",
    serverId: "700000000000000007"
  }, extra || {});
  assert.equal(matchDiscordMessage(message("hey <@200000000000000002>"), base).reason, "user");
  assert.equal(matchDiscordMessage(message("hey <@!200000000000000002>"), base).reason, "user");
  assert.equal(matchDiscordMessage(message("role <@&300000000000000003>"), base).reason, "role");
  assert.equal(matchDiscordMessage(message("hello @everyone"), base).reason, "everyone");
  assert.equal(matchDiscordMessage(message("hello @here"), Object.assign({}, base, { mentionEveryone: false })).reason, "here");
  assert.equal(matchDiscordMessage(message("hello @everyone"), Object.assign({}, base, { mentionEveryone: false, mentionHere: false, mentionUser: false, mentionRoles: false })).hit, false);
  assert.equal(matchDiscordMessage(message("a ZEPHYRWORD here"), Object.assign({}, base, { mentionUser: false, mentionRoles: false, mentionEveryone: false, mentionHere: false })).reason, "keyword");
  assert.equal(matchDiscordMessage(message("zephyrwording"), Object.assign({}, base, { mentionUser: false, mentionRoles: false, mentionEveryone: false, mentionHere: false })).hit, false);
  assert.equal(matchDiscordMessage(message("zephyrword drill"), Object.assign({}, base, { mentionUser: false, mentionRoles: false, mentionEveryone: false, mentionHere: false })).hit, false);
  assert.equal(matchDiscordMessage(message("id 42"), Object.assign({}, base, {
    mentionUser: false, mentionRoles: false, mentionEveryone: false, mentionHere: false,
    keywords: [{ phrase: "id \\d+", whole: false, regex: true }]
  })).reason, "keyword");
  assert.equal(matchDiscordMessage(message("id 42"), Object.assign({}, base, {
    mentionUser: false, mentionRoles: false, mentionEveryone: false, mentionHere: false,
    keywords: [{ phrase: "(", whole: false, regex: true }]
  })).hit, false);
  assert.equal(matchDiscordMessage(message("zephyrword", { channelId: "600000000000000006" }), Object.assign({}, base, {
    mentionUser: false, mentionRoles: false, mentionEveryone: false, mentionHere: false,
    mutedChannels: ["600000000000000006"]
  })).hit, false);
  assert.equal(matchDiscordMessage(message("zephyrword", { serverId: "700000000000000007" }), Object.assign({}, base, {
    mentionUser: false, mentionRoles: false, mentionEveryone: false, mentionHere: false,
    mutedServers: ["700000000000000007"]
  })).hit, false);
  assert.equal(matchDiscordMessage(message("zephyrword", { channelId: "111" }), Object.assign({}, base, {
    mentionUser: false, mentionRoles: false, mentionEveryone: false, mentionHere: false,
    scope: "selected",
    channels: ["600000000000000006"]
  })).hit, false);
  assert.equal(matchDiscordMessage(message("zephyrword", { authorId: "9" }), Object.assign({}, base, {
    mentionUser: false, mentionRoles: false, mentionEveryone: false, mentionHere: false,
    fromUsers: ["500000000000000005"]
  })).hit, false);
  const now = Date.UTC(2026, 0, 2, 3, 15);
  const quiet = quietEndsAt(now, { quietStart: 3 * 60, quietEnd: 4 * 60, quietOffset: 0 });
  assert.ok(quiet > now);
  assert.equal(quietEndsAt(now, { quietStart: 0, quietEnd: 0, quietOffset: 0 }), 0);
});

test.before(async () => {
  mf = new Miniflare(workerOptions());
  alpha = await signup("203.0.113.81", "alphaone", "Alpha One");
  bravo = await signup("203.0.113.82", "bravotwo", "Bravo Two");
  charlie = await signup("203.0.113.83", "charliethree", "Charlie Three");
});

test.after(async () => {
  if (mf) await mf.dispose();
});

test("mentions notify, catch up, and respect privacy", async () => {
  const keys = await pushKeys();
  const sub = await call("/v1/push/subscribe", {
    method: "PUT",
    ip: "203.0.113.84",
    token: bravo.token,
    body: { endpoint: "https://push.example/bravo-phone", keys, expirationTime: 0 }
  });
  assert.equal(sub.status, 200);

  const posted = await call("/v1/content", {
    method: "POST",
    ip: "203.0.113.85",
    token: alpha.token,
    body: { id: "ct_aaaaaaaaaaaaaaaa", kind: "post", text: "hello @BravoTwo" }
  });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.created, true);
  assert.equal(posted.body.mentions, 1);
  const again = await call("/v1/content", {
    method: "POST",
    ip: "203.0.113.86",
    token: alpha.token,
    body: { id: "ct_aaaaaaaaaaaaaaaa", kind: "post", text: "hello @BravoTwo" }
  });
  assert.equal(again.body.created, false);
  const mentionRows = await one("SELECT COUNT(*) AS n FROM mentions WHERE target_id = ? AND source_id = ?", bravo.account.publicId, "ct_aaaaaaaaaaaaaaaa");
  assert.equal(Number(mentionRows.n), 1);

  const notes = await call("/v1/notifications", { ip: "203.0.113.87", token: bravo.token });
  assert.equal(notes.status, 200);
  const mention = (notes.body.items || []).find((item) => item.kind === "mention");
  assert.ok(mention);
  assert.equal(mention.mention, true);
  const pushed = await one("SELECT COUNT(*) AS n FROM push_log WHERE public_id = ? AND note_id = ?", bravo.account.publicId, mention.id);
  assert.equal(Number(pushed.n), 1);
  const cursor = Number(notes.body.cursor) || 0;
  assert.ok(cursor > 0);

  const caught = await call("/v1/notifications?since=" + encodeURIComponent(String(cursor)), { ip: "203.0.113.88", token: bravo.token });
  assert.equal(caught.status, 200);
  assert.equal((caught.body.items || []).some((item) => item.id === mention.id), false);

  const later = await call("/v1/content", {
    method: "POST",
    ip: "203.0.113.89",
    token: alpha.token,
    body: { id: "ct_bbbbbbbbbbbbbbbb", kind: "post", text: "again @bravotwo" }
  });
  assert.equal(later.status, 200);
  const fresh = await call("/v1/notifications?since=" + encodeURIComponent(String(cursor)), { ip: "203.0.113.90", token: bravo.token });
  assert.equal((fresh.body.items || []).some((item) => item.kind === "mention" && item.id !== mention.id), true);

  const bio = await call("/v1/profile", {
    method: "PATCH",
    ip: "203.0.113.91",
    token: alpha.token,
    body: { bio: "not a mention @bravotwo" }
  });
  assert.equal(bio.status, 200);
  const bioMentions = await one("SELECT COUNT(*) AS n FROM mentions WHERE author_id = ? AND source_id LIKE 'bio%'", alpha.account.publicId);
  assert.equal(Number(bioMentions.n), 0);
  const contentCount = await one("SELECT COUNT(*) AS n FROM account_content WHERE author_id = ?", alpha.account.publicId);
  assert.equal(Number(contentCount.n), 2);

  const dmOnly = await call("/v1/content", {
    method: "POST",
    ip: "203.0.113.92",
    token: alpha.token,
    body: { id: "ct_cccccccccccccccc", kind: "dm", parentId: bravo.account.publicId, text: "hello there" }
  });
  assert.equal(dmOnly.status, 200);
  const dmRows = await one("SELECT COUNT(*) AS n FROM notifications WHERE public_id = ? AND kind = 'dm' AND idempotency_key = ?", bravo.account.publicId, "dm:ct_cccccccccccccccc");
  assert.equal(Number(dmRows.n), 1);
  const dmMention = await call("/v1/content", {
    method: "POST",
    ip: "203.0.113.93",
    token: alpha.token,
    body: { id: "ct_dddddddddddddddd", kind: "dm", parentId: bravo.account.publicId, text: "hey @bravotwo" }
  });
  assert.equal(dmMention.status, 200);
  const extraDm = await one("SELECT COUNT(*) AS n FROM notifications WHERE public_id = ? AND kind = 'dm' AND idempotency_key = ?", bravo.account.publicId, "dm:ct_dddddddddddddddd");
  assert.equal(Number(extraDm.n), 0);
  const dmAsMention = await one("SELECT COUNT(*) AS n FROM mentions WHERE source_id = ? AND target_id = ?", "ct_dddddddddddddddd", bravo.account.publicId);
  assert.equal(Number(dmAsMention.n), 1);

  const edited = await call("/v1/content/ct_bbbbbbbbbbbbbbbb", {
    method: "PATCH",
    ip: "203.0.113.94",
    token: alpha.token,
    body: { text: "again @bravotwo and @charliethree" }
  });
  assert.equal(edited.status, 200);
  const charlieMention = await one("SELECT COUNT(*) AS n FROM mentions WHERE source_id = ? AND target_id = ?", "ct_bbbbbbbbbbbbbbbb", charlie.account.publicId);
  assert.equal(Number(charlieMention.n), 1);
  const stillBravo = await one("SELECT COUNT(*) AS n FROM mentions WHERE source_id = ? AND target_id = ?", "ct_bbbbbbbbbbbbbbbb", bravo.account.publicId);
  assert.equal(Number(stillBravo.n), 1);

  const blocked = await call("/v1/blocks", {
    method: "PUT",
    ip: "203.0.113.95",
    token: charlie.token,
    body: { id: alpha.account.publicId }
  });
  assert.equal(blocked.status, 200);
  const blockedPost = await call("/v1/content", {
    method: "POST",
    ip: "203.0.113.96",
    token: alpha.token,
    body: { id: "ct_eeeeeeeeeeeeeeee", kind: "post", text: "nope @charliethree" }
  });
  assert.equal(blockedPost.status, 200);
  const blockedRows = await one("SELECT COUNT(*) AS n FROM mentions WHERE source_id = ?", "ct_eeeeeeeeeeeeeeee");
  assert.equal(Number(blockedRows.n), 0);
  await call("/v1/blocks", {
    method: "DELETE",
    ip: "203.0.113.97",
    token: charlie.token,
    body: { id: alpha.account.publicId }
  });

  const muted = await call("/v1/mutes", {
    method: "PUT",
    ip: "203.0.113.98",
    token: bravo.token,
    body: { id: alpha.account.publicId }
  });
  assert.equal(muted.status, 200);
  const mutedPost = await call("/v1/content", {
    method: "POST",
    ip: "203.0.113.99",
    token: alpha.token,
    body: { id: "ct_ffffffffffffffff", kind: "post", text: "quiet @bravotwo" }
  });
  assert.equal(mutedPost.status, 200);
  const mutedRows = await one("SELECT COUNT(*) AS n FROM mentions WHERE source_id = ?", "ct_ffffffffffffffff");
  assert.equal(Number(mutedRows.n), 0);
  await call("/v1/mutes", {
    method: "DELETE",
    ip: "203.0.113.100",
    token: bravo.token,
    body: { id: alpha.account.publicId }
  });

  const locked = await call("/v1/profile", {
    method: "PATCH",
    ip: "203.0.113.101",
    token: charlie.token,
    body: { protected: true }
  });
  assert.equal(locked.status, 200);
  const privateMiss = await call("/v1/content", {
    method: "POST",
    ip: "203.0.113.102",
    token: alpha.token,
    body: { id: "ct_1111111111111111", kind: "post", text: "private @charliethree" }
  });
  assert.equal(privateMiss.status, 200);
  const privateRows = await one("SELECT COUNT(*) AS n FROM mentions WHERE source_id = ?", "ct_1111111111111111");
  assert.equal(Number(privateRows.n), 0);
  const follow = await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.103",
    token: charlie.token,
    body: { id: "app:" + alpha.account.publicId }
  });
  assert.equal(follow.status, 200);
  const privateHit = await call("/v1/content", {
    method: "POST",
    ip: "203.0.113.104",
    token: alpha.token,
    body: { id: "ct_2222222222222222", kind: "post", text: "allowed @charliethree" }
  });
  assert.equal(privateHit.status, 200);
  const allowed = await one("SELECT COUNT(*) AS n FROM mentions WHERE source_id = ? AND target_id = ?", "ct_2222222222222222", charlie.account.publicId);
  assert.equal(Number(allowed.n), 1);

  const off = await call("/v1/notifications", {
    method: "POST",
    ip: "203.0.113.105",
    token: bravo.token,
    body: { prefs: { mentions: "off" } }
  });
  assert.equal(off.status, 200);
  const hiddenPost = await call("/v1/content", {
    method: "POST",
    ip: "203.0.113.106",
    token: alpha.token,
    body: { id: "ct_3333333333333333", kind: "post", text: "stored @bravotwo" }
  });
  assert.equal(hiddenPost.status, 200);
  const stored = await one("SELECT note_id FROM notifications WHERE public_id = ? AND idempotency_key = ?", bravo.account.publicId, "mention:ct_3333333333333333:" + bravo.account.publicId);
  assert.ok(stored && stored.note_id);
  const hiddenView = await call("/v1/notifications", { ip: "203.0.113.107", token: bravo.token });
  assert.equal((hiddenView.body.items || []).some((item) => item.id === stored.note_id), false);
  const silent = await one("SELECT COUNT(*) AS n FROM push_log WHERE public_id = ? AND note_id = ?", bravo.account.publicId, stored.note_id);
  assert.equal(Number(silent.n), 0);
  await call("/v1/notifications", {
    method: "POST",
    ip: "203.0.113.108",
    token: bravo.token,
    body: { prefs: { mentions: "push" } }
  });
  const shown = await call("/v1/notifications", { ip: "203.0.113.109", token: bravo.token });
  assert.equal((shown.body.items || []).some((item) => item.id === stored.note_id), true);
  const stillSilent = await one("SELECT COUNT(*) AS n FROM push_log WHERE public_id = ? AND note_id = ?", bravo.account.publicId, stored.note_id);
  assert.equal(Number(stillSilent.n), 0);

  await call("/v1/notifications", {
    method: "POST",
    ip: "203.0.113.126",
    token: bravo.token,
    body: { prefs: { mentionsFrom: "following" } }
  });
  const filtered = await call("/v1/content", {
    method: "POST",
    ip: "203.0.113.111",
    token: alpha.token,
    body: { id: "ct_4444444444444444", kind: "post", text: "filter @bravotwo" }
  });
  assert.equal(filtered.status, 200);
  const filteredId = "mention:ct_4444444444444444:" + bravo.account.publicId;
  const filteredRow = await one("SELECT note_id FROM notifications WHERE public_id = ? AND note_id = ?", bravo.account.publicId, filteredId);
  assert.ok(filteredRow);
  const filteredView = await call("/v1/notifications", { ip: "203.0.113.112", token: bravo.token });
  assert.equal((filteredView.body.items || []).some((item) => item.id === filteredId), false);
  const filteredPush = await one("SELECT COUNT(*) AS n FROM push_log WHERE public_id = ? AND note_id = ?", bravo.account.publicId, filteredId);
  assert.equal(Number(filteredPush.n), 0);
  await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.113",
    token: bravo.token,
    body: { id: "app:" + alpha.account.publicId }
  });
  const followedView = await call("/v1/notifications", { ip: "203.0.113.114", token: bravo.token });
  assert.equal((followedView.body.items || []).some((item) => item.id === filteredId), true);
  const stillNoRetro = await one("SELECT COUNT(*) AS n FROM push_log WHERE public_id = ? AND note_id = ?", bravo.account.publicId, filteredId);
  assert.equal(Number(stillNoRetro.n), 0);

  const marked = await call("/v1/notifications", {
    method: "POST",
    ip: "203.0.113.115",
    token: bravo.token,
    body: { tab: "mentions", ids: [mention.id] }
  });
  assert.equal(marked.status, 200);
  const readRow = await one("SELECT read_at FROM notifications WHERE public_id = ? AND note_id = ?", bravo.account.publicId, mention.id);
  assert.ok(Number(readRow.read_at) > 0);

  const quote = await call("/v1/reposts", {
    method: "PUT",
    ip: "203.0.113.116",
    token: alpha.token,
    body: {
      kind: "quote",
      postKey: "q:app:samplepost:1",
      comment: "see @charliethree",
      post: { platform: "app", id: "samplepost", statusId: "samplepost", handle: "bravotwo", text: "original" }
    }
  });
  assert.equal(quote.status, 200);
  const quoteNote = await one("SELECT COUNT(*) AS n FROM notifications WHERE public_id = ? AND kind = 'quote'", bravo.account.publicId);
  assert.equal(Number(quoteNote.n), 1);
  const quoteMention = await one("SELECT COUNT(*) AS n FROM mentions WHERE target_id = ? AND source_kind = 'quote'", charlie.account.publicId);
  assert.equal(Number(quoteMention.n), 1);

  const env = await mf.getBindings();
  await emitNotification(env, {
    publicId: bravo.account.publicId,
    kind: "like",
    at: Date.now(),
    actorId: alpha.account.publicId,
    groupKey: "like:subjectone",
    idempotencyKey: "like:" + alpha.account.publicId + ":subjectone",
    handle: "alphaone",
    name: "Alpha One",
    text: "",
    hash: "#/",
    platform: "app"
  });
  await emitNotification(env, {
    publicId: bravo.account.publicId,
    kind: "like",
    at: Date.now(),
    actorId: charlie.account.publicId,
    groupKey: "like:subjectone",
    idempotencyKey: "like:" + charlie.account.publicId + ":subjectone",
    handle: "charliethree",
    name: "Charlie Three",
    text: "",
    hash: "#/",
    platform: "app"
  });
  await emitNotification(env, {
    publicId: bravo.account.publicId,
    kind: "like",
    at: Date.now(),
    actorId: charlie.account.publicId,
    groupKey: "like:subjectone",
    idempotencyKey: "like:" + charlie.account.publicId + ":subjectone",
    handle: "charliethree",
    name: "Charlie Three",
    text: "",
    hash: "#/",
    platform: "app"
  });
  const grouped = await call("/v1/notifications", { ip: "203.0.113.117", token: bravo.token });
  const like = (grouped.body.items || []).find((item) => item.id === "like:subjectone");
  assert.ok(like);
  assert.equal(like.others, 1);
  const likeRows = await one("SELECT COUNT(*) AS n FROM notifications WHERE public_id = ? AND note_id = ?", bravo.account.publicId, "like:subjectone");
  assert.equal(Number(likeRows.n), 1);
});

test("discord alerts preview, dedupe, mutes, and quiet hours stay on already loaded messages", async () => {
  const mins = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const rule = {
    mentionUser: true,
    mentionRoles: true,
    mentionEveryone: false,
    mentionHere: false,
    discordUserId: "200000000000000002",
    roleIds: ["300000000000000003"],
    keywords: [{ phrase: "zephyrword", whole: true, regex: false }],
    exclude: [],
    scope: "all",
    channels: [],
    fromUsers: [],
    quietStart: mins,
    quietEnd: (mins + 45) % 1440,
    quietOffset: 0
  };
  const saved = await call("/v1/discord/alerts", {
    method: "PUT",
    ip: "203.0.113.118",
    token: alpha.token,
    body: { rule }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.rule.discordUserId, "200000000000000002");
  const sample = {
    id: "800000000000000008",
    content: "ping <@200000000000000002> zephyrword",
    authorId: "500000000000000005",
    channelId: "600000000000000006",
    serverId: "700000000000000007",
    authorName: "Sample"
  };
  const preview = await call("/v1/discord/alerts/preview", {
    method: "POST",
    ip: "203.0.113.119",
    token: alpha.token,
    body: { messages: [sample], mutedChannels: [], mutedServers: [] }
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.matches.length, 1);
  assert.equal(preview.body.matches[0].reason, "user");
  assert.equal(Object.prototype.hasOwnProperty.call(preview.body.matches[0], "content"), false);
  const previewHits = await one("SELECT COUNT(*) AS n FROM discord_alert_hits WHERE public_id = ?", alpha.account.publicId);
  assert.equal(Number(previewHits.n), 0);

  const muted = await call("/v1/discord/alerts/ingest", {
    method: "POST",
    ip: "203.0.113.120",
    token: alpha.token,
    body: { messages: [sample], mutedChannels: ["600000000000000006"], mutedServers: [] }
  });
  assert.equal(muted.status, 200);
  assert.equal(muted.body.created, 0);

  const first = await call("/v1/discord/alerts/ingest", {
    method: "POST",
    ip: "203.0.113.121",
    token: alpha.token,
    body: { messages: [sample], mutedChannels: [], mutedServers: [] }
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.created, 1);
  const second = await call("/v1/discord/alerts/ingest", {
    method: "POST",
    ip: "203.0.113.122",
    token: alpha.token,
    body: { messages: [sample], mutedChannels: [], mutedServers: [] }
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.created, 0);
  const hits = await one("SELECT COUNT(*) AS n FROM discord_alert_hits WHERE public_id = ? AND message_id = ?", alpha.account.publicId, sample.id);
  assert.equal(Number(hits.n), 1);
  const note = await one("SELECT kind, payload FROM notifications WHERE public_id = ? AND idempotency_key = ?", alpha.account.publicId, "discord:" + sample.id);
  assert.equal(note.kind, "discord");
  const payload = JSON.parse(note.payload);
  assert.equal(payload.mention, true);
  const box = await one("SELECT next_at FROM notification_outbox WHERE public_id = ? AND note_id = ?", alpha.account.publicId, "discord:" + sample.id);
  assert.ok(box && Number(box.next_at) > Date.now());

  // A private channel still alerts, but the note never carries the text or author.
  const hushed = Object.assign({}, sample, { id: "800000000000000009", channelId: "600000000000000016" });
  const quiet = await call("/v1/discord/alerts/ingest", {
    method: "POST",
    ip: "203.0.113.140",
    token: alpha.token,
    body: { messages: [hushed], mutedChannels: [], mutedServers: [], privateChannels: ["600000000000000016"] }
  });
  assert.equal(quiet.status, 200);
  assert.equal(quiet.body.created, 1);
  const hushedNote = await one("SELECT payload FROM notifications WHERE public_id = ? AND idempotency_key = ?", alpha.account.publicId, "discord:" + hushed.id);
  assert.ok(hushedNote);
  assert.equal(hushedNote.payload.includes("zephyrword"), false);
  assert.equal(hushedNote.payload.includes("Sample"), false);

  const view = await call("/v1/notifications", { ip: "203.0.113.123", token: alpha.token });
  const alert = (view.body.items || []).find((item) => item.kind === "discord");
  assert.ok(alert);
  assert.equal(alert.mention, true);

  const keys = await pushKeys();
  const sub = await call("/v1/push/subscribe", {
    method: "PUT",
    ip: "203.0.113.125",
    token: alpha.token,
    body: { endpoint: "https://push.example/alpha-phone", keys, expirationTime: 0 }
  });
  assert.equal(sub.status, 200);
  pushStatus = 500;
  await run("UPDATE notification_outbox SET attempts = 5, next_at = 1 WHERE public_id = ? AND note_id = ?", alpha.account.publicId, "discord:" + sample.id);
  const drained = await call("/v1/notifications", { ip: "203.0.113.124", token: alpha.token });
  assert.equal(drained.status, 200);
  const dead = await one("SELECT public_hash, kind, reason FROM notification_dead WHERE kind = 'discord' ORDER BY created_at DESC LIMIT 1");
  assert.ok(dead);
  assert.equal(dead.reason, "push_failed");
  assert.equal(String(dead.public_hash).length, 16);
  assert.notEqual(dead.public_hash, alpha.account.publicId);
  assert.notEqual(dead.public_hash, alpha.account.handle);
  pushStatus = 201;
});
