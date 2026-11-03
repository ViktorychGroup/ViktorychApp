/* Store: gifts and sticker packs, paid with money (payment adapter) or with
   Viktorychs (earned, never sold). Purchases and entitlements live in D1, keyed
   by internal account ids. No card data is ever stored here. */

import { storeItem, limitedById, limitedOpen, STICKER_PACKS, STICKER_RE, validSticker, stickerPack, STATUS_EMOJIS, statusEmojiById, statusEmojiByChar, emojiEntitlement, CURRENCY, TIERS, LIMITED, REFUND_DAYS, giftTier } from "../../shared/store-catalog.js";
import { GIFTS } from "../../shared/gift-catalog.js";
import { blocksEither } from "./social.js";
import { canSeeAudience } from "./audience.js";
import { emitNotification } from "./notifications.js";
import { balanceOf, newId, accountByHandle, prefsOf, cleanMessage, giftById, tallyBadges, spendStatements, GIFTS_PER_RECIPIENT_DAY, guardFailure, birthdayGiftAllowed } from "./points.js";
import { paymentProvider, paymentsInfo, verifyStripe, PROVIDERS } from "./payments.js";

export const STORE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS store_orders (
    id TEXT PRIMARY KEY,
    buyer_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    method TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    provider_ref TEXT NOT NULL DEFAULT '',
    payment_ref TEXT NOT NULL DEFAULT '',
    edition INTEGER NOT NULL DEFAULT 0,
    gift_send_id TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    privacy TEXT NOT NULL DEFAULT 'public',
    created_at INTEGER NOT NULL,
    paid_at INTEGER NOT NULL DEFAULT 0,
    refunded_at INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS store_orders_buyer ON store_orders(buyer_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS store_orders_send ON store_orders(gift_send_id)",
  `CREATE TABLE IF NOT EXISTS store_entitlements (
    owner_id TEXT NOT NULL,
    pack_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, pack_id)
  )`,
  `CREATE TABLE IF NOT EXISTS store_editions (
    item_id TEXT PRIMARY KEY,
    sold INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS gift_opens (
    send_id TEXT PRIMARY KEY,
    opened_at INTEGER NOT NULL
  )`
];

const PUBLIC_ID = /^\d{12}$/;
const ORDER_ID = /^[a-f0-9]{32}$/;
const DAY = 86400000;

function rowsOf(result) {
  return (result && result.results) || [];
}

function itemName(item) {
  return item.name || item.id;
}

/* Sticker packs this account may use: the free ones plus what it owns. */
export async function ownedPacks(env, publicId) {
  const owned = STICKER_PACKS.filter((pack) => pack.tier === "free").map((pack) => pack.id);
  if (!PUBLIC_ID.test(String(publicId || ""))) return owned;
  try {
    const listed = await env.DB.prepare("SELECT pack_id FROM store_entitlements WHERE owner_id = ?").bind(publicId).all();
    rowsOf(listed).forEach((row) => { if (stickerPack(row.pack_id) && owned.indexOf(row.pack_id) < 0) owned.push(row.pack_id); });
  } catch (err) { /* table not ready: free packs only */ }
  return owned;
}

/* Status emojis this account owns (ids from the catalog). */
export async function ownedEmojis(env, publicId) {
  const owned = [];
  if (!PUBLIC_ID.test(String(publicId || ""))) return owned;
  try {
    const listed = await env.DB.prepare("SELECT pack_id FROM store_entitlements WHERE owner_id = ? AND pack_id LIKE 'emoji:%'").bind(publicId).all();
    rowsOf(listed).forEach((row) => {
      const id = String(row.pack_id || "").slice(6);
      if (statusEmojiById(id) && owned.indexOf(id) < 0) owned.push(id);
    });
  } catch (err) { /* table not ready: nothing owned */ }
  return owned;
}

/* A custom status may use any emoji except a store status emoji the account doesn't own. */
export async function statusEmojiAllowed(env, publicId, emoji) {
  const special = statusEmojiByChar(emoji);
  if (!special) return true;
  return (await ownedEmojis(env, publicId)).indexOf(special.id) >= 0;
}

/* Drops sticker tokens the author does not own, so stickers in comments are real purchases. */
export async function keepOwnedStickers(env, publicId, text) {
  const value = String(text || "");
  if (value.indexOf("[[sticker:") < 0) return value;
  const owned = await ownedPacks(env, publicId);
  return value.replace(STICKER_RE, (whole, pack, item) => (validSticker(pack, item) && owned.indexOf(pack) >= 0 ? whole : ""));
}

async function editionsSold(env) {
  const sold = {};
  try {
    const listed = await env.DB.prepare("SELECT item_id, sold FROM store_editions").all();
    rowsOf(listed).forEach((row) => { sold[row.item_id] = Number(row.sold) || 0; });
  } catch (err) { /* none yet */ }
  return sold;
}

async function checkRecipient(env, viewer, recipient, item) {
  if (!recipient) return { status: 400, error: "recipient" };
  if (recipient.public_id === viewer.public_id) return null;
  if (await blocksEither(env, viewer.public_id, recipient.public_id)) return { status: 403, error: "blocked" };
  const prefs = await prefsOf(env, recipient.public_id);
  if (prefs.who === "nobody") return { status: 403, error: "closed" };
  if (prefs.who === "followers") {
    const follow = await env.DB.prepare(
      "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?"
    ).bind(viewer.public_id, "app:" + recipient.public_id).first();
    if (!follow) return { status: 403, error: "followers" };
  }
  if (prefs.who === "list") {
    const allowed = await canSeeAudience(env, { viewerId: viewer.public_id, ownerId: recipient.public_id, audience: "list", subject: "gift", subjectId: recipient.public_id });
    if (!allowed) return { status: 403, error: "closed" };
  }
  if (item.kind === "gift") {
    const gift = giftById(item.id);
    if (gift && gift.category === "birthday" && !(await birthdayGiftAllowed(env, viewer.public_id, recipient.public_id, Date.now()))) return { status: 403, error: "birthday" };
  }
  return null;
}

/* Shared checks for both ways to pay. */
async function prepare(env, viewer, body, deps) {
  const kind = body.kind === "stickers" || body.kind === "emoji" ? body.kind : "gift";
  const item = storeItem(kind, String(body.itemId || ""));
  if (!item) return { fail: { status: 400, error: "item" } };
  const limited = limitedById(item.id);
  if (limited && !limitedOpen(limited)) return { fail: { status: 410, error: "ended" } };
  const handle = String(body.handle || "").replace(/^@/, "").trim();
  const recipient = handle ? await accountByHandle(env, handle) : viewer;
  const blocked = await checkRecipient(env, viewer, recipient, item);
  if (blocked) return { fail: blocked };
  if (recipient.public_id !== viewer.public_id) {
    const paced = await deps.rateHit(env, "gift-to:" + viewer.public_id + ":" + recipient.public_id, GIFTS_PER_RECIPIENT_DAY, DAY);
    if (!paced.ok) return { paced: paced };
  }
  if (kind === "stickers") {
    const owned = await ownedPacks(env, recipient.public_id);
    if (owned.indexOf(item.id) >= 0) return { fail: { status: 409, error: "owned" } };
  }
  if (kind === "emoji") {
    const owned = await ownedEmojis(env, recipient.public_id);
    if (owned.indexOf(item.id) >= 0) return { fail: { status: 409, error: "owned" } };
  }
  const privacy = body.privacy === "private" || body.privacy === "anonymous" ? body.privacy : "public";
  return { item: item, limited: limited, recipient: recipient, privacy: recipient.public_id === viewer.public_id ? "private" : privacy, message: cleanMessage(body.message) };
}

function editionStatements(env, limited) {
  if (!limited) return [];
  return [
    env.DB.prepare("INSERT INTO store_editions (item_id, sold) VALUES (?, 0) ON CONFLICT(item_id) DO NOTHING").bind(limited.id),
    env.DB.prepare("UPDATE store_editions SET sold = sold + 1 WHERE item_id = ? AND sold < ?").bind(limited.id, limited.limit),
    env.DB.prepare("INSERT INTO point_guard (kind, ok) SELECT 'edition', changes()")
  ];
}

function editionValue(limited) {
  return limited ? "(SELECT sold FROM store_editions WHERE item_id = ?)" : "0";
}

/* Statements that hand the item over: a gift on the profile or a sticker pack. */
function deliverStatements(env, order, now) {
  const out = [];
  if (order.kind === "gift") {
    out.push(env.DB.prepare(
      "INSERT INTO gift_sends (id, gift_id, sender_id, recipient_id, message, privacy, hidden, cost, context, post_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'direct', '', ?)"
    ).bind(order.sendId, order.itemId, order.buyerId, order.recipientId, order.message, order.privacy, order.method === "viktorychs" ? order.amount : 0, now));
    if (order.buyerId === order.recipientId) {
      out.push(env.DB.prepare("INSERT INTO gift_opens (send_id, opened_at) VALUES (?, ?) ON CONFLICT(send_id) DO NOTHING").bind(order.sendId, now));
    }
  } else {
    out.push(env.DB.prepare(
      "INSERT INTO store_entitlements (owner_id, pack_id, order_id, created_at) VALUES (?, ?, ?, ?)"
    ).bind(order.recipientId, order.kind === "emoji" ? emojiEntitlement(order.itemId) : order.itemId, order.id, now));
  }
  return out;
}

async function notifyRecipient(env, order, buyer, recipientHandle) {
  if (order.buyerId === order.recipientId) return;
  try {
    const named = order.privacy !== "anonymous";
    await emitNotification(env, {
      publicId: order.recipientId,
      kind: "gift",
      at: Date.now(),
      actorId: named ? order.buyerId : "",
      idempotencyKey: "store:" + order.id,
      handle: named ? buyer.handle || "" : "",
      name: named ? buyer.display_name || "" : "",
      text: String(order.message || "").slice(0, 140),
      hash: order.kind === "stickers" ? "#/store/stickers" : order.kind === "emoji" ? "#/store/emojis" : "#/@" + encodeURIComponent(recipientHandle || "") + "?tab=gifts",
      platform: "app"
    });
  } catch (err) { /* the item is already delivered */ }
}

function presentOrder(row, viewerId) {
  const item = storeItem(row.kind, row.item_id);
  const now = Date.now();
  const refundable = row.method === "money" && row.status === "paid" && row.kind === "gift" && row.buyer_id === viewerId &&
    row.recipient_id !== row.buyer_id && !row.opened_at && Number(row.paid_at) > now - REFUND_DAYS * DAY;
  return {
    id: row.id,
    kind: row.kind,
    itemId: row.item_id,
    base: item ? item.base : "",
    name: item ? item.name : row.item_id,
    method: row.method,
    amount: Number(row.amount) || 0,
    currency: row.currency || "",
    status: row.status,
    edition: Number(row.edition) || 0,
    toSelf: row.recipient_id === row.buyer_id,
    recipient: row.recipient_id === row.buyer_id ? null : { handle: row.recipient_handle || "", name: row.recipient_name || "" },
    opened: !!row.opened_at,
    refundable: refundable,
    refundUntil: row.method === "money" && Number(row.paid_at) ? Number(row.paid_at) + REFUND_DAYS * DAY : 0,
    at: Number(row.created_at) || 0
  };
}

async function loadOrder(env, id) {
  return env.DB.prepare(
    "SELECT so.*, o.opened_at FROM store_orders so LEFT JOIN gift_opens o ON o.send_id = so.gift_send_id WHERE so.id = ?"
  ).bind(id).first();
}

/* Money order paid: deliver once. Safe to call again for the same order. */
async function fulfil(env, orderId, paymentRef) {
  const row = await env.DB.prepare("SELECT * FROM store_orders WHERE id = ?").bind(orderId).first();
  if (!row || row.status !== "pending") return { ok: !!row, already: true };
  const now = Date.now();
  const sendId = row.kind === "gift" ? newId() : "";
  const order = { id: row.id, kind: row.kind, itemId: row.item_id, buyerId: row.buyer_id, recipientId: row.recipient_id, message: row.message, privacy: row.privacy, method: "money", amount: 0, sendId: sendId };
  const claim = await env.DB.prepare(
    "UPDATE store_orders SET status = 'paid', paid_at = ?, payment_ref = ?, gift_send_id = ? WHERE id = ? AND status = 'pending'"
  ).bind(now, String(paymentRef || ""), sendId, row.id).run();
  if (!(claim && claim.meta && claim.meta.changes)) return { ok: true, already: true };
  try { await env.DB.batch(deliverStatements(env, order, now)); }
  catch (err) {
    if (!/UNIQUE/i.test(String(err && err.message || err))) throw err;
    /* The recipient already owned that pack: keep the payment on record for a refund by hand. */
  }
  const buyer = await env.DB.prepare("SELECT handle, display_name FROM accounts WHERE public_id = ?").bind(row.buyer_id).first();
  const recipient = await env.DB.prepare("SELECT handle FROM accounts WHERE public_id = ?").bind(row.recipient_id).first();
  await tallyBadges(env, row.recipient_id);
  await notifyRecipient(env, order, buyer || {}, recipient && recipient.handle);
  return { ok: true };
}

async function expire(env, orderId) {
  const row = await env.DB.prepare("SELECT * FROM store_orders WHERE id = ?").bind(orderId).first();
  if (!row || row.status !== "pending") return;
  const done = await env.DB.prepare("UPDATE store_orders SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(orderId).run();
  if (done && done.meta && done.meta.changes && limitedById(row.item_id)) {
    await env.DB.prepare("UPDATE store_editions SET sold = sold - 1 WHERE item_id = ? AND sold > 0").bind(row.item_id).run();
  }
}

async function markRefunded(env, row, now) {
  const done = await env.DB.prepare(
    "UPDATE store_orders SET status = 'refunded', refunded_at = ? WHERE id = ? AND status = 'paid'"
  ).bind(now, row.id).run();
  if (!(done && done.meta && done.meta.changes)) return false;
  if (row.kind === "gift" && row.gift_send_id) await env.DB.prepare("DELETE FROM gift_sends WHERE id = ?").bind(row.gift_send_id).run();
  if (row.kind === "stickers") await env.DB.prepare("DELETE FROM store_entitlements WHERE owner_id = ? AND pack_id = ? AND order_id = ?").bind(row.recipient_id, row.item_id, row.id).run();
  return true;
}

function returnBase(body, deps, env) {
  const raw = String(body.returnUrl || "");
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && deps.originAllowed && deps.originAllowed(env, url.origin)) return url.origin + url.pathname;
  } catch (err) { /* fall through */ }
  return "https://viktorychgroup.github.io/ViktorychApp/";
}

export function catalogBody(env, sold, owned, emojis) {
  const payments = paymentsInfo(env);
  return {
    payments: { enabled: payments.enabled, providers: payments.providers, currency: CURRENCY },
    tiers: TIERS,
    refundDays: REFUND_DAYS,
    gifts: GIFTS.map((gift) => {
      const item = storeItem("gift", gift.id);
      return { id: gift.id, tier: item.tier, cents: item.cents, viktorychs: item.viktorychs };
    }),
    limited: LIMITED.map((item) => ({ id: item.id, base: item.base, name: item.name, tier: item.tier, cents: TIERS[item.tier].cents, viktorychs: item.viktorychs, limit: item.limit, sold: sold[item.id] || 0, until: item.until, open: limitedOpen(item) })),
    stickers: STICKER_PACKS.map((pack) => ({ id: pack.id, name: pack.name, tier: pack.tier, cents: TIERS[pack.tier].cents, viktorychs: pack.viktorychs, items: pack.items, owned: owned ? owned.indexOf(pack.id) >= 0 : pack.tier === "free" })),
    emojis: STATUS_EMOJIS.map((item) => ({ id: item.id, emoji: item.emoji, name: item.name, tier: item.tier, viktorychs: item.viktorychs, popular: !!item.popular, fresh: !!item.fresh, owned: !!(emojis && emojis.indexOf(item.id) >= 0) }))
  };
}

export async function handleStore(request, env, path, deps) {
  if (path === "/v1/pay/webhook/stripe" && request.method === "POST") {
    if (!PROVIDERS.stripe.ready(env)) return deps.json(404, { error: "not_found" });
    const payload = await request.text();
    if (payload.length > 200000) return deps.json(413, { error: "too_large" });
    if (!(await verifyStripe(env, request.headers.get("stripe-signature"), payload))) return deps.json(400, { error: "signature" });
    let event = null;
    try { event = JSON.parse(payload); } catch (err) { return deps.json(400, { error: "body" }); }
    const parsed = PROVIDERS.stripe.parse(event);
    if (!ORDER_ID.test(parsed.orderId)) return deps.json(200, { received: true });
    if (parsed.type === "paid") await fulfil(env, parsed.orderId, parsed.paymentRef);
    else if (parsed.type === "expired") await expire(env, parsed.orderId);
    else if (parsed.type === "refunded") {
      const row = await env.DB.prepare("SELECT * FROM store_orders WHERE id = ?").bind(parsed.orderId).first();
      if (row) await markRefunded(env, row, Date.now());
    }
    return deps.json(200, { received: true });
  }

  const viewer = await deps.sessionAccount(env, request);
  if (path === "/v1/store/catalog" && request.method === "GET") {
    const owned = viewer ? await ownedPacks(env, viewer.public_id) : null;
    const emojis = viewer ? await ownedEmojis(env, viewer.public_id) : null;
    const body = catalogBody(env, await editionsSold(env), owned, emojis);
    if (viewer) {
      body.balance = await balanceOf(env, viewer.public_id);
      body.owner = viewer.owner === 1;
    }
    return deps.json(200, body);
  }
  if (!viewer) return deps.json(401, { error: "unauthorized" });

  if (path === "/v1/store/orders" && request.method === "GET") {
    const listed = await env.DB.prepare(
      "SELECT so.*, o.opened_at, a.handle AS recipient_handle, a.display_name AS recipient_name FROM store_orders so LEFT JOIN gift_opens o ON o.send_id = so.gift_send_id LEFT JOIN accounts a ON a.public_id = so.recipient_id WHERE so.buyer_id = ? AND so.status <> 'expired' ORDER BY so.created_at DESC LIMIT 60"
    ).bind(viewer.public_id).all();
    return deps.json(200, { orders: rowsOf(listed).map((row) => presentOrder(row, viewer.public_id)) });
  }

  if (path === "/v1/store/buy" && request.method === "POST") {
    const paced = await deps.rateHit(env, "store-buy:" + viewer.public_id, 30, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 4000);
    if (body.error) return deps.json(400, { error: body.error });
    const ready = await prepare(env, viewer, body, deps);
    if (ready.paced) return deps.limited(ready.paced);
    if (ready.fail) return deps.json(ready.fail.status, { error: ready.fail.error });
    const item = ready.item;
    const free = item.tier === "free";
    if (!free && !(item.viktorychs > 0)) return deps.json(400, { error: "money_only" });
    if (free && item.kind === "gift") return deps.json(400, { error: "use_gift_sheet" });
    const now = Date.now();
    const order = { id: newId(), kind: item.kind, itemId: item.id, buyerId: viewer.public_id, recipientId: ready.recipient.public_id, message: ready.message, privacy: ready.privacy, method: free ? "free" : "viktorychs", amount: free ? 0 : item.viktorychs, sendId: item.kind === "gift" ? newId() : "" };
    const insertOrder = env.DB.prepare(
      "INSERT INTO store_orders (id, buyer_id, recipient_id, kind, item_id, method, amount, currency, status, edition, gift_send_id, message, privacy, created_at, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'viktorychs', 'paid', " + editionValue(ready.limited) + ", ?, ?, ?, ?, ?)"
    );
    const orderArgs = [order.id, order.buyerId, order.recipientId, order.kind, order.itemId, order.method, order.amount].concat(ready.limited ? [ready.limited.id] : [], [order.sendId, order.message, order.privacy, now, now]);
    const statements = editionStatements(env, ready.limited)
      .concat(free ? [] : spendStatements(env, viewer.public_id, item.viktorychs, item.kind === "gift" ? "gift" : item.kind === "emoji" ? "status_emoji" : "stickers", order.id, now))
      .concat([insertOrder.bind.apply(insertOrder, orderArgs)], deliverStatements(env, order, now), [env.DB.prepare("DELETE FROM point_guard")]);
    try { await env.DB.batch(statements); }
    catch (err) {
      const why = guardFailure(err);
      if (why) return deps.json(why === "balance" ? 402 : 409, { error: why, balance: await balanceOf(env, viewer.public_id) });
      if (/UNIQUE/i.test(String(err && err.message || err))) return deps.json(409, { error: "owned" });
      throw err;
    }
    await tallyBadges(env, viewer.public_id);
    await notifyRecipient(env, order, viewer, ready.recipient.handle);
    const saved = await env.DB.prepare("SELECT edition FROM store_orders WHERE id = ?").bind(order.id).first();
    return deps.json(201, { id: order.id, balance: await balanceOf(env, viewer.public_id), edition: Number(saved && saved.edition) || 0, sendId: order.sendId });
  }

  if (path === "/v1/store/checkout" && request.method === "POST") {
    const paced = await deps.rateHit(env, "store-pay:" + viewer.public_id, 10, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 4000);
    if (body.error) return deps.json(400, { error: body.error });
    const provider = paymentProvider(env, String(body.provider || ""));
    if (!provider) return deps.json(503, { error: "payments_off" });
    if (body.accept !== true) return deps.json(400, { error: "terms" });
    const ready = await prepare(env, viewer, body, deps);
    if (ready.paced) return deps.limited(ready.paced);
    if (ready.fail) return deps.json(ready.fail.status, { error: ready.fail.error });
    const item = ready.item;
    if (!(item.cents > 0)) return deps.json(400, { error: "free_item" });
    const now = Date.now();
    const id = newId();
    const insertOrder = env.DB.prepare(
      "INSERT INTO store_orders (id, buyer_id, recipient_id, kind, item_id, method, amount, currency, status, provider, edition, message, privacy, created_at) VALUES (?, ?, ?, ?, ?, 'money', ?, ?, 'pending', ?, " + editionValue(ready.limited) + ", ?, ?, ?)"
    );
    const args = [id, viewer.public_id, ready.recipient.public_id, item.kind, item.id, item.cents, CURRENCY, provider.id].concat(ready.limited ? [ready.limited.id] : [], [ready.message, ready.privacy, now]);
    try {
      await env.DB.batch(editionStatements(env, ready.limited).concat([insertOrder.bind.apply(insertOrder, args), env.DB.prepare("DELETE FROM point_guard")]));
    } catch (err) {
      if (guardFailure(err) === "sold_out") return deps.json(409, { error: "sold_out" });
      throw err;
    }
    const base = returnBase(body, deps, env);
    let session;
    try {
      session = await provider.createCheckout(env, {
        orderId: id,
        cents: item.cents,
        currency: CURRENCY,
        name: itemName(item),
        successUrl: base + "#/store/orders?paid=" + id,
        cancelUrl: base + "#/store?cancelled=" + id,
        termsNote: "Items only. No cash value, no resale. Unopened gifts can be refunded within " + REFUND_DAYS + " days. Terms: " + base + "#/store/terms"
      });
    } catch (err) {
      await expire(env, id);
      if (err && err.provider) return deps.json(502, { error: "provider" });
      throw err;
    }
    await env.DB.prepare("UPDATE store_orders SET provider_ref = ? WHERE id = ?").bind(session.ref, id).run();
    return deps.json(201, { id: id, url: session.url });
  }

  const refund = path.match(/^\/v1\/store\/orders\/([a-f0-9]{32})\/refund$/);
  if (refund && request.method === "POST") {
    const paced = await deps.rateHit(env, "store-refund:" + viewer.public_id, 10, DAY);
    if (!paced.ok) return deps.limited(paced);
    const row = await loadOrder(env, refund[1]);
    if (!row || row.buyer_id !== viewer.public_id) return deps.json(404, { error: "not_found" });
    const shown = presentOrder(row, viewer.public_id);
    if (!shown.refundable) return deps.json(409, { error: row.opened_at ? "opened" : "not_refundable" });
    const provider = PROVIDERS[row.provider];
    if (!provider || !provider.ready(env)) return deps.json(503, { error: "payments_off" });
    try { await provider.refund(env, row.payment_ref, row.id); }
    catch (err) {
      if (err && err.provider) return deps.json(502, { error: "provider" });
      throw err;
    }
    await markRefunded(env, row, Date.now());
    return deps.json(200, { ok: true });
  }

  const open = path.match(/^\/v1\/store\/gifts\/([a-f0-9]{32})\/open$/);
  if (open && request.method === "POST") {
    const row = await env.DB.prepare("SELECT id, recipient_id FROM gift_sends WHERE id = ?").bind(open[1]).first();
    if (!row || row.recipient_id !== viewer.public_id) return deps.json(404, { error: "not_found" });
    await env.DB.prepare("INSERT INTO gift_opens (send_id, opened_at) VALUES (?, ?) ON CONFLICT(send_id) DO NOTHING").bind(row.id, Date.now()).run();
    return deps.json(200, { opened: true });
  }

  /* Owner tools: grant Viktorychs, or grant a test item without paying. */
  if (path === "/v1/viktorychs/grant" && request.method === "POST") {
    if (viewer.owner !== 1) return deps.json(403, { error: "forbidden" });
    const body = await deps.readJson(request, 2000);
    if (body.error) return deps.json(400, { error: body.error });
    const amount = Math.floor(Number(body.amount) || 0);
    if (amount < 1 || amount > 100000) return deps.json(400, { error: "amount" });
    const target = body.handle ? await accountByHandle(env, body.handle) : viewer;
    if (!target) return deps.json(404, { error: "not_found" });
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO point_ledger (id, public_id, delta, reason, ref, created_at) VALUES (?, ?, ?, 'grant', ?, ?)").bind(newId(), target.public_id, amount, newId(), now),
      env.DB.prepare("INSERT INTO point_balances (public_id, balance, updated_at) VALUES (?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at").bind(target.public_id, amount, now)
    ]);
    return deps.json(200, { ok: true, balance: target.public_id === viewer.public_id ? await balanceOf(env, viewer.public_id) : undefined });
  }
  if (path === "/v1/store/grant" && request.method === "POST") {
    if (viewer.owner !== 1) return deps.json(403, { error: "forbidden" });
    const body = await deps.readJson(request, 2000);
    if (body.error) return deps.json(400, { error: body.error });
    const kind = body.kind === "stickers" || body.kind === "emoji" ? body.kind : "gift";
    const item = storeItem(kind, String(body.itemId || ""));
    if (!item) return deps.json(400, { error: "item" });
    const target = body.handle ? await accountByHandle(env, body.handle) : viewer;
    if (!target) return deps.json(404, { error: "not_found" });
    const now = Date.now();
    const order = { id: newId(), kind: kind, itemId: item.id, buyerId: viewer.public_id, recipientId: target.public_id, message: "", privacy: "anonymous", method: "grant", amount: 0, sendId: kind === "gift" ? newId() : "" };
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO store_orders (id, buyer_id, recipient_id, kind, item_id, method, amount, currency, status, gift_send_id, privacy, created_at, paid_at) VALUES (?, ?, ?, ?, ?, 'grant', 0, '', 'paid', ?, 'anonymous', ?, ?)").bind(order.id, order.buyerId, order.recipientId, kind, item.id, order.sendId, now, now)
      ].concat(deliverStatements(env, order, now)));
    } catch (err) {
      if (/UNIQUE/i.test(String(err && err.message || err))) return deps.json(409, { error: "owned" });
      throw err;
    }
    return deps.json(201, { id: order.id });
  }
  return null;
}

export { fulfil as fulfilOrder, giftTier };
