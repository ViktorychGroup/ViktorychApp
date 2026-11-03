import assert from "node:assert/strict";
import { canSeeIdentity } from "../shared/identity-audience.js";

const owner = { owner: true, viewerId: "111111111111" };
const stranger = { owner: false, follows: false, friends: false, blocked: false, viewerId: "222222222222" };
const follower = { owner: false, follows: true, followsYou: false, friends: false, blocked: false, viewerId: "222222222222" };
const mutual = { owner: false, follows: true, followsYou: true, friends: true, blocked: false, viewerId: "222222222222" };
const blocked = { owner: false, follows: true, friends: true, blocked: true, viewerId: "222222222222" };

assert.equal(canSeeIdentity({ audience: "public", hidden: false }, stranger, {}), true);
assert.equal(canSeeIdentity({ audience: "public", hidden: true }, stranger, {}), false);
assert.equal(canSeeIdentity({ audience: "public", hidden: true }, owner, {}), true);
assert.equal(canSeeIdentity({ audience: "followers", hidden: false }, stranger, {}), false);
assert.equal(canSeeIdentity({ audience: "followers", hidden: false }, follower, {}), true);
assert.equal(canSeeIdentity({ audience: "friends", hidden: false }, follower, {}), false);
assert.equal(canSeeIdentity({ audience: "friends", hidden: false }, mutual, {}), true);
assert.equal(canSeeIdentity({ audience: "only", hidden: false }, mutual, {}), false);
assert.equal(canSeeIdentity({ audience: "only", hidden: false }, owner, {}), true);
assert.equal(canSeeIdentity({ audience: "list", hidden: false }, mutual, {}), false);
assert.equal(canSeeIdentity({ audience: "list", hidden: false }, mutual, { "222222222222": 1 }), true);
assert.equal(canSeeIdentity({ audience: "public", hidden: false }, blocked, {}), false);

console.log("identity audience ok");

// Specific people: only a viewer the account chose sees the link.
const chosen = { owner: false, follows: false, followsYou: false, friends: false, blocked: false, viewerId: "v1" };
assert.equal(canSeeIdentity({ audience: "people", hidden: false }, chosen, { v1: 1 }), true);
assert.equal(canSeeIdentity({ audience: "people", hidden: false }, chosen, {}), false);
assert.equal(canSeeIdentity({ audience: "people", hidden: false }, Object.assign({}, chosen, { blocked: true }), { v1: 1 }), false);
console.log("identity audience people ok");
