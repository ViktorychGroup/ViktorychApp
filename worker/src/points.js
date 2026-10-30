/* Viktorychs (free points earned by effort, never sold) and gifts. Amounts are chosen here, never from the client.
   The ledger is append-only. A repeated ref does not pay twice. */

import { friendshipLive } from "./friends-pref.js";
import { inspectHandle } from "../../shared/handle-skeleton.js";
import { GIFTS, SEASONS, FREE_PER_DAY, POPULAR } from "../../shared/gift-catalog.js";
import { limitedById } from "../../shared/store-catalog.js";
import { blocksEither } from "./social.js";
import { planNotification } from "./notifications.js";
import { canSeeAudience, setListGrants } from "./audience.js";
import { commitBundled } from "./mention-store.js";

export const POINTS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS point_ledger (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS point_ledger_account ON point_ledger(public_id, created_at DESC)",
  "CREATE UNIQUE INDEX IF NOT EXISTS point_ledger_once ON point_ledger(public_id, reason, ref)",
  `CREATE TABLE IF NOT EXISTS point_balances (
    public_id TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS point_daily (
    public_id TEXT NOT NULL,
    day TEXT NOT NULL,
    action TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (public_id, day, action)
  )`,
  `CREATE TABLE IF NOT EXISTS point_streaks (
    public_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    last_day TEXT NOT NULL,
    streak INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (public_id, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS point_invites (
    code TEXT PRIMARY KEY,
    inviter_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    redeemed_by TEXT NOT NULL DEFAULT '',
    redeemed_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS gift_sends (
    id TEXT PRIMARY KEY,
    gift_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    privacy TEXT NOT NULL DEFAULT 'public',
    hidden INTEGER NOT NULL DEFAULT 0,
    cost INTEGER NOT NULL,
    context TEXT NOT NULL DEFAULT 'direct',
    post_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS gift_sends_recipient ON gift_sends(recipient_id, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS gift_prefs (
    public_id TEXT PRIMARY KEY,
    hide_tab INTEGER NOT NULL DEFAULT 0,
    who TEXT NOT NULL DEFAULT 'everyone',
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS point_engagers (
    post_key TEXT NOT NULL,
    engager_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (post_key, engager_id)
  )`,
  "CREATE INDEX IF NOT EXISTS point_engagers_pair ON point_engagers(author_id, engager_id, created_at)",
  `CREATE TABLE IF NOT EXISTS point_guard (
    kind TEXT NOT NULL,
    ok INTEGER NOT NULL,
    CONSTRAINT balance CHECK (kind <> 'balance' OR ok = 1),
    CONSTRAINT edition CHECK (kind <> 'edition' OR ok = 1)
  )`
];

/* Viktorychs are earned by real effort only and are never sold.
   - quality_post: 3 distinct real people engaged with your post.
   - popular_post: 10 distinct real people engaged with your post.
   - login: long daily streaks pay at milestones only (7, 30, 100, 365 days, then every 30).
   - invite: someone you invited stayed and became active.
   Engagement counts only from other accounts at least a week old, never from
   yourself or anyone you blocked, and one person counts at most 3 times a week
   toward the same author. Accounts younger than 3 days earn nothing. */
export const RULES = {
  quality_post: { points: 15, cap: 3 },
  popular_post: { points: 25, cap: 2 },
  login: { points: 10, cap: 1, milestones: [[7, 10], [30, 40], [100, 120], [365, 300]], every: [30, 40] },
  invite: { points: 50, cap: 2 },
  profile: { points: 5, cap: 1 },
  birthday: { points: 25, cap: 1 }
};

export const EARN = {
  minAgeDays: 3,
  engagerAgeDays: 7,
  qualityAt: 3,
  popularAt: 10,
  pairPerWeek: 3,
  inviteAgeDays: 7,
  invitePosts: 3,
  inviteStreak: 5,
  redeemWithinDays: 3
};

const GAMES = { regone: 1 };
/* Gifts one person may send another per day, across the gift sheet and the store. */
export const GIFTS_PER_RECIPIENT_DAY = 10;
const PUBLIC_ID = /^\d{12}$/;

const SVG = {
  heart: "M12 20s-7-4.4-7-9a4 4 0 0 1 7-2 4 4 0 0 1 7 2c0 4.6-7 9-7 9z",
  star: "m12 3 2.4 5.6L20 9.2l-4 3.8.9 5.8L12 16.2 7.1 18.8 8 13 4 9.2l5.6-.6L12 3z",
  spark: "M12 2l1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6L12 2z",
  leaf: "M5 19c8-1 14-8 14-14-6 0-13 6-14 14zm2-2c1-4 5-8 9-9-1 4-5 8-9 9z",
  comet: "M14 4l1 4 4 1-4 1-1 4-1-4-4-1 4-1 1-4zM6 14l.6 2 2 .6-2 .6L6 20l-.6-2.8L3.4 16.6 5.4 16 6 14z",
  crown: "M4 16l2-8 4 4 2-6 2 6 4-4 2 8H4zm1 2h14v2H5v-2z",
  cake: "M4 14h16v4H4v-4zm2-3h12l-1-4H7l-1 4zm4-6h2v3h-2V5zm-3 3h2v2H7V8zm6 0h2v2h-2V8z",
  candle: "M11 3h2v3h-2V3zm-5 6h12l-1 9H7L6 9zm-1 11h14v2H5v-2z"
};

const LEGACY_GIFTS = [
  { id: "heart", category: "kindness", price: 10, seasonal: false, svg: SVG.heart },
  { id: "star", category: "kindness", price: 25, seasonal: false, svg: SVG.star },
  { id: "spark", category: "celebrate", price: 50, seasonal: false, svg: SVG.spark },
  { id: "leaf", category: "seasonal", price: 50, seasonal: true, svg: SVG.leaf },
  { id: "comet", category: "celebrate", price: 100, seasonal: false, svg: SVG.comet },
  { id: "crown", category: "celebrate", price: 250, seasonal: false, svg: SVG.crown },
  { id: "cake", category: "birthday", price: 15, seasonal: false, svg: SVG.cake },
  { id: "candle", category: "birthday", price: 40, seasonal: false, svg: SVG.candle }
];

const GIFT_BOX_SVG = "M4 10h16v10H4V10zm-1-4h18v4H3V6zm8 0h2v14h-2V6zm1 0c-2-4-6-3-5-1 1 1 3 1 5 1zm0 0c2-4 6-3 5-1-1 1-3 1-5 1z";

/* The shared catalog adds art (cp) and shelves (cats). Legacy ids keep their
   server category, so birthday-only gifts stay birthday-only. */
export const GIFT_CATALOG = GIFTS.map((item) => {
  const old = LEGACY_GIFTS.find((gift) => gift.id === item.id);
  const seasonal = item.cats.some((cat) => SEASONS[cat]);
  return {
    id: item.id,
    category: old ? old.category : (item.cats.find((cat) => !SEASONS[cat]) || "seasonal"),
    price: old ? old.price : item.price,
    seasonal: old ? old.seasonal : seasonal,
    svg: old ? old.svg : GIFT_BOX_SVG,
    cp: item.cp,
    cats: item.cats
  };
});


function giftById(id) {
  return GIFT_CATALOG.find((item) => item.id === id) || null;
}

function hex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function newId() {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function yesterday(day) {
  const date = new Date(day + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function rowsOf(result) {
  return (result && result.results) || [];
}

export function ruleList() {
  return Object.keys(RULES).map((id) => ({
    id: id,
    points: RULES[id].points,
    cap: RULES[id].cap,
    milestones: RULES[id].milestones ? RULES[id].milestones.map((row) => ({ days: row[0], points: row[1] })) : []
  }));
}

/* The streak payout for day n of a login streak, or 0. */
export function streakPayout(n) {
  const rule = RULES.login;
  const hit = rule.milestones.find((row) => row[0] === n);
  if (hit) return hit[1];
  const last = rule.milestones[rule.milestones.length - 1][0];
  if (n > last && (n - last) % rule.every[0] === 0) return rule.every[1];
  return 0;
}

async function accountAgeDays(env, publicId) {
  const row = await env.DB.prepare("SELECT created_at FROM accounts WHERE public_id = ?").bind(publicId).first();
  if (!row) return -1;
  return (Date.now() - (Number(row.created_at) || Date.now())) / 86400000;
}

async function balanceOf(env, publicId) {
  const row = await env.DB.prepare("SELECT balance FROM point_balances WHERE public_id = ?").bind(publicId).first();
  return Number(row && row.balance) || 0;
}

async function grant(env, publicId, action, mark, delta, now) {
  const rule = RULES[action];
  const day = utcDay(now);
  const prior = await env.DB.prepare(
    "SELECT id FROM point_ledger WHERE public_id = ? AND reason = ? AND ref = ?"
  ).bind(publicId, action, mark).first();
  if (prior) return { awarded: 0, balance: await balanceOf(env, publicId), duplicate: true };
  const daily = await env.DB.prepare(
    "SELECT hits FROM point_daily WHERE public_id = ? AND day = ? AND action = ?"
  ).bind(publicId, day, action).first();
  if (Number(daily && daily.hits) >= rule.cap) return { awarded: 0, balance: await balanceOf(env, publicId), capped: true };
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO point_ledger (id, public_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(newId(), publicId, delta, action, mark, now),
      env.DB.prepare(
        "INSERT INTO point_balances (public_id, balance, updated_at) VALUES (?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at"
      ).bind(publicId, delta, now),
      env.DB.prepare(
        "INSERT INTO point_daily (public_id, day, action, hits) VALUES (?, ?, ?, 1) ON CONFLICT(public_id, day, action) DO UPDATE SET hits = hits + 1"
      ).bind(publicId, day, action)
    ]);
  } catch (err) {
    if (!/UNIQUE/i.test(String(err && err.message || err))) throw err;
    return { awarded: 0, balance: await balanceOf(env, publicId), duplicate: true };
  }
  await tallyBadges(env, publicId);
  return { awarded: delta, balance: await balanceOf(env, publicId) };
}

/* One distinct real person engaged with a post. Pays the author at 3 and 10. */
export async function creditEngagement(env, authorId, postKey, engagerId) {
  const author = String(authorId || "");
  const engager = String(engagerId || "");
  const key = String(postKey || "").slice(0, 120);
  if (!PUBLIC_ID.test(author) || !PUBLIC_ID.test(engager) || !key || author === engager) return { awarded: 0 };
  if (await accountAgeDays(env, author) < EARN.minAgeDays) return { awarded: 0, young: true };
  if (await accountAgeDays(env, engager) < EARN.engagerAgeDays) return { awarded: 0, young: true };
  if (await blocksEither(env, author, engager)) return { awarded: 0 };
  const now = Date.now();
  const pair = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM point_engagers WHERE author_id = ? AND engager_id = ? AND created_at > ?"
  ).bind(author, engager, now - 7 * 86400000).first();
  if (Number(pair && pair.n) >= EARN.pairPerWeek) return { awarded: 0, pair: true };
  const added = await env.DB.prepare(
    "INSERT INTO point_engagers (post_key, engager_id, author_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(post_key, engager_id) DO NOTHING"
  ).bind(key, engager, author, now).run();
  if (!(added && added.meta && added.meta.changes)) return { awarded: 0, duplicate: true };
  const counted = await env.DB.prepare("SELECT COUNT(*) AS n FROM point_engagers WHERE post_key = ? AND author_id = ?").bind(key, author).first();
  const n = Number(counted && counted.n) || 0;
  if (n >= EARN.popularAt) return grant(env, author, "popular_post", key, RULES.popular_post.points, now);
  if (n >= EARN.qualityAt) return grant(env, author, "quality_post", key, RULES.quality_post.points, now);
  return { awarded: 0, engagers: n };
}

async function replyAuthor(env, replyId) {
  const id = String(replyId || "");
  let row = null;
  try { row = await env.DB.prepare("SELECT author_id, parent_id FROM public_posts WHERE id = ?").bind(id).first(); }
  catch (err) { row = null; }
  if (!row) {
    try { row = await env.DB.prepare("SELECT author_id, parent_id FROM account_content WHERE id = ?").bind(id).first(); }
    catch (err) { row = null; }
  }
  return row;
}

async function loginStreak(env, publicId, now) {
  const day = utcDay(now);
  const row = await env.DB.prepare(
    "SELECT last_day, streak FROM point_streaks WHERE public_id = ? AND kind = 'login'"
  ).bind(publicId).first();
  if (row && row.last_day === day) return { awarded: 0, balance: await balanceOf(env, publicId), streak: Number(row.streak) || 1 };
  const streak = row && row.last_day === yesterday(day) ? (Number(row.streak) || 0) + 1 : 1;
  await env.DB.prepare(
    "INSERT INTO point_streaks (public_id, kind, last_day, streak) VALUES (?, 'login', ?, ?) ON CONFLICT(public_id, kind) DO UPDATE SET last_day = excluded.last_day, streak = excluded.streak"
  ).bind(publicId, day, streak).run();
  await payInviterIfActive(env, publicId, now, streak);
  const pay = streakPayout(streak);
  if (!pay || await accountAgeDays(env, publicId) < EARN.minAgeDays) return { awarded: 0, balance: await balanceOf(env, publicId), streak: streak };
  const got = await grant(env, publicId, "login", "streak:" + day, pay, now);
  got.streak = streak;
  return got;
}

/* An invite pays once the invited person stayed a week, posted, and kept a streak. */
async function payInviterIfActive(env, publicId, now, streak) {
  const invite = await env.DB.prepare("SELECT code, inviter_id FROM point_invites WHERE redeemed_by = ?").bind(publicId).first();
  if (!invite) return;
  if (streak < EARN.inviteStreak || await accountAgeDays(env, publicId) < EARN.inviteAgeDays) return;
  let posts = 0;
  try {
    const counted = await env.DB.prepare("SELECT COUNT(*) AS n FROM public_posts WHERE author_id = ? AND hidden = 0").bind(publicId).first();
    posts = Number(counted && counted.n) || 0;
  } catch (err) { posts = 0; }
  if (posts < EARN.invitePosts) return;
  if (await accountAgeDays(env, invite.inviter_id) < EARN.minAgeDays) return;
  await grant(env, invite.inviter_id, "invite", invite.code, RULES.invite.points, now);
}

export async function awardActivity(env, publicId, action, ref) {
  if (!PUBLIC_ID.test(String(publicId || ""))) return { awarded: 0, balance: 0 };
  const mark = String(ref || "").slice(0, 120);
  if (action === "like_in") {
    const cut = mark.indexOf(":");
    if (cut < 0) return { awarded: 0 };
    return creditEngagement(env, publicId, mark.slice(cut + 1), mark.slice(0, cut));
  }
  if (action === "reply_in") {
    const reply = await replyAuthor(env, mark);
    if (!reply || !reply.parent_id) return { awarded: 0 };
    return creditEngagement(env, publicId, reply.parent_id, reply.author_id);
  }
  const now = Date.now();
  if (action === "login") return loginStreak(env, publicId, now);
  const rule = RULES[action];
  if (!rule || !mark) return { awarded: 0, balance: await balanceOf(env, publicId) };
  if (await accountAgeDays(env, publicId) < EARN.minAgeDays) return { awarded: 0, balance: await balanceOf(env, publicId), young: true };
  return grant(env, publicId, action, mark, rule.points, now);
}

async function tallyBadges(env, publicId) {
  try {
    const badges = await import("./badges.js");
    await badges.syncBadges(env, publicId);
  } catch (err) { /* points are saved even if a badge tally misses */ }
}

export async function clawback(env, publicId, action, ref) {
  if (action === "post" || action === "comment") {
    const first = await clawback(env, publicId, "quality_post", ref);
    const second = await clawback(env, publicId, "popular_post", ref);
    return { awarded: (first.awarded || 0) + (second.awarded || 0) };
  }
  if (action === "like_in") {
    const cut = String(ref || "").indexOf(":");
    if (cut < 0) return { awarded: 0 };
    await env.DB.prepare("DELETE FROM point_engagers WHERE post_key = ? AND engager_id = ?").bind(String(ref).slice(cut + 1), String(ref).slice(0, cut)).run();
    return { awarded: 0 };
  }
  if (!PUBLIC_ID.test(String(publicId || "")) || !RULES[action]) return { awarded: 0 };
  const mark = String(ref || "").slice(0, 120);
  if (!mark) return { awarded: 0 };
  const original = await env.DB.prepare(
    "SELECT delta FROM point_ledger WHERE public_id = ? AND reason = ? AND ref = ? AND delta > 0"
  ).bind(publicId, action, mark).first();
  if (!original) return { awarded: 0 };
  const clawRef = "claw:" + mark;
  const already = await env.DB.prepare(
    "SELECT id FROM point_ledger WHERE public_id = ? AND reason = ? AND ref = ?"
  ).bind(publicId, action, clawRef).first();
  if (already) return { awarded: 0, duplicate: true };
  const balance = await balanceOf(env, publicId);
  const delta = -Math.min(Number(original.delta) || 0, balance);
  if (!delta) return { awarded: 0, balance: balance };
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO point_ledger (id, public_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(newId(), publicId, delta, action, clawRef, now),
    env.DB.prepare(
      "UPDATE point_balances SET balance = balance + ?, updated_at = ? WHERE public_id = ?"
    ).bind(delta, now, publicId)
  ]);
  return { awarded: delta, balance: await balanceOf(env, publicId) };
}

/* Atomic: the balance check, the debit and the ledger row are one transaction.
   A guard row with a CHECK constraint aborts the whole batch on a short balance. */
export function spendStatements(env, publicId, cost, reason, mark, now) {
  return [
    env.DB.prepare(
      "UPDATE point_balances SET balance = balance - ?, updated_at = ? WHERE public_id = ? AND balance >= ?"
    ).bind(cost, now, publicId, cost),
    env.DB.prepare("INSERT INTO point_guard (kind, ok) SELECT 'balance', changes()"),
    env.DB.prepare(
      "INSERT INTO point_ledger (id, public_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(newId(), publicId, -cost, reason, mark, now)
  ];
}

export function guardFailure(err) {
  const text = String(err && err.message || err);
  if (/CHECK constraint failed: balance/i.test(text)) return "balance";
  if (/CHECK constraint failed: edition/i.test(text)) return "sold_out";
  return "";
}

export async function spendPoints(env, publicId, amount, reason, ref, extra) {
  const cost = Math.floor(Number(amount) || 0);
  if (cost <= 0 || !PUBLIC_ID.test(String(publicId || ""))) return { ok: false, error: "cost" };
  const now = Date.now();
  const mark = String(ref || newId()).slice(0, 120);
  try {
    await env.DB.batch(spendStatements(env, publicId, cost, reason, mark, now).concat(extra || [], [env.DB.prepare("DELETE FROM point_guard")]));
  } catch (err) {
    const why = guardFailure(err);
    if (!why) throw err;
    return { ok: false, error: why, balance: await balanceOf(env, publicId) };
  }
  return { ok: true, balance: await balanceOf(env, publicId) };
}

export { balanceOf, newId, accountByHandle, prefsOf, cleanMessage, giftById, tallyBadges, birthdayGiftAllowed };

async function history(env, publicId) {
  const listed = await env.DB.prepare(
    "SELECT delta, reason, created_at FROM point_ledger WHERE public_id = ? ORDER BY created_at DESC LIMIT 40"
  ).bind(publicId).all();
  return rowsOf(listed).map((row) => ({
    delta: Number(row.delta) || 0,
    reason: row.reason,
    at: Number(row.created_at) || 0
  }));
}

function cleanMessage(value) {
  return String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, 500);
}

async function accountByHandle(env, handle) {
  const checked = inspectHandle(String(handle || "").replace(/^@/, ""));
  if (!checked.ok) return null;
  return env.DB.prepare(
    "SELECT public_id, handle, display_name, bio, avatar, location FROM accounts WHERE skeleton = ?"
  ).bind(checked.skeleton).first();
}

async function prefsOf(env, publicId) {
  const row = await env.DB.prepare("SELECT hide_tab, who FROM gift_prefs WHERE public_id = ?").bind(publicId).first();
  const who = row && (row.who === "followers" || row.who === "nobody" || row.who === "list") ? row.who : "everyone";
  return { hideTab: !!(row && row.hide_tab === 1), who: who };
}

function presentGift(row, viewerId, owner) {
  const privacy = row.privacy === "private" || row.privacy === "anonymous" ? row.privacy : "public";
  const limited = limitedById(row.gift_id);
  const gift = giftById(limited ? limited.base : row.gift_id);
  const item = {
    id: row.id,
    giftId: row.gift_id,
    base: limited ? limited.base : "",
    edition: Number(row.edition) || 0,
    wrapped: row.pay_method === "money" && !row.opened_at,
    svg: gift ? gift.svg : "",
    cp: gift ? gift.cp : "",
    message: row.message || "",
    at: Number(row.created_at) || 0,
    hidden: row.hidden === 1,
    context: row.context || "direct",
    postId: row.post_id || ""
  };
  const showSender = privacy === "public" || (privacy === "private" && (owner || viewerId === row.recipient_id));
  if (showSender && privacy !== "anonymous") {
    item.sender = { handle: row.sender_handle || "", name: row.sender_name || "" };
  } else item.sender = null;
  return item;
}

async function listGifts(env, ownerId, viewerId, owner) {
  const prefs = await prefsOf(env, ownerId);
  if (prefs.hideTab && !owner) return { hidden: true, who: prefs.who, gifts: [] };
  const listed = await env.DB.prepare(
    "SELECT g.id, g.gift_id, g.sender_id, g.recipient_id, g.message, g.privacy, g.hidden, g.context, g.post_id, g.created_at, a.handle AS sender_handle, a.display_name AS sender_name, o.opened_at, so.method AS pay_method, so.edition FROM gift_sends g LEFT JOIN accounts a ON a.public_id = g.sender_id LEFT JOIN gift_opens o ON o.send_id = g.id LEFT JOIN store_orders so ON so.gift_send_id = g.id AND so.status = 'paid' WHERE g.recipient_id = ? ORDER BY g.created_at DESC LIMIT 80"
  ).bind(ownerId).all();
  const gifts = [];
  rowsOf(listed).forEach((row) => {
    if (row.hidden === 1 && !owner) return;
    gifts.push(presentGift(row, viewerId, owner));
  });
  return { hidden: false, who: owner ? prefs.who : "", hideTab: owner ? prefs.hideTab : false, gifts: gifts };
}

/* Free gifts cost nothing, so each account gets a few a day. */
async function takeFreeGift(env, publicId) {
  const day = utcDay(Date.now());
  const row = await env.DB.prepare(
    "SELECT hits FROM point_daily WHERE public_id = ? AND day = ? AND action = 'free_gift'"
  ).bind(publicId, day).first();
  if (Number(row && row.hits) >= FREE_PER_DAY) return { ok: false, error: "free_limit", balance: await balanceOf(env, publicId) };
  await env.DB.prepare(
    "INSERT INTO point_daily (public_id, day, action, hits) VALUES (?, ?, 'free_gift', 1) ON CONFLICT(public_id, day, action) DO UPDATE SET hits = hits + 1"
  ).bind(publicId, day).run();
  return { ok: true, balance: await balanceOf(env, publicId) };
}

/* Most-sent gifts of the last two weeks, topped up from the house picks. */
async function trendingGifts(env) {
  let ids = [];
  try {
    const listed = await env.DB.prepare(
      "SELECT gift_id, COUNT(*) AS n FROM gift_sends WHERE created_at > ? GROUP BY gift_id ORDER BY n DESC LIMIT 12"
    ).bind(Date.now() - 14 * 86400000).all();
    ids = rowsOf(listed).map((row) => row.gift_id).filter((id) => giftById(id));
  } catch (err) { ids = []; }
  POPULAR.forEach((id) => { if (ids.length < 12 && !ids.includes(id)) ids.push(id); });
  return ids;
}

export async function dailyFreeGift() {
  return { enabled: false };
}

export async function giftForPost(env, postId, viewerId) {
  if (!postId) return null;
  const row = await env.DB.prepare(
    "SELECT g.id, g.gift_id, g.sender_id, g.recipient_id, g.message, g.privacy, g.hidden, g.context, g.post_id, g.created_at, a.handle AS sender_handle, a.display_name AS sender_name FROM gift_sends g LEFT JOIN accounts a ON a.public_id = g.sender_id WHERE g.post_id = ?"
  ).bind(postId).first();
  if (!row || row.hidden === 1) return null;
  const owner = viewerId && viewerId === row.recipient_id;
  return presentGift(row, viewerId || "", !!owner);
}

function birthdayParts(text) {
  const raw = String(text || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/) || raw.match(/^(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = match.length > 3 ? Number(match[1]) : 0;
  const month = Number(match[match.length > 3 ? 2 : 1]);
  const day = Number(match[match.length > 3 ? 3 : 2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: year, month: month, day: day };
}

function zonedYmd(ms, timeZone) {
  const zone = timeZone || "UTC";
  try {
    const bag = {};
    new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms)).forEach((part) => {
      bag[part.type] = part.value;
    });
    return { year: Number(bag.year), month: Number(bag.month), day: Number(bag.day) };
  } catch (err) {
    const date = new Date(ms);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }
}

function daysUntilBirthday(parts, now, timeZone) {
  if (!parts) return null;
  const today = zonedYmd(now, timeZone);
  const start = Date.UTC(today.year, today.month - 1, today.day);
  const last = (year) => new Date(Date.UTC(year, parts.month, 0)).getUTCDate();
  let target = Date.UTC(today.year, parts.month - 1, Math.min(parts.day, last(today.year)));
  if (target < start) target = Date.UTC(today.year + 1, parts.month - 1, Math.min(parts.day, last(today.year + 1)));
  return Math.round((target - start) / 86400000);
}

async function birthdayField(env, publicId) {
  try {
    return await env.DB.prepare(
      "SELECT id, body, audience, tz FROM about_fields WHERE public_id = ? AND kind = 'birthday' ORDER BY created_at ASC LIMIT 1"
    ).bind(publicId).first();
  } catch (err) {
    try {
      return await env.DB.prepare(
        "SELECT id, body, audience FROM about_fields WHERE public_id = ? AND kind = 'birthday' ORDER BY created_at ASC LIMIT 1"
      ).bind(publicId).first();
    } catch (err2) {
      return null;
    }
  }
}

async function birthdayGiftAllowed(env, viewerId, recipientId, now) {
  const field = await birthdayField(env, recipientId);
  if (!field || daysUntilBirthday(birthdayParts(field.body), now, field.tz) !== 0) return false;
  const audience = field.audience || "only";
  if (audience === "only") return false;
  if (audience === "list") {
    const allow = await env.DB.prepare(
      "SELECT user_id FROM about_field_allow WHERE field_id = ? AND user_id = ?"
    ).bind(field.id, viewerId).first();
    if (!allow) return false;
  }
  const follow = await env.DB.prepare(
    "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?"
  ).bind(viewerId, "app:" + recipientId).first();
  if (audience === "followers" && !follow) return false;
  if (audience === "friends") {
    const back = await env.DB.prepare(
      "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?"
    ).bind(recipientId, "app:" + viewerId).first();
    const friends = await env.DB.prepare(
      "SELECT user_id FROM account_friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)"
    ).bind(viewerId, recipientId, recipientId, viewerId).first();
    const friendCounts = !!friends && await friendshipLive(env, viewerId, recipientId);
    if (!follow || (!back && !friendCounts)) return false;
  }
  return true;
}

export async function awardBirthdayBonuses(env, now) {
  if (String(env.BIRTHDAY_POINTS || "") === "off") return { awarded: 0 };
  let listed = null;
  try {
    listed = await env.DB.prepare("SELECT public_id, body, tz FROM about_fields WHERE kind = 'birthday' LIMIT 400").all();
  } catch (err) {
    try { listed = await env.DB.prepare("SELECT public_id, body FROM about_fields WHERE kind = 'birthday' LIMIT 400").all(); }
    catch (err2) { return { awarded: 0 }; }
  }
  const at = Number(now) || Date.now();
  let awarded = 0;
  for (const row of rowsOf(listed)) {
    const parts = birthdayParts(row.body);
    if (daysUntilBirthday(parts, at, row.tz) !== 0) continue;
    const year = String(zonedYmd(at, row.tz).year);
    const paid = await awardActivity(env, row.public_id, "birthday", "bday:" + year);
    awarded += paid.awarded || 0;
  }
  return { awarded: awarded };
}

export async function handlePoints(request, env, path, deps) {
  const url = new URL(request.url);
  const viewer = await deps.sessionAccount(env, request);
  if (path === "/v1/gifts/catalog" && request.method === "GET") {
    return deps.json(200, {
      gifts: GIFT_CATALOG.map((item) => ({ id: item.id, category: item.category, price: item.price, seasonal: item.seasonal, svg: item.svg, cp: item.cp, cats: item.cats })),
      trending: await trendingGifts(env),
      freePerDay: FREE_PER_DAY
    });
  }
  if (path === "/v1/gifts/daily" && request.method === "GET") return deps.json(200, await dailyFreeGift());
  if (path === "/v1/points/board" && request.method === "GET") {
    return deps.json(200, { enabled: String(env.POINTS_BOARD || "") === "on" });
  }
  if (path === "/v1/gifts/inbox" && request.method === "GET") {
    if (!viewer) return deps.json(401, { error: "unauthorized" });
    const listed = await env.DB.prepare(
      "SELECT g.id, g.gift_id, g.sender_id, g.recipient_id, g.message, g.privacy, g.hidden, g.context, g.post_id, g.created_at, a.handle AS sender_handle, a.display_name AS sender_name FROM gift_sends g LEFT JOIN accounts a ON a.public_id = g.sender_id WHERE g.recipient_id = ? AND g.context = 'dm' AND g.hidden = 0 ORDER BY g.created_at DESC LIMIT 40"
    ).bind(viewer.public_id).all();
    return deps.json(200, { gifts: rowsOf(listed).map((row) => presentGift(row, viewer.public_id, true)) });
  }
  if (path === "/v1/gifts" && request.method === "GET") {
    const handle = String(url.searchParams.get("handle") || "");
    const ownerRow = handle ? await accountByHandle(env, handle) : viewer;
    if (!ownerRow) return deps.json(handle ? 404 : 401, { error: handle ? "not_found" : "unauthorized" });
    const owner = !!(viewer && viewer.public_id === ownerRow.public_id);
    return deps.json(200, await listGifts(env, ownerRow.public_id, viewer ? viewer.public_id : "", owner));
  }
  if (!viewer) return deps.json(401, { error: "unauthorized" });
  if (path === "/v1/gifts/sent" && request.method === "GET") {
    const listed = await env.DB.prepare(
      "SELECT g.id, g.gift_id, g.recipient_id, g.message, g.privacy, g.context, g.created_at, a.handle AS recipient_handle, a.display_name AS recipient_name FROM gift_sends g LEFT JOIN accounts a ON a.public_id = g.recipient_id WHERE g.sender_id = ? ORDER BY g.created_at DESC LIMIT 80"
    ).bind(viewer.public_id).all();
    return deps.json(200, {
      gifts: rowsOf(listed).map((row) => {
        const gift = giftById(row.gift_id);
        return {
          id: row.id,
          giftId: row.gift_id,
          svg: gift ? gift.svg : "",
          cp: gift ? gift.cp : "",
          message: row.message || "",
          privacy: row.privacy || "public",
          context: row.context || "direct",
          at: Number(row.created_at) || 0,
          recipient: { handle: row.recipient_handle || "", name: row.recipient_name || "" }
        };
      })
    });
  }
  if (path === "/v1/points" && request.method === "GET") {
    return deps.json(200, {
      balance: await balanceOf(env, viewer.public_id),
      history: await history(env, viewer.public_id),
      rules: ruleList()
    });
  }
  if (path === "/v1/points/touch" && request.method === "POST") {
    const paced = await deps.rateHit(env, "points:" + viewer.public_id, 30, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 2000);
    if (body.error) return deps.json(400, { error: body.error });
    const action = String(body.action || "");
    const day = utcDay(Date.now());
    let result = { awarded: 0 };
    if (action === "login") result = await awardActivity(env, viewer.public_id, "login", day);
    else if (action === "read" || (action === "game" && GAMES[String(body.gameId || "")])) result = { awarded: 0 };
    else if (action === "profile") {
      const ready = viewer.display_name && String(viewer.bio || "").trim() && (viewer.avatar || viewer.location);
      if (!ready) return deps.json(400, { error: "incomplete" });
      result = await awardActivity(env, viewer.public_id, "profile", "profile");
    } else return deps.json(400, { error: "action" });
    return deps.json(200, { awarded: result.awarded || 0, streak: result.streak || 0, balance: result.balance != null ? result.balance : await balanceOf(env, viewer.public_id) });
  }
  if (path === "/v1/points/invites" && request.method === "POST") {
    const paced = await deps.rateHit(env, "invite:" + viewer.public_id, 10, 24 * 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const code = hex(crypto.getRandomValues(new Uint8Array(8)));
    await env.DB.prepare(
      "INSERT INTO point_invites (code, inviter_id, created_at, redeemed_by, redeemed_at) VALUES (?, ?, ?, '', 0)"
    ).bind(code, viewer.public_id, Date.now()).run();
    return deps.json(201, { code: code });
  }
  if (path === "/v1/points/invites/redeem" && request.method === "POST") {
    const body = await deps.readJson(request, 1000);
    if (body.error) return deps.json(400, { error: body.error });
    const code = String(body.code || "").toLowerCase();
    if (!/^[a-f0-9]{16}$/.test(code)) return deps.json(400, { error: "code" });
    const row = await env.DB.prepare("SELECT inviter_id, redeemed_by FROM point_invites WHERE code = ?").bind(code).first();
    if (!row || row.redeemed_by || row.inviter_id === viewer.public_id) return deps.json(400, { error: "code" });
    /* Only a brand-new account can use an invite, and only once. The inviter is
       paid later, when this account has stayed and become active. */
    if (await accountAgeDays(env, viewer.public_id) > EARN.redeemWithinDays) return deps.json(400, { error: "too_late" });
    const used = await env.DB.prepare("SELECT code FROM point_invites WHERE redeemed_by = ?").bind(viewer.public_id).first();
    if (used) return deps.json(400, { error: "code" });
    await env.DB.prepare(
      "UPDATE point_invites SET redeemed_by = ?, redeemed_at = ? WHERE code = ? AND redeemed_by = ''"
    ).bind(viewer.public_id, Date.now(), code).run();
    return deps.json(200, { ok: true, awarded: 0, inviterAwarded: 0, pending: true });
  }
  if (path === "/v1/gifts/prefs" && request.method === "PUT") {
    const body = await deps.readJson(request, 8000);
    if (body.error) return deps.json(400, { error: body.error });
    const who = body.who === "followers" || body.who === "nobody" || body.who === "list" ? body.who : "everyone";
    const hide = body.hideTab ? 1 : 0;
    await env.DB.prepare(
      "INSERT INTO gift_prefs (public_id, hide_tab, who, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET hide_tab = excluded.hide_tab, who = excluded.who, updated_at = excluded.updated_at"
    ).bind(viewer.public_id, hide, who, Date.now()).run();
    if (who === "list") await setListGrants(env, viewer.public_id, "gift", viewer.public_id, body.listIds);
    else await setListGrants(env, viewer.public_id, "gift", viewer.public_id, []);
    return deps.json(200, { hideTab: !!hide, who: who });
  }
  if (path === "/v1/gifts/send" && request.method === "POST") {
    const paced = await deps.rateHit(env, "gift:" + viewer.public_id, 20, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 4000);
    if (body.error) return deps.json(400, { error: body.error });
    const gift = giftById(String(body.giftId || ""));
    if (!gift) return deps.json(400, { error: "gift" });
    const recipient = await accountByHandle(env, body.handle || body.recipientHandle || "");
    if (!recipient || recipient.public_id === viewer.public_id) return deps.json(400, { error: "recipient" });
    if (await blocksEither(env, viewer.public_id, recipient.public_id)) return deps.json(403, { error: "blocked" });
    if (gift.category === "birthday" && !(await birthdayGiftAllowed(env, viewer.public_id, recipient.public_id, Date.now()))) {
      return deps.json(403, { error: "birthday" });
    }
    const prefs = await prefsOf(env, recipient.public_id);
    if (prefs.who === "nobody") return deps.json(403, { error: "closed" });
    if (prefs.who === "followers") {
      const follow = await env.DB.prepare(
        "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?"
      ).bind(viewer.public_id, "app:" + recipient.public_id).first();
      if (!follow) return deps.json(403, { error: "followers" });
    }
    if (prefs.who === "list") {
      const allowed = await canSeeAudience(env, {
        viewerId: viewer.public_id,
        ownerId: recipient.public_id,
        audience: "list",
        subject: "gift",
        subjectId: recipient.public_id
      });
      if (!allowed) return deps.json(403, { error: "closed" });
    }
    const privacy = body.privacy === "private" || body.privacy === "anonymous" ? body.privacy : "public";
    const mode = body.mode === "reply" || body.mode === "dm" ? body.mode : "direct";
    const parentId = String(body.parentId || "").replace(/[^\w.:-]/g, "").slice(0, 80);
    if (mode === "reply" && !parentId) return deps.json(400, { error: "parent" });
    const perRecipient = await deps.rateHit(env, "gift-to:" + viewer.public_id + ":" + recipient.public_id, GIFTS_PER_RECIPIENT_DAY, 24 * 60 * 60 * 1000);
    if (!perRecipient.ok) return deps.limited(perRecipient);
    const sendId = newId();
    let paid;
    if (gift.price > 0) paid = await spendPoints(env, viewer.public_id, gift.price, "gift", sendId);
    else paid = await takeFreeGift(env, viewer.public_id);
    if (!paid.ok) return deps.json(paid.error === "free_limit" ? 429 : 402, { error: paid.error, balance: paid.balance || 0 });
    const now = Date.now();
    const message = cleanMessage(body.message);
    let postId = "";
    if (mode === "reply") {
      postId = newId();
      await env.DB.prepare(
        "INSERT INTO public_posts (id, author_id, body, parent_id, quote_id, created_at, hidden) VALUES (?, ?, ?, ?, '', ?, 0)"
      ).bind(postId, viewer.public_id, message || gift.id, parentId, now).run();
      try {
        await awardActivity(env, viewer.public_id, "comment", postId);
        const parentRow = await env.DB.prepare("SELECT author_id FROM public_posts WHERE id = ?").bind(parentId).first();
        if (parentRow && parentRow.author_id && parentRow.author_id !== viewer.public_id) {
          await awardActivity(env, parentRow.author_id, "reply_in", postId);
        }
      } catch (err) { /* the reply is saved */ }
    } else if (mode === "dm") {
      postId = "ct_" + hex(crypto.getRandomValues(new Uint8Array(8)));
      await env.DB.prepare(
        "INSERT INTO account_content (id, author_id, kind, parent_id, body, created_at, updated_at, deleted_at) VALUES (?, ?, 'dm', ?, ?, ?, ?, 0)"
      ).bind(postId, viewer.public_id, recipient.public_id, message || gift.id, now, now).run();
    }
    await env.DB.prepare(
      "INSERT INTO gift_sends (id, gift_id, sender_id, recipient_id, message, privacy, hidden, cost, context, post_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)"
    ).bind(sendId, gift.id, viewer.public_id, recipient.public_id, message, privacy, gift.price, mode, postId, now).run();
    await tallyBadges(env, viewer.public_id);
    await tallyBadges(env, recipient.public_id);
    try {
      const named = privacy !== "anonymous";
      const note = await planNotification(env, {
        publicId: recipient.public_id,
        kind: "gift",
        at: now,
        actorId: named ? viewer.public_id : "",
        idempotencyKey: "gift:" + sendId,
        handle: named ? viewer.handle : "",
        name: named ? viewer.display_name : "",
        text: cleanMessage(body.message).slice(0, 140),
        hash: "#/@" + encodeURIComponent(recipient.handle || "") + "?tab=gifts",
        platform: "app"
      });
      if (note && note.statements) await commitBundled(env, note.statements, note.deliveries || [], request);
    } catch (err) { /* the gift is already stored */ }
    const attached = postId ? await giftForPost(env, postId, recipient.public_id) : null;
    return deps.json(201, {
      id: sendId,
      balance: paid.balance,
      context: mode,
      postId: postId,
      post: mode === "reply" ? {
        id: postId,
        text: message,
        body: message,
        handle: viewer.handle,
        author: viewer.display_name,
        platform: "app",
        date: new Date(now).toISOString(),
        parentId: parentId,
        gift: attached
      } : null
    });
  }
  const hide = path.match(/^\/v1\/gifts\/([a-f0-9]{32})\/hide$/);
  if (hide && request.method === "POST") {
    const row = await env.DB.prepare("SELECT id, recipient_id, hidden FROM gift_sends WHERE id = ?").bind(hide[1]).first();
    if (!row || row.recipient_id !== viewer.public_id) return deps.json(404, { error: "not_found" });
    const next = row.hidden === 1 ? 0 : 1;
    await env.DB.prepare("UPDATE gift_sends SET hidden = ? WHERE id = ?").bind(next, row.id).run();
    return deps.json(200, { hidden: next === 1 });
  }
  return null;
}
