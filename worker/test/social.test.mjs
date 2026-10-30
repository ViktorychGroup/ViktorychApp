import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";

let mf;

function workerOptions() {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    bindings: {
      ACCOUNT_PEPPER: "pepper-test",
      OWNER_CLAIM_CODE: "claim-test",
      OWNER_HANDLE: "mirathorn",
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000"
    }
  };
}

async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.10");
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.body) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch (err) { body = null; }
  return { status: res.status, body };
}

async function signup(ip, handle, name) {
  const created = await call("/v1/signup", {
    method: "POST",
    ip,
    body: { displayName: name, handle }
  });
  assert.equal(created.status, 201);
  return created.body;
}

function handlesOf(body) {
  return ((body && body.accounts) || []).map((row) => row.handle).sort();
}

function kindsOf(body) {
  return ((body && body.items) || []).map((row) => row.kind);
}

test.before(async () => {
  mf = new Miniflare(workerOptions());
});

test.after(async () => {
  if (mf) await mf.dispose();
});

test("a second follow does not double the count or the note", async () => {
  const north = await signup("203.0.113.40", "north_sg", "North Wind");
  const south = await signup("203.0.113.41", "south_sg", "South Dock");
  const first = await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.42",
    token: north.token,
    body: { id: "app:" + south.account.publicId }
  });
  const second = await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.43",
    token: north.token,
    body: { id: "app:" + south.account.publicId }
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.viewerFollows, true);
  assert.equal(second.body.followersCount, 1);
  assert.equal(second.body.followingCount, 1);
  const notes = await call("/v1/notifications", { ip: "203.0.113.44", token: south.token });
  assert.equal(kindsOf(notes.body).filter((kind) => kind === "follow").length, 1);
});

test("follow spam is refused in plain words", async () => {
  const north = await signup("203.0.113.45", "pace_sg", "Pace Lane");
  let last = null;
  for (let i = 0; i < 30; i++) {
    last = await call("/v1/follows", {
      method: "PUT",
      ip: "203.0.113.46",
      token: north.token,
      body: { id: "x:lane" + String(i).padStart(2, "0") }
    });
    assert.equal(last.status, 200);
  }
  const blocked = await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.47",
    token: north.token,
    body: { id: "x:lane30" }
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, "rate_limited");
  assert.equal(blocked.body.message, "Too many follows. Wait a few minutes and try again.");
});

test("a protected account keeps posts and lists hidden until the request is accepted", async () => {
  const north = await signup("203.0.113.48", "alpha_sg", "North Wind");
  const south = await signup("203.0.113.49", "beta_sg", "South Dock");
  const locked = await call("/v1/profile", {
    method: "PATCH",
    ip: "203.0.113.50",
    token: south.token,
    body: { protected: true }
  });
  assert.equal(locked.status, 200);
  assert.equal(locked.body.account.protected, true);

  const asked = await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.51",
    token: north.token,
    body: { id: "app:" + south.account.publicId }
  });
  assert.equal(asked.body.pending, true);
  assert.equal(asked.body.viewerFollows, false);
  assert.equal(asked.body.followersCount, 0);
  const again = await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.52",
    token: north.token,
    body: { id: "app:" + south.account.publicId }
  });
  assert.equal(again.body.pending, true);
  const notes = await call("/v1/notifications", { ip: "203.0.113.53", token: south.token });
  assert.equal(kindsOf(notes.body).filter((kind) => kind === "follow_request").length, 1);

  const hidden = await call("/v1/profile/beta_sg", { ip: "203.0.113.54", token: north.token });
  assert.equal(hidden.body.account.locked, true);
  assert.equal(hidden.body.account.viewerPending, true);
  assert.equal(hidden.body.reposts.length, 0);
  const lists = await call("/v1/follows?id=" + encodeURIComponent("app:" + south.account.publicId) + "&tab=followers", {
    ip: "203.0.113.55",
    token: north.token
  });
  assert.equal(lists.body.locked, true);
  assert.equal(lists.body.accounts.length, 0);

  const wrote = await call("/v1/posts", {
    method: "POST",
    ip: "203.0.113.56",
    token: south.token,
    body: { text: "A protected note" }
  });
  assert.equal(wrote.status, 200);
  const unseen = await call("/v1/posts?id=" + encodeURIComponent(south.account.publicId), { ip: "203.0.113.57", token: north.token });
  assert.equal(unseen.body.posts.length, 0);

  const cancelled = await call("/v1/follows", {
    method: "DELETE",
    ip: "203.0.113.58",
    token: north.token,
    body: { id: "app:" + south.account.publicId }
  });
  assert.equal(cancelled.status, 200);
  await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.59",
    token: north.token,
    body: { id: "app:" + south.account.publicId }
  });
  const declined = await call("/v1/follows/decline", {
    method: "POST",
    ip: "203.0.113.60",
    token: south.token,
    body: { id: "app:" + north.account.publicId }
  });
  assert.equal(declined.status, 200);
  await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.61",
    token: north.token,
    body: { id: "app:" + south.account.publicId }
  });
  const accepted = await call("/v1/follows/accept", {
    method: "POST",
    ip: "203.0.113.62",
    token: south.token,
    body: { id: "app:" + north.account.publicId }
  });
  assert.equal(accepted.status, 200);
  const seen = await call("/v1/posts?id=" + encodeURIComponent(south.account.publicId), { ip: "203.0.113.63", token: north.token });
  assert.equal(seen.body.posts.length, 1);
  const open = await call("/v1/profile/beta_sg", { ip: "203.0.113.64", token: north.token });
  assert.equal(open.body.account.viewerFollows, true);
  assert.equal(open.body.account.locked, undefined);
  const acceptedNotes = await call("/v1/notifications", { ip: "203.0.113.65", token: north.token });
  assert.equal(kindsOf(acceptedNotes.body).includes("follow_accept"), true);
  const southNotes = await call("/v1/notifications", { ip: "203.0.113.66", token: south.token });
  assert.equal(kindsOf(southNotes.body).includes("follow"), false);
});

test("lists page, search, remove a follower, and show mutuals", async () => {
  const north = await signup("203.0.113.70", "list_sg", "List Keeper");
  const south = await signup("203.0.113.71", "mate_sg", "Mate Shore");
  for (let i = 0; i < 21; i++) {
    const row = await call("/v1/follows", {
      method: "PUT",
      ip: "203.0.113.72",
      token: north.token,
      body: {
        id: "x:row" + String(i).padStart(2, "0"),
        profile: { name: i === 3 ? "Cedar Post" : "Row " + i, handle: "row" + i, platform: "x" }
      }
    });
    assert.equal(row.status, 200);
  }
  const page = await call("/v1/follows?id=" + encodeURIComponent("app:" + north.account.publicId) + "&tab=following", {
    ip: "203.0.113.73",
    token: north.token
  });
  assert.equal(page.body.accounts.length, 20);
  assert.ok(page.body.cursor);
  const next = await call("/v1/follows?id=" + encodeURIComponent("app:" + north.account.publicId) + "&tab=following&cursor=" + encodeURIComponent(page.body.cursor), {
    ip: "203.0.113.74",
    token: north.token
  });
  assert.equal(next.body.accounts.length, 1);
  const found = await call("/v1/follows?id=" + encodeURIComponent("app:" + north.account.publicId) + "&tab=following&q=cedar", {
    ip: "203.0.113.75",
    token: north.token
  });
  assert.equal(found.body.accounts.length, 1);
  assert.equal(found.body.accounts[0].name, "Cedar Post");

  await call("/v1/follows", { method: "PUT", ip: "203.0.113.76", token: south.token, body: { id: "app:" + north.account.publicId } });
  await call("/v1/follows", { method: "PUT", ip: "203.0.113.77", token: north.token, body: { id: "app:" + south.account.publicId } });
  const followers = await call("/v1/follows?id=" + encodeURIComponent("app:" + north.account.publicId) + "&tab=followers", {
    ip: "203.0.113.78",
    token: north.token
  });
  assert.deepEqual(handlesOf(followers.body), ["mate_sg"]);
  assert.equal(followers.body.accounts[0].followsYou, true);
  assert.equal(followers.body.accounts[0].removable, true);
  const mutuals = await call("/v1/follows?id=" + encodeURIComponent("app:" + north.account.publicId) + "&tab=mutuals", {
    ip: "203.0.113.79",
    token: north.token
  });
  assert.deepEqual(handlesOf(mutuals.body), ["mate_sg"]);
  const removed = await call("/v1/follows/remove", {
    method: "POST",
    ip: "203.0.113.80",
    token: north.token,
    body: { id: "app:" + south.account.publicId }
  });
  assert.equal(removed.status, 200);
  const after = await call("/v1/follows?id=" + encodeURIComponent("app:" + north.account.publicId) + "&tab=followers", {
    ip: "203.0.113.81",
    token: north.token
  });
  assert.equal(after.body.accounts.length, 0);
});

test("a block hides both sides and a mute hides without a note", async () => {
  const north = await signup("203.0.113.90", "block_sg", "Block North");
  const south = await signup("203.0.113.91", "quiet_sg", "Quiet South");
  await call("/v1/follows", { method: "PUT", ip: "203.0.113.92", token: north.token, body: { id: "app:" + south.account.publicId } });
  await call("/v1/follows", { method: "PUT", ip: "203.0.113.93", token: south.token, body: { id: "app:" + north.account.publicId } });
  const muted = await call("/v1/mutes", { method: "PUT", ip: "203.0.113.94", token: north.token, body: { id: south.account.publicId } });
  assert.equal(muted.status, 200);
  assert.equal(muted.body.ok, true);
  const still = await call("/v1/follows", { ip: "203.0.113.95", token: north.token });
  assert.equal(still.body.ids.indexOf("app:@" + south.account.handle) >= 0, true);
  const quietNotes = await call("/v1/notifications", { ip: "203.0.113.96", token: north.token });
  assert.equal(kindsOf(quietNotes.body).includes("follow"), false);
  await call("/v1/posts", { method: "POST", ip: "203.0.113.97", token: south.token, body: { text: "Muted line" } });
  const hiddenPosts = await call("/v1/posts?id=" + encodeURIComponent(south.account.publicId), { ip: "203.0.113.98", token: north.token });
  assert.equal(hiddenPosts.body.posts.length, 0);
  const mailed = await call("/v1/messages", { method: "POST", ip: "203.0.113.99", token: south.token, body: { id: north.account.publicId, text: "hello there" } });
  assert.equal(mailed.status, 200);
  const inbox = await call("/v1/messages?id=" + encodeURIComponent(south.account.publicId), { ip: "203.0.113.100", token: north.token });
  assert.equal(inbox.body.messages.length, 0);

  const blocked = await call("/v1/blocks", { method: "PUT", ip: "203.0.113.101", token: north.token, body: { id: south.account.publicId } });
  assert.equal(blocked.status, 200);
  const mine = await call("/v1/follows", { ip: "203.0.113.102", token: north.token });
  assert.equal(mine.body.ids.indexOf("app:@" + south.account.handle) >= 0, false);
  const theirs = await call("/v1/follows", { ip: "203.0.113.103", token: south.token });
  assert.equal(theirs.body.ids.indexOf("app:@" + north.account.handle) >= 0, false);
  const seen = await call("/v1/profile/quiet_sg", { ip: "203.0.113.104", token: north.token });
  assert.equal(seen.body.account.viewerBlocks, true);
  assert.equal(seen.body.reposts.length, 0);
  const wall = await call("/v1/profile/block_sg", { ip: "203.0.113.105", token: south.token });
  assert.equal(wall.body.account.blockedBy, true);
  assert.equal(wall.body.account.bio, undefined);
  assert.equal(wall.body.reposts.length, 0);
  const people = await call("/v1/people?q=quiet", { ip: "203.0.113.106", token: north.token });
  assert.equal(handlesOf(people.body).indexOf("quiet_sg") >= 0, false);
  const dm = await call("/v1/messages", { method: "POST", ip: "203.0.113.107", token: south.token, body: { id: north.account.publicId, text: "still here" } });
  assert.equal(dm.status, 403);
  const list = await call("/v1/blocks", { ip: "203.0.113.108", token: north.token });
  assert.deepEqual(handlesOf(list.body), ["quiet_sg"]);
  const friend = await call("/v1/friends/request", { method: "POST", ip: "203.0.113.109", token: south.token, body: { targetId: north.account.publicId } });
  assert.equal(friend.status, 403);
  const opened = await call("/v1/blocks", { method: "DELETE", ip: "203.0.113.110", token: north.token, body: { id: south.account.publicId } });
  assert.equal(opened.status, 200);
  const restored = await call("/v1/follows", { ip: "203.0.113.111", token: north.token });
  assert.equal(restored.body.ids.indexOf("app:@" + south.account.handle) >= 0, false);
});

test("a friend accept needs a real request, and a protected account can still follow someone", async () => {
  const north = await signup("203.0.113.120", "gate_sg", "Gate House");
  const south = await signup("203.0.113.121", "open_sg", "Open Yard");
  const bare = await call("/v1/friends/accept", { method: "POST", ip: "203.0.113.122", token: north.token, body: { targetId: south.account.publicId } });
  assert.equal(bare.status, 200);
  assert.equal(bare.body.status, "none");
  assert.equal(bare.body.friendsCount, 0);
  await call("/v1/profile", { method: "PATCH", ip: "203.0.113.123", token: north.token, body: { protected: true } });
  const followed = await call("/v1/follows", { method: "PUT", ip: "203.0.113.124", token: north.token, body: { id: "app:" + south.account.publicId } });
  assert.equal(followed.body.viewerFollows, true);
  assert.equal(followed.body.pending, undefined);
  // Only accounts older than the owner-only start (#280) bulk-import follows.
  const legacyDb = await mf.getD1Database("DB");
  await legacyDb.prepare("UPDATE accounts SET created_at = ? WHERE public_id = ?").bind(Date.UTC(2026, 9, 28, 18, 4, 30) - 86400000, south.account.publicId).run();
  const imported = await call("/v1/follows/import", {
    method: "POST",
    ip: "203.0.113.125",
    token: south.token,
    body: { ids: ["app:" + north.account.publicId, "x:plainyard"] }
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.followingCount, 1);
  const ids = await call("/v1/follows", { ip: "203.0.113.126", token: south.token });
  assert.equal(ids.body.ids.indexOf("app:@" + north.account.handle) >= 0, false);
  assert.equal(ids.body.ids.indexOf("x:plainyard") >= 0, true);
});
