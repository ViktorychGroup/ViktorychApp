import assert from "node:assert/strict";
import { tiktokFollowPrivate, tiktokNoteHidden, visibleNotes } from "../shared/tiktok-lock.js";

const locked = { id: "locked-row", platform: "tiktok", handle: "lockedacct", feedId: "tiktok:lockedacct", text: "hidden row", read: false, at: 30 };
const open = { id: "open-row", platform: "tiktok", handle: "openacct", feedId: "tiktok:openacct", text: "shown row", read: false, at: 20 };
const other = { id: "plain-row", platform: "x", handle: "readerlock", text: "hello", read: false, at: 10 };
const ownerLocked = { owner: true, locked: true, unlocked: ["openacct"] };

assert.equal(tiktokNoteHidden(locked, ownerLocked), true, "a locked account stays hidden for the owner");
assert.equal(tiktokNoteHidden(open, ownerLocked), false, "an unlocked account stays visible for the owner");
assert.equal(tiktokNoteHidden(locked, { owner: true, locked: false, unlocked: [] }), false, "turning the lock off shows a stored row");
assert.equal(tiktokNoteHidden(open, { owner: false, audienceAll: false, locked: false, unlocked: ["openacct"] }), true, "someone who is not the owner does not see it");
assert.equal(tiktokNoteHidden(open, { owner: false, audienceAll: true, locked: true, unlocked: ["openacct"] }), false, "a public audience can see an unlocked account");
assert.equal(tiktokNoteHidden(locked, { owner: false, audienceAll: true, locked: true, unlocked: ["openacct"] }), true, "a public audience still hides a locked account");
assert.equal(tiktokNoteHidden(other, ownerLocked), false, "another platform is left alone");
assert.equal(tiktokNoteHidden({ platform: "tiktok", feedId: "tiktok:" }, ownerLocked), true, "a tiktok row with no account stays hidden");

const visible = visibleNotes([locked, open, other], ownerLocked);
assert.deepEqual(visible.map((note) => note.id), ["open-row", "plain-row"], "the list drops the locked row");
const unread = visible.filter((note) => !note.read).length;
assert.equal(unread, 2, "the badge count skips the locked row");
assert.equal(visibleNotes([locked], { owner: true, locked: true, unlocked: function (name) { return name === "lockedacct"; } }).length, 1, "the same unlock check the Shorts lock uses");

const follow = { platform: "tiktok", handle: "alpha_one", feedId: "tiktok:alpha_one" };
assert.equal(tiktokFollowPrivate(follow, { owner: true, locked: false, unlocked: [] }), true, "shorts unlocked puts the follow on the private list");
assert.equal(tiktokFollowPrivate(follow, { owner: true, locked: true, unlocked: [] }), false, "shorts locked puts the follow on the normal list");
assert.equal(tiktokFollowPrivate(follow, { owner: true, locked: true, unlocked: ["alpha_one"] }), true, "an unlocked account stays on the private list");
assert.equal(tiktokFollowPrivate(follow, { owner: false, locked: false, unlocked: [] }), false, "someone else's list is unchanged");
assert.equal(tiktokFollowPrivate({ platform: "x", handle: "alpha_one" }, { owner: true, locked: false }), false, "other networks stay where they are");

console.log("ok tiktok lock");
