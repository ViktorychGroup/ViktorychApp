/* Test-only entry: the real Worker plus a sample friendship bypass hook, the
   way the owner inspector would register one. Not deployed. */
import worker from "../../src/index.js";
import { setFriendshipBypass } from "../../src/friend-privacy.js";

setFriendshipBypass({
  allows(env, viewer) { return Number(viewer.owner) === 1; },
  async record(env, viewerId, targetIds, action) {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS test_bypass_log (viewer_id TEXT, target_id TEXT, action TEXT)").run();
    await env.DB.batch(targetIds.map((id) => env.DB.prepare("INSERT INTO test_bypass_log (viewer_id, target_id, action) VALUES (?, ?, ?)").bind(viewerId, id, action)));
  }
});

export * from "../../src/index.js";
export default worker;
