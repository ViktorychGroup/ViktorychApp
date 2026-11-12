/* Who may insert a live post into this signed-in Home. The server already
   checked the follow, the blocks and the audience. This ties the event to
   the account that is signed in now and to the follows that account has. */
(function (root) {
  function livePostAllowed(session, follows, post) {
    const me = session && String(session.publicId || "");
    const author = post && String(post.authorId || "");
    if (!/^\d{12}$/.test(me) || !/^\d{12}$/.test(author) || me === author) return false;
    if (!post.id) return false;
    const want = "app:" + author;
    const list = Array.isArray(follows) ? follows : [];
    for (let i = 0; i < list.length; i++) {
      const item = String(list[i] || "");
      if (item === want || item === author) return true;
    }
    return false;
  }
  root.ViktorychHomeLive = { allowed: livePostAllowed };
})(typeof window !== "undefined" ? window : globalThis);
