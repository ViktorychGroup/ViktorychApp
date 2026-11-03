/* Mention rows are written in the same batch as the post.
   Delivery sits in an outbox so a failed push can be retried without
   losing the mention. Bios never come through here. */

import { friendshipLive } from "./friends-pref.js";
import { extractMentions } from "../../shared/mentions.js";
import { resolveName } from "./usernames.js";
import { canMention } from "./name-rules.js";
import { ensureNotificationSchema, finishDeliveries, planNotification } from "./notifications.js";

export const MENTION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS account_content (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    parent_id TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS account_content_author ON account_content(author_id, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS mentions (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    author_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, target_id)
  )`,
  "CREATE INDEX IF NOT EXISTS mentions_target ON mentions(target_id, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS account_blocks (
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  )`,
  `CREATE TABLE IF NOT EXISTS account_mutes (
    muter_id TEXT NOT NULL,
    muted_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (muter_id, muted_id)
  )`
];

const KINDS = { post: 1, reply: 1, quote: 1, dm: 1 };
let ready = null;

function clip(value, max) {
  return String(value == null ? "" : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, max);
}

function cleanText(value) {
  const text = clip(value, 2000).trim();
  if (!text || Array.from(text).length > 1000) return "";
  return text;
}

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return "ct_" + hex;
}

export function ensureMentionSchema(env) {
  if (!env || !env.DB) return Promise.resolve();
  if (!ready) {
    ready = ensureNotificationSchema(env).then(() => env.DB.batch(MENTION_SCHEMA.map((sql) => env.DB.prepare(sql)))).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

async function blockedOrMuted(env, actorId, targetId) {
  const blocked = await env.DB.prepare(
    "SELECT blocker_id FROM account_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1"
  ).bind(actorId, targetId, targetId, actorId).first();
  if (blocked) return true;
  const muted = await env.DB.prepare(
    "SELECT muter_id FROM account_mutes WHERE muter_id = ? AND muted_id = ?"
  ).bind(targetId, actorId).first();
  return !!muted;
}

async function privateAllows(env, actorId, target) {
  if (!target || Number(target.protected_account) !== 1) return true;
  const friend = await env.DB.prepare(
    "SELECT user_id FROM account_friends WHERE user_id = ? AND friend_id = ?"
  ).bind(target.public_id, actorId).first();
  if (friend && await friendshipLive(env, target.public_id, actorId)) return true;
  const follow = await env.DB.prepare(
    "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?"
  ).bind(target.public_id, "app:" + actorId).first();
  return !!follow;
}

export async function planMentions(env, opts) {
  await ensureMentionSchema(env);
  const actor = opts && opts.actor;
  const sourceId = clip(opts && opts.sourceId, 160);
  const kind = KINDS[opts && opts.kind] ? opts.kind : "post";
  if (!actor || !/^\d{12}$/.test(String(actor.public_id || "")) || !sourceId) {
    return { statements: [], deliveries: [], targets: [] };
  }
  const found = extractMentions(opts.text).slice(0, 10);
  const seen = {};
  (opts.exceptIds || []).forEach((id) => { if (id) seen[id] = true; });
  seen[actor.public_id] = true;
  const statements = [];
  const deliveries = [];
  const targets = [];
  const now = opts.at || Date.now();
  for (let i = 0; i < found.length; i++) {
    const named = await resolveName(env, found[i].handle, actor.public_id);
    const account = named ? await env.DB.prepare(
      "SELECT public_id, handle, protected_account FROM accounts WHERE public_id = ?"
    ).bind(named.publicId).first() : null;
    if (!account || seen[account.public_id]) continue;
    seen[account.public_id] = true;
    if (await blockedOrMuted(env, actor.public_id, account.public_id)) continue;
    if (!(await privateAllows(env, actor.public_id, account))) continue;
    if (!(await canMention(env, account.public_id, actor.public_id, { replyTo: opts.replyTo || "" }))) continue;
    targets.push(account.public_id);
    statements.push(env.DB.prepare(
      "INSERT INTO mentions (source_id, target_id, source_kind, author_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_id, target_id) DO NOTHING"
    ).bind(sourceId, account.public_id, kind, actor.public_id, now));
    const planned = await planNotification(env, {
      publicId: account.public_id,
      kind: "mention",
      at: now,
      actorId: actor.public_id,
      idempotencyKey: "mention:" + sourceId + ":" + account.public_id,
      handle: actor.handle,
      name: actor.display_name || actor.displayName || actor.handle,
      text: clip(opts.text, 180),
      hash: opts.hash || "#/",
      platform: "app",
      feedId: actor.handle ? "app:@" + actor.handle : "",
      mention: true
    });
    if (planned && planned.statements) planned.statements.forEach((statement) => statements.push(statement));
    if (planned && planned.deliveries) planned.deliveries.forEach((delivery) => deliveries.push(delivery));
  }
  return { statements, deliveries, targets };
}

export async function commitBundled(env, statements, deliveries, request) {
  const list = (statements || []).filter(Boolean);
  if (list.length) await env.DB.batch(list);
  await finishDeliveries(env, deliveries || [], request);
}

function actorOf(row) {
  return { public_id: row.public_id, handle: row.handle, display_name: row.display_name };
}

export async function handleContentRoutes(request, env, path, deps) {
  const { json, sessionAccount, readJson, rateHit, limited } = deps;
  if (path !== "/v1/content" && !path.startsWith("/v1/content/")) return null;
  await ensureMentionSchema(env);
  const row = await sessionAccount(env, request);
  if (!row) return json(401, { error: "unauthorized" });
  const hit = await rateHit(env, "content:" + row.public_id, 40, 10 * 60 * 1000);
  if (!hit.ok) return limited(hit);
  if (path === "/v1/content" && request.method === "POST") {
    const body = await readJson(request, 8000);
    if (body.error) return json(body.error === "too_large" ? 413 : 400, { error: body.error });
    const kind = KINDS[body.kind] ? body.kind : "";
    let text = cleanText(body.text || body.body || "");
    if (text.indexOf("[[sticker:") >= 0) {
      const store = await import("./store.js");
      text = cleanText(await store.keepOwnedStickers(env, row.public_id, text));
    }
    if (!kind || !text) return json(400, { error: "bad_post" });
    let id = String(body.id || "");
    if (id && !/^ct_[a-f0-9]{16}$/.test(id)) return json(400, { error: "bad_post" });
    if (!id) id = newId();
    const existing = await env.DB.prepare("SELECT author_id FROM account_content WHERE id = ?").bind(id).first();
    if (existing) {
      if (existing.author_id !== row.public_id) return json(403, { error: "forbidden" });
      return json(200, { id, created: false });
    }
    const parent = clip(body.parentId || "", 80);
    const now = Date.now();
    let replyTo = "";
    if (parent) {
      try {
        const up = await env.DB.prepare("SELECT author_id FROM account_content WHERE id = ?").bind(parent).first();
        replyTo = up && up.author_id ? up.author_id : (/^\d{12}$/.test(parent) ? parent : "");
      } catch (err) { replyTo = ""; }
    }
    const planned = await planMentions(env, {
      actor: actorOf(row),
      sourceId: id,
      kind,
      replyTo,
      text,
      at: now,
      hash: "#/" + encodeURIComponent(row.handle || "")
    });
    const statements = [
      env.DB.prepare(
        "INSERT INTO account_content (id, author_id, kind, parent_id, body, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)"
      ).bind(id, row.public_id, kind, parent, text, now, now)
    ].concat(planned.statements);
    try {
      const points = await import("./points.js");
      await points.awardActivity(env, row.public_id, kind === "reply" || kind === "comment" ? "comment" : "post", id);
      if ((kind === "reply" || kind === "comment") && parent && parent !== row.public_id) {
        const parentRow = await env.DB.prepare("SELECT author_id FROM account_content WHERE id = ?").bind(parent).first();
        if (parentRow && parentRow.author_id && parentRow.author_id !== row.public_id) {
          await points.awardActivity(env, parentRow.author_id, "reply_in", id);
        }
      }
    } catch (err) { /* the post is saved */ }
    const deliveries = planned.deliveries.slice();
    if (kind === "dm" && /^\d{12}$/.test(parent) && parent !== row.public_id && planned.targets.indexOf(parent) < 0) {
      const target = await env.DB.prepare("SELECT public_id, protected_account FROM accounts WHERE public_id = ?").bind(parent).first();
      if (target && !(await blockedOrMuted(env, row.public_id, parent)) && await privateAllows(env, row.public_id, target)) {
        const note = await planNotification(env, {
          publicId: parent,
          kind: "dm",
          at: now,
          actorId: row.public_id,
          idempotencyKey: "dm:" + id,
          handle: row.handle,
          name: row.display_name,
          text: clip(text, 180),
          hash: "#/messages",
          platform: "app",
          feedId: row.handle ? "app:@" + row.handle : ""
        });
        if (note && note.statements) note.statements.forEach((statement) => statements.push(statement));
        if (note && note.deliveries) note.deliveries.forEach((delivery) => deliveries.push(delivery));
      }
    }
    await commitBundled(env, statements, deliveries, request);
    return json(200, { id, created: true, mentions: planned.targets.length });
  }
  const edit = path.match(/^\/v1\/content\/(ct_[a-f0-9]{16})$/);
  if (edit && request.method === "PATCH") {
    const body = await readJson(request, 8000);
    if (body.error) return json(400, { error: body.error });
    let text = cleanText(body.text || body.body || "");
    if (text.indexOf("[[sticker:") >= 0) {
      const store = await import("./store.js");
      text = cleanText(await store.keepOwnedStickers(env, row.public_id, text));
    }
    if (!text) return json(400, { error: "bad_post" });
    const id = edit[1];
    const existing = await env.DB.prepare(
      "SELECT author_id, kind FROM account_content WHERE id = ? AND deleted_at = 0"
    ).bind(id).first();
    if (!existing) return json(404, { error: "not_found" });
    if (existing.author_id !== row.public_id) return json(403, { error: "forbidden" });
    const now = Date.now();
    const planned = await planMentions(env, {
      actor: actorOf(row),
      sourceId: id,
      kind: existing.kind,
      text,
      at: now,
      hash: "#/" + encodeURIComponent(row.handle || "")
    });
    const drop = planned.targets.length
      ? "DELETE FROM mentions WHERE source_id = ? AND target_id NOT IN (" + planned.targets.map(() => "?").join(",") + ")"
      : "DELETE FROM mentions WHERE source_id = ?";
    const statements = [
      env.DB.prepare("UPDATE account_content SET body = ?, updated_at = ? WHERE id = ?").bind(text, now, id),
      env.DB.prepare(drop).bind(...(planned.targets.length ? [id].concat(planned.targets) : [id]))
    ].concat(planned.statements);
    await commitBundled(env, statements, planned.deliveries, request);
    return json(200, { id, edited: true, mentions: planned.targets.length });
  }
  return null;
}

function cleanPeer(value) {
  const id = String(value || "");
  return /^\d{12}$/.test(id) ? id : "";
}

export async function handleBlockMuteRoutes(request, env, path, deps) {
  if (path !== "/v1/blocks" && path !== "/v1/mutes") return null;
  const { json, sessionAccount, readJson, rateHit, limited } = deps;
  await ensureMentionSchema(env);
  const row = await sessionAccount(env, request);
  if (!row) return json(401, { error: "unauthorized" });
  if (request.method !== "PUT" && request.method !== "DELETE") return json(405, { error: "method" });
  const hit = await rateHit(env, "graph:" + row.public_id, 40, 10 * 60 * 1000);
  if (!hit.ok) return limited(hit);
  const body = await readJson(request, 2000);
  if (body.error) return json(400, { error: body.error });
  const peer = cleanPeer(body.id || body.publicId || body.accountId);
  if (!peer || peer === row.public_id) return json(400, { error: "bad_account" });
  const known = await env.DB.prepare("SELECT public_id FROM accounts WHERE public_id = ?").bind(peer).first();
  if (!known) return json(404, { error: "not_found" });
  const now = Date.now();
  if (path === "/v1/blocks") {
    if (request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM account_blocks WHERE blocker_id = ? AND blocked_id = ?").bind(row.public_id, peer).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO account_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?) ON CONFLICT(blocker_id, blocked_id) DO NOTHING"
      ).bind(row.public_id, peer, now).run();
    }
    return json(200, { ok: true });
  }
  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM account_mutes WHERE muter_id = ? AND muted_id = ?").bind(row.public_id, peer).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO account_mutes (muter_id, muted_id, created_at) VALUES (?, ?, ?) ON CONFLICT(muter_id, muted_id) DO NOTHING"
    ).bind(row.public_id, peer, now).run();
  }
  return json(200, { ok: true });
}
