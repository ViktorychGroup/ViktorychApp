/* Unified profiles. people.json is the only source of linked accounts. */
(function (root) {

  function tr(key, vars) {
    var fn = (typeof window !== "undefined" && window.t) ? window.t : ((typeof self !== "undefined" && self.t) ? self.t : null);
    const text = fn ? fn(key, vars) : key;
    return vars ? String(text).replace(/\{(\w+)\}/g, (all, name) => (vars[name] != null ? String(vars[name]) : all)) : text;
  }
  function trn(key, n, vars) {
    var fn = (typeof window !== "undefined" && window.tn) ? window.tn : ((typeof self !== "undefined" && self.tn) ? self.tn : null);
    return fn ? fn(key, n, vars) : String(n);
  }
  function productName(kind) {
    var api = (typeof SI18n !== "undefined") ? SI18n : ((typeof window !== "undefined" && window.SI18n) ? window.SI18n : ((typeof self !== "undefined" && self.SI18n) ? self.SI18n : null));
    return (api && api.productName) ? api.productName(kind) : "";
  }

  const NET = {
    x: "X",
    threads: "Threads",
    instagram: "Instagram",
    youtube: "YouTube",
    vk: "VK",
    telegram: "Telegram",
    discord: "Discord",
    tiktok: "TikTok",
    bsky: "Bluesky",
    bluesky: "Bluesky",
    mastodon: "Fediverse",
    reddit: "Reddit",
    rss: "RSS"
  };
  let bound = null;
  let people = [];
  const byKey = new Map();

  function hooks() { return bound || {}; }

  function esc(value) {
    const fn = hooks().esc;
    if (fn) return fn(value);
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function lower(value) {
    return String(value || "").replace(/^@/, "").trim().toLowerCase();
  }

  function remember(key, person) {
    const text = String(key || "");
    if (!text || byKey.has(text)) return;
    byKey.set(text, person);
  }

  /* Per-reader overrides, synced with the account as settings.peopleLinks:
     off   feed ids of a merged person this reader does not follow (never read, never shown)
     split feed ids pulled out of any merged profile
     join  merges this reader confirmed: { id, name, rows: [account rows] }
     dismiss suggestion keys answered with Not now
     pick  the last platform choice when following a merged person */
  let rawDoc = null;
  let suggestRows = [];
  function cleanLinks(value) {
    const v = value && typeof value === "object" ? value : {};
    const list = (x, cap) => (Array.isArray(x) ? x : []).map((item) => String(item || "")).filter(Boolean).slice(-cap);
    const joins = (Array.isArray(v.join) ? v.join : []).filter((row) => row && row.id && Array.isArray(row.rows) && row.rows.length >= 2).slice(-200).map((row) => ({
      id: String(row.id), name: String(row.name || ""), avatar: String(row.avatar || ""),
      rows: row.rows.slice(0, 12).map((a) => ({ platform: String(a.platform || "x"), handle: String(a.handle || ""), feedId: String(a.feedId || ""), name: String(a.name || ""), avatar: String(a.avatar || ""), channelId: String(a.channelId || "") }))
    }));
    const pick = {};
    if (v.pick && typeof v.pick === "object") Object.keys(v.pick).slice(0, 40).forEach((k) => { pick[k] = v.pick[k] !== false; });
    return { off: list(v.off, 2000), split: list(v.split, 2000), join: joins, dismiss: list(v.dismiss, 500), pick: pick };
  }
  let linksMemo = { raw: undefined, value: null, off: null };
  function links() {
    const fn = hooks().links;
    const raw = fn ? fn() : null;
    if (linksMemo.value && linksMemo.raw === raw) return cloneLinks(linksMemo.value);
    const value = cleanLinks(raw);
    linksMemo = { raw: raw, value: value, off: new Set(value.off.map(folded)) };
    return cloneLinks(value);
  }
  function cloneLinks(v) {
    return { off: v.off.slice(), split: v.split.slice(), join: v.join.map((row) => Object.assign({}, row, { rows: row.rows.slice() })), dismiss: v.dismiss.slice(), pick: Object.assign({}, v.pick) };
  }
  function saveLinks(next) {
    const fn = hooks().saveLinks;
    if (fn) fn(cleanLinks(next));
    rebuild();
  }
  function folded(id) { return String(id || "").toLowerCase(); }

  function ingest(doc) {
    rawDoc = doc || { people: [] };
    rebuild();
  }

  function rebuild() {
    const doc = rawDoc || { people: [] };
    const prefs = links();
    const split = new Set(prefs.split.map(folded));
    const out = [];
    ((doc && doc.people) || []).forEach((person) => {
      if (!person || !person.id) return;
      const accounts = (person.accounts || []).filter((account) => !split.has(folded(account.feedId || ((account.platform || "x") + ":" + (account.handle || "")))));
      if (accounts.length === (person.accounts || []).length) { out.push(person); return; }
      if (accounts.length >= 2) out.push(Object.assign({}, person, { accounts: accounts }));
    });
    prefs.join.forEach((row) => {
      const rows = row.rows.filter((a) => !split.has(folded(a.feedId)));
      if (rows.length < 2) return;
      const host = out.find((person) => (person.accounts || []).some((account) => rows.some((a) => a.feedId && folded(a.feedId) === folded(account.feedId))));
      if (host) {
        const extra = rows.filter((a) => !(host.accounts || []).some((account) => folded(account.feedId) === folded(a.feedId)));
        if (extra.length) out[out.indexOf(host)] = Object.assign({}, host, { accounts: (host.accounts || []).concat(extra.map((a) => Object.assign({ user: true }, a))) });
        return;
      }
      out.push({ id: row.id, name: row.name || rows[0].name || rows[0].handle, avatar: row.avatar || rows.map((a) => a.avatar).filter(Boolean)[0] || "", user: true, accounts: rows });
    });
    people = out;
    byKey.clear();
    people.forEach((person) => {
      if (!person || !person.id) return;
      (person.accounts || []).forEach((account) => {
        const platform = account.platform || "x";
        const handle = lower(account.handle);
        if (handle) remember(platform + ":" + handle, person);
        if (account.channelId) {
          remember(platform + ":" + lower(account.channelId), person);
          remember(platform + ":" + account.channelId, person);
        }
        if (account.permanentId) remember(platform + ":" + String(account.permanentId), person);
        if (account.secUid) remember(platform + ":" + String(account.secUid), person);
        if (account.feedId) remember(String(account.feedId).toLowerCase(), person);
      });
    });
    crossMemo = null;
    people.forEach((person) => {
      if (!person || !person.id) return;
      (person.accounts || []).forEach((account) => {
        const platform = account.platform || "x";
        (account.previousHandles || []).forEach((item) => {
          const handle = lower(item);
          if (handle) remember(platform + ":" + handle, person);
        });
      });
    });
  }

  function match(platform, handle) {
    const key = lower(handle);
    if (!key) return null;
    const name = platform || "x";
    return byKey.get(name + ":" + key) || byKey.get(key) || null;
  }

  function matchFeed(feed) {
    if (!feed) return null;
    return match(feed.platform, feed.handle) || match(feed.platform, feed.channelId) || match(feed.platform, feed.id) || (feed.id ? byKey.get(String(feed.id).toLowerCase()) : null) || null;
  }

  function byId(id) {
    const key = String(id || "");
    return people.find((person) => person && person.id === key) || null;
  }

  function hashFor(platform, handle) {
    const person = match(platform, handle);
    return person ? "#/p/" + encodeURIComponent(person.id) : "";
  }

  function titleFor(route) {
    if (!route) return "";
    const person = route.name === "person" ? byId(route.id) : match(route.platform, route.handle);
    return person ? (person.name || person.id) : "";
  }

  function accountHandles(account) {
    return [account && account.handle].concat((account && account.previousHandles) || []).map(lower).filter(Boolean);
  }

  function sameAccount(feed, account) {
    if (!feed || !account) return false;
    if ((feed.platform || "x") !== (account.platform || "x")) return false;
    const handle = lower(feed.handle);
    const channel = String(feed.channelId || "");
    const names = accountHandles(account);
    if (handle && names.indexOf(handle) >= 0) return true;
    if (account.channelId && (channel === account.channelId || handle === lower(account.channelId))) return true;
    if (account.permanentId && String(feed.permanentId || "") === String(account.permanentId)) return true;
    if (account.feedId && feed.id === account.feedId) return true;
    return false;
  }

  function catalogIds(person) {
    const list = hooks().feeds ? hooks().feeds() : [];
    const ids = [];
    (person.accounts || []).forEach((account) => {
      list.forEach((feed) => {
        if (feed && feed.id && sameAccount(feed, account) && ids.indexOf(feed.id) < 0) ids.push(feed.id);
      });
      if (account.feedId && ids.indexOf(account.feedId) < 0) {
        const known = list.some((feed) => feed && feed.id === account.feedId);
        if (known) ids.push(account.feedId);
      }
    });
    return ids;
  }

  function personOf(id) {
    const raw = String(id || "");
    return byId(raw.replace(/^person:/, "")) || matchFeed({ id: raw, platform: raw.split(":")[0], handle: raw.split(":").slice(1).join(":") });
  }

  function offSet() {
    const fn = hooks().links;
    const raw = fn ? fn() : null;
    if (!(linksMemo.value && linksMemo.raw === raw)) links();
    return linksMemo.off || new Set();
  }

  function followIds(id) {
    const raw = String(id || "");
    const person = personOf(raw);
    if (!person) return raw ? [raw] : [];
    const ids = catalogIds(person);
    if (!ids.length) return raw ? [raw] : [];
    const off = offSet();
    const on = ids.filter((item) => !off.has(folded(item)));
    if (on.length) return on;
    return off.has(folded(raw)) ? [] : (raw && raw.indexOf("person:") !== 0 ? [raw] : []);
  }

  function allIds(id) {
    const person = personOf(id);
    return person ? catalogIds(person) : [];
  }

  /* Cross-posts: the sync folds copies of one post into crossPosts. Copies that
     still arrive from another path (archive, a live read) are hidden here. */
  let crossMemo = null;
  function crossIndex() {
    const list = hooks().basePosts ? hooks().basePosts() : [];
    if (crossMemo && crossMemo.list === list && crossMemo.n === list.length) return crossMemo.keys;
    const keys = new Set();
    list.forEach((post) => {
      (post && post.crossPosts || []).forEach((ref) => {
        if (!ref) return;
        if (ref.id) keys.add(folded((ref.platform || "") + "|" + ref.id));
        if (ref.statusId) keys.add(folded((ref.platform || "") + "|" + ref.statusId));
      });
    });
    crossMemo = { list: list, n: list.length, keys: keys };
    return keys;
  }

  function postFeedId(post, person) {
    if (post.feedId) return post.feedId;
    const account = (person.accounts || []).find((a) => (a.platform || "x") === (post.platform || "x") && accountHandles(a).indexOf(lower(post.handle)) >= 0);
    return account ? (account.feedId || "") : "";
  }

  /* True when the reader turned this platform off for its person and no copy
     on a platform they keep exists, or when the post is a folded copy. Runs
     before a card is built, so nothing from an off platform loads. */
  function hidden(post) {
    if (!post) return false;
    if (!(post.crossPosts && post.crossPosts.length)) {
      const keys = crossIndex();
      if (keys.size && (keys.has(folded((post.platform || "") + "|" + post.id)) || (post.statusId && keys.has(folded((post.platform || "") + "|" + post.statusId))))) return true;
    }
    const off = offSet();
    if (!off.size) return false;
    const person = match(post.platform || "x", post.handle) || (post.feedId ? byKey.get(folded(post.feedId)) : null);
    if (!person) return false;
    const own = postFeedId(post, person);
    if (!own || !off.has(folded(own))) return false;
    return !(post.crossPosts || []).some((ref) => ref && ref.feedId && !off.has(folded(ref.feedId)));
  }

  function originalUrl(ref) {
    if (!ref) return "";
    if (ref.url) return ref.url;
    const id = String(ref.statusId || ref.id || "");
    if (ref.platform === "youtube" && /^[\w-]{11}$/.test(id)) return "https://www.youtube.com/watch?v=" + id;
    if (ref.platform === "x" && /^\d+$/.test(id)) return "https://x.com/i/status/" + id;
    return "";
  }

  /* Small platform badges on a folded post. Each opens that platform's original. */
  function badges(post) {
    const refs = (post && post.crossPosts) || [];
    if (!refs.length) return "";
    const h = hooks();
    const glyph = h.platformGlyph || (() => "");
    const off = offSet();
    const rows = [{ platform: post.platform || "x", url: post.url || originalUrl(post), feedId: post.feedId || "" }].concat(refs);
    const seen = {};
    const html = rows.map((ref) => {
      const platform = ref.platform || "x";
      if (seen[platform]) return "";
      seen[platform] = true;
      const href = originalUrl(ref);
      const net = NET[platform] || platform;
      const dim = ref.feedId && off.has(folded(ref.feedId)) ? " off" : "";
      const label = tr("Open on {platform}", { platform: net });
      return href
        ? `<a class="xp-badge${dim}" data-act="stop" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(label)}" aria-label="${esc(label)}">${glyph(platform)}</a>`
        : `<span class="xp-badge${dim}" title="${esc(net)}">${glyph(platform)}</span>`;
    }).join("");
    return `<span class="xp-badges">${html}</span>`;
  }

  function reposterMatch(post, person) {
    const by = post && post.repostedBy;
    if (!post || !person || !by || !(by.handle || by.name || by.feedId)) return false;
    const platform = by.platform || post.platform || "x";
    const handle = lower(by.handle);
    return (person.accounts || []).some((account) => {
      if (by.feedId && account.feedId && by.feedId === account.feedId) return true;
      return (account.platform || "x") === platform && !!handle && accountHandles(account).indexOf(handle) >= 0;
    });
  }

  function authorMatch(post, person) {
    if (!post || !person) return false;
    const platform = post.platform || "x";
    const handle = lower(post.handle);
    if (!handle) return false;
    return (person.accounts || []).some((account) => (account.platform || "x") === platform && accountHandles(account).indexOf(handle) >= 0);
  }

  function countsAsOwn(post, person) {
    if (!post || post.kind === "reply") return false;
    if (reposterMatch(post, person) && !authorMatch(post, person)) return false;
    return true;
  }

  function owns(post, person) {
    if (!post || !person) return false;
    const platform = post.platform || "x";
    const handle = lower(post.handle);
    const channel = String(post.channelId || "");
    return (person.accounts || []).some((account) => {
      if ((account.platform || "x") !== platform) return false;
      if (account.feedId && post.feedId === account.feedId) return true;
      if (handle && accountHandles(account).indexOf(handle) >= 0) return true;
      if (account.permanentId && String(post.permanentId || "") === String(account.permanentId)) return true;
      if (account.channelId && (channel === account.channelId || handle === lower(account.channelId) || post.feedId === (account.platform + ":" + account.channelId))) return true;
      return false;
    }) || catalogIds(person).indexOf(post.feedId) >= 0;
  }

  function stamp(post) { return (post && (post.sortDate || post.date)) || ""; }

  function dedupePosts(rows) {
    const seen = new Set();
    const out = [];
    rows.forEach((post) => {
      if (!post) return;
      const order = typeof window !== "undefined" ? window.FeedOrder : null;
      const key = order ? order.key(post) : (post.platform || "") + ":" + (post.kind === "repost" ? post.id : (post.statusId || post.id));
      if (seen.has(key)) return;
      seen.add(key);
      out.push(post);
    });
    const order = typeof window !== "undefined" ? window.FeedOrder : null;
    out.sort((a, b) => order ? order.compare(a, b) : (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : 0));
    return out;
  }

  function isShort(post) {
    if (!post || (post.platform || "x") === "x") return false;
    if (post.short) return true;
    const blob = [post.url, post.statusId, post.id].join(" ");
    if (/\/shorts\//.test(blob)) return true;
    const media = (post.media || [])[0];
    const dur = media && Number(media.duration);
    return !!(media && (media.type === "video" || media.type === "animated_gif") && isFinite(dur) && dur > 0 && dur <= 60);
  }

  function isVideo(post) {
    if (!post || post.kind === "reply" || post.kind === "community" || post.kind === "repost" || isShort(post)) return false;
    if (post.repostedBy && (post.repostedBy.handle || post.repostedBy.name)) return false;
    if (post.platform === "youtube") return true;
    return (post.media || []).some((item) => item && (item.type === "video" || item.type === "animated_gif"));
  }

  function hasMedia(post) {
    return (post.media || []).some((item) => item && (item.type === "photo" || item.type === "video" || item.type === "animated_gif" || item.poster || (item.type !== "link" && item.url)));
  }

  function tabsFor(person, rows) {
    const platforms = {};
    (person.accounts || []).forEach((account) => { platforms[account.platform || "x"] = true; });
    const tabs = [["posts", tr("Posts")]];
    if (platforms.youtube || platforms.x || rows.some(isVideo)) tabs.push(["videos", tr("Videos")]);
    if (platforms.youtube || rows.some(isShort)) tabs.push(["shorts", "Shorts"]);
    if (platforms.youtube || rows.some((post) => post.kind === "community")) tabs.push(["community", tr("Community")]);
    if (platforms.x || platforms.threads || rows.some((post) => post.kind === "reply")) tabs.push(["replies", tr("Replies")]);
    if (platforms.x || platforms.instagram || platforms.threads || platforms.vk || platforms.telegram || platforms.discord || rows.some(hasMedia)) tabs.push(["media", tr("Media")]);
    return tabs;
  }

  function filterTab(rows, tab) {
    if (tab === "videos") return rows.filter(isVideo);
    if (tab === "shorts") return rows.filter(isShort);
    if (tab === "community") return rows.filter((post) => post.kind === "community");
    if (tab === "replies") return rows.filter((post) => post.kind === "reply");
    if (tab === "media") return rows.filter((post) => post.kind !== "reply" && hasMedia(post));
    return rows.filter((post) => post.kind !== "reply");
  }

  function postsFor(person, all) {
    return dedupePosts((all || []).filter((post) => owns(post, person)));
  }

  function external(account) {
    if (!account) return "";
    if (account.url) return account.url;
    const handle = account.handle || "";
    if (account.platform === "x") return "https://x.com/" + handle;
    if (account.platform === "youtube") return account.channelId ? "https://www.youtube.com/channel/" + account.channelId : "https://www.youtube.com/@" + handle;
    if (account.platform === "instagram") return "https://www.instagram.com/" + handle + "/";
    if (account.platform === "threads") return "https://www.threads.com/@" + handle;
    if (account.platform === "vk") return "https://vk.com/" + handle;
    if (account.platform === "telegram") return "https://t.me/" + handle;
    if (account.platform === "tiktok") return "https://www.tiktok.com/@" + handle;
    if (account.platform === "bsky" || account.platform === "bluesky") return "https://bsky.app/profile/" + handle;
    if (account.platform === "reddit") return "https://www.reddit.com/user/" + handle;
    return account.url || "";
  }

  function preferred(person) {
    const accounts = person.accounts || [];
    const rank = { youtube: 0, x: 1, instagram: 2 };
    return accounts.slice().sort((a, b) => (rank[a.platform] == null ? 9 : rank[a.platform]) - (rank[b.platform] == null ? 9 : rank[b.platform]))[0] || null;
  }

  function baseFeed(person) {
    const list = hooks().feeds ? hooks().feeds() : [];
    const order = preferred(person);
    let found = null;
    (person.accounts || []).forEach((account) => {
      if (found) return;
      list.forEach((feed) => {
        if (!found && sameAccount(feed, account)) found = feed;
      });
    });
    if (found) return found;
    const account = order || {};
    return {
      id: account.feedId || ((account.platform || "x") + ":" + (account.handle || person.id)),
      platform: account.platform || "x",
      handle: account.handle || person.id,
      channelId: account.channelId || "",
      name: person.name,
      configured: false
    };
  }

  function decorate(feed, person) {
    const base = baseFeed(person);
    const copy = Object.assign({}, base, {
      name: person.name || base.name,
      avatar: person.avatar || base.avatar,
      banner: person.banner || base.banner,
      bio: person.bio || base.bio,
      aliases: (person.accounts || []).map((account) => account.handle || "").join(" "),
      personId: person.id,
      memberIds: catalogIds(person)
    });
    if (!copy.memberIds.length && feed && feed.id) copy.memberIds = [feed.id];
    return copy;
  }

  function collapse(list) {
    const seen = new Set();
    const out = [];
    (list || []).forEach((feed) => {
      const person = matchFeed(feed);
      if (!person) { out.push(feed); return; }
      if (seen.has(person.id)) return;
      seen.add(person.id);
      out.push(decorate(feed, person));
    });
    return out;
  }

  function suggestions(list, followed) {
    const isOn = typeof followed === "function" ? followed : () => false;
    const seen = new Set();
    const out = [];
    (list || []).forEach((feed) => {
      if (!feed || !feed.id) return;
      const person = matchFeed(feed);
      if (person) {
        if (seen.has(person.id)) return;
        seen.add(person.id);
        const ids = catalogIds(person);
        if (ids.some(isOn) || isOn(feed.id)) return;
        out.push(decorate(feed, person));
        return;
      }
      if (isOn(feed.id)) return;
      out.push(feed);
    });
    out.sort((a, b) => (b.configured ? 1 : 0) - (a.configured ? 1 : 0) || String(a.name || "").localeCompare(String(b.name || "")));
    return out;
  }

  function countHtml(person) {
    const format = hooks().formatCount || ((n) => String(n));
    const hrefFor = hooks().connectHref || (() => "");
    const extraOf = hooks().extraFollowers || (() => 0);
    const ensure = hooks().ensureCounts || (() => {});
    const link = (html, tab) => {
      const href = hrefFor(person, tab);
      return href ? `<a href="${esc(href)}">${html}</a>` : html;
    };
    const followerRows = [];
    let following = null;
    (person.accounts || []).forEach((account) => {
      const id = account.feedId || ((account.platform || "x") + ":" + (account.handle || ""));
      if (id) ensure(id);
      const extra = Number(extraOf(id)) || 0;
      if (account.followers != null || extra) followerRows.push({ platform: account.platform, value: (Number(account.followers) || 0) + extra });
      if (account.following != null && following == null) following = account.following;
    });
    const bits = followerRows.map((row) => {
      const label = followerRows.length > 1
        ? (row.platform === "youtube" ? tr("YouTube subscribers") : tr("{platform} followers", { platform: NET[row.platform] || row.platform || "" }))
        : (row.platform === "youtube" ? tr("Subscribers") : tr("Followers"));
      return link(`<b>${esc(format(row.value))}</b> <span>${esc(label)}</span>`, "followers");
    });
    if (following != null) bits.push(link(`<b>${esc(format(following))}</b> <span>${tr("Following count")}</span>`, "following"));
    return bits.length ? `<div class="counts">${bits.join("")}</div>` : "";
  }

  function platformsOf(person) {
    const out = [];
    (person.accounts || []).forEach((account) => {
      const p = account.platform || "x";
      if (out.indexOf(p) < 0) out.push(p);
    });
    return out;
  }

  function accountFeedId(account) {
    const list = hooks().feeds ? hooks().feeds() : [];
    const feed = list.find((item) => item && sameAccount(item, account));
    return (feed && feed.id) || account.feedId || "";
  }

  function chipHtml(person) {
    const h = hooks();
    const glyph = h.platformGlyph || h.sourceBadge || (() => "");
    const followed = h.isFollowed || (() => false);
    const off = offSet();
    const many = (person.accounts || []).length > 1;
    const chips = (person.accounts || []).map((account) => {
      const href = external(account);
      const net = NET[account.platform] || account.platform || "";
      const handle = account.handle ? "@" + account.handle : net;
      const fid = accountFeedId(account);
      let toggle = "";
      if (many && fid) {
        const on = followed(fid) && !off.has(folded(fid));
        const label = tr("Follow on {platform}", { platform: net });
        toggle = `<button class="pchip-follow${on ? " on" : ""}" type="button" data-act="pm-plat" data-person="${esc(person.id)}" data-feed="${esc(fid)}" aria-pressed="${on ? "true" : "false"}" aria-label="${esc(label)}" title="${esc(label)}">${on ? esc(tr("state.Following")) : esc(tr("Follow"))}</button>`;
      }
      return `<span class="pchip-wrap"><a class="pchip" data-act="stop" target="_blank" rel="noopener noreferrer" href="${esc(href)}" title="${esc(net)}">${glyph(account.platform)}<span class="pchip-net">${esc(net)}</span><span>${esc(handle)}</span></a>${toggle}</span>`;
    }).join("");
    const unmerge = many ? `<button class="pchip-split" type="button" data-act="pm-split" data-person="${esc(person.id)}">${esc(tr("Not the same person? Unmerge"))}</button>` : "";
    return `<div class="pchips">${chips}</div>${unmerge}`;
  }

  function mediaGrid(rows) {
    const statusHash = hooks().statusHash;
    const watchHash = hooks().watchHash;
    const cells = rows.map((post) => {
      const media = (post.media || []).find((item) => item && (item.poster || item.type === "photo" || item.type === "video" || item.type === "animated_gif"));
      if (!media) return "";
      const src = media.poster || (media.type === "photo" ? media.url : "");
      if (!src) return "";
      const dest = post.watch && watchHash ? watchHash(post) : (statusHash ? statusHash(post) : "#/");
      return `<a class="pmedia-cell" href="${esc(dest)}"><img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>`;
    }).filter(Boolean);
    return cells.length ? `<div class="pmedia">${cells.join("")}</div>` : "";
  }

  function emptyCopy(tab) {
    if (tab === "replies") return [tr("No replies yet"), tr("Replies from these accounts will show up here.")];
    if (tab === "media") return [tr("No media yet"), tr("Photos and videos from these accounts will show up here.")];
    if (tab === "videos") return [tr("No videos yet"), tr("YouTube videos and videos from X will show up here.")];
    if (tab === "shorts") return [tr("No Shorts yet"), tr("Short videos from these accounts will show up here.")];
    if (tab === "community") return [tr("No community posts yet"), tr("Community posts from this channel will show up here.")];
    return [tr("No posts yet"), tr("Posts from these accounts will show up here.")];
  }

  function page(route) {
    const person = route && route.name === "person" ? byId(route.id) : match(route && route.platform, route && route.handle);
    if (!person) return null;
    const h = hooks();
    const all = postsFor(person, h.posts ? h.posts() : []);
    all.forEach((post) => { if (h.ensureYtMeta && post.platform === "youtube") h.ensureYtMeta(post); });
    const tabs = tabsFor(person, all);
    const requested = route.query && route.query.get ? (route.query.get("tab") || "") : "";
    const tab = tabs.some((pair) => pair[0] === requested) ? requested : "posts";
    const from = route.query && route.query.get ? (route.query.get("from") || "") : "";
    const platformsHere = platformsOf(person);
    const source = platformsHere.indexOf(from) >= 0 ? from : "";
    const list = filterTab(source ? all.filter((post) => (post.platform || "x") === source || (post.crossPosts || []).some((ref) => ref && ref.platform === source)) : all, tab);
    const posted = all.filter((post) => countsAsOwn(post, person)).length;
    const shown = h.formatCount ? h.formatCount(posted) : String(posted);
    const count = tr("{count} posts", { count: shown }).replace("{count}", shown);
    const bannerFace = root.ViktorychFaces && root.ViktorychFaces.banner ? root.ViktorychFaces.banner(person.banner, person.bannerFace) : (person.banner ? "photo" : "default");
    const banner = bannerFace === "photo" && person.banner ? `<img class="pbanner" src="${esc(person.banner)}" alt="">` : "";
    const base = baseFeed(person);
    const follow = h.followButtonClean ? h.followButtonClean(base.id, true) : "";
    const who = preferred(person) || base;
    const bell = h.bellButton ? h.bellButton(base.id, who.handle || base.handle || "") : "";
    const shareId = base.id || ("person:" + person.id);
    const hrefFor = (id, src) => {
      const q = [];
      if (id !== "posts") q.push("tab=" + id);
      const pick = src === undefined ? source : src;
      if (pick) q.push("from=" + encodeURIComponent(pick));
      return "#/p/" + encodeURIComponent(person.id) + (q.length ? "?" + q.join("&") : "");
    };
    const fromHtml = platformsHere.length > 1 ? `<div class="pfrom" role="group" aria-label="${esc(tr("Posts from"))}"><span class="pfrom-label">${esc(tr("Posts from"))}</span>${[""].concat(platformsHere).map((p) => `<a class="pfrom-pill${p === source ? " on" : ""}" href="${esc(hrefFor(tab, p))}" aria-current="${p === source ? "true" : "false"}">${p ? (h.platformGlyph ? h.platformGlyph(p) : "") + `<span>${esc(NET[p] || p)}</span>` : `<span>${esc(tr("All"))}</span>`}</a>`).join("")}</div>` : "";
    const tabHtml = tabs.map((pair) => `<a class="tab${tab === pair[0] ? " on" : ""}" role="tab" aria-selected="${tab === pair[0] ? "true" : "false"}" href="${esc(hrefFor(pair[0]))}"><span>${esc(pair[1])}</span></a>`).join("");
    let avatar = h.avatar ? h.avatar(person.avatar, person.name, "pava") : "";
    if (root.Spaces && root.Spaces.avatar) {
      (person.accounts || []).forEach((account) => {
        avatar = root.Spaces.avatar(avatar, account && account.platform, account && account.handle);
      });
    }
    const bio = h.bioBlock ? h.bioBlock({
      id: "person:" + person.id,
      platform: (preferred(person) || {}).platform || "x",
      handle: (preferred(person) || {}).handle || "",
      bio: person.bio || "",
      kind: "bio"
    }) : (person.bio ? `<div class="bio">${esc(person.bio)}</div>` : "");
    const icon = h.icon || (() => "");
    let body = "";
    if (tab === "media") body = mediaGrid(list);
    else if (list.length && h.card) body = list.map((post) => h.card(post, reposterMatch(post, person) ? "" : "author")).join("");
    if (!body) {
      const copy = emptyCopy(tab);
      body = h.emptyBlock ? h.emptyBlock(copy[0], copy[1]) : "";
    }
    const tail = h.archiveSentinel ? h.archiveSentinel() : "";
    let liveCard = "";
    if (root.Spaces && root.Spaces.profileCard) {
      (person.accounts || []).some((account) => {
        liveCard = root.Spaces.profileCard(account && account.platform, account && account.handle) || "";
        return !!liveCard;
      });
    }
    const nk = root.ViktorychNick;
    const shownName = nk && who && who.handle ? nk.name(who.platform || "x", who.handle, person.name || person.id || "") : (person.name || person.id || "");
    const top = root.ViktorychProfile && root.ViktorychProfile.top ? root.ViktorychProfile.top({
      name: shownName,
      original: person.name || person.id || "",
      personId: person.id,
      platform: (who && who.platform) || "x",
      handle: (who && who.handle) || "",
      feedId: base.id || "",
      url: (who && who.url) || "",
      own: false,
      count: count
    }, banner) : `<div class="pt-count">${esc(count)}</div>${banner}`;
    return `${top}
    <div class="pinfo" data-person="${esc(person.id)}">
      <div class="pava-row">
        ${avatar}
        <div class="pactions">
          <button class="icon-btn" type="button" data-act="share" data-kind="profile" data-id="${esc(shareId)}" aria-label="${tr("Share")}">${icon("share")}</button>
          ${bell}
          ${follow}
        </div>
      </div>
      <h1 class="pname">${esc(shownName)}${nk && nk.button && who && who.handle ? nk.button(who.platform || "x", who.handle, person.name || person.id || "", person.id) : ""}</h1>
      ${chipHtml(person)}
      ${bio}
      ${countHtml(person)}
      ${suggestHtml(person)}
    </div>
    ${liveCard}
    <div class="tabs ptabs" role="tablist" aria-label="${tr("Profile")}">${tabHtml}</div>
    ${fromHtml}
    ${body}${tail}`;
  }

  /* ---- Cheap same-person checks on data already loaded (no requests). ---- */
  function normName(name) { return String(name || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); }
  function tokensOf(feed) {
    const h = lower(feed && feed.handle);
    const p = (feed && feed.platform) || "x";
    if (!h) return [];
    if (p === "x") return ["x.com/" + h, "twitter.com/" + h];
    if (p === "instagram") return ["instagram.com/" + h];
    if (p === "threads") return ["threads.com/@" + h, "threads.net/@" + h];
    if (p === "youtube") return ["youtube.com/@" + h].concat(feed.channelId ? ["youtube.com/channel/" + String(feed.channelId).toLowerCase()] : []);
    if (p === "tiktok") return ["tiktok.com/@" + h];
    if (p === "vk") return ["vk.com/" + h];
    if (p === "telegram") return ["t.me/" + h];
    if (p === "bsky" || p === "bluesky") return ["bsky.app/profile/" + h];
    return [];
  }
  function blobOf(feed) { return [feed && feed.bio, feed && feed.website, feed && feed.description].join(" ").toLowerCase(); }
  function pointsAt(a, b) {
    const blob = blobOf(a);
    if (!blob.trim()) return false;
    return tokensOf(b).some((token) => {
      const at = blob.indexOf(token);
      if (at < 0) return false;
      const next = blob.charAt(at + token.length);
      return !/[a-z0-9_]/.test(next);
    });
  }
  function avatarKey(url) { return String(url || "").replace(/_(normal|bigger|mini|400x400)\./, ".").split("?")[0]; }
  /* "strong" merges straight away (with Undo), "weak" asks first, "" is no match. */
  function evidence(a, b) {
    if (!a || !b) return "";
    const pa = a.platform || "x";
    const pb = b.platform || "x";
    if (pa === pb) return "";
    const ha = lower(a.handle);
    const hb = lower(b.handle);
    if (((pa === "threads" && pb === "instagram") || (pa === "instagram" && pb === "threads")) && ha && ha === hb) return "strong";
    const there = pointsAt(a, b);
    const back = pointsAt(b, a);
    const na = normName(a.name);
    const name = na.length >= 3 && na === normName(b.name);
    const face = !!a.avatar && avatarKey(a.avatar) === avatarKey(b.avatar);
    if (there && back) return "strong";
    if ((there || back) && (name || face)) return "strong";
    if (there || back) return "weak";
    if (ha && ha === hb && ha.length >= 4 && (name || face)) return "weak";
    if (name && face) return "weak";
    if (name && ha && hb && (ha.indexOf(hb) >= 0 || hb.indexOf(ha) >= 0)) return "maybe";
    if (name) return "maybe";
    return "";
  }

  /* dHash of an avatar thumbnail the page already shows. A "maybe" (same name
     only) becomes a one-tap suggestion when the two faces are close. Images
     from hosts without CORS cannot be read and simply stay unmatched. */
  const HASHES = {};
  function dhash(url) {
    const key = String(url || "");
    if (!key || typeof Image === "undefined" || typeof document === "undefined") return Promise.resolve("");
    if (HASHES[key]) return HASHES[key];
    HASHES[key] = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      const done = (value) => resolve(value || "");
      const timer = setTimeout(() => done(""), 4000);
      img.onerror = () => { clearTimeout(timer); done(""); };
      img.onload = () => {
        clearTimeout(timer);
        try {
          const c = document.createElement("canvas");
          c.width = 9; c.height = 8;
          const g = c.getContext("2d");
          g.drawImage(img, 0, 0, 9, 8);
          const d = g.getImageData(0, 0, 9, 8).data;
          let bits = "";
          for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
              const i = (y * 9 + x) * 4;
              const j = i + 4;
              const l = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
              const r = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
              bits += l > r ? "1" : "0";
            }
          }
          done(bits);
        } catch (err) { done(""); }
      };
      img.src = key;
    });
    return HASHES[key];
  }
  function closeFaces(a, b) {
    return Promise.all([dhash(a), dhash(b)]).then((pair) => {
      if (!pair[0] || !pair[1]) return false;
      let diff = 0;
      for (let i = 0; i < 64; i++) if (pair[0][i] !== pair[1][i]) diff++;
      return diff <= 10;
    });
  }

  function feedRow(feed) {
    return { platform: feed.platform || "x", handle: feed.handle || "", feedId: feed.id || "", name: feed.name || "", avatar: feed.avatar || "", channelId: feed.channelId || "" };
  }
  function feedById(id) {
    const list = hooks().feeds ? hooks().feeds() : [];
    return list.find((feed) => feed && folded(feed.id) === folded(id)) || null;
  }
  function personRows(person) {
    return (person.accounts || []).map((account) => {
      const feed = (hooks().feeds ? hooks().feeds() : []).find((item) => item && sameAccount(item, account));
      return feed ? feedRow(feed) : { platform: account.platform || "x", handle: account.handle || "", feedId: account.feedId || "", name: account.name || person.name || "", avatar: account.avatar || "", channelId: account.channelId || "" };
    });
  }
  function joinKey(a, b) { return [folded(a), folded(b)].sort().join("~"); }
  function dismissed(a, b) { return links().dismiss.indexOf(joinKey(a, b)) >= 0; }

  function mergeInto(feed, target) {
    const prefs = links();
    const targetPerson = target.person || null;
    const rows = targetPerson ? personRows(targetPerson) : [feedRow(target.feed)];
    rows.push(feedRow(feed));
    const id = targetPerson ? targetPerson.id : "u-" + folded(target.feed.id).replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    const name = targetPerson ? (targetPerson.name || "") : (target.feed.name || feed.name || "");
    prefs.join = prefs.join.filter((row) => row.id !== id).concat([{ id: id, name: name, avatar: (targetPerson && targetPerson.avatar) || target.feed && target.feed.avatar || "", rows: rows }]);
    prefs.split = prefs.split.filter((fid) => rows.every((row) => folded(row.feedId) !== folded(fid)));
    saveLinks(prefs);
    return id;
  }
  function undoMerge(id, feedId) {
    const prefs = links();
    const row = prefs.join.find((item) => item.id === id);
    if (row) {
      row.rows = row.rows.filter((a) => folded(a.feedId) !== folded(feedId));
      if (row.rows.length < 2) prefs.join = prefs.join.filter((item) => item.id !== id);
    }
    saveLinks(prefs);
  }

  function nameList(platforms) {
    return platforms.map((p) => NET[p] || p).join(", ");
  }

  /* After a reader adds one source: offer the person's other accounts, or
     merge it with a person or followed source that is clearly the same. */
  function afterFollow(ids) {
    const h = hooks();
    if (!ids || ids.length !== 1 || !h.toastAction) return;
    const id = ids[0];
    const feed = feedById(id);
    if (!feed) return;
    const followed = h.isFollowed || (() => false);
    const person = matchFeed(feed);
    if (person) {
      const off = offSet();
      const rest = catalogIds(person).filter((fid) => folded(fid) !== folded(id) && !followed(fid) && !off.has(folded(fid)));
      if (!rest.length) return;
      const platforms = [];
      rest.forEach((fid) => { const f = feedById(fid); const p = (f && f.platform) || fid.split(":")[0]; if (platforms.indexOf(p) < 0) platforms.push(p); });
      h.toastAction(tr("Also on {platforms}. Add them?", { platforms: nameList(platforms) }), tr("Add"), () => { if (h.follow) h.follow(rest, true); });
      return;
    }
    const list = h.feeds ? h.feeds() : [];
    let best = null;
    const consider = (level, target) => {
      const rank = { strong: 3, weak: 2, maybe: 1 };
      if (!level || (best && rank[best.level] >= rank[level])) return;
      best = { level: level, target: target };
    };
    people.forEach((p) => {
      if ((p.accounts || []).some((a) => (a.platform || "x") === (feed.platform || "x"))) return;
      personRows(p).forEach((row) => {
        if (dismissed(id, row.feedId)) return;
        const other = feedById(row.feedId) || row;
        consider(evidence(feed, other), { person: p, feed: other });
      });
    });
    list.forEach((other) => {
      if (!other || !other.id || folded(other.id) === folded(id) || matchFeed(other) || !followed(other.id) || dismissed(id, other.id)) return;
      consider(evidence(feed, other), { person: null, feed: other });
    });
    suggestRows.forEach((row) => {
      const accts = row && row.accounts || [];
      if (!accts.some((a) => folded(a.id) === folded(id))) return;
      accts.forEach((a) => {
        if (folded(a.id) === folded(id) || dismissed(id, a.id)) return;
        const other = feedById(a.id);
        if (other) consider("weak", { person: matchFeed(other), feed: other });
      });
    });
    if (!best) return;
    const label = (best.target.person && best.target.person.name) || best.target.feed.name || ("@" + (best.target.feed.handle || ""));
    const ask = () => h.toastAction(tr("Same person as {name}?", { name: label }), tr("Merge"), () => {
      mergeInto(feed, best.target);
      if (h.render) h.render();
    }, () => {
      const prefs = links();
      prefs.dismiss.push(joinKey(id, best.target.feed.id || best.target.feed.feedId));
      saveLinks(prefs);
    });
    if (best.level === "strong") {
      const pid = mergeInto(feed, best.target);
      h.toastAction(tr("Merged into {name}’s profile", { name: label }), tr("Undo"), () => { undoMerge(pid, id); if (h.render) h.render(); });
      if (h.render) h.render();
      return;
    }
    if (best.level === "weak") { ask(); return; }
    closeFaces(feed.avatar, best.target.feed.avatar).then((close) => { if (close) ask(); });
  }

  function suggestHtml(person) {
    const rows = [];
    const mine = catalogIds(person).map(folded);
    suggestRows.forEach((row) => {
      const accts = (row && row.accounts) || [];
      if (!accts.some((a) => mine.indexOf(folded(a.id)) >= 0)) return;
      accts.forEach((a) => {
        if (mine.indexOf(folded(a.id)) >= 0) return;
        const other = feedById(a.id);
        if (!other || matchFeed(other) || mine.some((fid) => dismissed(fid, a.id))) return;
        rows.push(other);
      });
    });
    if (!rows.length) return "";
    const other = rows[0];
    const net = NET[other.platform] || other.platform || "";
    return `<div class="pm-suggest" role="group"><span>${esc(tr("Same person as {name}?", { name: (other.name || ("@" + other.handle)) + " · " + net }))}</span><button class="pm-btn primary" type="button" data-act="pm-join" data-person="${esc(person.id)}" data-feed="${esc(other.id)}">${esc(tr("Merge"))}</button><button class="pm-btn" type="button" data-act="pm-dismiss" data-person="${esc(person.id)}" data-feed="${esc(other.id)}">${esc(tr("Not now"))}</button></div>`;
  }

  function act(name, el) {
    const h = hooks();
    const pid = el && el.dataset ? el.dataset.person : "";
    const fid = el && el.dataset ? el.dataset.feed : "";
    const person = byId(pid);
    if (name === "pm-plat" && fid) {
      const prefs = links();
      const followed = h.isFollowed ? h.isFollowed(fid) : false;
      const isOff = prefs.off.some((item) => folded(item) === folded(fid));
      if (followed && !isOff) {
        prefs.off.push(fid);
        saveLinks(prefs);
        if (h.follow) h.follow([fid], false);
      } else {
        prefs.off = prefs.off.filter((item) => folded(item) !== folded(fid));
        saveLinks(prefs);
        if (h.follow) h.follow([fid], true);
      }
      if (h.render) h.render();
      return true;
    }
    if (name === "pm-split" && person) {
      const prefs = links();
      const ids = catalogIds(person).concat((person.accounts || []).map((a) => a.feedId).filter(Boolean));
      ids.forEach((item) => { if (prefs.split.indexOf(item) < 0) prefs.split.push(item); });
      prefs.join = prefs.join.filter((row) => row.id !== person.id);
      saveLinks(prefs);
      if (h.toastAction) {
        h.toastAction(tr("Unmerged. Each account has its own profile again."), tr("Undo"), () => {
          const back = links();
          back.split = back.split.filter((item) => ids.indexOf(item) < 0);
          saveLinks(back);
          if (h.render) h.render();
        });
      }
      if (h.go) h.go("#/");
      else if (h.render) h.render();
      return true;
    }
    if (name === "pm-join" && person && fid) {
      const feed = feedById(fid);
      if (feed) mergeInto(feed, { person: person, feed: baseFeed(person) });
      if (h.render) h.render();
      return true;
    }
    if (name === "pm-dismiss" && person && fid) {
      const prefs = links();
      catalogIds(person).forEach((mine) => prefs.dismiss.push(joinKey(mine, fid)));
      saveLinks(prefs);
      if (h.render) h.render();
      return true;
    }
    return false;
  }

  /* Following a merged person: pick the platforms first. Everything starts
     checked, or as the reader chose last time. Off platforms are never read. */
  function pick(ids, el) {
    const h = hooks();
    if (typeof document === "undefined" || !ids || ids.length < 2) return false;
    const person = personOf(ids[0]);
    if (!person || !h.follow) return false;
    const all = catalogIds(person);
    if (all.length < 2) return false;
    const prefs = links();
    const glyph = h.platformGlyph || (() => "");
    const old = document.querySelector(".pm-sheet");
    if (old) old.remove();
    const wrap = document.createElement("div");
    wrap.className = "pm-sheet";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    const title = tr("Follow {name} on", { name: person.name || "" });
    wrap.setAttribute("aria-label", title);
    const rows = all.map((fid) => {
      const feed = feedById(fid) || {};
      const p = feed.platform || fid.split(":")[0];
      const on = prefs.pick[p] !== false;
      return `<label class="pm-row"><input type="checkbox" data-feed="${esc(fid)}" data-platform="${esc(p)}"${on ? " checked" : ""}>${glyph(p)}<span class="pm-net">${esc(NET[p] || p)}</span><span class="pm-handle">${feed.handle ? "@" + esc(feed.handle) : ""}</span></label>`;
    }).join("");
    wrap.innerHTML = `<div class="pm-card"><h2 class="pm-title">${esc(title)}</h2>${rows}<div class="pm-acts"><button class="pm-btn" type="button" data-pm="cancel">${esc(tr("Cancel"))}</button><button class="follow pm-go" type="button" data-pm="go">${esc(tr("Follow"))}</button></div></div>`;
    const close = () => { wrap.remove(); try { if (el && el.focus) el.focus(); } catch (err) { /* gone */ } };
    wrap.addEventListener("click", (event) => {
      const btn = event.target.closest ? event.target.closest("[data-pm]") : null;
      if (event.target === wrap || (btn && btn.dataset.pm === "cancel")) { close(); return; }
      if (!btn || btn.dataset.pm !== "go") return;
      const next = links();
      const yes = [];
      wrap.querySelectorAll("input[data-feed]").forEach((box) => {
        const fid = box.dataset.feed;
        next.pick[box.dataset.platform] = !!box.checked;
        next.off = next.off.filter((item) => folded(item) !== folded(fid));
        if (box.checked) yes.push(fid);
        else next.off.push(fid);
      });
      saveLinks(next);
      close();
      if (yes.length) h.follow(yes, true);
      else if (h.render) h.render();
    });
    wrap.addEventListener("keydown", (event) => {
      if (event.key === "Escape" || event.key === "GoBack" || event.key === "BrowserBack") { event.preventDefault(); close(); }
    });
    document.body.appendChild(wrap);
    const first = wrap.querySelector("input");
    if (first) first.focus();
    return true;
  }

  function start() {
    const load = root.fetch ? root.fetch("people.json", { cache: "no-cache" }) : Promise.reject();
    const hints = root.fetch ? root.fetch("suggestions.json", { cache: "no-cache" }) : Promise.reject();
    Promise.resolve(hints).then((res) => (res && res.ok ? res.json() : null)).then((doc) => {
      suggestRows = (doc && Array.isArray(doc.suggestions)) ? doc.suggestions.slice(0, 400) : [];
    }).catch(() => {});
    return Promise.resolve(load).then((res) => (res && res.ok ? res.json() : null)).then((doc) => {
      if (!doc) return;
      ingest(doc);
      if (hooks().render) hooks().render();
    }).catch(() => {});
  }

  function bind(next) { bound = next || null; }

  function use(doc) { ingest(doc || { people: [] }); }

  root.FeedsPeople = {
    bind: bind,
    start: start,
    use: use,
    match: match,
    byId: byId,
    hashFor: hashFor,
    titleFor: titleFor,
    page: page,
    collapse: collapse,
    suggestions: suggestions,
    followIds: followIds,
    allIds: allIds,
    hidden: hidden,
    badges: badges,
    act: act,
    pick: pick,
    afterFollow: afterFollow,
    refresh: rebuild,
    cleanLinks: cleanLinks,
    evidence: evidence,
    postsFor: postsFor,
    tabsFor: tabsFor,
    filterTab: filterTab
  };
})(typeof window !== "undefined" ? window : globalThis);
