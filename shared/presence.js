/* Presence and custom status rules shared by the Worker and the page.
   Last-seen wording follows Telegram. While reciprocity is on, exact
   times stay hidden both ways: if either person would not show the
   other an exact time, both see "last seen recently". Turning
   reciprocity off still hides you from them, and lets you see someone
   whose own setting allows you. */

export const WRITE_WINDOW_MS = 55000;
export const STALE_MS = 150000;
export const IDLE_MS = 5 * 60 * 1000;
export const HEARTBEAT_MS = 60000;
export const STATUS_MAX = 80;
export const PRESENCE_CACHE_MS = 20000;
export const PRESENCE_CLIENT_MS = 12000;
export const WATCH_LIMIT = 30;

const PREFERENCES = ["online", "idle", "dnd", "invisible"];
const ACTIVITIES = ["active", "idle", "hidden"];
const PRIVACY = ["everyone", "follows", "followers", "mutuals", "lists", "nobody"];
const CLEARS = ["30m", "1h", "4h", "today", "week", "never"];

export function normalizePreference(value) {
  const text = String(value || "");
  return PREFERENCES.indexOf(text) >= 0 ? text : "online";
}

export function normalizeActivity(value) {
  const text = String(value || "");
  return ACTIVITIES.indexOf(text) >= 0 ? text : "hidden";
}

export function normalizePrivacy(value) {
  const text = String(value || "");
  return PRIVACY.indexOf(text) >= 0 ? text : "everyone";
}

export function normalizeClear(value) {
  const text = String(value || "");
  return CLEARS.indexOf(text) >= 0 ? text : "";
}

export function cleanStatusText(value) {
  const text = String(value || "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  if (chars.length > STATUS_MAX) return chars.slice(0, STATUS_MAX).join("");
  return text;
}

export function cleanEmoji(value) {
  const text = String(value || "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  let parts;
  try {
    parts = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (row) => row.segment);
  } catch (err) {
    parts = Array.from(text);
  }
  if (parts.length > 8) return parts.slice(0, 8).join("");
  return text;
}

export function isAccountId(value) {
  return /^\d{12}$/.test(String(value || ""));
}

export function clearAtFrom(choice, now, clientAt) {
  const n = Number(now) || 0;
  const mode = normalizeClear(choice);
  if (!mode || mode === "never") return 0;
  if (mode === "30m") return n + 30 * 60 * 1000;
  if (mode === "1h") return n + 60 * 60 * 1000;
  if (mode === "4h") return n + 4 * 60 * 60 * 1000;
  const at = Number(clientAt) || 0;
  const max = mode === "today" ? 36 * 60 * 60 * 1000 : 8 * 24 * 60 * 60 * 1000;
  if (at > n && at - n <= max) return at;
  if (mode === "today") {
    const day = new Date(n);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  }
  return n + 7 * 24 * 60 * 60 * 1000;
}

export function effectiveState(row, now) {
  const preference = normalizePreference(row && (row.preference));
  const activity = normalizeActivity(row && (row.activity));
  const lastBeat = Number(row && (row.last_beat != null ? row.last_beat : row.lastBeat)) || 0;
  const lastSeen = Number(row && (row.last_seen != null ? row.last_seen : row.lastSeen)) || 0;
  const fresh = lastBeat > 0 && (Number(now) || 0) - lastBeat < STALE_MS;
  if (!fresh || preference === "invisible") {
    return { state: "offline", lastSeen, preference, fresh: false };
  }
  if (preference === "dnd") return { state: "dnd", lastSeen, preference, fresh: true };
  if (preference === "idle" || activity === "idle" || activity === "hidden") {
    return { state: "idle", lastSeen, preference, fresh: true };
  }
  if (activity === "active") return { state: "online", lastSeen, preference, fresh: true };
  return { state: "offline", lastSeen, preference, fresh: false };
}

export function applyBeat(prev, activity, now) {
  const preference = normalizePreference(prev && prev.preference);
  const seenPrivacy = normalizePrivacy(prev && (prev.seen_privacy || prev.seenPrivacy));
  const next = {
    preference,
    activity: normalizeActivity(activity),
    seenPrivacy,
    lastBeat: Number(now) || 0,
    lastSeen: Number(prev && (prev.last_seen != null ? prev.last_seen : prev.lastSeen)) || 0
  };
  if (preference !== "invisible") next.lastSeen = next.lastBeat;
  return next;
}

export function shouldWriteBeat(prev, next, now, windowMs) {
  if (!prev) return true;
  const limit = Number(windowMs) > 0 ? Number(windowMs) : WRITE_WINDOW_MS;
  const prevPref = normalizePreference(prev.preference);
  const prevActivity = normalizeActivity(prev.activity);
  const prevPrivacy = normalizePrivacy(prev.seen_privacy || prev.seenPrivacy);
  if (prevPref !== next.preference) return true;
  if (prevActivity !== next.activity) return true;
  if (prevPrivacy !== next.seenPrivacy) return true;
  const last = Number(prev.last_beat != null ? prev.last_beat : prev.lastBeat) || 0;
  if ((Number(now) || 0) - last >= limit) return true;
  return false;
}

export function listIds(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  const out = [];
  raw.split(",").forEach((part) => {
    const id = part.trim().toLowerCase();
    if (/^[a-f0-9]{32}$/.test(id) && out.indexOf(id) < 0) out.push(id);
  });
  return out.slice(0, 12);
}

export function relationAllows(privacy, rel) {
  const mode = normalizePrivacy(privacy);
  const link = rel || {};
  if (mode === "nobody") return false;
  if (mode === "followers") return !!link.followsSubject;
  if (mode === "mutuals") return !!link.friends || (!!link.followsSubject && !!link.subjectFollows);
  if (mode === "lists") return !!link.onList;
  if (mode === "follows") return !!(link.followsSubject || link.subjectFollows);
  return true;
}

export function privacyAllows(privacy, iFollow, followsMe) {
  return relationAllows(privacy, { followsSubject: !!iFollow, subjectFollows: !!followsMe });
}

export function canSeeExact(viewerPrivacy, targetPrivacy, viewerFollowsTarget, targetFollowsViewer, same, opts) {
  if (same) return true;
  const extra = opts || {};
  const reciprocal = extra.reciprocal == null ? true : !!extra.reciprocal;
  const targetOk = relationAllows(targetPrivacy, {
    followsSubject: viewerFollowsTarget,
    subjectFollows: targetFollowsViewer,
    friends: extra.friends,
    onList: extra.targetList
  });
  if (!targetOk) return false;
  if (!reciprocal) return true;
  return relationAllows(viewerPrivacy, {
    followsSubject: targetFollowsViewer,
    subjectFollows: viewerFollowsTarget,
    friends: extra.friends,
    onList: extra.viewerList
  });
}

export function activeStatus(status, now) {
  if (!status) return { emoji: "", text: "", clearAt: 0 };
  const clearAt = Number(status.clear_at != null ? status.clear_at : status.clearAt) || 0;
  if (clearAt > 0 && clearAt <= (Number(now) || 0)) return { emoji: "", text: "", clearAt: 0 };
  return {
    emoji: cleanEmoji(status.emoji),
    text: cleanStatusText(status.text != null ? status.text : status.body),
    clearAt
  };
}

export function publicPresence(presence, status, exact, now, self) {
  const effect = effectiveState(presence, now);
  const custom = activeStatus(status, now);
  const view = {
    state: effect.state,
    exact: !!exact,
    lastSeen: exact ? effect.lastSeen : 0,
    emoji: custom.emoji,
    text: custom.text
  };
  if (self) {
    const rawReciprocal = presence && (presence.reciprocal != null ? presence.reciprocal : presence.reciprocalFlag);
    view.preference = effect.preference;
    view.seenPrivacy = normalizePrivacy(presence && (presence.seen_privacy || presence.seenPrivacy));
    view.reciprocal = rawReciprocal == null ? true : Number(rawReciprocal) !== 0;
    view.seenLists = listIds(presence && (presence.seen_lists != null ? presence.seen_lists : presence.seenLists));
    view.clearAt = custom.clearAt;
    if (effect.preference === "invisible") view.state = "invisible";
  } else if (!exact || effect.preference === "invisible") {
    view.state = "offline";
    view.lastSeen = 0;
    view.exact = false;
  }
  return view;
}

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function clock(ms) {
  const day = new Date(ms);
  return pad(day.getHours()) + ":" + pad(day.getMinutes());
}

function dayStart(ms) {
  const day = new Date(ms);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
}

/* Telegram-style buckets. `exact` false is always "last seen recently". */
export function lastSeenPhrase(lastSeen, now, exact, state) {
  if (state === "online") return { key: "Online", vars: null };
  if (state === "idle") return { key: "Idle", vars: null };
  if (state === "dnd") return { key: "Do not disturb", vars: null };
  if (state === "invisible") return { key: "Invisible", vars: null };
  if (!exact) return { key: "last seen recently", vars: null };
  const seen = Number(lastSeen) || 0;
  const at = Number(now) || 0;
  if (!seen || seen > at) return { key: "", vars: null };
  const delta = at - seen;
  if (delta < 60 * 1000) return { key: "last seen just now", vars: null };
  if (delta < 60 * 60 * 1000) {
    const count = Math.max(1, Math.floor(delta / 60000));
    return { key: "last seen {count} min ago", vars: { count: count } };
  }
  const days = Math.round((dayStart(at) - dayStart(seen)) / 86400000);
  if (days <= 0) return { key: "last seen today at {time}", vars: { time: clock(seen) } };
  if (days === 1) return { key: "last seen yesterday", vars: null };
  if (days < 3) return { key: "last seen recently", vars: null };
  if (days < 8) return { key: "last seen within a week", vars: null };
  return { key: "last seen a long time ago", vars: null };
}

export function shouldConnect(visibility) {
  return visibility === "visible";
}

const api = {
  normalizePreference,
  normalizeActivity,
  normalizePrivacy,
  listIds,
  cleanStatusText,
  cleanEmoji,
  clearAtFrom,
  effectiveState,
  applyBeat,
  shouldWriteBeat,
  canSeeExact,
  publicPresence,
  lastSeenPhrase,
  shouldConnect,
  activeStatus
};
globalThis.PresenceRules = api;
