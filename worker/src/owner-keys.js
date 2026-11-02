/* Owner-only connected keys. Plaintext exists only in memory while a
   request is handled. Responses list a mask and a status, never the value.
   A service can store several keys. Jobs read the highest-priority healthy
   one. The next key is used only after that one is expired or signed out. */

import {
  SLOTS,
  slotById,
  maskSecret,
  sanitizeError,
  attentionReason,
  ADVANCE,
  HOLD,
  expiryState,
  parseMaterial,
  encryptMaterial,
  decryptMaterial
} from "../../shared/owner-keys.js";

export const KEYS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS owner_keys (
    owner_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    kind TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    mask TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_used INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    tested_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, slot)
  )`,
  `CREATE TABLE IF NOT EXISTS owner_key_items (
    owner_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    mask TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_used INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    tested_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, key_id)
  )`,
  "CREATE INDEX IF NOT EXISTS owner_key_items_slot ON owner_key_items (owner_id, slot, position)",
  `CREATE TABLE IF NOT EXISTS owner_key_pace (
    owner_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    until_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, slot)
  )`
];

const PROBES = {
  tiktok: "https://www.tiktok.com/",
  youtube: "https://www.youtube.com/",
  instagram: "https://www.instagram.com/",
  threads: "https://www.threads.net/",
  vk: "https://vk.com/",
  x: "https://x.com/",
  reddit: "https://www.reddit.com/api/v1/access_token",
  discord: "https://discord.com/api/v10/users/@me"
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_KEYS = 8;
const PACE_MS = 15 * 60 * 1000;

function bearer(request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1].trim() : "";
}

function jobOk(env, request, timingEqual) {
  const expected = String(env.GITHUB_DISPATCH_TOKEN || "").trim();
  const got = bearer(request);
  if (!expected || !got) return false;
  return timingEqual(expected, got);
}

function displayStatus(row, now) {
  if (!row) return "empty";
  if (expiryState(row.expires_at, now) === "expired") return "expired";
  const status = String(row.status || "unknown");
  if (status === "working" || status === "expired" || status === "needs_attention" || status === "unknown") return status;
  return "unknown";
}

function healthy(row, now) {
  if (!row) return false;
  const status = displayStatus(row, now);
  return status === "unknown" || status === "working";
}

function cleanLabel(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
}

function cleanKeyId(value) {
  const id = String(value || "");
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : "";
}

function newKeyId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return "k" + hex;
}

function rowsOf(result) {
  return result && result.results ? result.results : [];
}

async function ownerRow(env, request, deps) {
  const row = await deps.sessionAccount(env, request);
  if (!row) return { error: deps.json(401, { error: "unauthorized" }) };
  if (row.owner !== 1) return { error: deps.json(403, { error: "forbidden" }) };
  return { row };
}

async function ownerIdOf(env) {
  const row = await env.DB.prepare("SELECT public_id FROM accounts WHERE owner = 1").first();
  return row && row.public_id ? String(row.public_id) : "";
}

async function loadSlotKeys(env, ownerId, slot) {
  const result = await env.DB.prepare(
    `SELECT key_id, slot, kind, label, position, ciphertext, iv, mask, status, last_used, last_error, expires_at, updated_at, tested_at
     FROM owner_key_items WHERE owner_id = ? AND slot = ? ORDER BY position ASC, updated_at ASC`
  ).bind(ownerId, slot).all();
  return rowsOf(result);
}

async function loadAllKeys(env, ownerId) {
  const result = await env.DB.prepare(
    `SELECT key_id, slot, kind, label, position, ciphertext, iv, mask, status, last_used, last_error, expires_at, updated_at, tested_at
     FROM owner_key_items WHERE owner_id = ? ORDER BY slot ASC, position ASC, updated_at ASC`
  ).bind(ownerId).all();
  return rowsOf(result);
}

async function loadPace(env, ownerId) {
  const result = await env.DB.prepare(
    "SELECT slot, reason, until_at, updated_at FROM owner_key_pace WHERE owner_id = ?"
  ).bind(ownerId).all();
  const map = {};
  rowsOf(result).forEach((row) => { map[row.slot] = row; });
  return map;
}

function pacePublic(row, now) {
  if (!row) return null;
  const reason = sanitizeError(row.reason);
  if (!reason) return null;
  const untilAt = Number(row.until_at) || 0;
  if (untilAt > 0 && untilAt <= now) return null;
  return { reason: reason, untilAt: untilAt };
}

function publicKey(row, now) {
  return {
    id: row.key_id,
    name: String(row.label || ""),
    mask: maskSecret("saved"),
    status: displayStatus(row, now),
    lastUsed: Number(row.last_used) || 0,
    lastError: sanitizeError(row.last_error),
    position: Number(row.position) || 0,
    expiresAt: Number(row.expires_at) || 0,
    updatedAt: Number(row.updated_at) || 0
  };
}

function summaryRow(rows, now) {
  for (let i = 0; i < rows.length; i++) {
    if (healthy(rows[i], now)) return rows[i];
  }
  return rows[0] || null;
}

function publicSlot(spec, rows, paceRow, now) {
  const current = summaryRow(rows, now);
  return {
    id: spec.id,
    kind: spec.kind,
    label: spec.label,
    configured: rows.length > 0,
    mask: current ? maskSecret("saved") : "",
    status: current ? displayStatus(current, now) : "empty",
    lastUsed: current ? Number(current.last_used) || 0 : 0,
    lastError: current ? sanitizeError(current.last_error) : "",
    expiresAt: current ? Number(current.expires_at) || 0 : 0,
    updatedAt: current ? Number(current.updated_at) || 0 : 0,
    pace: pacePublic(paceRow, now),
    keys: rows.map((row) => publicKey(row, now))
  };
}

function alertsFor(slots) {
  const out = [];
  slots.forEach((slot) => {
    (slot.keys || []).forEach((key) => {
      if (key.status === "expired" || key.status === "needs_attention") {
        out.push({
          slot: slot.id,
          keyId: key.id,
          label: slot.label,
          status: key.status,
          updatedAt: key.updatedAt
        });
      }
    });
    if (slot.pace && slot.pace.reason) {
      out.push({
        slot: slot.id,
        label: slot.label,
        status: "slow",
        reason: slot.pace.reason,
        updatedAt: slot.pace.untilAt || 0
      });
    }
  });
  return out;
}

async function freshen(env, ownerId, rows, now) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (displayStatus(row, now) !== "expired" || row.status === "expired") continue;
    await env.DB.prepare(
      "UPDATE owner_key_items SET status = 'expired', last_error = 'expired', updated_at = ? WHERE owner_id = ? AND key_id = ?"
    ).bind(now, ownerId, row.key_id).run();
    row.status = "expired";
    row.last_error = "expired";
    row.updated_at = now;
  }
  return rows;
}

async function setPace(env, ownerId, slot, reason, now) {
  const code = sanitizeError(reason);
  if (!code) return;
  await env.DB.prepare(
    `INSERT INTO owner_key_pace (owner_id, slot, reason, until_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, slot) DO UPDATE SET
       reason = excluded.reason,
       until_at = excluded.until_at,
       updated_at = excluded.updated_at`
  ).bind(ownerId, slot, code, now + PACE_MS, now).run();
}

async function clearPace(env, ownerId, slot) {
  await env.DB.prepare("DELETE FROM owner_key_pace WHERE owner_id = ? AND slot = ?").bind(ownerId, slot).run();
}

async function writeKeyStatus(env, ownerId, keyId, status, error, now, touch) {
  const code = sanitizeError(error);
  if (touch) {
    await env.DB.prepare(
      "UPDATE owner_key_items SET status = ?, last_error = ?, tested_at = ?, updated_at = ?, last_used = ? WHERE owner_id = ? AND key_id = ?"
    ).bind(status, code, now, now, now, ownerId, keyId).run();
    return;
  }
  await env.DB.prepare(
    "UPDATE owner_key_items SET status = ?, last_error = ?, updated_at = ? WHERE owner_id = ? AND key_id = ?"
  ).bind(status, code, now, ownerId, keyId).run();
}

function pairOf(material) {
  try {
    const data = JSON.parse(String(material || ""));
    const id = String((data && data.clientId) || "").trim();
    const secret = String((data && data.clientSecret) || "").trim();
    if (!id || !secret) return null;
    return { clientId: id, clientSecret: secret };
  } catch (err) {
    return null;
  }
}

async function probe(spec, material) {
  let response = null;
  try {
    if (spec.kind === "cookie") {
      response = await fetch(PROBES[spec.id], {
        method: "GET",
        redirect: "manual",
        headers: { cookie: material, "user-agent": UA, accept: "text/html" }
      });
    } else if (spec.id === "reddit") {
      const pair = pairOf(material);
      if (!pair) return { status: "needs_attention", error: "bad_paste" };
      const basic = btoa(pair.clientId + ":" + pair.clientSecret);
      response = await fetch(PROBES.reddit, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: "Basic " + basic,
          "user-agent": "ViktorychApp/1.0",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: "grant_type=client_credentials"
      });
    } else if (spec.id === "discord") {
      const token = String(material || "");
      const header = token.indexOf("Bot ") === 0 || token.indexOf("Bearer ") === 0 ? token : token;
      response = await fetch(PROBES.discord, {
        method: "GET",
        redirect: "manual",
        headers: { authorization: header, "user-agent": UA, accept: "application/json" }
      });
    } else if (spec.id === "telegram") {
      const token = String(material || "");
      if (/[\s/?#]/.test(token)) return { status: "needs_attention", error: "bad_paste" };
      response = await fetch("https://api.telegram.org/bot" + token + "/getMe", {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": UA, accept: "application/json" }
      });
    } else {
      return { status: "unknown", error: "" };
    }
  } catch (err) {
    return { status: "unknown", error: "unreachable" };
  }
  let text = "";
  try { text = (await response.text()).slice(0, 20000); }
  catch (err) { text = ""; }
  const location = String(response.headers.get("location") || "");
  let reason = attentionReason(response.status, text + "\n" + location);
  if (!reason && response.status >= 300 && response.status < 400 && /captcha|challenge|checkpoint/i.test(location)) reason = "challenge";
  if (reason && ADVANCE[reason]) return { status: "needs_attention", error: reason };
  if (reason && HOLD[reason]) return { status: "hold", error: reason, pace: true };
  if (spec.id === "reddit") {
    if (response.status !== 200 || text.indexOf("access_token") < 0) return { status: "needs_attention", error: "unauthorized" };
    return { status: "working", error: "" };
  }
  if (spec.id === "telegram") {
    if (response.status !== 200 || text.indexOf("\"ok\":true") < 0 && text.indexOf("\"ok\": true") < 0) {
      const code = response.status === 401 ? "unauthorized" : "forbidden";
      if (HOLD[code]) return { status: "hold", error: code, pace: true };
      return { status: "needs_attention", error: code };
    }
    return { status: "working", error: "" };
  }
  if (response.status >= 200 && response.status < 400) return { status: "working", error: "" };
  return { status: "unknown", error: "unreachable" };
}

async function applyProbe(env, ownerId, spec, row, now) {
  if (displayStatus(row, now) === "expired") {
    await writeKeyStatus(env, ownerId, row.key_id, "expired", "expired", now, false);
    row.status = "expired";
    row.last_error = "expired";
    row.updated_at = now;
    return row;
  }
  const value = await decryptMaterial(env.KEYS_ENC_KEY, spec.id, row.iv, row.ciphertext);
  if (!value) {
    await writeKeyStatus(env, ownerId, row.key_id, "needs_attention", "unreadable", now, false);
    row.status = "needs_attention";
    row.last_error = "unreadable";
    row.updated_at = now;
    return row;
  }
  const result = await probe(spec, value);
  if (result.pace) {
    await env.DB.prepare(
      "UPDATE owner_key_items SET last_error = ?, tested_at = ?, last_used = ? WHERE owner_id = ? AND key_id = ?"
    ).bind(sanitizeError(result.error), now, now, ownerId, row.key_id).run();
    await setPace(env, ownerId, spec.id, result.error, now);
    row.last_error = sanitizeError(result.error);
    row.last_used = now;
    row.tested_at = now;
    return row;
  }
  await writeKeyStatus(env, ownerId, row.key_id, result.status, result.error, now, true);
  if (result.status === "working") await clearPace(env, ownerId, spec.id);
  row.status = result.status;
  row.last_error = sanitizeError(result.error);
  row.updated_at = now;
  row.last_used = now;
  return row;
}

async function takeActive(env, ownerId, spec, now) {
  const rows = await loadSlotKeys(env, ownerId, spec.id);
  await freshen(env, ownerId, rows, now);
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!healthy(row, now)) continue;
    const value = await decryptMaterial(env.KEYS_ENC_KEY, spec.id, row.iv, row.ciphertext);
    if (!value) {
      await writeKeyStatus(env, ownerId, row.key_id, "needs_attention", "unreadable", now, false);
      row.status = "needs_attention";
      failed += 1;
      if (failed >= 2) break;
      continue;
    }
    await env.DB.prepare(
      "UPDATE owner_key_items SET last_used = ? WHERE owner_id = ? AND key_id = ?"
    ).bind(now, ownerId, row.key_id).run();
    row.last_used = now;
    return { row: row, value: value, rows: rows };
  }
  return { row: null, value: "", rows: rows };
}

function absentCode(rows, now) {
  if (!rows.length) return 404;
  const allExpired = rows.every((row) => displayStatus(row, now) === "expired");
  if (allExpired) return 410;
  return 409;
}

export async function readUsableKey(env, slotId) {
  const spec = slotById(slotId);
  if (!spec || !env.DB || !String(env.KEYS_ENC_KEY || "").trim()) return null;
  const ownerId = await ownerIdOf(env);
  if (!ownerId) return null;
  const taken = await takeActive(env, ownerId, spec, Date.now());
  if (!taken.row) return null;
  return { slot: spec.id, keyId: taken.row.key_id, kind: spec.kind, value: taken.value };
}

export async function markKeyAttention(env, slotId, reason, keyId) {
  const spec = slotById(slotId);
  const code = sanitizeError(reason) || "forbidden";
  if (!spec || !env.DB) return { switched: false };
  const ownerId = await ownerIdOf(env);
  if (!ownerId) return { switched: false };
  const now = Date.now();
  const rows = await loadSlotKeys(env, ownerId, spec.id);
  await freshen(env, ownerId, rows, now);
  const wanted = cleanKeyId(keyId);
  let row = wanted ? rows.find((item) => item.key_id === wanted) || null : null;
  if (!row) row = summaryRow(rows, now);
  if (ADVANCE[code]) {
    if (!row) return { switched: false };
    const status = code === "expired" ? "expired" : "needs_attention";
    await writeKeyStatus(env, ownerId, row.key_id, status, code, now, false);
    return { switched: true };
  }
  if (row) {
    await env.DB.prepare(
      "UPDATE owner_key_items SET last_error = ? WHERE owner_id = ? AND key_id = ?"
    ).bind(code, ownerId, row.key_id).run();
  }
  if (HOLD[code]) await setPace(env, ownerId, spec.id, code, now);
  return { switched: false };
}

async function listKeys(env, ownerId) {
  const now = Date.now();
  const rows = await loadAllKeys(env, ownerId);
  await freshen(env, ownerId, rows, now);
  const pace = await loadPace(env, ownerId);
  const grouped = {};
  rows.forEach((row) => {
    if (!grouped[row.slot]) grouped[row.slot] = [];
    grouped[row.slot].push(row);
  });
  const slots = SLOTS.map((spec) => publicSlot(spec, grouped[spec.id] || [], pace[spec.id] || null, now));
  return { slots: slots, alerts: alertsFor(slots) };
}

/* Expired or signed-out keys for the watchdog. Labels and statuses only. */
export async function ownerKeyAlerts(env) {
  if (!env || !env.DB) return [];
  try {
    const ownerId = await ownerIdOf(env);
    if (!ownerId) return [];
    const listed = await listKeys(env, ownerId);
    return (listed.alerts || []).filter((row) => row.status === "expired" || row.status === "needs_attention")
      .map((row) => ({ slot: row.slot, label: row.label, status: row.status }));
  } catch (err) {
    return [];
  }
}

async function slotView(env, ownerId, spec) {
  const listed = await listKeys(env, ownerId);
  return listed.slots.find((slot) => slot.id === spec.id) || publicSlot(spec, [], null, Date.now());
}

function materialBody(spec, row, value) {
  const packed = { slot: spec.id, keyId: row.key_id, kind: spec.kind };
  if (spec.kind === "pair") {
    const pair = pairOf(value);
    if (!pair) return null;
    packed.clientId = pair.clientId;
    packed.clientSecret = pair.clientSecret;
    return packed;
  }
  packed.value = value;
  return packed;
}

/* The old single-slot table is copied once into owner_key_items. This runs
   on every isolate start, so it no longer asks sqlite_master (that read every
   schema row, about 420, on each cold start); the copy itself answers
   "no such table" when the old table is gone. */
export async function migrateOwnerKeys(env) {
  if (!env || !env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO owner_key_items (
        owner_id, key_id, slot, label, position, kind, ciphertext, iv, mask, status, last_used, last_error, expires_at, updated_at, tested_at
      )
      SELECT
        owner_id, 'legacy-' || slot, slot, '', 0, kind, ciphertext, iv, mask, status, last_used, last_error, expires_at, updated_at, tested_at
      FROM owner_keys
      WHERE NOT EXISTS (
        SELECT 1 FROM owner_key_items AS items
        WHERE items.owner_id = owner_keys.owner_id AND items.slot = owner_keys.slot
      )`
    ).run();
  } catch (err) {
    if (/no such table/i.test(String(err && err.message || err))) return;
    throw err;
  }
}

export async function handleOwnerKeys(request, env, path, deps) {
  const { json, readJson, rateHit, limited, timingEqual } = deps;
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "v1" || parts[1] !== "owner" || parts[2] !== "keys") return json(404, { error: "not_found" });
  const slotId = parts[3] ? decodeURIComponent(parts[3]) : "";
  const fourth = parts[4] ? decodeURIComponent(parts[4]) : "";
  const fifth = parts[5] ? decodeURIComponent(parts[5]) : "";
  const spec = slotId ? slotById(slotId) : null;

  if (fourth === "material" || fourth === "attention") {
    if (!spec || parts.length !== 5) return json(404, { error: "not_found" });
    if (!jobOk(env, request, timingEqual)) return json(401, { error: "unauthorized" });
    if (!env.DB) return json(503, { error: "not_configured" });
    const hit = await rateHit(env, "owner-keys-job:" + spec.id, 120, 10 * 60 * 1000);
    if (!hit.ok) return limited(hit);
    if (fourth === "attention") {
      if (request.method !== "POST") return json(405, { error: "method" });
      const body = await readJson(request, 2000);
      if (body && body.error === "bad_json") return json(400, { error: "bad_json" });
      const code = sanitizeError(body && body.error) || "forbidden";
      const marked = await markKeyAttention(env, spec.id, code, body && body.keyId);
      return json(200, {
        ok: true,
        switched: !!marked.switched,
        status: marked.switched ? (code === "expired" ? "expired" : "needs_attention") : "kept"
      });
    }
    if (request.method !== "GET") return json(405, { error: "method" });
    if (!String(env.KEYS_ENC_KEY || "").trim()) return json(503, { error: "not_configured" });
    const ownerId = await ownerIdOf(env);
    if (!ownerId) return json(404, { error: "not_found" });
    const now = Date.now();
    const taken = await takeActive(env, ownerId, spec, now);
    if (!taken.row) {
      const code = absentCode(taken.rows, now);
      const error = code === 410 ? "expired" : code === 404 ? "not_found" : "needs_attention";
      return json(code, { error: error });
    }
    const packed = materialBody(spec, taken.row, taken.value);
    if (!packed) {
      await writeKeyStatus(env, ownerId, taken.row.key_id, "needs_attention", "unreadable", now, false);
      return json(409, { error: "needs_attention" });
    }
    return json(200, packed);
  }

  const gate = await ownerRow(env, request, deps);
  if (gate.error) return gate.error;
  if (!env.DB) return json(503, { error: "not_configured" });
  const ownerId = gate.row.public_id;

  if (!slotId && request.method === "GET") {
    const hit = await rateHit(env, "owner-keys-list:" + ownerId, 60, 10 * 60 * 1000);
    if (!hit.ok) return limited(hit);
    const listed = await listKeys(env, ownerId);
    listed.ready = !!String(env.KEYS_ENC_KEY || "").trim();
    return json(200, listed);
  }
  if (!spec || parts.length > 6) return json(404, { error: "not_found" });

  if (request.method === "DELETE" && !fourth) {
    const hit = await rateHit(env, "owner-keys-delete:" + ownerId, 60, 60 * 60 * 1000);
    if (!hit.ok) return limited(hit);
    await env.DB.prepare("DELETE FROM owner_key_items WHERE owner_id = ? AND slot = ?").bind(ownerId, spec.id).run();
    await clearPace(env, ownerId, spec.id);
    return json(200, { ok: true, slot: await slotView(env, ownerId, spec) });
  }

  if (request.method === "DELETE" && fourth && !fifth) {
    const keyId = cleanKeyId(fourth);
    if (!keyId) return json(404, { error: "not_found" });
    const hit = await rateHit(env, "owner-keys-delete:" + ownerId, 60, 60 * 60 * 1000);
    if (!hit.ok) return limited(hit);
    const rows = await loadSlotKeys(env, ownerId, spec.id);
    if (!rows.some((row) => row.key_id === keyId)) return json(404, { error: "not_found" });
    await env.DB.prepare(
      "DELETE FROM owner_key_items WHERE owner_id = ? AND slot = ? AND key_id = ?"
    ).bind(ownerId, spec.id, keyId).run();
    return json(200, { ok: true, slot: await slotView(env, ownerId, spec) });
  }

  if (request.method === "PUT" && !fourth) {
    const hit = await rateHit(env, "owner-keys-put:" + ownerId, 60, 60 * 60 * 1000);
    if (!hit.ok) return limited(hit);
    if (!String(env.KEYS_ENC_KEY || "").trim()) return json(503, { error: "not_configured" });
    const body = await readJson(request, 120000);
    if (!body || body.error) return json(400, { error: body && body.error === "too_large" ? "too_large" : "bad_json" });
    const existing = await loadSlotKeys(env, ownerId, spec.id);
    if (existing.length >= MAX_KEYS) return json(400, { error: "too_many" });
    const parsed = parseMaterial(spec.kind, body.value, Date.now());
    if (!parsed.ok) return json(400, { error: "bad_paste" });
    const sealed = await encryptMaterial(env.KEYS_ENC_KEY, spec.id, parsed.material);
    if (!sealed) return json(503, { error: "not_configured" });
    const now = Date.now();
    const status = parsed.expired ? "expired" : "unknown";
    const error = parsed.expired ? "expired" : "";
    const position = existing.reduce((max, row) => Math.max(max, Number(row.position) || 0), -1) + 1;
    await env.DB.prepare(
      `INSERT INTO owner_key_items (owner_id, key_id, slot, label, position, kind, ciphertext, iv, mask, status, last_used, last_error, expires_at, updated_at, tested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0)`
    ).bind(ownerId, newKeyId(), spec.id, cleanLabel(body.label), position, spec.kind, sealed.ciphertext, sealed.iv, maskSecret("saved"), status, error, parsed.expiresAt || 0, now).run();
    return json(200, { ok: true, slot: await slotView(env, ownerId, spec) });
  }

  if (request.method === "PUT" && fourth && !fifth) {
    const keyId = cleanKeyId(fourth);
    if (!keyId) return json(404, { error: "not_found" });
    const hit = await rateHit(env, "owner-keys-put:" + ownerId, 60, 60 * 60 * 1000);
    if (!hit.ok) return limited(hit);
    if (!String(env.KEYS_ENC_KEY || "").trim()) return json(503, { error: "not_configured" });
    const body = await readJson(request, 120000);
    if (!body || body.error) return json(400, { error: body && body.error === "too_large" ? "too_large" : "bad_json" });
    const rows = await loadSlotKeys(env, ownerId, spec.id);
    const row = rows.find((item) => item.key_id === keyId);
    if (!row) return json(404, { error: "not_found" });
    const parsed = parseMaterial(spec.kind, body.value, Date.now());
    if (!parsed.ok) return json(400, { error: "bad_paste" });
    const sealed = await encryptMaterial(env.KEYS_ENC_KEY, spec.id, parsed.material);
    if (!sealed) return json(503, { error: "not_configured" });
    const now = Date.now();
    const status = parsed.expired ? "expired" : "unknown";
    const error = parsed.expired ? "expired" : "";
    const label = body.label == null ? String(row.label || "") : cleanLabel(body.label);
    await env.DB.prepare(
      `UPDATE owner_key_items
       SET label = ?, kind = ?, ciphertext = ?, iv = ?, mask = ?, status = ?, last_error = ?, expires_at = ?, updated_at = ?, tested_at = 0
       WHERE owner_id = ? AND key_id = ?`
    ).bind(label, spec.kind, sealed.ciphertext, sealed.iv, maskSecret("saved"), status, error, parsed.expiresAt || 0, now, ownerId, keyId).run();
    return json(200, { ok: true, slot: await slotView(env, ownerId, spec) });
  }

  if (request.method === "POST" && fourth === "order" && !fifth) {
    const hit = await rateHit(env, "owner-keys-put:" + ownerId, 60, 60 * 60 * 1000);
    if (!hit.ok) return limited(hit);
    const body = await readJson(request, 8000);
    if (!body || body.error) return json(400, { error: "bad_json" });
    const rows = await loadSlotKeys(env, ownerId, spec.id);
    const ids = Array.isArray(body.ids) ? body.ids.map(cleanKeyId) : [];
    const have = rows.map((row) => row.key_id);
    const seen = {};
    let ok = ids.length === have.length;
    ids.forEach((id) => {
      if (!id || seen[id]) ok = false;
      seen[id] = true;
    });
    have.forEach((id) => { if (!seen[id]) ok = false; });
    if (!ok) return json(400, { error: "bad_json" });
    await env.DB.batch(ids.map((id, index) => env.DB.prepare(
      "UPDATE owner_key_items SET position = ? WHERE owner_id = ? AND slot = ? AND key_id = ?"
    ).bind(index, ownerId, spec.id, id)));
    return json(200, { ok: true, slot: await slotView(env, ownerId, spec) });
  }

  if (request.method === "POST" && (fourth === "test" || fifth === "test")) {
    const hit = await rateHit(env, "owner-keys-test:" + ownerId, 20, 60 * 60 * 1000);
    if (!hit.ok) return limited(hit);
    if (!String(env.KEYS_ENC_KEY || "").trim()) return json(503, { error: "not_configured" });
    if (fourth !== "test" && fifth !== "test") return json(404, { error: "not_found" });
    if (fourth === "test" && fifth) return json(404, { error: "not_found" });
    const rows = await loadSlotKeys(env, ownerId, spec.id);
    let row = null;
    if (fourth === "test") row = rows[0] || null;
    else {
      const keyId = cleanKeyId(fourth);
      row = keyId ? rows.find((item) => item.key_id === keyId) || null : null;
    }
    if (!row) return json(404, { error: "not_found" });
    await applyProbe(env, ownerId, spec, row, Date.now());
    return json(200, { ok: true, slot: await slotView(env, ownerId, spec) });
  }

  return json(405, { error: "method" });
}
