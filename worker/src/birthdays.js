/* Birthday reminders. The worker decides who may know, in the owner's time zone.
   A hidden birthday is left out of the list and out of the notification. */

import { friendshipLive, siteOwnerId } from "./friends-pref.js";
import { blocksEither } from "./social.js";
import { notLocked } from "./locked-sql.js";
import { emitNotification } from "./notifications.js";
import { birthdayParts, canSeeField, daysUntilBirthday } from "./about.js";
import { canSeeAudience } from "./audience.js";

function rowsOf(result) {
  return (result && result.results) || [];
}

function enabled(env) {
  return String(env && env.BIRTHDAY_NOTES || "") !== "off";
}

async function notesOff(env, ids) {
  const off = {};
  const unique = ids.filter((id) => /^\d{12}$/.test(id));
  for (let i = 0; i < unique.length; i += 40) {
    const slice = unique.slice(i, i + 40);
    const marks = slice.map(() => "?").join(",");
    const listed = await env.DB.prepare(
      "SELECT public_id, notes FROM birthday_prefs WHERE public_id IN (" + marks + ")"
    ).bind(...slice).all();
    rowsOf(listed).forEach((row) => {
      if (row.notes === 0) off[row.public_id] = 1;
    });
  }
  return off;
}

async function allowSet(env, fieldId) {
  const bag = {};
  const listed = await env.DB.prepare(
    "SELECT user_id FROM about_field_allow WHERE field_id = ?"
  ).bind(fieldId).all();
  rowsOf(listed).forEach((row) => {
    if (/^\d{12}$/.test(String(row.user_id || ""))) bag[row.user_id] = 1;
  });
  return bag;
}

async function followerRelation(env, ownerId, followerId, allowed, ownerBypass) {
  if (await blocksEither(env, ownerId, followerId)) return null;
  const back = await env.DB.prepare(
    "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?"
  ).bind(ownerId, "app:" + followerId).first();
  const friends = await env.DB.prepare(
    "SELECT user_id FROM account_friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)"
  ).bind(followerId, ownerId, ownerId, followerId).first();
  return {
    owner: false,
    follows: true,
    followsYou: !!back,
    friends: !!friends && (!!ownerBypass || await friendshipLive(env, ownerId, followerId)),
    blocked: false,
    viewerId: followerId,
    allowed: allowed
  };
}

function visibleTo(audience, relation, allowed) {
  if (!relation) return false;
  return canSeeField(audience, relation, allowed);
}

async function mayKnow(env, audience, relation, allowed, ownerId, fieldId) {
  if (visibleTo(audience, relation, allowed)) return true;
  if (audience !== "list" || !relation || !relation.viewerId) return false;
  return canSeeAudience(env, {
    viewerId: relation.viewerId,
    ownerId: ownerId,
    audience: "list",
    subject: "about",
    subjectId: fieldId
  });
}

export async function upcomingBirthdays(env, viewer, now) {
  if (!viewer) return { upcoming: [], notes: true, enabled: false };
  const pref = await env.DB.prepare("SELECT notes FROM birthday_prefs WHERE public_id = ?").bind(viewer.public_id).first();
  const notes = !(pref && pref.notes === 0);
  if (!enabled(env)) return { upcoming: [], notes: notes, enabled: false };
  const follows = await env.DB.prepare(
    "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id LIKE 'app:%'" + notLocked("account_follows") + " LIMIT 200"
  ).bind(viewer.public_id).all();
  const upcoming = [];
  for (const row of rowsOf(follows)) {
    const ownerId = String(row.target_id || "").slice(4);
    if (!/^\d{12}$/.test(ownerId) || ownerId === viewer.public_id) continue;
    const field = await env.DB.prepare(
      "SELECT id, body, show_year, audience, tz FROM about_fields WHERE public_id = ? AND kind = 'birthday' ORDER BY created_at ASC LIMIT 1"
    ).bind(ownerId).first();
    if (!field) continue;
    const account = await env.DB.prepare(
      "SELECT handle, display_name, profile_less FROM accounts WHERE public_id = ?"
    ).bind(ownerId).first();
    if (!account || account.profile_less === 1) continue;
    const allowed = field.audience === "list" ? await allowSet(env, field.id) : {};
    const relation = await followerRelation(env, ownerId, viewer.public_id, allowed, await siteOwnerId(env, viewer.public_id));
    if (!(await mayKnow(env, field.audience, relation, allowed, ownerId, field.id))) continue;
    const parts = birthdayParts(field.body);
    const inDays = daysUntilBirthday(parts, now, field.tz);
    if (inDays == null || inDays < 0 || inDays > 7) continue;
    const item = {
      handle: account.handle || "",
      name: account.display_name || account.handle || "",
      inDays: inDays,
      month: parts.month,
      day: parts.day
    };
    if (field.show_year === 1 && parts.year) item.year = parts.year;
    upcoming.push(item);
  }
  upcoming.sort((a, b) => a.inDays - b.inDays || a.handle.localeCompare(b.handle));
  return { upcoming: upcoming.slice(0, 40), notes: notes, enabled: true };
}

export async function setBirthdayNotes(env, publicId, notes) {
  await env.DB.prepare(
    "INSERT INTO birthday_prefs (public_id, notes, updated_at) VALUES (?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET notes = excluded.notes, updated_at = excluded.updated_at"
  ).bind(publicId, notes ? 1 : 0, Date.now()).run();
  return { notes: !!notes };
}

export async function runBirthdaySweep(env, now) {
  if (!enabled(env)) return { sent: 0 };
  const at = Number(now) || Date.now();
  const listed = await env.DB.prepare(
    "SELECT f.id, f.public_id, f.body, f.show_year, f.audience, f.tz, a.handle, a.display_name, a.profile_less FROM about_fields f JOIN accounts a ON a.public_id = f.public_id WHERE f.kind = 'birthday' LIMIT 400"
  ).all();
  let sent = 0;
  for (const field of rowsOf(listed)) {
    if (field.profile_less === 1) continue;
    const parts = birthdayParts(field.body);
    if (daysUntilBirthday(parts, at, field.tz) !== 0) continue;
    const today = zonedKey(at, field.tz);
    const off = await notesOff(env, [field.public_id]);
    if (!off[field.public_id]) {
      const self = await emitNotification(env, {
        publicId: field.public_id,
        kind: "birthday_self",
        at: at,
        actorId: "",
        idempotencyKey: "bday-self:" + field.public_id + ":" + today.slice(0, 4),
        handle: field.handle || "",
        name: field.display_name || field.handle || "",
        text: "",
        hash: "#/@" + encodeURIComponent(field.handle || ""),
        platform: "app"
      });
      if (self && self.created) sent += 1;
    }
    const followers = await env.DB.prepare(
      "SELECT follower_id FROM account_follows WHERE target_id = ? LIMIT 300"
    ).bind("app:" + field.public_id).all();
    const ids = rowsOf(followers).map((row) => row.follower_id).filter((id) => /^\d{12}$/.test(id) && id !== field.public_id);
    const muted = await notesOff(env, ids);
    const allowed = field.audience === "list" ? await allowSet(env, field.id) : {};
    for (let i = 0; i < ids.length; i++) {
      const followerId = ids[i];
      if (muted[followerId]) continue;
      const relation = await followerRelation(env, field.public_id, followerId, allowed);
      if (!(await mayKnow(env, field.audience, relation, allowed, field.public_id, field.id))) continue;
      const note = await emitNotification(env, {
        publicId: followerId,
        kind: "birthday",
        at: at,
        actorId: field.public_id,
        idempotencyKey: "bday:" + field.public_id + ":" + today,
        handle: field.handle || "",
        name: field.display_name || field.handle || "",
        text: "",
        hash: "#/@" + encodeURIComponent(field.handle || ""),
        platform: "app"
      });
      if (note && note.created) sent += 1;
    }
  }
  return { sent: sent };
}

function zonedKey(ms, timeZone) {
  const zone = timeZone || "UTC";
  try {
    const bag = {};
    new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms)).forEach((part) => {
      bag[part.type] = part.value;
    });
    return bag.year + "-" + bag.month + "-" + bag.day;
  } catch (err) {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export async function handleBirthdayRoutes(request, env, path, deps) {
  if (path === "/v1/about/upcoming" && request.method === "GET") {
    const viewer = await deps.sessionAccount(env, request);
    if (!viewer) return deps.json(401, { error: "unauthorized" });
    return deps.json(200, await upcomingBirthdays(env, viewer, Date.now()));
  }
  if (path === "/v1/about/birthday-notes" && request.method === "PUT") {
    const viewer = await deps.sessionAccount(env, request);
    if (!viewer) return deps.json(401, { error: "unauthorized" });
    const body = await deps.readJson(request, 1000);
    if (body.error) return deps.json(400, { error: body.error });
    return deps.json(200, await setBirthdayNotes(env, viewer.public_id, body.notes !== false && body.notes !== 0));
  }
  return null;
}
