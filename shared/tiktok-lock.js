/* One check for a notification about a TikTok account.
   The Shorts lock and the unlock list stay where they already live.
   This file only decides whether a row is hidden.

   Locked posts stay in the feed and show again when the lock lifts.
   Notifications do the same. The row stays stored and shows in the list
   once that account is on the unlock list, or once the Shorts lock is off.
   A buzz that was skipped while the account was locked is not sent later.
   New notes after the account is unlocked are delivered and counted. */

function foldHandle(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function tiktokSubject(item) {
  if (!item || typeof item !== "object") return null;
  const platform = String(item.platform || "").toLowerCase();
  const feedId = String(item.feedId || "");
  const hash = String(item.hash || "");
  const id = String(item.id || "");
  const looks = platform === "tiktok"
    || feedId.indexOf("tiktok:") === 0
    || hash.indexOf("#/tiktok/") === 0
    || id.indexOf("tiktok:") === 0
    || id.indexOf("live:tiktok:") === 0;
  if (!looks) return null;
  let handle = foldHandle(item.handle || item.account || "");
  if (!handle && feedId.indexOf("tiktok:") === 0) handle = foldHandle(feedId.slice("tiktok:".length).split(":")[0]);
  if (!handle && hash.indexOf("#/tiktok/") === 0) {
    const raw = hash.slice("#/tiktok/".length).split("/")[0];
    try { handle = foldHandle(decodeURIComponent(raw)); }
    catch (err) { handle = foldHandle(raw); }
  }
  return { handle: handle };
}

function unlockedHas(unlocked, handle) {
  if (!handle) return false;
  if (typeof unlocked === "function") {
    try { return !!unlocked(handle); }
    catch (err) { return false; }
  }
  if (unlocked && typeof unlocked.has === "function") {
    return unlocked.has(handle) || unlocked.has(foldHandle(handle));
  }
  if (Array.isArray(unlocked)) {
    const want = foldHandle(handle);
    return unlocked.some((item) => foldHandle(typeof item === "string" ? item : item && item.handle) === want);
  }
  return false;
}

/* viewer.locked defaults to on. Pass locked:false only when the Shorts
   lock is off. viewer.unlocked is the same list Shorts already loaded:
   a function, a Set, or an array. It is not a second copy of the list. */
function tiktokNoteHidden(item, viewer) {
  const subject = tiktokSubject(item);
  if (!subject) return false;
  const view = viewer && typeof viewer === "object" ? viewer : {};
  const owner = view.owner === true || view.owner === 1;
  const audienceAll = view.audienceAll === true || view.audience === "all";
  if (!owner && !audienceAll) return true;
  if (view.locked === false) return false;
  if (!subject.handle) return true;
  return !unlockedHas(view.unlocked, subject.handle);
}

function visibleNotes(notes, viewer) {
  return (Array.isArray(notes) ? notes : []).filter((item) => !tiktokNoteHidden(item, viewer));
}

/* The owner's TikTok follows sit on the private following list while Shorts
   can see them, and on the normal list while the same check would hide them.
   That is the Shorts page unlocked (or this account unlocked) versus locked. */
function tiktokFollowPrivate(item, viewer) {
  const subject = tiktokSubject(item);
  if (!subject) return false;
  const view = viewer && typeof viewer === "object" ? viewer : {};
  if (!(view.owner === true || view.owner === 1)) return false;
  return !tiktokNoteHidden(item, view);
}

const api = {
  foldHandle: foldHandle,
  tiktokSubject: tiktokSubject,
  tiktokNoteHidden: tiktokNoteHidden,
  visibleNotes: visibleNotes,
  tiktokFollowPrivate: tiktokFollowPrivate
};

export { foldHandle, tiktokSubject, tiktokNoteHidden, visibleNotes, tiktokFollowPrivate };
globalThis.TiktokLock = api;
