/** Reply context: each reply carries its parent chain (up to a few levels) so
   feeds can show the parent above it and the post page can show every ancestor. */

const MAX_DEPTH = 8;

function node(row, community) {
  const less = row.profile_less === 1;
  const out = {
    id: row.id,
    body: row.body || "",
    createdAt: Number(row.created_at) || 0,
    parentId: row.parent_id || "",
    authorId: less ? "" : row.author_id,
    authorName: less ? "Anonymous" : (row.display_name || row.handle || ""),
    authorHandle: less ? "anonymous" : (row.handle || ""),
    // Avatars go through the viewer-aware resolvers below (the column is a storage key).
    authorAvatar: "",
    media: []
  };
  if (community) out.community = { name: community, rootId: "" };
  return out;
}

/* Public parents follow the same audience rules as the list (canSee); community
   parents sit in the same community as the reply, so the viewer can already see them. */
export async function attachParents(env, posts, opts) {
  opts = opts || {};
  const skip = opts.skip || new Set();
  const canSee = opts.canSee || ((row) => (row.audience || "everyone") === "everyone" || row.author_id === opts.viewerId);
  const found = {};
  let want = [];
  posts.forEach((post) => { if (post && post.parentId) want.push(post.parentId); });
  for (let depth = 0; depth < MAX_DEPTH && want.length; depth++) {
    const ids = Array.from(new Set(want.filter((id) => id && !(id in found)))).slice(0, 80);
    want = [];
    if (!ids.length) break;
    const marks = ids.map(() => "?").join(",");
    try {
      const pub = await env.DB.prepare("SELECT p.id, p.author_id, p.body, p.parent_id, p.created_at, p.audience, a.handle, a.display_name, a.avatar FROM public_posts p JOIN accounts a ON a.public_id = p.author_id WHERE p.hidden = 0 AND p.id IN (" + marks + ")").bind(...ids).all();
      for (const row of (pub && pub.results) || []) {
        if (skip.has(row.author_id) || !(await canSee(row))) continue;
        found[row.id] = node(row, "");
      }
    } catch (err) { /* no public parents */ }
    try {
      const com = await env.DB.prepare("SELECT c.id, c.author_id, c.body, c.parent_id, c.created_at, c.community_id, a.handle, a.display_name, a.avatar, a.profile_less FROM community_posts c JOIN accounts a ON a.public_id = c.author_id WHERE c.deleted_at = 0 AND c.id IN (" + marks + ")").bind(...ids).all();
      for (const row of (com && com.results) || []) {
        if (skip.has(row.author_id)) continue;
        found[row.id] = node(row, row.community_id || "");
      }
    } catch (err) { /* no community parents */ }
    ids.forEach((id) => { if (!(id in found)) found[id] = null; });
    ids.forEach((id) => { if (found[id] && found[id].parentId) want.push(found[id].parentId); });
  }
  if (opts.faceFor) {
    for (const id of Object.keys(found)) {
      const hit = found[id];
      if (!hit || hit.community || !hit.authorId) continue;
      try {
        const face = await opts.faceFor(hit.authorId);
        hit.authorAvatar = face.avatar || "";
        hit.authorLocked = !!face.locked;
        hit.authorOfficial = !!face.official;
      } catch (err) { hit.authorAvatar = ""; }
    }
  }
  if (opts.avatarFor) {
    for (const id of Object.keys(found)) {
      const hit = found[id];
      if (!hit || !hit.community || !hit.authorHandle || hit.authorHandle === "anonymous") continue;
      try { hit.authorAvatar = (await opts.avatarFor(hit.authorHandle)) || ""; } catch (err) { hit.authorAvatar = ""; }
    }
  }
  const chain = (id, depth, seen) => {
    const hit = found[id];
    if (!hit || depth >= MAX_DEPTH || seen.has(id)) return null;
    seen.add(id);
    const copy = Object.assign({}, hit);
    if (copy.parentId) {
      const up = chain(copy.parentId, depth + 1, seen);
      if (up) copy.parent = up;
    }
    return copy;
  };
  posts.forEach((post) => {
    if (!post || !post.parentId || post.parent) return;
    const up = chain(post.parentId, 0, new Set([post.id]));
    if (up) post.parent = up;
  });
  return posts;
}
