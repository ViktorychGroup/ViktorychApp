/* Locked follows, like WhatsApp's Locked chats.

   A person can lock some of the accounts and sources they follow. A locked
   follow drops out of every follow list and count, timeline, search,
   suggestion, presence read and notification list (see locked-sql.js for
   the shared filter), for every viewer including the person themself,
   until they open the Locked area on a device.

   Opening the Locked area always happens on the device: the screen lock or
   biometrics through a platform passkey made only for this (WebAuthn, user
   verification required), or a secret code. The code is stored only as a
   salted PBKDF2-SHA256 hash and is never logged. A good unlock gives a
   short-lived grant tied to that device's session; the Locked area reads
   need it. Wrong codes count, back off and are rate limited per account and
   per IP. "Forgot code" re-checks the account (account number or the
   account's passkey) and clears the code and device keys; it never lists
   the locked people.

   The followed person still sees the follower, like the X default. */
import {
  b64urlToBytes,
  bytesToB64url,
  creationOptions,
  randomBytes,
  requestOptions,
  rpIdForOrigin,
  verifyAssertion,
  verifyRegistration
} from "../../shared/webauthn.js";
import { LOCKED_SQL_SCHEMA, FOLLOWING_COUNT_SQL, filterHash, lockedTargetSet, lockedAccountSet } from "./locked-sql.js";
import { canSeePosts } from "./social.js";
import { audienceSets, canSee, presentPost } from "./posts.js";
import { redactPublicIds } from "../../shared/profile-privacy.js";

export const LOCKED_SCHEMA = LOCKED_SQL_SCHEMA.concat([
  "CREATE INDEX IF NOT EXISTS locked_follows_owner ON locked_follows(owner_id, created_at DESC)",
  "CREATE TABLE IF NOT EXISTS locked_follow_prefs (public_id TEXT PRIMARY KEY, code_hash TEXT NOT NULL DEFAULT '', code_salt TEXT NOT NULL DEFAULT '', code_rounds INTEGER NOT NULL DEFAULT 0, hide_entry INTEGER NOT NULL DEFAULT 0, relock_secs INTEGER NOT NULL DEFAULT 60, fails INTEGER NOT NULL DEFAULT 0, fail_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS locked_follow_keys (credential_id TEXT PRIMARY KEY, public_id TEXT NOT NULL, rp_id TEXT NOT NULL, public_key TEXT NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS locked_follow_keys_owner ON locked_follow_keys(public_id)",
  "CREATE TABLE IF NOT EXISTS locked_follow_grants (grant_hash TEXT PRIMARY KEY, public_id TEXT NOT NULL, session_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS locked_follow_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, owner_id TEXT NOT NULL, subject_id TEXT NOT NULL, action TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS locked_follow_audit_at ON locked_follow_audit(at DESC)",
  "CREATE TABLE IF NOT EXISTS locked_follow_challenges (id TEXT PRIMARY KEY, public_id TEXT NOT NULL, kind TEXT NOT NULL, challenge TEXT NOT NULL, origin TEXT NOT NULL, rp_id TEXT NOT NULL, expires_at INTEGER NOT NULL)"
]);

export const RELOCK_CHOICES = [0, 60, 300, 900];
const CODE_MIN = 4;
const CODE_MAX = 64;
const CHALLENGE_MS = 5 * 60 * 1000;
const FREE_FAILS = 5;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const FILTER_BLOCK = 64;
const enc = new TextEncoder();

let schemaReady = null;
export function ensureLockedSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(LOCKED_SCHEMA.map((sql) => env.DB.prepare(sql)))
      .catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(text)))));
}

function codeRounds(env) {
  const n = Number(env.LOCK_CODE_ROUNDS || env.PBKDF2_ITERATIONS || 100000);
  return Math.max(1000, Math.min(100000, Math.floor(n) || 100000));
}

/* PBKDF2-SHA256 over the code and the server pepper, with a random salt. */
export async function hashCode(env, code, saltHex, rounds) {
  const material = String(code).normalize("NFC") + "\u0000" + String(env.ACCOUNT_PEPPER || "");
  const key = await crypto.subtle.importKey("raw", enc.encode(material), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, key, 256);
  return hex(new Uint8Array(bits));
}

function sameHex(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return diff === 0;
}

function cleanCode(raw) {
  const text = String(raw == null ? "" : raw).trim();
  const n = Array.from(text).length;
  if (n < CODE_MIN || n > CODE_MAX) return "";
  if (/[\u0000-\u001F\u007F]/.test(text)) return "";
  return text;
}

async function readPrefsRow(env, publicId) {
  await ensureLockedSchema(env);
  return env.DB.prepare("SELECT public_id, code_hash, code_salt, code_rounds, hide_entry, relock_secs, fails, fail_until FROM locked_follow_prefs WHERE public_id = ?").bind(publicId).first();
}

async function keyCount(env, publicId) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM locked_follow_keys WHERE public_id = ?").bind(publicId).first();
  return Number(row && row.n) || 0;
}

async function ensurePrefsRow(env, publicId) {
  await env.DB.prepare("INSERT INTO locked_follow_prefs (public_id, updated_at) VALUES (?, ?) ON CONFLICT(public_id) DO NOTHING").bind(publicId, Date.now()).run();
}

function bearerOf(request) {
  const header = request.headers.get("Authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function relockOf(row) {
  const n = Number(row && row.relock_secs);
  return RELOCK_CHOICES.indexOf(n) >= 0 ? n : 60;
}

async function issueGrant(env, request, publicId, row) {
  const grant = "lg1." + bytesToB64url(randomBytes(32));
  const relock = relockOf(row);
  // "Right away" still needs a few minutes on the server; the device drops
  // the grant as soon as the person leaves the Locked area.
  const ttl = Math.max(120, relock) * 1000;
  const expires = Date.now() + ttl;
  await env.DB.prepare("DELETE FROM locked_follow_grants WHERE expires_at < ?").bind(Date.now()).run();
  await env.DB.prepare("INSERT INTO locked_follow_grants (grant_hash, public_id, session_hash, expires_at) VALUES (?, ?, ?, ?)").bind(
    await sha256Hex(grant), publicId, await sha256Hex(bearerOf(request)), expires
  ).run();
  return { grant, expiresAt: expires, relockSecs: relock };
}

/* True when the request carries a live grant for this account and this
   device's session. */
export async function grantOk(env, request, publicId) {
  const grant = String(request.headers.get("X-Locked-Grant") || "");
  if (!grant || grant.length > 200 || grant.indexOf("lg1.") !== 0) return false;
  try {
    await ensureLockedSchema(env);
    const row = await env.DB.prepare("SELECT public_id, session_hash, expires_at FROM locked_follow_grants WHERE grant_hash = ?").bind(await sha256Hex(grant)).first();
    if (!row || String(row.public_id) !== String(publicId)) return false;
    if (Number(row.expires_at) <= Date.now()) return false;
    return sameHex(row.session_hash, await sha256Hex(bearerOf(request)));
  } catch (err) {
    return false;
  }
}

function party(request, deps) {
  const origin = request.headers.get("Origin") || "";
  if (!origin || !deps.originAllowed(origin)) return null;
  const rpId = rpIdForOrigin(origin);
  return rpId ? { origin, rpId } : null;
}

async function putChallenge(env, publicId, kind, site) {
  const id = bytesToB64url(randomBytes(24));
  const challenge = randomBytes(32);
  await env.DB.prepare("DELETE FROM locked_follow_challenges WHERE expires_at < ?").bind(Date.now()).run();
  await env.DB.prepare("INSERT INTO locked_follow_challenges (id, public_id, kind, challenge, origin, rp_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
    id, publicId, kind, bytesToB64url(challenge), site.origin, site.rpId, Date.now() + CHALLENGE_MS
  ).run();
  return { id, challenge };
}

async function takeChallenge(env, id, publicId, kind, site) {
  const text = String(id || "");
  if (!text || text.length > 80) return null;
  const row = await env.DB.prepare("SELECT public_id, kind, challenge, origin, rp_id, expires_at FROM locked_follow_challenges WHERE id = ?").bind(text).first();
  if (!row) return null;
  await env.DB.prepare("DELETE FROM locked_follow_challenges WHERE id = ?").bind(text).run();
  if (row.kind !== kind || String(row.public_id) !== String(publicId)) return null;
  if (Number(row.expires_at) <= Date.now()) return null;
  if (row.origin !== site.origin || row.rp_id !== site.rpId) return null;
  return b64urlToBytes(row.challenge);
}

function credentialId(body) {
  const c = body && body.credential;
  if (!c || c.type !== "public-key") return "";
  const raw = String(c.rawId || c.id || "");
  return raw && raw.length <= 1400 ? raw : "";
}

/* Wrong-code pacing: five free tries, then a doubling wait, capped at an
   hour. The wait is stored with the account so it holds on every device. */
async function noteFail(env, publicId, row) {
  const fails = (Number(row && row.fails) || 0) + 1;
  const wait = fails > FREE_FAILS ? Math.min(MAX_BACKOFF_MS, 30000 * Math.pow(2, fails - FREE_FAILS - 1)) : 0;
  await env.DB.prepare("UPDATE locked_follow_prefs SET fails = ?, fail_until = ? WHERE public_id = ?").bind(fails, wait ? Date.now() + wait : 0, publicId).run();
  return wait;
}

async function clearFails(env, publicId) {
  await env.DB.prepare("UPDATE locked_follow_prefs SET fails = 0, fail_until = 0 WHERE public_id = ?").bind(publicId).run();
}

function cooling(row) {
  const until = Number(row && row.fail_until) || 0;
  return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
}

async function resolveTarget(env, deps, raw) {
  const id = deps.cleanFollowId(raw);
  if (!id) return "";
  if (id.indexOf("app:") !== 0) return id;
  const account = await deps.accountByFollowRef(env, id);
  return account ? "app:" + account.public_id : "";
}

async function followingCount(env, publicId) {
  const row = await env.DB.prepare(FOLLOWING_COUNT_SQL).bind(publicId).first();
  return Number(row && row.n) || 0;
}

/* The device-side filter: salted hashes of every id form the device may see
   for a locked follow, padded with random decoys to a block of 64 so the
   size says nothing about how many there are. */
async function filterFor(env, publicId) {
  const salt = bytesToB64url(randomBytes(12));
  const hashes = [];
  const locked = await lockedTargetSet(env, publicId);
  for (const id of locked) {
    hashes.push(filterHash(salt, id));
    if (id.indexOf("app:") === 0) {
      const row = await env.DB.prepare("SELECT handle FROM accounts WHERE public_id = ?").bind(id.slice(4)).first();
      if (row && row.handle) hashes.push(filterHash(salt, "app:@" + row.handle));
    }
  }
  const size = Math.max(FILTER_BLOCK, Math.ceil(hashes.length / FILTER_BLOCK) * FILTER_BLOCK);
  while (hashes.length < size) hashes.push(hex(randomBytes(8)));
  for (let i = hashes.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    const t = hashes[i]; hashes[i] = hashes[j]; hashes[j] = t;
  }
  return { salt, hashes };
}

/* For the owner inspector: whether this account uses locked follows at all.
   Never the code, never who. */
export async function lockedFollowSummary(env, publicId) {
  try {
    await ensureLockedSchema(env);
    const row = await readPrefsRow(env, publicId);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM locked_follows WHERE owner_id = ?").bind(publicId).first();
    return { setUp: !!(row && (row.code_hash || await keyCount(env, publicId))), lockedCount: Number(n && n.n) || 0 };
  } catch (err) {
    return { setUp: false, lockedCount: 0 };
  }
}

/* The app owner sees every account's real following list and counts, locked
   follows included and marked. Each look is written to locked_follow_audit.
   Never the code, its hash, the device keys or anyone's messages. */
export function ownerSees(viewer, subjectId) {
  return !!(viewer && Number(viewer.owner) === 1 && subjectId && String(viewer.public_id) !== String(subjectId));
}

export async function auditOwnerView(env, ownerId, subjectId, action) {
  try {
    await ensureLockedSchema(env);
    await env.DB.prepare("INSERT INTO locked_follow_audit (at, owner_id, subject_id, action) VALUES (?, ?, ?, ?)").bind(Date.now(), String(ownerId), String(subjectId), String(action).slice(0, 40)).run();
  } catch (err) { /* the read still answers */ }
}

const TRUE_FOLLOWING_SQL = "SELECT COUNT(*) AS n FROM account_follows WHERE follower_id = ?";

/* GET /v1/owner/locked-follows?id=<account ref>  (owner only)
   GET /v1/owner/locked-follows/audit              (owner only) */
export async function handleOwnerLocked(request, env, path, url, deps) {
  if (path !== "/v1/owner/locked-follows" && path !== "/v1/owner/locked-follows/audit") return null;
  if (request.method !== "GET") return deps.json(405, { error: "method" });
  const viewer = await deps.sessionAccount(env, request);
  if (!viewer) return deps.json(401, { error: "unauthorized" });
  if (Number(viewer.owner) !== 1) return deps.json(403, { error: "forbidden" });
  await ensureLockedSchema(env);
  if (path === "/v1/owner/locked-follows/audit") {
    const listed = await env.DB.prepare("SELECT l.at, l.action, a.handle FROM locked_follow_audit l LEFT JOIN accounts a ON a.public_id = l.subject_id ORDER BY l.id DESC LIMIT 200").all();
    return deps.json(200, { items: ((listed && listed.results) || []).map((r) => ({ at: r.at, action: r.action, handle: r.handle || "" })) });
  }
  const ref = deps.cleanFollowId(url.searchParams.get("id") || "");
  const account = ref && ref.indexOf("app:") === 0 ? await deps.accountByFollowRef(env, ref) : null;
  if (!account) return deps.json(404, { error: "not_found" });
  const subject = String(account.public_id);
  await auditOwnerView(env, viewer.public_id, subject, "inspect");
  const summary = await lockedFollowSummary(env, subject);
  const locked = Array.from(await lockedTargetSet(env, subject));
  const people = [];
  for (const id of locked.slice(0, 500)) {
    if (id.indexOf("app:") === 0) {
      const cards = await deps.cards(env, request, [id.slice(4)]);
      if (cards[0]) people.push(Object.assign({}, cards[0], { locked: true }));
    } else {
      const snap = await env.DB.prepare("SELECT snapshot FROM account_follows WHERE follower_id = ? AND target_id = ?").bind(subject, id).first();
      people.push(Object.assign({}, deps.feedCard(id, snap && snap.snapshot), { locked: true }));
    }
  }
  const all = await env.DB.prepare(TRUE_FOLLOWING_SQL).bind(subject).first();
  return deps.json(200, redactPublicIds({
    id: "app:@" + (account.handle || ""),
    setUp: summary.setUp,
    lockedCount: locked.length,
    followingCount: Number(all && all.n) || 0,
    visibleFollowingCount: await followingCount(env, subject),
    locked: people
  }));
}

export async function handleLockedFollows(request, env, path, url, deps) {
  if (!path.startsWith("/v1/locked-follows")) return null;
  if (!env.DB) return deps.json(503, { error: "not_configured" });
  const viewer = await deps.sessionAccount(env, request);
  if (!viewer) return deps.json(401, { error: "unauthorized" });
  await ensureLockedSchema(env);
  const me = String(viewer.public_id);
  const method = request.method;
  const row = await readPrefsRow(env, me);
  const keys = await keyCount(env, me);
  const setUp = !!((row && row.code_hash) || keys);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const body = method === "GET" ? {} : await deps.readJson(request, 16000);
  if (body.error) return deps.json(400, { error: body.error });
  const granted = await grantOk(env, request, me);

  if (path === "/v1/locked-follows/state" && method === "GET") {
    const paced = await deps.rateHit(env, "lf-read:" + me, 240, 10 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    return deps.json(200, {
      setUp,
      code: !!(row && row.code_hash),
      device: keys > 0,
      hideEntry: !!(row && row.hide_entry),
      relockSecs: relockOf(row),
      unlocked: granted,
      filter: await filterFor(env, me)
    });
  }

  // First set-up needs nothing more than the session; changing an existing
  // lock needs a live grant.
  if (path === "/v1/locked-follows/code" && method === "POST") {
    if (setUp && !granted) return deps.json(403, { error: "locked" });
    const code = cleanCode(body.code);
    if (!code) return deps.json(400, { error: "bad_code" });
    const paced = await deps.rateHit(env, "lf-code:" + me, 10, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const salt = hex(randomBytes(16));
    const rounds = codeRounds(env);
    const hashed = await hashCode(env, code, salt, rounds);
    await ensurePrefsRow(env, me);
    await env.DB.prepare("UPDATE locked_follow_prefs SET code_hash = ?, code_salt = ?, code_rounds = ?, fails = 0, fail_until = 0, updated_at = ? WHERE public_id = ?").bind(hashed, salt, rounds, Date.now(), me).run();
    return deps.json(200, Object.assign({ ok: true }, await issueGrant(env, request, me, await readPrefsRow(env, me))));
  }

  if (path === "/v1/locked-follows/device/options" && method === "POST") {
    if (setUp && !granted) return deps.json(403, { error: "locked" });
    const site = party(request, deps);
    if (!site) return deps.json(403, { error: "origin" });
    const paced = await deps.rateHit(env, "lf-dev:" + me, 20, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const stored = await putChallenge(env, me, "register", site);
    const options = creationOptions({ rpId: site.rpId, challenge: stored.challenge, userId: randomBytes(16), userName: "locked-follows", userDisplayName: "Locked follows", userVerification: "required" });
    options.authenticatorSelection = { authenticatorAttachment: "platform", residentKey: "discouraged", requireResidentKey: false, userVerification: "required" };
    options.hints = ["client-device"];
    return deps.json(200, { challengeId: stored.id, publicKey: options });
  }

  if (path === "/v1/locked-follows/device" && method === "POST") {
    if (setUp && !granted) return deps.json(403, { error: "locked" });
    const site = party(request, deps);
    if (!site) return deps.json(403, { error: "origin" });
    const challenge = await takeChallenge(env, body.challengeId, me, "register", site);
    const response = body.credential && body.credential.response;
    if (!challenge || !response || !response.clientDataJSON || !response.attestationObject) return deps.json(400, { error: "challenge" });
    let verified;
    try {
      verified = await verifyRegistration({ clientDataJSON: response.clientDataJSON, attestationObject: response.attestationObject, challenge, origin: site.origin, rpId: site.rpId, requireUV: true });
    } catch (err) {
      return deps.json(400, { error: "device_failed" });
    }
    if (keys >= 10) return deps.json(409, { error: "device_limit" });
    await ensurePrefsRow(env, me);
    await env.DB.prepare("INSERT INTO locked_follow_keys (credential_id, public_id, rp_id, public_key, sign_count, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(credential_id) DO NOTHING").bind(
      bytesToB64url(verified.credentialId), me, site.rpId, bytesToB64url(verified.publicKey), verified.signCount || 0, Date.now()
    ).run();
    return deps.json(200, Object.assign({ ok: true, credentialId: bytesToB64url(verified.credentialId) }, await issueGrant(env, request, me, await readPrefsRow(env, me))));
  }

  if (path === "/v1/locked-follows/unlock/options" && method === "POST") {
    const site = party(request, deps);
    if (!site) return deps.json(403, { error: "origin" });
    const paced = await deps.rateHit(env, "lf-uo:" + me, 60, 15 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const listed = await env.DB.prepare("SELECT credential_id FROM locked_follow_keys WHERE public_id = ? AND rp_id = ?").bind(me, site.rpId).all();
    const allow = ((listed && listed.results) || []).map((r) => ({ type: "public-key", id: r.credential_id, transports: ["internal"] }));
    if (!allow.length) return deps.json(404, { error: "no_device" });
    const stored = await putChallenge(env, me, "unlock", site);
    const options = requestOptions({ rpId: site.rpId, challenge: stored.challenge, userVerification: "required", allowCredentials: allow });
    options.hints = ["client-device"];
    return deps.json(200, { challengeId: stored.id, publicKey: options });
  }

  if (path === "/v1/locked-follows/unlock" && method === "POST") {
    const ipGate = await deps.rateHit(env, "lf-unlock-ip:" + ip, 40, 15 * 60 * 1000);
    if (!ipGate.ok) return deps.limited(ipGate);
    const probe = body.probe === true;
    const gate = await deps.rateHit(env, (probe ? "lf-probe:" : "lf-unlock:") + me, probe ? 20 : 20, probe ? 60 * 60 * 1000 : 15 * 60 * 1000);
    if (!gate.ok) return deps.limited(gate);
    if (!setUp) return deps.json(401, { error: "unlock_failed" });
    const wait = cooling(row);
    if (wait) return deps.json(429, { error: "rate_limited", retryAfter: wait }, { "retry-after": String(wait), "x-limit-scope": "action" });
    if (body.credential) {
      const site = party(request, deps);
      if (!site) return deps.json(403, { error: "origin" });
      const challenge = await takeChallenge(env, body.challengeId, me, "unlock", site);
      const rawId = credentialId(body);
      const response = body.credential.response;
      const key = rawId ? await env.DB.prepare("SELECT credential_id, public_key, sign_count, rp_id FROM locked_follow_keys WHERE credential_id = ? AND public_id = ?").bind(rawId, me).first() : null;
      if (!challenge || !key || key.rp_id !== site.rpId || !response) return deps.json(401, { error: "unlock_failed" });
      try {
        const ok = await verifyAssertion({ clientDataJSON: response.clientDataJSON, authenticatorData: response.authenticatorData, signature: response.signature, publicKey: b64urlToBytes(key.public_key), challenge, origin: site.origin, rpId: site.rpId, signCount: key.sign_count, requireUV: true });
        await env.DB.prepare("UPDATE locked_follow_keys SET sign_count = ? WHERE credential_id = ?").bind(ok.signCount || key.sign_count || 0, rawId).run();
      } catch (err) {
        return deps.json(401, { error: "unlock_failed" });
      }
      await clearFails(env, me);
      return deps.json(200, Object.assign({ ok: true }, await issueGrant(env, request, me, row)));
    }
    const code = cleanCode(body.code);
    const salt = row && row.code_salt ? row.code_salt : "00000000000000000000000000000000";
    // Always do the slow hash, so a missing code and a wrong code take the
    // same time.
    const hashed = await hashCode(env, code || "----", salt, Number(row && row.code_rounds) || codeRounds(env));
    if (!code || !row || !row.code_hash || !sameHex(hashed, row.code_hash)) {
      if (!probe && row && row.code_hash) {
        const waitNext = await noteFail(env, me, row);
        if (waitNext) return deps.json(401, { error: "unlock_failed", retryAfter: Math.ceil(waitNext / 1000) });
      }
      return deps.json(401, { error: "unlock_failed" });
    }
    await clearFails(env, me);
    return deps.json(200, Object.assign({ ok: true }, await issueGrant(env, request, me, row)));
  }

  if (path === "/v1/locked-follows/relock" && method === "POST") {
    const grant = String(request.headers.get("X-Locked-Grant") || "");
    if (grant) await env.DB.prepare("DELETE FROM locked_follow_grants WHERE grant_hash = ? AND public_id = ?").bind(await sha256Hex(grant), me).run();
    return deps.json(200, { ok: true });
  }

  // Lock a follow. Hiding is always allowed once a lock is set up; it only
  // ever takes things out of view.
  if (path === "/v1/locked-follows/lock" && method === "POST") {
    if (!setUp) return deps.json(409, { error: "not_set_up" });
    const paced = await deps.rateHit(env, "lf-lock:" + me, 60, 10 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    let target = await resolveTarget(env, deps, body.id);
    if (!target) return deps.json(404, { error: "not_found" });
    let follow = await env.DB.prepare("SELECT target_id, created_at FROM account_follows WHERE follower_id = ? AND lower(target_id) = lower(?)").bind(me, target).first();
    if (!follow && target.indexOf("app:") !== 0) {
      const now = Date.now();
      await env.DB.prepare("INSERT INTO account_follows (follower_id, target_id, snapshot, created_at) VALUES (?, ?, '', ?) ON CONFLICT(follower_id, target_id) DO NOTHING").bind(me, target, now).run();
      follow = { target_id: target, created_at: now };
    }
    if (!follow) return deps.json(404, { error: "not_following" });
    target = follow.target_id || target;
    await env.DB.prepare("INSERT INTO locked_follows (owner_id, target_id, follow_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, target_id) DO UPDATE SET follow_at = excluded.follow_at, created_at = excluded.created_at").bind(me, target, Number(follow.created_at) || 0, Date.now()).run();
    return deps.json(200, { ok: true, followingCount: await followingCount(env, me) });
  }

  // Everything below is inside the Locked area: it needs a live grant.
  if (!granted) return deps.json(403, { error: "locked" });

  if (path === "/v1/locked-follows/unlock-follow" && method === "POST") {
    const target = await resolveTarget(env, deps, body.id);
    if (!target) return deps.json(404, { error: "not_found" });
    await env.DB.prepare("DELETE FROM locked_follows WHERE owner_id = ? AND lower(target_id) = lower(?)").bind(me, target).run();
    return deps.json(200, { ok: true, followingCount: await followingCount(env, me) });
  }

  if (path === "/v1/locked-follows/list" && method === "GET") {
    const locked = Array.from(await lockedTargetSet(env, me));
    const accounts = [];
    for (const id of locked.slice(0, 500)) {
      if (id.indexOf("app:") === 0) {
        const cards = await deps.cards(env, request, [id.slice(4)]);
        if (cards[0]) accounts.push(cards[0]);
      } else {
        const snap = await env.DB.prepare("SELECT snapshot FROM account_follows WHERE follower_id = ? AND lower(target_id) = lower(?)").bind(me, id).first();
        accounts.push(deps.feedCard(id, snap && snap.snapshot));
      }
    }
    return deps.json(200, redactPublicIds({ accounts }));
  }

  if (path === "/v1/locked-follows/posts" && method === "GET") {
    const ids = Array.from(await lockedAccountSet(env, me)).slice(0, 80);
    const posts = [];
    if (ids.length) {
      const marks = ids.map(() => "?").join(",");
      const listed = await env.DB.prepare("SELECT p.id, p.author_id, p.body, p.parent_id, p.quote_id, p.created_at, p.hidden, p.audience, p.reply_control, p.location, p.poll_json, p.scheduled_at, p.ext_parent, a.handle, a.display_name, a.avatar FROM public_posts p JOIN accounts a ON a.public_id = p.author_id WHERE p.hidden = 0 AND (p.scheduled_at = 0 OR p.scheduled_at <= ?) AND p.author_id IN (" + marks + ") ORDER BY p.created_at DESC LIMIT 60").bind(Date.now(), ...ids).all();
      const rows = (listed && listed.results) || [];
      const sets = await audienceSets(env, me, rows.map((r) => r.author_id));
      for (const r of rows) {
        if ((r.audience || "everyone") === "list") continue;
        if (!canSee(r, me, sets) || !(await canSeePosts(env, me, r.author_id))) continue;
        const post = await presentPost(env, request, r, me);
        delete post.authorId;
        posts.push(post);
        if (posts.length >= 30) break;
      }
    }
    return deps.json(200, redactPublicIds({ posts }));
  }

  if (path === "/v1/locked-follows/notifications" && method === "GET") {
    return deps.json(200, redactPublicIds({ items: await deps.heldNotes(env, request, me, await lockedAccountSet(env, me)) }));
  }

  if (path === "/v1/locked-follows/prefs" && method === "PATCH") {
    await ensurePrefsRow(env, me);
    const hide = body.hideEntry == null ? (row && row.hide_entry ? 1 : 0) : (body.hideEntry ? 1 : 0);
    if (hide && !(row && row.code_hash)) return deps.json(400, { error: "needs_code" });
    const relock = body.relockSecs == null ? relockOf(row) : Number(body.relockSecs);
    if (RELOCK_CHOICES.indexOf(relock) < 0) return deps.json(400, { error: "bad_relock" });
    await env.DB.prepare("UPDATE locked_follow_prefs SET hide_entry = ?, relock_secs = ?, updated_at = ? WHERE public_id = ?").bind(hide, relock, Date.now(), me).run();
    return deps.json(200, { ok: true, hideEntry: !!hide, relockSecs: relock });
  }

  if (path === "/v1/locked-follows/off" && method === "POST") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM locked_follows WHERE owner_id = ?").bind(me),
      env.DB.prepare("DELETE FROM locked_follow_keys WHERE public_id = ?").bind(me),
      env.DB.prepare("DELETE FROM locked_follow_prefs WHERE public_id = ?").bind(me),
      env.DB.prepare("DELETE FROM locked_follow_grants WHERE public_id = ?").bind(me)
    ]);
    return deps.json(200, { ok: true, followingCount: await followingCount(env, me) });
  }

  return deps.json(404, { error: "not_found" });
}

/* "Forgot code": prove it is the account (account number, or one of the
   account's own passkeys), then the code and device keys are cleared. The
   locked people stay locked and are not listed. Routed before the grant
   check because it is the way back in. */
export async function handleLockedReset(request, env, path, deps) {
  if (path !== "/v1/locked-follows/reset" && path !== "/v1/locked-follows/reset/options") return null;
  if (request.method !== "POST") return deps.json(405, { error: "method" });
  const viewer = await deps.sessionAccount(env, request);
  if (!viewer) return deps.json(401, { error: "unauthorized" });
  await ensureLockedSchema(env);
  const me = String(viewer.public_id);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipGate = await deps.rateHit(env, "lf-reset-ip:" + ip, 12, 60 * 60 * 1000);
  if (!ipGate.ok) return deps.limited(ipGate);
  const gate = await deps.rateHit(env, "lf-reset:" + me, 8, 60 * 60 * 1000);
  if (!gate.ok) return deps.limited(gate);
  const body = await deps.readJson(request, 16000);
  if (body.error) return deps.json(400, { error: body.error });
  const site = party(request, deps);
  if (path === "/v1/locked-follows/reset/options") {
    if (!site) return deps.json(403, { error: "origin" });
    const listed = await env.DB.prepare("SELECT credential_id, transports FROM webauthn_credentials WHERE public_id = ? AND rp_id = ?").bind(me, site.rpId).all().catch(() => null);
    const allow = ((listed && listed.results) || []).map((r) => ({ type: "public-key", id: r.credential_id }));
    if (!allow.length) return deps.json(404, { error: "no_passkey" });
    const stored = await putChallenge(env, me, "reset", site);
    return deps.json(200, { challengeId: stored.id, publicKey: requestOptions({ rpId: site.rpId, challenge: stored.challenge, userVerification: "required", allowCredentials: allow }) });
  }
  let ok = false;
  if (body.credential) {
    if (!site) return deps.json(403, { error: "origin" });
    const challenge = await takeChallenge(env, body.challengeId, me, "reset", site);
    const rawId = credentialId(body);
    const key = rawId ? await env.DB.prepare("SELECT public_key, sign_count, rp_id FROM webauthn_credentials WHERE credential_id = ? AND public_id = ?").bind(rawId, me).first() : null;
    const response = body.credential.response;
    if (challenge && key && key.rp_id === site.rpId && response) {
      try {
        const verified = await verifyAssertion({ clientDataJSON: response.clientDataJSON, authenticatorData: response.authenticatorData, signature: response.signature, publicKey: b64urlToBytes(key.public_key), challenge, origin: site.origin, rpId: site.rpId, signCount: key.sign_count, requireUV: true });
        await env.DB.prepare("UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ? WHERE credential_id = ?").bind(verified.signCount || key.sign_count || 0, Date.now(), rawId).run();
        ok = true;
      } catch (err) { ok = false; }
    }
  } else {
    const account = await env.DB.prepare("SELECT public_id, handle, skeleton, owner, number_hash, salt FROM accounts WHERE public_id = ?").bind(me).first();
    ok = !!(account && await deps.verifyAccountNumber(env, account, body.accountNumber));
  }
  if (!ok) return deps.json(401, { error: "invalid_credentials" });
  await env.DB.batch([
    env.DB.prepare("UPDATE locked_follow_prefs SET code_hash = '', code_salt = '', code_rounds = 0, hide_entry = 0, fails = 0, fail_until = 0, updated_at = ? WHERE public_id = ?").bind(Date.now(), me),
    env.DB.prepare("DELETE FROM locked_follow_keys WHERE public_id = ?").bind(me),
    env.DB.prepare("DELETE FROM locked_follow_grants WHERE public_id = ?").bind(me)
  ]);
  return deps.json(200, { ok: true });
}
