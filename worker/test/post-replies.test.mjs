import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
      OWNER_HANDLE: "user_owner",
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000"
    }
  };
}

async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers();
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.110");
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.json) headers.set("content-type", "application/json");
  if (opts.multipart) headers.set("content-type", opts.multipart.type);
  const res = await mf.dispatchFetch("https://accounts.test" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.multipart ? opts.multipart.body : (opts.json ? JSON.stringify(opts.json) : undefined)
  });
  if (opts.raw) return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch (err) { body = { raw: text }; }
  return { status: res.status, body };
}

async function signup(handle, ip) {
  const created = await call("/v1/signup", {
    method: "POST",
    ip,
    json: { displayName: "User " + handle.slice(-1).toUpperCase(), handle }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

test.before(async () => {
  mf = new Miniflare(workerOptions());
});

test.after(async () => {
  if (mf) await mf.dispose();
});
const IP = { a: "203.0.113.171", b: "203.0.113.172", c: "203.0.113.173" };

async function notes(token, ip) {
  const got = await call("/v1/notifications", { ip, token });
  assert.equal(got.status, 200, JSON.stringify(got.body));
  return got.body.items || [];
}

test("one app account replies to and quotes another, end to end", async () => {
  const a = await signup("user_a", IP.a);
  const b = await signup("member_test", IP.b);
  const c = await signup("sync_user", IP.c);

  const parent = await call("/v1/posts", { method: "POST", ip: IP.b, token: b.token, json: { body: "hello from b @sync_user", poll: { options: ["yes", "no"], minutes: 60 } } });
  assert.equal(parent.status, 201, JSON.stringify(parent.body));
  const pid = parent.body.post.id;

  const reply = await call("/v1/posts", { method: "POST", ip: IP.a, token: a.token, json: { body: "a replies @member_test", parentId: pid } });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  assert.equal(reply.body.post.parentId, pid);
  assert.equal(reply.body.post.parent && reply.body.post.parent.id, pid, "the reply carries its parent");

  const quote = await call("/v1/posts", { method: "POST", ip: IP.a, token: a.token, json: { body: "a quotes b", quoteId: pid } });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const card = quote.body.post.quote;
  assert.equal(card.id, pid);
  assert.equal(card.authorHandle, "member_test");
  assert.ok(card.authorId && card.createdAt && card.body, "the quote card has author, time and text");

  // B hears about the reply and the quote, once each.
  const bNotes = await notes(b.token, IP.b);
  const kinds = bNotes.map((item) => item.kind).sort();
  assert.ok(kinds.includes("reply"), JSON.stringify(kinds));
  assert.ok(kinds.includes("quote"), JSON.stringify(kinds));
  assert.ok(bNotes.every((item) => !item.hash || item.hash.indexOf("#/app/user_a/status/") === 0 || item.kind === "mention"), "notes open the post");

  assert.ok((await notes(c.token, IP.c)).some((item) => item.kind === "mention"), "mentions reach the named account");

  // Home and both profiles list the reply and quote with counts.
  const home = await call("/v1/posts", { ip: IP.b, token: b.token });
  const homeParent = home.body.posts.find((post) => post.id === pid);
  assert.equal(homeParent.replyCount, 1);
  assert.equal(homeParent.quoteCount, 1);
  assert.ok(home.body.posts.find((post) => post.id === reply.body.post.id).parent, "home shows the parent above the reply");
  const aProfile = await call("/v1/posts?by=" + a.account.publicId, { ip: IP.b, token: b.token });
  assert.equal(aProfile.body.posts.length, 2);

  // Likes and poll votes reach the server and the author.
  const liked = await call("/v1/posts/like", { method: "POST", ip: IP.a, token: a.token, json: { id: pid } });
  assert.equal(liked.status, 200, JSON.stringify(liked.body));
  assert.equal(liked.body.likes, 1);
  assert.equal(liked.body.liked, true);
  const voted = await call("/v1/posts/vote", { method: "POST", ip: IP.a, token: a.token, json: { id: pid, choice: 1 } });
  assert.equal(voted.status, 200, JSON.stringify(voted.body));
  assert.deepEqual(voted.body.poll.votes, [0, 1]);
  assert.equal((await call("/v1/posts/vote", { method: "POST", ip: IP.a, token: a.token, json: { id: pid, choice: 0 } })).status, 409);
  assert.ok((await notes(b.token, IP.b)).some((item) => item.kind === "like"));
  const replyLike = await call("/v1/posts/like", { method: "POST", ip: IP.b, token: b.token, json: { id: reply.body.post.id } });
  assert.equal(replyLike.body.likes, 1);

  // The thread under the parent, in each sort.
  const second = await call("/v1/posts", { method: "POST", ip: IP.c, token: c.token, json: { body: "c replies too", parentId: pid } });
  assert.equal(second.status, 201);
  const thread = await call("/v1/posts/thread?id=" + pid + "&sort=liked", { ip: IP.b, token: b.token });
  assert.equal(thread.status, 200, JSON.stringify(thread.body));
  assert.equal(thread.body.post.id, pid);
  assert.equal(thread.body.post.likes, 1);
  assert.equal(thread.body.post.poll.mine, -1);
  assert.deepEqual(thread.body.replies.map((post) => post.id), [reply.body.post.id, second.body.post.id]);
  const recent = await call("/v1/posts/thread?id=" + pid + "&sort=recent", { ip: IP.b, token: b.token });
  assert.equal(recent.body.replies[0].id, second.body.post.id);
  const replyThread = await call("/v1/posts/thread?id=" + reply.body.post.id, { ip: IP.b, token: b.token });
  assert.equal(replyThread.body.post.parent.id, pid, "a reply's own page shows its parent");

  // Edits by the author only; deletes leave a placeholder in quotes and drop counts.
  assert.equal((await call("/v1/posts/edit", { method: "POST", ip: IP.b, token: b.token, json: { id: reply.body.post.id, body: "hijack" } })).status, 404);
  const edited = await call("/v1/posts/edit", { method: "POST", ip: IP.a, token: a.token, json: { id: reply.body.post.id, body: "a replies, edited" } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const afterEdit = await call("/v1/posts/thread?id=" + pid, { ip: IP.b, token: b.token });
  const editedReply = afterEdit.body.replies.find((post) => post.id === reply.body.post.id);
  assert.equal(editedReply.body, "a replies, edited");
  assert.ok(editedReply.editedAt > 0);
  assert.equal((await call("/v1/posts/delete", { method: "POST", ip: IP.a, token: a.token, json: { id: reply.body.post.id } })).status, 200);
  const afterDelete = await call("/v1/posts/thread?id=" + pid, { ip: IP.b, token: b.token });
  assert.equal(afterDelete.body.post.replyCount, 1);
  assert.equal((await call("/v1/posts/thread?id=" + reply.body.post.id, { ip: IP.b, token: b.token })).status, 410);
  assert.equal((await call("/v1/posts/delete", { method: "POST", ip: IP.b, token: b.token, json: { id: pid } })).status, 200);
  const quoteNow = await call("/v1/posts/thread?id=" + quote.body.post.id, { ip: IP.a, token: a.token });
  assert.equal(quoteNow.body.post.quote.unavailable, true);

  // A block stops replies and quotes both ways.
  const fresh = await call("/v1/posts", { method: "POST", ip: IP.b, token: b.token, json: { body: "after the block" } });
  await call("/v1/blocks", { method: "POST", ip: IP.b, token: b.token, json: { accountId: a.account.publicId } });
  assert.equal((await call("/v1/posts", { method: "POST", ip: IP.a, token: a.token, json: { body: "blocked reply", parentId: fresh.body.post.id } })).status, 404);
  assert.equal((await call("/v1/posts", { method: "POST", ip: IP.a, token: a.token, json: { body: "blocked quote", quoteId: fresh.body.post.id } })).status, 404);

  // A reply to an outside post keeps its parent so Home, the profile and the thread show it above.
  const ext = { platform: "reddit", id: "reddit:t3_abc", statusId: "t3_abc", url: "https://www.reddit.com/r/test/comments/abc/", handle: "member_test", author: "member_test", text: "outside parent", community: "test", score: 12, media: [{ type: "photo", url: "https://i.redd.it/x.jpg" }, { type: "photo", url: "javascript:alert(1)" }] };
  const extReply = await call("/v1/posts", { method: "POST", ip: IP.b, token: b.token, json: { body: "b replies to reddit", extParent: ext } });
  assert.equal(extReply.status, 201, JSON.stringify(extReply.body));
  assert.equal(extReply.body.post.extParent.platform, "reddit");
  const listed = await call("/v1/posts?by=" + b.account.publicId, { ip: IP.b, token: b.token });
  const row = listed.body.posts.find((post) => post.id === extReply.body.post.id);
  assert.equal(row.extParent.text, "outside parent");
  assert.equal(row.extParent.community, "test");
  assert.equal(row.extParent.score, 12);
  assert.deepEqual(row.extParent.media.map((item) => item.url), ["https://i.redd.it/x.jpg"]);
  const bogus = await call("/v1/posts", { method: "POST", ip: IP.b, token: b.token, json: { body: "no platform", extParent: { platform: "nope", id: "1" } } });
  assert.equal(bogus.status, 201);
  assert.equal(bogus.body.post.extParent, null);
});

test("a reply can carry a photo, and the thread shows it", async () => {
  const ip = "203.0.113.181";
  const a = await signup("device_user", ip);
  const parent = await call("/v1/posts", { method: "POST", ip, token: a.token, json: { body: "parent for media" } });
  assert.equal(parent.status, 201, JSON.stringify(parent.body));
  const pid = parent.body.post.id;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const b = "replymedia";
  const field = (name, value) => Buffer.from("--" + b + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n");
  const body = Buffer.concat([
    field("body", "reply with a photo"),
    field("parentId", pid),
    Buffer.from("--" + b + "\r\nContent-Disposition: form-data; name=\"media\"; filename=\"p.png\"\r\nContent-Type: image/png\r\n\r\n"),
    png,
    Buffer.from("\r\n--" + b + "--\r\n")
  ]);
  const reply = await call("/v1/posts", { method: "POST", ip, token: a.token, multipart: { type: "multipart/form-data; boundary=" + b, body } });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  assert.equal(reply.body.post.parentId, pid);
  const media = reply.body.post.media || [];
  assert.equal(media.length, 1, JSON.stringify(reply.body.post));
  const stored = await call(media[0].url, { ip, token: a.token, raw: true });
  assert.equal(stored.status, 200);
  assert.equal(Buffer.compare(Buffer.from(stored.bytes), png), 0);
  const thread = await call("/v1/posts/thread?id=" + pid, { ip, token: a.token });
  const shown = thread.body.replies.find((post) => post.id === reply.body.post.id);
  assert.ok(shown && (shown.media || []).length === 1, "the thread lists the reply with its photo");
});

test("a profile pages back through all of an account's posts", async () => {
  const ip = "203.0.113.191";
  const u = await signup("owner_test", ip);
  const db = await mf.getD1Database("DB");
  const made = [];
  const seed = await call("/v1/posts", { method: "POST", ip, token: u.token, json: { body: "post 0" } });
  assert.equal(seed.status, 201, JSON.stringify(seed.body));
  const row = await db.prepare("SELECT * FROM public_posts WHERE id = ?").bind(seed.body.post.id).first();
  const cols = Object.keys(row);
  made.push(row.id);
  await db.prepare("UPDATE public_posts SET created_at = ? WHERE id = ?").bind(1700000000000, row.id).run();
  // Copies past the posting rate limit, one second apart. The suffix range
  // skips the seed's own id so a random seed cannot collide with a copy.
  const start = /^1[0-4]\d$/.test(String(row.id).slice(-3)) ? 200 : 100;
  for (let i = 1; i < 45; i++) {
    const copy = Object.assign({}, row, { id: String(row.id).slice(0, -3) + String(start + i), body: "post " + i, created_at: 1700000000000 + i * 1000 });
    await db.prepare("INSERT INTO public_posts (" + cols.join(",") + ") VALUES (" + cols.map(() => "?").join(",") + ")").bind(...cols.map((c) => copy[c])).run();
    made.push(copy.id);
  }
  const first = await call("/v1/posts?by=" + u.account.publicId, { ip, token: u.token });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.posts.length, 40);
  assert.equal(first.body.more, true);
  const next = await call("/v1/posts?by=" + u.account.publicId + "&before=" + first.body.before, { ip, token: u.token });
  const ids = new Set(first.body.posts.concat(next.body.posts).map((post) => post.id));
  assert.ok(made.every((id) => ids.has(id)), "every post shows across the two pages");
  assert.equal(next.body.more, false);
});

test("a profile opened by username lists that account's own posts for other viewers", async () => {
  const ipA = "203.0.113.181";
  const ipB = "203.0.113.182";
  const author = await signup("byname_writer", ipA);
  const viewer = await signup("byname_reader", ipB);
  const made = await call("/v1/posts", { method: "POST", ip: ipA, token: author.token, json: { body: "first post by name" } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  // Other viewers get no public id on the profile, so the client asks by name.
  const profile = await call("/v1/profile/byname_writer", { ip: ipB, token: viewer.token });
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  assert.ok(!profile.body.account.publicId);
  for (const name of ["byname_writer", "@BYNAME_WRITER"]) {
    const listed = await call("/v1/posts?handle=" + encodeURIComponent(name), { ip: ipB, token: viewer.token });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.ok(listed.body.posts.some((post) => post.id === made.body.post.id), name);
    assert.equal(listed.body.author, "");
  }
  const missing = await call("/v1/posts?handle=nobody_here_zz", { ip: ipB, token: viewer.token });
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body.posts, []);
});
