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
  catch (err) { body = { raw: text }; }
  return { status: res.status, body, text };
}

async function signup(ip, handle, name) {
  const created = await call("/v1/signup", {
    method: "POST",
    ip,
    body: { displayName: name, handle }
  });
  assert.equal(created.status, 201, created.text);
  return created.body;
}

test.before(async () => {
  mf = new Miniflare(workerOptions());
});

test.after(async () => {
  if (mf) await mf.dispose();
});

test("signed-in follow sync returns every account past the first page", async () => {
  const ada = await signup("203.0.113.80", "ada_page", "Ada Page");
  const db = await mf.getD1Database("DB");
  const follower = ada.account.publicId;
  const stmts = [];
  for (let i = 0; i < 501; i++) {
    stmts.push(db.prepare("INSERT INTO account_follows (follower_id, target_id, snapshot, created_at) VALUES (?, ?, '', ?)").bind(follower, "x:acct" + String(i).padStart(4, "0"), 1700000000000 + i));
  }
  for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
  const mine = await call("/v1/follows", { ip: "203.0.113.81", token: ada.token });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.ids.length, 501);
  assert.equal(mine.body.ids[0], "x:acct0500");
  assert.equal(mine.body.ids[500], "x:acct0000");
});

test("follows persist for the signed-in account and stay private", async () => {
  const closed = await call("/v1/follows", { ip: "203.0.113.210" });
  assert.equal(closed.status, 401);

  const ada = await signup("203.0.113.211", "ada_fl", "Ada Follow");
  const bea = await signup("203.0.113.212", "bea_fl", "Bea Follow");
  const bio = await call("/v1/profile", {
    method: "PATCH",
    ip: "203.0.113.213",
    token: ada.token,
    body: { bio: "Ada builds engines" }
  });
  assert.equal(bio.status, 200);

  const self = await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.214",
    token: ada.token,
    body: { id: "app:" + ada.account.publicId }
  });
  assert.equal(self.status, 400);

  const bad = await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.215",
    token: ada.token,
    body: { id: "../secret" }
  });
  assert.equal(bad.status, 400);

  const followed = await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.216",
    token: ada.token,
    body: { id: "app:" + bea.account.publicId }
  });
  assert.equal(followed.status, 200);
  assert.equal(followed.body.viewerFollows, true);
  assert.equal(followed.body.followingCount, 1);
  assert.equal(followed.body.followersCount, 1);

  const outside = await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.217",
    token: ada.token,
    body: {
      id: "x:copperlane",
      profile: {
        name: "Copper Lane",
        handle: "copperlane",
        platform: "x",
        bio: "Mars",
        avatar: "https://cdn.example/elon.jpg",
        email: "secret@example.com"
      }
    }
  });
  assert.equal(outside.status, 200);
  assert.equal(outside.body.followingCount, 2);
  assert.equal(outside.body.followersCount, 1);

  const adaProfile = await call("/v1/profile/ada_fl", { ip: "203.0.113.218", token: bea.token });
  assert.equal(adaProfile.status, 200);
  assert.equal(adaProfile.body.account.followingCount, 2);
  assert.equal(adaProfile.body.account.followersCount, 0);
  const beaProfile = await call("/v1/profile/bea_fl", { ip: "203.0.113.219", token: ada.token });
  assert.equal(beaProfile.body.account.followersCount, 1);
  assert.equal(beaProfile.body.account.viewerFollows, true);

  const otherDevice = await call("/v1/login", {
    method: "POST",
    ip: "203.0.113.220",
    body: { accountNumber: ada.accountNumber }
  });
  assert.equal(otherDevice.status, 200);
  const mine = await call("/v1/follows", { ip: "203.0.113.221", token: otherDevice.body.token });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.followingCount, 2);
  assert.deepEqual(mine.body.ids.sort(), ["app:@bea_fl", "x:copperlane"].sort());

  const following = await call("/v1/follows?id=" + encodeURIComponent("app:" + ada.account.publicId) + "&tab=following", {
    ip: "203.0.113.222",
    token: bea.token
  });
  assert.equal(following.status, 200);
  assert.equal(following.body.accounts.length, 2);
  const beaRow = following.body.accounts.find((row) => row.id === "app:@bea_fl");
  const elon = following.body.accounts.find((row) => row.id === "x:copperlane");
  assert.equal(beaRow.kind, "account");
  assert.equal(beaRow.handle, "bea_fl");
  assert.equal(beaRow.name, "Bea Follow");
  assert.equal(elon.kind, "feed");
  assert.equal(elon.handle, "copperlane");
  assert.equal(elon.bio, "Mars");
  assert.equal(elon.name, "Copper Lane");
  const dumped = JSON.stringify(following.body);
  assert.equal(dumped.includes("secret@example.com"), false);
  assert.equal(dumped.includes("accountNumber"), false);
  assert.equal(dumped.includes("number_hash"), false);
  assert.equal(dumped.includes("number_lookup"), false);
  assert.equal(dumped.includes("\"salt\""), false);
  assert.equal(dumped.includes("email"), false);

  const followers = await call("/v1/follows?id=" + encodeURIComponent("x:copperlane") + "&tab=followers", {
    ip: "203.0.113.223",
    token: bea.token
  });
  assert.equal(followers.body.followersCount, 1);
  assert.equal(followers.body.accounts[0].handle, "ada_fl");
  assert.equal(followers.body.accounts[0].bio, "Ada builds engines");
  assert.equal(JSON.stringify(followers.body).includes(ada.accountNumber), false);

  const guest = await call("/v1/follows?id=x:copperlane&tab=followers", { ip: "203.0.113.224" });
  assert.equal(guest.status, 401);

  const gone = await call("/v1/follows", {
    method: "DELETE",
    ip: "203.0.113.225",
    token: otherDevice.body.token,
    body: { id: "app:" + bea.account.publicId }
  });
  assert.equal(gone.status, 200);
  assert.equal(gone.body.followingCount, 1);
  assert.equal(gone.body.followersCount, 0);
  const after = await call("/v1/profile/bea_fl", { ip: "203.0.113.226", token: ada.token });
  assert.equal(after.body.account.followersCount, 0);
  assert.equal(after.body.account.viewerFollows, false);

  // Only accounts older than the owner-only start (#280) bulk-import follows.
  const legacyDb = await mf.getD1Database("DB");
  await legacyDb.prepare("UPDATE accounts SET created_at = ? WHERE public_id = ?").bind(Date.UTC(2026, 9, 28, 18, 4, 30) - 86400000, bea.account.publicId).run();
  const imported = await call("/v1/follows/import", {
    method: "POST",
    ip: "203.0.113.227",
    token: bea.token,
    body: { ids: ["x:copperlane", "x:copperlane", "not an id", "youtube:news"] }
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.followingCount, 2);
  const again = await call("/v1/follows/import", {
    method: "POST",
    ip: "203.0.113.228",
    token: bea.token,
    body: { ids: ["x:copperlane", "youtube:news"] }
  });
  assert.equal(again.body.followingCount, 2);
  const elonFollowers = await call("/v1/follows?id=x:copperlane", { ip: "203.0.113.229", token: ada.token });
  assert.equal(elonFollowers.body.followersCount, 2);
  assert.equal(elonFollowers.body.viewerFollows, true);

  const withApp = await call("/v1/follows/import", {
    method: "POST",
    ip: "203.0.113.230",
    token: bea.token,
    body: { ids: ["app:" + ada.account.publicId, "app:" + bea.account.publicId, "app:000000000000", "x:copperlane"] }
  });
  assert.equal(withApp.status, 200, withApp.text);
  assert.equal(withApp.body.followingCount, 3);
  const beaList = await call("/v1/follows", { ip: "203.0.113.231", token: bea.token });
  assert.equal(beaList.body.ids.includes("app:@ada_fl"), true);
  assert.equal(beaList.body.ids.includes("app:" + bea.account.publicId), false);
  assert.equal(beaList.body.ids.includes("app:@bea_fl"), false);
  assert.equal(beaList.body.ids.includes("app:000000000000"), false);

  // Private follows test
  const setPrivate = await call("/v1/profile", {
    method: "PATCH",
    ip: "203.0.113.232",
    token: ada.token,
    body: { privateFollows: true }
  });
  assert.equal(setPrivate.status, 200);
  assert.equal(setPrivate.body.account.privateFollows, true);

  const adaCheck = await call("/v1/profile/ada_fl", { ip: "203.0.113.233", token: bea.token });
  assert.equal(adaCheck.body.account.privateFollows, true);

  // Bea visits Ada's following list - should be private
  const beaViewsAdaFollowing = await call("/v1/follows?id=" + encodeURIComponent("app:" + ada.account.publicId) + "&tab=following", {
    ip: "203.0.113.234",
    token: bea.token
  });
  assert.equal(beaViewsAdaFollowing.status, 200);
  assert.equal(beaViewsAdaFollowing.body.isPrivate, true);
  assert.equal(beaViewsAdaFollowing.body.accounts.length, 0);

  // Bea visits Ada's followers list - should be private
  const beaViewsAdaFollowers = await call("/v1/follows?id=" + encodeURIComponent("app:" + ada.account.publicId) + "&tab=followers", {
    ip: "203.0.113.235",
    token: bea.token
  });
  assert.equal(beaViewsAdaFollowers.status, 200);
  assert.equal(beaViewsAdaFollowers.body.isPrivate, true);
  assert.equal(beaViewsAdaFollowers.body.accounts.length, 0);

  // Ada views their own following list - owner can view, so the denial flag stays off
  const adaViewsOwnFollowing = await call("/v1/follows?id=" + encodeURIComponent("app:" + ada.account.publicId) + "&tab=following", {
    ip: "203.0.113.236",
    token: ada.token
  });
  assert.equal(adaViewsOwnFollowing.status, 200);
  assert.equal(adaViewsOwnFollowing.body.isPrivate, false);
  assert.equal(adaViewsOwnFollowing.body.accounts.length > 0, true);

  // Reset privateFollows back to false
  const resetPrivate = await call("/v1/profile", {
    method: "PATCH",
    ip: "203.0.113.237",
    token: ada.token,
    body: { privateFollows: false }
  });
  assert.equal(resetPrivate.status, 200);
  assert.equal(resetPrivate.body.account.privateFollows, false);

  const beaViewsAdaAgain = await call("/v1/follows?id=" + encodeURIComponent("app:" + ada.account.publicId) + "&tab=following", {
    ip: "203.0.113.238",
    token: bea.token
  });
  assert.equal(beaViewsAdaAgain.status, 200);
  assert.equal(beaViewsAdaAgain.body.isPrivate, false);
  assert.equal(beaViewsAdaAgain.body.accounts.length > 0, true);
});

test("the owner sees private follower lists and another account does not", async () => {
  const userA = await signup("203.0.113.240", "user_a", "User A");
  const userB = await signup("203.0.113.241", "user_b", "User B");
  const followed = await call("/v1/follows", {
    method: "PUT",
    ip: "203.0.113.242",
    token: userA.token,
    body: { id: "app:@" + userB.account.handle }
  });
  assert.equal(followed.status, 200, followed.text);
  assert.equal(followed.body.pending, undefined);
  const setPrivate = await call("/v1/profile", {
    method: "PATCH",
    ip: "203.0.113.243",
    token: userA.token,
    body: { privateFollows: true }
  });
  assert.equal(setPrivate.status, 200);
  assert.equal(setPrivate.body.account.privateFollows, true);

  const ownById = await call("/v1/follows?id=" + encodeURIComponent("app:" + userA.account.publicId) + "&tab=following", {
    ip: "203.0.113.244",
    token: userA.token
  });
  assert.equal(ownById.status, 200, ownById.text);
  assert.equal(ownById.body.isPrivate, false);
  assert.equal(ownById.body.accounts.length, 1);
  assert.equal(ownById.body.accounts[0].handle, "user_b");
  assert.equal(JSON.stringify(ownById.body).includes(userA.account.publicId), false);
  assert.equal(JSON.stringify(ownById.body).includes(userB.account.publicId), false);

  const ownByHandle = await call("/v1/follows?id=" + encodeURIComponent("app:@USER_A") + "&tab=following", {
    ip: "203.0.113.245",
    token: userA.token
  });
  assert.equal(ownByHandle.status, 200, ownByHandle.text);
  assert.equal(ownByHandle.body.isPrivate, false);
  assert.equal(ownByHandle.body.accounts.length, 1);
  assert.equal(ownByHandle.body.accounts[0].handle, "user_b");

  const ownFollowers = await call("/v1/follows?id=" + encodeURIComponent("app:@user_a") + "&tab=followers", {
    ip: "203.0.113.246",
    token: userA.token
  });
  assert.equal(ownFollowers.status, 200, ownFollowers.text);
  assert.equal(ownFollowers.body.isPrivate, false);
  assert.ok(Array.isArray(ownFollowers.body.accounts));

  const otherById = await call("/v1/follows?id=" + encodeURIComponent("app:" + userA.account.publicId) + "&tab=following", {
    ip: "203.0.113.247",
    token: userB.token
  });
  assert.equal(otherById.status, 200, otherById.text);
  assert.equal(otherById.body.isPrivate, true);
  assert.equal(otherById.body.accounts.length, 0);
  assert.equal(JSON.stringify(otherById.body).includes(userA.account.publicId), false);

  const otherByHandle = await call("/v1/follows?id=" + encodeURIComponent("app:@user_a") + "&tab=followers", {
    ip: "203.0.113.248",
    token: userB.token
  });
  assert.equal(otherByHandle.status, 200, otherByHandle.text);
  assert.equal(otherByHandle.body.isPrivate, true);
  assert.equal(otherByHandle.body.accounts.length, 0);
});
