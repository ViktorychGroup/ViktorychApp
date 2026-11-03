/* Owner account inspector ("Cuentas"). Owner only, and the Worker enforces it
   (/v1/owner/inspector/*: 403 for anyone else). Lists every account on the
   site with all its usernames, including hidden ones, and opens one account's
   details for moderation. Opening details writes an audit row on the Worker.
   Never shows passwords, tokens, passkey keys, recovery codes, message text or
   the private nicknames other people set. Nothing here is cached on the device.
     #/settings/accounts-inspector          list, search, sort, filter
     #/settings/accounts-inspector/<id>     one account
     #/settings/accounts-inspector/audit    who was opened, and when */
(function () {
  let hooks = null;
  const S = {
    q: "", sort: "created", filter: "all",
    list: null, listKey: "", loading: false, error: "", more: false, totals: null,
    detail: {}, detailLoading: {}, detailError: {},
    audit: null, auditLoading: false, sheet: null
  };
  function kindLabel(k) {
    const words = { person: tr("Person"), business: tr("Business"), organization: tr("Organization"), media: tr("Media"), government: tr("Government"), creator: tr("Creator"), bot: tr("Bot"), community: tr("Community"), other: tr("Other") };
    return k ? (words[k] || k) : tr("Their choice");
  }
  const KINDS = ["", "person", "business", "organization", "media", "government", "creator", "bot", "community", "other"];

  function tr(key, vars) { return hooks && hooks.tr ? hooks.tr(key, vars) : key; }
  function esc(value) { return hooks && hooks.esc ? hooks.esc(value) : String(value == null ? "" : value); }
  function icon(name) { return hooks && hooks.icon ? hooks.icon(name) : ""; }
  function ownerOn() { return !!(hooks && hooks.accountToken && hooks.accountToken() && hooks.signedOwner && hooks.signedOwner()); }
  function paint() { if (hooks && hooks.render) hooks.render(); }
  function toast(text) { if (hooks && hooks.toast && text) hooks.toast(text); }

  function api(path, method, body) {
    const base = hooks.accountsApi();
    const headers = { Authorization: "Bearer " + hooks.accountToken() };
    if (body) headers["content-type"] = "application/json";
    return fetch(base + path, { method: method || "GET", headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store", credentials: "omit" })
      .then((res) => res.json().then((data) => ({ ok: res.ok, status: res.status, body: data || {} })).catch(() => ({ ok: res.ok, status: res.status, body: {} })))
      .catch(() => ({ ok: false, status: 0, body: { error: "offline" } }));
  }

  function failText(res) {
    if (res.status === 403 || res.status === 401) return tr("Only the owner can see this.");
    if (res.status === 204) return tr("Owner inspector is switched off.");
    if (res.status === 0) return tr("You're offline. Try again when you're connected.");
    return tr("Couldn’t load. Try again.");
  }

  function when(ms) {
    if (!ms) return tr("Never");
    try { return hooks.relTime ? hooks.relTime(new Date(ms).toISOString()) : new Date(ms).toLocaleString(); }
    catch (err) { return ""; }
  }
  function date(ms) {
    if (!ms) return "—";
    try { return new Date(ms).toLocaleDateString(hooks.lang ? hooks.lang() : undefined, { year: "numeric", month: "short", day: "numeric" }); }
    catch (err) { return new Date(ms).toISOString().slice(0, 10); }
  }
  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }
  function num(n) { return n == null ? "—" : String(n); }
  function grouped(id) { return String(id || "").replace(/(\d{4})(?=\d)/g, "$1 "); }
  function face(row) {
    if (hooks.avatar) return hooks.avatar(row.avatar || "", row.name || row.handle || "", "oi-ava", true);
    return `<span class="oi-ava">${esc(String(row.name || row.handle || "?").slice(0, 1))}</span>`;
  }

  /* ---------- list ---------- */

  function listKey() { return [S.q, S.sort, S.filter].join("|"); }
  function loadList(force, append) {
    if (!ownerOn() || S.loading) return;
    const key = listKey();
    if (!force && !append && S.list && S.listKey === key) return;
    S.loading = true;
    const offset = append && S.list ? S.list.length : 0;
    const qs = "?q=" + encodeURIComponent(S.q) + "&sort=" + S.sort + "&filter=" + S.filter + "&offset=" + offset;
    api("/v1/owner/inspector/accounts" + qs).then((res) => {
      S.loading = false;
      if (listKey() !== key) { loadList(true); return; }
      if (!res.ok || res.status === 204) { S.error = failText(res); S.list = S.list || []; paint(); return; }
      S.error = "";
      S.listKey = key;
      const rows = Array.isArray(res.body.accounts) ? res.body.accounts : [];
      S.list = append && S.list ? S.list.concat(rows) : rows;
      S.more = !!res.body.more;
      S.totals = res.body.totals || null;
      paint();
    });
  }

  function chip(label, on, attrs) {
    return `<button type="button" class="oi-chip${on ? " on" : ""}" aria-pressed="${on ? "true" : "false"}" ${attrs}>${esc(label)}</button>`;
  }

  function rowHtml(r) {
    const tags = [];
    if (r.owner) tags.push(`<span class="oi-tag oi-tag-owner">${esc(tr("Owner"))}</span>`);
    if (r.online) tags.push(`<span class="oi-tag oi-tag-on">${esc(tr("Online"))}</span>`);
    if (r.hiddenNames) tags.push(`<span class="oi-tag">${esc((String(r.hiddenNames) === "1" ? tr("1 hidden username") : tr("{count} hidden usernames", { count: String(r.hiddenNames) })))}</span>`);
    else if (r.extraNames) tags.push(`<span class="oi-tag">${esc((String(r.extraNames) === "1" ? tr("1 more username") : tr("{count} more usernames", { count: String(r.extraNames) })))}</span>`);
    if (r.friendsOff) tags.push(`<span class="oi-tag">${esc(tr("Friends off"))}</span>`);
    if (r.lockedFollows) tags.push(`<span class="oi-tag oi-tag-lock">${icon("lock")}${esc((String(r.lockedFollows) === "1" ? tr("1 locked follow") : tr("{count} locked follows", { count: String(r.lockedFollows) })))}</span>`);
    if (r.extraDisplayNames) tags.push(`<span class="oi-tag">${esc(tr("Several display names"))}</span>`);
    if (r.protected) tags.push(`<span class="oi-tag">${esc(tr("Protected"))}</span>`);
    if (r.temporary) tags.push(`<span class="oi-tag">${esc(tr("Temporary"))}</span>`);
    if (r.reports) tags.push(`<span class="oi-tag oi-tag-warn">${esc((String(r.reports) === "1" ? tr("1 report") : tr("{count} reports", { count: String(r.reports) })))}</span>`);
    const sub = [tr("Joined {date}", { date: date(r.createdAt) }), tr("Active {when}", { when: when(r.activeAt) }), tr("{count} followers", { count: String(r.followers) }), tr("{count} posts", { count: String(r.posts) })].join(" · ");
    return `<a class="oi-row" href="#/settings/accounts-inspector/${encodeURIComponent(r.id)}"><span class="oi-face">${face(r)}${r.online ? '<i class="oi-dot" aria-hidden="true"></i>' : ""}</span><span class="oi-copy"><span class="oi-name"><b>${esc(r.name || r.handle)}</b><span class="oi-handle">@${esc(r.handle)}</span></span><span class="oi-sub">${esc(sub)}</span>${tags.length ? `<span class="oi-tags">${tags.join("")}</span>` : ""}</span><span class="oi-chev" aria-hidden="true">${icon("chevR")}</span></a>`;
  }

  function listView() {
    loadList(false);
    const sorts = [["created", tr("Newest")], ["active", tr("Last active")], ["handle", tr("Username")], ["followers", tr("Followers")], ["posts", tr("Posts")], ["reports", tr("Reports")]];
    const filters = [["all", tr("All")], ["online", tr("Online")], ["hidden_names", tr("Hidden usernames")], ["extra_names", tr("Several usernames")], ["extra_display", tr("Several display names")], ["friends_off", tr("Friends off")], ["locked_follows", tr("Locked follows")], ["protected", tr("Protected")], ["reported", tr("Reported")], ["temporary", tr("Temporary")]];
    const totals = S.totals ? `<p class="oi-totals">${esc((String(S.totals.accounts) === "1" ? tr("1 account") : tr("{count} accounts", { count: String(S.totals.accounts) })))} · ${esc(tr("{count} online now", { count: String(S.totals.online) }))}</p>` : "";
    const search = `<form class="oi-search" data-oi-form="search"><label class="search"><span class="sr">${icon("search")}</span><input id="oi-q" type="search" name="q" value="${esc(S.q)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(tr("Search name, any username or account ID"))}" aria-label="${esc(tr("Search accounts"))}"></label></form>`;
    const filterBar = `<div class="oi-chips" role="group" aria-label="${esc(tr("Filter"))}">${filters.map((f) => chip(f[1], S.filter === f[0], `data-oi-act="filter" data-oi-v="${f[0]}"`)).join("")}</div>`;
    const sortName = (sorts.find((x) => x[0] === S.sort) || sorts[0])[1];
    const sortBar = `<button type="button" class="oi-sort" data-oi-act="open-sort" aria-haspopup="dialog"><span>${esc(tr("Sort by"))}</span><b>${esc(sortName)}</b>${icon("chevR")}</button>`;
    let body;
    if (S.list == null) body = `<p class="oi-empty">${esc(tr("Loading…"))}</p>`;
    else if (S.error) body = `<div class="oi-empty"><p>${esc(S.error)}</p><button type="button" class="oi-btn" data-oi-act="retry">${esc(tr("Retry"))}</button></div>`;
    else if (!S.list.length) body = `<p class="oi-empty">${esc(tr("No accounts match"))}</p>`;
    else body = S.list.map(rowHtml).join("") + (S.more ? `<button type="button" class="oi-more" data-oi-act="more">${esc(S.loading ? tr("Loading…") : tr("Show more"))}</button>` : "");
    const note = `<p class="oi-note">${icon("lock")}<span>${esc(tr("Only you see this. Privacy settings don’t hide usernames from the owner. Opening an account is logged."))}</span></p>`;
    const audit = `<a class="oi-audit-link" href="#/settings/accounts-inspector/audit">${esc(tr("Access log"))}</a>`;
    S.sorts = sorts;
    return `<div class="oi-page">${note}${search}<div class="oi-bar">${filterBar}</div><div class="oi-bar oi-bar-sort">${sortBar}</div><div class="oi-meta">${totals}${audit}</div><section class="oi-list">${body}</section></div>`;
  }

  /* ---------- detail ---------- */

  function loadDetail(id, force) {
    if (!ownerOn() || S.detailLoading[id]) return;
    if (S.detail[id] && !force) return;
    S.detailLoading[id] = true;
    api("/v1/owner/inspector/accounts/" + encodeURIComponent(id)).then((res) => {
      S.detailLoading[id] = false;
      if (!res.ok || res.status === 204) { S.detailError[id] = res.status === 404 ? tr("This account doesn’t exist.") : failText(res); paint(); return; }
      S.detailError[id] = "";
      S.detail[id] = res.body;
      paint();
    });
  }

  function audienceText(a) {
    if (!a) return "";
    let text;
    if (a.level === "public") text = tr("Everyone");
    else if (a.level === "followers") text = tr("Followers");
    else if (a.level === "friends") text = tr("Friends");
    else if (a.level === "custom") text = tr("Custom: {lists} lists, {people} people", { lists: String(a.lists || 0), people: String(a.people || 0) });
    else text = tr("Only them");
    if (a.excludes) text += " · " + tr("{count} excluded", { count: String(a.excludes) });
    return text;
  }

  function line(label, value) {
    return `<div class="oi-line"><span class="oi-k">${esc(label)}</span><span class="oi-v">${value}</span></div>`;
  }
  function section(title, inner) {
    return `<section class="oi-sec"><h2>${esc(title)}</h2>${inner}</section>`;
  }
  function stat(n, label) { return `<span class="oi-stat"><b>${esc(num(n))}</b> ${esc(label)}</span>`; }

  const SIGNIN = () => ({ account_number: tr("Account number"), passkey: tr("Passkey"), recovery_codes: tr("Recovery codes"), tv_code: tr("TV code") });
  const LINK_STATE = () => ({ verified: tr("Verified"), linked: tr("Linked"), played: tr("Played"), alerts: tr("Alerts on"), on: tr("On") });
  const LEVEL_WORD = () => ({ online: tr("Online"), away: tr("Away"), busy: tr("Busy"), offline: tr("Offline"), hidden: tr("Hidden"), everyone: tr("Everyone"), followers: tr("Followers"), friends: tr("Friends"), nobody: tr("Nobody") });
  const STATE_WORD = () => ({ pending: tr("Pending"), allowed: tr("Allowed"), approved: tr("Allowed"), blocked: tr("Not approved"), banned: tr("Banned"), open: tr("Open"), hidden: tr("Hidden"), dismissed: tr("Dismissed") });
  function word(map, key) { return map[key] || String(key || "—"); }

  function detailView(id) {
    loadDetail(id, false);
    const d = S.detail[id];
    if (!d) {
      const err = S.detailError[id];
      return `<div class="oi-page">${err ? `<div class="oi-empty"><p>${esc(err)}</p><button type="button" class="oi-btn" data-oi-act="retry-detail" data-oi-id="${esc(id)}">${esc(tr("Retry"))}</button></div>` : `<p class="oi-empty">${esc(tr("Loading…"))}</p>`}</div>`;
    }
    const lw = LEVEL_WORD();
    const sw = STATE_WORD();
    const banner = d.banner ? `<div class="oi-banner" style="background-image:url('${esc(d.banner)}')"></div>` : `<div class="oi-banner"></div>`;
    const head = `<div class="oi-hero">${banner}<div class="oi-hero-row"><span class="oi-hero-face">${face(d)}</span><a class="oi-btn" href="#/@${encodeURIComponent(d.handle)}">${esc(tr("View profile"))}</a></div><div class="oi-hero-copy"><b class="oi-hero-name">${esc(d.name || d.handle)}</b><span class="oi-handle">@${esc(d.handle)}</span>${d.bio ? `<p class="oi-bio">${esc(d.bio)}</p>` : ""}<p class="oi-sub">${esc(tr("Joined {date}", { date: date(d.createdAt) }))} · ${d.online ? `<span class="oi-on">${esc(tr("Online now"))}</span>` : esc(tr("Active {when}", { when: when(d.lastActive) }))}</p><p class="oi-stats">${stat(d.counts.following, tr("Following"))}${stat(d.counts.followers, tr("Followers"))}${stat(d.counts.friends, tr("Friends"))}</p></div></div>`;

    const names = section(tr("Usernames"), d.names.map((n) => `<div class="oi-name-row"><span class="oi-name-handle">@${esc(n.handle)}${n.primary ? ` <span class="oi-tag">${esc(tr("Primary"))}</span>` : ""}${n.audience && n.audience.hidden ? ` <span class="oi-tag oi-tag-lock">${icon("lock")}${esc(tr("Hidden"))}</span>` : ""}</span><span class="oi-name-aud">${esc(audienceText(n.audience))}</span></div>`).join(""));
    const dnames = (d.displayNames || []).length > 1 || ((d.displayNames || [])[0] && (d.displayNames[0].audience || {}).hidden) ? section(tr("Display names"), d.displayNames.map((n) => `<div class="oi-name-row"><span class="oi-name-handle">${esc(n.name)}${n.primary ? ` <span class="oi-tag">${esc(tr("Primary"))}</span>` : ""}${n.audience && n.audience.hidden ? ` <span class="oi-tag oi-tag-lock">${icon("lock")}${esc(tr("Hidden"))}</span>` : ""}</span><span class="oi-name-aud">${esc(audienceText(n.audience))}</span></div>`).join("")) : "";

    const pp = d.people || null;
    const AUD = () => ({ everyone: tr("Everyone"), followers: tr("Followers"), friends: tr("Friends"), mutuals: tr("Mutuals"), nobody: tr("Nobody"), me: tr("Only them"), fof: tr("Friends of friends") });
    const peopleRow = (key, label, n) => `<button type="button" class="set-row oi-act-row" data-oi-act="open-people" data-oi-id="${esc(d.id)}" data-oi-v="${key}" aria-haspopup="dialog"><span class="set-copy"><b>${esc(label)}</b><span class="set-sub">${esc(num(n))}</span></span><span class="set-chev" aria-hidden="true">${icon("chevR")}</span></button>`;
    const people = pp ? `<section class="oi-sec oi-sec-rows"><h2>${esc(tr("Friends and follows"))}</h2><p class="oi-sheet-sub oi-sec-sub">${esc(tr("Everything, including friendships, follows and lists the person hid."))}</p>${[
      peopleRow("friends", tr("Friends"), d.counts.friends),
      peopleRow("followers", tr("Followers"), d.counts.followers),
      peopleRow("following", tr("Following"), d.counts.following),
      (pp.lockedFollows.count || pp.lockedFollows.lockSet) ? peopleRow("lockedFollowing", tr("Locked follows"), pp.lockedFollows.count) : ""
    ].join("")}<div class="oi-sec-lines">${[
      line(tr("Friends switch"), esc(pp.friendsSetting.on ? tr("On") : tr("Off"))),
      line(tr("Who can send requests"), esc(word(AUD(), pp.friendsSetting.whoCanRequest))),
      line(tr("Who sees the friends list"), esc(word(AUD(), pp.friendsSetting.listAudience))),
      line(tr("Shares online status"), esc(pp.friendsSetting.shareOnline ? tr("On") : tr("Off"))),
      (pp.friends || []).some((f) => f.privacy) ? line(tr("Private friendships"), esc(String((pp.friends || []).filter((f) => f.privacy).length))) : "",
      line(tr("Friend requests"), esc(tr("{in} received · {out} sent", { in: String(num(pp.requestsIn)), out: String(num(pp.requestsOut)) }))),
      (pp.lockedFollows.count || pp.lockedFollows.lockSet) ? line(tr("Locked follows"), esc(String(pp.lockedFollows.count) + (pp.lockedFollows.lockSet ? " · " + tr("Lock set") : ""))) : ""
    ].join("")}</div></section>` : "";

    const extras = d.extras ? Object.keys(d.extras).map((k) => {
      const v = d.extras[k] || {};
      const rows = Object.keys(v).filter((x) => v[x] == null || typeof v[x] !== "object" || Array.isArray(v[x])).map((x) => line(x.replace(/_/g, " "), esc(Array.isArray(v[x]) ? String(v[x].length) : typeof v[x] === "boolean" ? (v[x] ? tr("On") : tr("Off")) : String(v[x])))).join("");
      return section(k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), rows || `<p class="oi-empty-sm">—</p>`);
    }).join("") : "";

    const idRow = `<span class="oi-mono">${esc(grouped(d.id))}</span> <button type="button" class="oi-link" data-oi-act="copy-id" data-oi-id="${esc(d.id)}">${esc(tr("Copy"))}</button>`;
    const emailRow = d.email && d.email.stored && d.email.address
      ? `<button type="button" class="oi-link oi-masked" data-oi-act="reveal" data-oi-full="${esc(d.email.address)}">${esc(String(d.email.address).replace(/^(.).*(@.*)$/, "$1•••$2"))}</button>${d.email.verified ? ` <span class="oi-tag">${esc(tr("Verified"))}</span>` : ""}`
      : esc(tr("None on file"));
    const account = section(tr("Account"), [
      line(tr("Display name"), esc(d.name || "—")),
      line(tr("Account ID"), idRow),
      line(tr("Created"), esc(date(d.createdAt))),
      line(tr("Last active"), esc(d.online ? tr("Online now") : when(d.lastActive))),
      line(tr("Sign-in methods"), esc((d.signIn || []).map((m) => SIGNIN()[m] || m).join(", "))),
      line(tr("Email"), emailRow),
      line(tr("Language"), esc(d.language ? d.language.toUpperCase() : "—")),
      line(tr("Setup"), esc(d.setupDone ? tr("Finished") : tr("Not finished"))),
      line(tr("Account type"), esc([d.kind.own ? kindLabel(d.kind.own) : "", d.kind.owner ? tr("owner set: {kind}", { kind: kindLabel(d.kind.owner) }) : ""].filter(Boolean).join(" · ") || "—"))
    ].join(""));

    const privacy = section(tr("Privacy settings"), [
      line(tr("Protected posts"), esc(d.profile.protected ? tr("On") : tr("Off"))),
      line(tr("Private followers and following"), esc(d.profile.privateFollows ? tr("On") : tr("Off"))),
      line(tr("Profile hidden"), esc(d.profile.profileLess ? tr("On") : tr("Off"))),
      d.presence ? line(tr("Online status"), esc(word(lw, d.presence.preference) + " · " + tr("last seen: {who}", { who: word(lw, d.presence.lastSeenPrivacy) }))) : ""
    ].join(""));

    const linkedKeys = Object.keys(d.linked || {});
    const linked = section(tr("Linked services"), linkedKeys.length ? linkedKeys.map((k) => line(k.charAt(0).toUpperCase() + k.slice(1), esc(word(LINK_STATE(), d.linked[k])))).join("") : `<p class="oi-empty-sm">${esc(tr("Nothing linked"))}</p>`);

    const c = d.counts;
    const activity = section(tr("Activity"), `<div class="oi-grid">${[
      [c.posts, tr("Posts")], [c.replies, tr("Replies")], [c.reposts, tr("Reposts")], [c.communityPosts, tr("Community posts")],
      [c.hiddenPosts, tr("Hidden posts")], [c.messagesSent, tr("Messages sent")], [c.audienceLists, tr("Audience lists")], [d.communities.length, tr("Communities")]
    ].map((p) => `<div class="oi-cell"><b>${esc(num(p[0]))}</b><span>${esc(p[1])}</span></div>`).join("")}</div>`);

    const communities = d.communities.length ? section(tr("Communities joined"), `<div class="oi-chips oi-chips-wrap">${d.communities.map((m) => `<span class="oi-chip">${esc(m.id)}</span>`).join("")}</div>`) : "";

    const requests = section(tr("Source requests"), d.requests.length ? d.requests.map((r) => line(r.name || r.platform || "—", esc(word(sw, r.state) + " · " + when(r.at)))).join("") : `<p class="oi-empty-sm">${esc(tr("No requests"))}</p>`);

    const m = d.moderation;
    const reportsByStatus = Object.keys(d.reports.byStatus || {}).map((k) => word(sw, k) + " " + d.reports.byStatus[k]).join(", ");
    const moderation = section(tr("Moderation"), [
      line(tr("Reports against them"), esc(String(d.reports.total) + (reportsByStatus ? " (" + reportsByStatus + ")" : ""))),
      line(tr("Reports they filed"), esc(num(d.reportsFiled))),
      line(tr("Blocked by"), esc((String(num(m.blockedBy)) === "1" ? tr("1 account") : tr("{count} accounts", { count: String(num(m.blockedBy)) })))),
      line(tr("Muted by"), esc((String(num(m.mutedBy)) === "1" ? tr("1 account") : tr("{count} accounts", { count: String(num(m.mutedBy)) })))),
      line(tr("Blocking"), esc((String(num(m.blocking)) === "1" ? tr("1 account") : tr("{count} accounts", { count: String(num(m.blocking)) })))),
      line(tr("Server bans"), esc(num(m.serverBans))),
      line(tr("Community Notes"), esc(m.notesBanned ? tr("Banned") : tr("OK"))),
      m.temporary ? line(tr("Temporary account"), esc(tr("Ends {date}", { date: date(m.tempUntil) }))) : ""
    ].join(""));

    const devices = section(tr("Sessions and storage"), [
      line(tr("Signed-in sessions"), esc(num(d.sessions.active))),
      line(tr("Devices"), esc(String(d.sessions.devices) + (d.sessions.types.length ? " · " + d.sessions.types.join(", ") : ""))),
      line(tr("Passkeys"), esc(num(d.passkeys))),
      line(tr("Recovery codes left"), esc(num(d.recoveryCodesLeft))),
      line(tr("Post media"), esc(bytes(d.storage.mediaBytes))),
      line(tr("Drive"), esc(bytes(d.storage.driveBytes))),
      line(tr("Synced settings"), esc(bytes(d.storage.settingsBytes)))
    ].join(""));

    const st = d.settings;
    const settings = st ? section(tr("Settings summary"), [
      line(tr("Theme"), esc(st.appearance || "—")),
      line(tr("Autoplay"), esc(st.autoplay || "—")),
      line(tr("Notifications"), esc(st.notifications ? tr("On") : tr("Off"))),
      line(tr("Zero trace"), esc(st.zeroTrace ? tr("On") : tr("Off"))),
      line(tr("Follows"), esc(num(st.follows))),
      line(tr("Lists"), esc(num(st.lists))),
      line(tr("Custom tabs"), esc(num(st.feedTabs))),
      line(tr("Muted words"), esc(num(st.mutedWords))),
      line(tr("Last synced"), esc(when(st.syncedAt)))
    ].join("")) : "";

    const kindNow = d.kind.owner ? kindLabel(d.kind.owner) : tr("Their choice");
    const actRow = (attrs, title, sub, tag) => `<${tag || "button type=\"button\""} class="set-row oi-act-row" ${attrs}><span class="set-copy"><b>${esc(title)}</b>${sub ? `<span class="set-sub">${esc(sub)}</span>` : ""}</span><span class="set-chev" aria-hidden="true">${icon("chevR")}</span></${tag ? "a" : "button"}>`;
    const actions = `<section class="oi-sec oi-sec-rows"><h2>${esc(tr("Owner actions"))}</h2>${[
      actRow(`href="#/@${encodeURIComponent(d.handle)}"`, tr("View profile"), "", "a"),
      actRow('data-acct="open-reports"', tr("Review reports"), ""),
      actRow(`data-oi-act="copy-id" data-oi-id="${esc(d.id)}"`, tr("Copy account ID"), ""),
      actRow(`data-oi-act="open-kind" data-oi-id="${esc(d.id)}" aria-haspopup="dialog"`, tr("Account type"), kindNow)
    ].join("")}</section>`;

    const foot = `<p class="oi-note oi-note-foot">${icon("lock")}<span>${esc(d.audited ? tr("This view was logged in the access log.") : tr("Only you see this."))}</span></p>`;
    return `<div class="oi-page oi-detail">${head}${names}${dnames}${people}${account}${privacy}${linked}${activity}${communities}${requests}${moderation}${devices}${settings}${extras}${actions}${foot}</div>`;
  }

  /* ---------- audit ---------- */

  function auditWhat(action, at) {
    const a = String(action || "view");
    if (a.indexOf("names:") === 0) return tr("Saw hidden display names {when}", { when: at });
    if (a.indexOf("locked:") === 0) return tr("Saw locked follows {when}", { when: at });
    if (/friend/.test(a)) return tr("Saw hidden friendships {when}", { when: at });
    return tr("Opened {when}", { when: at });
  }
  function auditView() {
    if (S.audit == null && !S.auditLoading) {
      S.auditLoading = true;
      api("/v1/owner/inspector/audit").then((res) => { S.auditLoading = false; S.audit = res.ok && res.body.rows ? res.body.rows : []; paint(); });
    }
    const rows = S.audit == null ? `<p class="oi-empty">${esc(tr("Loading…"))}</p>`
      : !S.audit.length ? `<p class="oi-empty">${esc(tr("No accounts opened yet"))}</p>`
      : S.audit.map((r) => `<a class="oi-row" href="#/settings/accounts-inspector/${encodeURIComponent(r.id)}"><span class="oi-copy"><span class="oi-name"><b>@${esc(r.handle || r.id)}</b></span><span class="oi-sub">${esc(auditWhat(r.action, when(r.at)))}</span></span></a>`).join("");
    return `<div class="oi-page"><p class="oi-note">${icon("lock")}<span>${esc(tr("Every time you open an account's details it is written here."))}</span></p><section class="oi-list">${rows}</section></div>`;
  }

  /* ---------- X-style bottom sheets (sort, account type, confirm) ---------- */

  function radioRow(act, value, label, on, extra) {
    return `<button type="button" class="oi-opt" role="radio" aria-checked="${on ? "true" : "false"}" data-oi-act="${act}" data-oi-v="${esc(value)}" ${extra || ""}><span>${esc(label)}</span><i class="oi-radio${on ? " on" : ""}" aria-hidden="true"></i></button>`;
  }
  function sheetHtml() {
    const sh = S.sheet;
    if (!sh) return "";
    let title = "", body = "", foot = "";
    if (sh.type === "sort") {
      title = tr("Sort by");
      body = `<div role="radiogroup">${(S.sorts || []).map((x) => radioRow("pick-sort", x[0], x[1], S.sort === x[0])).join("")}</div>`;
      foot = `<button type="button" class="oi-pill oi-pill-outline" data-oi-act="close-sheet">${esc(tr("Cancel"))}</button>`;
    } else if (sh.type === "kind") {
      const d = S.detail[sh.id];
      const cur = d ? (d.kind.owner || "") : "";
      title = tr("Account type");
      body = `<p class="oi-sheet-sub">${esc(tr("Shown on their profile. “Their choice” keeps what they picked."))}</p><div role="radiogroup">${KINDS.map((k) => radioRow("pick-kind", k, kindLabel(k), cur === k, `data-oi-id="${esc(sh.id)}"`)).join("")}</div>`;
      foot = `<button type="button" class="oi-pill oi-pill-outline" data-oi-act="close-sheet">${esc(tr("Cancel"))}</button>`;
    } else if (sh.type === "people") {
      const d = S.detail[sh.id];
      const pp = d && d.people ? d.people : {};
      const rows = Array.isArray(pp[sh.list]) ? pp[sh.list] : [];
      const titles = { friends: tr("Friends"), followers: tr("Followers"), following: tr("Following"), lockedFollowing: tr("Locked follows") };
      title = titles[sh.list] || tr("Friends");
      body = rows.length ? `<div class="oi-people">${rows.map((p) => {
        const label = p.handle ? "@" + p.handle : String(p.target || p.id || "—");
        const inner = `<span class="set-copy"><b>${esc(p.name || label)}</b><span class="set-sub">${esc(label)}${p.at ? " · " + esc(date(p.at)) : ""}</span></span>${p.locked ? `<span class="oi-tag oi-tag-lock">${icon("lock")}${esc(tr("Locked"))}</span>` : ""}${p.privacy ? `<span class="oi-tag oi-tag-lock">${icon("lock")}${esc(tr("Private friendship"))}</span>` : ""}`;
        return p.id && p.handle ? `<a class="set-row oi-person" href="#/settings/accounts-inspector/${encodeURIComponent(p.id)}" data-oi-act="close-sheet-go">${inner}</a>` : `<div class="set-row oi-person">${inner}</div>`;
      }).join("")}</div>${rows.length >= (pp.max || 500) ? `<p class="oi-sheet-sub">${esc(tr("Showing the first {count}", { count: String(pp.max || 500) }))}</p>` : ""}` : `<p class="oi-sheet-sub">${esc(tr("No one here"))}</p>`;
      foot = `<button type="button" class="oi-pill oi-pill-outline" data-oi-act="close-sheet">${esc(tr("Close"))}</button>`;
    } else if (sh.type === "confirm") {
      title = tr("Change account type?");
      body = `<p class="oi-sheet-sub">${esc(tr("Change this account’s type to “{kind}”?", { kind: kindLabel(sh.kind) }))}</p>`;
      foot = `<button type="button" class="oi-pill oi-pill-accent" data-oi-act="save-kind" data-oi-id="${esc(sh.id)}"${sh.busy ? " disabled" : ""}>${esc(sh.busy ? tr("Saving…") : tr("Change"))}</button><button type="button" class="oi-pill oi-pill-outline" data-oi-act="close-sheet">${esc(tr("Cancel"))}</button>`;
    }
    return `<div class="oi-sheet-wrap" data-oi-act="close-sheet"><div class="oi-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}" data-oi-stop="1"><div class="oi-grab" aria-hidden="true"></div><h3>${esc(title)}</h3>${body}<div class="oi-sheet-foot">${foot}</div></div></div>`;
  }

  function view(sub) {
    const id = String(sub || "");
    const back = id ? "#/settings/accounts-inspector" : "#/settings";
    const title = id === "audit" ? tr("Access log") : id ? (S.detail[id] ? "@" + S.detail[id].handle : tr("Account")) : tr("Accounts");
    const head = hooks.settingsHead ? hooks.settingsHead(title, back) : "";
    if (!ownerOn()) return head + `<p class="oi-empty">${esc(tr("Only the owner can see this."))}</p>`;
    if (id === "audit") { S.sheet = null; return head + auditView(); }
    if (S.sheet && S.sheet.id && S.sheet.id !== id) S.sheet = null;
    if (id) return head + detailView(id) + sheetHtml();
    if (S.sheet && S.sheet.type !== "sort") S.sheet = null;
    return head + listView() + sheetHtml();
  }

  function settingsRowHtml() {
    if (!ownerOn()) return "";
    return `<a class="set-row" href="#/settings/accounts-inspector"><span class="set-copy"><b>${esc(tr("Accounts"))}</b><span class="set-sub">${esc(tr("Every account on the site, with all usernames and details, for moderation."))}</span></span><span class="set-chev" aria-hidden="true">${icon("chevR")}</span></a>`;
  }

  /* ---------- events ---------- */

  function copy(text) {
    const done = () => toast(tr("Account ID copied"));
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
    else done();
  }

  function onClick(event) {
    const btn = event.target && event.target.closest ? event.target.closest("[data-oi-act]") : null;
    if (!btn || !hooks) return;
    const inner = event.target.closest("[data-oi-stop]");
    if (btn.classList.contains("oi-sheet-wrap") && inner) return;
    event.preventDefault();
    const act = btn.dataset.oiAct;
    if (act === "filter") { S.filter = btn.dataset.oiV || "all"; S.list = null; loadList(true); paint(); return; }
    if (act === "retry") { S.error = ""; S.list = null; loadList(true); paint(); return; }
    if (act === "more") { loadList(false, true); paint(); return; }
    if (act === "retry-detail") { const id = btn.dataset.oiId; S.detailError[id] = ""; loadDetail(id, true); paint(); return; }
    if (act === "copy-id") { copy(btn.dataset.oiId || ""); return; }
    if (act === "reveal") { btn.textContent = btn.dataset.oiFull || ""; btn.classList.remove("oi-masked"); return; }
    if (act === "close-sheet") { S.sheet = null; paint(); return; }
    if (act === "close-sheet-go") { S.sheet = null; location.hash = btn.getAttribute("href"); return; }
    if (act === "open-people") { S.sheet = { type: "people", id: btn.dataset.oiId, list: btn.dataset.oiV || "friends" }; paint(); return; }
    if (act === "open-sort") { S.sheet = { type: "sort" }; paint(); return; }
    if (act === "pick-sort") { S.sheet = null; if (S.sort !== btn.dataset.oiV) { S.sort = btn.dataset.oiV || "created"; S.list = null; loadList(true); } paint(); return; }
    if (act === "open-kind") { S.sheet = { type: "kind", id: btn.dataset.oiId }; paint(); return; }
    if (act === "pick-kind") {
      const id = btn.dataset.oiId;
      const d = S.detail[id];
      const kind = btn.dataset.oiV || "";
      if (d && (d.kind.owner || "") === kind) { S.sheet = null; paint(); return; }
      S.sheet = { type: "confirm", id, kind };
      paint();
      return;
    }
    if (act === "save-kind") {
      const sh = S.sheet;
      if (!sh || sh.type !== "confirm" || sh.busy) return;
      const id = sh.id;
      const kind = sh.kind;
      const d = S.detail[id];
      sh.busy = true;
      paint();
      api("/v1/owner/account-kind", "PUT", { id, kind }).then((res) => {
        S.sheet = null;
        if (res.ok) { if (d) d.kind.owner = kind; toast(tr("Saved")); } else toast(tr("Couldn’t save. Try again."));
        paint();
      });
    }
  }

  let typing = null;
  function onInput(event) {
    const el = event.target;
    if (!el || el.id !== "oi-q") return;
    clearTimeout(typing);
    typing = setTimeout(() => {
      S.q = String(el.value || "").trim();
      S.list = null;
      loadList(true);
      paint();
      const again = document.getElementById("oi-q");
      if (again) { again.focus(); try { again.setSelectionRange(again.value.length, again.value.length); } catch (err) {} }
    }, 350);
  }
  function onChange(event) {
    const el = event.target;
    if (!el || !el.dataset) return;
  }
  function onSubmit(event) {
    const form = event.target && event.target.closest ? event.target.closest("form[data-oi-form]") : null;
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector("input[name=q]");
    S.q = input ? String(input.value || "").trim() : "";
    S.list = null;
    loadList(true);
    paint();
  }

  function attach(next) {
    hooks = next || hooks;
    if (attach.bound) return;
    attach.bound = true;
    document.addEventListener("click", onClick, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && S.sheet) { S.sheet = null; paint(); } }, true);
  }

  window.OwnerInspector = { attach, view, settingsRowHtml };
})();
