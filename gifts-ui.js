/* Viktorychs (earned, never sold), the gift store and sticker packs.
   Prices come from shared/store-catalog.js; balances, ownership and payments
   state come from the worker. Nothing here waits on the network to draw. */
(function (root) {
  "use strict";

  var balance = null;
  var rules = [];
  var history = [];
  var catalog = [];
  var gifts = null;
  var sheet = null;
  var errorText = "";
  var started = false;
  var viewedHandle = "";
  var shop = null;
  var shopLoading = false;
  var orders = null;
  var ownerNote = "";

  function tn(key, n, vars) { var f = (typeof window !== "undefined" && window.tn) || (typeof self !== "undefined" && self.tn); return f ? f(key, n, vars) : String(n); }
  function tr(key, vars) {
    var fn = root.t || (typeof window !== "undefined" && window.t);
    var text = fn ? fn(key, vars) : key;
    if (!fn && vars) {
      Object.keys(vars).forEach(function (name) {
        text = String(text).split("{" + name + "}").join(String(vars[name]));
      });
    }
    return text;
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function token() {
    try { return root.ViktorychAccounts && root.ViktorychAccounts.token ? root.ViktorychAccounts.token() : ""; }
    catch (err) { return ""; }
  }

  function call(path, opts) {
    if (!root.ViktorychAccounts || !root.ViktorychAccounts.call) return Promise.resolve({ status: 503 });
    return root.ViktorychAccounts.call(path, opts || {});
  }

  function redraw() {
    paintBalance();
    if (root.ViktorychAccounts && root.ViktorychAccounts.requestRender) root.ViktorychAccounts.requestRender();
  }

  function paintBalance() {
    if (typeof document === "undefined") return;
    var nodes = document.querySelectorAll("[data-points-balance]");
    nodes.forEach(function (node) {
      node.textContent = balance == null ? "" : String(balance);
    });
  }

  function loadPoints() {
    var auth = token();
    if (!auth) return Promise.resolve();
    return call("/v1/points", { token: auth }).then(function (body) {
      if (!body || body.status !== 200) return;
      balance = Number(body.balance) || 0;
      rules = body.rules || [];
      history = body.history || [];
      paintBalance();
    }).catch(function () {});
  }

  function loadCatalog() {
    return call("/v1/gifts/catalog", { token: token() }).then(function (body) {
      if (body && body.gifts) catalog = body.gifts;
      if (body && body.trending && body.trending.length) {
        store.trending = body.trending;
        try { root.localStorage.setItem("vk-gift-trending", JSON.stringify(body.trending)); } catch (err) { /* private mode */ }
      }
    }).catch(function () {});
  }

  function loadShop() {
    if (shopLoading) return Promise.resolve();
    shopLoading = true;
    return call("/v1/store/catalog", { token: token() }).then(function (body) {
      shopLoading = false;
      if (!body || !body.tiers) return;
      shop = body;
      if (body.balance != null) balance = Number(body.balance) || 0;
      redraw();
    }).catch(function () { shopLoading = false; });
  }

  /* Daily visit, reading and game points are awarded at most once per UTC
     day, so a reload, a second tab or another visit the same day has nothing
     to ask for. Each touch is remembered on this device until the day ends,
     or until the server's wait ends when it paced us. */
  var touching = {};
  function touchWho() {
    try {
      var acct = root.ViktorychAccounts && root.ViktorychAccounts.account && root.ViktorychAccounts.account();
      if (acct && acct.publicId) return String(acct.publicId);
    } catch (err) { /* fall back to the token */ }
    return String(token()).slice(-12);
  }
  function touchKey(action, gameId) {
    return "vk-points-touch:" + touchWho() + ":" + action + ":" + (gameId || "");
  }
  function dayEnd(now) {
    var d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
  function touchHeld(key, now) {
    try { return Number(root.localStorage.getItem(key) || 0) > now; } catch (err) { return false; }
  }
  function touchHold(key, until) {
    try { root.localStorage.setItem(key, String(until)); } catch (err) { /* private mode */ }
  }

  function touch(action, gameId) {
    var auth = token();
    if (!auth) return Promise.resolve(false);
    var key = touchKey(action, gameId);
    var now = Date.now();
    if (touchHeld(key, now)) return Promise.resolve(false);
    if (touching[key]) return touching[key];
    touching[key] = call("/v1/points/touch", { method: "POST", token: auth, body: { action: action, gameId: gameId || "" } }).then(function (body) {
      delete touching[key];
      var code = body && body.status;
      if (code === 200) touchHold(key, dayEnd(Date.now()));
      else if (code === 429) touchHold(key, Date.now() + Math.max(60, Number(body.retry) || 0) * 1000 + 15 * 60 * 1000);
      if (body && body.balance != null) balance = Number(body.balance) || 0;
      paintBalance();
      return code === 200 && Number(body.awarded) > 0;
    }).catch(function () { delete touching[key]; return false; });
    return touching[key];
  }

  function start() {
    if (started) return;
    started = true;
    loadCatalog();
    loadPoints().then(function () {
      var gained = false;
      touch("login").then(function (got) { gained = gained || got; return touch("read"); }).then(function (got) {
        if (gained || got) return loadPoints();
      });
    });
  }

  function reasonLabel(reason) {
    if (reason === "quality_post") return tr("A quality post");
    if (reason === "popular_post") return tr("A popular post");
    if (reason === "grant") return tr("Granted by the app owner");
    if (reason === "stickers") return tr("Bought a sticker pack");
    if (reason === "status_emoji") return tr("Bought a status emoji");
    if (reason === "badge") return tr("Badge reward");
    if (reason === "signup") return tr("Sign-up bonus");
    if (reason === "login") return tr("Login streak");
    if (reason === "read") return tr("Reading streak");
    if (reason === "post") return tr("Posting");
    if (reason === "comment") return tr("Commenting");
    if (reason === "repost") return tr("Reposting");
    if (reason === "like_in") return tr("A like on your post");
    if (reason === "reply_in") return tr("A reply to you");
    if (reason === "follow") return tr("Following an account");
    if (reason === "profile") return tr("Finishing your profile");
    if (reason === "invite") return tr("An invite who became active");
    if (reason === "game") return tr("Playing a game");
    if (reason === "gift") return tr("Sent a gift");
    if (reason === "birthday") return tr("Birthday bonus");
    return tr("Viktorychs");
  }

  function giftName(id) {
    if (id === "heart") return tr("Heart gift");
    if (id === "star") return tr("Star gift");
    if (id === "spark") return tr("Spark gift");
    if (id === "leaf") return tr("Leaf gift");
    if (id === "comet") return tr("Comet gift");
    if (id === "crown") return tr("Crown gift");
    if (id === "cake") return tr("Cake gift");
    if (id === "candle") return tr("Candle gift");
    return tr("Gift");
  }

  function svg(path) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="' + path + '"/></svg>';
  }

  function coin() {
    return '<svg class="vk-coin" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="currentColor"/><circle cx="12" cy="12" r="8" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.2"/><path fill="#fff" d="M7.6 7h2.3l2.1 6.6L14.1 7h2.3l-3.3 10h-2.2z"/></svg>';
  }

  function vks(n) {
    return '<span class="vk-amount">' + coin() + "<b>" + esc(String(n)) + '</b><span class="vk-sr">' + esc(tr("Viktorychs")) + "</span></span>";
  }

  function ruleText(rule) {
    if (rule.id === "login") {
      return tr("Streak milestones: {list}", { list: (rule.milestones || []).map(function (m) { return tr("{d} days +{n}", { d: String(m.days), n: String(m.points) }); }).join(", ") });
    }
    if (rule.id === "quality_post") return tr("+{n} when 3 different people reply or like · up to {cap} a day", { n: String(rule.points), cap: String(rule.cap) });
    if (rule.id === "popular_post") return tr("+{n} more at 10 different people · up to {cap} a day", { n: String(rule.points), cap: String(rule.cap) });
    if (rule.id === "invite") return tr("+{n} once they stay a week, post and keep a streak · up to {cap} a day", { n: String(rule.points), cap: String(rule.cap) });
    return tr("+{n} once", { n: String(rule.points) });
  }

  function pointsPage() {
    var earn = rules.map(function (rule) {
      var extra = rule.streak ? " · " + tr("streak bonus up to {n}", { n: String(rule.streak) }) : "";
      return "<li><b>" + esc(reasonLabel(rule.id)) + "</b><span>" + esc(tn("viktorychs", rule.points, { count: String(rule.points) })) + esc(extra) + "</span></li>";
    }).join("");
    var rows = history.map(function (item) {
      var sign = item.delta > 0 ? "+" : "";
      return '<div class="points-row"><span>' + esc(reasonLabel(item.reason)) + '</span><b>' + esc(sign + item.delta) + "</b></div>";
    }).join("");
    return '<div class="points-page"><div class="topbar"><div class="page-head"><button type="button" class="icon-btn" data-act="back" aria-label="' + esc(tr("Back")) + '">' + icon("back") + '</button><h1 class="grow">' + esc(tr("Viktorychs")) + '</h1></div></div><div class="points-balance">' + coin() + '<b data-points-balance>' + esc(balance == null ? "0" : String(balance)) + '</b><span>' + esc(tr("Viktorychs")) + '</span></div><p class="points-note">' + esc(tr("Viktorychs are earned by real effort and are never sold. They have no cash value and can only be spent on gifts and stickers.")) + '</p><a class="points-store" href="#/store">' + esc(tr("Gifts")) + '</a><h2>' + esc(tr("How to earn")) + '</h2><ul class="points-earn">' + earn + '</ul><p class="points-note">' + esc(tr("Only people other than you count, and their accounts must be at least a week old. New accounts start earning after 3 days. Daily caps apply.")) + "</p><h2>" + esc(tr("History")) + "</h2>" + (rows || '<p class="points-note">' + esc(tr("No points yet")) + "</p>") + "</div>";
  }

  /* ---- Gifts page (VK-style shelves). Art comes from shared/gift-catalog.js. ---- */
  var store = { sub: "", query: "", searching: false, histTab: "received", received: null, sent: null, trending: null };
  try { store.trending = JSON.parse(root.localStorage.getItem("vk-gift-trending") || "null"); } catch (err) { store.trending = null; }

  function lib() { return root.GiftCatalog || null; }

  function sectionTitle(id) {
    if (id === "popular") return tr("Popular");
    if (id === "trending") return tr("Trending");
    if (id === "free") return tr("Free");
    if (id === "premium") return tr("Premium");
    if (id === "warm") return tr("Warm wishes");
    if (id === "party") return tr("Party");
    if (id === "love") return tr("In love");
    if (id === "flowers") return tr("Flowers");
    if (id === "cute") return tr("Cute");
    if (id === "birthday") return tr("Birthday");
    if (id === "treats") return tr("Treats");
    if (id === "halloween") return tr("Halloween");
    if (id === "christmas") return tr("Christmas");
    if (id === "newyear") return tr("New Year");
    if (id === "valentine") return tr("Valentine’s Day");
    if (id === "womensday") return tr("Women’s Day");
    if (id === "easter") return tr("Easter");
    if (id === "midsummer") return tr("Midsummer");
    if (id === "autumn") return tr("Autumn");
    if (id === "spring") return tr("Spring");
    if (id === "summer") return tr("Summer");
    if (id === "history") return tr("Gift history");
    if (id === "limited") return tr("Limited editions");
    if (id === "stickers") return tr("Sticker packs");
    if (id === "emojis") return tr("Status emojis");
    if (id === "orders") return tr("My purchases");
    if (id === "terms") return tr("Purchase terms");
    if (id === "owner") return tr("Owner tools");
    return tr("Gifts");
  }

  var ICON = {
    back: "M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20v-2z",
    clock: "M13 3a9 9 0 0 0-9 9H1l3.9 3.9L9 12H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.25 2.52.77-1.28-3.52-2.09V8H12z",
    search: "M10.5 3a7.5 7.5 0 0 1 5.96 12.05l4.25 4.24-1.42 1.42-4.24-4.25A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z",
    chevron: "M9.3 5.3 10.7 3.9 18.8 12l-8.1 8.1-1.4-1.4 6.7-6.7z",
    close: "M18.3 5.7 16.9 4.3 12 9.2 7.1 4.3 5.7 5.7l4.9 4.9-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z",
    popular: "M12 2c1 3.5 5 5.6 5 10.5a5 5 0 0 1-10 0c0-1.6.6-3 1.6-4 .1 1.6 1 2.6 2 3C10 8.5 11.2 5.2 12 2zm0 3.9c-.6 1.8-1.3 3.7-.7 6.3l.3 1.3-1.3-.3a3.6 3.6 0 0 1-1.6-.8A3 3 0 0 0 9 12.5a3 3 0 0 0 6 0c0-3-1.9-4.8-3-6.6z",
    free: "M20 7h-2.2A3 3 0 0 0 12 4.4 3 3 0 0 0 6.2 7H4a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1zm-5-1a1 1 0 1 1 0 2h-2a2 2 0 0 1 2-2zM9 6a2 2 0 0 1 2 2H9a1 1 0 1 1 0-2zM5 9h6v1H5V9zm1 3h5v7H6v-7zm7 7v-7h5v7h-5zm6-9h-6V9h6v1z",
    premium: "M7 3h10l4 6-9 12L3 9l4-6zm1.1 2L5.8 8.5h3.1L10.4 5H8.1zm5.5 0 1.5 3.5h3.1L15.9 5h-2.3zm-1.6.3L10.8 8.5h2.4L12 5.3zM6 10.5l4.6 6.1-1.8-6.1H6zm4.9 0L12 15.9l1.1-5.4h-2.2zm4.3 0-1.8 6.1 4.6-6.1h-2.8z",
    warm: "M11 1h2v3h-2V1zm0 19h2v3h-2v-3zM1 11h3v2H1v-2zm19 0h3v2h-3v-2zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4-2.1-2.1zm12.1 12.1 1.4-1.4 2.1 2.1-1.4 1.4-2.1-2.1zM18.4 4.2l1.4 1.4-2.1 2.1-1.4-1.4 2.1-2.1zM6.3 16.3l1.4 1.4-2.1 2.1-1.4-1.4 2.1-2.1zM12 6a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
    party: "M3 21l5.2-14.4 9.2 9.2L3 21zm4.3-4.3-1 2.9 2.9-1-1.9-1.9zm1.6-4.7-.9 2.6 3.5 3.5 2.6-.9-5.2-5.2zM14 2h2v3h-2V2zm5.6 2 1.4 1.4-2.1 2.1-1.4-1.4L19.6 4zM19 9h3v2h-3V9zm-6.2-2.8 1.4 1.4-1.4 1.4-1.4-1.4 1.4-1.4z",
    love: "M12 21s-8.5-5.1-8.5-11.2A4.8 4.8 0 0 1 12 6.5a4.8 4.8 0 0 1 8.5 3.3C20.5 15.9 12 21 12 21zm0-2.4c2.4-1.6 6.5-5 6.5-8.8a2.8 2.8 0 0 0-5.2-1.5L12 10l-1.3-1.7a2.8 2.8 0 0 0-5.2 1.5c0 3.8 4.1 7.2 6.5 8.8z",
    flowers: "M12 2a3.5 3.5 0 0 1 3.4 4.4 3.5 3.5 0 0 1 3 5.6 3.5 3.5 0 0 1-3 5.6A3.5 3.5 0 0 1 12 22a3.5 3.5 0 0 1-3.4-4.4 3.5 3.5 0 0 1-3-5.6 3.5 3.5 0 0 1 3-5.6A3.5 3.5 0 0 1 12 2zm0 2a1.5 1.5 0 0 0-1.4 2l.6 1.9-1.9-.3a1.5 1.5 0 0 0-1.2 2.6l1.5 1.3-1.5 1.3a1.5 1.5 0 0 0 1.2 2.6l1.9-.3-.6 1.9a1.5 1.5 0 1 0 2.8 0l-.6-1.9 1.9.3a1.5 1.5 0 0 0 1.2-2.6l-1.5-1.3 1.5-1.3a1.5 1.5 0 0 0-1.2-2.6l-1.9.3.6-1.9A1.5 1.5 0 0 0 12 4zm0 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z",
    cute: "M12 2a8 8 0 0 1 8 8v11l-2.7-1.6L14.7 21 12 19.4 9.3 21l-2.6-1.6L4 21V10a8 8 0 0 1 8-8zm0 2a6 6 0 0 0-6 6v7.4l.7-.4 2.6 1.6L12 17l2.7 1.6 2.6-1.6.7.4V10a6 6 0 0 0-6-6zM9 9a1.3 1.3 0 1 1 0 2.6A1.3 1.3 0 0 1 9 9zm6 0a1.3 1.3 0 1 1 0 2.6A1.3 1.3 0 0 1 15 9zm-5 4h4a2 2 0 0 1-4 0z",
    birthday: "M11 1.5c1 1.2 2 2.2 2 3.3a1.5 1.5 0 0 1-1 1.4V8h5a3 3 0 0 1 3 3v9h1v2H3v-2h1v-9a3 3 0 0 1 3-3h4V6.2a1.5 1.5 0 0 1-1-1.4c0-1.1 1-2.1 1-3.3zM7 10a1 1 0 0 0-1 1v2.4c.6.4 1.3.4 2 0a3.3 3.3 0 0 1 4 0c.6.4 1.4.4 2 0a3.3 3.3 0 0 1 4 0V11a1 1 0 0 0-1-1H7zm-1 5.6V20h12v-4.4a3.3 3.3 0 0 1-3 0c-.6-.4-1.4-.4-2 0a3.3 3.3 0 0 1-4 0c-.6-.4-1.4-.4-2 0a3.3 3.3 0 0 1-1 .4z",
    treats: "M4 8h13v2h1a3 3 0 0 1 0 6h-1.3A7 7 0 0 1 4 13V8zm2 2v3a5 5 0 0 0 10 0v-3H6zm11 2v2h1a1 1 0 0 0 0-2h-1zM7 2h2v4H7V2zm4 1h2v3h-2V3zM3 20h15v2H3v-2z"
  };

  function icon(name) {
    return '<svg class="vkg-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="' + (ICON[name] || "") + '"/></svg>';
  }

  /* Art for one gift: static Noto PNG, or the animated one when big is set.
     A failed image falls back (see the error listener below). */
  function artHtml(item, big) {
    var c = lib();
    if (!item) return "";
    var own = c && c.localArt ? c.localArt(item.base || item.giftId || item.id) : "";
    if (own) return '<img class="vkg-img is-own" src="' + esc(own) + '"' + (item.cp ? ' data-gift-art="' + esc(item.cp) + '"' : "") + ' alt="" loading="lazy" decoding="async" draggable="false">';
    if (!item.cp || !c) return item.svg ? svg(item.svg) : "";
    var src = big && item.anim ? c.animatedArt(item.cp) : c.staticArt(item.cp);
    return '<img class="vkg-img" src="' + esc(src) + '" data-gift-art="' + esc(item.cp) + '" alt="" loading="lazy" decoding="async" draggable="false" referrerpolicy="no-referrer">';
  }

  function giftLabel(item) {
    if (!item) return tr("Gift");
    return item.name ? tr(item.name) : giftName(item.id);
  }

  function allGifts() {
    var c = lib();
    if (c && c.GIFTS) return c.GIFTS;
    return catalog;
  }

  function findGift(id) {
    var found = null;
    allGifts().forEach(function (item) { if (item.id === id) found = item; });
    if (!found) catalog.forEach(function (item) { if (item.id === id) found = item; });
    var sc = storeLib();
    var limited = !found && sc ? sc.limitedById(id) : null;
    if (limited) {
      var base = null;
      allGifts().forEach(function (item) { if (item.id === limited.base) base = item; });
      found = { id: limited.id, base: limited.base, name: limited.name, cp: base ? base.cp : "", anim: base ? base.anim : false, limited: true };
    }
    return found;
  }

  function onShelf(item) {
    var c = lib();
    return c && item.cats ? c.onShelf(item) : true;
  }

  function giftsFor(id) {
    var c = lib();
    var list = allGifts();
    if (!c || !list.length || !list[0].cats) return id === "all" ? list : [];
    if (id === "popular" || id === "trending") {
      var ids = (store.trending && store.trending.length ? store.trending : c.POPULAR) || [];
      return ids.map(function (gid) { return c.giftById(gid); }).filter(function (item) { return item && onShelf(item); });
    }
    if (c.SEASONS[id]) return list.filter(function (item) { return item.cats.indexOf(id) >= 0; });
    return list.filter(function (item) { return c.inCategory(item, id) && onShelf(item); });
  }

  function storeLib() { return root.StoreCatalog || null; }

  function money(cents) {
    var value = (Number(cents) || 0) / 100;
    var cur = shop && shop.payments && shop.payments.currency ? String(shop.payments.currency).toUpperCase() : "EUR";
    try { return new Intl.NumberFormat(root.SI18n && root.SI18n.locale ? root.SI18n.locale() : undefined, { style: "currency", currency: cur }).format(value); }
    catch (err) { return "€" + value.toFixed(2); }
  }

  function priceOf(kind, id) {
    var sc = storeLib();
    return sc ? sc.storeItem(kind, id) : null;
  }

  function priceTags(item) {
    if (!item) return "";
    if (item.tier === "free") return '<span class="vkg-price is-free">' + esc(tr("Free")) + "</span>";
    var parts = [];
    if (item.viktorychs > 0) parts.push(vks(item.viktorychs));
    if (item.cents > 0) parts.push('<span class="vk-money">' + esc(money(item.cents)) + "</span>");
    return '<span class="vkg-price">' + parts.join('<span class="vk-or">·</span>') + "</span>";
  }

  function paymentsOn() {
    return !!(shop && shop.payments && shop.payments.enabled);
  }

  function limitedLeft(id) {
    var row = null;
    (shop && shop.limited || []).forEach(function (item) { if (item.id === id) row = item; });
    return row ? Math.max(0, row.limit - row.sold) : null;
  }

  function priceLabel(item) {
    if (!item) return "";
    var priced = priceOf("gift", item.id);
    if (priced) return priceTags(priced);
    if (Number(item.price) === 0) return '<span class="vkg-price is-free">' + esc(tr("Free")) + "</span>";
    return '<span class="vkg-price">' + esc(tn("viktorychs", item.price, { count: String(item.price) })) + "</span>";
  }

  function hueStyle(item) {
    var c = lib();
    if (!c || !c.artHue || !item) return "";
    return ' style="--h:' + Number(c.artHue(item.id)) + '"';
  }

  function tierMark(priced) {
    if (!priced || priced.tier !== "premium") return "";
    return '<span class="vkg-tier" title="' + esc(tr("Premium")) + '">' + icon("premium") + '<span class="vk-sr">' + esc(tr("Premium")) + "</span></span>";
  }

  function tile(item) {
    var priced = priceOf("gift", item.id);
    var left = item.limited ? limitedLeft(item.id) : null;
    var badge = item.limited ? '<span class="vkg-limited">' + esc(left == null ? tr("Limited") : left > 0 ? tr("{n} left", { n: String(left) }) : tr("Sold out")) + "</span>" : "";
    return '<button type="button" class="gift-card vkg-item' + (item.limited ? " is-limited" : "") + '" data-gift="pick" data-gift-id="' + esc(item.id) + '" aria-label="' + esc(giftLabel(item)) + '"><span class="vkg-art"' + hueStyle(item.base ? { id: item.base } : item) + '>' + artHtml(item, false) + tierMark(priced) + badge + "</span>" + priceLabel(item) + "</button>";
  }

  function limitedItems() {
    var sc = storeLib();
    if (!sc) return [];
    return sc.LIMITED.filter(function (item) { return sc.limitedOpen(item); }).map(function (item) { return findGift(item.id); }).filter(Boolean);
  }

  function limitedShelf() {
    var items = limitedItems();
    if (!items.length) return "";
    return '<section class="vkg-shelf" data-shelf="limited"><a class="vkg-shelf-head" href="#/store/limited"><h2>' + esc(sectionTitle("limited")) + "</h2>" + icon("chevron") + '</a><div class="vkg-row">' + items.map(tile).join("") + "</div></section>";
  }

  /* ---- Sticker packs ---- */
  function ownedPacks() {
    var sc = storeLib();
    var owned = [];
    if (shop && shop.stickers) shop.stickers.forEach(function (pack) { if (pack.owned) owned.push(pack.id); });
    else if (sc) sc.STICKER_PACKS.forEach(function (pack) { if (pack.tier === "free") owned.push(pack.id); });
    return owned;
  }

  function stickerArt(itemId) {
    var c = lib();
    var src = c && c.localArt ? c.localArt(itemId) : "";
    if (!src) return "";
    return '<img class="vks-img" src="' + esc(src) + '" alt="" loading="lazy" decoding="async" draggable="false">';
  }

  function stickerHtml(pack, itemId) {
    var sc = storeLib();
    if (!sc || !sc.validSticker(pack, itemId)) return "";
    return '<span class="vk-sticker" role="img" aria-label="' + esc(tr("Sticker")) + '">' + stickerArt(itemId) + "</span>";
  }

  function packCard(pack) {
    var owned = ownedPacks().indexOf(pack.id) >= 0;
    var priced = priceOf("stickers", pack.id);
    var action = pack.tier === "free"
      ? '<span class="vks-owned">' + esc(tr("Free for everyone")) + "</span>"
      : (owned ? '<span class="vks-owned">' + esc(tr("Owned")) + "</span>" : priceTags(priced)) + '<button type="button" class="vks-get" data-gift="pack" data-pack-id="' + esc(pack.id) + '">' + esc(owned ? tr("Gift") : tr("Get")) + "</button>";
    return '<article class="vks-pack' + (owned ? " is-owned" : "") + '"><div class="vks-head"><b>' + esc(tr(pack.name)) + "</b>" + tierMark(priced) + '<span class="vks-count">' + esc(tr("{n} stickers", { n: String(pack.items.length) })) + '</span></div><div class="vks-grid">' + pack.items.map(function (id) { return '<span class="vks-cell">' + stickerArt(id) + "</span>"; }).join("") + '</div><div class="vks-foot">' + action + "</div></article>";
  }

  function stickersHtml() {
    var sc = storeLib();
    if (!sc) return '<p class="points-note vkg-empty">' + esc(tr("Loading…")) + "</p>";
    return '<p class="points-note">' + esc(tr("Bought stickers work in Messages and in comments.")) + '</p><div class="vks-list">' + sc.STICKER_PACKS.map(packCard).join("") + "</div>";
  }

  function stickerShelf() {
    var sc = storeLib();
    if (!sc) return "";
    return '<section class="vkg-shelf" data-shelf="stickers"><a class="vkg-shelf-head" href="#/store/stickers"><h2>' + esc(sectionTitle("stickers")) + "</h2>" + icon("chevron") + '</a><div class="vkg-row">' + sc.STICKER_PACKS.map(function (pack) {
      return '<a class="gift-card vkg-item vks-mini" href="#/store/stickers" aria-label="' + esc(tr(pack.name)) + '"><span class="vkg-art" style="--h:' + Number(lib() && lib().artHue ? lib().artHue(pack.items[0]) : 200) + '">' + stickerArt(pack.items[0]) + tierMark(priceOf("stickers", pack.id)) + "</span>" + priceTags(priceOf("stickers", pack.id)) + "</a>";
    }).join("") + "</div></section>";
  }

  /* ---- Status emojis: shown on your avatar, set from your status ---- */
  function emojiList() {
    var sc = storeLib();
    if (shop && Array.isArray(shop.emojis)) return shop.emojis;
    return sc && sc.STATUS_EMOJIS ? sc.STATUS_EMOJIS.map(function (item) { return { id: item.id, emoji: item.emoji, name: item.name, tier: item.tier, viktorychs: item.viktorychs, popular: !!item.popular, fresh: !!item.fresh, owned: false }; }) : [];
  }

  function ownedEmojis() {
    return emojiList().filter(function (item) { return item.owned; }).map(function (item) { return item.id; });
  }

  function emojiCard(item) {
    var priced = priceOf("emoji", item.id);
    var mark = item.fresh ? '<span class="vke-flag">' + esc(tr("New")) + "</span>" : item.popular ? '<span class="vke-flag">' + esc(tr("Popular")) + "</span>" : "";
    var action = (item.owned ? '<span class="vks-owned">' + esc(tr("Owned")) + "</span>" : priceTags(priced)) + '<button type="button" class="vks-get" data-gift="emoji" data-emoji-id="' + esc(item.id) + '">' + esc(item.owned ? tr("Gift") : tr("Get")) + "</button>";
    return '<article class="vke-card' + (item.owned ? " is-owned" : "") + '"><span class="vke-art" aria-hidden="true">' + esc(item.emoji) + "</span>" + mark + '<b>' + esc(tr(item.name)) + '</b><div class="vks-foot">' + action + "</div></article>";
  }

  function emojisHtml() {
    var list = emojiList();
    if (!list.length) return '<p class="points-note vkg-empty">' + esc(tr("Loading…")) + "</p>";
    return '<p class="points-note">' + esc(tr("Status emojis show on your avatar. Pick one in your status; any other emoji stays free.")) + '</p><div class="vke-grid">' + list.map(emojiCard).join("") + "</div>";
  }

  function emojiShelf() {
    var list = emojiList();
    if (!list.length) return "";
    return '<section class="vkg-shelf" data-shelf="emojis"><a class="vkg-shelf-head" href="#/store/emojis"><h2>' + esc(sectionTitle("emojis")) + "</h2>" + icon("chevron") + '</a><div class="vkg-row">' + list.map(function (item) {
      return '<a class="gift-card vkg-item vke-mini" href="#/store/emojis" aria-label="' + esc(tr(item.name)) + '"><span class="vkg-art vke-art">' + esc(item.emoji) + "</span>" + priceTags(priceOf("emoji", item.id)) + "</a>";
    }).join("") + "</div></section>";
  }

  /* A compact picker for the composer and Messages: owned packs first. */
  function stickerPicker(slot) {
    if (!shop) loadShop();
    var sc = storeLib();
    if (!sc) return "";
    var owned = ownedPacks();
    var rows = sc.STICKER_PACKS.filter(function (pack) { return owned.indexOf(pack.id) >= 0; }).map(function (pack) {
      return '<div class="vks-pick-row" aria-label="' + esc(tr(pack.name)) + '">' + pack.items.map(function (id) {
        return '<button type="button" class="vks-pick" data-act="xc-sticker-add" data-slot="' + esc(slot || "") + '" data-sticker="' + esc(sc.stickerToken(pack.id, id)) + '" aria-label="' + esc(tr("Sticker")) + '">' + stickerArt(id) + "</button>";
      }).join("") + "</div>";
    }).join("");
    return '<div class="vks-picker">' + rows + '<a class="vks-more" href="#/store/stickers">' + esc(tr("More sticker packs")) + "</a></div>";
  }

  /* Sticker tokens inside already-escaped text become images. */
  function renderStickers(html) {
    var sc = storeLib();
    if (!sc || String(html).indexOf("[[sticker:") < 0) return html;
    return String(html).replace(/\[\[sticker:([a-z0-9_]{1,24})\/([a-z0-9_]{1,32})\]\]/g, function (whole, pack, id) { return stickerHtml(pack, id) || ""; });
  }

  /* ---- Purchases, terms and owner tools ---- */
  function loadOrders() {
    var auth = token();
    if (!auth || orders === "loading") return;
    orders = "loading";
    call("/v1/store/orders", { token: auth }).then(function (body) {
      orders = body && body.orders ? body.orders : [];
      redraw();
    }).catch(function () { orders = []; redraw(); });
  }

  function orderRow(order) {
    var status = order.kind === "emoji" ? priceOf("emoji", order.itemId) : null;
    var item = order.kind === "stickers" || order.kind === "emoji" ? null : findGift(order.itemId);
    var art = order.kind === "stickers" ? stickerArt(order.base) : status ? '<span class="vke-art is-small" aria-hidden="true">' + esc(status.emoji) + "</span>" : artHtml(item || { id: order.itemId, base: order.base }, false);
    var name = order.kind === "stickers" || order.kind === "emoji" ? tr(order.name) : giftLabel(item || { name: order.name });
    var paid = order.method === "money" ? money(order.amount) : order.method === "viktorychs" ? tr("{n} Viktorychs", { n: String(order.amount) }) : order.method === "grant" ? tr("Granted by the app owner") : tr("Free");
    var who = order.toSelf ? tr("For you") : tr("To {name}", { name: order.recipient ? (order.recipient.name || (order.recipient.handle ? "@" + order.recipient.handle : "")) : "" });
    var state = order.status === "pending" ? tr("Waiting for payment") : order.status === "refunded" ? tr("Refunded") : (order.opened ? tr("Opened") : tr("Delivered"));
    var when = order.at ? new Date(order.at).toLocaleDateString() : "";
    var edition = order.edition ? " · " + tr("No. {n}", { n: String(order.edition) }) : "";
    var refund = order.refundable ? '<button type="button" class="vko-refund" data-gift="refund" data-id="' + esc(order.id) + '">' + esc(tr("Refund")) + "</button><span>" + esc(tr("Refundable until {date} while unopened", { date: new Date(order.refundUntil).toLocaleDateString() })) + "</span>" : "";
    return '<div class="vkg-hrow vko-row"><span class="vkg-hart">' + art + '</span><div class="vkg-htext"><b>' + esc(name) + "</b><span>" + esc(who + " · " + paid + " · " + state + (when ? " · " + when : "") + edition) + "</span>" + (refund ? '<div class="vko-actions">' + refund + "</div>" : "") + "</div></div>";
  }

  function ordersHtml(route) {
    if (!token()) return '<p class="points-note vkg-empty">' + esc(tr("Sign in to see your purchases.")) + "</p>";
    if (orders == null) loadOrders();
    var paid = route && route.query && route.query.get ? route.query.get("paid") : "";
    var thanks = paid ? '<p class="vkg-soon is-ok">' + esc(tr("Thank you! Your item is delivered as soon as the payment is confirmed.")) + "</p>" : "";
    var body = orders === "loading" || orders == null ? '<p class="points-note vkg-empty">' + esc(tr("Loading…")) + "</p>"
      : !orders.length ? '<p class="points-note vkg-empty">' + esc(tr("No purchases yet")) + "</p>"
      : orders.map(orderRow).join("");
    return thanks + '<div class="vkg-hist">' + body + '</div><p class="points-note"><a href="#/store/terms">' + esc(tr("Purchase terms")) + "</a></p>";
  }

  function termsHtml() {
    var days = String(storeLib() ? storeLib().REFUND_DAYS : 14);
    var lines = [
      tr("Gifts and sticker packs are digital items for use inside ViktorychApp. They have no cash value."),
      tr("You can pay for an item with money, through our payment provider, or with Viktorychs. Viktorychs are earned by taking part and are never sold."),
      tr("Viktorychs have no cash value. They can’t be bought, cashed out or transferred for money, and they can’t be refunded once spent."),
      tr("Items can’t be resold, traded for money or exchanged for cash."),
      tr("A gift paid with money stays wrapped until the recipient opens it. You can ask for a refund of an unopened gift within {n} days. Once it is opened, it can’t be refunded.", { n: days }),
      tr("Sticker packs and items you buy for yourself are delivered right away. By asking for that, you agree that the {n}-day right to cancel ends at delivery.", { n: days }),
      tr("Card details go straight to the payment provider. ViktorychApp never sees or stores them."),
      tr("You can’t send gifts to someone who blocked you or who doesn’t accept gifts from you. Gifting is rate-limited to stop spam."),
      tr("Viktorychs earned through abuse, such as fake accounts or self-engagement, can be removed.")
    ];
    return '<div class="vkg-terms"><ul>' + lines.map(function (line) { return "<li>" + esc(line) + "</li>"; }).join("") + "</ul></div>";
  }

  function ownerHtml() {
    if (!shop || !shop.owner) return '<p class="points-note vkg-empty">' + esc(tr("Only the app owner can use these tools.")) + "</p>";
    var sc = storeLib();
    var options = [];
    if (sc) {
      sc.STICKER_PACKS.forEach(function (pack) { options.push('<option value="stickers:' + esc(pack.id) + '">' + esc(tr(pack.name)) + "</option>"); });
      (sc.STATUS_EMOJIS || []).forEach(function (item) { options.push('<option value="emoji:' + esc(item.id) + '">' + esc(item.emoji + " " + tr(item.name)) + "</option>"); });
      sc.LIMITED.forEach(function (item) { options.push('<option value="gift:' + esc(item.id) + '">' + esc(tr(item.name)) + "</option>"); });
      sc.PREMIUM_ART.forEach(function (id) { var g = findGift(id); if (g) options.push('<option value="gift:' + esc(id) + '">' + esc(giftLabel(g)) + "</option>"); });
    }
    return '<div class="vkg-owner"><h2>' + esc(tr("Grant Viktorychs")) + '</h2><input data-own="handle" placeholder="' + esc(tr("Recipient")) + '" aria-label="' + esc(tr("Recipient")) + '"><input data-own="amount" type="number" min="1" max="100000" inputmode="numeric" placeholder="' + esc(tr("Amount")) + '" aria-label="' + esc(tr("Amount")) + '"><button type="button" data-gift="own-points">' + esc(tr("Grant")) + "</button><h2>" + esc(tr("Grant a test item")) + '</h2><input data-own="item-handle" placeholder="' + esc(tr("Recipient")) + '" aria-label="' + esc(tr("Recipient")) + '"><select data-own="item" aria-label="' + esc(tr("Item")) + '">' + options.join("") + '</select><button type="button" data-gift="own-item">' + esc(tr("Grant")) + "</button>" + (ownerNote ? '<p class="points-note">' + esc(ownerNote) + "</p>" : "") + "</div>";
  }

  function storeLinks() {
    return '<nav class="vkg-links"><a href="#/store/stickers">' + esc(tr("Sticker packs")) + '</a><a href="#/store/emojis">' + esc(tr("Status emojis")) + '</a><a href="#/store/orders">' + esc(tr("My purchases")) + '</a><a href="#/store/terms">' + esc(tr("Purchase terms")) + "</a>" + (shop && shop.owner ? '<a href="#/store/owner">' + esc(tr("Owner tools")) + "</a>" : "") + "</nav>";
  }

  function paymentsNote() {
    if (!shop || paymentsOn()) return "";
    return '<p class="vkg-soon">' + esc(tr("Card payments are coming soon. You can already pay with Viktorychs.")) + "</p>";
  }

  /* The same sticky X page header as Settings and Notifications: back arrow, title, icon buttons. */
  function headerHtml(title, backHref) {
    var back = backHref
      ? '<a class="icon-btn" href="' + esc(backHref) + '" aria-label="' + esc(tr("Back")) + '">' + icon("back") + "</a>"
      : '<button type="button" class="icon-btn" data-act="back" aria-label="' + esc(tr("Back")) + '">' + icon("back") + "</button>";
    if (store.searching) {
      return '<div class="topbar vkg-top"><div class="page-head">' + back + '<input class="vkg-search" type="search" data-gift-search value="' + esc(store.query) + '" placeholder="' + esc(tr("Search gifts")) + '" aria-label="' + esc(tr("Search gifts")) + '" autocomplete="off" enterkeyhint="search"><button type="button" class="icon-btn" data-gift="search-close" aria-label="' + esc(tr("Close")) + '">' + icon("close") + "</button></div></div>";
    }
    return '<div class="topbar vkg-top"><div class="page-head">' + back + '<h1 class="grow">' + esc(title) + '</h1><a class="icon-btn" href="#/store/history" aria-label="' + esc(tr("Gift history")) + '">' + icon("clock") + '</a><button type="button" class="icon-btn" data-gift="search" aria-label="' + esc(tr("Search gifts")) + '">' + icon("search") + "</button></div></div>";
  }

  function chipsHtml() {
    var c = lib();
    if (!c) return "";
    return '<nav class="vkg-chips" aria-label="' + esc(tr("Gift categories")) + '">' + c.CHIPS.map(function (row) {
      return '<div class="vkg-chiprow">' + row.map(function (id) {
        return '<a class="vkg-chip" href="#/store/' + esc(id) + '">' + icon(id) + "<span>" + esc(sectionTitle(id)) + "</span></a>";
      }).join("") + "</div>";
    }).join("") + "</nav>";
  }

  function shelfHtml(id) {
    var items = giftsFor(id);
    if (!items.length) return "";
    return '<section class="vkg-shelf" data-shelf="' + esc(id) + '"><a class="vkg-shelf-head" href="#/store/' + esc(id) + '"><h2>' + esc(sectionTitle(id)) + "</h2>" + icon("chevron") + '</a><div class="vkg-row">' + items.map(tile).join("") + "</div></section>";
  }

  function balanceLine() {
    if (balance == null) return "";
    return '<a class="vkg-balance" href="#/points">' + esc(tn("viktorychBalance", balance, { count: String(balance) })) + "</a>";
  }

  function searchResults() {
    var q = store.query.trim().toLowerCase();
    if (!q) return '<p class="points-note vkg-empty">' + esc(tr("Type a gift name, like rose or cat.")) + "</p>";
    var hits = allGifts().filter(function (item) {
      if (!onShelf(item)) return false;
      var hay = (giftLabel(item) + " " + (item.name || "") + " " + item.id.replace(/_/g, " ") + " " + (item.cats || []).map(sectionTitle).join(" ")).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    if (!hits.length) return '<p class="points-note vkg-empty">' + esc(tr("No results")) + "</p>";
    return '<div class="vkg-grid">' + hits.map(tile).join("") + "</div>";
  }

  function historyRow(item, sent) {
    var gift = findGift(item.giftId) || { id: item.giftId, svg: item.svg, cp: item.cp };
    if (!gift.cp && item.cp) gift = { id: gift.id, name: gift.name, svg: item.svg, cp: item.cp, anim: gift.anim };
    var person = sent ? item.recipient : item.sender;
    var who = person ? (person.name || (person.handle ? "@" + person.handle : "")) : tr("Anonymous gift");
    var line = sent ? tr("To {name}", { name: who }) : tr("From {name}", { name: who });
    var when = item.at ? new Date(item.at).toLocaleDateString((window.SI18n ? window.SI18n.locale() : undefined)) : "";
    return '<div class="vkg-hrow"><span class="vkg-hart">' + artHtml(gift, false) + '</span><div class="vkg-htext"><b>' + esc(giftLabel(gift)) + "</b><span>" + esc(line) + (when ? " · " + esc(when) : "") + "</span>" + (item.message ? "<p>" + esc(item.message) + "</p>" : "") + "</div></div>";
  }

  function loadHistory() {
    var auth = token();
    if (!auth) return;
    if (store.received == null) {
      store.received = "loading";
      call("/v1/gifts", { token: auth }).then(function (body) {
        store.received = body && body.gifts ? body.gifts : [];
        redraw();
      }).catch(function () { store.received = []; redraw(); });
    }
    if (store.sent == null) {
      store.sent = "loading";
      call("/v1/gifts/sent", { token: auth }).then(function (body) {
        store.sent = body && body.gifts ? body.gifts : [];
        redraw();
      }).catch(function () { store.sent = []; redraw(); });
    }
  }

  function historyHtml() {
    if (!token()) return '<p class="points-note vkg-empty">' + esc(tr("Sign in to see the gifts you sent and received.")) + "</p>";
    loadHistory();
    var sent = store.histTab === "sent";
    var list = sent ? store.sent : store.received;
    var tabs = '<div class="tabs-bar"><div class="tabs" role="tablist"><button type="button" role="tab" class="tab' + (!sent ? " on" : "") + '" data-gift="hist" data-tab="received" aria-selected="' + (!sent) + '"><span>' + esc(tr("Received")) + '</span></button><button type="button" role="tab" class="tab' + (sent ? " on" : "") + '" data-gift="hist" data-tab="sent" aria-selected="' + sent + '"><span>' + esc(tr("Sent")) + "</span></button></div></div>";
    var body;
    if (list === "loading" || list == null) body = '<p class="points-note vkg-empty">' + esc(tr("Loading…")) + "</p>";
    else if (!list.length) body = '<p class="points-note vkg-empty">' + esc(sent ? tr("You haven’t sent any gifts yet.") : tr("No gifts yet")) + "</p>";
    else body = list.map(function (item) { return historyRow(item, sent); }).join("");
    return tabs + '<div class="vkg-hist">' + body + "</div>";
  }

  function storePage(route) {
    var sub = route && route.sub ? String(route.sub) : "";
    if (!shop) loadShop();
    if (sub !== store.sub) {
      if (sub === "orders") orders = null;
      store.sub = sub;
      store.searching = false;
      store.query = "";
      if (sub === "history") { store.received = null; store.sent = null; }
    }
    var c = lib();
    var body;
    var title = sub ? sectionTitle(sub) : tr("Gifts");
    var backHref = sub ? "#/store" : "";
    if (store.searching) body = '<div data-gift-results>' + searchResults() + "</div>";
    else if (sub === "history") body = historyHtml();
    else if (sub === "stickers") body = balanceLine() + paymentsNote() + stickersHtml();
    else if (sub === "emojis") body = balanceLine() + emojisHtml();
    else if (sub === "orders") body = ordersHtml(route);
    else if (sub === "terms") body = termsHtml();
    else if (sub === "owner") body = ownerHtml();
    else if (sub === "limited") {
      var rare = limitedItems();
      body = rare.length ? '<div class="vkg-grid">' + rare.map(tile).join("") + "</div>" : '<p class="points-note vkg-empty">' + esc(tr("No gifts here right now.")) + "</p>";
    } else if (sub) {
      var items = giftsFor(sub);
      body = items.length ? '<div class="vkg-grid">' + items.map(tile).join("") + "</div>" : '<p class="points-note vkg-empty">' + esc(tr("No gifts here right now.")) + "</p>";
    } else if (!c || !allGifts().length || !allGifts()[0].cats) {
      body = '<section class="vkg-shelf"><div class="vkg-row">' + allGifts().map(tile).join("") + "</div></section>";
    } else {
      var shelves = c.activeSeasons().concat(["trending"]).concat(c.CATEGORIES.filter(function (id) { return id !== "trending"; }));
      body = chipsHtml() + balanceLine() + storeLinks() + paymentsNote() + limitedShelf() + stickerShelf() + emojiShelf() + shelves.map(shelfHtml).join("");
    }
    var credit = '<p class="vkg-credit">' + esc(tr("Gift art: original illustrations made for ViktorychApp, plus Noto Emoji by Google (Apache 2.0, animated CC BY 4.0).")) + "</p>";
    return '<div class="store-page vkg-page">' + headerHtml(title, backHref) + body + credit + "</div>";
  }

  function sheetItem() {
    if (!sheet) return null;
    return priceOf(sheet.kind, sheet.giftId);
  }

  function sheetPayOptions(item) {
    var out = [];
    if (!item) return out;
    if (item.tier === "free") return ["free"];
    if (item.viktorychs > 0) out.push("viktorychs");
    if (item.cents > 0 && sheet.mode === "direct") out.push("money");
    return out;
  }

  function pickPay() {
    var options = sheetPayOptions(sheetItem());
    if (options.indexOf(sheet.pay) < 0) sheet.pay = options[0] || "viktorychs";
  }

  function pill(act, on, label) {
    return '<button type="button" class="vkg-pill' + (on ? " is-on" : "") + '" data-gift="' + act + '" aria-pressed="' + (on ? "true" : "false") + '">' + esc(label) + "</button>";
  }

  function sheetHtml() {
    if (!sheet) return "";
    pickPay();
    var item = sheetItem();
    var stickers = sheet.kind === "stickers";
    var emoji = sheet.kind === "emoji";
    var gift = stickers || emoji ? null : findGift(sheet.giftId);
    var pack = stickers && storeLib() ? storeLib().stickerPack(sheet.giftId) : null;
    var owned = (stickers && ownedPacks().indexOf(sheet.giftId) >= 0) || (emoji && ownedEmojis().indexOf(sheet.giftId) >= 0);
    if (owned) sheet.forMe = false;
    var left = gift && gift.limited ? limitedLeft(gift.id) : null;
    var soldOut = left === 0;
    var title = sheet.forMe ? tr("Buy for me") : (stickers ? tr("Gift stickers") : emoji ? tr("Send status emoji") : tr("Send a gift"));
    var payMoney = sheet.pay === "money";
    var moneyOff = payMoney && !paymentsOn();
    var confirmLabel = sheet.busy ? tr("Loading…") : moneyOff ? tr("Coming soon") : payMoney ? tr("Pay {price}", { price: money(item ? item.cents : 0) }) : sheet.forMe ? tr("Buy") : tr("Send");
    var disabled = sheet.busy || moneyOff || soldOut;
    var preview = "";
    if (gift) preview = '<p class="gift-preview"><span class="vkg-art is-big"' + hueStyle(gift.base ? { id: gift.base } : gift) + '>' + artHtml(gift, true) + tierMark(item) + "</span><b>" + esc(giftLabel(gift)) + "</b>" + priceTags(item) + (gift.limited ? '<span class="vkg-limited is-inline">' + esc(left == null ? tr("Limited") : left > 0 ? tr("{n} left", { n: String(left) }) : tr("Sold out")) + "</span>" : "") + "</p>";
    if (emoji && item) preview = '<p class="gift-preview"><span class="vkg-art is-big vke-art" aria-hidden="true">' + esc(item.emoji) + "</span><b>" + esc(tr(item.name)) + "</b>" + priceTags(item) + "</p>";
    if (pack) preview = '<div class="gift-preview is-pack"><b>' + esc(tr(pack.name)) + "</b>" + priceTags(item) + '<div class="vks-grid">' + pack.items.map(function (id) { return '<span class="vks-cell">' + stickerArt(id) + "</span>"; }).join("") + "</div></div>";
    var modes = sheet.mode === "direct" && !(item && item.tier === "free" && !stickers && !emoji) ? '<div class="vkg-pills" role="group">' + pill("as-gift", !sheet.forMe, tr("Send as gift")) + (owned ? "" : pill("for-me", sheet.forMe, tr("Buy for me"))) + "</div>" : "";
    var recipient = sheet.forMe ? "" :
      '<input data-gift-field="handle" value="' + esc(sheet.handle || "") + '" placeholder="' + esc(tr("Recipient")) + '" aria-label="' + esc(tr("Recipient")) + '" autocapitalize="off" autocomplete="off">' +
      '<textarea data-gift-field="message" placeholder="' + esc(tr("Add a message")) + '" aria-label="' + esc(tr("Add a message")) + '">' + esc(sheet.message || "") + "</textarea>" +
      '<label><input type="radio" name="gift-privacy" data-gift-privacy="public"' + (sheet.privacy === "public" ? " checked" : "") + "> " + esc(tr("Public gift")) + "</label>" +
      '<label><input type="radio" name="gift-privacy" data-gift-privacy="private"' + (sheet.privacy === "private" ? " checked" : "") + "> " + esc(tr("Only the recipient sees who sent it")) + "</label>" +
      '<label><input type="radio" name="gift-privacy" data-gift-privacy="anonymous"' + (sheet.privacy === "anonymous" ? " checked" : "") + "> " + esc(tr("Anonymous gift")) + "</label>";
    var options = sheetPayOptions(item);
    var pay = "";
    if (options.length && options[0] !== "free") {
      pay = '<fieldset class="vkg-pay"><legend>' + esc(tr("Pay with")) + "</legend>" + options.map(function (id) {
        var label = id === "money"
          ? '<span class="vk-money">' + esc(money(item.cents)) + "</span>" + (paymentsOn() ? '<span class="vk-sub">' + esc(tr("Card, Apple Pay or Google Pay")) + "</span>" : '<span class="vk-sub">' + esc(tr("Coming soon")) + "</span>")
          : vks(item.viktorychs) + '<span class="vk-sub">' + esc(tr("You have {n} Viktorychs", { n: String(balance == null ? 0 : balance) })) + "</span>";
        return '<label class="vkg-payopt' + (sheet.pay === id ? " is-on" : "") + '"><input type="radio" name="gift-pay" data-gift-pay="' + id + '"' + (sheet.pay === id ? " checked" : "") + ">" + label + "</label>";
      }).join("") + "</fieldset>";
    }
    var note = "";
    if (payMoney) {
      var days = String(storeLib() ? storeLib().REFUND_DAYS : 14);
      var consent = stickers || emoji || sheet.forMe
        ? tr("I agree to the purchase terms and want it delivered now. I understand the {n}-day right to cancel ends at delivery.", { n: days })
        : tr("I agree to the purchase terms. An unopened gift can be refunded within {n} days.", { n: days });
      note = '<label class="vkg-consent"><input type="checkbox" data-gift-accept' + (sheet.accept ? " checked" : "") + "> " + esc(consent) + '</label><a class="vkg-terms-link" href="#/store/terms" data-gift="terms">' + esc(tr("Purchase terms")) + "</a>";
    } else if (options[0] !== "free") {
      note = '<p class="vkg-fine">' + esc(tr("Viktorychs have no cash value and can’t be refunded once spent.")) + ' <a href="#/store/terms" data-gift="terms">' + esc(tr("Purchase terms")) + "</a></p>";
    }
    return '<div class="gift-sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="gift-sheet-bar"><button type="button" class="icon-btn" data-gift="close" aria-label="' + esc(tr("Close")) + '">' + icon("close") + '</button><h2>' + esc(title) + '</h2><button type="button" data-gift="confirm"' + (disabled ? ' disabled aria-disabled="true"' : "") + ">" + esc(confirmLabel) + '</button></div><div class="gift-sheet-body">' +
      preview + modes + recipient + pay + note +
      (errorText ? '<p class="gift-error" role="alert">' + esc(errorText) + "</p>" : "") +
      "</div></div>";
  }

  function giftsHtml(pack, mine) {
    if (!pack) return "";
    if (pack.hidden && !mine) return "";
    var grid = (pack.gifts || []).map(function (gift) {
      var who = gift.sender && gift.sender.name ? gift.sender.name : (gift.sender && gift.sender.handle ? gift.sender.handle : tr("Anonymous gift"));
      var hide = mine ? '<button type="button" data-gift="hide" data-id="' + esc(gift.id) + '">' + esc(gift.hidden ? tr("Show gift") : tr("Hide gift")) + "</button>" + (root.GiftNFT ? root.GiftNFT.buttonHtml(gift) : "") : "";
      var edition = gift.edition ? '<span class="vkg-edition">' + esc(tr("No. {n}", { n: String(gift.edition) })) + "</span>" : "";
      if (gift.wrapped) {
        var open = mine ? '<button type="button" class="gift-unwrap" data-gift="unwrap" data-id="' + esc(gift.id) + '">' + esc(tr("Open gift")) + "</button>" : "";
        return '<article class="gift-tile is-wrapped"><span class="gift-art"><span class="gift-box" aria-hidden="true">' + icon("birthday") + '</span></span><b>' + esc(mine ? who : tr("Wrapped gift")) + "</b>" + open + "</article>";
      }
      return '<article class="gift-tile' + (gift.hidden ? " is-hidden" : "") + '"><span class="gift-art">' + artHtml(gift, false) + edition + '</span><b>' + esc(who) + "</b><p>" + esc(gift.message || "") + "</p>" + hide + "</article>";
    }).join("");
    var send = mine ? "" : '<button type="button" class="gift-send" data-gift="open" data-handle="' + esc(viewedHandle) + '">' + esc(tr("Send a gift")) + "</button>";
    var prefs = mine ? '<div class="gift-prefs"><label>' + esc(tr("Who can send you gifts")) + '</label><select data-gift-who><option value="everyone">' + esc(tr("Everyone")) + '</option><option value="followers">' + esc(tr("Followers")) + '</option><option value="nobody">' + esc(tr("Nobody")) + '</option><option value="list">' + esc(tr("Custom lists")) + '</option></select>' + (window.AudienceLists && window.AudienceLists.checksHtml ? window.AudienceLists.checksHtml([]) : "") + '<label class="gift-check"><input type="checkbox" data-gift-hide-tab' + (pack.hideTab ? " checked" : "") + "> " + esc(tr("Hide the Gifts tab")) + "</label></div>" : "";
    var empty = grid ? "" : '<p class="points-note">' + esc(tr("No gifts yet")) + "</p>";
    return '<div class="gifts-tab">' + send + prefs + empty + '<div class="gift-grid">' + grid + "</div></div>";
  }

  function showTab(account) {
    if (!account) return false;
    if (account.gifts && account.gifts.hidden) {
      var session = root.ViktorychAccounts && root.ViktorychAccounts.account && root.ViktorychAccounts.account();
      return !!(session && account.publicId && session.publicId === account.publicId);
    }
    return true;
  }

  function watchBirthday(account) {
    if (!account || !account.handle || account.birthdayChecked) return;
    account.birthdayChecked = true;
    call("/v1/about?handle=" + encodeURIComponent(account.handle), { token: token() }).then(function (body) {
      account.birthdayToday = !!(body && body.status === 200 && body.birthdayToday);
      redraw();
    }).catch(function () { account.birthdayToday = false; });
  }

  function ensure(account) {
    if (!account || !account.handle || account.giftsLoading) return;
    viewedHandle = account.handle;
    if (account.giftsLoaded) return;
    account.giftsLoading = true;
    call("/v1/gifts?handle=" + encodeURIComponent(account.handle), { token: token() }).then(function (body) {
      account.giftsLoading = false;
      account.giftsLoaded = true;
      account.gifts = body && body.gifts ? body : { gifts: [], hidden: false };
      redraw();
    }).catch(function () {
      account.giftsLoading = false;
      account.giftsLoaded = true;
      account.gifts = { gifts: [], hidden: false };
    });
  }

  function openSheet(handle, extra) {
    extra = extra || {};
    sheet = {
      kind: extra.kind === "stickers" || extra.kind === "emoji" ? extra.kind : "gift",
      forMe: false,
      pay: "viktorychs",
      accept: false,
      busy: false,
      giftId: (catalog[0] && catalog[0].id) || "heart",
      handle: handle || "",
      message: "",
      privacy: "public",
      mode: extra.mode === "reply" || extra.mode === "dm" ? extra.mode : "direct",
      parentId: String(extra.parentId || "")
    };
    errorText = "";
    loadCatalog().then(redraw);
    if (!shop) loadShop();
    redraw();
  }

  function errorFor(code, forMe, kind) {
    if (code === "owned" && kind === "emoji") return forMe ? tr("You already have this emoji.") : tr("They already have this emoji.");
    if (code === "birthday") return tr("That gift is only for their birthday.");
    if (code === "free_limit") return tr("You’ve used today’s free gifts. Try again tomorrow.");
    if (code === "balance") return tr("Not enough Viktorychs for this gift.");
    if (code === "blocked") return tr("You can’t send gifts to this account.");
    if (code === "closed" || code === "followers") return tr("This person isn’t accepting gifts from you.");
    if (code === "owned") return forMe ? tr("You already have this sticker pack.") : tr("They already have this sticker pack.");
    if (code === "sold_out") return tr("Sold out");
    if (code === "ended") return tr("This limited edition has ended.");
    if (code === "rate_limited") return tr("Too many gifts right now. Try again later.");
    if (code === "payments_off") return tr("Card payments are coming soon. You can already pay with Viktorychs.");
    if (code === "terms") return tr("Please accept the purchase terms.");
    if (code === "money_only") return tr("This item can only be bought with money.");
    if (code === "recipient") return tr("Couldn’t find that account.");
    if (code === "provider") return tr("The payment page couldn’t open. Try again later.");
    return tr("Couldn’t send that gift.");
  }

  function returnUrl() {
    try { return root.location.origin + root.location.pathname; } catch (err) { return ""; }
  }

  function confirmSend() {
    if (!sheet || sheet.busy) return;
    var auth = token();
    if (!auth) { errorText = tr("Sign in"); redraw(); return; }
    pickPay();
    var current = sheet;
    var item = sheetItem();
    var gift = current.kind === "gift" ? findGift(current.giftId) : null;
    if (!current.forMe && !String(current.handle || "").trim()) { errorText = tr("Couldn’t find that account."); redraw(); return; }
    if (current.pay === "money" && !current.accept) { errorText = errorFor("terms"); redraw(); return; }
    var target = current.forMe ? "" : current.handle;
    var path;
    var payload;
    if (current.pay === "money") {
      path = "/v1/store/checkout";
      payload = { kind: current.kind, itemId: current.giftId, handle: target, message: current.message, privacy: current.privacy, accept: true, returnUrl: returnUrl() };
    } else if (current.kind === "gift" && !current.forMe && !(gift && gift.limited)) {
      path = "/v1/gifts/send";
      payload = { giftId: current.giftId, handle: current.handle, message: current.message, privacy: current.privacy, mode: current.mode || "direct", parentId: current.parentId || "" };
    } else {
      path = "/v1/store/buy";
      payload = { kind: current.kind, itemId: current.giftId, handle: target, message: current.message, privacy: current.privacy };
    }
    current.busy = true;
    errorText = "";
    redraw();
    call(path, { method: "POST", token: auth, body: payload }).then(function (body) {
      current.busy = false;
      if (!body || (body.status && body.status >= 400)) {
        if (body && body.balance != null) balance = Number(body.balance) || 0;
        if (sheet === current) { errorText = errorFor(body && body.error, current.forMe, current.kind); redraw(); }
        return;
      }
      if (current.pay === "money" && body.url) {
        root.location.assign(body.url);
        return;
      }
      if (body.balance != null) balance = Number(body.balance) || 0;
      store.sent = null;
      orders = null;
      if (item && (item.kind === "stickers" || item.kind === "emoji" || (gift && gift.limited))) loadShop();
      if (sheet === current) sheet = null;
      if (current.mode === "reply" && body.post && root.ProfileGifts && root.ProfileGifts.onReply) root.ProfileGifts.onReply(current.parentId, body.post);
      if (current.forMe && current.kind === "stickers") root.location.hash = "#/store/stickers";
      if (current.forMe && current.kind === "emoji") root.location.hash = "#/store/emojis";
      redraw();
    }).catch(function () {
      current.busy = false;
      if (sheet === current) { errorText = tr("Couldn’t send that gift."); redraw(); }
    });
  }

  function ownerAction(act) {
    var field = function (name) { var el = document.querySelector('[data-own="' + name + '"]'); return el ? String(el.value || "").trim() : ""; };
    var req;
    if (act === "own-points") {
      req = call("/v1/viktorychs/grant", { method: "POST", token: token(), body: { handle: field("handle"), amount: Number(field("amount")) || 0 } });
    } else {
      var pick = field("item").split(":");
      req = call("/v1/store/grant", { method: "POST", token: token(), body: { handle: field("item-handle"), kind: pick[0], itemId: pick[1] || "" } });
    }
    ownerNote = tr("Loading…");
    redraw();
    req.then(function (body) {
      ownerNote = body && (!body.status || body.status < 400) ? tr("Done") : tr("Couldn’t do that.");
      if (body && body.balance != null) balance = Number(body.balance) || 0;
      loadShop();
      redraw();
    }).catch(function () { ownerNote = tr("Couldn’t do that."); redraw(); });
  }

  function onClick(event) {
    var el = event.target && event.target.closest ? event.target.closest("[data-gift]") : null;
    if (!el) return false;
    if (event.preventDefault) event.preventDefault();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    var act = el.getAttribute("data-gift");
    if (act === "close") { sheet = null; errorText = ""; redraw(); return true; }
    if (act === "reply" || act === "dm" || act === "pick" || act === "open") {
      var mode = act === "reply" ? "reply" : (act === "dm" ? "dm" : "direct");
      openSheet(el.getAttribute("data-handle") || (sheet && sheet.handle) || "", { mode: mode, parentId: el.getAttribute("data-parent") || "" });
      if (act === "pick") sheet.giftId = el.getAttribute("data-gift-id") || sheet.giftId;
      redraw();
      return true;
    }
    if (act === "birthday") {
      openSheet(el.getAttribute("data-handle") || "", { mode: "direct" });
      if (sheet) sheet.giftId = "cake";
      confirmSend();
      return true;
    }
    if (act === "confirm") { confirmSend(); return true; }
    if (act === "emoji") {
      openSheet("", { mode: "direct", kind: "emoji" });
      sheet.giftId = el.getAttribute("data-emoji-id") || "";
      sheet.forMe = ownedEmojis().indexOf(sheet.giftId) < 0;
      redraw();
      return true;
    }
    if (act === "pack") {
      openSheet("", { mode: "direct", kind: "stickers" });
      sheet.giftId = el.getAttribute("data-pack-id") || "";
      sheet.forMe = ownedPacks().indexOf(sheet.giftId) < 0;
      redraw();
      return true;
    }
    if (act === "as-gift" || act === "for-me") { if (sheet) { sheet.forMe = act === "for-me"; errorText = ""; } redraw(); return true; }
    if (act === "terms") { sheet = null; errorText = ""; root.location.hash = "#/store/terms"; redraw(); return true; }
    if (act === "unwrap") {
      var sendId = el.getAttribute("data-id");
      el.disabled = true;
      call("/v1/store/gifts/" + sendId + "/open", { method: "POST", token: token() }).then(function () {
        var account = currentAccount();
        if (account) { account.giftsLoaded = false; ensure(account); }
      }).catch(function () { el.disabled = false; });
      return true;
    }
    if (act === "refund") {
      el.disabled = true;
      call("/v1/store/orders/" + el.getAttribute("data-id") + "/refund", { method: "POST", token: token() }).then(function (body) {
        if (body && body.status >= 400) el.disabled = false;
        orders = null;
        redraw();
      }).catch(function () { el.disabled = false; });
      return true;
    }
    if (act === "own-points" || act === "own-item") { ownerAction(act); return true; }
    if (act === "search") { store.searching = true; store.query = ""; redraw(); focusSearch(); return true; }
    if (act === "search-close") { store.searching = false; store.query = ""; redraw(); return true; }
    if (act === "hist") { store.histTab = el.getAttribute("data-tab") === "sent" ? "sent" : "received"; redraw(); return true; }
    if (act === "hide") {
      call("/v1/gifts/" + el.getAttribute("data-id") + "/hide", { method: "POST", token: token() }).then(function () {
        var account = currentAccount();
        if (account) { account.giftsLoaded = false; ensure(account); }
      });
      return true;
    }
    return false;
  }

  function currentAccount() {
    try {
      var session = root.ViktorychAccounts && root.ViktorychAccounts.account && root.ViktorychAccounts.account();
      if (!session || !root.ViktorychAccounts.storedAccount) return session;
      return root.ViktorychAccounts.storedAccount(session.handle) || session;
    } catch (err) { return null; }
  }

  function focusSearch() {
    setTimeout(function () {
      var input = document.querySelector("[data-gift-search]");
      if (input) { input.focus(); try { input.setSelectionRange(input.value.length, input.value.length); } catch (err) { /* search inputs */ } }
    }, 0);
  }

  if (typeof document !== "undefined") {
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", function (event) {
      if (sheet && (event.key === "Escape" || event.key === "Esc") && !sheet.busy) { sheet = null; errorText = ""; redraw(); }
    });
    /* Art fallback: animated -> static PNG -> the emoji character. */
    document.addEventListener("error", function (event) {
      var img = event.target;
      if (!img || img.tagName !== "IMG" || !img.hasAttribute("data-gift-art")) return;
      var c = lib();
      var cp = img.getAttribute("data-gift-art");
      if (c && (img.src.indexOf("gstatic") >= 0 || img.classList.contains("is-own"))) { img.classList.remove("is-own"); img.setAttribute("referrerpolicy", "no-referrer"); img.src = c.staticArt(cp); return; }
      var span = document.createElement("span");
      span.className = "vkg-emoji";
      span.textContent = c ? c.emojiChar(cp) : "";
      if (img.parentNode) img.parentNode.replaceChild(span, img);
    }, true);
    if (typeof window !== "undefined") {
      window.addEventListener("giftcatalog", function () { redraw(); });
      window.addEventListener("storecatalog", function () { redraw(); });
    }
    document.addEventListener("input", function (event) {
      var el = event.target;
      if (el && el.hasAttribute && el.hasAttribute("data-gift-search")) {
        store.query = el.value;
        var box = document.querySelector("[data-gift-results]");
        if (box) box.innerHTML = searchResults();
        return;
      }
      if (!sheet || !el || !el.getAttribute) return;
      if (el.getAttribute("data-gift-field")) sheet[el.getAttribute("data-gift-field")] = el.value;
    }, true);
    document.addEventListener("change", function (event) {
      var el = event.target;
      if (!el || !el.getAttribute) return;
      if (el.getAttribute("data-gift-privacy")) {
        if (sheet) sheet.privacy = el.getAttribute("data-gift-privacy");
        return;
      }
      if (el.getAttribute("data-gift-pay")) {
        if (sheet) { sheet.pay = el.getAttribute("data-gift-pay"); errorText = ""; redraw(); }
        return;
      }
      if (el.hasAttribute("data-gift-accept")) {
        if (sheet) sheet.accept = !!el.checked;
        return;
      }
      if (el.hasAttribute("data-gift-who") || el.hasAttribute("data-gift-hide-tab")) {
        var who = document.querySelector("[data-gift-who]");
        var hide = document.querySelector("[data-gift-hide-tab]");
        call("/v1/gifts/prefs", {
          method: "PUT",
          token: token(),
          body: { who: who ? who.value : "everyone", hideTab: !!(hide && hide.checked), listIds: window.AudienceLists && window.AudienceLists.selectedLists ? window.AudienceLists.selectedLists(document) : [] }
        });
      }
    }, true);
  }

  root.ProfileGifts = {
    start: start,
    played: function (gameId) { touch("game", gameId); },
    pointsPage: pointsPage,
    storePage: storePage,
    banner: function (account) {
      watchBirthday(account);
      if (!account || !account.birthdayToday) return "";
      var session = root.ViktorychAccounts && root.ViktorychAccounts.account && root.ViktorychAccounts.account();
      var mine = !!(session && account.publicId && session.publicId === account.publicId);
      var send = mine ? "" : '<button type="button" data-gift="birthday" data-handle="' + esc(account.handle || "") + '">' + esc(tr("Send birthday gift")) + "</button>";
      return '<div class="bday-banner"><b>' + esc(tr("Birthday today")) + "</b>" + send + "</div>";
    },
    noteAction: function (note) {
      if (!note || note.kind !== "birthday" || !note.handle) return "";
      return '<button type="button" class="bday-send" data-gift="birthday" data-handle="' + esc(note.handle) + '">' + esc(tr("Send birthday gift")) + "</button>";
    },
    dmBar: function () {
      return '<section class="gift-dm"><button class="primary" type="button" data-gift="dm">' + esc(tr("Send gift in a message")) + '</button><p class="phandle">' + esc(tr("A direct message gift uses the same privacy, limits, and points as any other gift.")) + "</p></section>";
    },
    giftsHtml: giftsHtml,
    showTab: showTab,
    ensure: ensure,
    open: openSheet,
    previewStore: function (items, route) { catalog = items || catalog; return storePage(route); },
    artHtml: artHtml,
    findGift: findGift,
    coin: coin,
    balance: function () { return balance; },
    balanceHtml: function () { return balance == null ? "" : '<span class="vk-amount">' + coin() + '<b data-points-balance>' + esc(String(balance)) + "</b></span>"; },
    stickerHtml: stickerHtml,
    stickerPicker: stickerPicker,
    renderStickers: renderStickers,
    ownedStickerPacks: ownedPacks,
    openStore: function (kind, id, forMe) {
      openSheet("", { mode: "direct", kind: kind });
      sheet.giftId = id;
      sheet.forMe = !!forMe;
      redraw();
    },
    overlay: function () { return sheetHtml(); },
    previewPoints: function (pack) {
      balance = pack.balance;
      rules = pack.rules || [];
      history = pack.history || [];
      return pointsPage();
    }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
