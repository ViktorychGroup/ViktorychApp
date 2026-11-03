/* Profile About fields. Each row has its own audience.
   A viewer who is not allowed receives neither the text nor the fact
   that a hidden field exists. Birthdays can omit the year. */

import { inspectHandle } from "../../shared/handle-skeleton.js";
import { blocksEither, pairState } from "./social.js";
import { canSeeAudience, setListGrants } from "./audience.js";

export const ABOUT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS about_fields (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL,
    section TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    person_id TEXT NOT NULL DEFAULT '',
    show_year INTEGER NOT NULL DEFAULT 0,
    tz TEXT NOT NULL DEFAULT '',
    audience TEXT NOT NULL DEFAULT 'public',
    list_id TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS about_fields_owner ON about_fields(public_id, section, sort_order, created_at)",
  `CREATE TABLE IF NOT EXISTS about_field_allow (
    field_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (field_id, user_id)
  )`,
  "CREATE INDEX IF NOT EXISTS about_field_allow_user ON about_field_allow(user_id)",
  `CREATE TABLE IF NOT EXISTS birthday_prefs (
    public_id TEXT PRIMARY KEY,
    notes INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  )`
];

const SECTIONS = ["personal", "interests", "work", "links", "websites"];
const KINDS = {
  personal: ["city", "hometown", "birthday", "relationship", "family", "language"],
  interests: ["interest"],
  work: ["work", "education"],
  links: ["link"],
  websites: ["website"]
};
const AUDIENCES = ["public", "followers", "friends", "only", "list"];
const SENSITIVE = { birthday: 1, relationship: 1, family: 1 };
const TEXT_MAX = 8000;
const LABEL_MAX = 500;
const FIELD_CAP = 200;
const ALLOW_CAP = 200;
const ID = /^[a-f0-9]{32}$/;
const PUBLIC_ID = /^\d{12}$/;

function hex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function newId() {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

function rowsOf(result) {
  return (result && result.results) || [];
}

function chars(value) {
  return Array.from(String(value || ""));
}

function cleanText(value, max) {
  const text = String(value == null ? "" : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (chars(text).length > max) return null;
  return text;
}

function cleanUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length > 2000 || !/^https:\/\/[^\s]+$/i.test(text)) return null;
  return text;
}

export function defaultAudience(kind) {
  return SENSITIVE[kind] ? "only" : "public";
}

export function birthdayParts(text) {
  const raw = String(text || "").trim();
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return partsOf(Number(match[1]), Number(match[2]), Number(match[3]));
  match = raw.match(/^(\d{2})-(\d{2})$/);
  if (match) return partsOf(0, Number(match[1]), Number(match[2]));
  return null;
}

export const BIRTHDAY_MIN_AGE = 13;

/* A calendar birth date (YYYY-MM-DD or MM-DD) must be a real day, not in
   the future, and at least BIRTHDAY_MIN_AGE years ago. Free text from older
   About fields is left alone. "Today" is the latest calendar day anywhere
   (UTC+14), so nobody is turned away by their time zone. */
export function birthdayProblem(text, now) {
  const raw = String(text || "").trim();
  const full = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const short = raw.match(/^(\d{2})-(\d{2})$/);
  if (!full && !short) return "";
  const year = full ? Number(full[1]) : 0;
  const month = Number(full ? full[2] : short[1]);
  const day = Number(full ? full[3] : short[2]);
  const last = new Date(Date.UTC(year || 2000, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > last || (year && year < 1900)) return "birthday_invalid";
  if (!year) return "";
  const latest = new Date(Number(now || Date.now()) + 14 * 3600000);
  const ty = latest.getUTCFullYear();
  const tm = latest.getUTCMonth() + 1;
  const td = latest.getUTCDate();
  if (year > ty || (year === ty && (month > tm || (month === tm && day > td)))) return "birthday_invalid";
  let age = ty - year;
  let bm = month;
  let bd = day;
  if (bm === 2 && bd === 29 && new Date(Date.UTC(ty, 2, 0)).getUTCDate() !== 29) { bm = 3; bd = 1; }
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age < BIRTHDAY_MIN_AGE ? "birthday_too_young" : "";
}

function partsOf(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: year, month: month, day: day };
}

export function cleanZone(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(text)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: text }).format(0);
    return text;
  } catch (err) {
    return null;
  }
}

export function zonedYmd(ms, timeZone) {
  const zone = cleanZone(timeZone) || "UTC";
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

function leapDay(year, month, day) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(day, last);
}

export function daysUntilBirthday(parts, now, timeZone) {
  if (!parts) return null;
  const today = zonedYmd(now, timeZone);
  const start = Date.UTC(today.year, today.month - 1, today.day);
  let target = Date.UTC(today.year, parts.month - 1, leapDay(today.year, parts.month, parts.day));
  if (target < start) target = Date.UTC(today.year + 1, parts.month - 1, leapDay(today.year + 1, parts.month, parts.day));
  return Math.round((target - start) / 86400000);
}

export function publicBirthday(text, showYear) {
  const parts = birthdayParts(text);
  if (parts) {
    const month = String(parts.month).padStart(2, "0");
    const day = String(parts.day).padStart(2, "0");
    if (showYear && parts.year) return parts.year + "-" + month + "-" + day;
    return month + "-" + day;
  }
  const raw = String(text || "");
  if (showYear) return raw;
  return raw.replace(/\b(?:19|20)\d{2}\b/g, "").replace(/\s{2,}/g, " ").replace(/\s+,/g, ",").trim();
}

export function canSeeField(audience, relation, allowed) {
  if (!relation || relation.blocked) return false;
  if (relation.owner) return true;
  if (audience === "public") return true;
  if (audience === "followers") return !!relation.follows;
  if (audience === "friends") return !!(relation.friends || (relation.follows && relation.followsYou));
  if (audience === "list") return !!(relation.viewerId && allowed && allowed[relation.viewerId]);
  return false;
}

function kindOk(section, kind) {
  const list = KINDS[section];
  return !!(list && list.indexOf(kind) >= 0);
}

function audienceOf(value, kind) {
  const text = String(value || "");
  if (AUDIENCES.indexOf(text) >= 0) return text;
  return defaultAudience(kind);
}

async function loadOwner(env, viewer, handle) {
  if (handle) {
    const checked = inspectHandle(handle);
    const skel = checked.skeleton || "";
    let row = skel ? await env.DB.prepare("SELECT public_id, handle, display_name, profile_less FROM accounts WHERE skeleton = ?").bind(skel).first() : null;
    if (!row && PUBLIC_ID.test(handle)) {
      row = await env.DB.prepare("SELECT public_id, handle, display_name, profile_less FROM accounts WHERE public_id = ?").bind(handle).first();
    }
    return row || null;
  }
  if (!viewer) return null;
  return { public_id: viewer.public_id, handle: viewer.handle, display_name: viewer.display_name, profile_less: viewer.profile_less };
}

async function relationFor(env, viewer, ownerId, preview) {
  const viewerId = viewer && viewer.public_id ? viewer.public_id : "";
  const owner = !!(viewerId && viewerId === ownerId);
  if (owner && !preview) return { owner: true, follows: true, followsYou: true, friends: true, blocked: false, viewerId: viewerId };
  if (viewerId && viewerId !== ownerId && await blocksEither(env, viewerId, ownerId)) {
    return { owner: false, follows: false, followsYou: false, friends: false, blocked: true, viewerId: viewerId };
  }
  if (owner && preview === "public") return { owner: false, follows: false, followsYou: false, friends: false, blocked: false, viewerId: "" };
  if (owner && preview === "follower") return { owner: false, follows: true, followsYou: false, friends: false, blocked: false, viewerId: viewerId };
  if (!viewerId || viewerId === ownerId) return { owner: owner, follows: owner, followsYou: owner, friends: owner, blocked: false, viewerId: viewerId };
  const state = await pairState(env, viewerId, ownerId);
  if (state.viewerBlocks || state.blockedBy) {
    return { owner: false, follows: false, followsYou: false, friends: false, blocked: true, viewerId: viewerId };
  }
  return {
    owner: false,
    follows: !!state.following,
    followsYou: !!state.followsYou,
    friends: !!state.friends,
    blocked: false,
    viewerId: viewerId
  };
}

async function allowMap(env, ids) {
  const map = {};
  if (!ids.length) return map;
  const marks = ids.map(() => "?").join(",");
  const listed = await env.DB.prepare(
    "SELECT field_id, user_id FROM about_field_allow WHERE field_id IN (" + marks + ")"
  ).bind(...ids).all();
  rowsOf(listed).forEach((row) => {
    const bag = map[row.field_id] || (map[row.field_id] = {});
    if (PUBLIC_ID.test(String(row.user_id || ""))) bag[row.user_id] = 1;
  });
  return map;
}

async function personCard(env, personId) {
  if (!PUBLIC_ID.test(String(personId || ""))) return null;
  const row = await env.DB.prepare("SELECT handle, display_name FROM accounts WHERE public_id = ?").bind(personId).first();
  if (!row) return null;
  return { handle: row.handle || "", name: row.display_name || row.handle || "" };
}

function presentField(row, relation, person, showPrivate) {
  const birthday = row.kind === "birthday";
  const showYear = row.show_year === 1;
  const text = birthday ? publicBirthday(row.body, showPrivate ? true : showYear) : (row.body || "");
  const field = {
    id: row.id,
    section: row.section,
    kind: row.kind,
    text: text,
    label: row.label || "",
    url: row.url || ""
  };
  if (person) field.person = { handle: person.handle, name: person.name };
  if (showPrivate) {
    field.audience = row.audience;
    field.listId = row.list_id || "";
    field.showYear = showYear;
    if (row.kind === "birthday") field.tz = row.tz || "";
    if (row.person_id) field.personId = row.person_id;
    if (person) field.personHandle = person.handle;
  }
  return field;
}

async function readFields(env, request, viewer, ownerRow, preview) {
  const relation = await relationFor(env, viewer, ownerRow.public_id, preview);
  if (relation.blocked || (ownerRow.profile_less === 1 && !relation.owner)) {
    return { visible: false, owner: false, preview: preview || "", sections: [] };
  }
  const listed = await env.DB.prepare(
    "SELECT id, public_id, section, kind, body, label, url, person_id, show_year, tz, audience, list_id, sort_order FROM about_fields WHERE public_id = ? ORDER BY sort_order ASC, created_at ASC"
  ).bind(ownerRow.public_id).all();
  const rows = rowsOf(listed);
  const allows = await allowMap(env, rows.map((row) => row.id));
  const showPrivate = relation.owner && !preview;
  let birthdayToday = false;
  const grouped = {};
  SECTIONS.forEach((id) => { grouped[id] = []; });
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!kindOk(row.section, row.kind)) continue;
    const allowed = allows[row.id] || {};
    let see = canSeeField(row.audience, relation, allowed);
    if (!see && row.audience === "list" && relation.viewerId) {
      see = await canSeeAudience(env, {
        viewerId: relation.viewerId,
        ownerId: row.public_id,
        audience: "list",
        subject: "about",
        subjectId: row.id
      });
    }
    if (!see) continue;
    const person = row.kind === "family" ? await personCard(env, row.person_id) : null;
    if (row.kind === "birthday" && daysUntilBirthday(birthdayParts(row.body), Date.now(), row.tz) === 0) birthdayToday = true;
    grouped[row.section].push(presentField(row, relation, person, showPrivate));
  }
  const sections = [];
  SECTIONS.forEach((id) => {
    if (!grouped[id].length && !showPrivate) return;
    sections.push({ id: id, fields: grouped[id] });
  });
  const visible = sections.some((section) => section.fields.length > 0);
  let birthdayNotes = true;
  if (showPrivate) {
    const pref = await env.DB.prepare("SELECT notes FROM birthday_prefs WHERE public_id = ?").bind(ownerRow.public_id).first();
    if (pref && pref.notes === 0) birthdayNotes = false;
  }
  return {
    visible: showPrivate || visible,
    owner: showPrivate,
    preview: preview || "",
    birthdayToday: birthdayToday,
    birthdayNotes: showPrivate ? birthdayNotes : undefined,
    sections: sections
  };
}

async function replaceAllow(env, fieldId, members) {
  await env.DB.prepare("DELETE FROM about_field_allow WHERE field_id = ?").bind(fieldId).run();
  const unique = [];
  (members || []).forEach((id) => {
    const text = String(id || "");
    if (PUBLIC_ID.test(text) && unique.indexOf(text) < 0 && unique.length < ALLOW_CAP) unique.push(text);
  });
  if (!unique.length) return;
  await env.DB.batch(unique.map((id) => env.DB.prepare(
    "INSERT INTO about_field_allow (field_id, user_id) VALUES (?, ?) ON CONFLICT(field_id, user_id) DO NOTHING"
  ).bind(fieldId, id)));
}

async function resolvePerson(env, handle) {
  const text = String(handle || "").replace(/^@/, "").trim();
  if (!text) return "";
  const checked = inspectHandle(text);
  if (!checked.ok) return null;
  const row = await env.DB.prepare("SELECT public_id FROM accounts WHERE skeleton = ?").bind(checked.skeleton).first();
  return row ? row.public_id : null;
}

function readMembers(body) {
  const raw = body && (body.members || body.allow);
  if (!Array.isArray(raw)) return [];
  return raw.map((id) => String(id || "").replace(/^app:/, "")).filter((id) => PUBLIC_ID.test(id)).slice(0, ALLOW_CAP);
}

async function writeField(env, viewer, existing, body) {
  const section = String((body && body.section) || (existing && existing.section) || "");
  const kind = String((body && body.kind) || (existing && existing.kind) || "");
  if (!kindOk(section, kind)) return { error: "bad_field", status: 400 };
  const text = body && body.text != null ? cleanText(body.text, TEXT_MAX) : (existing ? existing.body : "");
  if (text == null) return { error: "too_large", status: 413 };
  if (!text) return { error: "text", status: 400 };
  const label = body && body.label != null ? cleanText(body.label, LABEL_MAX) : (existing ? existing.label : "");
  if (label == null) return { error: "too_large", status: 413 };
  const url = body && body.url != null ? cleanUrl(body.url) : (existing ? existing.url : "");
  if (url == null) return { error: "url", status: 400 };
  const audience = audienceOf(body && body.audience != null ? body.audience : (existing && existing.audience), kind);
  const listId = audience === "list" ? cleanText((body && body.listId) || "", 80) || "" : "";
  if (listId == null) return { error: "list", status: 400 };
  let personId = existing ? (existing.person_id || "") : "";
  if (kind === "family" && body && body.personHandle != null) {
    const resolved = await resolvePerson(env, body.personHandle);
    if (resolved == null) return { error: "bad_account", status: 400 };
    personId = resolved;
  } else if (kind !== "family") personId = "";
  const showYear = kind === "birthday" ? ((body && body.showYear != null) ? (body.showYear ? 1 : 0) : (existing ? existing.show_year : 0)) : 0;
  let tz = "";
  if (kind === "birthday" && body && body.text != null) {
    const why = birthdayProblem(text, Date.now());
    if (why) return { error: why, status: 400 };
  }
  if (kind === "birthday") {
    const asked = body && body.tz != null ? cleanZone(body.tz) : (existing ? existing.tz || "" : "");
    if (asked == null) return { error: "zone", status: 400 };
    tz = asked || "";
  }
  const sort = body && body.sort != null ? Math.max(0, Math.min(10000, Math.floor(Number(body.sort) || 0))) : (existing ? Number(existing.sort_order) || 0 : 0);
  const now = Date.now();
  const id = existing ? existing.id : newId();
  if (!existing) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM about_fields WHERE public_id = ?").bind(viewer.public_id).first();
    if (Number(count && count.n) >= FIELD_CAP) return { error: "too_many", status: 429 };
    await env.DB.prepare(
      "INSERT INTO about_fields (id, public_id, section, kind, body, label, url, person_id, show_year, tz, audience, list_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, viewer.public_id, section, kind, text, label || "", url || "", personId, showYear, tz, audience, listId, sort, now, now).run();
  } else {
    await env.DB.prepare(
      "UPDATE about_fields SET section = ?, kind = ?, body = ?, label = ?, url = ?, person_id = ?, show_year = ?, tz = ?, audience = ?, list_id = ?, sort_order = ?, updated_at = ? WHERE id = ? AND public_id = ?"
    ).bind(section, kind, text, label || "", url || "", personId, showYear, tz, audience, listId, sort, now, id, viewer.public_id).run();
  }
  if (audience === "list" && body && (body.members || body.allow)) await replaceAllow(env, id, readMembers(body));
  else if (audience !== "list") await env.DB.prepare("DELETE FROM about_field_allow WHERE field_id = ?").bind(id).run();
  if (audience === "list" && body && body.listIds) await setListGrants(env, viewer.public_id, "about", id, body.listIds);
  else if (audience !== "list") await setListGrants(env, viewer.public_id, "about", id, []);
  return { id: id };
}

export async function handleAbout(request, env, path, deps) {
  const url = new URL(request.url);
  const viewer = await deps.sessionAccount(env, request);
  if (path === "/v1/about" && request.method === "GET") {
    const handle = String(url.searchParams.get("handle") || "");
    const asked = String(url.searchParams.get("as") || "");
    const preview = (asked === "public" || asked === "follower") ? asked : "";
    const ownerRow = await loadOwner(env, viewer, handle);
    if (!ownerRow) return deps.json(handle ? 404 : 401, { error: handle ? "not_found" : "unauthorized" });
    if (ownerRow.profile_less === 1 && (!viewer || viewer.public_id !== ownerRow.public_id)) return deps.json(404, { error: "not_found" });
    if (preview && (!viewer || viewer.public_id !== ownerRow.public_id)) {
      return deps.json(200, await readFields(env, request, viewer, ownerRow, ""));
    }
    return deps.json(200, await readFields(env, request, viewer, ownerRow, preview));
  }
  if (!viewer) return deps.json(401, { error: "unauthorized" });
  if (path === "/v1/about" && request.method === "POST") {
    const paced = await deps.rateHit(env, "about-write:" + viewer.public_id, 60, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 24000);
    if (body.error) return deps.json(body.error === "too_large" ? 413 : 400, { error: body.error });
    const saved = await writeField(env, viewer, null, body);
    if (saved.error) return deps.json(saved.status, { error: saved.error });
    return deps.json(201, { id: saved.id });
  }
  if (path === "/v1/about/order" && request.method === "PUT") {
    const body = await deps.readJson(request, 8000);
    if (body.error) return deps.json(400, { error: body.error });
    const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id || "")).filter((id) => ID.test(id)) : [];
    if (!ids.length) return deps.json(400, { error: "ids" });
    const now = Date.now();
    await env.DB.batch(ids.map((id, index) => env.DB.prepare(
      "UPDATE about_fields SET sort_order = ?, updated_at = ? WHERE id = ? AND public_id = ?"
    ).bind(index, now, id, viewer.public_id)));
    return deps.json(200, { ok: true });
  }
  const one = path.match(/^\/v1\/about\/([a-f0-9]{32})$/);
  if (!one) return null;
  const row = await env.DB.prepare(
    "SELECT id, public_id, section, kind, body, label, url, person_id, show_year, tz, audience, list_id, sort_order FROM about_fields WHERE id = ?"
  ).bind(one[1]).first();
  if (!row || row.public_id !== viewer.public_id) return deps.json(404, { error: "not_found" });
  if (request.method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM about_field_allow WHERE field_id = ?").bind(row.id),
      env.DB.prepare("DELETE FROM about_fields WHERE id = ? AND public_id = ?").bind(row.id, viewer.public_id)
    ]);
    return deps.json(200, { ok: true });
  }
  if (request.method === "PATCH") {
    const paced = await deps.rateHit(env, "about-write:" + viewer.public_id, 60, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 24000);
    if (body.error) return deps.json(body.error === "too_large" ? 413 : 400, { error: body.error });
    const saved = await writeField(env, viewer, row, body);
    if (saved.error) return deps.json(saved.status, { error: saved.error });
    return deps.json(200, { id: saved.id });
  }
  return null;
}
