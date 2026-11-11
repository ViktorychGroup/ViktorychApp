import assert from "node:assert/strict";
import test from "node:test";
import { loadCardSources, presentPost } from "../src/posts.js";

const POSTS = [
  { id: "a".repeat(32), author_id: "100000000001", body: "one", quote_id: "", display_name: "Ada", handle: "ada" },
  { id: "b".repeat(32), author_id: "100000000001", body: "two", quote_id: "c".repeat(32), display_name: "Ada", handle: "ada" },
  { id: "d".repeat(32), author_id: "100000000001", body: "three", quote_id: "", display_name: "Ada", handle: "ada" }
];

const MEDIA = [
  { id: "m2", post_id: "a".repeat(32), mime: "image/png", size: 8, alt_text: "later", sort_order: 2 },
  { id: "m1", post_id: "a".repeat(32), mime: "image/png", size: 4, alt_text: "first", sort_order: 1 },
  { id: "mq", post_id: "c".repeat(32), mime: "image/png", size: 3, alt_text: "quoted", sort_order: 0 }
];

const QUOTE = {
  id: "c".repeat(32),
  author_id: "100000000001",
  body: "quoted body",
  parent_id: "",
  created_at: 10,
  audience: "everyone",
  hidden: 0,
  scheduled_at: 0,
  ext_parent: "",
  handle: "ada",
  display_name: "Ada",
  avatar: ""
};

function storeDb() {
  const sqls = [];
  const env = {
    DB: {
      prepare(sql) {
        sqls.push(sql);
        const stmt = {
          bind(...args) {
            stmt.args = args;
            return stmt;
          },
          async all() {
            if (sql.indexOf("public_post_media") >= 0) {
              const wanted = new Set(stmt.args);
              return { results: MEDIA.filter((item) => wanted.has(item.post_id)).slice().sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1)) };
            }
            if (sql.indexOf("gift_sends") >= 0) {
              return { results: [{ id: "g1", gift_id: "star", sender_id: "100000000001", recipient_id: "200000000002", message: "", privacy: "public", hidden: 0, context: "", post_id: "d".repeat(32), created_at: 5, sender_handle: "ada", sender_name: "Ada" }] };
            }
            if (sql.indexOf("FROM public_posts") >= 0) return { results: [QUOTE] };
            return { results: [] };
          },
          async first() { return null; }
        };
        return stmt;
      }
    }
  };
  return { env, sqls };
}

test("a page of posts reads media, gifts and quotes once", async () => {
  const { env, sqls } = storeDb();
  const cached = await loadCardSources(env, POSTS);
  assert.equal(sqls.length, 3);
  assert.ok(sqls.some((sql) => sql.indexOf("public_post_media") >= 0 && sql.indexOf(" IN (") >= 0));
  assert.ok(sqls.some((sql) => sql.indexOf("gift_sends") >= 0 && sql.indexOf(" IN (") >= 0));
  const before = sqls.length;
  const request = { url: "https://accounts.test/v1/posts" };
  const cards = [];
  for (let i = 0; i < POSTS.length; i++) cards.push(await presentPost(env, request, POSTS[i], "200000000002", cached));
  const later = sqls.slice(before);
  assert.equal(later.filter((sql) => sql.indexOf("public_post_media") >= 0 || sql.indexOf("gift_sends") >= 0 || sql.indexOf("FROM public_posts") >= 0).length, 0);
  assert.deepEqual(cards[0].media.map((item) => item.alt), ["first", "later"]);
  assert.equal(cards[1].quote.body, "quoted body");
  assert.equal(cards[1].quote.media[0].alt, "quoted");
  assert.equal(cards[2].gift && cards[2].gift.id, "g1");
  assert.equal(cards[0].gift, null);
});
