/* Locked follows: the SQL pieces every follow read shares.

   A locked follow is a normal row in account_follows plus a row in
   locked_follows with the same follower, target and follow time. While it
   is there, that follow is left out of every list, count, timeline, search
   and suggestion that reads the follower's follows, for every viewer, the
   follower included. Matching on the follow time means an unfollow and a
   later follow start unlocked again, even if an old lock row was left.

   The followed person still sees the follower: lists of a target's
   followers do not use this filter. */

export const LOCKED_SQL_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS locked_follows (owner_id TEXT NOT NULL, target_id TEXT NOT NULL, follow_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (owner_id, target_id))"
];

/* " AND NOT EXISTS (...)" for an account_follows alias. */
export function notLocked(alias) {
  const a = alias || "account_follows";
  return " AND NOT EXISTS (SELECT 1 FROM locked_follows lf WHERE lf.owner_id = " + a + ".follower_id AND lf.target_id = " + a + ".target_id AND lf.follow_at = " + a + ".created_at)";
}

/* Visible following count: never counts locked follows. */
export const FOLLOWING_COUNT_SQL = "SELECT COUNT(*) AS n FROM account_follows f WHERE f.follower_id = ?" + notLocked("f");

/* Stored target ids ("app:<id>" or a feed id) this account has locked. */
export async function lockedTargetSet(env, ownerId) {
  const set = new Set();
  if (!ownerId) return set;
  try {
    const listed = await env.DB.prepare(
      "SELECT f.target_id AS id FROM account_follows f JOIN locked_follows lf ON lf.owner_id = f.follower_id AND lf.target_id = f.target_id AND lf.follow_at = f.created_at WHERE f.follower_id = ? LIMIT 5000"
    ).bind(String(ownerId)).all();
    ((listed && listed.results) || []).forEach((row) => set.add(String(row.id)));
  } catch (err) { /* no table yet: nothing is locked */ }
  return set;
}

/* Account ids (12 digits) among this account's locked follows. */
export async function lockedAccountSet(env, ownerId) {
  const out = new Set();
  (await lockedTargetSet(env, ownerId)).forEach((id) => {
    if (id.indexOf("app:") === 0) out.add(id.slice(4));
  });
  return out;
}

export async function isLockedFollow(env, ownerId, targetStoredId) {
  if (!ownerId || !targetStoredId) return false;
  try {
    const row = await env.DB.prepare(
      "SELECT 1 AS ok FROM account_follows f JOIN locked_follows lf ON lf.owner_id = f.follower_id AND lf.target_id = f.target_id AND lf.follow_at = f.created_at WHERE f.follower_id = ? AND f.target_id = ?"
    ).bind(String(ownerId), String(targetStoredId)).first();
    return !!row;
  } catch (err) {
    return false;
  }
}

/* Salted 64-bit FNV-style hash the client can compute without waiting.
   Used for the device-side filter, so the device never holds a plain list. */
export function filterHash(salt, id) {
  const text = String(salt || "") + "|" + String(id || "").toLowerCase();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return ("0000000" + h1.toString(16)).slice(-8) + ("0000000" + h2.toString(16)).slice(-8);
}

/* " AND NOT EXISTS (...)" for a friends row: a friend the user has a locked
   follow on is left out of that user's friends list and count. */
export function notLockedFriend(userCol, friendCol) {
  return " AND NOT EXISTS (SELECT 1 FROM account_follows af JOIN locked_follows lf ON lf.owner_id = af.follower_id AND lf.target_id = af.target_id AND lf.follow_at = af.created_at WHERE af.follower_id = " + userCol + " AND af.target_id = ('app:' || " + friendCol + "))";
}
