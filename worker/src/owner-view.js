/* Owner view: the one server-side answer to "may this viewer see past privacy?".
   The site owner sees every privacy-hidden thing about an account: all usernames
   and display names (hidden ones too), full friend lists including friendships
   hidden by per-friendship rules, locked follows, true follower / following /
   friend counts and Friends-off accounts. Everyone else keeps the normal rules.

   How other features use it:
     import { isOwnerViewer, logOwnerView, addOwnerViewSource } from "./owner-view.js";
     if (await isOwnerViewer(env, viewerId)) { ...skip the audience filter...; await logOwnerView(env, viewerId, targetId, "friends"); }
   or, to show a feature's hidden data inside the owner inspector:
     addOwnerViewSource("friendship_privacy", async (env, id) => ({ ...counts / lists, never secrets... }));

   Never part of any owner view: passwords and their hashes, salts, session or
   API tokens, lock codes and their hashes, passkey keys, recovery codes, 2FA
   secrets, and private message text. scrubSecrets() drops such keys as a last
   line of defense before anything leaves the Worker. */

import { isSiteOwner } from "./display-names.js";

const OWNER_TTL_MS = 30 * 1000;
const ownerCache = new Map();

/* true only for the account flagged owner = 1. Reuses the display-names owner
   check (#488, isSiteOwner); pass the request to memoize per request. Without
   one, a 30 s per-isolate cache keeps hot paths cheap. */
export async function isOwnerViewer(env, viewerId, request) {
  const id = String(viewerId || "");
  if (!id || !env || !env.DB) return false;
  if (request && typeof request === "object") return isSiteOwner(env, request, id);
  const hit = ownerCache.get(id);
  const now = Date.now();
  if (hit && hit.until > now) return hit.owner;
  const owner = await isSiteOwner(env, null, id);
  ownerCache.set(id, { owner, until: now + OWNER_TTL_MS });
  if (ownerCache.size > 500) ownerCache.delete(ownerCache.keys().next().value);
  return owner;
}

export function resetOwnerViewCache() { ownerCache.clear(); }

const LOG_SCHEMA = "CREATE TABLE IF NOT EXISTS owner_access_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, owner_id TEXT NOT NULL, target_id TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'view')";

/* Writes one audit row (ids, time and a short action word only). Returns true when written. */
export async function logOwnerView(env, ownerId, targetId, action) {
  if (!env || !env.DB || !ownerId || !targetId) return false;
  const word = String(action || "view").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "view";
  const insert = () => env.DB.prepare("INSERT INTO owner_access_log (at, owner_id, target_id, action) VALUES (?, ?, ?, ?)").bind(Date.now(), String(ownerId), String(targetId), word).run();
  try { await insert(); return true; } catch (err) { /* table may not exist yet */ }
  try { await env.DB.prepare(LOG_SCHEMA).run(); await insert(); return true; } catch (err) { return false; }
}

/* Feature modules register extra owner-only detail here (see header). */
const sources = new Map();
export function addOwnerViewSource(name, fn) {
  const key = String(name || "").replace(/[^a-z0-9_]/gi, "").slice(0, 40);
  if (key && typeof fn === "function") sources.set(key, fn);
}
export async function ownerViewExtras(env, id) {
  const out = {};
  for (const [key, fn] of sources) {
    try { out[key] = scrubSecrets(await fn(env, id)); } catch (err) { out[key] = { error: "unavailable" }; }
  }
  return out;
}

const SECRET_KEY = /(password|passcode|hash|salt|token|secret|private_?key|public_?key|credential|totp|otp_|lock_?code|ciphertext|grant|challenge|message_?text|dm_?text)/i;

/* Removes secret-looking keys anywhere in a value (objects and arrays). */
export function scrubSecrets(value, depth) {
  const d = depth || 0;
  if (d > 8 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, d + 1));
  if (typeof value !== "object") return value;
  const out = {};
  Object.keys(value).forEach((k) => { if (!SECRET_KEY.test(k)) out[k] = scrubSecrets(value[k], d + 1); });
  return out;
}
