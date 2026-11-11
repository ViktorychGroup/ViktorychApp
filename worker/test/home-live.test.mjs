import assert from "node:assert/strict";
import test from "node:test";
import { AccountChannel } from "../src/channel.js";
import { forgetFlags } from "../src/feature-flags.js";
import { pushLivePost } from "../src/post-actions.js";

const AUTHOR = "100000000001";
const VIEWER = "200000000002";
const OTHER = "300000000003";
const POST = "a".repeat(32);

function row(extra) {
  return Object.assign({
    id: POST,
    author_id: AUTHOR,
    body: "current text",
    parent_id: "",
    quote_id: "",
    created_at: 50,
    hidden: 0,
    audience: "everyone",
    reply_control: "everyone",
    location: "",
    poll_json: "",
    scheduled_at: 0,
    edited_at: 80,
    ext_parent: "",
    handle: "ada",
    display_name: "Public Ada"
  }, extra || {});
}

function mockEnv(mode, delivered) {
  const watched = [];
  return {
    watched: watched,
    DB: {
      prepare(sql) {
        const stmt = {
          bind(...args) {
            stmt.args = args;
            return stmt;
          },
          async run() { return { success: true }; },
          async first() {
            if (sql.indexOf("FROM public_posts") >= 0) {
              if (mode.quoteId && stmt.args && stmt.args[0] === mode.quoteId) {
                const quote = mode.quote || {};
                return row({
                  id: mode.quoteId,
                  author_id: quote.author_id || OTHER,
                  body: quote.body || "quoted public",
                  display_name: "Public Bea",
                  handle: "bea",
                  audience: quote.audience || "everyone",
                  hidden: quote.hidden || 0
                });
              }
              if (mode.missing) return null;
              return row(mode.post);
            }
            if (sql.indexOf("account_follows") >= 0 && sql.indexOf("locked_follows") < 0) {
              const viewer = stmt.args[0];
              if (mode.follow && viewer === VIEWER && stmt.args[1] === "app:" + AUTHOR) return { target_id: "app:" + AUTHOR };
              return null;
            }
            if (sql.indexOf("locked_follows") >= 0) return mode.locked ? { ok: 1 } : null;
            if (sql.indexOf("account_blocks") >= 0) {
              const ids = stmt.args || [];
              const quoteAuthor = (mode.quote && mode.quote.author_id) || OTHER;
              if (mode.block && ids.indexOf(AUTHOR) >= 0 && ids.indexOf(VIEWER) >= 0) return { blocked_id: AUTHOR };
              if (mode.quote && mode.quote.blocked && ids.indexOf(quoteAuthor) >= 0) return { blocked_id: quoteAuthor };
              return null;
            }
            if (sql.indexOf("account_mutes") >= 0) return mode.mute ? { muted_id: AUTHOR } : null;
            if (sql.indexOf("account_friends") >= 0) return mode.friend ? { friend_id: AUTHOR } : null;
            if (sql.indexOf("account_follow_requests") >= 0) return mode.pending ? { requester_id: VIEWER } : null;
            if (sql.indexOf("protected_account") >= 0) {
              const id = stmt.args && stmt.args[0];
              const quoteAuthor = (mode.quote && mode.quote.author_id) || OTHER;
              if (mode.protected && id === AUTHOR) return { protected_account: 1 };
              if (mode.quote && mode.quote.protected && id === quoteAuthor) return { protected_account: 1 };
              return { protected_account: 0 };
            }
            if (sql.indexOf("feature_flags") >= 0) return null;
            return null;
          },
          async all() {
            if (sql.indexOf("feature_flags") >= 0 && mode.flagOff) return { results: [{ name: "home_live", off: 1 }] };
            if (sql.indexOf("public_post_media") >= 0) return { results: [] };
            if (sql.indexOf("account_friends") >= 0) return { results: mode.friend ? [{ friend_id: AUTHOR }] : [] };
            if (sql.indexOf("account_follows") >= 0) return { results: mode.follow ? [{ follower_id: AUTHOR }] : [] };
            return { results: [] };
          }
        };
        return stmt;
      }
    },
    ACCOUNT_CHANNEL: {
      idFromName(id) { return id; },
      get(id) {
        return {
          async fetch(url, init) {
            const text = String(url);
            if (text.indexOf("/watchers/add") >= 0 || text.indexOf("/watchers/remove") >= 0) {
              watched.push(id);
              return Response.json({ ok: true });
            }
            if (text.indexOf("/watchers") >= 0) return Response.json({ ids: mode.watchers || [VIEWER] });
            if (text.indexOf("/deliver") >= 0) {
              delivered.push(JSON.parse(init.body));
              return Response.json({ ok: true });
            }
            return new Response("no", { status: 404 });
          }
        };
      }
    }
  };
}

test("an accepted follower receives the current public card", async () => {
  forgetFlags();
  const delivered = [];
  const n = await pushLivePost(mockEnv({ follow: true, post: { body: "edited text", edited_at: 90 } }, delivered), { id: POST, body: "stale text", authorName: "Secret nick", liked: true, authorId: AUTHOR });
  assert.equal(n, 1);
  const card = delivered[0].data.post;
  assert.equal(card.body, "edited text");
  assert.equal(card.authorName, "Public Ada");
  assert.equal(card.editedAt, 90);
  assert.equal(Object.prototype.hasOwnProperty.call(card, "liked"), false);
  assert.equal(card.authorName.indexOf("Secret"), -1);
});

const QUOTE = "b".repeat(32);

test("a public quote still appears with the quoted account's public name", async () => {
  forgetFlags();
  const delivered = [];
  const n = await pushLivePost(mockEnv({ follow: true, quoteId: QUOTE, post: { quote_id: QUOTE }, quote: { body: "quoted" } }, delivered), { id: POST, authorId: AUTHOR });
  assert.equal(n, 1);
  assert.equal(delivered[0].data.post.quote.body, "quoted");
  assert.equal(delivered[0].data.post.quote.authorName, "Public Bea");
  assert.equal(delivered[0].data.post.quote.unavailable, undefined);
});

test("a friends-only, list, or protected quote is withheld from a follower who cannot see it", async () => {
  for (const quote of [{ audience: "friends" }, { audience: "list" }, { protected: true, body: "secret quote" }]) {
    forgetFlags();
    const delivered = [];
    const n = await pushLivePost(mockEnv({ follow: true, quoteId: QUOTE, post: { quote_id: QUOTE }, quote: quote }, delivered), { id: POST, authorId: AUTHOR });
    assert.equal(n, 1, JSON.stringify(quote));
    assert.equal(delivered[0].data.post.quote.unavailable, true, JSON.stringify(quote));
    assert.equal(delivered[0].data.post.quote.body, undefined, JSON.stringify(quote));
    assert.equal(delivered[0].data.post.body, "current text");
  }
});

test("a quote from a blocked author is withheld", async () => {
  forgetFlags();
  const delivered = [];
  const n = await pushLivePost(mockEnv({ follow: true, quoteId: QUOTE, post: { quote_id: QUOTE }, quote: { blocked: true, body: "hidden quote" } }, delivered), { id: POST, authorId: AUTHOR });
  assert.equal(n, 1);
  assert.equal(delivered[0].data.post.quote.unavailable, true);
  assert.equal(delivered[0].data.post.quote.body, undefined);
});

test("home_live off sends nothing and records no posts watch", async () => {
  forgetFlags();
  const delivered = [];
  const env = mockEnv({ follow: true, flagOff: true }, delivered);
  const n = await pushLivePost(env, { id: POST, authorId: AUTHOR });
  assert.equal(n, 0);
  assert.equal(delivered.length, 0);
  const channel = new AccountChannel({ id: { name: VIEWER }, getWebSockets() { return []; } }, env);
  const ws = {
    att: { topics: ["posts"], watches: {} },
    deserializeAttachment() { return this.att; },
    serializeAttachment(next) { this.att = next; },
    send() {}
  };
  await channel.webSocketMessage(ws, JSON.stringify({ op: "watch", topic: "posts", ids: [AUTHOR] }));
  assert.equal(env.watched.length, 0);
});

test("non-followers, pending follows, locks, blocks, mutes and protected strangers get nothing", async () => {
  for (const mode of [{}, { pending: true }, { follow: true, locked: true }, { follow: true, block: true }, { follow: true, mute: true }, { protected: true }]) {
    forgetFlags();
    const delivered = [];
    const n = await pushLivePost(mockEnv(mode, delivered), { id: POST, authorId: AUTHOR });
    assert.equal(n, 0, JSON.stringify(mode));
    assert.equal(delivered.length, 0, JSON.stringify(mode));
  }
});

test("a protected author still reaches an accepted follower", async () => {
  forgetFlags();
  const delivered = [];
  const n = await pushLivePost(mockEnv({ follow: true, protected: true }, delivered), { id: POST, authorId: AUTHOR });
  assert.equal(n, 1);
  assert.equal(delivered.length, 1);
});

test("a friends-only post is not sent to a follower who is not a friend", async () => {
  forgetFlags();
  const delivered = [];
  const n = await pushLivePost(mockEnv({ follow: true, post: { audience: "friends" } }, delivered), { id: POST, authorId: AUTHOR });
  assert.equal(n, 0);
  assert.equal(delivered.length, 0);
});

test("a deleted or hidden post is not sent", async () => {
  for (const mode of [{ missing: true }, { follow: true, post: { hidden: 2 } }, { follow: true, post: { hidden: 1 } }]) {
    forgetFlags();
    const delivered = [];
    const n = await pushLivePost(mockEnv(mode, delivered), { id: POST, body: "still here", authorId: AUTHOR });
    assert.equal(n, 0, JSON.stringify(mode));
    assert.equal(delivered.length, 0);
  }
});

test("a posts watch is stored only for an accepted unlocked follow", async () => {
  for (const follow of [false, true]) {
    const env = mockEnv({ follow: follow }, []);
    const ctx = { id: { name: VIEWER }, getWebSockets() { return []; } };
    const channel = new AccountChannel(ctx, env);
    const ws = {
      att: { topics: ["posts"], watches: {} },
      deserializeAttachment() { return this.att; },
      serializeAttachment(next) { this.att = next; },
      send() {}
    };
    await channel.webSocketMessage(ws, JSON.stringify({ op: "watch", topic: "posts", ids: [AUTHOR] }));
    assert.equal(env.watched.length, follow ? 1 : 0, String(follow));
  }
});
