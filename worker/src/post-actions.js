/* Replies and quotes between app accounts: who may see a parent or a quoted
   post, the counts on every card, likes, poll votes, edits, deletes, the reply
   thread under a post, and the notes and live updates that go with them. */

import { presentPost, hiddenAuthors, audienceSets, canSee, withParents } from "./posts.js";
import { canSeeAudience } from "./audience.js";
import { blocksEither, actorHidden, acceptedUnlockedFollow } from "./social.js";
import { listWatchers, deliverToAccount } from "./channel.js";
import { readFlags } from "./feature-flags.js";

export const POST_ACTION_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS public_post_likes (post_id TEXT NOT NULL, account_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (post_id, account_id))",
  "CREATE INDEX IF NOT EXISTS public_post_likes_post ON public_post_likes(post_id)",
  "CREATE TABLE IF NOT EXISTS public_poll_votes (post_id TEXT NOT NULL, account_id TEXT NOT NULL, choice INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (post_id, account_id))",
  "CREATE INDEX IF NOT EXISTS public_posts_parent ON public_posts(parent_id)",
  "CREATE INDEX IF NOT EXISTS public_posts_quote ON public_posts(quote_id)"
];

export const EDIT_WINDOW = 60 * 60 * 1000;
const DELETED = 2;

function postId(value) {
  const text = String(value || "");
  return /^[a-f0-9]{32}$/.test(text) ? text : "";
}

export function statusHash(handle, id) {
  return "#/app/" + encodeURIComponent(String(handle || "")) + "/status/" + encodeURIComponent(String(id || ""));
}

/* Same rules as the timeline: blocks either way, then the post's audience. */
export async function viewerCanSee(env, viewerId, row) {
  if (!row) return false;
  if (row.author_id === viewerId) return true;
  if (await blocksEither(env, viewerId, row.author_id)) return false;
  const audience = row.audience || "everyone";
  if (audience === "everyone") return true;
  if (audience === "list") return canSeeAudience(env, { viewerId, ownerId: row.author_id, audience: "list", subject: "post", subjectId: row.id });
  return canSee(row, viewerId, await audienceSets(env, viewerId, [row.author_id]));
}

async function grouped(env, sql, ids, extra) {
  const out = {};
  if (!ids.length) return out;
  const marks = ids.map(() => "?").join(",");
  try {
    const rows = await env.DB.prepare(sql.replace("%IDS%", marks)).bind(...(extra || []), ...ids).all();
    ((rows && rows.results) || []).forEach((row) => { out[row.k] = row; });
  } catch (err) { /* a missing table counts as zero */ }
  return out;
}

function collect(posts, into) {
  (posts || []).forEach((post) => {
    if (!post || !post.id) return;
    if (postId(post.id)) into.push(post);
    if (post.parent) collect([post.parent], into);
    if (post.quote && post.quote.id) collect([post.quote], into);
  });
  return into;
}

/* Counts and the viewer's own state on every app post, its parents and quotes. */
export async function decorate(env, posts, viewerId) {
  const all = collect(posts, []);
  const ids = Array.from(new Set(all.map((post) => post.id))).slice(0, 200);
  if (!ids.length) return posts;
  const live = "hidden = 0 AND (scheduled_at = 0 OR scheduled_at <= " + Date.now() + ")";
  const [replies, quotes, likes, liked, reposts, edits, votes, mine] = await Promise.all([
    grouped(env, "SELECT parent_id AS k, COUNT(*) AS n FROM public_posts WHERE " + live + " AND parent_id IN (%IDS%) GROUP BY parent_id", ids),
    grouped(env, "SELECT quote_id AS k, COUNT(*) AS n FROM public_posts WHERE " + live + " AND quote_id IN (%IDS%) GROUP BY quote_id", ids),
    grouped(env, "SELECT post_id AS k, COUNT(*) AS n FROM public_post_likes WHERE post_id IN (%IDS%) GROUP BY post_id", ids),
    grouped(env, "SELECT post_id AS k FROM public_post_likes WHERE account_id = ? AND post_id IN (%IDS%)", ids, [viewerId]),
    grouped(env, "SELECT substr(post_key, 7) AS k, COUNT(*) AS n, SUM(CASE WHEN public_id = ? THEN 1 ELSE 0 END) AS me FROM account_reposts WHERE post_key IN (" + ids.map(() => "?").join(",") + ") GROUP BY post_key", ids.map((id) => "r:app:" + id), [viewerId]),
    grouped(env, "SELECT id AS k, edited_at FROM public_posts WHERE id IN (%IDS%)", ids),
    grouped(env, "SELECT post_id || ':' || choice AS k, COUNT(*) AS n FROM public_poll_votes WHERE post_id IN (%IDS%) GROUP BY post_id, choice", ids),
    grouped(env, "SELECT post_id AS k, choice FROM public_poll_votes WHERE account_id = ? AND post_id IN (%IDS%)", ids, [viewerId])
  ]);
  all.forEach((post) => {
    const id = post.id;
    post.replyCount = Number(replies[id] && replies[id].n) || 0;
    post.quoteCount = Number(quotes[id] && quotes[id].n) || 0;
    post.likes = Number(likes[id] && likes[id].n) || 0;
    post.liked = !!liked[id];
    post.reposts = Number(reposts[id] && reposts[id].n) || 0;
    post.reposted = !!(reposts[id] && Number(reposts[id].me));
    post.editedAt = Number(edits[id] && edits[id].edited_at) || 0;
    if (post.poll && Array.isArray(post.poll.options)) {
      const counts = post.poll.options.map((opt, i) => Number(votes[id + ":" + i] && votes[id + ":" + i].n) || 0);
      post.poll.votes = counts;
      post.poll.total = counts.reduce((a, b) => a + b, 0);
      post.poll.mine = mine[id] ? Number(mine[id].choice) : -1;
    }
  });
  return posts;
}

/* The quoted post as a card: author, avatar, text, media and time, or a
   placeholder when the viewer may not see it. */
export async function quoteFor(env, request, quoteId, viewerId) {
  const row = await env.DB.prepare("SELECT p.id, p.author_id, p.body, p.parent_id, p.created_at, p.audience, p.hidden, p.scheduled_at, p.ext_parent, a.handle, a.display_name, a.avatar FROM public_posts p JOIN accounts a ON a.public_id = p.author_id WHERE p.id = ?").bind(quoteId).first();
  if (!row || row.hidden || Number(row.scheduled_at) > Date.now()) return { id: quoteId, unavailable: true, deleted: !!(row && Number(row.hidden) === DELETED) };
  if (!(await viewerCanSee(env, viewerId, row))) return { id: quoteId, unavailable: true };
  const mediaRows = await env.DB.prepare("SELECT id, mime, size, alt_text FROM public_post_media WHERE post_id = ? ORDER BY sort_order ASC, id ASC").bind(row.id).all();
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    parentId: row.parent_id || "",
    authorId: row.author_id,
    authorName: row.display_name,
    authorHandle: row.handle,
    authorAvatar: "", // presentPost fills the viewer-aware face
    media: ((mediaRows && mediaRows.results) || []).map((item) => ({ id: item.id, mime: item.mime, size: item.size, alt: item.alt_text || "", url: new URL("/v1/posts/media/" + item.id, request.url).pathname }))
  };
}

const LIVE_POST_SQL = "SELECT p.id, p.author_id, p.body, p.parent_id, p.quote_id, p.created_at, p.hidden, p.audience, p.reply_control, p.location, p.poll_json, p.scheduled_at, p.edited_at, p.ext_parent, a.handle, a.display_name FROM public_posts p JOIN accounts a ON a.public_id = p.author_id WHERE p.id = ?";

function mediaItem(item, request) {
  return {
    id: item.id,
    mime: item.mime,
    size: item.size,
    alt: item.alt_text || "",
    url: new URL("/v1/posts/media/" + item.id, request.url).pathname
  };
}

/* The public row only: the account's own name and handle, never a viewer's
   nickname, and no like, repost, or poll vote. */
async function neutralLiveCard(env, request, row) {
  if (!row || !row.id) return null;
  let media = [];
  try {
    const listed = await env.DB.prepare("SELECT id, mime, size, alt_text FROM public_post_media WHERE post_id = ? ORDER BY sort_order ASC, id ASC").bind(row.id).all();
    media = ((listed && listed.results) || []).map((item) => mediaItem(item, request));
  } catch (err) { media = []; }
  let quote = null;
  if (row.quote_id) {
    let quoted = null;
    try { quoted = await env.DB.prepare(LIVE_POST_SQL).bind(row.quote_id).first(); }
    catch (err) { quoted = null; }
    if (!quoted || Number(quoted.hidden) || Number(quoted.scheduled_at) > Date.now()) quote = { id: row.quote_id, unavailable: true };
    else {
      let qMedia = [];
      try {
        const listed = await env.DB.prepare("SELECT id, mime, size, alt_text FROM public_post_media WHERE post_id = ? ORDER BY sort_order ASC, id ASC").bind(quoted.id).all();
        qMedia = ((listed && listed.results) || []).map((item) => mediaItem(item, request));
      } catch (err) { qMedia = []; }
      quote = {
        id: quoted.id,
        body: quoted.body || "",
        authorId: quoted.author_id,
        authorName: quoted.display_name || "",
        authorHandle: quoted.handle || "",
        authorAvatar: "",
        media: qMedia
      };
    }
  }
  let poll = null;
  if (row.poll_json) {
    try {
      const parsed = JSON.parse(row.poll_json);
      if (parsed && Array.isArray(parsed.options)) poll = { options: parsed.options };
    } catch (err) { poll = null; }
  }
  const card = {
    id: row.id,
    body: row.body || "",
    createdAt: row.created_at,
    parentId: row.parent_id || "",
    quoteId: row.quote_id || "",
    authorId: row.author_id,
    authorName: row.display_name || "",
    authorHandle: row.handle || "",
    authorAvatar: "",
    media: media,
    quote: quote,
    audience: row.audience || "everyone",
    editedAt: Number(row.edited_at) || 0,
    poll: poll
  };
  let packed = "";
  try { packed = JSON.stringify({ post: card }); }
  catch (err) { return null; }
  if (packed.length > 7000) return null;
  return card;
}

/* Watchers who still have an accepted, unlocked follow. The post is read
   again here, so a delete or an edit that landed first is what they see. */
export async function pushLivePost(env, hint) {
  const id = hint && hint.id;
  if (!env || !id) return 0;
  let off = {};
  try { off = await readFlags(env); }
  catch (err) { off = {}; }
  if (off.home_live) return 0;
  let fresh = null;
  try { fresh = await env.DB.prepare(LIVE_POST_SQL).bind(id).first(); }
  catch (err) { return 0; }
  if (!fresh || Number(fresh.hidden) || Number(fresh.scheduled_at) > Date.now()) return 0;
  let watchers = [];
  try { watchers = await listWatchers(env, fresh.author_id, "posts"); }
  catch (err) { return 0; }
  const request = { url: "https://accounts.local/v1/posts" };
  const card = await neutralLiveCard(env, request, fresh);
  if (!card) return 0;
  let sent = 0;
  for (let i = 0; i < watchers.length; i++) {
    const viewerId = watchers[i];
    if (!viewerId || viewerId === fresh.author_id) continue;
    try {
      if (!(await acceptedUnlockedFollow(env, viewerId, fresh.author_id))) continue;
      if (!(await viewerCanSee(env, viewerId, fresh))) continue;
      await deliverToAccount(env, viewerId, "posts", { post: card }, fresh.author_id);
      sent += 1;
    } catch (err) { /* their next Home fetch still shows the post */ }
  }
  return sent;
}

/* Notes for the parent's author, the quoted author and anyone mentioned. */
export async function notifyPost(env, session, post, parentRow, quoteRow, deps) {
  let notes;
  try { notes = await import("./notifications.js"); } catch (err) { return; }
  const hash = statusHash(session.handle, post.id);
  const told = [];
  const tell = async (row, kind) => {
    if (!row || !row.author_id || row.author_id === session.public_id || told.indexOf(row.author_id) >= 0) return;
    told.push(row.author_id);
    if (await actorHidden(env, row.author_id, session.public_id)) return;
    try {
      await notes.emitNotification(env, {
        publicId: row.author_id,
        kind: kind,
        at: Date.now(),
        actorId: session.public_id,
        groupKey: kind + ":" + row.id,
        idempotencyKey: "pp" + kind + ":" + post.id,
        handle: session.handle,
        name: session.display_name,
        text: String(post.body || "").slice(0, 180),
        hash: hash,
        platform: "app",
        feedId: session.handle ? "app:@" + session.handle : "",
        request: deps && deps.request
      });
    } catch (err) { /* the post is saved */ }
  };
  await tell(parentRow, "reply");
  await tell(quoteRow, "quote");
  try {
    await notes.notifyMentions(env, session, post.body || "", told.slice(), "pmention:" + post.id, hash);
  } catch (err) { /* the post is saved */ }
  await bump(env, deps, [parentRow, quoteRow], session.public_id);
}

/* Live counts: the authors whose posts changed hear about it at once. */
export async function bump(env, deps, rows, actorId) {
  const publish = deps && deps.publish;
  if (!publish) return;
  const seen = {};
  for (const row of rows || []) {
    if (!row || !row.author_id || seen[row.author_id]) continue;
    seen[row.author_id] = true;
    try { await publish(env, row.author_id, "posts", { id: row.id, at: Date.now() }, row.author_id); }
    catch (err) { /* devices refresh when they come back */ }
  }
  if (actorId && !seen[actorId]) {
    try { await publish(env, actorId, "posts", { at: Date.now() }, actorId); } catch (err) { /* same */ }
  }
}

async function readBody(request, deps) {
  const body = await deps.readJson(request, 4000);
  return body && !body.error ? body : null;
}

async function liveRow(env, id) {
  return env.DB.prepare("SELECT id, author_id, body, parent_id, quote_id, created_at, hidden, audience, poll_json, scheduled_at FROM public_posts WHERE id = ?").bind(id).first();
}

async function guarded(env, session, id) {
  const row = id ? await liveRow(env, id) : null;
  if (!row || row.hidden || Number(row.scheduled_at) > Date.now()) return null;
  if (!(await viewerCanSee(env, session.public_id, row))) return null;
  return row;
}

async function like(request, env, deps, session) {
  const gate = await deps.rateHit(env, "plike:" + session.public_id, 120, 10 * 60 * 1000);
  if (!gate.ok) return deps.limited(gate);
  const body = await readBody(request, deps);
  const row = body ? await guarded(env, session, postId(body.id)) : null;
  if (!row) return deps.json(404, { error: "not_found" });
  const on = body.on !== false;
  if (on) {
    const res = await env.DB.prepare("INSERT OR IGNORE INTO public_post_likes (post_id, account_id, created_at) VALUES (?, ?, ?)").bind(row.id, session.public_id, Date.now()).run();
    const fresh = !!(res && res.meta && res.meta.changes);
    if (fresh && row.author_id !== session.public_id && !(await actorHidden(env, row.author_id, session.public_id))) {
      try {
        const notes = await import("./notifications.js");
        const author = await env.DB.prepare("SELECT handle FROM accounts WHERE public_id = ?").bind(row.author_id).first();
        await notes.emitNotification(env, {
          publicId: row.author_id, kind: "like", at: Date.now(), actorId: session.public_id,
          groupKey: "like:" + row.id, idempotencyKey: "plike:" + session.public_id + ":" + row.id,
          handle: session.handle, name: session.display_name, text: String(row.body || "").slice(0, 180),
          hash: statusHash(author && author.handle, row.id), platform: "app", feedId: session.handle ? "app:@" + session.handle : ""
        });
      } catch (err) { /* the like is saved */ }
    }
  } else {
    await env.DB.prepare("DELETE FROM public_post_likes WHERE post_id = ? AND account_id = ?").bind(row.id, session.public_id).run();
  }
  await bump(env, deps, [row], session.public_id);
  const post = { id: row.id };
  await decorate(env, [post], session.public_id);
  return deps.json(200, { ok: true, id: row.id, likes: post.likes, liked: post.liked });
}

async function vote(request, env, deps, session) {
  const body = await readBody(request, deps);
  const row = body ? await guarded(env, session, postId(body.id)) : null;
  if (!row || !row.poll_json) return deps.json(404, { error: "not_found" });
  let poll = null;
  try { poll = JSON.parse(row.poll_json); } catch (err) { poll = null; }
  const choice = Number(body.choice);
  if (!poll || !Array.isArray(poll.options) || !Number.isInteger(choice) || choice < 0 || choice >= poll.options.length) return deps.json(400, { error: "bad_vote" });
  const ends = Number(poll.endsAt) || (Number(poll.minutes) ? Number(row.created_at) + Number(poll.minutes) * 60000 : 0);
  if (ends && Date.now() > ends) return deps.json(409, { error: "poll_closed" });
  const res = await env.DB.prepare("INSERT OR IGNORE INTO public_poll_votes (post_id, account_id, choice, created_at) VALUES (?, ?, ?, ?)").bind(row.id, session.public_id, choice, Date.now()).run();
  if (!(res && res.meta && res.meta.changes)) return deps.json(409, { error: "already_voted" });
  await bump(env, deps, [row], session.public_id);
  const post = { id: row.id, poll: poll };
  await decorate(env, [post], session.public_id);
  return deps.json(200, { ok: true, poll: post.poll });
}

async function edit(request, env, deps, session, clean) {
  const body = await readBody(request, deps);
  const row = body ? await liveRow(env, postId(body.id)) : null;
  if (!row || row.hidden || row.author_id !== session.public_id) return deps.json(404, { error: "not_found" });
  if (Date.now() - Number(row.created_at) > EDIT_WINDOW) return deps.json(409, { error: "edit_closed" });
  const text = clean(body.body);
  if (!text) return deps.json(400, { error: "bad_post" });
  const now = Date.now();
  await env.DB.prepare("UPDATE public_posts SET body = ?, edited_at = ? WHERE id = ?").bind(text, now, row.id).run();
  try {
    const notes = await import("./notifications.js");
    await notes.notifyMentions(env, session, text, [session.public_id], "pmention:" + row.id, statusHash(session.handle, row.id));
  } catch (err) { /* the edit is saved */ }
  await bump(env, deps, [], session.public_id);
  return deps.json(200, { ok: true, id: row.id, body: text, editedAt: now });
}

async function remove(request, env, deps, session) {
  const body = await readBody(request, deps);
  const row = body ? await liveRow(env, postId(body.id)) : null;
  if (!row || row.hidden || row.author_id !== session.public_id) return deps.json(404, { error: "not_found" });
  await env.DB.batch([
    env.DB.prepare("UPDATE public_posts SET hidden = ? WHERE id = ?").bind(DELETED, row.id),
    env.DB.prepare("DELETE FROM public_post_likes WHERE post_id = ?").bind(row.id),
    env.DB.prepare("DELETE FROM public_poll_votes WHERE post_id = ?").bind(row.id),
    env.DB.prepare("DELETE FROM account_reposts WHERE post_key = ?").bind("r:app:" + row.id)
  ]);
  const parent = row.parent_id ? await liveRow(env, row.parent_id) : null;
  await bump(env, deps, [parent], session.public_id);
  return deps.json(200, { ok: true, id: row.id });
}

const SELECT = "SELECT p.id, p.author_id, p.body, p.parent_id, p.quote_id, p.created_at, p.hidden, p.audience, p.reply_control, p.location, p.poll_json, p.scheduled_at, p.ext_parent, a.handle, a.display_name, a.avatar FROM public_posts p JOIN accounts a ON a.public_id = p.author_id";

/* One post with its ancestors and its replies, sorted like the reply tabs. */
async function thread(request, env, deps, session) {
  const url = new URL(request.url);
  const id = postId(url.searchParams.get("id"));
  const sort = url.searchParams.get("sort") === "recent" ? "recent" : (url.searchParams.get("sort") === "liked" ? "liked" : "relevant");
  const row = id ? await env.DB.prepare(SELECT + " WHERE p.id = ?").bind(id).first() : null;
  if (!row || Number(row.scheduled_at) > Date.now()) return deps.json(404, { error: "not_found" });
  if (row.hidden) return deps.json(Number(row.hidden) === DELETED ? 410 : 404, { error: Number(row.hidden) === DELETED ? "deleted" : "not_found" });
  if (!(await viewerCanSee(env, session.public_id, row))) return deps.json(404, { error: "not_found" });
  const skip = await hiddenAuthors(env, session.public_id);
  const post = await presentPost(env, request, row, session.public_id);
  const listed = await env.DB.prepare(SELECT + " WHERE p.parent_id = ? AND p.hidden = 0 AND (p.scheduled_at = 0 OR p.scheduled_at <= ?) ORDER BY p.created_at ASC LIMIT 200").bind(id, Date.now()).all();
  const rows = ((listed && listed.results) || []).filter((item) => !skip.has(item.author_id));
  const sets = await audienceSets(env, session.public_id, rows.map((item) => item.author_id));
  const replies = [];
  for (const item of rows) {
    if ((item.audience || "") === "list") {
      if (!(await canSeeAudience(env, { viewerId: session.public_id, ownerId: item.author_id, audience: "list", subject: "post", subjectId: item.id }))) continue;
    } else if (!canSee(item, session.public_id, sets)) continue;
    replies.push(await presentPost(env, request, item, session.public_id));
  }
  await withParents(env, request, session, [post], skip);
  await decorate(env, [post].concat(replies), session.public_id);
  if (sort === "recent") replies.sort((a, b) => b.createdAt - a.createdAt);
  else if (sort === "liked") replies.sort((a, b) => (b.likes - a.likes) || (a.createdAt - b.createdAt));
  else {
    // Relevant: the author's own replies first, then by likes and replies, then oldest first.
    const score = (reply) => (reply.authorId === row.author_id ? 1e9 : 0) + reply.likes * 3 + reply.replyCount * 2;
    replies.sort((a, b) => (score(b) - score(a)) || (a.createdAt - b.createdAt));
  }
  const quotes = await env.DB.prepare("SELECT COUNT(*) AS n FROM public_posts WHERE quote_id = ? AND hidden = 0").bind(id).first();
  return deps.json(200, { post, replies, sort, quotes: Number(quotes && quotes.n) || 0 });
}

export async function handlePostActions(request, env, path, deps, clean) {
  const routes = { "/v1/posts/like": like, "/v1/posts/vote": vote, "/v1/posts/edit": edit, "/v1/posts/delete": remove };
  const isThread = path === "/v1/posts/thread" && request.method === "GET";
  if (!isThread && !(routes[path] && request.method === "POST")) return null;
  const session = await deps.sessionAccount(env, request);
  if (!session) return deps.json(401, { error: "unauthorized" });
  if (isThread) return thread(request, env, deps, session);
  return routes[path](request, env, deps, session, clean);
}
