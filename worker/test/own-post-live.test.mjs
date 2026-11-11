import assert from "node:assert/strict";
import test from "node:test";
import { authorPostNote } from "../src/post-actions.js";

test("the author's other devices get one card, not a rebuild note", () => {
  const note = authorPostNote({
    id: "a".repeat(32),
    body: "hello",
    createdAt: 10,
    authorId: "100000000001",
    authorName: "Ada",
    authorHandle: "ada",
    likes: 1,
    liked: true
  });
  assert.equal(note.post.body, "hello");
  assert.equal(note.post.liked, true);
  assert.equal(note.post.id, "a".repeat(32));
});

test("a card that cannot fit the channel keeps only the id", () => {
  const note = authorPostNote({ id: "b".repeat(32), body: "x".repeat(8000), authorId: "100000000001" });
  assert.equal(note.post, undefined);
  assert.equal(note.id, "b".repeat(32));
});
