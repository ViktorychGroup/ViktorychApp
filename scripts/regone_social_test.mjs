import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/* ReGone social in a real browser with a stubbed Worker and game site:
   invites (sheet, room picker, typed room, message rules, pop-out, Join
   hint), achievements, lobby, the mini player keeping the same game frame,
   Privacy > Games, Top Players and the players-online chip. Every name and
   id here is made up. SHOTS=<dir> saves screenshots. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.env.SHOTS || "";

function fail(message) {
  console.error("FAIL: " + message);
  process.exitCode = 1;
  throw new Error(message);
}
function mime(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}
function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("missing"); return; }
      res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  return mod.chromium || (mod.default && mod.default.chromium);
}

const STUB = "<!doctype html><html><body style=\"margin:0;background:#1b1f23;color:#aaa;font:14px sans-serif;display:grid;place-items:center;height:100vh\"><div>game stub</div><script>window.__boot = (window.__boot || 0) + 1;</script></body></html>";
const ME = "100000000001";
const FRIEND = "100000000002";
const FRIEND2 = "100000000003";
const person = (id, name, extra) => Object.assign({ publicId: id, handle: "user_" + id.slice(-1), name, avatar: "" }, extra || {});
const BOARD = { gameId: "regone", people: [
  person(ME, "Test Owner", { me: true, totalMs: 7200000, weekMs: 3600000, streak: 4, bestStreak: 6, playing: false }),
  person(FRIEND, "Sample Friend", { me: false, totalMs: 9000000, weekMs: 1200000, streak: 1, bestStreak: 2, playing: true }),
  person(FRIEND2, "Demo Pal", { me: false, totalMs: 600000, weekMs: 0, streak: 0, bestStreak: 1, playing: false })
] };
const ROOMS = { ok: true, source: "live", rooms: [
  { name: "NZlay Mini 01 - EU", arena: "Warehouse", mode: "Eliminate", max: 8, region: "EU" },
  { name: "NZlay Medium 03 - USA", arena: "Courtyard", mode: "Sabotage", max: 12, region: "USA" },
  { name: "NZlay Large 01 - EU", arena: "Timbertown", mode: "Eliminate", max: 16, region: "EU" }
], clans: [{ name: "Synth Clan Arena - EU", arena: "Pipeline", mode: "Eliminate", max: 12, region: "EU", clan: true }] };
const TOP = { ok: true, source: "https://nzlay.com/pages/top100", fetchedAt: Date.now(), players: Array.from({ length: 12 }, (_, i) => ({ rank: i + 1, name: "Synthetic Player " + (i + 1), kills: 5000 - i * 300, kdr: (3 - i * 0.1).toFixed(2), deaths: 1500 + i * 20, total: 6500 })),
  friends: [person(FRIEND, "Sample Friend", { rank: 3 })], mine: { name: "Synthetic Player 7", rank: 7 } };
const ACH = { gameId: "regone", achievements: [
  { id: "first_play", earnedAt: Date.now() - 86400000, seen: true },
  { id: "hours_1", earnedAt: Date.now() - 3600000, seen: true },
  { id: "streak_3", earnedAt: Date.now() - 3600000, seen: true },
  { id: "invite_sent", earnedAt: Date.now() - 600000, seen: true }
], totalMs: 7200000, bestStreak: 6, linkedName: "Synthetic Player 7", claimed: true, rank: { rank: 7, kills: 3200, kdr: "2.40", deaths: 1620, total: 6500 } };
const PSTATS = { ok: true, linked: true, claimed: true, name: "Synthetic Player 7", stats: { kills: 237, weapons: { rifle: 120, pistol: 70, shotgun: 47 }, weaponBest: 120, favouriteWeapon: "rifle", hits: 260, headshots: 70, headshotRate: 26.9, multiKills: 12, matchesWon: 14, roundsWon: 40 }, fetchedAt: Date.now(), source: "https://nzlay.com/profile/", achievements: [] };
const PREFS = { audiences: { together: "friends", room: "friends", stats: "public" }, lists: { together: { include: [], exclude: [] }, room: { include: [], exclude: [] }, stats: { include: [], exclude: [] } }, streakReminder: false, quiet: { on: false, from: 22, to: 7 }, tz: 60, linkedName: "Synthetic Player 7" };

async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

async function run(browser, origin, size) {
  const label = size.name;
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.mobile, hasTouch: !!size.mobile, serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  const posts = [];
  const state = { lobby: null, invites: { incoming: [], sent: [] } };
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.route((url) => !String(url).startsWith(origin), (route) => {
    const url = route.request().url();
    if (url.startsWith("https://nzlay.com/ReGone/game/")) return route.fulfill({ status: 200, contentType: "text/html", body: STUB });
    return route.fulfill({ status: 204, body: "" });
  });
  const json = (route, body, status) => route.fulfill({ status: status || 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route(origin + "/v1/**", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (err) { body = {}; }
    if (req.method() !== "GET") posts.push({ path: p, method: req.method(), body });
    if (p === "/v1/games/board") return json(route, BOARD);
    if (p === "/v1/games/play") return json(route, { streak: 4, bestStreak: 6, achievements: [] });
    if (p === "/v1/games/regone/online") return json(route, { ok: true, online: 137, at: Date.now() });
    if (p === "/v1/games/regone/rooms" || p === "/v1/games/rooms") return json(route, ROOMS);
    if (p === "/v1/games/regone/top") return json(route, TOP);
    if (p === "/v1/games/achievements" && req.method() === "GET") return json(route, ACH);
    if (p === "/v1/games/regone/profile-stats") return json(route, PSTATS);
    if (p === "/v1/games/invites") return json(route, Object.assign({ now: Date.now() }, state.invites));
    if (p === "/v1/games/invite") return json(route, { ok: true, sent: true, id: "a".repeat(24), expiresAt: Date.now() + 600000, room: body.room || "", message: body.message || "", achievements: ["invite_sent"] });
    if (p === "/v1/games/invite/answer") return json(route, { ok: true, status: body.answer === "join" ? "joined" : "declined", gameId: "regone", room: "NZlay Mini 01 - EU", lobbyId: "", achievements: [] });
    if (p === "/v1/games/lobby" && req.method() === "GET") return json(route, { lobby: state.lobby });
    if (p === "/v1/games/lobby" && req.method() === "POST") {
      state.lobby = { id: "b".repeat(24), gameId: "regone", hostId: ME, room: body.room || "", private: !!body.private, member: true, launchedAt: 0, expiresAt: Date.now() + 3600000, members: [person(ME, "Test Owner", { ready: false, host: true, me: true }), person(FRIEND, "Sample Friend", { ready: true, host: false, me: false })] };
      return json(route, { lobby: state.lobby });
    }
    if (p === "/v1/games/lobby/ready") { state.lobby.members[0].ready = body.ready !== false; return json(route, { lobby: state.lobby }); }
    if (p === "/v1/games/lobby/launch") return json(route, { ok: true, launchedAt: Date.now(), room: state.lobby.room, members: 2 });
    if (p === "/v1/games/friends-rooms") return json(route, { friends: [person(FRIEND, "Sample Friend", { room: "NZlay Mini 01 - EU", gameId: "regone" })] });
    if (p === "/v1/games/presence") return json(route, { playing: true, gameId: "regone", room: "NZlay Mini 01 - EU", canInvite: true });
    if (p === "/v1/games/together") return json(route, { people: [person(FRIEND, "Sample Friend", { times: 5, lastAt: Date.now() })] });
    if (p === "/v1/games/prefs") return json(route, PREFS);
    if (p === "/v1/games/room") return json(route, { ok: true, room: body.room || "" });
    if (p === "/v1/audience-lists") return json(route, { lists: [] });
    return json(route, {}, 404);
  });
  await page.addInitScript((me) => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true }));
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token", account: { publicId: me, handle: "user_1", displayName: "Test Owner", avatar: "" } }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true };
  }, ME);

  /* Games hub: players online, invite button, achievements, Friends in rooms. */
  await page.goto(origin + "/index.html#/games", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.ViktorychGameSocial && document.querySelector("[data-gs-hub]"), null, { timeout: 20000 }).catch(() => fail(label + ": no ReGone social hub"));
  await page.waitForFunction(() => /137/.test((document.querySelector(".game-card .gs-online") || {}).textContent || ""), null, { timeout: 8000 }).catch(() => fail(label + ": no players-online chip on the tile"));
  await page.waitForSelector(".gs-ach-grid .gs-ach.got", { timeout: 8000 }).catch(() => fail(label + ": no achievements grid"));
  await page.waitForSelector(".gs-roomgroup", { timeout: 8000 }).catch(() => fail(label + ": no Friends in rooms"));
  const hub = await page.evaluate(() => ({
    got: document.querySelectorAll(".gs-ach.got").length,
    locked: document.querySelectorAll(".gs-ach:not(.got)").length,
    outline: [...document.querySelectorAll(".gs-ach svg")].every((s) => getComputedStyle(s).fill === "none"),
    wide: document.scrollingElement.scrollWidth > innerWidth + 1
  }));
  if (hub.got !== 4 || hub.locked < 5) fail(label + ": achievements " + JSON.stringify(hub));
  if (!hub.outline) fail(label + ": badges are not outline");
  if (hub.wide) fail(label + ": hub scrolls sideways");
  if (size.mobile) {
    const small = await page.evaluate(() => [...document.querySelectorAll("[data-gs-hub] .gs-btn")].filter((b) => b.getBoundingClientRect().height < 56).length);
    if (small) fail(label + ": " + small + " hub buttons are under 56px on a phone");
  }
  await shot(page, label + "-01-games-hub");

  /* Invite sheet: friend picker, room filters and search, typed room, message rules. */
  await page.click("[data-gs-hub] [data-gs-invite]");
  await page.waitForSelector(".gs-sheet .gs-room", { timeout: 8000 }).catch(() => fail(label + ": the invite sheet has no rooms"));
  const rooms0 = await page.$$eval(".gs-sheet .gs-room", (els) => els.length);
  if (rooms0 !== 4) fail(label + ": expected 4 rooms (3 official, 1 clan), got " + rooms0);
  await page.selectOption(".gs-sheet [data-gs-filter=\"region\"]", "USA");
  const usa = await page.$$eval(".gs-sheet .gs-room-name", (els) => els.map((e) => e.textContent));
  if (usa.length !== 1 || !/USA/.test(usa[0])) fail(label + ": region filter " + usa.join(","));
  await page.selectOption(".gs-sheet [data-gs-filter=\"region\"]", "");
  await page.fill(".gs-sheet [data-gs-room-filter]", "timber");
  const timber = await page.$$eval(".gs-sheet .gs-room-name", (els) => els.map((e) => e.textContent));
  if (timber.length !== 1 || !/Large 01/.test(timber[0])) fail(label + ": room search " + timber.join(","));
  await page.fill(".gs-sheet [data-gs-room-filter]", "nothing like this");
  const none = await page.textContent(".gs-sheet .gs-rooms");
  if (!/Type the name below/.test(none)) fail(label + ": no free-text fallback hint");
  await page.click(".gs-sheet [data-gs-submit]");
  let err = await page.textContent(".gs-sheet .gs-error");
  if (!/Pick a friend/.test(err)) fail(label + ": sending with no friend says " + err);
  await page.click(".gs-sheet [data-gs-pick=\"" + "100000000002" + "\"]");
  await page.fill(".gs-sheet [data-gs-room-typed]", "Our Room 7");
  await page.fill(".gs-sheet [data-gs-msg]", "join me at https://example.test now");
  await page.click(".gs-sheet [data-gs-submit]");
  err = await page.textContent(".gs-sheet .gs-error");
  if (!/links/.test(err)) fail(label + ": a link in the message was not refused: " + err);
  await page.fill(".gs-sheet [data-gs-msg]", "x".repeat(150));
  const counter = await page.evaluate(() => { const c = document.querySelector(".gs-sheet .gs-count"); return { over: c.classList.contains("over"), value: document.querySelector(".gs-sheet [data-gs-msg]").value.length }; });
  if (!counter.over && counter.value > 140) fail(label + ": the 140 counter does not warn");
  await page.fill(".gs-sheet [data-gs-msg]", "Quick round before dinner?");
  await shot(page, label + "-02-invite-sheet");
  await page.click(".gs-sheet [data-gs-submit]");
  await page.waitForFunction(() => !document.querySelector(".gs-sheet"), null, { timeout: 8000 }).catch(() => fail(label + ": the sheet did not close after sending"));
  const sent = posts.filter((x) => x.path === "/v1/games/invite").pop();
  if (!sent || sent.body.to !== FRIEND || sent.body.room !== "Our Room 7" || sent.body.message !== "Quick round before dinner?") fail(label + ": invite body " + JSON.stringify(sent));

  /* Incoming invite through the realtime channel: pop-out, countdown, Join. */
  const inv = { id: "c".repeat(24), gameId: "regone", from: person(FRIEND, "Sample Friend"), room: "NZlay Mini 01 - EU", message: "Ready?", lobbyId: "", private: false, status: "pending", createdAt: Date.now(), expiresAt: Date.now() + 600000 };
  state.invites.incoming = [inv];
  await page.evaluate((i) => window.ViktorychGameSocial.onChannel({ type: "invite", invite: i }), inv);
  await page.waitForSelector(".ach.v-invite", { timeout: 8000 }).catch(() => fail(label + ": no invite pop-out"));
  const pop = await page.evaluate(() => ({ text: document.querySelector(".ach.v-invite").textContent, online: /137/.test(document.querySelector(".ach.v-invite").textContent) }));
  if (!/invites you to play ReGone/.test(pop.text) || !/Join/.test(pop.text) || !/Not now/.test(pop.text)) fail(label + ": pop-out copy " + pop.text);
  if (!pop.online) fail(label + ": no players-online count in the pop-out");
  await shot(page, label + "-03-invite-popout");
  await page.click(".ach.v-invite .ach-btn-main");
  await page.waitForSelector("#game-host iframe", { timeout: 15000 }).catch(() => fail(label + ": Join did not open the game"));
  await page.waitForSelector("#game-host .gs-hint", { timeout: 8000 }).catch(() => fail(label + ": no Join room hint"));
  const hint = await page.textContent("#game-host .gs-hint");
  if (!/Join room NZlay Mini 01 - EU/.test(hint)) fail(label + ": hint says " + hint);
  const answered = posts.filter((x) => x.path === "/v1/games/invite/answer").pop();
  if (!answered || answered.body.answer !== "join") fail(label + ": join answer " + JSON.stringify(answered));
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => "")).catch(() => "");
  if (clip && clip !== "NZlay Mini 01 - EU") fail(label + ": clipboard holds " + clip);
  await page.waitForFunction(() => document.getElementById("game-host").classList.contains("is-loaded"), null, { timeout: 10000 }).catch(() => fail(label + ": the game never loaded"));
  await shot(page, label + "-04-join-hint");

  /* Mini player: leave the game page, the same frame keeps running. */
  await page.evaluate(() => { window.__frame = document.querySelector("#game-host iframe"); window.__src = window.__frame.src; });
  const gameFrame = await (await page.$("#game-host iframe")).contentFrame();
  await gameFrame.evaluate(() => { window.__marker = "still-running"; });
  await page.evaluate(() => { location.hash = "#/games"; });
  await page.waitForFunction(() => document.getElementById("game-host").classList.contains("mini"), null, { timeout: 8000 }).catch(() => fail(label + ": leaving did not go to the mini player"));
  const mini = await page.evaluate(() => {
    const host = document.getElementById("game-host");
    const frame = host.querySelector("iframe");
    const r = host.getBoundingClientRect();
    return { same: frame === window.__frame, src: frame.src === window.__src, hidden: host.hidden, busy: window.ViktorychGames.busy(), w: r.width, h: r.height, x: r.x, y: r.y };
  });
  mini.boot = await (await (await page.$("#game-host iframe")).contentFrame()).evaluate(() => window.__boot === 1 && window.__marker === "still-running");
  if (!mini.same || !mini.src || !mini.boot) fail(label + ": the mini player rebuilt the game frame " + JSON.stringify(mini));
  if (mini.hidden || mini.busy) fail(label + ": mini player state " + JSON.stringify(mini));
  if (mini.w > Math.max(size.width * 0.6, 120) || mini.w > 340) fail(label + ": mini player is " + mini.w + "px wide");
  await shot(page, label + "-05-mini-player");
  // Drag it.
  const cx = mini.x + mini.w / 2;
  const cy = mini.y + mini.h / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 120, cy - 120, { steps: 6 });
  await page.mouse.up();
  const moved = await page.evaluate(() => { const r = document.getElementById("game-host").getBoundingClientRect(); return { x: r.x, y: r.y, mini: document.getElementById("game-host").classList.contains("mini") }; });
  if (!moved.mini || Math.abs(moved.x - (mini.x - 120)) > 12) fail(label + ": drag " + JSON.stringify(moved));
  // Tap to expand: still the same frame.
  await page.mouse.click(moved.x + 40, moved.y + mini.h - 20);
  await page.waitForFunction(() => !document.getElementById("game-host").classList.contains("mini") && /#\/games\/regone/.test(location.hash), null, { timeout: 8000 }).catch(() => fail(label + ": tap did not expand"));
  const back = await page.evaluate(() => ({ same: document.querySelector("#game-host iframe") === window.__frame, busy: window.ViktorychGames.busy() }));
  if (!back.same || !back.busy) fail(label + ": expanding lost the frame " + JSON.stringify(back));
  // Leave again and close with X.
  await page.evaluate(() => { location.hash = "#/games"; });
  await page.waitForFunction(() => document.getElementById("game-host").classList.contains("mini"), null, { timeout: 8000 });
  const roomPosts = posts.filter((x) => x.path === "/v1/games/room").length;
  await page.waitForTimeout(1500); // the mini window keeps counting play time
  await page.click("#game-host [data-game-close]");
  const closed = await page.evaluate(() => ({ hidden: document.getElementById("game-host").hidden, frame: !!document.querySelector("#game-host iframe"), busy: window.ViktorychGames.busy() }));
  if (!closed.hidden || closed.frame || closed.busy) fail(label + ": X did not close " + JSON.stringify(closed));
  await page.waitForTimeout(300);
  if (posts.filter((x) => x.path === "/v1/games/room").length <= roomPosts) fail(label + ": closing did not clear the room");
  if (!posts.some((x) => x.path === "/v1/games/play")) fail(label + ": no play time was sent " + JSON.stringify(posts.map((x) => x.path)));

  /* Party lobby. */
  await page.click("[data-gs-lobby-new]");
  await page.waitForSelector(".gs-sheet", { timeout: 8000 });
  await page.click(".gs-sheet .gs-room");
  await page.click(".gs-sheet [data-gs-submit]");
  await page.waitForSelector(".gs-lobby .gs-member", { timeout: 8000 }).catch(() => fail(label + ": no lobby"));
  await page.click(".gs-lobby [data-gs-lobby-ready]");
  await page.waitForFunction(() => document.querySelectorAll(".gs-lobby .gs-ready.on").length === 2, null, { timeout: 8000 }).catch(() => fail(label + ": ready state did not update"));
  const lobbyText = await page.textContent(".gs-lobby");
  if (!/Launch/.test(lobbyText)) fail(label + ": the host has no Launch");
  await page.evaluate(() => document.querySelector(".gs-lobby").scrollIntoView({ block: "center" }));
  await shot(page, label + "-06-party-lobby");

  /* Top Players tab. */
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click("[data-gs-tab=\"top\"]");
  await page.waitForSelector(".gs-table tbody tr", { timeout: 8000 }).catch(() => fail(label + ": no Top Players table"));
  const top = await page.evaluate(() => ({ rows: document.querySelectorAll(".gs-table tbody tr").length, friend: !!document.querySelector(".gs-friend-row"), me: !!document.querySelector(".gs-me-row") }));
  if (top.rows !== 12 || !top.friend || !top.me) fail(label + ": top " + JSON.stringify(top));
  await page.fill("[data-gs-top-search]", "Player 1");
  await page.waitForFunction(() => document.querySelectorAll(".gs-table tbody tr").length === 4, null, { timeout: 5000 }).catch(() => fail(label + ": top search"));
  await page.fill("[data-gs-top-search]", "");
  await page.waitForFunction(() => document.querySelectorAll(".gs-table tbody tr").length === 12, null, { timeout: 5000 });
  await shot(page, label + "-07-top-players");
  await page.click("[data-gs-tab=\"games\"]");

  /* Rank card with linked NZlay stats, and the profile achievements. */
  await page.evaluate((me) => {
    const box = document.createElement("div");
    box.id = "gs-profile-probe";
    box.style.cssText = "padding:16px;max-width:600px";
    box.innerHTML = window.ViktorychGameSocial.profileTabHtml({ publicId: me, handle: "user_1" }, true);
    const main = document.querySelector("main") || document.body;
    main.prepend(box);
  }, ME);
  await page.waitForSelector("#gs-profile-probe .gs-card .gs-grid", { timeout: 8000 }).catch(() => fail(label + ": no rank card with stats"));
  const rank = await page.textContent("#gs-profile-probe .gs-card");
  if (!/#7|7/.test(rank) || !/rifle/i.test(rank)) fail(label + ": rank card " + rank);
  await page.evaluate(() => { document.querySelector("#gs-profile-probe details") && (document.querySelector("#gs-profile-probe details").open = true); window.scrollTo(0, 0); });
  await shot(page, label + "-08-rank-card");
  await page.evaluate(() => document.getElementById("gs-profile-probe").remove());

  /* Privacy > Games. */
  await page.evaluate(() => { location.hash = "#/settings/privacy"; });
  await page.waitForSelector("[data-gs-privacy] [data-gs-aud-open]", { timeout: 10000 }).catch(() => fail(label + ": no Privacy > Games"));
  const aud = await page.evaluate(() => [...new Set([...document.querySelectorAll("[data-gs-aud-open]")].map((b) => b.getAttribute("data-gs-aud-open")))]);
  if (aud.join() !== "together,room,stats") fail(label + ": audiences " + aud.join());
  if (await page.$("[data-gs-privacy] select, [data-gs-notify] select")) fail(label + ": native select in Games settings");
  await page.evaluate(() => document.querySelector("[data-gs-aud-open=\"room\"]").scrollIntoView({ block: "center" }));
  await page.click("[data-gs-aud-open=\"room\"]", { timeout: 10000 });
  await page.click(".xs-sheet-back:not(.xs-leaving) [data-xs-opt=\"only\"]", { timeout: 10000 });
  await page.waitForTimeout(300);
  const pref = posts.filter((x) => x.path === "/v1/games/prefs").pop();
  if (!pref || !pref.body.audiences || pref.body.audiences.room !== "only") fail(label + ": privacy save " + JSON.stringify(pref));
  await page.evaluate(() => document.querySelector("[data-gs-privacy]").scrollIntoView({ block: "start" }));
  await shot(page, label + "-09-privacy-games");

  /* Flags: switching regone_online off removes the chip. */
  await page.evaluate(() => { localStorage.setItem("viktorychapp-server-off", JSON.stringify(["regone_online"])); location.hash = "#/games"; });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-gs-hub]", { timeout: 15000 });
  await page.waitForTimeout(800);
  const chip = await page.evaluate(() => [...document.querySelectorAll(".gs-online")].filter((e) => !e.hidden && e.offsetParent).length);
  if (chip) fail(label + ": the online chip shows with regone_online off");
  if (errors.length) fail(label + ": " + errors[0]);
  await context.close();
  console.log("regone social ok " + label);
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    await run(browser, origin, { name: "desktop", width: 1280, height: 860 });
    await run(browser, origin, { name: "phone", width: 390, height: 844, mobile: true });
    console.log("regone social ok");
  } finally {
    await browser.close();
    server.close();
  }
}
main().catch((err) => { console.error(err && err.stack || err); process.exitCode = 1; });
