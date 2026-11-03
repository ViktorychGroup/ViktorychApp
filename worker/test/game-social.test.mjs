import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { unlocked, localParts, isNightOwl, inQuiet, parseTop, cleanRoom, checkMessage, roomsFromList, roomRegion, parseProfileStats } from "../../shared/regone.js";

/* Every player name here is synthetic. */
const TOP_HTML = readFileSync(new URL("./fixtures/regone-top100.html", import.meta.url), "utf8");
const PROFILE_HTML = readFileSync(new URL("./fixtures/regone-profile.html", import.meta.url), "utf8");
const CLAN_LIST = {
  success: 1,
  servers: [
    { _id: "9", owner_user_id: 42, name: "Synth Clan Arena - EU", arena: "Crane", game_mode: "Sabotage", max_players: 12, ip: "192.0.2.9" },
    { _id: "10", owner_user_id: 43, name: "visit spam.com now", arena: "Crane", game_mode: "Sabotage", max_players: 12, ip: "192.0.2.10" }
  ]
};
const ROOM_LIST = {
  success: 1,
  servers: [
    { _id: "1", owner_user_id: 1, name: "NZlay Large 01 - EU", arena: "Pipeline", game_mode: "Eliminate", max_players: 16, ip: "192.0.2.1" },
    { _id: "2", owner_user_id: 1, name: "NZlay Mini 01 - USA", arena: "Tower", game_mode: "Sabotage", max_players: 8, ip: "192.0.2.2" },
    { _id: "3", owner_user_id: 7, name: "Synthetic clan room", arena: "Crane", game_mode: "Eliminate", max_players: 8, ip: "192.0.2.3" }
  ]
};
let outbound = { top: 0, rooms: 0, clans: 0, online: 0, profile: 0, profilePath: "", mode: "ok" };
let mf;

function workerOptions(mode) {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    bindings: {
      ACCOUNT_PEPPER: "pepper-test",
      OWNER_CLAIM_CODE: "claim-test",
      OWNER_HANDLE: "owner_synth",
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000"
    },
    async outboundService(request) {
      const url = new URL(request.url);
      if (url.hostname === "nzlay.com" && url.pathname === "/pages/top100") {
        outbound.top++;
        assert.match(request.headers.get("user-agent") || "", /ViktorychApp/);
        if (mode === "broken") return new Response("<html><body>maintenance</body></html>", { headers: { "content-type": "text/html" } });
        return new Response(TOP_HTML, { headers: { "content-type": "text/html" } });
      }
      if (url.hostname === "wsp.nzlay.com" && url.pathname === "/getserverlist/") {
        outbound.rooms++;
        if (mode === "broken") return new Response("nope", { status: 503 });
        return Response.json(ROOM_LIST);
      }
      if (url.hostname === "wsp.nzlay.com" && url.pathname === "/getclanserverlist/") {
        outbound.clans++;
        if (mode === "broken") return new Response("nope", { status: 503 });
        return Response.json(CLAN_LIST);
      }
      if (url.hostname === "nzlay.com" && url.pathname === "/ReGone/players-online.php") {
        outbound.online++;
        if (mode === "broken") return new Response("<html>", { status: 502 });
        return Response.json({ online: 137 });
      }
      if (url.hostname === "nzlay.com" && url.pathname.startsWith("/profile/")) {
        outbound.profile++;
        outbound.profilePath = url.pathname;
        if (mode === "broken") return new Response("<html>gone</html>", { headers: { "content-type": "text/html" } });
        return new Response(PROFILE_HTML, { headers: { "content-type": "text/html" } });
      }
      // The game's sockets, sd_* endpoints and anything else are never called.
      assert.fail("unexpected outbound request " + url.hostname + url.pathname);
      return new Response("not in test", { status: 404 });
    }
  };
}

async function call(path, opts, inst) {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.10");
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.body) headers.set("content-type", "application/json");
  const res = await (inst || mf).dispatchFetch("https://accounts.test" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch (err) { body = { raw: text }; }
  return { status: res.status, body, text };
}

let ipN = 20;
async function signup(handle, inst) {
  const ip = "198.51.100." + (ipN++);
  const created = await call("/v1/signup", { method: "POST", ip, body: { displayName: "Test " + handle, handle } }, inst);
  assert.equal(created.status, 201, created.text);
  const me = created.body;
  const as = (path, opts) => call(path, Object.assign({ ip, token: me.token }, opts || {}), inst);
  return { id: me.account.publicId, token: me.token, ip, as };
}
async function befriend(a, b) {
  await a.as("/v1/friends/request", { method: "POST", body: { targetId: "app:" + b.id } });
  const ok = await b.as("/v1/friends/accept", { method: "POST", body: { targetId: "app:" + a.id } });
  assert.equal(ok.body.status, "friends", ok.text);
}
async function follow(a, b) {
  const res = await a.as("/v1/follows", { method: "PUT", body: { id: "app:" + b.id } });
  assert.ok(res.status < 300, res.text);
}
async function sql(query, ...args) {
  const db = await mf.getD1Database("DB");
  return db.prepare(query).bind(...args).run();
}

test.before(async () => { mf = new Miniflare(workerOptions("ok")); });
test.after(async () => { if (mf) await mf.dispose(); });

test("rooms, messages and achievements are pure and safe", () => {
  assert.equal(cleanRoom("  NZlay Large 01 - EU \u0000"), "NZlay Large 01 - EU");
  assert.equal(cleanRoom("join www.example.com"), "", "links are not room names");
  assert.equal(cleanRoom("x".repeat(80)).length, 48);
  assert.deepEqual(checkMessage("see https://example.com"), { ok: false, error: "links" });
  assert.deepEqual(checkMessage("y".repeat(141)), { ok: false, error: "long" });
  assert.equal(checkMessage("come on you shit").text, "come on you s***");
  assert.equal(checkMessage("Shiitake soup first").text, "Shiitake soup first", "only whole words are masked");
  const rooms = roomsFromList(ROOM_LIST);
  assert.deepEqual(rooms.map((r) => r.name), ["NZlay Large 01 - EU", "NZlay Mini 01 - USA"], "only official rooms");
  assert.equal(JSON.stringify(rooms).indexOf("192.0.2"), -1, "no server addresses leave the Worker");
  // Simulated sessions.
  assert.deepEqual(unlocked({}), []);
  assert.deepEqual(unlocked({ totalMs: 60000 }), ["first_play"]);
  const big = unlocked({ totalMs: 51 * 3600000, streak: 30, invited: true, joined: true, friends: 3, night: true, weekend: true });
  ["first_play", "hours_1", "hours_10", "hours_50", "streak_3", "streak_7", "streak_30", "invite_sent", "invite_joined", "friends_3", "night_owl", "weekend_warrior"].forEach((id) => assert.ok(big.includes(id), id));
  assert.ok(!big.includes("top_100"));
  const ranked = unlocked({ rank: 9, kills: 1200, climbed: 12 });
  ["top_100", "top_50", "top_10", "kills_100", "kills_500", "kills_1000", "climber"].forEach((id) => assert.ok(ranked.includes(id), id));
  assert.ok(!ranked.includes("top_1") && !ranked.includes("kills_2500"));
  const at = Date.UTC(2026, 9, 31, 23, 30); // Saturday 23:30 UTC
  assert.equal(localParts(at, 120).weekday, 0, "two hours east is already Sunday");
  assert.equal(isNightOwl(at, 120), true);
  assert.equal(isNightOwl(at, 0), false);
  assert.equal(inQuiet(at, 0, 22, 7), true);
  assert.equal(inQuiet(Date.UTC(2026, 9, 31, 12), 0, 22, 7), false);
  const players = parseTop(TOP_HTML);
  assert.equal(players.length, 12);
  assert.deepEqual(players[2], { rank: 3, name: "Synth Charlie", kills: 2540, kdr: 2.5918, deaths: 980, total: 102870 });
  assert.deepEqual(parseTop("<table><tr><td>changed</td></tr></table>"), []);
});

test("live invite: send with room and note, Join, expiry, decline, blocks and mutes", async () => {
  const ana = await signup("inv_ana");
  const bo = await signup("inv_bo");
  const cy = await signup("inv_cy");
  const dee = await signup("inv_dee");
  await befriend(ana, bo);
  await befriend(cy, bo);
  await befriend(dee, bo);

  const linky = await ana.as("/v1/games/invite", { method: "POST", body: { gameId: "regone", to: bo.id, message: "go to www.example.com" } });
  assert.equal(linky.status, 400);
  assert.equal(linky.body.error, "message_links");

  const sent = await ana.as("/v1/games/invite", { method: "POST", body: { gameId: "regone", to: bo.id, room: "NZlay Large 01 - EU", message: "gg, bring snacks" } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.body.sent, true);
  assert.ok(sent.body.expiresAt - Date.now() > 9 * 60 * 1000 && sent.body.expiresAt - Date.now() <= 10 * 60 * 1000);
  assert.ok(sent.body.achievements.includes("invite_sent"));

  const inbox = await bo.as("/v1/games/invites");
  assert.equal(inbox.body.incoming.length, 1);
  const inv = inbox.body.incoming[0];
  assert.equal(inv.room, "NZlay Large 01 - EU");
  assert.equal(inv.message, "gg, bring snacks");
  assert.equal(inv.from.publicId, ana.id);
  const bell = await bo.as("/v1/notifications");
  const note = (bell.body.items || []).find((item) => item.kind === "game_invite");
  assert.ok(note && note.hash === "#/games/regone?invite=" + sent.body.id);
  assert.match(note.text, /NZlay Large 01 - EU/);

  const joined = await bo.as("/v1/games/invite/answer", { method: "POST", body: { id: sent.body.id, answer: "join" } });
  assert.equal(joined.status, 200, joined.text);
  assert.equal(joined.body.status, "joined");
  assert.equal(joined.body.room, "NZlay Large 01 - EU");
  const again = await bo.as("/v1/games/invite/answer", { method: "POST", body: { id: sent.body.id, answer: "decline" } });
  assert.equal(again.status, 409);
  const mine = await ana.as("/v1/games/invites");
  assert.equal(mine.body.sent[0].status, "joined");
  const ach = await ana.as("/v1/games/achievements");
  assert.ok(ach.body.achievements.some((a) => a.id === "invite_joined"));
  // Notifications > Games: the inviter hears that a friend joined and
  // gets a note for each new achievement.
  const anaBell = await ana.as("/v1/notifications");
  const joinNote = (anaBell.body.items || []).find((item) => item.kind === "game_join");
  assert.ok(joinNote && joinNote.hash === "#/games/regone");
  assert.match(joinNote.text, /NZlay Large 01 - EU/);
  assert.ok((anaBell.body.items || []).some((item) => item.kind === "game_achievement" && item.text === "invite_joined"));

  // The room bo joined is visible to friends, grouped by room on the page.
  const rooms = await ana.as("/v1/games/friends-rooms");
  assert.deepEqual(rooms.body.friends.map((f) => [f.publicId, f.room]), [[bo.id, "NZlay Large 01 - EU"]]);
  const badge = await ana.as("/v1/games/presence?id=" + bo.id);
  assert.equal(badge.body.room, "NZlay Large 01 - EU");
  assert.equal(badge.body.canInvite, true);

  // Expiry.
  const late = await ana.as("/v1/games/invite", { method: "POST", body: { gameId: "regone", to: bo.id } });
  assert.equal(late.body.sent, true);
  await sql("UPDATE game_invites SET expires_at = ? WHERE id = ?", Date.now() - 1000, late.body.id);
  assert.equal((await bo.as("/v1/games/invites")).body.incoming.length, 0, "expired invites drop off");
  const tooLate = await bo.as("/v1/games/invite/answer", { method: "POST", body: { id: late.body.id, answer: "join" } });
  assert.equal(tooLate.status, 410);

  // Decline.
  const third = await ana.as("/v1/games/invite", { method: "POST", body: { gameId: "regone", to: bo.id } });
  const no = await bo.as("/v1/games/invite/answer", { method: "POST", body: { id: third.body.id, answer: "decline" } });
  assert.equal(no.body.status, "declined");
  assert.equal((await ana.as("/v1/games/invites")).body.sent[0].status, "declined");

  // Someone else cannot answer for bo.
  const fourth = await ana.as("/v1/games/invite", { method: "POST", body: { gameId: "regone", to: bo.id } });
  const thief = await cy.as("/v1/games/invite/answer", { method: "POST", body: { id: fourth.body.id, answer: "join" } });
  assert.equal(thief.status, 404);

  // Blocked and muted people cannot invite.
  await bo.as("/v1/blocks", { method: "PUT", body: { id: cy.id } });
  const blocked = await cy.as("/v1/games/invite", { method: "POST", body: { gameId: "regone", to: bo.id } });
  assert.equal(blocked.status, 403);
  await bo.as("/v1/mutes", { method: "PUT", body: { id: dee.id } });
  const muted = await dee.as("/v1/games/invite", { method: "POST", body: { gameId: "regone", to: bo.id } });
  assert.equal(muted.status, 403);
  assert.equal(muted.body.error, "unavailable");
  assert.ok(!(await bo.as("/v1/games/invites")).body.incoming.some((i) => i.from.publicId === dee.id));
});

test("achievements unlock from simulated sessions", async () => {
  const zed = await signup("ach_zed");
  // The first play sits at local noon so it cannot already earn night_owl
  // (with tz 0 it would between 00:00 and 03:59 UTC).
  let noon = (12 - new Date().getUTCHours()) * 60;
  if (noon < -720) noon += 1440;
  if (noon > 840) noon -= 1440;
  const first = await zed.as("/v1/games/play", { method: "POST", body: { gameId: "regone", ms: 60000, tz: noon } });
  assert.equal(first.status, 200, first.text);
  assert.ok(first.body.achievements.includes("first_play"));
  await sql("UPDATE game_stats SET total_ms = ?, best_streak = 7 WHERE public_id = ?", 11 * 3600000, zed.id);
  // A tz that puts the page at 01:xx local time.
  const hour = new Date().getUTCHours();
  let tz = (1 - hour) * 60;
  if (tz < -720) tz += 1440;
  if (tz > 840) tz -= 1440;
  await new Promise((r) => setTimeout(r, 1100));
  const next = await zed.as("/v1/games/play", { method: "POST", body: { gameId: "regone", ms: 1000, tz } });
  ["hours_1", "hours_10", "streak_3", "streak_7", "night_owl"].forEach((id) => assert.ok(next.body.achievements.includes(id), id + " " + next.text));
  assert.ok(!next.body.achievements.includes("hours_50"));
  const list = await zed.as("/v1/games/achievements");
  assert.equal(list.body.achievements.filter((a) => !a.seen).length >= 6, true);
  await zed.as("/v1/games/achievements/seen", { method: "POST", body: { ids: ["first_play"] } });
  assert.equal((await zed.as("/v1/games/achievements")).body.achievements.find((a) => a.id === "first_play").seen, true);
});

test("party lobby: invite, ready, only the host launches, private records nothing", async () => {
  const host = await signup("lob_host");
  const guest = await signup("lob_guest");
  const other = await signup("lob_other");
  await befriend(host, guest);
  const made = await host.as("/v1/games/lobby", { method: "POST", body: { room: "NZlay Mini 01 - USA" } });
  assert.equal(made.status, 200, made.text);
  const lobby = made.body.lobby;
  assert.equal(lobby.room, "NZlay Mini 01 - USA");
  assert.equal(lobby.members.length, 1);
  assert.equal((await other.as("/v1/games/lobby?id=" + lobby.id)).status, 404, "strangers cannot peek");
  const sent = await host.as("/v1/games/invite", { method: "POST", body: { gameId: "regone", to: guest.id, lobbyId: lobby.id, room: lobby.room } });
  assert.equal(sent.body.sent, true, sent.text);
  const peek = await guest.as("/v1/games/lobby?id=" + lobby.id);
  assert.equal(peek.body.lobby.member, false);
  const joined = await guest.as("/v1/games/lobby/join", { method: "POST", body: { id: lobby.id } });
  assert.equal(joined.body.lobby.members.length, 2);
  const ready = await guest.as("/v1/games/lobby/ready", { method: "POST", body: { id: lobby.id, ready: true } });
  assert.ok(ready.body.lobby.members.every((m) => m.ready));
  const notHost = await guest.as("/v1/games/lobby/launch", { method: "POST", body: { id: lobby.id } });
  assert.equal(notHost.status, 403);
  const go = await host.as("/v1/games/lobby/launch", { method: "POST", body: { id: lobby.id } });
  assert.equal(go.status, 200, go.text);
  assert.equal(go.body.members, 2);
  assert.equal(go.body.room, "NZlay Mini 01 - USA");
  const together = await host.as("/v1/games/together");
  assert.deepEqual(together.body.people.map((p) => p.publicId), [guest.id]);

  // Play privately: a private lobby leaves no shared record.
  const host2 = await signup("lob_host2");
  const guest2 = await signup("lob_guest2");
  await befriend(host2, guest2);
  const quiet = await host2.as("/v1/games/lobby", { method: "POST", body: { private: true } });
  await host2.as("/v1/games/invite", { method: "POST", body: { gameId: "regone", to: guest2.id, lobbyId: quiet.body.lobby.id, private: true } });
  await guest2.as("/v1/games/lobby/join", { method: "POST", body: { id: quiet.body.lobby.id } });
  await host2.as("/v1/games/lobby/launch", { method: "POST", body: { id: quiet.body.lobby.id } });
  assert.deepEqual((await host2.as("/v1/games/together")).body.people, []);
  // Lobbies expire.
  await sql("UPDATE game_lobbies SET expires_at = ? WHERE id = ?", Date.now() - 1, lobby.id);
  assert.equal((await host.as("/v1/games/lobby?id=" + lobby.id)).status, 404);
});

test("play-together audiences: each level, both must allow, blocks, mutes and clear", async () => {
  const a = await signup("tog_a");
  const b = await signup("tog_b");
  const fan = await signup("tog_fan");
  const pal = await signup("tog_pal");
  const stranger = await signup("tog_str");
  await befriend(a, b);
  await befriend(a, pal);
  await befriend(b, pal);
  await follow(fan, a);
  await follow(fan, b);
  const lob = await a.as("/v1/games/lobby", { method: "POST", body: {} });
  await a.as("/v1/games/invite", { method: "POST", body: { gameId: "regone", to: b.id, lobbyId: lob.body.lobby.id } });
  await b.as("/v1/games/lobby/join", { method: "POST", body: { id: lob.body.lobby.id } });
  await a.as("/v1/games/lobby/launch", { method: "POST", body: { id: lob.body.lobby.id } });
  const seen = async (viewer) => {
    const got = await viewer.as("/v1/games/together?id=" + a.id);
    return got.body.people.map((p) => p.publicId).includes(b.id);
  };
  const set = (who, together, lists) => who.as("/v1/games/prefs", { method: "POST", body: { audiences: { together }, lists: lists ? { together: lists } : undefined } });

  // Default: only me.
  const defaults = await a.as("/v1/games/prefs");
  assert.equal(defaults.body.audiences.together, "only");
  assert.equal(await seen(a), true, "you always see your own");
  assert.equal(await seen(fan), false);
  assert.equal(await seen(pal), false);

  // Both must allow: a goes public, b still only me.
  await set(a, "public");
  assert.equal(await seen(stranger), false, "b has not allowed anyone");
  await set(b, "public");
  assert.equal(await seen(stranger), true);

  // Followers.
  await set(a, "followers");
  assert.equal(await seen(stranger), false);
  assert.equal(await seen(fan), true);
  // Mutuals (friends).
  await set(a, "friends");
  assert.equal(await seen(fan), false);
  assert.equal(await seen(pal), true);
  // b narrows to friends too: pal is a friend of both.
  await set(b, "friends");
  assert.equal(await seen(pal), true);
  assert.equal(await seen(fan), false);

  // Custom: a list with fan, then an exclude list beats it.
  await set(b, "public");
  const list = await a.as("/v1/audience-lists", { method: "POST", body: { name: "Game crew" } });
  assert.equal(list.status, 201, list.text);
  await a.as("/v1/audience-lists/" + list.body.id + "/members", { method: "POST", body: { handle: "tog_fan" } });
  await set(a, "list", { include: [list.body.id], exclude: [] });
  assert.equal(await seen(fan), true);
  assert.equal(await seen(pal), false, "not on the list");
  await set(a, "public", { include: [], exclude: [list.body.id] });
  assert.equal(await seen(fan), false, "excluded");
  assert.equal(await seen(stranger), true);
  await set(a, "public", { include: [], exclude: [] });

  // Never to muted or blocked people, from either player.
  await b.as("/v1/mutes", { method: "PUT", body: { id: stranger.id } });
  assert.equal(await seen(stranger), false, "b muted the viewer");
  await b.as("/v1/mutes", { method: "DELETE", body: { id: stranger.id } });
  assert.equal(await seen(stranger), true);
  await a.as("/v1/blocks", { method: "PUT", body: { id: fan.id } });
  assert.equal(await seen(fan), false);

  // Room audience: only me hides the room and Playing now.
  await b.as("/v1/games/room", { method: "POST", body: { room: "NZlay Large 01 - EU" } });
  assert.equal((await a.as("/v1/games/presence?id=" + b.id)).body.room, "NZlay Large 01 - EU");
  await b.as("/v1/games/prefs", { method: "POST", body: { audiences: { room: "only" } } });
  const hidden = await a.as("/v1/games/presence?id=" + b.id);
  assert.equal(hidden.body.room, "");
  assert.equal(hidden.body.playing, false);
  assert.deepEqual((await a.as("/v1/games/friends-rooms")).body.friends, []);
  // Rooms age out without a heartbeat.
  await b.as("/v1/games/prefs", { method: "POST", body: { audiences: { room: "friends" } } });
  await b.as("/v1/games/room", { method: "POST", body: { room: "NZlay Mini 01 - USA" } });
  assert.equal((await a.as("/v1/games/friends-rooms")).body.friends.length, 1);
  await sql("UPDATE game_rooms SET updated_at = ? WHERE public_id = ?", Date.now() - 31 * 60 * 1000, b.id);
  assert.equal((await a.as("/v1/games/friends-rooms")).body.friends.length, 0);

  // Stats audience gates achievements.
  await b.as("/v1/games/prefs", { method: "POST", body: { audiences: { stats: "only" } } });
  assert.equal((await a.as("/v1/games/achievements?id=" + b.id)).body.hidden, true);

  // Clear history.
  const cleared = await a.as("/v1/games/together", { method: "DELETE" });
  assert.equal(cleared.status, 200);
  assert.deepEqual((await a.as("/v1/games/together")).body.people, []);
});

test("Top 100: parsed, cached, linked name, rank achievements, climb and friends", async () => {
  const me = await signup("top_me");
  const pal = await signup("top_pal");
  await befriend(me, pal);
  outbound.top = 0;
  const top = await me.as("/v1/games/regone/top");
  assert.equal(top.status, 200, top.text);
  assert.equal(top.body.ok, true);
  assert.equal(top.body.players.length, 12);
  assert.equal(top.body.players[0].name, "Synth Alpha");
  await me.as("/v1/games/regone/top");
  assert.equal(outbound.top, 1, "one request per refresh");

  const linked = await me.as("/v1/games/link-name", { method: "POST", body: { name: "synth charlie" } });
  assert.equal(linked.status, 200, linked.text);
  ["top_100", "top_50", "top_10", "kills_100", "kills_500", "kills_1000", "kills_2500"].forEach((id) => assert.ok(linked.body.achievements.includes(id), id));
  assert.ok(!linked.body.achievements.includes("top_1"));
  const card = await me.as("/v1/games/achievements");
  assert.equal(card.body.rank.rank, 3);
  assert.equal(card.body.claimed, true);

  await sql("UPDATE game_board_snap SET rank = 20 WHERE public_id = ?", me.id);
  const climbed = await me.as("/v1/games/achievements");
  assert.ok(climbed.body.achievements.some((a) => a.id === "climber"));
  const once = await me.as("/v1/games/achievements");
  assert.equal(once.body.achievements.filter((a) => a.id === "climber").length, 1, "awarded once");

  await pal.as("/v1/games/link-name", { method: "POST", body: { name: "Synth Alpha" } });
  const view = await me.as("/v1/games/regone/top");
  assert.deepEqual(view.body.friends.map((f) => [f.publicId, f.rank]), [[pal.id, 1]]);
  assert.equal(view.body.mine.rank, 3);
  await pal.as("/v1/games/prefs", { method: "POST", body: { audiences: { stats: "only" } } });
  assert.deepEqual((await me.as("/v1/games/regone/top")).body.friends, [], "stats audience hides the claimed rank");
  assert.equal((await me.as("/v1/games/achievements?id=" + pal.id)).body.hidden, true);

  const rooms = await me.as("/v1/games/rooms");
  assert.equal(rooms.body.source, "live");
  assert.deepEqual(rooms.body.rooms.map((r) => r.name), ["NZlay Large 01 - EU", "NZlay Mini 01 - USA"]);
});

test("players online, room filters data and self-linked profile stats", async () => {
  // Pure parts first.
  assert.equal(roomRegion("NZlay Mini 01 - EU"), "EU");
  assert.equal(roomRegion("NZlay Large 02 - USA"), "USA");
  assert.equal(roomRegion("Plain room"), "");
  const stats = parseProfileStats(PROFILE_HTML);
  assert.equal(stats.kills, 237);
  assert.equal(stats.favouriteWeapon, "rifle");
  assert.equal(stats.weaponBest, 180);
  assert.equal(stats.headshots, 70);
  assert.equal(stats.hits, 260);
  assert.equal(stats.multiKills, 12);
  assert.equal(stats.matchesWon, 14);
  assert.equal(parseProfileStats("<html>no stats</html>"), null);
  assert.equal(parseProfileStats("var profileStatsA = {broken"), null);

  const me = await signup("stat_me");
  const pal = await signup("stat_pal");
  const other = await signup("stat_other");
  await befriend(me, pal);
  outbound.online = 0;
  const online = await me.as("/v1/games/regone/online");
  assert.equal(online.status, 200, online.text);
  assert.deepEqual([online.body.ok, online.body.online], [true, 137]);
  await me.as("/v1/games/regone/online");
  assert.equal(outbound.online, 1, "cached for a minute");

  const rooms = await me.as("/v1/games/regone/rooms");
  assert.equal(rooms.body.source, "live");
  assert.deepEqual(rooms.body.rooms.map((r) => [r.name, r.arena, r.mode, r.region, r.max]), [["NZlay Large 01 - EU", "Pipeline", "Eliminate", "EU", 16], ["NZlay Mini 01 - USA", "Tower", "Sabotage", "USA", 8]]);
  assert.deepEqual(rooms.body.clans.map((r) => [r.name, r.region, r.clan]), [["Synth Clan Arena - EU", "EU", true]], "clan rooms with links are dropped");
  assert.equal(rooms.text.indexOf("192.0.2"), -1, "no server addresses");
  assert.equal(rooms.text.indexOf("owner_user_id"), -1);

  // Nothing linked: no fetch.
  outbound.profile = 0;
  const none = await me.as("/v1/games/regone/profile-stats");
  assert.deepEqual([none.body.ok, none.body.linked], [false, false]);
  assert.equal(outbound.profile, 0);

  await me.as("/v1/games/link-name", { method: "POST", body: { name: "Synth Charlie" } });
  const mine = await me.as("/v1/games/regone/profile-stats");
  assert.equal(mine.status, 200, mine.text);
  assert.equal(mine.body.ok, true);
  assert.equal(mine.body.claimed, true);
  assert.equal(outbound.profilePath, "/profile/Synth%20Charlie");
  ["weapon_100", "headshot_25", "multi_10", "wins_10"].forEach((id) => assert.ok(mine.body.achievements.includes(id), id));
  assert.ok(!mine.body.achievements.includes("wins_100"));
  await me.as("/v1/games/regone/profile-stats");
  assert.equal(outbound.profile, 1, "one fetch an hour per name");
  const again = await me.as("/v1/games/regone/profile-stats");
  assert.deepEqual(again.body.achievements, [], "awarded once");

  // A friend reads the cached stats under the stats audience; never a fresh fetch for someone else.
  const seen = await pal.as("/v1/games/regone/profile-stats?id=" + me.id);
  assert.equal(seen.body.ok, true);
  assert.deepEqual(seen.body.achievements, []);
  await me.as("/v1/games/prefs", { method: "POST", body: { audiences: { stats: "friends" } } });
  assert.equal((await other.as("/v1/games/regone/profile-stats?id=" + me.id)).body.hidden, true);
  await pal.as("/v1/blocks", { method: "PUT", body: { id: me.id } });
  assert.notEqual((await pal.as("/v1/games/regone/profile-stats?id=" + me.id)).body.ok, true, "blocked pairs see nothing");
  assert.equal(outbound.profile, 1);
});

test("a broken Top 100 hides the tab and rooms fall back to the curated list", async () => {
  const broken = new Miniflare(workerOptions("broken"));
  try {
    const ip = "198.51.100.200";
    const made = await call("/v1/signup", { method: "POST", ip, body: { displayName: "Broken", handle: "top_broken" } }, broken);
    const token = made.body.token;
    const top = await call("/v1/games/regone/top", { ip, token }, broken);
    assert.equal(top.status, 200);
    assert.equal(top.body.ok, false);
    assert.deepEqual(top.body.players, []);
    const rooms = await call("/v1/games/rooms", { ip, token }, broken);
    assert.equal(rooms.body.source, "curated", "curated rooms when the list is down");
    assert.ok(rooms.body.rooms.length >= 4);
    const online = await call("/v1/games/regone/online", { ip, token }, broken);
    assert.equal(online.body.ok, false, "the chip hides");
    await call("/v1/games/link-name", { method: "POST", ip, token, body: { name: "Synth Gone" } }, broken);
    const stats = await call("/v1/games/regone/profile-stats", { ip, token }, broken);
    assert.deepEqual([stats.body.ok, stats.body.linked], [false, true], "a changed profile page shows nothing");
    const features = await call("/v1/features", { ip }, broken);
    assert.ok(features.body.features.includes("regone_leaderboard"));
    ["regone_leaderboard", "regone_online", "regone_rooms", "regone_profile_stats"].forEach((name) => {
      assert.ok(features.body.features.includes(name), name);
      assert.ok(!features.body.off.includes(name), name + " on by default");
    });
  } finally {
    await broken.dispose();
  }
});

test("the regone_leaderboard flag answers the Top 100 route empty", async () => {
  const flagged = new Miniflare(workerOptions("ok"));
  try {
    const db = await flagged.getD1Database("DB");
    await db.prepare("CREATE TABLE IF NOT EXISTS feature_flags (name TEXT PRIMARY KEY, off INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)").run();
    for (const name of ["regone_leaderboard", "regone_online", "regone_rooms", "regone_profile_stats"]) {
      await db.prepare("INSERT INTO feature_flags (name, off, updated_at) VALUES (?, 1, 0)").bind(name).run();
    }
    const features = await call("/v1/features", { ip: "198.51.100.210" }, flagged);
    ["regone_leaderboard", "regone_online", "regone_rooms", "regone_profile_stats"].forEach((name) => assert.ok(features.body.off.includes(name), name));
    const top = await call("/v1/games/regone/top", { ip: "198.51.100.210" }, flagged);
    assert.equal(top.status, 204, "the page hides the tab");
    for (const path of ["/v1/games/regone/online", "/v1/games/regone/rooms", "/v1/games/rooms", "/v1/games/regone/profile-stats"]) {
      assert.equal((await call(path, { ip: "198.51.100.210" }, flagged)).status, 204, path);
    }
  } finally {
    await flagged.dispose();
  }
});
