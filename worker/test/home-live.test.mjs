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
              if (mode.missing) return null;
              return row(mode.post);
            }
            if (sql.indexOf("account_follows") >= 0 && sql.indexOf("locked_follows") < 0) {
              const viewer = stmt.args[0];
              if (mode.follow && viewer === VIEWER) return { target_id: "app:" + AUTHOR };
              return null;
            }
            if (sql.indexOf("locked_follows") >= 0) return mode.locked ? { ok: 1 } : null;
            if (sql.indexOf("account_blocks") >= 0) return mode.block ? { blocked_id: AUTHOR } : null;
            if (sql.indexOf("account_mutes") >= 0) return mode.mute ? { muted_id: AUTHOR } : null;
            if (sql.indexOf("account_friends") >= 0) return mode.friend ? { friend_id: AUTHOR } : null;
            if (sql.indexOf("account_follow_requests") >= 0) return mode.pending ? { requester_id: VIEWER } : null;
            if (sql.indexOf("protected_account") >= 0) return { protected_account: mode.protected ? 1 : 0 };
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

test("a quote keeps the quoted account's public name", async () => {
  forgetFlags();
  const delivered = [];
  const env = mockEnv({ follow: true, post: { quote_id: "b".repeat(32) } }, delivered);
  const real = env.DB.prepare;
  env.DB.prepare = (sql) => {
    const stmt = real(sql);
    const first = stmt.first.bind(stmt);
    stmt.first = async () => {
      if (sql.indexOf("FROM public_posts") >= 0 && stmt.args && stmt.args[0] === "b".repeat(32)) {
        return row({ id: "b".repeat(32), body: "quoted", display_name: "Public Bea", handle: "bea", author_id: OTHER });
      }
      return first();
    };
    return stmt;
  };
  const n = await pushLivePost(env, { id: POST, authorId: AUTHOR });
  assert.equal(n, 1);
  assert.equal(delivered[0].data.post.quote.authorName, "Public Bea");
  assert.equal(delivered[0].data.post.quote.body, "quoted");
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
