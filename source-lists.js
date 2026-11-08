/* Source lists on the device.
   Members: the posts of lists the owner assigned to this account are merged
   into the timeline from small content-addressed shards. The shard is read
   from this device's copy first, then from peers (the sharing pool checks the
   hash), then from the Worker. Nobody else downloads them.
   Owner: #/feeds/lists creates lists, adds sources, assigns accounts and
   approves requests. Members request an account from the same page. */
(function () {
  const META_KEY = "private-list-meta-v1";
  const DOC_PREFIX = "private-list-doc:";
  const CHECK_MS = 30 * 60 * 1000;
  const NONE_MS = 6 * 60 * 60 * 1000;
  const PENDING_MS = 15 * 1000;
  let hooks = null;
  const mem = { meta: null, docs: {}, ready: null, busy: false };
  const page = { owner: null, mine: null, loading: false, error: "", busy: "", requests: null };

  function tr(key, vars) { return hooks && hooks.tr ? hooks.tr(key, vars) : key; }
  function esc(value) { return hooks && hooks.esc ? hooks.esc(value) : String(value == null ? "" : value); }
  function zeroTrace() { return !!(hooks && hooks.STATE && hooks.STATE.settings && hooks.STATE.settings.privacyZeroTrace); }
  function signedIn() { return !!(hooks && hooks.accountsApi && hooks.accountsApi() && hooks.accountToken && hooks.accountToken()); }
  function ownerOn() { return !!(signedIn() && hooks.signedOwner && hooks.signedOwner()); }

  function readLocal(key) {
    if (zeroTrace() || typeof localStorage === "undefined") return null;
    try {
      const raw = hooks && hooks.readStored ? hooks.readStored(localStorage, key) : localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) { return null; }
  }
  function writeLocal(key, value) {
    if (zeroTrace() || typeof localStorage === "undefined") return;
    try {
      const text = JSON.stringify(value);
      if (hooks && hooks.writeStored) hooks.writeStored(localStorage, key, text);
      else localStorage.setItem(key, text);
    } catch (err) { /* a full quota keeps the previous copy */ }
  }
  function dropLocal(key) {
    try {
      if (hooks && hooks.removeStored) hooks.removeStored(localStorage, key);
      else localStorage.removeItem(key);
    } catch (err) { /* nothing stored */ }
  }

  function local() { return window.ViktorychLocal && window.ViktorychLocal.readDoc ? window.ViktorychLocal : null; }

  /* Copies are stored under the account that fetched them. A switch cannot
     read or replace another account's shard. */
  function metaStoreKey(who) { return META_KEY + ":" + String(who || ""); }
  function docStoreKey(who, id) { return DOC_PREFIX + String(who || "") + ":" + id; }

  async function readShardDoc(who, row) {
    let saved = null;
    const db = local();
    if (db) {
      try { saved = await db.readDoc("private-list", who + ":" + row.id); } catch (err) { saved = null; }
    }
    if (!saved) saved = readLocal(docStoreKey(who, row.id));
    return saved && saved.account === who && saved.hash === row.hash && saved.doc && Array.isArray(saved.doc.posts) ? saved.doc : null;
  }
  function saveShardDoc(who, row, doc) {
    if (zeroTrace() || !who) return;
    const saved = { hash: row.hash, account: who, doc: doc };
    const db = local();
    if (db && db.saveDoc && typeof indexedDB !== "undefined") {
      db.saveDoc("private-list", who + ":" + row.id, saved).catch(() => null);
      return;
    }
    writeLocal(docStoreKey(who, row.id), saved);
  }
  function forgetShardDoc(who, row) {
    dropLocal(docStoreKey(who, row.id));
    const db = local();
    if (db && db.saveDoc && typeof indexedDB !== "undefined") db.saveDoc("private-list", who + ":" + row.id, null).catch(() => null);
  }

  /* Loads this device's copy. The timeline waits for it at most briefly. */
  function sessionStamp() {
    const accounts = window.ViktorychAccounts;
    const gen = accounts && accounts.sessionGeneration ? String(accounts.sessionGeneration()) : "0";
    return accountKey() + "\n" + gen;
  }

  function useAccount(stamp) {
    if (mem.account === stamp) return;
    mem.account = stamp;
    mem.meta = null;
    mem.docs = {};
    mem.ready = null;
  }

  function ready() {
    const who = accountKey();
    const stamp = sessionStamp();
    useAccount(stamp);
    if (mem.ready) return mem.ready;
    mem.meta = readLocal(metaStoreKey(who));
    if (!mem.meta || mem.meta.account !== who || mem.meta.session !== stamp) mem.meta = null;
    const lists = (mem.meta && mem.meta.lists) || [];
    mem.ready = Promise.all(lists.filter((row) => row.hash).map((row) => readShardDoc(who, row).then((doc) => {
      if (doc && accountKey() === who) mem.docs[row.hash] = doc;
    }).catch(() => null))).then(() => true);
    return mem.ready;
  }

  function activeDocs() {
    if (!mem.meta || !signedIn() || mem.meta.account !== accountKey() || mem.meta.session !== sessionStamp()) return [];
    const lists = (mem.meta && mem.meta.lists) || [];
    return lists.map((row) => mem.docs[row.hash]).filter(Boolean);
  }

  /* Adds the assigned lists' feeds and posts; drops ones from lists this
     account no longer has. Quoted and reposted items ride inside their post. */
  function merge(doc) {
    if (!doc || !Array.isArray(doc.posts)) return doc;
    const docs = activeDocs();
    const feeds = [];
    const posts = [];
    const feedIds = new Set();
    docs.forEach((one) => {
      (one.feeds || []).forEach((feed) => {
        if (!feed || !feed.id || feedIds.has(feed.id)) return;
        feedIds.add(feed.id);
        feeds.push(Object.assign({}, feed, { sourceList: true }));
      });
      (one.posts || []).forEach((post) => { if (post && post.feedId) posts.push(Object.assign({}, post, { sourceList: true })); });
    });
    const baseFeeds = (doc.feeds || []).filter((feed) => feed && !(feed.sourceList && !feedIds.has(feed.id)));
    const haveFeed = new Set(baseFeeds.map((feed) => feed.id));
    const basePosts = doc.posts.filter((post) => post && !(post.sourceList && !feedIds.has(post.feedId)));
    const key = (post) => String(post.platform || "") + ":" + String(post.statusId || post.id || "") + ":" + String(post.feedId || "");
    const havePost = new Set(basePosts.map(key));
    const addFeeds = feeds.filter((feed) => !haveFeed.has(feed.id));
    const addPosts = posts.filter((post) => !havePost.has(key(post)));
    if (!addFeeds.length && !addPosts.length && baseFeeds.length === (doc.feeds || []).length && basePosts.length === doc.posts.length) return doc;
    return Object.assign({}, doc, { feeds: baseFeeds.concat(addFeeds), posts: basePosts.concat(addPosts) });
  }

  function api(path, method, body, token) {
    const base = hooks.accountsApi();
    const auth = token || hooks.accountToken();
    return fetch(base + path, {
      method: method || "GET",
      headers: Object.assign({ Authorization: "Bearer " + auth }, body ? { "content-type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      credentials: "omit"
    }).then((res) => res.json().then((data) => ({ ok: res.ok, status: res.status, body: data })).catch(() => ({ ok: res.ok, status: res.status, body: null })));
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((n) => n.toString(16).padStart(2, "0")).join("");
  }

  /* Peers first when the sharing pool has it, then the Worker. The hash checks both. */
  async function pullShard(row) {
    const pool = window.ViktorychPool;
    let bytes = null;
    if (pool && pool.getBlob && row.size) {
      try { bytes = await pool.getBlob(row.hash, row.size, { priority: "background", waitMs: 800 }); } catch (err) { bytes = null; }
      if (bytes && (await sha256Hex(bytes)) !== row.hash) bytes = null;
    }
    if (!bytes) {
      const res = await fetch(hooks.accountsApi() + "/v1/me/source-lists/shard/" + row.hash, {
        headers: { Authorization: "Bearer " + (row.token || hooks.accountToken()) },
        credentials: "omit"
      });
      if (!res.ok) return null;
      bytes = new Uint8Array(await res.arrayBuffer());
      if ((await sha256Hex(bytes)) !== row.hash) return null;
      if (pool && pool.putBlob) { try { pool.putBlob(bytes); } catch (err) { /* sharing is optional */ } }
    }
    try {
      const doc = JSON.parse(new TextDecoder().decode(bytes));
      return doc && Array.isArray(doc.posts) ? doc : null;
    } catch (err) { return null; }
  }

  /* Checks for list updates at most every 30 minutes (6 hours when this
     account has no lists), so other accounts spend almost nothing. */
  async function refresh(force) {
    if (!hooks || !signedIn() || mem.busy) return false;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
    await ready();
    const meta = mem.meta || {};
    const pending = ((meta.lists) || []).some((row) => row && !row.hash && row.status !== "empty");
    const wait = pending ? PENDING_MS : ((meta.lists && meta.lists.length) ? CHECK_MS : NONE_MS);
    if (force !== true && force !== "retry" && meta.checkedAt && Date.now() - meta.checkedAt < wait && meta.account === accountKey() && meta.session === sessionStamp()) return false;
    const who = accountKey();
    const stamp = sessionStamp();
    const token = hooks.accountToken();
    useAccount(stamp);
    mem.busy = true;
    let switched = false;
    try {
      const res = await api("/v1/me/source-lists" + (force === "retry" ? "?retry=1" : ""), "GET", null, token);
      if (sessionStamp() !== stamp) { switched = true; return false; }
      if (!res.ok || !res.body || !Array.isArray(res.body.lists)) return false;
      const lists = res.body.lists.filter((row) => row && /^s[a-f0-9]{8}$/.test(row.id)).map((row) => ({
        id: row.id,
        name: String(row.name || ""),
        hash: /^[a-f0-9]{64}$/.test(row.hash || "") ? row.hash : "",
        size: Number(row.size) || 0,
        at: Number(row.at) || 0,
        count: Number(row.count) || 0,
        status: String(row.status || "")
      }));
      if (sessionStamp() !== stamp) { switched = true; return false; }
      const added = [];
      for (const row of lists) {
        if (!row.hash || mem.docs[row.hash]) continue;
        const doc = await pullShard(Object.assign({ token: token }, row));
        if (sessionStamp() !== stamp) { switched = true; return false; }
        if (doc) { mem.docs[row.hash] = doc; added.push(row.hash); saveShardDoc(who, row, doc); }
      }
      if (sessionStamp() !== stamp) {
        switched = true;
        added.forEach((hash) => delete mem.docs[hash]);
        return false;
      }
      const before = JSON.stringify(((mem.meta && mem.meta.lists) || []).map((row) => row.hash));
      const old = (mem.meta && mem.meta.lists) || [];
      mem.meta = { lists, checkedAt: Date.now(), account: who, session: stamp };
      writeLocal(metaStoreKey(who), mem.meta);
      const keep = new Set(lists.map((row) => row.hash));
      const ids = new Set(lists.map((row) => row.id));
      old.forEach((row) => {
        if (row.hash && !keep.has(row.hash)) delete mem.docs[row.hash];
        if (!ids.has(row.id)) forgetShardDoc(who, row);
      });
      const changed = before !== JSON.stringify(lists.map((row) => row.hash));
      if (changed && hooks.onChange && sessionStamp() === stamp) hooks.onChange();
      return changed;
    } catch (err) {
      return false;
    } finally {
      mem.busy = false;
      if (switched && sessionStamp() !== stamp) refresh(true);
    }
  }

  function accountKey() {
    const acct = window.ViktorychAccounts && window.ViktorychAccounts.account ? window.ViktorychAccounts.account() : null;
    return acct ? String(acct.publicId || acct.public_id || acct.handle || "") : "";
  }

  /* ---------- #/feeds/lists ---------- */

  function paint() { if (hooks && hooks.render) hooks.render(); }

  function load() {
    if (page.loading || !signedIn()) return;
    page.loading = true;
    const owner = ownerOn();
    const done = (res) => {
      page.loading = false;
      if (res && res.ok && res.body) {
        page.error = "";
        if (owner) page.owner = res.body;
        else page.requests = res.body.requests || [];
      } else {
        page.error = tr("Couldn’t load this list.");
      }
      paint();
    };
    if (owner) api("/v1/owner/source-lists").then(done, () => done(null));
    else {
      refresh(true).finally(() => api("/v1/me/source-lists/requests").then(done, () => done(null)));
    }
  }

  function face(row) {
    return hooks.avatar ? hooks.avatar(row.avatar || "", row.name || row.handle || "") : "";
  }

  function rowHtml(row, sub, act, attrs, extra) {
    return `<article class="feeds-row"><span class="feeds-who"><span class="feeds-face">${face(row)}</span><span class="feeds-copy"><span class="feeds-name">${esc(row.name || row.handle || "")}</span><span class="feeds-sub">${esc(sub)}</span>${extra || ""}</span></span><span class="feeds-row-end">${act ? `<button type="button" class="feeds-pill" data-sl-act="${esc(act)}" ${attrs}>${esc(tr("Remove"))}</button>` : ""}</span></article>`;
  }

  function sourceStatus(source) {
    const h = source.health;
    if (!h) return `<span class="feeds-status is-adding"><i class="feeds-dot" aria-hidden="true"></i><span>${esc(tr("Waiting for the next refresh"))}</span></span>`;
    return h.ok
      ? `<span class="feeds-status is-ok"><i class="feeds-dot" aria-hidden="true"></i><span>${esc(tr("Posts: {n}", { n: h.count }))}</span></span>`
      : `<span class="feeds-status is-failing"><i class="feeds-dot" aria-hidden="true"></i><span>${esc(tr("Couldn’t refresh. Showing the last posts."))}</span></span>`;
  }

  function listCard(list) {
    const busy = page.busy === list.id;
    const sources = list.sources.map((s) => rowHtml(s, "@" + (s.handle || "") + " · " + (s.platform || ""), "remove-source", `data-list="${esc(list.id)}" data-id="${esc(s.id)}"`, sourceStatus(s))).join("");
    const members = list.members.map((m) => rowHtml(m, "@" + (m.handle || "") + (m.active ? "" : " · " + tr("Inactive, not fetched")), "remove-member", `data-list="${esc(list.id)}" data-id="${esc(m.id)}"`)).join("");
    const size = list.shard ? tr("Posts: {n}", { n: list.shard.count }) + " · " + Math.max(1, Math.round(list.shard.size / 1024)) + " KB" : tr("No posts yet");
    return `<section class="feeds-section sl-list" data-list="${esc(list.id)}"${busy ? ' aria-busy="true"' : ""}>
      <h2>${esc(list.name)} <span class="feeds-count">· ${esc(size)}</span></h2>
      <div class="feeds-add"><input class="search" data-sl-field="rename" data-list="${esc(list.id)}" value="${esc(list.name)}" aria-label="${esc(tr("List name"))}"><button type="button" class="feeds-pill" data-sl-act="rename" data-list="${esc(list.id)}">${esc(tr("Rename"))}</button><button type="button" class="feeds-pill" data-sl-act="delete-list" data-list="${esc(list.id)}">${esc(tr("Delete list"))}</button></div>
      <h2>${esc(tr("Sources"))} <span class="feeds-count">${list.sources.length}</span></h2>
      ${sources || `<p class="feeds-hint">${esc(tr("No sources yet"))}</p>`}
      <div class="feeds-add"><input class="search" data-sl-field="source" data-list="${esc(list.id)}" placeholder="${esc(tr("Paste a link or @handle"))}" autocomplete="off"><button type="button" class="follow" data-sl-act="add-source" data-list="${esc(list.id)}">${esc(tr("Add"))}</button></div>
      <h2>${esc(tr("Shown to"))} <span class="feeds-count">${list.members.length}</span></h2>
      ${members || `<p class="feeds-hint">${esc(tr("Nobody yet. Nothing is fetched until you assign someone."))}</p>`}
      <div class="feeds-add"><input class="search" data-sl-field="member" data-list="${esc(list.id)}" placeholder="${esc(tr("@username on this site"))}" autocomplete="off"><button type="button" class="follow" data-sl-act="add-member" data-list="${esc(list.id)}">${esc(tr("Assign"))}</button></div>
    </section>`;
  }

  function requestRow(req, lists) {
    const options = lists.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("") + `<option value="">${esc(tr("New list for this person"))}</option>`;
    const who = req.by || {};
    return `<article class="feeds-row sl-request"><span class="feeds-copy"><span class="feeds-name">${esc(req.input)}</span><span class="feeds-sub">${esc(tr("Asked by"))} @${esc(who.handle || "")}${req.note ? " · " + esc(req.note) : ""}</span></span><span class="feeds-row-end feeds-inline"><select data-sl-field="target" data-id="${esc(req.id)}" aria-label="${esc(tr("Add to list"))}">${options}</select><button type="button" class="follow" data-sl-act="approve" data-id="${esc(req.id)}">${esc(tr("Approve"))}</button><button type="button" class="feeds-pill" data-sl-act="reject" data-id="${esc(req.id)}">${esc(tr("Reject"))}</button></span></article>`;
  }

  function ownerView() {
    const doc = page.owner;
    if (!doc) return `<div class="feeds-empty"><b>${esc(page.error || tr("Loading…"))}</b></div>`;
    const requests = (doc.requests || []).map((r) => requestRow(r, doc.lists || [])).join("");
    return `<p class="feeds-hint">${esc(tr("Posts from a list show only for the accounts you assign. Your own feed and everyone else's stay the same, and nobody else downloads them."))}</p>
      <div class="feeds-add"><input class="search" data-sl-field="new-list" placeholder="${esc(tr("New list name"))}" autocomplete="off"><button type="button" class="follow" data-sl-act="create">${esc(tr("Create list"))}</button></div>
      ${requests ? `<section class="feeds-section"><h2>${esc(tr("Requests"))} <span class="feeds-count">${(doc.requests || []).length}</span></h2>${requests}</section>` : ""}
      ${(doc.lists || []).map(listCard).join("") || `<div class="feeds-empty"><b>${esc(tr("No lists yet"))}</b><span>${esc(tr("Create a list, add sources, then assign the accounts that should see them."))}</span></div>`}`;
  }

  function listLine(list) {
    if (list.status === "error" && list.hash) return tr("Couldn’t refresh. Showing the last posts.");
    if (list.status === "error") return tr("Something went wrong. Try again.");
    if (list.status === "empty" || (list.hash && !list.count)) return tr("No posts yet");
    if (list.hash) return tr("In your timeline");
    return tr("Loading…");
  }

  function memberView() {
    const lists = (mem.meta && mem.meta.lists) || [];
    const rows = lists.map((l) => `<article class="feeds-row"><span class="feeds-copy"><span class="feeds-name">${esc(l.name)}</span><span class="feeds-sub">${esc(listLine(l))}</span></span>${l.status === "error" ? `<span class="feeds-row-end"><button type="button" class="feeds-pill" data-sl-act="retry-lists">${esc(tr("Retry"))}</button></span>` : ""}</article>`).join("");
    const pending = (page.requests || []).map((r) => `<article class="feeds-row"><span class="feeds-copy"><span class="feeds-name">${esc(r.input)}</span><span class="feeds-sub">${esc(tr("Waiting for approval"))}</span></span></article>`).join("");
    return `<p class="feeds-hint">${esc(tr("Extra sources the owner added for you. Mute any account from its posts to hide it."))}</p>
      <section class="feeds-section"><h2>${esc(tr("Your extra sources"))}</h2>${rows || `<p class="feeds-hint">${esc(tr("None yet"))}</p>`}</section>
      ${window.FeedRequests && window.FeedRequests.active() ? `<a class="feeds-banner sl-link" href="#/feeds/requests"><span>${esc(tr("My source requests"))}</span><span aria-hidden="true">›</span></a>` : `<section class="feeds-section"><h2>${esc(tr("Request an account"))}</h2>
      <div class="feeds-add"><input class="search" data-sl-field="request" placeholder="${esc(tr("Paste a link or @handle"))}" autocomplete="off"><button type="button" class="follow" data-sl-act="request">${esc(tr("Request"))}</button></div>
      ${pending}</section>`}`;
  }

  function view() {
    const head = hooks.pageHead ? hooks.pageHead(tr("Source lists"), "", true) : "";
    if (!signedIn()) return head + `<div class="feeds-empty"><b>${esc(tr("Sign in to see this"))}</b></div>`;
    if ((ownerOn() && !page.owner) || (!ownerOn() && page.requests == null)) load();
    return head + `<div class="feeds-org sl-page">${ownerOn() ? ownerView() : memberView()}</div>`;
  }

  function field(name, list, id) {
    const sel = `[data-sl-field="${name}"]` + (list ? `[data-list="${list}"]` : "") + (id ? `[data-id="${id}"]` : "");
    const el = document.querySelector(sel);
    return el ? String(el.value || "").trim() : "";
  }

  function failText(body) {
    const code = body && body.error;
    if (body && body.message) return tr(body.message);
    if (code === "full") return tr("That’s the limit for lists.");
    if (code === "not_found") return tr("Couldn’t find that account.");
    if (code === "unsupported_tiktok") return tr("TikTok can’t be added to lists.");
    if (code === "too_many") return tr("You already have requests waiting.");
    return tr("Something went wrong. Try again.");
  }

  function run(promise, okText) {
    page.busy = "x";
    paint();
    return promise.then((res) => {
      page.busy = "";
      if (res.ok && res.body && Array.isArray(res.body.lists)) page.owner = res.body;
      if (hooks.toast) hooks.toast(res.ok ? okText : failText(res.body));
      paint();
    }, () => { page.busy = ""; if (hooks.toast) hooks.toast(tr("Something went wrong. Try again.")); paint(); });
  }

  function onClick(event) {
    const btn = event.target && event.target.closest ? event.target.closest("[data-sl-act]") : null;
    if (!btn || !hooks) return;
    event.preventDefault();
    const act = btn.dataset.slAct;
    const list = btn.dataset.list || "";
    const id = btn.dataset.id || "";
    const L = "/v1/owner/source-lists";
    if (act === "create") { const name = field("new-list"); if (name) run(api(L, "POST", { name }), tr("List created")); return; }
    if (act === "rename") { const name = field("rename", list); if (name) run(api(L + "/" + list, "PATCH", { name }), tr("Saved")); return; }
    if (act === "delete-list") { if (window.confirm(tr("Delete this list? Its sources stop being fetched."))) run(api(L + "/" + list, "DELETE"), tr("List deleted")); return; }
    if (act === "add-source") { const input = field("source", list); if (input) run(api(L + "/" + list + "/sources", "POST", { input }), tr("Source added")); return; }
    if (act === "remove-source") { run(api(L + "/" + list + "/sources/" + encodeURIComponent(id), "DELETE"), tr("Removed")); return; }
    if (act === "add-member") { const handle = field("member", list); if (handle) run(api(L + "/" + list + "/members", "POST", { handle }), tr("Assigned")); return; }
    if (act === "remove-member") { run(api(L + "/" + list + "/members/" + encodeURIComponent(id), "DELETE"), tr("Removed")); return; }
    if (act === "approve") {
      const target = field("target", "", id);
      const req = ((page.owner && page.owner.requests) || []).find((r) => r.id === id);
      const body = target ? { listId: target } : { newList: tr("For @{name}", { name: (req && req.by && req.by.handle) || "" }) };
      run(api(L + "/requests/" + id + "/approve", "POST", body), tr("Approved"));
      return;
    }
    if (act === "reject") { run(api(L + "/requests/" + id, "DELETE"), tr("Rejected")); return; }
    if (act === "retry-lists") { refresh("retry").then(() => paint()); return; }
    if (act === "request") {
      const input = field("request");
      if (!input) return;
      api("/v1/me/source-lists/requests", "POST", { input }).then((res) => {
        if (hooks.toast) hooks.toast(res.ok ? tr("Sent to the owner") : failText(res.body));
        page.requests = null;
        paint();
      });
    }
  }

  function attach(next) {
    hooks = next || hooks;
    ready();
    if (attach.bound) return;
    attach.bound = true;
    document.addEventListener("click", onClick);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refresh(false);
    });
    setTimeout(() => refresh(false), 4000);
    setInterval(() => { if (document.visibilityState === "visible") refresh(false); }, 10 * 60 * 1000);
  }

  function notify(data) {
    if (!data || !data.lists) return Promise.resolve(false);
    return refresh(true);
  }

  window.SourceLists = { attach, merge, ready, refresh, notify, view, _mem: mem };
})();
