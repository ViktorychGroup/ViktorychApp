/* Source requests.
   Only the owner adds accounts, feeds and communities. Everyone else gets the
   same buttons labelled Request: the request goes to the owner, who allows it
   (to everyone, only the people who asked, or a source list), blocks it (it
   can be asked for again) or bans it (never again, and copies stop).
   #/feeds/requests     what this account asked for
   #/settings/feed-requests          the owner's queue
   #/settings/feed-requests/banned   banned sources
   Handles and links stay on the Worker; nothing here is written to the repo. */
(function () {
  const MINE_KEY = "feed-requests-mine-v1";
  const BANS_AT_KEY = "feed-requests-bans-at";
  const BANS_MS = 6 * 60 * 60 * 1000;
  const COUNT_MS = 5 * 60 * 1000;
  let hooks = null;
  const S = {
    mine: null, mineLoading: false, mineTab: "pending", mineError: "",
    queue: null, queueState: "pending", queueLoading: false, queueError: "",
    bans: null, bansLoading: false,
    count: 0, countAt: 0, picked: {}, busy: {}, previews: {},
    dest: {}, members: {}, sheet: ""
  };
  const API_TIMEOUT_MS = 30000;

  function tr(key, vars) { return hooks && hooks.tr ? hooks.tr(key, vars) : key; }
  function esc(value) { return hooks && hooks.esc ? hooks.esc(value) : String(value == null ? "" : value); }
  function signedIn() { return !!(hooks && hooks.accountsApi && hooks.accountsApi() && hooks.accountToken && hooks.accountToken()); }
  function ownerOn() { return !!(signedIn() && hooks.signedOwner && hooks.signedOwner()); }
  function paint() { if (hooks && hooks.render) hooks.render(); }
  function toast(text) { if (hooks && hooks.toast && text) hooks.toast(text); }

  /* Default on: only a server list that names it turns it off. */
  function active() {
    if (!hooks) return false;
    const off = hooks.serverOff ? hooks.serverOff() : [];
    return !(Array.isArray(off) && off.indexOf("feed_requests") >= 0);
  }
  /* True when this person's add buttons should send a request instead. */
  function asks() { return active() && !ownerOn(); }

  function api(path, method, body, anonymous) {
    const base = hooks.accountsApi();
    const token = hooks.accountToken();
    const headers = body ? { "content-type": "application/json" } : {};
    if (!anonymous && token) headers.Authorization = "Bearer " + token;
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    let late = false;
    const timer = ctrl ? setTimeout(() => { late = true; ctrl.abort(); }, API_TIMEOUT_MS) : null;
    return fetch(base + path, {
      method: method || "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      credentials: "omit",
      signal: ctrl ? ctrl.signal : undefined
    }).then((res) => res.json().then((data) => ({ ok: res.ok, status: res.status, body: data || {} })).catch(() => ({ ok: res.ok, status: res.status, body: {} })))
      .catch(() => ({ ok: false, status: 0, body: { error: late ? "timeout" : (typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "network") } }))
      .then((out) => { if (timer) clearTimeout(timer); return out; });
  }

  function norm(id) { return String(id || "").trim().toLowerCase().replace(/^bsky:/, "bluesky:"); }

  function readMine() {
    if (S.mine) return S.mine;
    try {
      const raw = hooks.readStored ? hooks.readStored(localStorage, MINE_KEY) : localStorage.getItem(MINE_KEY);
      const list = raw ? JSON.parse(raw) : null;
      if (Array.isArray(list)) S.mine = list;
    } catch (err) { S.mine = null; }
    return S.mine;
  }
  function saveMine() {
    if (hooks && hooks.STATE && hooks.STATE.settings && hooks.STATE.settings.privacyZeroTrace) return;
    try {
      // Only the state and key are kept on the device, for the buttons.
      const slim = (S.mine || []).slice(0, 200).map((r) => ({ id: r.id, key: r.key, state: r.state }));
      const text = JSON.stringify(slim);
      if (hooks.writeStored) hooks.writeStored(localStorage, MINE_KEY, text);
      else localStorage.setItem(MINE_KEY, text);
    } catch (err) { /* quota */ }
  }

  function loadMine(force) {
    if (!signedIn() || S.mineLoading) return Promise.resolve(S.mine);
    if (S.mine && S.mine.some((r) => r.input != null) && !force) return Promise.resolve(S.mine);
    S.mineLoading = true;
    return api("/v1/feed-requests").then((res) => {
      S.mineLoading = false;
      if (res.ok && Array.isArray(res.body.requests)) {
        S.mine = res.body.requests;
        S.mineError = "";
        saveMine();
      } else if (!S.mine || !S.mine.some((r) => r.input != null)) {
        S.mineError = tr("Couldn’t load your requests.");
      }
      paint();
      return S.mine;
    });
  }

  function findMine(id) {
    const key = norm(id);
    if (!key) return null;
    return (readMine() || []).find((r) => norm(r.key) === key || norm(r.input) === key) || null;
  }
  function stateFor(id) {
    const row = findMine(id);
    return row ? row.state : "";
  }

  function noteRequested(request) {
    if (!request || !request.key) return;
    readMine();
    S.mine = (S.mine || []).filter((r) => r.id !== request.id && norm(r.key) !== norm(request.key));
    S.mine.unshift(request);
    saveMine();
    paint();
  }

  function failText(body) {
    const code = body && body.error;
    if (code === "banned") return tr("This source isn’t available.");
    if (code === "rate_limited") return tr("Too many requests today. Try again tomorrow.");
    if (code === "too_many") return tr("You have too many open requests.");
    if (code === "owner_adds") return tr("You’re the owner. Add it directly.");
    if (code === "bad_input" || code === "unsupported") return tr("Use a profile URL, @handle, or an https feed");
    return tr("Couldn’t send your request. Try again.");
  }

  /* Sends a request. Resolves to "pending", "allowed" or "" (refused). */
  function submit(raw, opts) {
    const options = opts || {};
    const input = String(raw || "").trim();
    if (!input) return Promise.resolve("");
    if (!signedIn()) {
      toast(tr("Sign in to request a source."));
      return Promise.resolve("");
    }
    const body = { input, kind: options.kind || "", note: String(options.note || "").slice(0, 280) };
    if (options.key) body.key = options.key;
    if (options.name) body.name = String(options.name).slice(0, 80);
    if (options.avatar && /^https:\/\//.test(options.avatar)) body.avatar = options.avatar;
    return api("/v1/feed-requests", "POST", body).then((res) => {
      if (res.ok && res.body.state === "allowed") return "allowed";
      if (res.ok && res.body.request) {
        noteRequested(res.body.request);
        if (!options.quiet) toast(tr("Request sent. The owner decides what’s added."));
        return "pending";
      }
      toast(failText(res.body));
      return "";
    });
  }

  function cancel(id) {
    return api("/v1/feed-requests/" + encodeURIComponent(id), "DELETE").then((res) => {
      if (res.ok && Array.isArray(res.body.requests)) {
        S.mine = res.body.requests;
        saveMine();
        toast(tr("Request cancelled"));
      } else toast(tr("Couldn’t cancel. Try again."));
      paint();
    });
  }

  /* The Follow button for a source that isn't in the app yet. */
  function buttonHtml(id, large, label) {
    const state = stateFor(id);
    const lg = large ? " lg" : "";
    if (state === "pending") {
      return `<button class="follow fr-btn is-requested${lg}" type="button" data-fr-act="cancel-key" data-fr-id="${esc(id)}" aria-pressed="true" title="${esc(tr("Cancel request"))}"><span class="f">${esc(tr("Requested"))}</span><span class="u">${esc(tr("Cancel"))}</span></button>`;
    }
    return `<button class="follow fr-btn${lg}" type="button" data-fr-act="request" data-fr-id="${esc(id)}" data-fr-label="${esc(label || "")}">${esc(tr("Request"))}</button>`;
  }

  /* app.js: replace Follow when the account can't add this source itself. */
  function gateButton(ids, large) {
    if (!asks() || !signedIn()) return "";
    const list = (ids || []).filter(Boolean);
    if (!list.length || list.some((id) => String(id).indexOf("app:") === 0)) return "";
    if (hooks.inCatalog && list.some((id) => hooks.inCatalog(id))) return "";
    if (list.some((id) => stateFor(id) === "approved")) return "";
    return buttonHtml(list[0], large);
  }

  /* app.js add boxes. ctx: { raw, parsed, existing, newsletter, kind, proceed }.
     Returns true when the request flow took over. */
  function gateAdd(ctx) {
    if (!asks()) return false;
    const raw = String(ctx.raw || "").trim();
    if (!raw || ctx.existing) return false;
    if (!signedIn()) {
      toast(tr("Sign in to request a source."));
      return true;
    }
    const go = (input, extra) => submit(input, extra).then((state) => {
      if (state === "allowed" && ctx.proceed) ctx.proceed();
      else if (state === "pending" && ctx.done) ctx.done();
      return state;
    });
    if (ctx.newsletter && hooks.newsletterInfo) {
      hooks.newsletterInfo(raw).then((doc) => {
        if (!doc || !doc.key) { toast(tr("Couldn’t read that newsletter.")); return; }
        go(raw, { key: doc.key, name: doc.name || "", avatar: doc.avatar || "" });
      }, () => toast(tr("Couldn’t read that newsletter.")));
      return true;
    }
    const parsed = ctx.parsed || {};
    let input = raw;
    if (parsed.platform === "nostr") input = "nostr:" + String(parsed.account || raw).replace(/^nostr:/i, "");
    go(input, { kind: ctx.kind || "" });
    return true;
  }

  /* Banned sources the device follows on its own stop being fetched. */
  async function hashOf(id) {
    const bytes = new TextEncoder().encode("feed-ban:" + String(id || "").trim().toLowerCase());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((n) => n.toString(16).padStart(2, "0")).join("").slice(0, 20);
  }
  function checkBans(force) {
    if (!hooks || !active() || !hooks.followedIds || !hooks.accountsApi || !hooks.accountsApi()) return Promise.resolve([]);
    if (typeof crypto === "undefined" || !crypto.subtle) return Promise.resolve([]);
    let at = 0;
    try { at = Number(localStorage.getItem(BANS_AT_KEY)) || 0; } catch (err) { at = 0; }
    if (!force && Date.now() - at < BANS_MS) return Promise.resolve([]);
    try { localStorage.setItem(BANS_AT_KEY, String(Date.now())); } catch (err) { /* private mode */ }
    return api("/v1/feed-requests/banned", "GET", null, true).then(async (res) => {
      const hashes = new Set((res.ok && Array.isArray(res.body.hashes)) ? res.body.hashes : []);
      if (!hashes.size) return [];
      const drop = [];
      const ids = hooks.followedIds().filter((id) => id && String(id).indexOf("app:") !== 0);
      for (const id of ids) {
        const variants = [id];
        const lower = String(id).toLowerCase();
        if (lower.indexOf("bsky:") === 0) variants.push("bluesky:" + lower.slice(5));
        for (const v of variants) {
          if (hashes.has(await hashOf(v))) { drop.push(id); break; }
        }
      }
      if (drop.length && hooks.unfollowLocal) hooks.unfollowLocal(drop);
      return drop;
    });
  }

  /* ---------- views ---------- */

  function face(row) {
    return hooks.avatar ? hooks.avatar(row.avatar || "", row.name || row.handle || row.input || "") : "";
  }
  function platformName(p) {
    const names = { x: "X", threads: "Threads", instagram: "Instagram", youtube: "YouTube", tiktok: "TikTok", reddit: "Reddit", bluesky: "Bluesky", mastodon: "Mastodon", rss: "RSS", news: tr("Newsletter"), nostr: "Nostr", vk: "VK", telegram: "Telegram" };
    return names[p] || p || "";
  }
  function when(ms) {
    if (!ms) return "";
    try { return new Date(ms).toLocaleDateString(hooks.lang ? hooks.lang() : undefined, { month: "short", day: "numeric" }); } catch (err) { return ""; }
  }
  /* "@handle" (or r/name, a feed's host) from a request, never the pasted URL. */
  function handleText(row) {
    const p = row.platform || "";
    const key = String(row.key || "");
    const input = String(row.input || "");
    if (row.kind === "community" || /^reddit:r:/.test(key)) return "r/" + (row.handle || key.replace(/^reddit:r:/, ""));
    if (p === "reddit") return "u/" + (row.handle || key.replace(/^reddit:(u:)?/, ""));
    if (p === "mastodon") return "@" + key.replace(/^mastodon:/, "");
    if (p === "rss" || p === "news" || p === "nostr" || row.kind === "news") {
      const url = row.url || (/^https?:\/\//i.test(input) ? input : "");
      if (url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (err) { /* fall through */ } }
      return row.handle || key.replace(/^[a-z]+:/, "");
    }
    let handle = row.handle || "";
    if (!handle) {
      const m = input.match(/^[a-z]+:@?(.+)$/i) || key.match(/^[a-z]+:(.+)$/);
      if (m && !/^\/\//.test(m[1])) handle = m[1];
      else {
        try { handle = new URL(input).pathname.split("/").filter(Boolean)[0] || ""; } catch (err) { handle = ""; }
        handle = handle.replace(/^@/, "");
      }
    }
    // A YouTube channel id is not a name people know; the title carries it.
    if (p === "youtube" && /^UC[\w-]{20,}$/.test(handle)) return row.name ? "" : tr("YouTube channel");
    return handle ? "@" + handle : "";
  }
  function title(row) { return row.name || handleText(row) || row.key || ""; }
  function subline(row) {
    const bits = [platformName(row.platform)];
    const handle = handleText(row);
    if (handle && handle !== title(row)) bits.push(handle);
    return bits.filter(Boolean).join(" · ");
  }
  function stateLabel(state) {
    if (state === "pending") return tr("Pending");
    if (state === "approved") return tr("Approved");
    if (state === "banned" || state === "rejected") return tr("Not approved");
    if (state === "cancelled") return tr("Cancelled");
    return state || "";
  }
  function tabs(items, current, act) {
    return `<div class="tabs ptabs fr-tabs" role="tablist">${items.map(([id, label, href]) => href
      ? `<a class="tab${current === id ? " on" : ""}" role="tab" aria-selected="${current === id ? "true" : "false"}" href="${esc(href)}"><span>${esc(label)}</span></a>`
      : `<button type="button" class="tab${current === id ? " on" : ""}" role="tab" aria-selected="${current === id ? "true" : "false"}" data-fr-act="${esc(act)}" data-fr-tab="${esc(id)}"><span>${esc(label)}</span></button>`).join("")}</div>`;
  }
  function empty(head, text) {
    return `<div class="feeds-empty"><b>${esc(head)}</b>${text ? `<span>${esc(text)}</span>` : ""}</div>`;
  }

  function myRow(row) {
    const end = row.state === "pending"
      ? `<button type="button" class="feeds-pill" data-fr-act="cancel" data-fr-id="${esc(row.id)}">${esc(tr("Cancel"))}</button>`
      : `<span class="fr-state is-${esc(row.state)}">${esc(stateLabel(row.state))}</span>`;
    const note = row.note ? `<span class="fr-note">“${esc(row.note)}”</span>` : "";
    const date = row.state === "pending" ? tr("Asked {date}", { date: when(row.at) }) : tr("Answered {date}", { date: when(row.decidedAt || row.at) });
    return `<article class="feeds-row fr-row"><span class="feeds-who"><span class="feeds-face">${face(row)}</span><span class="feeds-copy"><span class="feeds-name">${esc(title(row))}</span><span class="feeds-sub">${esc(subline(row))}</span><span class="feeds-sub">${esc(date)}</span>${note}</span></span><span class="feeds-row-end">${end}</span></article>`;
  }

  function requestBox() {
    return `<form class="feeds-add fr-ask" data-fr-form="ask"><label class="search"><input name="input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(tr("Paste a link or @handle"))}" aria-label="${esc(tr("Source to request"))}"></label><button class="follow" type="submit">${esc(tr("Request"))}</button></form>
      <div class="fr-note-box"><input class="search" data-fr-field="note" maxlength="280" autocomplete="off" placeholder="${esc(tr("Add a note for the owner (optional)"))}" aria-label="${esc(tr("Note for the owner"))}"></div>`;
  }

  function myView() {
    const head = hooks.pageHead ? hooks.pageHead(tr("My source requests"), "", true) : "";
    if (!signedIn()) return head + empty(tr("Sign in to request a source."), tr("Only the owner adds sources. Signed-in accounts can ask for one."));
    if (ownerOn()) return head + `<div class="feeds-org">${empty(tr("You add sources directly."), "")}<a class="feeds-banner sl-link" href="#/settings/feed-requests"><span>${esc(tr("Source requests"))}</span><span aria-hidden="true">›</span></a></div>`;
    const mine = readMine();
    if (!mine || !mine.some((r) => r.input != null)) loadMine(true);
    const list = (mine || []).filter((r) => r.input != null);
    const groups = { pending: [], approved: [], rejected: [] };
    list.forEach((r) => {
      if (r.state === "pending") groups.pending.push(r);
      else if (r.state === "approved") groups.approved.push(r);
      else if (r.state === "rejected" || r.state === "banned") groups.rejected.push(r);
    });
    const tab = S.mineTab;
    const rows = groups[tab] || [];
    const bar = tabs([
      ["pending", tr("Pending") + (groups.pending.length ? " " + groups.pending.length : "")],
      ["approved", tr("Approved")],
      ["rejected", tr("Not approved")]
    ], tab, "mine-tab");
    const hint = `<p class="feeds-hint fr-hint">${esc(tr("Only the owner adds accounts and feeds. Ask for one here or with the Request button on its profile."))}</p>`;
    const body = rows.length ? rows.map(myRow).join("")
      : (S.mineLoading && !list.length ? empty(tr("Loading…"), "")
        : S.mineError && !list.length ? empty(S.mineError, "")
          : empty(tab === "pending" ? tr("No requests waiting") : tab === "approved" ? tr("Nothing approved yet") : tr("Nothing here"), tab === "pending" ? tr("Paste a link or @handle above to ask for a source.") : ""));
    return head + `<div class="feeds-org fr-page">${hint}${requestBox()}${bar}<section class="feeds-section fr-list">${body}</section></div>`;
  }

  /* ---------- owner ---------- */

  function loadCount(force) {
    if (!ownerOn() || !active()) return;
    if (!force && Date.now() - S.countAt < COUNT_MS) return;
    S.countAt = Date.now();
    api("/v1/owner/feed-requests/count").then((res) => {
      if (res.ok) {
        const next = Number(res.body.pending) || 0;
        if (next !== S.count) { S.count = next; paint(); }
      }
    });
  }

  function loadQueue(force) {
    if (S.queueLoading || !ownerOn()) return;
    if (S.queue && S.queue.state === S.queueState && !force) return;
    S.queueLoading = true;
    const state = S.queueState;
    api("/v1/owner/feed-requests?state=" + state).then((res) => {
      S.queueLoading = false;
      if (res.ok) {
        S.queue = { state, requests: res.body.requests || [], lists: res.body.lists || [] };
        S.queueError = "";
        S.count = Number(res.body.pending) || 0;
        S.countAt = Date.now();
        if (state === "pending" && Number(res.body.unseen) > 0) api("/v1/owner/feed-requests/seen", "POST", {});
      } else S.queueError = tr("Couldn’t load requests.");
      paint();
    });
  }

  function loadBans(force) {
    if (S.bansLoading || !ownerOn()) return;
    if (S.bans && !force) return;
    S.bansLoading = true;
    api("/v1/owner/feed-bans").then((res) => {
      S.bansLoading = false;
      S.bans = res.ok ? (res.body.bans || []) : [];
      paint();
    });
  }

  function destOptions(lists) {
    return [["everyone", tr("Everyone"), tr("Everyone who uses the app can follow it.")], ["requester", tr("Only who asked"), tr("Only the people who requested it.")]]
      .concat((lists || []).map((l) => ["list:" + l.id, tr("List: {name}", { name: l.name }), tr("People in this source list.")]))
      .concat([["new", tr("New list…"), tr("A new source list for the people you name.")]]);
  }
  function destOf(id) { return S.dest[id] || "everyone"; }
  function destLabel(id, lists) {
    const hit = destOptions(lists).find((o) => o[0] === destOf(id));
    return hit ? hit[1] : tr("Everyone");
  }
  /* X settings row: "Who can see it  Everyone ›", opens a bottom sheet. */
  function destPicker(row, lists) {
    const chev = hooks.icon ? hooks.icon("chevR") : "›";
    return `<button type="button" class="fr-dest" data-fr-act="dest-open" data-fr-id="${esc(row.id)}" aria-haspopup="dialog"><span class="fr-dest-copy"><span class="fr-dest-label">${esc(tr("Who can see it"))}</span><span class="fr-dest-value">${esc(destLabel(row.id, lists))}</span></span><span class="fr-dest-chev" aria-hidden="true">${chev}</span></button>`;
  }
  function membersField(row) {
    const d = destOf(row.id);
    const show = d === "new" || d.indexOf("list:") === 0;
    const value = S.members[row.id] || "";
    return `<label class="fr-float${value ? " has-value" : ""}"${show ? "" : " hidden"}><input data-fr-field="members" data-fr-id="${esc(row.id)}" value="${esc(value)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder=" "><span>${esc(tr("@usernames, comma separated"))}</span></label>`;
  }
  function sheetHtml() {
    const id = S.sheet;
    if (!id || !S.queue) return "";
    const lists = S.queue.lists || [];
    const current = destOf(id);
    const rows = destOptions(lists).map(([value, label, sub]) => `<button type="button" class="fr-sheet-row" role="radio" aria-checked="${value === current ? "true" : "false"}" data-fr-act="dest-pick" data-fr-id="${esc(id)}" data-fr-value="${esc(value)}"><span class="fr-sheet-copy"><b>${esc(label)}</b><span>${esc(sub)}</span></span><span class="fr-radio${value === current ? " on" : ""}" aria-hidden="true"></span></button>`).join("");
    return `<div class="fr-sheet-wrap" data-fr-act="dest-close"><div class="fr-sheet" role="dialog" aria-modal="true" aria-label="${esc(tr("Who can see it"))}"><span class="fr-grab" aria-hidden="true"></span><h2>${esc(tr("Who can see it"))}</h2><p>${esc(tr("Choose who gets this source when you allow it."))}</p><div role="radiogroup">${rows}</div><button type="button" class="fr-sheet-cancel" data-fr-act="dest-close">${esc(tr("Cancel"))}</button></div></div>`;
  }

  function requesterHtml(row) {
    const people = row.requesters || [];
    if (!people.length) return "";
    const faces = people.slice(0, 3).map((p) => `<span class="fr-mini">${hooks.avatar ? hooks.avatar(p.avatar || "", p.name || p.handle || "") : ""}</span>`).join("");
    const first = people[0];
    const names = people.length === 1
      ? tr("Asked by {name}", { name: first.name || first.handle || "" })
      : tr("Asked by {name} and {count} more", { name: first.name || first.handle || "", count: String(people.length - 1) });
    const notes = people.filter((p) => p.note).slice(0, 3).map((p) => `<li><b>${esc(p.name || p.handle || "")}</b> ${esc(p.note)}</li>`).join("");
    return `<div class="fr-who"><span class="fr-faces">${faces}</span><span>${esc(names)}</span></div>${notes ? `<ul class="fr-notes">${notes}</ul>` : ""}`;
  }

  function previewHtml(row) {
    const got = S.previews[row.id] || row.preview || [];
    if (!got.length) {
      return `<button type="button" class="fr-link" data-fr-act="preview" data-fr-id="${esc(row.id)}"${S.busy[row.id] === "preview" ? " disabled" : ""}>${esc(S.busy[row.id] === "preview" ? tr("Loading…") : tr("Show recent posts"))}</button>`;
    }
    return `<ol class="fr-preview">${got.slice(0, 3).map((p) => `<li>${esc(String(p.text || p.title || "").slice(0, 200))}</li>`).join("")}</ol>`;
  }

  function queueRow(row, lists, decided) {
    const busy = S.busy[row.id] && S.busy[row.id] !== "preview";
    const picked = !!S.picked[row.id];
    const check = decided ? "" : `<label class="feeds-check"><input type="checkbox" data-fr-act="pick" data-fr-id="${esc(row.id)}"${picked ? " checked" : ""} aria-label="${esc(tr("Select"))}"></label>`;
    const count = row.count > 1 ? `<span class="fr-count">${esc(tr("{count} requests", { count: String(row.count) }))}</span>` : "";
    const actions = decided
      ? `<span class="fr-state is-${esc(row.state)}">${esc(stateLabel(row.state))}${row.dest ? " · " + esc(row.dest === "everyone" ? tr("Everyone") : row.dest === "requester" ? tr("Only who asked") : tr("Source list")) : ""}</span>`
      : `<div class="fr-actions">${destPicker(row, lists)}${membersField(row)}
          <div class="fr-buttons"><button type="button" class="fr-pill is-accent" data-fr-act="allow" data-fr-id="${esc(row.id)}"${busy ? " disabled" : ""}>${S.busy[row.id] === "allow" ? `<span class="fr-spin" aria-hidden="true"></span>${esc(tr("Allowing…"))}` : esc(tr("Allow"))}</button>
          <button type="button" class="fr-pill" data-fr-act="block" data-fr-id="${esc(row.id)}"${busy ? " disabled" : ""}>${esc(tr("Block"))}</button>
          <button type="button" class="fr-pill is-danger" data-fr-act="ban" data-fr-id="${esc(row.id)}"${busy ? " disabled" : ""}>${esc(tr("Ban"))}</button></div></div>`;
    return `<article class="feeds-row fr-qrow${row.unseen && !decided ? " is-new" : ""}"${busy ? ' aria-busy="true"' : ""}>${check}<div class="fr-main">
      <span class="feeds-who"><span class="feeds-face">${face(row)}</span><span class="feeds-copy"><span class="feeds-name">${esc(title(row))}${count}</span><span class="feeds-sub">${esc(subline(row))}</span></span></span>
      ${requesterHtml(row)}
      ${decided ? "" : previewHtml(row)}
      ${actions}</div></article>`;
  }

  function ownerView(sub) {
    if (sub === "banned") return bansView();
    const head = hooks.settingsHead ? hooks.settingsHead(tr("Source requests"), "#/settings") : "";
    if (!ownerOn()) return head + empty(tr("Only the owner reviews requests."), "");
    loadQueue(false);
    const q = S.queue && S.queue.state === S.queueState ? S.queue : null;
    const decided = S.queueState === "decided";
    const lists = q ? q.lists : [];
    const bar = tabs([
      ["pending", tr("Pending") + (S.count ? " " + S.count : "")],
      ["decided", tr("Decided")],
      ["banned", tr("Banned")]
    ], S.queueState, "queue-tab");
    const ids = q && !decided ? q.requests.map((r) => r.id) : [];
    const picked = ids.filter((id) => S.picked[id]);
    const bulk = !decided && ids.length ? `<div class="feeds-bulk fr-bulk" role="region" aria-label="${esc(tr("Bulk actions"))}"><span>${esc(tr("{count} selected", { count: String(picked.length) }))}</span>
      <button type="button" class="fr-pill" data-fr-act="pick-all">${esc(picked.length === ids.length ? tr("Clear") : tr("Select all"))}</button>
      ${picked.length ? `<button type="button" class="fr-pill is-accent" data-fr-act="bulk" data-fr-do="allow">${esc(tr("Allow for everyone"))}</button><button type="button" class="fr-pill" data-fr-act="bulk" data-fr-do="block">${esc(tr("Block"))}</button><button type="button" class="fr-pill is-danger" data-fr-act="bulk" data-fr-do="ban">${esc(tr("Ban"))}</button>` : ""}</div>` : "";
    const hint = `<p class="feeds-hint fr-hint">${esc(tr("Only you add sources. Allow lets it in, Block says no for now, Ban stops it for good and removes copies."))}</p>`;
    let body;
    if (!q) body = empty(S.queueError || tr("Loading…"), "");
    else if (!q.requests.length) body = empty(decided ? tr("Nothing decided yet") : tr("No requests waiting"), decided ? "" : tr("When someone asks for an account or feed, it shows up here."));
    else body = q.requests.map((r) => queueRow(r, lists, decided)).join("");
    return head + `<div class="feeds-org fr-page fr-owner">${hint}${bar}${bulk}<section class="feeds-section fr-list">${body}</section></div>${sheetHtml()}`;
  }

  function bansView() {
    const head = hooks.settingsHead ? hooks.settingsHead(tr("Banned sources"), "#/settings/feed-requests") : "";
    if (!ownerOn()) return head + empty(tr("Only the owner reviews requests."), "");
    loadBans(false);
    const bar = tabs([
      ["pending", tr("Pending") + (S.count ? " " + S.count : "")],
      ["decided", tr("Decided")],
      ["banned", tr("Banned")]
    ], "banned", "queue-tab");
    const add = `<form class="feeds-add" data-fr-form="ban"><label class="search"><input name="input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(tr("Paste a link or @handle"))}" aria-label="${esc(tr("Source to ban"))}"></label><button class="follow is-danger" type="submit">${esc(tr("Ban"))}</button></form>`;
    const hint = `<p class="feeds-hint fr-hint">${esc(tr("Banned sources can’t be requested or added, and copies stop being fetched. Unban to let people ask again."))}</p>`;
    const rows = (S.bans || []).map((b) => `<article class="feeds-row fr-row"><span class="feeds-who"><span class="feeds-face">${face(b)}</span><span class="feeds-copy"><span class="feeds-name">${esc(b.name || b.input || b.key)}</span><span class="feeds-sub">${esc([platformName(b.platform), b.input && b.input !== b.name ? b.input : "", when(b.at)].filter(Boolean).join(" · "))}</span></span></span><span class="feeds-row-end"><button type="button" class="feeds-pill" data-fr-act="unban" data-fr-key="${esc(b.key)}">${esc(tr("Unban"))}</button></span></article>`).join("");
    const body = S.bans == null ? empty(tr("Loading…"), "") : rows || empty(tr("No banned sources"), "");
    return head + `<div class="feeds-org fr-page fr-owner">${hint}${bar}${add}<section class="feeds-section fr-list">${body}</section></div>`;
  }

  /* Row on the main Settings page. */
  function settingsRowHtml() {
    if (!active() || !signedIn()) return "";
    const chev = hooks.icon ? hooks.icon("chevR") : "›";
    if (ownerOn()) {
      loadCount(false);
      const badge = S.count ? `<span class="fr-badge" aria-label="${esc(tr("{count} waiting", { count: String(S.count) }))}">${S.count > 99 ? "99+" : S.count}</span>` : "";
      return `<a class="set-row" href="#/settings/feed-requests"><span class="set-copy"><b>${esc(tr("Source requests"))}</b><span class="set-sub">${esc(tr("Allow, block or ban accounts and feeds people ask for."))}</span></span>${badge}<span class="set-chev" aria-hidden="true">${chev}</span></a>`;
    }
    return `<a class="set-row" href="#/feeds/requests"><span class="set-copy"><b>${esc(tr("My source requests"))}</b><span class="set-sub">${esc(tr("Accounts and feeds you asked the owner to add."))}</span></span><span class="set-chev" aria-hidden="true">${chev}</span></a>`;
  }
  function pendingCount() { return ownerOn() ? S.count : 0; }

  /* ---------- actions ---------- */

  function fieldOf(name, id) {
    const el = document.querySelector(`[data-fr-field="${name}"]` + (id ? `[data-fr-id="${CSS.escape(id)}"]` : ""));
    return el ? String(el.value || "").trim() : "";
  }

  function destBody(id) {
    const dest = destOf(id);
    const members = String(S.members[id] || fieldOf("members", id) || "").split(/[\s,]+/).map((m) => m.replace(/^@/, "")).filter(Boolean);
    if (dest === "everyone") return { dest: "everyone" };
    if (dest === "requester") return { dest: "requester" };
    if (dest === "new") {
      const row = S.queue && S.queue.requests.find((r) => r.id === id);
      return { dest: "list", newList: tr("For {name}", { name: (row && title(row)) || "" }).slice(0, 60), members };
    }
    return { dest: "list", listId: dest.slice(5), members };
  }

  function decide(id, action) {
    if (action === "ban" && !window.confirm(tr("Ban this source? Nobody can request or add it again, and copies stop being fetched."))) return;
    const body = action === "allow" ? destBody(id) : {};
    S.busy[id] = action;
    paint();
    const row = S.queue && S.queue.requests.find((r) => r.id === id);
    const name = row ? title(row) : "";
    api("/v1/owner/feed-requests/" + encodeURIComponent(id) + "/" + action, "POST", body).then((res) => {
      delete S.busy[id];
      if (res.ok) {
        toast(action === "allow" ? (res.body.unverified ? tr("Allowed. Posts show up after the next sync.") : tr("Allowed")) : action === "block" ? tr("Blocked. It can be asked for again.") : tr("Banned"));
        delete S.dest[id];
        delete S.members[id];
        if (S.queue) S.queue.requests = S.queue.requests.filter((r) => r.id !== id);
        delete S.picked[id];
        if (res.body.pending != null) S.count = Number(res.body.pending) || 0;
        if (action === "ban") S.bans = null;
      } else {
        toast(decideFail(action, res, name));
        if (res.status === 404 && res.body && res.body.error === "not_found") loadQueue(true);
      }
      paint();
    });
  }

  /* A clear message for every way Allow, Block or Ban can fail. */
  function decideFail(action, res, name) {
    const code = (res && res.body && res.body.error) || "";
    if (res && res.status === 0) return code === "timeout" ? tr("The server took too long. Try again.") : tr("You’re offline. Check your connection and try again.");
    if (code === "banned") return tr("This source is banned. Unban it first.");
    if (code === "not_found" && res.status === 404 && !res.body.message) return tr("This request was already handled.");
    if (code === "full") return tr("The feed list is full.");
    if (code === "bad_list") return tr("Pick a list or name a new one.");
    if (code === "unsupported_tiktok") return tr("TikTok can’t go into a source list. Allow it for everyone or only who asked.");
    if (code === "bad_input" || code === "bad_feed" || code === "private_host" || code === "unsupported" || code === "unsupported_facebook" || code === "unsupported_discord") return tr("That link isn’t a source the app can read.");
    if (code === "rate_limited" || code === "rate" || (res && res.status === 429)) return tr("Too many changes. Try again in a minute.");
    if (code === "auth" || code === "forbidden" || (res && (res.status === 401 || res.status === 403))) return tr("Sign in again as the owner to do this.");
    if (action === "allow") return name ? tr("Couldn’t allow {name}. Try again.", { name }) : tr("Couldn’t allow it. Try again.");
    return tr("Couldn’t save. Try again.");
  }

  function bulk(action) {
    const ids = Object.keys(S.picked).filter((id) => S.picked[id]);
    if (!ids.length) return;
    if (action === "ban" && !window.confirm(tr("Ban {count} sources? Nobody can request or add them again.", { count: String(ids.length) }))) return;
    ids.forEach((id) => { S.busy[id] = action; });
    paint();
    api("/v1/owner/feed-requests/bulk", "POST", { ids, action, dest: "everyone" }).then((res) => {
      ids.forEach((id) => { delete S.busy[id]; });
      if (res.ok) {
        const done = new Set((res.body.results || []).filter((r) => r.ok).map((r) => r.id));
        if (S.queue) S.queue.requests = S.queue.requests.filter((r) => !done.has(r.id));
        done.forEach((id) => { delete S.picked[id]; });
        if (res.body.pending != null) S.count = Number(res.body.pending) || 0;
        const failed = (res.body.results || []).filter((r) => !r.ok);
        if (failed.length) {
          const first = failed[0];
          const why = decideFail(action, { ok: false, status: first.error === "banned" ? 403 : 400, body: { error: first.error, message: "x" } }, "");
          toast(tr("{done} updated, {failed} couldn’t be: {why}", { done: String(done.size), failed: String(failed.length), why }));
        } else toast(tr("{count} updated", { count: String(done.size) }));
        if (action === "ban") S.bans = null;
      } else toast(decideFail(action, res, ""));
      paint();
    });
  }

  function preview(id) {
    S.busy[id] = "preview";
    paint();
    api("/v1/owner/feed-requests/" + encodeURIComponent(id) + "/preview", "POST", {}).then((res) => {
      delete S.busy[id];
      const posts = res.ok && res.body.request && Array.isArray(res.body.request.preview) ? res.body.request.preview : [];
      S.previews[id] = posts.length ? posts : [{ text: tr("No recent posts to show.") }];
      if (res.ok && res.body.request && S.queue) {
        const row = S.queue.requests.find((r) => r.id === id);
        if (row) { row.name = res.body.request.name || row.name; row.avatar = res.body.request.avatar || row.avatar; }
      }
      paint();
    });
  }

  function onClick(event) {
    const btn = event.target && event.target.closest ? event.target.closest("[data-fr-act]") : null;
    if (!btn || !hooks || btn.tagName === "INPUT") return;
    event.preventDefault();
    event.stopPropagation();
    const act = btn.dataset.frAct;
    const id = btn.dataset.frId || "";
    if (act === "request") {
      btn.disabled = true;
      submit(id).then((state) => {
        btn.disabled = false;
        if (state === "allowed" && hooks.follow) hooks.follow(id);
        paint();
      });
      return;
    }
    if (act === "cancel-key") {
      const row = findMine(id);
      if (row && window.confirm(tr("Cancel this request?"))) cancel(row.id);
      return;
    }
    if (act === "cancel") { cancel(id); return; }
    if (act === "mine-tab") { S.mineTab = btn.dataset.frTab; paint(); return; }
    if (act === "queue-tab") {
      const tab = btn.dataset.frTab;
      if (tab === "banned") { location.hash = "#/settings/feed-requests/banned"; return; }
      S.queueState = tab;
      S.picked = {};
      if (/\/banned$/.test(location.hash)) location.hash = "#/settings/feed-requests";
      loadQueue(true);
      paint();
      return;
    }
    if (act === "allow" || act === "block" || act === "ban") { decide(id, act); return; }
    if (act === "dest-open") { S.sheet = id; paint(); focusSheet(); return; }
    if (act === "dest-close") {
      if (btn.classList.contains("fr-sheet-wrap") && event.target !== btn) return;
      closeSheet();
      return;
    }
    if (act === "dest-pick") {
      S.dest[id] = btn.dataset.frValue || "everyone";
      closeSheet();
      if (S.dest[id] === "new" || S.dest[id].indexOf("list:") === 0) {
        setTimeout(() => { const el = document.querySelector(`[data-fr-field="members"][data-fr-id="${CSS.escape(id)}"]`); if (el) el.focus(); }, 0);
      }
      return;
    }
    if (act === "preview") { preview(id); return; }
    if (act === "pick-all") {
      const ids = S.queue ? S.queue.requests.map((r) => r.id) : [];
      const all = ids.length && ids.every((rid) => S.picked[rid]);
      S.picked = {};
      if (!all) ids.forEach((rid) => { S.picked[rid] = true; });
      paint();
      return;
    }
    if (act === "bulk") { bulk(btn.dataset.frDo); return; }
    if (act === "unban") {
      const key = btn.dataset.frKey || "";
      api("/v1/owner/feed-bans/" + encodeURIComponent(key), "DELETE").then((res) => {
        if (res.ok) { S.bans = res.body.bans || []; toast(tr("Unbanned")); } else toast(tr("Couldn’t save. Try again."));
        paint();
      });
    }
  }

  function closeSheet() {
    const back = S.sheet;
    S.sheet = "";
    paint();
    if (back) setTimeout(() => { const el = document.querySelector(`[data-fr-act="dest-open"][data-fr-id="${CSS.escape(back)}"]`); if (el) el.focus(); }, 0);
  }
  function focusSheet() {
    setTimeout(() => { const el = document.querySelector('.fr-sheet [aria-checked="true"]') || document.querySelector(".fr-sheet-row"); if (el) el.focus(); }, 0);
  }
  function onKey(event) {
    if (S.sheet && event.key === "Escape") { event.preventDefault(); closeSheet(); }
  }
  function onInput(event) {
    const el = event.target;
    if (!el || !el.dataset || el.dataset.frField !== "members") return;
    S.members[el.dataset.frId] = el.value;
    const wrap = el.closest(".fr-float");
    if (wrap) wrap.classList.toggle("has-value", !!el.value);
  }

  function onChange(event) {
    const el = event.target;
    if (!el || !el.dataset) return;
    if (el.dataset.frAct === "pick") {
      S.picked[el.dataset.frId] = !!el.checked;
      paint();
      return;
    }
  }

  function onSubmit(event) {
    const form = event.target && event.target.closest ? event.target.closest("form[data-fr-form]") : null;
    if (!form || !hooks) return;
    event.preventDefault();
    event.stopPropagation();
    const input = form.querySelector("input[name=input]");
    const raw = input ? String(input.value || "").trim() : "";
    if (!raw) return;
    if (form.dataset.frForm === "ask") {
      submit(raw, { note: fieldOf("note") }).then((state) => {
        if (state) { form.reset(); const note = document.querySelector('[data-fr-field="note"]'); if (note) note.value = ""; S.mineTab = state === "pending" ? "pending" : S.mineTab; }
        if (state === "allowed") toast(tr("Already allowed. Follow it from its profile."));
        paint();
      });
      return;
    }
    if (form.dataset.frForm === "ban") {
      if (!window.confirm(tr("Ban this source? Nobody can request or add it again, and copies stop being fetched."))) return;
      api("/v1/owner/feed-bans", "POST", { input: raw }).then((res) => {
        if (res.ok) { S.bans = res.body.bans || []; form.reset(); toast(tr("Banned")); } else toast(failText(res.body));
        paint();
      });
    }
  }

  function attach(next) {
    hooks = next || hooks;
    if (attach.bound) return;
    attach.bound = true;
    document.addEventListener("click", onClick, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => {
      if (!signedIn() || !active()) return;
      if (ownerOn()) loadCount(true);
      else loadMine(false);
      checkBans(false);
    }, 4000);
  }

  window.FeedRequests = {
    attach, active, asks, submit, cancel, stateFor, buttonHtml, gateButton, gateAdd, noteRequested,
    myView, ownerView, settingsRowHtml, pendingCount, checkBans, loadMine, hashOf
  };
})();
