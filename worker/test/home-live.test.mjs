import assert from "node:assert/strict";
import test from "node:test";
import { forgetFlags } from "../src/feature-flags.js";
import { liveCard, pushLivePost } from "../src/post-actions.js";

const AUTHOR = "100000000001";
const VIEWER = "200000000002";

function mockEnv(mode, delivered) {
  return {
    DB: {
      prepare(sql) {
        const stmt = {
          bind() { return stmt; },
          async run() { return { success: true }; },
          async first() {
            if (sql.indexOf("account_blocks") >= 0 && mode.block) return { blocker_id: AUTHOR };
            if (sql.indexOf("account_mutes") >= 0 && mode.mute) return { muted_id: AUTHOR };
            if (sql.indexOf("locked_follows") >= 0 && mode.locked) return { ok: 1 };
            return null;
          },
          async all() {
            if (sql.indexOf("feature_flags") >= 0 && mode.flagOff) return { results: [{ name: "home_live", off: 1 }] };
            return { results: [] };
          }
        };
        return stmt;
      }
    },
    ACCOUNT_CHANNEL: {
      idFromName(id) { return id; },
      get() {
        return {
          async fetch(url, init) {
            const text = String(url);
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

function sample() {
  return {
    id: "a".repeat(32),
    authorId: AUTHOR,
    body: "Hello from the bench",
    audience: "everyone",
    liked: true,
    reposted: true,
    likes: 2,
    poll: { options: ["a", "b"], mine: 0 }
  };
}

test("a live card drops the author's like and vote", () => {
  const card = liveCard(sample());
  assert.equal(card.liked, false);
  assert.equal(card.reposted, false);
  assert.equal(card.poll.mine, -1);
  assert.equal(card.likes, 2);
  assert.equal(card.body, "Hello from the bench");
});

test("a card that cannot fit the channel is not sent", () => {
  const post = sample();
  post.body = "x".repeat(8000);
  assert.equal(liveCard(post), null);
});

test("an open follower receives the card", async () => {
  forgetFlags();
  const delivered = [];
  const n = await pushLivePost(mockEnv({}, delivered), sample());
  assert.equal(n, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].topic, "posts");
  assert.equal(delivered[0].data.post.liked, false);
  assert.equal(delivered[0].data.post.authorId, AUTHOR);
});

test("the author is not pushed their own card", async () => {
  forgetFlags();
  const delivered = [];
  const n = await pushLivePost(mockEnv({ watchers: [AUTHOR, VIEWER] }, delivered), sample());
  assert.equal(n, 1);
  assert.equal(delivered.length, 1);
});

test("a block, a mute, a locked follow, or the switch sends nothing", async () => {
  for (const mode of [{ block: true }, { mute: true }, { locked: true }, { flagOff: true }]) {
    forgetFlags();
    const delivered = [];
    const n = await pushLivePost(mockEnv(mode, delivered), sample());
    assert.equal(n, 0, JSON.stringify(mode));
    assert.equal(delivered.length, 0, JSON.stringify(mode));
  }
});
