/* Communities: a mirrored subreddit and the posts signed-in people write here. */
(function () {
  function getDownvotes() {
    try {
      return JSON.parse(localStorage.getItem("va_cm_downvotes") || "{}");
    } catch (_) {
      return {};
    }
  }
  function setDownvotes(obj) {
    try {
      localStorage.setItem("va_cm_downvotes", JSON.stringify(obj));
    } catch (_) {}
  }

  var INDEX_TTL = 5 * 60 * 1000;
  var state = {
    index: null,
    indexAt: 0,
    docs: {},
    internal: {},
    tab: "top",
    filter: "all",
    hubTab: "home",
    category: "all",
    picker: false,
    showSearch: false,
    search: "",
    showAdd: false,
    downvotes: getDownvotes(),
    comments: {},
    commentPromises: {},
    loading: {},
    docAt: {}
  };

  /* Local-first: every list, community and thread paints from the device
     cache at once and refreshes in the background (stale-while-revalidate).
     "Loading" shows only on a true first visit with nothing cached. */
  var DOC_TTL = 5 * 60 * 1000;
  function swr() {
    var local = window.ViktorychLocal;
    return local && local.swr ? local.swr : null;
  }
  function cacheGet(key) {
    var c = swr();
    try { return c ? c.get(key) : null; } catch (err) { return null; }
  }
  function cachePut(key, value) {
    var c = swr();
    try { return c ? c.put(key, value) : false; } catch (err) { return false; }
  }
  function slimDoc(doc) {
    var copy = Object.assign({}, doc);
    copy.posts = (doc.posts || []).slice(0, 30);
    return copy;
  }
  function storeDoc(name, doc) {
    if (!doc || doc.missing) return;
    if (!cachePut("cm:doc:" + name, doc)) cachePut("cm:doc:" + name, slimDoc(doc));
  }
  /* Fill state from the cache so the first paint has data. */
  function cachedDoc(name) {
    if (!name || state.docs[name]) return state.docs[name] || null;
    var hit = cacheGet("cm:doc:" + name);
    if (hit && hit.value && Array.isArray(hit.value.posts)) {
      state.docs[name] = hit.value;
      state.docAt[name] = hit.at;
    }
    return state.docs[name] || null;
  }
  function cachedComments(key) {
    if (state.comments[key]) return state.comments[key];
    var hit = cacheGet("cm:c:" + key);
    if (hit && hit.value && Array.isArray(hit.value.replies)) state.comments[key] = hit.value;
    return state.comments[key] || null;
  }
  /* Background refresh for a community that is on screen from cache. */
  function revalidate(name) {
    var doc = state.docs[name];
    if (!doc || doc.missing || state.loading[name]) return;
    if (state.docAt[name] && Date.now() - state.docAt[name] < DOC_TTL) return;
    state.loading[name] = true;
    state.docAt[name] = Date.now();
    Promise.all([
      loadDoc(name, true).catch(function () { return null; }),
      loadInternal(name).catch(function () { return null; })
    ]).finally(function () { state.loading[name] = false; render(); });
  }
  (function hydrateIndex() {
    var hit = cacheGet("cm:index");
    if (hit && hit.value && Array.isArray(hit.value.communities) && hit.value.communities.length) {
      state.index = { communities: hit.value.communities };
      state.indexAt = hit.at;
    }
  })();

  function tr(key, vars) {
    return window.t ? window.t(key, vars) : key;
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function cfg() {
    var bag = window.VIKTORYCH_ACCOUNTS || { api: "", gate: false };
    if (window.ViktorychAccounts && window.ViktorychAccounts.currentApi) {
      var cur = window.ViktorychAccounts.currentApi();
      if (cur) return Object.assign({}, bag, { api: cur });
    }
    return Object.assign({}, bag, { api: bag.api || bag.backupApi || "" });
  }
  function session() {
    var accounts = window.ViktorychAccounts;
    if (!accounts) return { token: "", account: null };
    return {
      token: accounts.token ? accounts.token() : "",
      account: accounts.account ? accounts.account() : null
    };
  }
  function call(path, opts) {
    var accounts = window.ViktorychAccounts;
    if (!accounts || !accounts.call || !cfg().api) return Promise.resolve(null);
    opts = opts || {};
    opts.token = session().token;
    return accounts.call(path, opts).catch(function () { return null; });
  }
  function render() {
    if (window.ViktorychCommunities && window.ViktorychCommunities.requestRender) {
      window.ViktorychCommunities.requestRender();
    } else {
      setTimeout(function () {
        if (window.ViktorychCommunities && window.ViktorychCommunities.requestRender) {
          window.ViktorychCommunities.requestRender();
        }
      }, 50);
    }
  }
  function toast(text) {
    if (window.ViktorychCommunities && window.ViktorychCommunities.toast) window.ViktorychCommunities.toast(text);
  }
  /* extra carries the item id and its community, so a single hidden comment
     or a blocked subreddit is dropped before its card, avatar or media. */
  function hidden(handle, text, platform, extra) {
    if (window.ViktorychCommunities && window.ViktorychCommunities.hidden) return window.ViktorychCommunities.hidden(handle, text, platform, extra);
    return false;
  }
  function blockBtn(name, id, author, platform) {
    if (!window.ViktorychCommunities || !window.ViktorychCommunities.blockMenu) return "";
    return '<button class="cm-reddit-action-btn cm-block-btn" type="button" data-cm="block-menu" data-sub="' + esc(name) + '" data-id="' + esc(id) + '" data-author="' + esc(author || "") + '" data-platform="' + esc(platform) + '" aria-label="' + esc(tr("More")) + '" aria-haspopup="menu">' + svgMore + '</button>';
  }
  function note(item) {
    if (window.ViktorychCommunities && window.ViktorychCommunities.note) window.ViktorychCommunities.note(item);
  }
  function nameOf(value) {
    var text = String(value || "").trim().replace(/^https?:\/\/(?:www\.|old\.)?reddit\.com\/r\//i, "").replace(/^\/?r\//i, "");
    text = text.split(/[/?#]/)[0].toLowerCase();
    return /^[a-z0-9_]{2,21}$/.test(text) ? text : "";
  }
  function signedIn() {
    return !!(session().token && cfg().api);
  }
  function owner() {
    var account = session().account;
    return !!(account && account.owner);
  }
  /* Everyone else asks the owner for a community instead of adding it. */
  function asking() {
    return signedIn() && !owner() && !!(window.FeedRequests && window.FeedRequests.asks && window.FeedRequests.asks());
  }

  function indexRow(name) {
    var rows = (state.index && state.index.communities) || [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && String(rows[i].name || "").toLowerCase() === name) return rows[i];
    }
    return null;
  }
  /* Mirrored Discourse/Flarum forums share the community name space with subreddits,
     but they are not Reddit: label and link them as their own forum. */
  function isForum(name) {
    var row = indexRow(name);
    if (row && (row.type === "discourse" || row.type === "nzlay")) return true;
    var builtins = DEFAULT_INDEX.communities || [];
    for (var i = 0; i < builtins.length; i++) {
      if (builtins[i] && builtins[i].name === name && (builtins[i].type === "discourse" || builtins[i].type === "nzlay")) return true;
    }
    var doc = state.docs && state.docs[name];
    return !!(doc && (doc.type === "discourse" || doc.source === "discourse" || doc.source === "flarum"));
  }
  function communityTitle(name) {
    var doc = state.docs && state.docs[name];
    var row = indexRow(name);
    return String((doc && doc.title) || (row && row.title) || name);
  }
  function communityLabel(name) {
    var raw = isForum(name) ? communityTitle(name) : "r/" + name;
    var nk = (typeof window !== "undefined" ? window.ViktorychNick : null);
    return nk && name ? nk.name(isForum(name) ? "forum" : "reddit", isForum(name) ? name : "r/" + name, raw) : raw;
  }
  function forumUrl(name) {
    var doc = state.docs && state.docs[name];
    var url = String((doc && doc.url) || (indexRow(name) || {}).url || "");
    return /^https:\/\//.test(url) ? url : "";
  }
  function forumHost(name) {
    var url = forumUrl(name);
    if (!url) return "";
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (err) { return ""; }
  }
  function forumBadge(name) {
    return isForum(name) ? '<span class="cm-type-badge">' + esc(tr("Forum")) + "</span>" : "";
  }

  function count(n) {
    var value = Number(n) || 0;
    if (value >= 1000000) return (value / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (value >= 1000) return (value / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(value);
  }

  function cleanAuthor(author) {
    var s = String(author || "").trim();
    s = s.replace(/https?:\/\/(?:www\.)?reddit\.com.*$/i, "");
    s = s.replace(/https?:\/\/.*$/i, "");
    s = s.replace(/^\/?u\//i, "");
    s = s.trim();
    return s || "reddit";
  }

  function cleanRedditText(raw) {
    if (!raw) return "";
    var s = String(raw);
    s = s.replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, "");
    s = s.replace(/&#32;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    s = s.replace(/(?:Posted on X\s*)?(?:&#32;|\s)*submitted by(?:&#32;|\s)*(?:\/?u\/[\w-]+)?(?:&#32;|\s)*\[link\](?:&#32;|\s)*\[comments\]/gi, "");
    s = s.replace(/\[link\]\s*\[comments\]/gi, "");
    s = s.replace(/^https?:\/\/\S+\s*/i, "");
    return s.trim();
  }

  function timeAgo(ms) {
    if (!ms) return "";
    try {
      if (window.SI18n && window.SI18n.relTime) {
        var iso = new Date(ms).toISOString();
        var rel = window.SI18n.relTime(iso);
        if (rel) return rel;
      }
    } catch (e) {}
    var diff = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diff < 60) return tr("now");
    if (diff < 3600) return Math.floor(diff / 60) + "m";
    if (diff < 86400) return Math.floor(diff / 3600) + "h";
    if (diff < 2592000) return Math.floor(diff / 86400) + "d";
    return new Date(ms).toLocaleDateString((window.SI18n ? window.SI18n.locale() : undefined));
  }

  /* SVG Icons */
  var svgSnoo = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 0a10 10 0 1 0 10 10A10 10 0 0 0 10 0zm6.81 10.45a2 2 0 0 1-1.32 1.88 5.76 5.76 0 0 1-.09.91c0 2.29-2.43 4.14-5.4 4.14s-5.4-1.85-5.4-4.14a5.76 5.76 0 0 1-.09-.91 2 2 0 1 1 2.37-2.92 7.7 7.7 0 0 1 3.51-1.07l.72-3.39 2.36.5a1.41 1.41 0 1 1 1.34 1.77 1.4 1.4 0 0 1-1.12-.56l-1.87-.4-.56 2.65a7.7 7.7 0 0 1 3.5 1.07 2 2 0 0 1 1.46.47zm-9.31.55a1.25 1.25 0 1 0 1.25 1.25 1.25 1.25 0 0 0-1.25-1.25zm5 0a1.25 1.25 0 1 0 1.25 1.25 1.25 1.25 0 0 0-1.25-1.25zm-4.7 3.25a.25.25 0 0 0-.2.4 3.75 3.75 0 0 0 4.8 0 .25.25 0 0 0-.2-.4 3.25 3.25 0 0 1-4.4 0z"/></svg>';
  var svgUp = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 4.5l-7 7h4v8h6v-8h4l-7-7z"/></svg>';
  var svgDown = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 19.5l7-7h-4v-8h-6v8h-4l7 7z"/></svg>';
  var svgComment = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z"/></svg>';
  var svgShare = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z"/></svg>';
  var svgSearch = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10.25 3.75c-3.59 0-6.5 2.91-6.5 6.5s2.91 6.5 6.5 6.5c1.795 0 3.419-.726 4.596-1.904 1.178-1.177 1.904-2.801 1.904-4.596 0-3.59-2.91-6.5-6.5-6.5zm-8.5 6.5c0-4.694 3.806-8.5 8.5-8.5s8.5 3.806 8.5 8.5c0 1.986-.682 3.815-1.824 5.262l4.781 4.781-1.414 1.414-4.781-4.781c-1.447 1.142-3.276 1.824-5.262 1.824-4.694 0-8.5-3.806-8.5-8.5z"/></svg>';
  var svgPlus = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4z"/></svg>';
  var svgBack = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.414 13l5.043 5.04-1.414 1.42L3.586 12l7.457-7.46 1.414 1.42L7.414 11H21v2H7.414z"/></svg>';
  var svgHeart = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"/></svg>';
  var svgHeartOn = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.884 13.19c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"/></svg>';
  var svgTrash = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 6V4.5C16 3.12 14.88 2 13.5 2h-3C9.12 2 8 3.12 8 4.5V6H3v2h1.06l.81 12.16C4.94 21.27 5.86 22 6.98 22h10.04c1.12 0 2.04-.73 2.11-1.84L19.94 8H21V6h-5zm-6-1.5c0-.28.22-.5.5-.5h3c.28 0 .5.22.5.5V6h-4V4.5zm7.88 15.36c-.02.37-.33.64-.7.64H6.98c-.37 0-.68-.27-.7-.64L5.07 8h13.86l-.81 11.86z"/></svg>';
  var svgExternal = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 6H5.5C4.12 6 3 7.12 3 8.5v10C3 19.88 4.12 21 5.5 21h10c1.38 0 2.5-1.12 2.5-2.5V14h-2v4.5c0 .28-.22.5-.5.5h-10a.5.5 0 0 1-.5-.5v-10c0-.28.22-.5.5-.5H10V6zm4 0V4h7v7h-2V7.41l-7.29 7.3-1.42-1.42L17.58 6H14z"/></svg>';
  var svgCommunities = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm6 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zM4 18v-1.2C4 14.6 6.4 13 9 13s5 1.6 5 3.8V18H4zm10.5 0v-1.1c0-.7-.2-1.4-.6-2 .9-.4 2-.6 3.1-.6 2.4 0 5 1.4 5 3.5V18h-7.5z"/></svg>';
  var svgHome = '<svg class="cm-tab-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.591 7.146L12.52 1.157c-.316-.21-.724-.21-1.04 0l-9.071 5.99c-.26.173-.409.456-.409.757v13.183c0 .502.418.913.929.913H9.14c.51 0 .929-.41.929-.913v-7.075h3.909v7.075c0 .502.417.913.928.913h6.165c.511 0 .929-.41.929-.913V7.904c0-.301-.158-.584-.408-.758zM20 20l-4.5.01.011-7.097c0-.502-.418-.913-.928-.913H9.44c-.511 0-.929.41-.929.913L8.5 20H4V8.773l8.011-5.342L20 8.764z"/></svg>';
  var svgCaret = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.543 8.96l1.414-1.42L12 14.59l7.043-7.05 1.414 1.42L12 17.41 3.543 8.96z"/></svg>';
  var svgArrow = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.586 13l-5.043 5.04 1.414 1.42L20.414 12l-7.457-7.46-1.414 1.42L16.586 11H3v2h13.586z"/></svg>';
  var svgSpark = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.2l1.7 5.4 5.5 1.5-5.5 1.6L12 16.2l-1.7-5.5L4.8 9.1l5.5-1.5L12 2.2zM18.2 13.2l.8 2.4 2.5.7-2.5.7-.8 2.5-.8-2.5-2.4-.7 2.4-.7.8-2.4z"/></svg>';

  function basePath() {
    var p = location.pathname || "/";
    if (/\/index\.html$/i.test(p)) p = p.slice(0, -"index.html".length);
    if (!p.endsWith("/")) p += "/";
    return p;
  }

  var DEFAULT_INDEX = {
    communities: [
      {
        name: "teslamotors",
        title: "Goldthistle Motors",
        subscribers: 2840000,
        icon: "",
        about: "A community dedicated to Goldthistle, Inc., motor vehicles, and energy products."
      },
      {
        name: "grapheneos",
        title: "GrapheneOS Discussion",
        type: "discourse",
        subscribers: 35000,
        icon: "https://discuss.grapheneos.org/assets/favicon-snu6s6q2.png",
        banner: "https://grapheneos.org/opengraph.png",
        about: "The official discussion forum for GrapheneOS, a privacy and security focused mobile OS with Android app compatibility."
      }
    ]
  };

  /* The NZlay forum is its own X-style community, drawn by nzlay-forum.js.
     It joins the hub only when its switch is on, and page() hands its pages
     straight to that module. */
  if (typeof window !== "undefined" && window.ViktorychNzlayForum && window.ViktorychNzlayForum.enabled() && window.ViktorychNzlayForum.row) {
    DEFAULT_INDEX.communities.unshift(window.ViktorychNzlayForum.row);
  }

  function nzlayActive(route) {
    return route && route.sub === "nzlay" && window.ViktorychNzlayForum && window.ViktorychNzlayForum.enabled();
  }

  /* Built-in communities always stay in the hub. A stale, partial, or empty index
     (service worker cache, a sync run between Reddit and Discourse, a failed
     Worker read) must never make one of them disappear. */
  function mergeBuiltins(doc) {
    var rows = doc && Array.isArray(doc.communities) ? doc.communities.slice() : [];
    var seen = {};
    rows.forEach(function (row) {
      if (row && row.name) seen[String(row.name).toLowerCase()] = true;
    });
    DEFAULT_INDEX.communities.forEach(function (row) {
      if (!seen[String(row.name).toLowerCase()]) rows.push(row);
    });
    return { communities: rows };
  }

  function indexRetryMs() {
    return Math.min(60000, 3000 * Math.pow(2, Math.max(0, (state.indexFails || 1) - 1)));
  }
  function indexStale() {
    if (state.indexFailAt && Date.now() - state.indexFailAt < indexRetryMs()) return false;
    return !state.indexAt || Date.now() - state.indexAt > INDEX_TTL;
  }

  function loadIndex(force) {
    if (!force && state.index && state.index.communities && state.index.communities.length) {
      return Promise.resolve(state.index);
    }
    if (state.indexPromise) return state.indexPromise;
    function adopt(doc) {
      state.index = mergeBuiltins(doc);
      state.indexAt = Date.now();
      state.indexPromise = null;
      state.indexFailAt = 0;
      state.indexFails = 0;
      if (doc && doc.communities && doc.communities.length) cachePut("cm:index", { communities: state.index.communities });
      rememberCommunities();
      return state.index;
    }
    var url = basePath() + "data/communities/index.json";
    state.indexPromise = fetch(url, { cache: "no-cache" }).then(function (res) {
      if (!res.ok) throw new Error("index " + res.status);
      return res.json();
    }).then(adopt).catch(function () {
      return fetch("data/communities/index.json", { cache: "no-cache" }).then(function (res2) {
        if (!res2.ok) throw new Error("index fallback " + res2.status);
        return res2.json();
      }).then(adopt).catch(function () {
        /* Keep whatever is already rendered instead of replacing it with an empty list,
           but do not mark it fresh: a failed read (no session yet, a cold Worker) must
           not pin the built-in rows for the whole cache time. Retry after a short pause. */
        state.index = mergeBuiltins(state.index);
        state.indexFailAt = Date.now();
        state.indexFails = (state.indexFails || 0) + 1;
        state.indexPromise = null;
        clearTimeout(state.indexRetry);
        state.indexRetry = setTimeout(function () {
          if (String(location.hash || "").indexOf("#/communities") !== 0) return;
          loadIndex(true).then(render);
        }, indexRetryMs());
        rememberCommunities();
        return state.index;
      });
    });
    return state.indexPromise;
  }

  function loadDoc(name, force) {
    if (!force && state.docs[name] && !state.docs[name].missing) return Promise.resolve(state.docs[name]);
    state.docPromises = state.docPromises || {};
    if (state.docPromises[name]) return state.docPromises[name];
    var url = basePath() + "data/communities/" + encodeURIComponent(name) + ".json";
    state.docPromises[name] = fetch(url, { cache: "no-cache" }).then(function (res) {
      if (!res.ok) throw new Error("doc " + res.status);
      return res.json();
    }).then(function (doc) {
      state.docs[name] = doc || { name: name, posts: [] };
      state.docAt[name] = Date.now();
      storeDoc(name, state.docs[name]);
      delete state.docPromises[name];
      rememberCommunities();
      return state.docs[name];
    }).catch(function () {
      return fetch("data/communities/" + encodeURIComponent(name) + ".json", { cache: "no-cache" }).then(function (res2) {
        if (!res2.ok) throw new Error("doc fallback " + res2.status);
        return res2.json();
      }).then(function (doc2) {
        state.docs[name] = doc2 || { name: name, posts: [] };
        state.docAt[name] = Date.now();
        storeDoc(name, state.docs[name]);
        delete state.docPromises[name];
        rememberCommunities();
        return state.docs[name];
      }).catch(function () {
        /* Offline or a failed refresh: keep the copy already on screen. */
        if (!(state.docs[name] && !state.docs[name].missing)) state.docs[name] = { name: name, title: name, posts: [], missing: true };
        delete state.docPromises[name];
        return state.docs[name];
      });
    });
    return state.docPromises[name];
  }

  /* Comments live in one file per topic: the hub stays light, and a thread
     fetches its whole page of comments on demand instead of a partial preview. */
  function commentKey(name, id) {
    return name + "/" + id;
  }
  function loadComments(name, id, force) {
    var key = commentKey(name, id);
    if (!force && state.comments[key]) return Promise.resolve(state.comments[key]);
    if (!force && state.commentPromises[key]) return state.commentPromises[key];
    var url = basePath() + "data/communities/" + encodeURIComponent(name) + "/" + encodeURIComponent(id) + ".json";
    state.commentPromises[key] = fetch(url, { cache: "no-cache" }).then(function (res) {
      if (!res.ok) throw new Error("comments " + res.status);
      return res.json();
    }).then(function (doc) {
      var data = doc && doc.replies ? doc : { replies: [] };
      data.at = Date.now();
      state.comments[key] = data;
      cachePut("cm:c:" + key, data);
      delete state.commentPromises[key];
      return data;
    }).catch(function () {
      /* Keep the thread usable: keep cached comments, else fall back to any shipped in the doc. */
      if (!(state.comments[key] && !state.comments[key].missing)) state.comments[key] = { replies: [], missing: true, at: Date.now() };
      delete state.commentPromises[key];
      return state.comments[key];
    });
    return state.commentPromises[key];
  }

  function loadInternal(name) {
    if (!signedIn()) {
      state.internal[name] = null;
      return Promise.resolve(null);
    }
    return call("/v1/communities/" + encodeURIComponent(name)).then(function (body) {
      state.internal[name] = body && body.community ? body : null;
      var notes = body && body.notes;
      if (notes && notes.length) {
        notes.forEach(note);
        call("/v1/communities/notes/seen", { method: "POST", body: { ids: notes.map(function (item) { return item.id; }) } });
      }
      return state.internal[name];
    }).catch(function () {
      state.internal[name] = null;
      return null;
    });
  }

  function head(title, back, actions) {
    var acct = session().account;
    var userAva = '<span class="ava initials">Y</span>';
    if (acct) {
      if (acct.avatar && /^https:\/\//.test(acct.avatar)) {
        userAva = '<img class="ava" src="' + esc(acct.avatar) + '" alt="">';
      } else {
        var letter = String(acct.displayName || acct.handle || "Y").slice(0, 1).toUpperCase();
        userAva = '<span class="ava initials">' + esc(letter) + '</span>';
      }
    }
    var mhead = '<div class="mhead">' +
      '<button class="m-ava" type="button" data-act="drawer" aria-label="' + esc(tr("Menu")) + '">' + userAva + '</button>' +
      '<a class="m-logo" href="#/communities" aria-label="' + esc(tr("Communities")) + '">' + svgCommunities + '</a>' +
      '<a class="m-icon" href="#/settings" aria-label="' + esc(tr("Settings")) + '">' + svgSpark + '</a>' +
    '</div>';

    return '<div class="topbar tall">' +
      mhead +
      '<div class="page-head">' +
      (back ? '<a class="icon-btn" href="' + esc(back) + '" aria-label="' + esc(tr("Back")) + '">' + svgBack + '</a>' : "") +
      '<div class="head-text grow"><h1>' + esc(title) + '</h1></div>' +
      (actions ? '<div class="page-head-actions">' + actions + '</div>' : "") +
      '</div></div>';
  }

  function redditPosts(doc, name) {
    return (doc && doc.posts || []).filter(function (post) {
      return post && !hidden(post.author, (post.title || "") + " " + (post.text || ""), "reddit", { id: post.id, community: name || (doc && doc.name) || "" });
    });
  }
  function internalPosts(name) {
    var bag = state.internal[name];
    if (!bag || !signedIn()) return [];
    return (bag.posts || []).filter(function (post) {
      var author = post.author || {};
      return !hidden(author.handle, post.body, "app", { id: post.id, community: name, authorId: author.publicId || author.id || "" });
    });
  }
  function scoreOf(item) {
    if (item.source === "reddit") return Number(item.score) || 0;
    var bag = state.internal[item.community] || {};
    return Number((bag.likes || {})[item.id]) || 0;
  }
  function feedItems(name, doc) {
    var reddit = redditPosts(doc, name).map(function (post) {
      return { source: "reddit", community: name, id: post.id, created: (Number(post.created) || 0) * 1000, score: post.score, post: post };
    });
    var internal = internalPosts(name).filter(function (post) { return !post.parentId; }).map(function (post) {
      return { source: "app", community: name, id: post.id, created: Number(post.createdAt) || 0, score: 0, post: post };
    });
    var items = reddit.concat(internal);
    if (state.filter === "reddit") items = items.filter(function (item) { return item.source === "reddit"; });
    if (state.filter === "app") items = items.filter(function (item) { return item.source === "app"; });
    if (state.tab === "media") items = items.filter(function (item) { return item.source === "reddit" && item.post.media && item.post.media.length; });
    items.sort(function (a, b) {
      if (state.tab === "latest") return b.created - a.created;
      var delta = scoreOf(b) - scoreOf(a);
      return delta || (b.created - a.created);
    });
    return items;
  }
  function inlineReplies(doc, parentId) {
    var out = [];
    ((doc && doc.posts) || []).forEach(function (post) {
      (post.replies || []).forEach(function (reply) {
        if (reply.parent === parentId) out.push(reply);
      });
    });
    return out;
  }
  function repliesFor(name, parentId, doc) {
    var cached = state.comments[commentKey(name, parentId)];
    var list = cached && !cached.missing ? (cached.replies || []) : inlineReplies(doc, parentId);
    var reddit = list.filter(function (reply) {
      return !hidden(reply.author, reply.text, "reddit", { id: reply.id, community: name });
    }).map(function (reply) {
      return { source: "reddit", id: reply.id, created: (Number(reply.created) || 0) * 1000, reply: reply };
    });
    var inThread = {};
    inThread[parentId] = true;
    var guard = 0;
    var grew = true;
    while (grew && guard < 8) {
      grew = false;
      guard += 1;
      internalPosts(name).forEach(function (post) {
        if (post.parentId && inThread[post.parentId] && !inThread[post.id]) {
          inThread[post.id] = true;
          grew = true;
        }
      });
    }
    var internal = internalPosts(name).filter(function (post) { return post.parentId && inThread[post.parentId]; }).map(function (post) {
      return { source: "app", id: post.id, created: Number(post.createdAt) || 0, post: post };
    });
    var items = reddit.concat(internal);
    if (state.filter === "reddit") items = items.filter(function (item) { return item.source === "reddit"; });
    if (state.filter === "app") items = items.filter(function (item) { return item.source === "app"; });
    items.sort(function (a, b) { return a.created - b.created; });
    return items;
  }

  function chips(name) {
    var chip = function (id, label) {
      return '<button class="cm-chip' + (state.filter === id ? " on" : "") + '" type="button" data-cm="filter" data-filter="' + id + '">' + esc(label) + "</button>";
    };
    var sourceLabel = isForum(name || currentSub()) ? tr("Forum") : tr("Reddit");
    return '<div class="cm-filter-bar" role="tablist">' + chip("all", tr("All")) + chip("reddit", sourceLabel) + chip("app", tr("ViktorychApp")) + "</div>";
  }
  function tabs() {
    var tab = function (id, label) {
      return '<button class="tab' + (state.tab === id ? " on" : "") + '" type="button" data-cm="tab" data-tab="' + id + '"><span>' + esc(label) + "</span></button>";
    };
    return '<div class="tabs" role="tablist">' + tab("top", tr("Top")) + tab("latest", tr("Latest")) + tab("media", tr("Media")) + "</div>";
  }
  function hubTabs() {
    var home = state.hubTab === "home";
    var explore = state.hubTab === "explore";
    var custom = readTabs();
    if (state.hubTab.indexOf("tab:") === 0 && !currentTab()) {
      state.hubTab = "home";
      home = true;
    }
    var extra = custom.map(function (tab) {
      var on = state.hubTab === "tab:" + tab.id;
      return '<button class="tab' + (on ? " on" : "") + '" type="button" role="tab" aria-selected="' + (on ? "true" : "false") + '" data-cm="hub-tab" data-hub="tab:' + esc(tab.id) + '"><span>' + esc(tab.name) + "</span></button>";
    }).join("");
    return '<div class="tabs cm-hub-tabs' + (custom.length ? " has-custom" : "") + '" role="tablist">' +
      '<button class="tab' + (home ? " on" : "") + '" type="button" role="tab" aria-selected="' + (home ? "true" : "false") + '" data-cm="hub-tab" data-hub="home"><span>' + svgHome + esc(tr("Home")) +
        '<i class="cm-caret" data-cm="picker" role="button" aria-label="' + esc(tr("Switch community")) + '" aria-expanded="' + (state.picker ? "true" : "false") + '">' + svgCaret + "</i></span></button>" +
      '<button class="tab' + (explore ? " on" : "") + '" type="button" role="tab" aria-selected="' + (explore ? "true" : "false") + '" data-cm="hub-tab" data-hub="explore"><span>' + esc(tr("Explore")) + "</span></button>" +
      extra +
      '<button class="cm-tab-add" type="button" data-cm="tab-new" aria-label="' + esc(tr("New tab")) + '" title="' + esc(tr("New tab")) + '">' + svgPlus + "</button>" +
    "</div>";
  }

  function playUrl(name, post, media, index) {
    var api = String(cfg().api || "").replace(/\/$/, "");
    var role = media.type === "video" ? "video" : "photo";
    if (signedIn() && api && /^t3_[A-Za-z0-9]{1,12}$/.test(post.id || "")) {
      return api + "/tg/social/reddit/" + encodeURIComponent(name) + "/" + encodeURIComponent(post.id) + "/" + role + "/" + index;
    }
    return media.url;
  }
  function mediaFrame(media) {
    var w = Number(media && media.width) || 0;
    var h = Number(media && media.height) || 0;
    var api = window.ViktorychFrame;
    if (!(w > 0 && h > 0) || !api || !api.spec) return { cls: "", attr: ' data-fit="pending"' };
    var spec = api.spec(w, h, api.narrow ? api.narrow() : (window.innerWidth || 390) < 700);
    if (!spec) return { cls: "", attr: ' data-fit="pending"' };
    return {
      cls: " has-ratio" + (spec.clamped ? " is-clamped" : ""),
      attr: ' data-fit="feed" data-mw="' + w + '" data-mh="' + h + '" style="aspect-ratio:' + spec.boxW + " / " + spec.boxH + '"'
    };
  }
  function mediaHtml(name, post, list) {
    if (!list || !list.length) return "";
    var rendered = list.map(function (media, index) {
      if (!media || !media.url) return "";
      var src = playUrl(name, post, media, index);
      var fallback = src !== media.url ? ' data-fallback="' + esc(media.url) + '"' : "";
      var frame = mediaFrame(media);
      if (media.type === "video") return '<video class="cm-reddit-video' + frame.cls + '" controls playsinline preload="metadata" src="' + esc(src) + '"' + fallback + frame.attr + "></video>";
      return '<img class="cm-reddit-photo' + frame.cls + '" alt="" loading="lazy" src="' + esc(src) + '"' + fallback + frame.attr + ">";
    }).join("");
    return '<div class="cm-media-wrap">' + rendered + "</div>";
  }

  function face(author) {
    var letter = String(author.displayName || author.handle || "?").slice(0, 1).toUpperCase();
    if (author.avatar && /^https:\/\//.test(author.avatar)) return '<img class="cm-app-ava" alt="" loading="lazy" decoding="async" src="' + esc(author.avatar) + '">';
    return '<span class="cm-app-ava cm-app-letter">' + esc(letter) + "</span>";
  }

  function joinBtn(name, joined) {
    return '<button type="button" class="cm-btn-join' + (joined ? " joined" : "") + '" data-cm="join" data-sub="' + esc(name) + '" data-leave-text="' + esc(tr("Leave")) + '"><span>' +
      esc(joined ? tr("Joined") : tr("Join")) + "</span></button>";
  }

  function voteState(sub, id) {
    var bag = state.internal[sub] || {};
    var up = (bag.mine || []).indexOf(id) >= 0;
    var down = !!(state.downvotes && state.downvotes[id]);
    return { up: up, down: down };
  }

  function voteGutter(sub, id, total, v) {
    return '<div class="cm-reddit-vote">' +
      '<button class="cm-vote-arrow up' + (v.up ? " on" : "") + '" type="button" data-cm="like" data-id="' + esc(id) + '" aria-label="' + esc(tr("Like")) + '">' + svgUp + '</button>' +
      '<span class="cm-reddit-score' + (v.up ? " on" : v.down ? " down-on" : "") + '">' + esc(count(total)) + '</span>' +
      '<button class="cm-vote-arrow down' + (v.down ? " on" : "") + '" type="button" data-cm="downvote" data-id="' + esc(id) + '" aria-label="Downvote">' + svgDown + '</button>' +
    '</div>';
  }

  function votePill(sub, id, total, v, forceDisplay) {
    var style = forceDisplay ? ' style="display:inline-flex;"' : "";
    return '<span class="cm-mobile-vote"' + style + '>' +
      '<button class="cm-vote-arrow up' + (v.up ? " on" : "") + '" type="button" data-cm="like" data-id="' + esc(id) + '" data-sub="' + esc(sub) + '" aria-label="' + esc(tr("Like")) + '">' + svgUp + '</button>' +
      '<span class="cm-reddit-score' + (v.up ? " on" : v.down ? " down-on" : "") + '">' + esc(count(total)) + '</span>' +
      '<button class="cm-vote-arrow down' + (v.down ? " on" : "") + '" type="button" data-cm="downvote" data-id="' + esc(id) + '" data-sub="' + esc(sub) + '" aria-label="Downvote">' + svgDown + '</button>' +
    '</span>';
  }

  /* Mirrored post card — Reddit layout for subreddits, forum layout for Discourse */
  /* X cuts a long post at about 280 characters and adds "Show more", which
     opens the post; the thread view shows the whole body. */
  var SHOW_CUT = 280;
  function cutBody(text) {
    var s = String(text || "");
    if (s.length <= SHOW_CUT) return { text: s, long: false };
    var cut = s.slice(0, SHOW_CUT);
    var sp = cut.lastIndexOf(" ");
    if (sp > 220) cut = cut.slice(0, sp);
    return { text: cut.replace(/\s+$/, "") + "…", long: true };
  }
  function showMore(href) {
    return '<a class="show-more cm-show-more" href="' + esc(href) + '">' + esc(tr("Show more")) + "</a>";
  }
  function redditCard(name, post, isThread) {
    var href = "#/communities/" + encodeURIComponent(name) + "/" + encodeURIComponent(post.id);
    var bag = state.internal[name] || {};
    var v = voteState(name, post.id);
    var extra = Number((bag.likes || {})[post.id]) || 0;
    var total = (Number(post.score) || 0) + extra + (v.down ? -1 : 0);
    var cleanTxt = cleanRedditText(post.text);
    var authorClean = cleanAuthor(post.author);
    var forum = isForum(name);
    var redditHref = post.url || ("https://www.reddit.com/r/" + encodeURIComponent(name) + "/comments/" + encodeURIComponent(String(post.id).replace(/^t3_/, "")));
    var sourceHref = forum ? (post.url || forumUrl(name)) : redditHref;
    var sourceLabel = forum ? tr("Open on forum") : tr("Open on Reddit");
    var subLabel = forum ? communityTitle(name) : "r/" + name;
    var authorLabel = forum ? esc(authorClean) : "u/" + esc(authorClean);

    return '<article class="cm-reddit-card' + (isThread ? " cm-thread-focus" : "") + '" data-post="' + esc(post.id) + '">' +
      voteGutter(name, post.id, total, v) +
      '<div class="cm-reddit-main">' +
        '<div class="cm-reddit-byline">' +
          '<span class="cm-reddit-snoo">' + (forum ? svgCommunities : svgSnoo) + '</span>' +
          '<a class="cm-reddit-sub" href="#/communities/' + encodeURIComponent(name) + '">' + esc(subLabel) + '</a>' + forumBadge(name) +
          '<span>•</span>' +
          '<span class="cm-reddit-author">' + authorLabel + '</span>' +
          '<span>•</span>' +
          '<span class="cm-reddit-time">' + esc(timeAgo((Number(post.created) || 0) * 1000)) + '</span>' +
          (post.flair ? '<span class="cm-reddit-flair">' + esc(post.flair) + '</span>' : "") +
        '</div>' +
        (post.title ? '<a class="cm-reddit-title" dir="auto" href="' + href + '">' + esc(post.title) + '</a>' : "") +
        (cleanTxt ? '<div class="cm-reddit-text" dir="auto">' + esc(isThread ? cleanTxt : cutBody(cleanTxt).text) + '</div>' : "") +
        (!isThread && cleanTxt && cutBody(cleanTxt).long ? showMore(href) : "") +
        mediaHtml(name, post, post.media) +
        '<div class="cm-reddit-actions">' +
          votePill(name, post.id, total, v, false) +
          '<a class="cm-reddit-action-btn" href="' + href + '">' + svgComment + '<span>' + esc(count(post.comments)) + " " + esc(tr("Comments")) + '</span></a>' +
          '<button class="cm-reddit-action-btn" type="button" data-cm="share" data-href="' + href + '">' + svgShare + '<span>' + esc(tr("Share")) + '</span></button>' +
          (sourceHref ? '<a class="cm-reddit-action-btn reddit-link" href="' + esc(sourceHref) + '" target="_blank" rel="noopener noreferrer">' + (forum ? svgCommunities : svgSnoo) + '<span>' + esc(sourceLabel) + '</span> ' + svgExternal + '</a>' : "") +
          blockBtn(name, post.id, post.author, "reddit") +
        '</div>' +
      '</div>' +
    '</article>';
  }

  /* ViktorychApp Native Post Card — Same Upvote/Downvote System & Layout */
  function appCard(name, post, isThread) {
    var author = post.author || {};
    var bag = state.internal[name] || {};
    var href = "#/communities/" + encodeURIComponent(name) + "/" + encodeURIComponent(post.id);
    var v = voteState(name, post.id);
    var total = (Number((bag.likes || {})[post.id]) || 0) + (v.down ? -1 : 0);
    var authorHandle = String(author.handle || "");

    return '<article class="cm-reddit-card cm-app-card' + (isThread ? " cm-thread-focus" : "") + '" data-post="' + esc(post.id) + '">' +
      voteGutter(name, post.id, total, v) +
      '<div class="cm-reddit-main">' +
        '<div class="cm-reddit-byline">' +
          face(author) +
          '<span class="cm-app-name">' + esc(author.displayName || author.handle || "") + (author.owner ? " ✓" : "") + '</span>' +
          '<span class="cm-app-handle">@' + esc(authorHandle) + '</span>' +
          '<span>•</span>' +
          '<span class="cm-reddit-time">' + esc(timeAgo(Number(post.createdAt) || Date.now())) + '</span>' +
          '<span class="cm-app-badge">' + esc(tr("Only on ViktorychApp")) + '</span>' +
        '</div>' +
        '<a class="cm-reddit-text" href="' + href + '" style="font-size:15px;text-decoration:none;">' + esc(post.body || "") + '</a>' +
        '<div class="cm-reddit-actions">' +
          votePill(name, post.id, total, v, false) +
          '<a class="cm-reddit-action-btn" href="' + href + '">' + svgComment + '<span>' + esc(tr("Reply")) + '</span></a>' +
          '<button class="cm-reddit-action-btn" type="button" data-cm="share" data-href="' + href + '">' + svgShare + '<span>' + esc(tr("Share")) + '</span></button>' +
          (post.mine || owner() ? '<button class="cm-reddit-action-btn del" type="button" data-cm="delete" data-id="' + esc(post.id) + '" data-sub="' + esc(name) + '">' + svgTrash + '<span>' + esc(tr("Delete")) + '</span></button>' : blockBtn(name, post.id, authorHandle, "app")) +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function card(name, item) {
    if (item.source === "reddit") return redditCard(name, item.post, false);
    return appCard(name, item.post);
  }

  function currentSub() {
    var parts = (location.hash || "").split("?")[0].replace(/^#\/?/, "").split("/");
    if (parts[0] !== "communities") return "";
    return nameOf(parts[1]);
  }

  /* Communities hub, laid out like X's mobile Communities page: a header
     with the viewer's avatar and search, Home and Explore tabs, a row of
     community covers, recorded Spaces when there are any, and one feed of
     posts from the communities on Home. */
  var CATEGORIES = [
    { id: "technology", words: ["tech", "software", "android", "linux", "privacy", "security", "programming", "computer", "phone", " os", "app", "ai ", "electric", "vehicle", "motor", "energy"] },
    { id: "news", words: ["news", "politic", "world", "election"] },
    { id: "gaming", words: ["game", "gaming", "esport", "xbox", "playstation", "nintendo"] },
    { id: "sports", words: ["sport", "football", "soccer", "nba", "nfl", "tennis", "f1", "racing"] },
    { id: "entertainment", words: ["movie", "film", "tv", "music", "show", "media", "anime", "book"] },
    { id: "science", words: ["science", "space", "physics", "biology", "astronomy", "research"] },
    { id: "business", words: ["business", "finance", "stock", "invest", "crypto", "startup", "inc."] }
  ];
  function categoryOf(row) {
    if (row && row.category) return String(row.category).toLowerCase();
    var text = " " + [row.name, row.title, row.about].join(" ").toLowerCase() + " ";
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].words.some(function (word) { return text.indexOf(word) >= 0; })) return CATEGORIES[i].id;
    }
    return "";
  }
  function hubRows() {
    var rows = (state.index && state.index.communities) || [];
    var q = String(state.search || "").toLowerCase().trim();
    if (!q) return rows.slice();
    return rows.filter(function (row) {
      return [row.name, row.title, row.about].some(function (v) { return String(v || "").toLowerCase().indexOf(q) >= 0; });
    });
  }
  /* Joined = what the account joined. The per-community bag (loaded when a
     community is opened or its feed loads) was the only source, so joined
     communities whose bag hadn't loaded yet never reached the row. The joined
     list that rides on /v1/posts (kept by app.js) fills the gap; a loaded bag
     still wins so Join/Leave shows at once. The owner adds communities as
     sources instead of joining them, so every hub community counts for them. */
  function serverJoined() {
    var get = window.ViktorychCommunityPrefs;
    var prefs = typeof get === "function" ? get() : null;
    return prefs && Array.isArray(prefs.joined) ? prefs : null;
  }
  function isJoined(name) {
    var bag = state.internal[name];
    if (bag && bag.joined) return true;
    if (owner()) return true;
    if (bag) return false;
    var prefs = serverJoined();
    return !!(prefs && (prefs.all || prefs.joined.indexOf(name) >= 0));
  }
  function joinedRows(rows) {
    return rows.filter(function (row) { return isJoined(row.name); });
  }
  /* Home shows what you joined; before you join anything it shows the most
     followed communities so the page is never empty. */
  function homeRows(rows) {
    var mine = joinedRows(rows);
    var list = mine.length ? mine : rows.slice().sort(function (a, b) { return (Number(b.subscribers) || 0) - (Number(a.subscribers) || 0); });
    var prefs = serverJoined();
    return list.filter(function (row) {
      var bag = state.internal[row.name];
      if (!bag && prefs && Array.isArray(prefs.hidden) && prefs.hidden.indexOf(row.name) >= 0) return false;
      return !(bag && (bag.muted || bag.showHome === false));
    });
  }
  function hubTone(name) {
    var h = 0;
    String(name || "").split("").forEach(function (ch) { h = (h * 31 + ch.charCodeAt(0)) % 360; });
    return h;
  }
  function coverCard(row, badge) {
    var label = isForum(row.name) ? (row.title || row.name) : "r/" + row.name;
    var img = row.banner
      ? '<img class="cm-cover-img" alt="" loading="lazy" decoding="async" src="' + esc(row.banner) + '">'
      : '<span class="cm-cover-img cm-cover-blank" style="--tone:' + hubTone(row.name) + '">' + (row.icon ? '<img alt="" loading="lazy" decoding="async" src="' + esc(row.icon) + '">' : (isForum(row.name) ? svgCommunities : svgSnoo)) + "</span>";
    return '<a class="cm-cover" href="#/communities/' + encodeURIComponent(row.name) + '">' + img + (badge || "") + '<b class="cm-cover-name"><span>' + esc(label) + "</span></b></a>";
  }
  /* ---------- Joined row folders, full lists and featured pins ----------
     Folders are the account's own: kept in its synced settings (or this
     device when no account hook is present), never published. Featured pins
     are the owner's order for Explore, read from the Worker. */
  var FOLDERS_KEY = "va_cm_folders";
  var FEATURED_KEY = "va_cm_featured";
  function cleanFolders(bag) {
    var list = bag && Array.isArray(bag.folders) ? bag.folders : [];
    var folders = [];
    var seen = {};
    var used = {};
    list.forEach(function (folder) {
      if (!folder || typeof folder !== "object" || folders.length >= 20) return;
      var id = String(folder.id || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
      var name = String(folder.name || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 40);
      if (!id || !name || seen[id]) return;
      seen[id] = true;
      var items = [];
      (Array.isArray(folder.items) ? folder.items : []).forEach(function (item) {
        var key = String(item || "").toLowerCase();
        if (/^[a-z0-9_]{2,21}$/.test(key) && !used[key] && items.length < 60) { used[key] = true; items.push(key); }
      });
      folders.push({ id: id, name: name, items: items });
    });
    var order = [];
    (bag && Array.isArray(bag.order) ? bag.order : []).forEach(function (key) {
      key = String(key || "");
      if (order.length < 200 && /^(?:f:[A-Za-z0-9]{1,24}|c:[a-z0-9_]{2,21})$/.test(key) && order.indexOf(key) < 0) order.push(key);
    });
    return { at: Number(bag && bag.at) || 0, folders: folders, order: order };
  }
  function readFolders() {
    var h = hooks();
    var bag = h.readFolders ? h.readFolders() : null;
    if (!bag) {
      try { bag = JSON.parse(localStorage.getItem(FOLDERS_KEY) || "null"); } catch (_) { bag = null; }
    }
    return cleanFolders(bag);
  }
  function writeFolders(bag) {
    var clean = cleanFolders(Object.assign({}, bag, { at: Date.now() }));
    var h = hooks();
    if (h.writeFolders) h.writeFolders(clean);
    try { localStorage.setItem(FOLDERS_KEY, JSON.stringify(clean)); } catch (_) { /* the account copy still holds it */ }
    return clean;
  }
  function folderById(bag, id) {
    for (var i = 0; i < bag.folders.length; i++) if (bag.folders[i].id === id) return bag.folders[i];
    return null;
  }
  function newFolderId() {
    return "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  /* The joined row in its saved order: folders and the communities that are
     not inside one. Anything new lands at the end in the hub's order. */
  function rowEntries(rows) {
    var bag = readFolders();
    var byName = {};
    rows.forEach(function (row) { byName[row.name] = row; });
    var inFolder = {};
    var list = bag.folders.map(function (folder) {
      folder.items.forEach(function (name) { inFolder[name] = true; });
      return { kind: "folder", key: "f:" + folder.id, folder: folder, rows: folder.items.filter(function (name) { return byName[name]; }).map(function (name) { return byName[name]; }) };
    });
    rows.forEach(function (row) {
      if (!inFolder[row.name]) list.push({ kind: "community", key: "c:" + row.name, row: row });
    });
    var pos = {};
    bag.order.forEach(function (key, i) { pos[key] = i; });
    return list.map(function (entry, i) { return { entry: entry, at: pos[entry.key] != null ? pos[entry.key] : 1000 + i }; })
      .sort(function (a, b) { return a.at - b.at; })
      .map(function (item) { return item.entry; });
  }
  function rowLabel(row) {
    return isForum(row.name) ? (row.title || row.name) : "r/" + row.name;
  }
  function miniAva(row) {
    var pic = row.icon || row.banner;
    return '<span class="cm-folder-mini" style="--tone:' + hubTone(row.name) + '">' +
      (pic ? '<img alt="" loading="lazy" decoding="async" src="' + esc(pic) + '">' : (isForum(row.name) ? svgCommunities : svgSnoo)) + "</span>";
  }
  function folderGrid(rows) {
    var cells = rows.slice(0, 4).map(miniAva);
    while (cells.length < 4) cells.push('<span class="cm-folder-mini cm-folder-empty"></span>');
    return cells.join("");
  }
  /* Same size as a community tile: a 2x2 grid of the folder's avatars and its name. */
  function folderTile(entry) {
    var name = entry.folder.name;
    return '<button class="cm-cover cm-folder" type="button" data-cm="cm-panel" data-panel="folder:' + esc(entry.folder.id) + '" aria-label="' + esc(tr("Open folder {name}", { name: name })) + '">' +
      '<span class="cm-cover-img cm-folder-grid">' + folderGrid(entry.rows) + "</span>" +
      '<b class="cm-cover-name"><span>' + esc(name) + "</span></b></button>";
  }
  function featuredList() {
    if (!state.featured) {
      try {
        var saved = JSON.parse(localStorage.getItem(FEATURED_KEY) || "null");
        if (saved && Array.isArray(saved.names)) { state.featured = saved.names; state.canPin = !!saved.canEdit; state.featuredAt = 0; }
      } catch (_) { /* read again from the Worker */ }
    }
    if (signedIn() && !state.featuredBusy && Date.now() - (state.featuredAt || 0) > 5 * 60 * 1000) {
      state.featuredBusy = true;
      call("/v1/communities/featured").then(function (body) {
        state.featuredBusy = false;
        state.featuredAt = Date.now();
        if (!body || !Array.isArray(body.featured)) return;
        var same = JSON.stringify(body.featured) === JSON.stringify(state.featured || []) && !!body.canEdit === !!state.canPin;
        state.featured = body.featured;
        state.canPin = !!body.canEdit;
        try { localStorage.setItem(FEATURED_KEY, JSON.stringify({ names: state.featured, canEdit: state.canPin })); } catch (_) { /* memory only */ }
        if (!same) render();
      });
    }
    return state.featured || [];
  }
  function canPin() {
    return owner() || !!state.canPin;
  }
  /* Every community: the owner's featured ones first in their order, then
     the rest by members. */
  function allOrdered(rows) {
    var pins = featuredList();
    var byName = {};
    rows.forEach(function (row) { byName[row.name] = row; });
    var top = pins.filter(function (name) { return byName[name]; }).map(function (name) { return byName[name]; });
    var rest = rows.filter(function (row) { return pins.indexOf(row.name) < 0; })
      .sort(function (a, b) { return (Number(b.subscribers) || 0) - (Number(a.subscribers) || 0); });
    return top.concat(rest);
  }
  function featuredBadge(name) {
    return featuredList().indexOf(name) >= 0 ? '<i class="cm-featured-badge">' + esc(tr("Featured")) + "</i>" : "";
  }
  function allRow(rows) {
    var list = allOrdered(rows);
    if (!list.length) return "";
    return '<div class="cm-section-head">' + esc(tr("All communities")) + "</div>" +
      '<div class="cm-covers cm-all-row" role="list">' + list.map(function (row) { return coverCard(row, featuredBadge(row.name)); }).join("") +
      '<button class="cm-see-all" type="button" data-cm="cm-panel" data-panel="all" aria-label="' + esc(tr("All communities")) + '">' + svgArrow + "</button></div>";
  }
  function panelHead(title, extra) {
    return '<div class="cm-panel-head"><button class="cm-icon-btn" type="button" data-cm="panel-back" aria-label="' + esc(tr("Back")) + '">' + svgBack + "</button>" +
      "<h2>" + esc(title) + "</h2>" + (extra || "") + "</div>";
  }
  function iconBtn(act, label, glyph, data) {
    return '<button class="cm-mini-btn" type="button" data-cm="' + act + '"' + (data || "") + ' aria-label="' + esc(label) + '" title="' + esc(label) + '">' + glyph + "</button>";
  }
  function folderSelect(name, bag, current) {
    var opts = '<option value=""' + (current ? "" : " selected") + ">" + esc(tr("No folder")) + "</option>" +
      bag.folders.map(function (folder) {
        return '<option value="' + esc(folder.id) + '"' + (folder.id === current ? " selected" : "") + ">" + esc(folder.name) + "</option>";
      }).join("");
    return '<label class="cm-move"><span>' + esc(tr("Move to folder")) + '</span><select data-cm="move-folder" data-sub="' + esc(name) + '">' + opts + "</select></label>";
  }
  function joinedLine(row, bag, folderId, scope) {
    var data = ' data-sub="' + esc(row.name) + '" data-scope="' + esc(scope) + '"';
    return '<div class="cm-line" data-line="' + esc(row.name) + '">' +
      '<a class="cm-pick" href="#/communities/' + encodeURIComponent(row.name) + '">' + miniAva(row) + "<span>" + esc(rowLabel(row)) + "</span></a>" +
      '<div class="cm-line-tools">' + folderSelect(row.name, bag, folderId) +
        iconBtn("row-up", tr("Move up"), "↑", data) + iconBtn("row-down", tr("Move down"), "↓", data) +
      "</div></div>";
  }
  function folderForm(id, value) {
    return '<form class="cm-folder-form" data-cm="folder-save" data-folder="' + esc(id || "") + '">' +
      '<input name="name" maxlength="40" required placeholder="' + esc(tr("Folder name")) + '" aria-label="' + esc(tr("Folder name")) + '" value="' + esc(value || "") + '">' +
      '<button type="submit">' + esc(id ? tr("Save") : tr("Create")) + "</button>" +
      '<button type="button" data-cm="folder-cancel">' + esc(tr("Cancel")) + "</button></form>";
  }
  function folderTools(folder) {
    var data = ' data-folder="' + esc(folder.id) + '"';
    return '<div class="cm-line-tools">' +
      iconBtn("folder-rename", tr("Rename"), "✎", data) +
      iconBtn("folder-delete", tr("Delete folder"), svgTrash, data) +
      iconBtn("row-up", tr("Move up"), "↑", data + ' data-scope="row"') +
      iconBtn("row-down", tr("Move down"), "↓", data + ' data-scope="row"') + "</div>";
  }
  function joinedPanel(rows) {
    var bag = readFolders();
    var entries = rowEntries(joinedRows(rows));
    state.openFolders = state.openFolders || {};
    var body = entries.map(function (entry) {
      if (entry.kind === "community") return joinedLine(entry.row, bag, "", "row");
      var folder = entry.folder;
      var open = state.openFolders[folder.id] !== false;
      var head = state.folderEdit === folder.id ? folderForm(folder.id, folder.name) :
        '<button class="cm-folder-head" type="button" data-cm="folder-toggle" data-folder="' + esc(folder.id) + '" aria-expanded="' + (open ? "true" : "false") + '">' +
          '<span class="cm-folder-grid cm-folder-small">' + folderGrid(entry.rows) + "</span>" +
          "<b>" + esc(folder.name) + "</b><span class=\"cm-folder-count\">" + esc(String(entry.rows.length)) + "</span>" +
          '<span class="cm-folder-caret">' + svgCaret + "</span></button>";
      return '<section class="cm-folder-section' + (open ? " open" : "") + '" data-folder-section="' + esc(folder.id) + '">' +
        '<div class="cm-folder-bar">' + head + (state.folderEdit === folder.id ? "" : folderTools(folder)) + "</div>" +
        (open ? '<div class="cm-folder-items">' + (entry.rows.length ? entry.rows.map(function (row) { return joinedLine(row, bag, folder.id, folder.id); }).join("") : '<p class="cm-folder-empty-note">' + esc(tr("Move communities here with Move to folder.")) + "</p>") + "</div>" : "") +
        "</section>";
    }).join("");
    var add = state.folderEdit === "new" ? folderForm("", "") :
      '<button class="cm-new-folder" type="button" data-cm="folder-new">' + svgPlus + "<span>" + esc(tr("New folder")) + "</span></button>";
    return panelHead(tr("Your Communities")) + '<div class="cm-panel-body">' + add +
      (body || '<div class="empty"><h2>' + esc(tr("Join a community to see it here.")) + "</h2></div>") + "</div>";
  }
  function folderPanel(rows, id) {
    var bag = readFolders();
    var entry = rowEntries(joinedRows(rows)).filter(function (item) { return item.kind === "folder" && item.folder.id === id; })[0];
    if (!entry) { state.panel = "joined"; return joinedPanel(rows); }
    var head = state.folderEdit === id ? folderForm(id, entry.folder.name) : "";
    var list = entry.rows.map(function (row) { return joinedLine(row, bag, id, id); }).join("");
    return panelHead(entry.folder.name, state.folderEdit === id ? "" : folderTools(entry.folder)) + '<div class="cm-panel-body">' + head +
      (list ? '<div class="cm-folder-items">' + list + "</div>" : '<p class="cm-folder-empty-note">' + esc(tr("Move communities here with Move to folder.")) + "</p>") + "</div>";
  }
  function allPanel(rows) {
    var pins = featuredList();
    var editor = canPin();
    var list = allOrdered(rows).map(function (row) {
      var pinned = pins.indexOf(row.name) >= 0;
      var data = ' data-sub="' + esc(row.name) + '"';
      var tools = editor ? '<div class="cm-line-tools">' +
        (pinned ? iconBtn("pin-up", tr("Move up"), "↑", data) + iconBtn("pin-down", tr("Move down"), "↓", data) : "") +
        '<button class="cm-pin-btn' + (pinned ? " on" : "") + '" type="button" data-cm="pin-toggle"' + data + ">" + esc(pinned ? tr("Unpin") : tr("Pin")) + "</button></div>" : "";
      return '<div class="cm-line' + (pinned ? " pinned" : "") + '" data-line="' + esc(row.name) + '">' +
        '<a class="cm-pick" href="#/communities/' + encodeURIComponent(row.name) + '">' + miniAva(row) + "<span>" + esc(rowLabel(row)) + "</span>" + featuredBadge(row.name) + "</a>" + tools + "</div>";
    }).join("");
    var hint = editor ? '<p class="cm-pin-hint">' + esc(tr("Pinned communities show first on Explore for everyone.")) + "</p>" : "";
    return panelHead(tr("All communities")) + '<div class="cm-panel-body">' + hint + list + "</div>";
  }
  function panelPage(rows) {
    if (state.panel === "joined") return joinedPanel(rows);
    if (state.panel === "all") return allPanel(rows);
    if (String(state.panel).indexOf("folder:") === 0) return folderPanel(rows, state.panel.slice(7));
    return "";
  }
  function moveIn(list, item, step) {
    var i = list.indexOf(item);
    var j = i + step;
    if (i < 0 || j < 0 || j >= list.length) return list;
    var next = list.slice();
    next[i] = list[j];
    next[j] = item;
    return next;
  }
  function savePins(names) {
    var prev = state.featured || [];
    state.featured = names;
    render();
    call("/v1/owner/communities/featured", { method: "POST", body: { names: names } }).then(function (body) {
      if (!body || !Array.isArray(body.featured)) {
        state.featured = prev;
        toast(tr("Couldn't save the pins."));
      } else {
        state.featured = body.featured;
        state.featuredAt = Date.now();
        try { localStorage.setItem(FEATURED_KEY, JSON.stringify({ names: state.featured, canEdit: true })); } catch (_) { /* memory only */ }
      }
      render();
    });
  }
  /* Panel and folder clicks; true when handled. */
  function panelClick(act, el) {
    var rows = hubRows();
    var bag;
    if (act === "cm-panel") {
      state.panel = el.dataset.panel || "";
      state.folderEdit = "";
      state.picker = false;
      render();
      window.scrollTo(0, 0);
      return true;
    }
    if (act === "panel-back") {
      state.panel = String(state.panel).indexOf("folder:") === 0 && state.panelFrom === "joined" ? "joined" : "";
      state.panelFrom = "";
      state.folderEdit = "";
      render();
      return true;
    }
    if (act === "folder-new") { state.folderEdit = "new"; render(); focusFolderInput(); return true; }
    if (act === "folder-cancel") { state.folderEdit = ""; render(); return true; }
    if (act === "folder-rename") { state.folderEdit = el.dataset.folder || ""; render(); focusFolderInput(); return true; }
    if (act === "folder-toggle") {
      state.openFolders = state.openFolders || {};
      var fid = el.dataset.folder;
      state.openFolders[fid] = state.openFolders[fid] === false;
      render();
      return true;
    }
    if (act === "folder-delete") {
      bag = readFolders();
      var gone = folderById(bag, el.dataset.folder);
      if (!gone) return true;
      if (!window.confirm(tr("Delete folder {name}? Its communities stay joined.", { name: gone.name }))) return true;
      bag.folders = bag.folders.filter(function (folder) { return folder.id !== gone.id; });
      bag.order = bag.order.filter(function (key) { return key !== "f:" + gone.id; });
      writeFolders(bag);
      if (state.panel === "folder:" + gone.id) state.panel = state.panelFrom === "joined" ? "joined" : "";
      render();
      return true;
    }
    if (act === "row-up" || act === "row-down") {
      var step = act === "row-up" ? -1 : 1;
      bag = readFolders();
      var scope = el.dataset.scope || "row";
      if (scope === "row") {
        var keys = rowEntries(joinedRows(rows)).map(function (entry) { return entry.key; });
        var key = el.dataset.folder ? "f:" + el.dataset.folder : "c:" + el.dataset.sub;
        bag.order = moveIn(keys, key, step);
      } else {
        var holder = folderById(bag, scope);
        if (holder) holder.items = moveIn(holder.items, el.dataset.sub, step);
      }
      writeFolders(bag);
      render();
      return true;
    }
    if (act === "pin-toggle" || act === "pin-up" || act === "pin-down") {
      if (!canPin()) return true;
      var pins = featuredList().slice();
      var name = el.dataset.sub;
      if (act === "pin-toggle") pins = pins.indexOf(name) >= 0 ? pins.filter(function (item) { return item !== name; }) : pins.concat([name]);
      else pins = moveIn(pins, name, act === "pin-up" ? -1 : 1);
      savePins(pins);
      return true;
    }
    return false;
  }
  function focusFolderInput() {
    setTimeout(function () {
      var box = document.querySelector(".cm-folder-form input");
      if (box) { box.focus(); box.select(); }
    }, 0);
  }
  function saveFolderForm(form) {
    var input = form.querySelector("input");
    var name = String(input && input.value || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 40);
    if (!name) return;
    var bag = readFolders();
    var id = form.dataset.folder;
    var folder = id ? folderById(bag, id) : null;
    if (folder) folder.name = name;
    else if (bag.folders.length < 20) {
      var fresh = { id: newFolderId(), name: name, items: [] };
      bag.folders.push(fresh);
      bag.order = ["f:" + fresh.id].concat(rowEntries(joinedRows(hubRows())).map(function (entry) { return entry.key; }).filter(function (key) { return key !== "f:" + fresh.id; }));
    }
    writeFolders(bag);
    state.folderEdit = "";
    render();
  }
  function moveToFolder(name, folderId) {
    var bag = readFolders();
    bag.folders.forEach(function (folder) { folder.items = folder.items.filter(function (item) { return item !== name; }); });
    var target = folderId ? folderById(bag, folderId) : null;
    if (target) target.items.push(name);
    writeFolders(bag);
    render();
  }
  /* Communities Home: only what this account joined (like X), in its own
     order with its folders; the arrow opens the full joined list. */
  function coverRow(rows) {
    if (!rows.length) return "";
    var tiles = (joinedRows(hubRows()).length ? rowEntries(rows) : rows.map(function (row) { return { kind: "community", row: row }; })).map(function (entry) {
      return entry.kind === "folder" ? folderTile(entry) : coverCard(entry.row);
    }).join("");
    /* Nothing joined yet: the row is the popular starter set and the arrow goes to Explore. */
    var starter = !joinedRows(hubRows()).length;
    var arrow = starter ? 'data-cm="hub-tab" data-hub="explore"' : 'data-cm="cm-panel" data-panel="joined"';
    return '<div class="cm-covers' + (starter ? "" : " cm-joined-row") + '" role="list">' + tiles +
      '<button class="cm-see-all" type="button" ' + arrow + ' aria-label="' + esc(tr("See all communities")) + '">' + svgArrow + "</button></div>";
  }
  function recordedDate(value) {
    var d = new Date(typeof value === "number" ? value * (value < 1e12 ? 1000 : 1) : String(value || ""));
    if (isNaN(d.getTime())) return "";
    return String(d.getMonth() + 1).padStart(2, "0") + "/" + String(d.getDate()).padStart(2, "0");
  }
  /* Recorded Spaces and media appear only when a community publishes them. */
  function recordedRow(rows) {
    var cards = [];
    rows.forEach(function (row) {
      var doc = state.docs[row.name] || {};
      (doc.recordings || row.recordings || []).forEach(function (rec) {
        if (!rec || !rec.title || cards.length >= 12) return;
        var href = /^https:\/\//.test(rec.url || "") ? rec.url : (/^#\//.test(rec.url || "") ? rec.url : "#/communities/" + encodeURIComponent(row.name));
        var ext = /^https:/.test(href) ? ' target="_blank" rel="noopener noreferrer"' : "";
        var date = recordedDate(rec.recorded || rec.created);
        cards.push('<a class="cm-rec" href="' + esc(href) + '"' + ext + '>' +
          '<span class="cm-rec-thumb">' + (/^https:\/\//.test(rec.thumb || "") ? '<img alt="" loading="lazy" decoding="async" src="' + esc(rec.thumb) + '">' : "") +
          '<i class="cm-rec-badge">' + esc(date ? tr("Recorded {date}", { date: date }) : tr("Recorded {date}", { date: "" }).trim()) + "</i></span>" +
          '<b class="cm-rec-title">' + esc(rec.title) + "</b></a>");
      });
    });
    return cards.length ? '<div class="cm-recs" role="list">' + cards.join("") + "</div>" : "";
  }
  function relTime(ms) {
    var diff = Math.max(0, Date.now() - (Number(ms) || 0));
    var m = Math.floor(diff / 60000);
    if (m < 1) return tr("now");
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    var d = new Date(Number(ms) || 0);
    return d.toLocaleDateString((window.SI18n ? window.SI18n.locale() : undefined), { month: "short", day: "numeric" });
  }
  /* A post on Home: an X post card with the community it came from above. */
  function homeCard(item) {
    var name = item.community;
    var post = item.post;
    var href = "#/communities/" + encodeURIComponent(name) + "/" + encodeURIComponent(post.id);
    var forum = isForum(name);
    var where = forum ? communityTitle(name) : "r/" + name;
    var v = voteState(name, post.id);
    var bag = state.internal[name] || {};
    var extra = Number((bag.likes || {})[post.id]) || 0;
    var who, handle, avatar, body, media = "", replies, more = false;
    if (item.source === "reddit") {
      var author = cleanAuthor(post.author);
      who = forum ? author : "u/" + author;
      handle = "";
      avatar = '<span class="cm-app-ava cm-x-snoo">' + (forum ? svgCommunities : svgSnoo) + "</span>";
      var text = cleanRedditText(post.text);
      var cutText = cutBody(text);
      more = cutText.long;
      body = (post.title ? '<span class="cm-x-title" dir="auto">' + esc(post.title) + "</span>" : "") + (text ? '<span class="cm-x-body" dir="auto">' + esc(cutText.text) + "</span>" : "");
      media = mediaHtml(name, post, post.media);
      replies = count(post.comments);
    } else {
      var a = post.author || {};
      who = a.displayName || a.handle || "";
      handle = a.handle ? "@" + a.handle : "";
      avatar = face(a);
      var cutApp = cutBody(post.body || "");
      more = cutApp.long;
      body = '<span class="cm-x-body" dir="auto">' + esc(cutApp.text) + "</span>";
      replies = "";
    }
    var total = (item.source === "reddit" ? (Number(post.score) || 0) : 0) + extra + (v.down ? -1 : 0);
    return '<article class="cm-x-post" data-post="' + esc(post.id) + '">' +
      '<a class="cm-x-ctx" href="#/communities/' + encodeURIComponent(name) + '">' + svgCommunities + "<span>" + esc(where) + "</span></a>" +
      '<div class="cm-x-row">' + avatar +
        '<div class="cm-x-main">' +
          '<div class="cm-x-by"><b>' + esc(who) + "</b>" + (handle ? '<span class="cm-x-handle">' + esc(handle) + "</span>" : "") + '<span class="cm-x-time">· ' + esc(relTime(item.created)) + "</span></div>" +
          '<a class="cm-x-text" href="' + href + '">' + body + "</a>" + (more ? showMore(href) : "") +
          media +
          '<div class="cm-x-acts">' +
            '<a class="cm-x-act" href="' + href + '" aria-label="' + esc(tr("Reply")) + '">' + svgComment + (replies ? "<span>" + esc(replies) + "</span>" : "") + "</a>" +
            votePill(name, post.id, total, v, true) +
            '<button class="cm-x-act" type="button" data-cm="share" data-href="' + href + '" aria-label="' + esc(tr("Share")) + '">' + svgShare + "</button>" +
          "</div>" +
        "</div>" +
      "</div>" +
    "</article>";
  }
  function homeFeed(rows) {
    var items = [];
    var waiting = false;
    rows.slice(0, 8).forEach(function (row) {
      var name = row.name;
      if (cachedDoc(name)) revalidate(name);
      if (!state.docs[name]) {
        waiting = true;
        if (!state.loading[name]) {
          state.loading[name] = true;
          Promise.all([
            loadDoc(name).catch(function () { return null; }),
            loadInternal(name).catch(function () { return null; })
          ]).finally(function () { state.loading[name] = false; render(); });
        }
        return;
      }
      var doc = state.docs[name];
      if (doc.missing) return;
      var bag = state.internal[name];
      if (bag && bag.locked) return;
      redditPosts(doc, name).forEach(function (post) {
        items.push({ source: "reddit", community: name, id: post.id, created: (Number(post.created) || 0) * 1000, post: post });
      });
      internalPosts(name).filter(function (post) { return !post.parentId; }).forEach(function (post) {
        items.push({ source: "app", community: name, id: post.id, created: Number(post.createdAt) || 0, post: post });
      });
    });
    items.sort(function (a, b) { return b.created - a.created; });
    if (!items.length) return waiting ? '<div class="reply-empty">' + esc(tr("Loading")) + "</div>" : '<div class="empty"><h2>' + esc(tr("No posts yet")) + "</h2></div>";
    return '<div class="cm-x-feed">' + items.slice(0, 60).map(homeCard).join("") + "</div>";
  }
  function pickerSheet(rows) {
    if (!state.picker) return "";
    var mine = joinedRows(rows);
    var list = (mine.length ? mine : rows).map(function (row) {
      return '<a class="cm-pick" href="#/communities/' + encodeURIComponent(row.name) + '">' + (row.icon ? '<img alt="" loading="lazy" src="' + esc(row.icon) + '">' : '<span class="cm-pick-ico">' + (isForum(row.name) ? svgCommunities : svgSnoo) + "</span>") +
        "<span>" + esc(isForum(row.name) ? (row.title || row.name) : "r/" + row.name) + "</span></a>";
    }).join("");
    return '<div class="cm-picker" role="menu"><div class="cm-pick-head">' + esc(mine.length ? tr("Your Communities") : tr("Popular communities")) + "</div>" + list + "</div>";
  }
  function categoryBar() {
    var categoryLabels = { technology: tr("Technology"), news: tr("News"), gaming: tr("Gaming"), sports: tr("Sports"), entertainment: tr("Entertainment"), science: tr("Science"), business: tr("Business") };
    var chip = function (id, label) {
      return '<button class="cm-chip' + (state.category === id ? " on" : "") + '" type="button" data-cm="category" data-cat="' + id + '"><span>' + esc(label) + "</span></button>";
    };
    return '<div class="cm-filter-bar cm-cats" role="tablist">' + chip("all", tr("All")) + CATEGORIES.map(function (c) { return chip(c.id, categoryLabels[c.id]); }).join("") + "</div>";
  }
  function exploreGrid(rows) {
    var list = state.category === "all" ? rows : rows.filter(function (row) { return categoryOf(row) === state.category; });
    var cards = list.map(function (row) {
      var isJoined = state.internal[row.name] && state.internal[row.name].joined;
      return '<div class="cm-card">' +
        '<a class="cm-card-cover" href="#/communities/' + encodeURIComponent(row.name) + '" style="--tone:' + hubTone(row.name) + '">' + (row.banner ? '<img alt="" loading="lazy" decoding="async" src="' + esc(row.banner) + '">' : "") + "</a>" +
        '<div class="cm-card-body">' +
          '<div class="cm-card-row">' +
            (row.icon ? '<img class="cm-card-avatar" alt="" loading="lazy" src="' + esc(row.icon) + '">' : '<div class="cm-card-avatar">' + (isForum(row.name) ? svgCommunities : svgSnoo) + "</div>") +
            joinBtn(row.name, isJoined) +
          "</div>" +
          '<a href="#/communities/' + encodeURIComponent(row.name) + '" class="cm-card-link">' +
            '<h3 class="cm-card-title">' + (isForum(row.name) ? esc(row.title || row.name) : "r/" + esc(row.name)) + forumBadge(row.name) + "</h3>" +
            '<p class="cm-card-desc">' + esc(row.about || row.title || ("r/" + row.name)) + "</p>" +
            '<div class="cm-facepile-wrap"><div class="cm-facepile"><span class="cm-face-dot d1"></span><span class="cm-face-dot d2"></span><span class="cm-face-dot d3"></span></div>' +
              "<span>" + esc(count(row.subscribers || 0)) + " " + esc(tr("Members")) + "</span></div>" +
          "</a>" +
        "</div>" +
      "</div>";
    }).join("");
    return '<div class="cm-section-head">' + esc(tr("Discover Communities")) + "</div>" +
      (cards ? '<div class="cm-card-grid">' + cards + "</div>" : '<div class="empty"><h2>' + esc(tr("That community wasn't found.")) + "</h2></div>");
  }
  function hubHead() {
    var acct = session().account;
    var face = '<span class="ava initials">Y</span>';
    if (acct) {
      face = acct.avatar && /^https:\/\//.test(acct.avatar)
        ? '<img class="ava" src="' + esc(acct.avatar) + '" alt="">'
        : '<span class="ava initials">' + esc(String(acct.displayName || acct.handle || "Y").slice(0, 1).toUpperCase()) + "</span>";
    }
    var add = owner() || asking() ? '<button class="cm-icon-btn" type="button" data-cm="toggle-add" aria-label="' + esc(owner() ? tr("Add community") : tr("Request a community")) + '">' + svgPlus + "</button>" : "";
    return '<div class="topbar tall cm-hub-top">' +
      '<div class="cm-hub-bar">' +
        '<button class="m-ava" type="button" data-act="drawer" aria-label="' + esc(tr("Menu")) + '">' + face + "</button>" +
        "<h1>" + esc(tr("Communities")) + "</h1>" +
        '<button class="cm-icon-btn" type="button" data-cm="toggle-search" aria-label="' + esc(tr("Search Communities")) + '" aria-pressed="' + (state.showSearch || state.search ? "true" : "false") + '">' + svgSearch + "</button>" +
        add +
      "</div>" +
      hubTabs() +
    "</div>";
  }
  function listPage() {
    var index = state.index;
    if (index && index.communities && index.communities.length && indexStale() && !state.loadingIndex) {
      /* Revalidate in the background so a stale hub cache repairs itself on this visit. */
      state.loadingIndex = true;
      loadIndex(true).finally(function () {
        state.loadingIndex = false;
        render();
      });
    }
    if (!index || !index.communities || !index.communities.length) {
      if (!state.loadingIndex) {
        state.loadingIndex = true;
        loadIndex().finally(function () {
          state.loadingIndex = false;
          render();
        });
      }
      return hubHead() + '<div class="reply-empty">' + esc(tr("Loading")) + "</div>";
    }
    var addBar = ((owner() || asking()) && state.showAdd)
      ? '<form class="cm-add-bar" data-cm="add"><input name="name" placeholder="r/technology" aria-label="' + esc(owner() ? tr("Add community") : tr("Request a community")) + '"><button type="submit">' + esc(owner() ? tr("Add") : tr("Request")) + "</button></form>"
      : "";
    var searchBar = (state.showSearch || state.search) ? '<div class="cm-search-wrap">' +
      '<div class="cm-search-box">' +
        '<span class="cm-search-svg">' + svgSearch + "</span>" +
        '<input type="text" class="cm-search-input" placeholder="' + esc(tr("Search Communities")) + '" value="' + esc(state.search) + '" data-cm="search-input" aria-label="' + esc(tr("Search Communities")) + '">' +
        (state.search ? '<button type="button" class="cm-search-clear" data-cm="clear-search" aria-label="' + esc(tr("Clear")) + '">✕</button>' : "") +
      "</div></div>" : "";
    var rows = hubRows();
    var body;
    var custom = currentTab();
    if (state.panel && !custom) {
      body = panelPage(rows);
    } else if (state.hubTab === "explore") {
      body = allRow(rows) + '<div class="cm-hub-sep"></div>' + categoryBar() + exploreGrid(rows);
    } else if (custom) {
      body = customTabPage(custom);
    } else {
      var home = homeRows(rows);
      var recs = recordedRow(home);
      body = pickerSheet(rows) + coverRow(home) + (recs ? '<div class="cm-hub-sep"></div>' + recs : "") + '<div class="cm-hub-sep"></div>' + homeFeed(home);
    }
    return hubHead() + addBar + searchBar + '<div class="cm-hub" data-hub="' + esc(custom ? "tab" : state.hubTab) + '">' + body + "</div>";
  }

  /* Single Community Feed Page (X.com 1-to-1 Clone) */
  function communityPage(route) {
    var name = nameOf(route.sub);
    if (!name) return head(tr("Communities"), "#/communities") + '<div class="empty"><h2>' + esc(tr("That community wasn't found.")) + "</h2></div>";
    var doc = cachedDoc(name);
    if (doc) revalidate(name);
    if (!doc) {
      if (!state.loading[name]) {
        state.loading[name] = true;
        Promise.all([
          loadDoc(name).catch(function () { return null; }),
          loadInternal(name).catch(function () { return null; })
        ]).finally(function () {
          state.loading[name] = false;
          render();
        });
      }
      return head(communityLabel(name), "#/communities") + '<div class="reply-empty">' + esc(tr("Loading")) + "</div>";
    }

    if (doc.missing) {
      return head(communityLabel(name), "#/communities") +
        '<div class="empty"><h2>' + esc(tr("That community wasn't found.")) + '</h2>' +
        '<button class="retry" type="button" data-cm="retry" data-sub="' + esc(name) + '">' + esc(tr("Retry")) + '</button></div>';
    }

    var bag = state.internal[name];
    var joined = bag && bag.joined;
    var forum = isForum(name);
    var title = communityTitle(name);
    var sourceUrl = forumUrl(name);
    var host = forumHost(name);
    var bannerImg = doc.banner
      ? '<img class="cm-hero-banner" alt="" src="' + esc(doc.banner) + '">'
      : '<div class="cm-hero-banner"></div>';

    var avatarImg = doc.icon
      ? '<img class="cm-hero-avatar" alt="" src="' + esc(doc.icon) + '">'
      : '<div class="cm-hero-avatar">' + (forum ? svgCommunities : svgSnoo) + '</div>';

    var shareBtn = '<button class="cm-icon-btn" type="button" data-cm="share" aria-label="' + esc(tr("Share")) + '">' + svgShare + '</button>';
    var removeBtn = owner() ? '<button class="cm-icon-btn" type="button" data-cm="remove" data-sub="' + esc(name) + '" aria-label="' + esc(tr("Remove")) + '">' + svgTrash + '</button>' : "";

    var rulesList = (doc.rules || []).map(function (rule, idx) {
      return '<div class="cm-rule-item"><span class="cm-rule-num">' + (idx + 1) + '</span><div><div class="cm-rule-title">' + esc(rule.title || "") + '</div><div>' + esc(rule.text || "") + '</div></div></div>';
    }).join("");

    var rulesAccordion = rulesList
      ? '<details class="cm-rules-box"><summary class="cm-rules-summary"><span>' + esc(tr("Community rules")) + '</span><span>▾</span></summary><div class="cm-rules-content">' + rulesList + '</div></details>'
      : "";

    var composeLabel = forum
      ? tr("Post into {name}", { name: title })
      : tr("Post into r/{name}", { name: name });
    var memberLabel = forum ? tr("Members") : tr("Reddit subscribers");
    var footerNote = forum ? tr("Nothing is sent to the forum.") : tr("Nothing is sent to Reddit.");
    var composer = signedIn()
      ? '<form class="cm-composer" data-cm="inline-post" data-sub="' + esc(name) + '">' +
          face(session().account || {}) +
          '<div class="cm-composer-main">' +
            '<textarea class="cm-composer-area" name="text" placeholder="' + esc(composeLabel) + '" aria-label="' + esc(composeLabel) + '"></textarea>' +
            '<div class="cm-composer-bottom">' +
              '<button type="submit" class="cm-composer-btn">' + esc(tr("Post")) + '</button>' +
            '</div>' +
          '</div>' +
        '</form>'
      : '<div class="cm-footer-note"><p>' + esc(tr("Sign in to post here.")) + '</p></div>';

    var items = (bag && bag.locked) ? [] : feedItems(name, doc);
    var empty = bag && bag.locked
      ? '<div class="empty"><h2>' + esc(tr("Only members can see posts in this community.")) + '</h2></div>'
      : state.filter === "app" && !signedIn()
      ? '<div class="empty"><p>' + esc(tr("Sign in to post here.")) + "</p></div>"
      : (items.length ? "" : '<div class="empty"><h2>' + esc(tr("No posts yet")) + "</h2></div>");

    return head(communityLabel(name), "#/communities", shareBtn) +
      '<section class="cm-hero">' +
        bannerImg +
        '<div class="cm-hero-body">' +
          '<div class="cm-hero-bar">' +
            avatarImg +
            '<div class="cm-hero-actions">' +
              shareBtn +
              '<button class="cm-icon-btn" type="button" data-cm="more" data-sub="' + esc(name) + '" aria-label="' + esc(tr("More")) + '" aria-haspopup="menu">' + svgMore + '</button>' +
              removeBtn +
              joinBtn(name, joined) +
              (signedIn() && joined ? '<button type="button" class="cm-btn-join" data-cm="home-feed" data-sub="' + esc(name) + '" aria-pressed="' + ((bag && bag.showHome === false) ? "false" : "true") + '"><span>' + esc((bag && bag.showHome === false) ? tr("Hidden on Home") : tr("Show in Home")) + '</span></button><button type="button" class="cm-btn-join" data-cm="mute-community" data-sub="' + esc(name) + '"><span>' + esc((bag && bag.muted) ? tr("Unmute community") : tr("Mute community")) + '</span></button>' : "") +
              (owner() ? '<button type="button" class="cm-btn-join" data-cm="visibility" data-sub="' + esc(name) + '" data-vis="' + esc((bag && bag.visibility) || "public") + '"><span>' + esc((bag && bag.visibility) === "private" ? tr("Private community") : (bag && bag.visibility) === "restricted" ? tr("Restricted community") : tr("Public community")) + '</span></button>' : "") +
            '</div>' +
          '</div>' +
          '<h1 class="cm-hero-title">' + esc(communityLabel(name)) + forumBadge(name) + ((typeof window !== "undefined" ? window.ViktorychNick : null) && window.ViktorychNick.button ? window.ViktorychNick.button(forum ? "forum" : "reddit", forum ? name : "r/" + name, forum ? title : "r/" + name) : "") + '</h1>' +
          '<div class="cm-hero-meta">' +
            '<div class="cm-facepile"><span class="cm-face-dot d1"></span><span class="cm-face-dot d2"></span><span class="cm-face-dot d3"></span></div>' +
            '<span><b>' + esc(count(doc.subscribers || (forum ? 0 : 2800000))) + '</b> ' + esc(memberLabel) + '</span>' +
            (host ? '<span class="cm-sep">·</span><a class="cm-forum-link" href="' + esc(sourceUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(host) + ' ' + svgExternal + '</a>' : "") +
            (bag && bag.members ? '<span class="cm-sep">·</span><span><b>' + esc(count(bag.members)) + '</b> ' + esc(tr("ViktorychApp members")) + '</span>' : "") +
          '</div>' +
          (doc.about ? '<p class="cm-hero-about">' + esc(doc.about) + '</p>' : "") +
          rulesAccordion +
        '</div>' +
      '</section>' +
      tabs() +
      chips(name) +
      composer +
      empty +
      items.map(function (item) { return card(name, item); }).join("") +
      '<p class="cm-footer-note">' + esc(footerNote) + '</p>';
  }

  function findReddit(doc, id) {
    var found = null;
    (doc.posts || []).forEach(function (post) {
      if (post.id === id) found = { kind: "post", post: post };
      (post.replies || []).forEach(function (reply) {
        if (reply.id === id) found = { kind: "reply", reply: reply, post: post };
      });
    });
    return found;
  }

  /* Single Thread / Post View (Reddit Comments Tree + X.com Theme) */
  function threadPage(route) {
    var name = nameOf(route.sub);
    var id = decodeURIComponent(route.post || "");
    var doc = cachedDoc(name);
    if (doc) revalidate(name);
    if (!doc) {
      if (!state.loading[name]) {
        state.loading[name] = true;
        Promise.all([
          loadDoc(name).catch(function () { return null; }),
          loadInternal(name).catch(function () { return null; })
        ]).finally(function () {
          state.loading[name] = false;
          render();
        });
      }
      return head(tr("Communities"), "#/communities/" + name) + '<div class="reply-empty">' + esc(tr("Loading")) + "</div>";
    }
    if (doc.missing) {
      return head(communityLabel(name), "#/communities") +
        '<div class="empty"><h2>' + esc(tr("That community wasn't found.")) + '</h2>' +
        '<button class="retry" type="button" data-cm="retry" data-sub="' + esc(name) + '">' + esc(tr("Retry")) + '</button></div>';
    }
    var bag = state.internal[name] || { posts: [], likes: {}, mine: [] };
    var internal = (bag.posts || []).filter(function (post) { return post.id === id; })[0];
    var reddit = findReddit(doc, id);
    var focus = "";
    if (internal && signedIn()) focus = appCard(name, internal, true);
    else if (reddit && reddit.kind === "post") focus = redditCard(name, reddit.post, true);
    else if (reddit && reddit.kind === "reply") {
      focus = '<article class="cm-reddit-comment">' +
        '<div class="cm-comment-gutter"><span class="cm-comment-snoo">' + (isForum(name) ? svgCommunities : svgSnoo) + '</span><span class="cm-comment-line"></span></div>' +
        '<div class="cm-comment-body">' +
          '<div class="cm-comment-byline"><span class="cm-comment-author">' + (isForum(name) ? "" : "u/") + esc(cleanAuthor(reddit.reply.author)) + '</span><span>•</span><span>' + esc(timeAgo((Number(reddit.reply.created) || 0) * 1000)) + '</span></div>' +
          '<div class="cm-comment-text">' + esc(cleanRedditText(reddit.reply.text)) + '</div>' +
        '</div>' +
      '</article>';
    }

    if (!focus) return head(communityLabel(name), "#/communities/" + name) + '<div class="empty"><h2>' + esc(tr("That community wasn't found.")) + "</h2></div>";

    /* A topic thread loads its own comment page; a reply focus reuses whatever
       the topic file already brought in. */
    var isTopic = !!(reddit && reddit.kind === "post" && !(internal && signedIn()));
    var comments = cachedComments(commentKey(name, id));
    if (comments && !comments.missing && comments.at && Date.now() - comments.at > DOC_TTL && !state.commentPromises[commentKey(name, id)]) {
      comments.at = Date.now();
      loadComments(name, id, true).then(function () {
        var now = (location.hash || "").split("?")[0];
        if (now.indexOf("/communities/" + name + "/" + id) >= 0) render();
      });
    }
    var commentsLoading = isTopic && isForum(name) && !comments;
    if (commentsLoading) {
      loadComments(name, id).then(function () {
        var current = (location.hash || "").split("?")[0];
        if (current.indexOf("/communities/" + name + "/" + id) >= 0) render();
      });
    }
    var totalComments = isTopic ? (Number(reddit.post.comments) || 0) : 0;

    var kidItems = repliesFor(name, id, doc);
    var kids = kidItems.map(function (item) {
      if (item.source === "reddit") {
        var replyScore = Number(item.reply.score) || 0;
        var rV = voteState(name, item.reply.id);
        var rTotal = replyScore + (rV.up ? 1 : 0) + (rV.down ? -1 : 0);
        return '<article class="cm-reddit-comment reply-card" data-post="' + esc(item.reply.id) + '">' +
          '<div class="cm-comment-gutter"><span class="cm-comment-snoo">' + (isForum(name) ? svgCommunities : svgSnoo) + '</span><span class="cm-comment-line"></span></div>' +
          '<div class="cm-comment-body">' +
            '<div class="cm-comment-byline"><span class="cm-comment-author">' + (isForum(name) ? "" : "u/") + esc(cleanAuthor(item.reply.author)) + '</span><span>•</span><span>' + esc(timeAgo(item.created)) + '</span></div>' +
            '<div class="cm-comment-text">' + esc(cleanRedditText(item.reply.text)) + '</div>' +
            '<div class="cm-comment-actions">' +
              votePill(name, item.reply.id, rTotal, rV, true) +
              '<button class="cm-reddit-action-btn" type="button" data-cm="focus-reply">' + svgComment + '<span>' + esc(tr("Reply")) + '</span></button>' +
              blockBtn(name, item.reply.id, item.reply.author, "reddit") +
            '</div>' +
          '</div>' +
        '</article>';
      }
      var aAuthor = item.post.author || {};
      var aAuthorHandle = String(aAuthor.handle || "");
      var aV = voteState(name, item.post.id);
      var aBag = state.internal[name] || {};
      var aTotal = (Number((aBag.likes || {})[item.post.id]) || 0) + (aV.down ? -1 : 0);
      return '<article class="cm-reddit-comment reply-card cm-app-reply" data-post="' + esc(item.post.id) + '">' +
        '<div class="cm-comment-gutter">' +
          face(aAuthor) +
          '<span class="cm-comment-line"></span>' +
        '</div>' +
        '<div class="cm-comment-body">' +
          '<div class="cm-comment-byline">' +
            '<span class="cm-app-name">' + esc(aAuthor.displayName || aAuthor.handle || "") + (aAuthor.owner ? " ✓" : "") + '</span>' +
            '<span class="cm-app-handle">@' + esc(aAuthorHandle) + '</span>' +
            '<span>•</span>' +
            '<span class="cm-reddit-time">' + esc(timeAgo(Number(item.post.createdAt) || item.created)) + '</span>' +
            '<span class="cm-app-badge">' + esc(tr("Only on ViktorychApp")) + '</span>' +
          '</div>' +
          '<div class="cm-comment-text">' + esc(item.post.body || "") + '</div>' +
          '<div class="cm-comment-actions">' +
            votePill(name, item.post.id, aTotal, aV, true) +
            '<button class="cm-reddit-action-btn" type="button" data-cm="focus-reply">' + svgComment + '<span>' + esc(tr("Reply")) + '</span></button>' +
            '<button class="cm-reddit-action-btn" type="button" data-cm="share" data-href="#/communities/' + encodeURIComponent(name) + '/' + encodeURIComponent(id) + '">' + svgShare + '</button>' +
            (item.post.mine || owner() ? '<button class="cm-reddit-action-btn del" type="button" data-cm="delete" data-id="' + esc(item.post.id) + '" data-sub="' + esc(name) + '">' + svgTrash + '</button>' : blockBtn(name, item.post.id, aAuthorHandle, "app")) +
          '</div>' +
        '</div>' +
      '</article>';
    }).join("");

    var box = signedIn()
      ? '<form class="cm-composer" data-cm="reply" data-sub="' + esc(name) + '" data-parent="' + esc(id) + '">' +
          face(session().account || {}) +
          '<div class="cm-composer-main">' +
            '<textarea class="cm-composer-area" name="text" aria-label="' + esc(tr("Post your reply")) + '" placeholder="' + esc(tr("Post your reply")) + '"></textarea>' +
            '<div class="cm-composer-bottom">' +
              '<button type="submit" class="cm-composer-btn">' + esc(tr("Reply")) + '</button>' +
            '</div>' +
          '</div>' +
        '</form>'
      : '<div class="cm-footer-note"><p>' + esc(tr("Sign in to post here.")) + '</p></div>';

    var headCount = totalComments;
    if (isTopic && comments && comments.complete && !kidItems.length) headCount = 0;
    var commentsHead = '<div class="cm-thread-replies-head">' + esc(tr("Comments")) +
      (headCount ? ' <span class="cm-thread-count">' + esc(count(headCount)) + '</span>' : "") + '</div>';
    var commentsNote = "";
    var commentsBody = kids;
    if (isTopic && commentsLoading) {
      commentsBody = '<div class="reply-empty">' + esc(tr("Loading comments…")) + '</div>';
    } else if (isTopic && comments && comments.missing && !kidItems.length) {
      commentsBody = '<div class="reply-empty"><p>' + esc(tr("Couldn't load the comments.")) + '</p>' +
        '<button class="retry" type="button" data-cm="retry-comments" data-sub="' + esc(name) + '" data-post="' + esc(id) + '">' + esc(tr("Retry")) + '</button></div>';
    } else if (isTopic && !kidItems.length) {
      commentsBody = '<div class="reply-empty">' + esc(tr("No comments yet.")) + '</div>';
    } else if (isTopic && comments && comments.complete === false && kidItems.length) {
      var shownTotal = Number(comments.total) || totalComments || kidItems.length;
      commentsNote = '<p class="cm-thread-note">' + esc(tr("Showing {shown} of {total}", { shown: kidItems.length, total: shownTotal })) + '</p>';
    }

    return head(communityLabel(name), "#/communities/" + name) +
      focus +
      chips(name) +
      commentsHead +
      commentsNote +
      commentsBody +
      box;
  }

  function page(route) {
    if (nzlayActive(route)) return window.ViktorychNzlayForum.page(route, { head: head, toast: toast, requestRender: render });
    if (route.post) return threadPage(route);
    if (route.sub) return communityPage(route);
    return listPage();
  }

  function takeCompose(text) {
    var hash = (location.hash || "").split("?")[0];
    var parts = hash.replace(/^#\/?/, "").split("/");
    if (parts[0] !== "communities" || !nameOf(parts[1]) || parts[2]) return false;
    if (!signedIn()) {
      toast(tr("Sign in to post here."));
      return true;
    }
    var body = String(text || "").trim();
    if (!body) return true;
    call("/v1/communities/" + encodeURIComponent(nameOf(parts[1])) + "/posts", { method: "POST", body: { text: body } }).then(function () {
      delete state.internal[nameOf(parts[1])];
      loadInternal(nameOf(parts[1])).then(render);
    });
    return true;
  }

  /* Custom tabs. Each tab is one feed that mixes chosen communities
     (subreddits and mirrored forums) with chosen profiles from any platform
     the app follows. Tabs live in this user's settings: on this device, then
     in the private account sync. Nothing is written to the repo or to a
     public endpoint, and nothing polls: a tab reads what is cached and asks
     the existing feed loaders for fresh posts at most once every few minutes
     while it is on screen. */
  var TAB_MAX = 12;
  var SOURCE_MAX = 50;
  var TABS_KEY = "va_cm_tabs";
  var svgMore = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 12c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm9 2c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/></svg>';
  var svgTick = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 20c-.264 0-.52-.104-.707-.293l-4.785-4.785 1.414-1.414L9 17.586 19.072 7.5l1.42 1.416L9.708 19.7c-.188.19-.442.3-.708.3z"/></svg>';
  var svgPin = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17 9.76V4.5C17 3.12 15.88 2 14.5 2h-5C8.12 2 7 3.12 7 4.5v5.26L3.88 16.1l.9 1.4H11v4.5h2v-4.5h6.22l.9-1.4L17 9.76zM6.86 15.5L9 11.24V4.5c0-.28.22-.5.5-.5h5c.28 0 .5.22.5.5v6.74l2.14 4.26H6.86z"/></svg>';

  function hooks() {
    return window.ViktorychCommunities || {};
  }
  function cleanSource(value) {
    var text = String(value == null ? "" : value).replace(/[\u0000-\u001F\u007F]/g, "").trim();
    if (text.indexOf("c:") === 0) {
      var name = nameOf(text.slice(2));
      return name ? "c:" + name : "";
    }
    if (text.indexOf("p:") === 0 && text.length > 2 && text.length <= 120) return text;
    return "";
  }
  function cleanTabs(bag) {
    var list = bag && Array.isArray(bag.tabs) ? bag.tabs : [];
    var seen = {};
    var tabs = [];
    list.forEach(function (tab) {
      if (!tab || typeof tab !== "object" || tabs.length >= TAB_MAX) return;
      var id = String(tab.id || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
      var name = String(tab.name || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 40);
      if (!id || !name || seen[id]) return;
      seen[id] = true;
      var sources = [];
      (Array.isArray(tab.sources) ? tab.sources : []).forEach(function (src) {
        var clean = cleanSource(src);
        if (clean && sources.indexOf(clean) < 0 && sources.length < SOURCE_MAX) sources.push(clean);
      });
      tabs.push({ id: id, name: name, sources: sources, home: tab.home === true });
    });
    return { at: Number(bag && bag.at) || 0, tabs: tabs };
  }
  function readTabs() {
    var h = hooks();
    var bag = h.readTabs ? h.readTabs() : null;
    if (!h.readTabs) {
      try { bag = JSON.parse(localStorage.getItem(TABS_KEY) || "null"); } catch (_) { bag = null; }
    }
    return cleanTabs(bag).tabs;
  }
  function writeTabs(tabs) {
    var bag = cleanTabs({ at: Date.now(), tabs: tabs });
    var h = hooks();
    if (h.writeTabs) h.writeTabs(bag);
    else {
      try { localStorage.setItem(TABS_KEY, JSON.stringify(bag)); } catch (_) {}
    }
    render();
    return bag.tabs;
  }
  function tabById(id) {
    var tabs = readTabs();
    for (var i = 0; i < tabs.length; i++) if (tabs[i].id === id) return tabs[i];
    return null;
  }
  function newTabId() {
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function currentTab() {
    return state.hubTab.indexOf("tab:") === 0 ? tabById(state.hubTab.slice(4)) : null;
  }
  function profileInfo(id) {
    var h = hooks();
    var info = h.profileInfo ? h.profileInfo(id) : null;
    if (info) return info;
    var cut = id.indexOf(":");
    var handle = cut > 0 ? id.slice(cut + 1) : id;
    return { id: id, name: handle, handle: handle, platform: cut > 0 ? id.slice(0, cut) : "", avatar: "" };
  }
  function sourceLabel(src) {
    if (src.indexOf("c:") === 0) return communityLabel(src.slice(2));
    var info = profileInfo(src.slice(2));
    return info.name || info.handle || src.slice(2);
  }
  function sourceSub(src) {
    if (src.indexOf("c:") === 0) return isForum(src.slice(2)) ? tr("Forum") : tr("Reddit");
    var info = profileInfo(src.slice(2));
    var handle = info.handle ? (info.platform === "reddit" ? "u/" : "@") + info.handle : "";
    return [info.platformLabel || "", handle].filter(Boolean).join(" · ");
  }
  function sourceIcon(src) {
    if (src.indexOf("c:") === 0) {
      var row = indexRow(src.slice(2)) || {};
      return row.icon ? '<img class="cm-src-ava" alt="" loading="lazy" decoding="async" src="' + esc(row.icon) + '">' : '<span class="cm-src-ava cm-src-ico">' + (isForum(src.slice(2)) ? svgCommunities : svgSnoo) + "</span>";
    }
    var info = profileInfo(src.slice(2));
    if (info.avatar && /^https:\/\//.test(info.avatar)) return '<img class="cm-src-ava round" alt="" loading="lazy" decoding="async" src="' + esc(info.avatar) + '">';
    return '<span class="cm-src-ava round cm-src-ico">' + esc(String(info.name || info.handle || "?").slice(0, 1).toUpperCase()) + "</span>";
  }

  /* One feed for a tab: community posts from the mirrored files plus posts
     the app already has for the chosen profiles, newest first. */
  function tabFeedItems(tab) {
    var items = [];
    var waiting = false;
    var people = [];
    var names = [];
    tab.sources.forEach(function (src) {
      if (src.indexOf("c:") === 0) names.push(src.slice(2));
      else people.push(src.slice(2));
    });
    names.slice(0, 16).forEach(function (name) {
      if (cachedDoc(name)) revalidate(name);
      if (!state.docs[name]) {
        waiting = true;
        if (!state.loading[name]) {
          state.loading[name] = true;
          Promise.all([
            loadDoc(name).catch(function () { return null; }),
            loadInternal(name).catch(function () { return null; })
          ]).finally(function () { state.loading[name] = false; render(); });
        }
        return;
      }
      var doc = state.docs[name];
      if (doc.missing) return;
      var bag = state.internal[name];
      if (bag && bag.locked) return;
      redditPosts(doc, name).forEach(function (post) {
        var item = { source: "reddit", community: name, id: post.id, created: (Number(post.created) || 0) * 1000, post: post };
        items.push({ created: item.created, item: item });
      });
      internalPosts(name).filter(function (post) { return !post.parentId; }).forEach(function (post) {
        var item = { source: "app", community: name, id: post.id, created: Number(post.createdAt) || 0, post: post };
        items.push({ created: item.created, item: item });
      });
    });
    var h = hooks();
    if (people.length) {
      state.profileLoads = state.profileLoads || {};
      var key = tab.id + "|" + people.join(",");
      if (h.loadProfiles && (!state.profileLoads[key] || Date.now() - state.profileLoads[key] > INDEX_TTL)) {
        state.profileLoads[key] = Date.now();
        state.profileWaiting = state.profileWaiting || {};
        state.profileWaiting[key] = true;
        Promise.resolve(h.loadProfiles(tab.id, people)).catch(function () {}).then(function () {
          delete state.profileWaiting[key];
          render();
        });
      }
      if (state.profileWaiting && state.profileWaiting[key]) waiting = true;
      if (h.profileItems) {
        (h.profileItems(people) || []).forEach(function (row) {
          if (row && row.html) items.push({ created: Number(row.created) || 0, html: row.html });
        });
      }
    }
    items.sort(function (a, b) { return b.created - a.created; });
    return { items: items.slice(0, 60), waiting: waiting };
  }
  function tabFeedHtml(tab, home) {
    if (!tab.sources.length) {
      return '<div class="empty cm-tab-empty"><h2>' + esc(tr("Nothing in this tab yet")) + "</h2><p>" + esc(tr("Add communities and people to see their posts here.")) + "</p>" +
        '<button class="cm-btn-join cm-tab-cta" type="button" data-cm="tab-edit" data-id="' + esc(tab.id) + '"><span>' + esc(tr("Add sources")) + "</span></button></div>";
    }
    var got = tabFeedItems(tab);
    if (!got.items.length) {
      return got.waiting ? '<div class="reply-empty">' + esc(tr("Loading")) + "</div>" : '<div class="empty"><h2>' + esc(tr("No posts in this tab")) + "</h2></div>";
    }
    return '<div class="cm-x-feed cm-tab-feed' + (home ? " cm-tab-home" : "") + '" data-tab-feed="' + esc(tab.id) + '">' + got.items.map(function (row) {
      return row.html || homeCard(row.item);
    }).join("") + "</div>";
  }
  function tabTools(tab) {
    var pin = tab.home
      ? '<button class="cm-btn-join cm-tab-pin on" type="button" data-cm="tab-pin" data-id="' + esc(tab.id) + '" aria-pressed="true">' + svgPin + "<span>" + esc(tr("Pinned to Home")) + "</span></button>"
      : '<button class="cm-btn-join cm-tab-pin" type="button" data-cm="tab-pin" data-id="' + esc(tab.id) + '" aria-pressed="false">' + svgPin + "<span>" + esc(tr("Pin to Home")) + "</span></button>";
    var n = tab.sources.length;
    return '<div class="cm-tab-tools"><span class="cm-tab-count">' + esc(tr("Sources: {n}", { n: n })) + "</span>" + pin +
      '<button class="cm-btn-join" type="button" data-cm="tab-edit" data-id="' + esc(tab.id) + '"><span>' + esc(tr("Edit tab")) + "</span></button></div>";
  }
  function customTabPage(tab) {
    return tabTools(tab) + tabFeedHtml(tab, false);
  }

  /* The editor and the "Add to tab" sheet sit on top of whatever page is open
     (a community, a profile, Home), so they draw themselves instead of going
     through the page render. */
  var editor = null;
  var assign = null;
  function layer(id) {
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      document.body.appendChild(el);
    }
    return el;
  }
  function dropLayer(id) {
    var el = document.getElementById(id);
    if (el) el.remove();
  }
  function openEditor(id, seed) {
    var tabs = readTabs();
    var tab = id ? tabById(id) : null;
    editor = {
      id: tab ? tab.id : "",
      name: tab ? tab.name : "",
      home: tab ? tab.home : false,
      sources: tab ? tab.sources.slice() : (seed || []).map(cleanSource).filter(Boolean),
      order: tabs.map(function (item) { return item.id; }),
      q: ""
    };
    if (!state.index) loadIndex().then(function () { if (editor) paintEditor(); });
    paintEditor();
    var name = document.getElementById("cm-ed-name");
    if (name && !editor.id) name.focus();
  }
  function closeEditor() {
    editor = null;
    dropLayer("cm-tab-editor");
  }
  function editorResults() {
    var q = String(editor.q || "").trim().toLowerCase();
    var out = [];
    var rows = (state.index && state.index.communities) || [];
    var pickRows = q ? rows.filter(function (row) {
      return [row.name, row.title, row.about].some(function (v) { return String(v || "").toLowerCase().indexOf(q.replace(/^r\//, "")) >= 0; });
    }) : rows.slice().sort(function (a, b) { return (Number(b.subscribers) || 0) - (Number(a.subscribers) || 0); });
    pickRows.slice(0, q ? 20 : 8).forEach(function (row) {
      var src = cleanSource("c:" + row.name);
      if (src) out.push(src);
    });
    var h = hooks();
    if (q && h.profiles) {
      (h.profiles(q) || []).slice(0, 30).forEach(function (row) {
        var src = cleanSource("p:" + (row && row.id));
        if (src && out.indexOf(src) < 0) out.push(src);
      });
    }
    var user = q.match(/^(?:https?:\/\/(?:www\.|old\.)?reddit\.com)?\/?u(?:ser)?\/([a-z0-9_-]{3,20})\/?$/i);
    if (user) {
      var redditUser = "p:reddit:" + user[1];
      if (out.indexOf(redditUser) < 0) out.push(redditUser);
    }
    return out;
  }
  function sourceRow(src, on) {
    return '<div class="cm-src-row">' + sourceIcon(src) +
      '<span class="cm-src-copy"><b>' + esc(sourceLabel(src)) + "</b><small>" + esc(sourceSub(src)) + "</small></span>" +
      '<button class="cm-src-btn' + (on ? " on" : "") + '" type="button" data-cm="ed-src" data-src="' + esc(src) + '">' + esc(on ? tr("Remove") : tr("Add")) + "</button></div>";
  }
  function resultsHtml() {
    var list = editorResults().filter(function (src) { return editor.sources.indexOf(src) < 0; });
    if (!list.length) return String(editor.q || "").trim() ? '<p class="cm-ed-note">' + esc(tr("No results")) + "</p>" : "";
    return list.map(function (src) { return sourceRow(src, false); }).join("");
  }
  function paintEditor() {
    if (!editor) return closeEditor();
    var root = layer("cm-tab-editor");
    root.className = "cm-layer";
    var tabs = readTabs();
    var names = {};
    tabs.forEach(function (tab) { names[tab.id] = tab.name; });
    var order = editor.order.filter(function (id) { return names[id]; });
    var orderHtml = order.length > 1 ? '<h3>' + esc(tr("Order")) + "</h3>" + order.map(function (id, i) {
      return '<div class="cm-order-row"><span class="cm-order-name">' + esc(id === editor.id ? (editor.name || names[id]) : names[id]) + "</span>" +
        '<button class="cm-icon-btn" type="button" data-cm="ed-move" data-id="' + esc(id) + '" data-dir="-1" aria-label="' + esc(tr("Move left")) + '"' + (i === 0 ? " disabled" : "") + ">↑</button>" +
        '<button class="cm-icon-btn" type="button" data-cm="ed-move" data-id="' + esc(id) + '" data-dir="1" aria-label="' + esc(tr("Move right")) + '"' + (i === order.length - 1 ? " disabled" : "") + ">↓</button></div>";
    }).join("") : "";
    var title = editor.id ? tr("Edit tab") : tr("New tab");
    root.innerHTML = '<div class="cm-sheet-back" data-cm="ed-close"><div class="cm-sheet cm-tab-editor" role="dialog" aria-modal="true" aria-label="' + esc(title) + '" data-cm="ed-stop">' +
      '<div class="cm-sheet-head"><button class="cm-icon-btn" type="button" data-cm="ed-close" aria-label="' + esc(tr("Close")) + '">✕</button><h2>' + esc(title) + "</h2>" +
        '<button class="cm-ed-save" type="button" data-cm="ed-save"' + (String(editor.name || "").trim() ? "" : " disabled") + ">" + esc(tr("Save")) + "</button></div>" +
      '<div class="cm-sheet-body">' +
        '<label class="cm-ed-field"><span>' + esc(tr("Name")) + '</span><input id="cm-ed-name" data-cm="ed-name" maxlength="40" value="' + esc(editor.name) + '" autocomplete="off"></label>' +
        '<button class="cm-switch' + (editor.home ? " on" : "") + '" type="button" role="switch" aria-checked="' + (editor.home ? "true" : "false") + '" data-cm="ed-home"><span>' + esc(tr("Pin to Home")) + "<small>" + esc(tr("Show this tab next to For you and Following.")) + "</small></span><i></i></button>" +
        "<h3>" + esc(tr("In this tab")) + "</h3>" +
        (editor.sources.length ? editor.sources.map(function (src) { return sourceRow(src, true); }).join("") : '<p class="cm-ed-note">' + esc(tr("Search to add communities and people.")) + "</p>") +
        "<h3>" + esc(tr("Add sources")) + "</h3>" +
        '<input id="cm-ed-q" class="cm-ed-q" data-cm="ed-q" type="search" placeholder="' + esc(tr("Search communities and people")) + '" aria-label="' + esc(tr("Search communities and people")) + '" value="' + esc(editor.q) + '" autocomplete="off">' +
        '<div id="cm-ed-results">' + resultsHtml() + "</div>" +
        orderHtml +
        (editor.id ? '<button class="cm-ed-delete" type="button" data-cm="ed-delete">' + esc(tr("Delete tab")) + "</button>" : "") +
      "</div></div></div>";
  }
  function saveEditor() {
    if (!editor) return;
    var name = String(editor.name || "").trim().slice(0, 40);
    if (!name) return;
    var tabs = readTabs();
    var id = editor.id || newTabId();
    var row = { id: id, name: name, sources: editor.sources.slice(), home: !!editor.home };
    var map = {};
    tabs.forEach(function (tab) { map[tab.id] = tab; });
    map[id] = row;
    var next = [];
    editor.order.forEach(function (key) { if (map[key]) { next.push(map[key]); delete map[key]; } });
    Object.keys(map).forEach(function (key) { next.push(map[key]); });
    if (!editor.id && tabs.length >= TAB_MAX) { toast(tr("You can have up to {n} tabs.", { n: TAB_MAX })); return; }
    writeTabs(next);
    var fresh = !editor.id;
    closeEditor();
    if (fresh && /^#\/communities\/?$/.test((location.hash || "").split("?")[0])) state.hubTab = "tab:" + id;
    toast(tr("Tab saved"));
    render();
  }
  function deleteTab(id) {
    var tabs = readTabs().filter(function (tab) { return tab.id !== id; });
    writeTabs(tabs);
    if (state.hubTab === "tab:" + id) state.hubTab = "home";
    var h = hooks();
    if (h.tabGone) h.tabGone(id);
    render();
  }
  function openAssign(src, label) {
    var clean = cleanSource(src);
    if (!clean) return;
    assign = { src: clean, label: String(label || "") };
    if (!state.index) loadIndex().then(function () { if (assign) paintAssign(); });
    paintAssign();
  }
  function closeAssign() {
    assign = null;
    dropLayer("cm-tab-assign");
  }
  function paintAssign() {
    if (!assign) return closeAssign();
    var root = layer("cm-tab-assign");
    root.className = "cm-layer";
    var tabs = readTabs();
    var rows = tabs.map(function (tab) {
      var on = tab.sources.indexOf(assign.src) >= 0;
      return '<button class="cm-assign-row" type="button" role="menuitemcheckbox" aria-checked="' + (on ? "true" : "false") + '" data-cm="as-toggle" data-id="' + esc(tab.id) + '"><span>' + esc(tab.name) + '</span><i class="cm-assign-mark">' + (on ? svgTick : "") + "</i></button>";
    }).join("");
    var label = assign.label || sourceLabel(assign.src);
    root.innerHTML = '<div class="cm-sheet-back cm-assign-back" data-cm="as-close"><div class="cm-sheet cm-assign" role="menu" aria-label="' + esc(tr("Add to tab")) + '" data-cm="ed-stop">' +
      '<div class="cm-assign-head"><b>' + esc(tr("Add to tab")) + "</b><small>" + esc(label) + "</small></div>" +
      (rows || '<p class="cm-ed-note">' + esc(tr("Make a tab to group communities and people in one feed.")) + "</p>") +
      '<button class="cm-assign-row cm-assign-new" type="button" data-cm="as-new">' + svgPlus + "<span>" + esc(tr("New tab")) + "</span></button>" +
      "</div></div>";
  }
  function editorInput(el) {
    if (!editor) return false;
    if (el.dataset.cm === "ed-name") {
      editor.name = el.value;
      var save = document.querySelector("#cm-tab-editor .cm-ed-save");
      if (save) save.disabled = !String(editor.name || "").trim();
      return true;
    }
    if (el.dataset.cm === "ed-q") {
      editor.q = el.value;
      var box = document.getElementById("cm-ed-results");
      if (box) box.innerHTML = resultsHtml();
      return true;
    }
    return false;
  }
  function tabClick(act, el) {
    if (act === "tab-new") { openEditor("", []); return true; }
    if (act === "tab-edit") { openEditor(el.dataset.id || "", []); return true; }
    if (act === "tab-pin") {
      var tabs = readTabs();
      tabs.forEach(function (tab) { if (tab.id === el.dataset.id) tab.home = !tab.home; });
      writeTabs(tabs);
      var pinned = tabById(el.dataset.id);
      toast(pinned && pinned.home ? tr("Pinned to Home") : tr("Unpinned from Home"));
      return true;
    }
    if (act === "more") { openAssign("c:" + (el.dataset.sub || ""), communityLabel(el.dataset.sub || "")); return true; }
    if (act === "ed-stop") return true;
    if (act === "ed-close") { closeEditor(); return true; }
    if (act === "ed-save") { saveEditor(); return true; }
    if (act === "ed-home") { if (editor) { editor.home = !editor.home; paintEditor(); } return true; }
    if (act === "ed-src") {
      if (!editor) return true;
      var src = el.dataset.src || "";
      var at = editor.sources.indexOf(src);
      if (at >= 0) editor.sources.splice(at, 1);
      else if (editor.sources.length < SOURCE_MAX) editor.sources.push(src);
      paintEditor();
      return true;
    }
    if (act === "ed-move") {
      if (!editor) return true;
      var names = {};
      readTabs().forEach(function (tab) { names[tab.id] = true; });
      var order = editor.order.filter(function (id) { return names[id]; });
      var i = order.indexOf(el.dataset.id);
      var j = i + (Number(el.dataset.dir) || 0);
      if (i >= 0 && j >= 0 && j < order.length) {
        order.splice(j, 0, order.splice(i, 1)[0]);
        editor.order = order;
      }
      paintEditor();
      return true;
    }
    if (act === "ed-delete") {
      if (!editor || !editor.id) return true;
      var askText = tr("Delete this tab? The communities and people in it stay as they are.");
      if (window.confirm && !window.confirm(askText)) return true;
      var gone = editor.id;
      closeEditor();
      deleteTab(gone);
      return true;
    }
    if (act === "as-close") { closeAssign(); return true; }
    if (act === "as-toggle") {
      if (!assign) return true;
      var list = readTabs();
      list.forEach(function (tab) {
        if (tab.id !== el.dataset.id) return;
        var k = tab.sources.indexOf(assign.src);
        if (k >= 0) tab.sources.splice(k, 1);
        else if (tab.sources.length < SOURCE_MAX) tab.sources.push(assign.src);
      });
      writeTabs(list);
      paintAssign();
      return true;
    }
    if (act === "as-new") {
      var seed = assign ? [assign.src] : [];
      closeAssign();
      openEditor("", seed);
      return true;
    }
    return false;
  }
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (editor) { closeEditor(); event.stopPropagation(); }
    else if (assign) { closeAssign(); event.stopPropagation(); }
  }, true);


  /* Global Click & Submit Event Handlers */
  document.addEventListener("click", function (event) {
    var el = event.target.closest("[data-cm]");
    if (!el) return;
    var act = el.dataset.cm;
    if (tabClick(act, el)) {
      if (act !== "ed-stop") event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (act === "picker") {
      state.hubTab = "home";
      state.picker = !state.picker;
      render();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (act === "category") {
      state.category = el.dataset.cat || "all";
      render();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (act === "toggle-search") {
      state.showSearch = !(state.showSearch || state.search);
      if (!state.showSearch) state.search = "";
      render();
      if (state.showSearch) {
        var box = document.querySelector("[data-cm='search-input']");
        if (box) box.focus();
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (act === "cm-panel" && String(el.dataset.panel || "").indexOf("folder:") === 0) state.panelFrom = state.panel || "row";
    if (panelClick(act, el)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (act === "hub-tab") {
      state.picker = false;
      state.panel = "";
      state.hubTab = el.dataset.hub || "home";
      render();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (act === "filter") {
      state.filter = el.dataset.filter || "all";
      render();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (act === "tab") {
      state.tab = el.dataset.tab || "top";
      render();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (act === "toggle-add") {
      state.showAdd = !state.showAdd;
      render();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (act === "clear-search") {
      state.search = "";
      render();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (act === "share") {
      event.preventDefault();
      event.stopPropagation();
      var url = el.dataset.href ? (location.origin + location.pathname + el.dataset.href) : location.href;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { toast(tr("Copied to clipboard")); });
      } else {
        toast(tr("Copied to clipboard"));
      }
      return;
    }
    if (act === "downvote") {
      event.preventDefault();
      event.stopPropagation();
      if (!signedIn()) { toast(tr("Sign in to post here.")); return; }
      var id = el.dataset.id;
      var sub = el.dataset.sub || currentSub();
      state.downvotes = state.downvotes || {};
      var wasDown = !!state.downvotes[id];
      var bag = state.internal[sub] || {};
      var wasUp = (bag.mine || []).indexOf(id) >= 0;
      if (wasUp) {
        call("/v1/communities/" + encodeURIComponent(sub) + "/likes", { method: "DELETE", body: { itemId: id } }).then(function () {
          delete state.internal[sub];
          loadInternal(sub).then(render);
        });
      }
      if (wasDown) {
        delete state.downvotes[id];
      } else {
        state.downvotes[id] = true;
      }
      setDownvotes(state.downvotes);
      render();
      return;
    }
    if (act === "block-menu") {
      event.preventDefault();
      event.stopPropagation();
      if (window.ViktorychCommunities && window.ViktorychCommunities.blockMenu) {
        window.ViktorychCommunities.blockMenu({ id: el.dataset.id || "", handle: el.dataset.author || "", platform: el.dataset.platform || "reddit", community: el.dataset.sub || "", comment: !!el.closest(".cm-reddit-comment") });
      }
      return;
    }
    if (act === "focus-reply") {
      event.preventDefault();
      event.stopPropagation();
      var area = document.querySelector(".cm-composer-area");
      if (area) { area.focus(); area.scrollIntoView({ behavior: "smooth" }); }
      return;
    }
    if (act === "like") {
      event.preventDefault();
      event.stopPropagation();
      if (!signedIn()) { toast(tr("Sign in to post here.")); return; }
      var id = el.dataset.id;
      var sub = el.dataset.sub || currentSub();
      if (state.downvotes && state.downvotes[id]) {
        delete state.downvotes[id];
        setDownvotes(state.downvotes);
      }
      var bag = state.internal[sub] || {};
      var on = (bag.mine || []).indexOf(id) >= 0;
      call("/v1/communities/" + encodeURIComponent(sub) + "/likes", { method: on ? "DELETE" : "POST", body: { itemId: id } }).then(function () {
        delete state.internal[sub];
        loadInternal(sub).then(render);
      });
      return;
    }
    if (act === "delete") {
      event.preventDefault();
      event.stopPropagation();
      call("/v1/communities/" + encodeURIComponent(el.dataset.sub) + "/posts/" + encodeURIComponent(el.dataset.id), { method: "DELETE" }).then(function () {
        delete state.internal[el.dataset.sub];
        loadInternal(el.dataset.sub).then(render);
      });
      return;
    }
    if (act === "retry-comments") {
      event.preventDefault();
      event.stopPropagation();
      var cSub = el.dataset.sub;
      var cPost = el.dataset.post;
      if (cSub && cPost) {
        delete state.comments[commentKey(cSub, cPost)];
        loadComments(cSub, cPost, true).finally(render);
      }
      return;
    }
    if (act === "retry") {
      event.preventDefault();
      event.stopPropagation();
      var subRetry = el.dataset.sub;
      if (subRetry) {
        delete state.docs[subRetry];
        state.loading[subRetry] = false;
        loadDoc(subRetry).finally(render);
      } else {
        state.index = null;
        loadIndex().finally(render);
      }
      return;
    }
    if (act === "home-feed" || act === "mute-community") {
      event.preventDefault();
      event.stopPropagation();
      if (!signedIn()) { toast(tr("Sign in to post here.")); return; }
      var prefName = el.dataset.sub;
      var prefBag = state.internal[prefName] || {};
      var prefBody = act === "mute-community" ? { muted: !prefBag.muted } : { showHome: prefBag.showHome === false };
      call("/v1/communities/" + encodeURIComponent(prefName) + "/feed", { method: "POST", body: prefBody }).then(function () {
        delete state.internal[prefName];
        loadInternal(prefName).then(render);
      });
      return;
    }
    if (act === "visibility") {
      event.preventDefault();
      event.stopPropagation();
      var visName = el.dataset.sub;
      var order = ["public", "restricted", "private"];
      var current = el.dataset.vis || "public";
      var nextVis = order[(order.indexOf(current) + 1) % order.length];
      call("/v1/communities/" + encodeURIComponent(visName) + "/visibility", { method: "POST", body: { visibility: nextVis } }).then(function () {
        delete state.internal[visName];
        loadInternal(visName).then(render);
      });
      return;
    }
    if (act === "join") {
      event.preventDefault();
      event.stopPropagation();
      if (!signedIn()) { toast(tr("Sign in to post here.")); return; }
      var subName = el.dataset.sub;
      var joined = state.internal[subName] && state.internal[subName].joined;
      call("/v1/communities/" + encodeURIComponent(subName) + "/join", { method: joined ? "DELETE" : "POST" }).then(function () {
        delete state.internal[subName];
        loadInternal(subName).then(render);
      });
      return;
    }
    if (act === "remove") {
      event.preventDefault();
      event.stopPropagation();
      call("/v1/owner/communities/" + encodeURIComponent(el.dataset.sub), { method: "DELETE" }).then(function () { toast(tr("Removed")); });
    }
  }, true);

  document.addEventListener("change", function (event) {
    var pick = event.target.closest("[data-cm='move-folder']");
    if (!pick) return;
    moveToFolder(pick.dataset.sub, pick.value);
  }, true);

  document.addEventListener("input", function (event) {
    var field = event.target.closest("[data-cm='ed-name'], [data-cm='ed-q']");
    if (field) {
      editorInput(field);
      event.stopPropagation();
      return;
    }
    var el = event.target.closest("[data-cm='search-input']");
    if (!el) return;
    state.search = el.value;
    var container = document.querySelector(".cm-card-grid");
    var clearBtn = document.querySelector(".cm-search-clear");
    if (clearBtn) clearBtn.hidden = !state.search;
    render();
  }, true);

  document.addEventListener("submit", function (event) {
    var form = event.target.closest("[data-cm]");
    if (!form) return;
    event.preventDefault();
    event.stopPropagation();

    if (form.dataset.cm === "folder-save") {
      saveFolderForm(form);
      return;
    }
    if (form.dataset.cm === "add") {
      var input = form.querySelector("input");
      var name = nameOf(input && input.value);
      if (!name) { toast(tr("That community wasn't found.")); return; }
      if (!owner()) {
        if (!asking()) return;
        window.FeedRequests.submit(name, { kind: "community" }).then(function (stateNow) {
          if (stateNow) { state.showAdd = false; render(); }
        });
        return;
      }
      call("/v1/owner/communities", { method: "POST", body: { name: name } }).then(function (body) {
        if (!body || !body.community) { toast(tr("Couldn't post.")); return; }
        toast(tr("New posts show up after the next sync."));
        state.showAdd = false;
        render();
      });
      return;
    }
    if (form.dataset.cm === "inline-post") {
      var area = form.querySelector("textarea");
      var text = area ? area.value.trim() : "";
      if (!text) return;
      var sub = form.dataset.sub;
      call("/v1/communities/" + encodeURIComponent(sub) + "/posts", { method: "POST", body: { text: text } }).then(function (body) {
        if (!body || !body.post) { toast(tr("Couldn't post.")); return; }
        area.value = "";
        delete state.internal[sub];
        loadInternal(sub).then(render);
      });
      return;
    }
    if (form.dataset.cm === "reply") {
      var replyArea = form.querySelector("textarea");
      var replyText = replyArea ? replyArea.value.trim() : "";
      if (!replyText) return;
      call("/v1/communities/" + encodeURIComponent(form.dataset.sub) + "/posts", {
        method: "POST",
        body: { text: replyText, parentId: form.dataset.parent }
      }).then(function (body) {
        if (!body || !body.post) { toast(tr("Couldn't post.")); return; }
        replyArea.value = "";
        delete state.internal[form.dataset.sub];
        loadInternal(form.dataset.sub).then(render);
      });
    }
  }, true);

  function pullNotes() {
    if (!signedIn()) return Promise.resolve();
    return call("/v1/communities/notes").then(function (body) {
      var notes = body && body.notes;
      if (!notes || !notes.length) return;
      notes.forEach(note);
      call("/v1/communities/notes/seen", { method: "POST", body: { ids: notes.map(function (item) { return item.id; }) } });
    });
  }

  document.addEventListener("error", function (event) {
    var el = event.target;
    if (!el || !el.getAttribute) return;
    var next = el.getAttribute("data-fallback");
    if (!next) return;
    el.removeAttribute("data-fallback");
    el.src = next;
  }, true);

  function rememberCommunities() {
    var local = window.ViktorychLocal;
    if (!local || !local.saveDoc) return;
    var rows = ((state.index && state.index.communities) || []).slice(0, 40).map(function (row) {
      return { name: row.name || "", title: row.title || row.name || "" };
    });
    if (rows.length) local.saveDoc("feeds", "communities", { communities: rows });
    Object.keys(state.docs || {}).forEach(function (name) {
      var doc = state.docs[name];
      if (!doc || !Array.isArray(doc.posts)) return;
      var items = doc.posts.map(function (post) {
        var created = Number(post && post.created) || 0;
        return {
          id: String((post && post.id) || ""),
          platform: "reddit",
          date: created ? new Date(created * 1000).toISOString() : "",
          text: (post && (post.title || post.text)) || ""
        };
      }).filter(function (post) { return post.id; });
      var ordered = local.orderPosts && window.FeedOrder ? local.orderPosts(items, window.FeedOrder.compare, window.FeedOrder.key) : items;
      local.saveDoc("feeds", "community:" + name, { tab: "community:" + name, order: "utc", posts: ordered.slice(0, 24) });
    });
  }

  window.ViktorychCommunities = {
    page: page,
    takeCompose: takeCompose,
    label: communityLabel,
    pullNotes: pullNotes,
    invalidate: function (name) {
      if (!name) return;
      delete state.internal[name];
      if (currentSub() === name) loadInternal(name).then(function () {
        if (window.ViktorychCommunities.requestRender) window.ViktorychCommunities.requestRender();
      });
    },
    requestRender: null,
    toast: null,
    hidden: null,
    note: null,
    snapshot: rememberCommunities,
    tabs: readTabs,
    /* Cached only: saved tabs plus joined communities already on the device. */
    mine: function () {
      var rows = (state.index && state.index.communities) || [];
      return {
        tabs: readTabs(),
        joined: joinedRows(rows).map(function (row) { return { name: row.name, label: communityLabel(row.name) }; })
      };
    },
    cleanTabs: cleanTabs,
    tabFeed: function (id) {
      var tab = tabById(id);
      return tab ? tabFeedHtml(tab, true) : "";
    },
    openTab: function (id) {
      if (tabById(id)) state.hubTab = "tab:" + id;
    },
    editTab: function (id) { openEditor(id || "", []); },
    openAssign: openAssign,
    readTabs: null,
    writeTabs: null,
    readFolders: null,
    writeFolders: null,
    profileInfo: null,
    profiles: null,
    profileItems: null,
    loadProfiles: null,
    tabGone: null
  };
})();
