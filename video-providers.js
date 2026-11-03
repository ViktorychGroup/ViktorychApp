/* Video provider registry for link preview cards.
   Each entry maps a page URL to the platform's own official embed player,
   the shape it draws at, and where a poster can come from. Nothing here
   downloads, proxies, or rips a stream: a card shows a still and a play
   button, and only a tap swaps in the provider's iframe. A URL no entry
   knows, and no oEmbed/og:video player, stays a plain link. */
(function (root) {
  "use strict";

  var WIDE = "16:9";
  var TALL = "9:16";

  function parse(raw) {
    try {
      var url = new URL(String(raw || "").trim());
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      return url;
    } catch (_) {
      return null;
    }
  }

  function bareHost(url) {
    return url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  }

  /* 90, "90s", "1m30s", "1h2m3s", "01:30" -> seconds. */
  function seconds(value) {
    var text = String(value || "").trim().toLowerCase();
    if (!text) return 0;
    if (/^\d+$/.test(text)) return Number(text);
    if (/^\d+(:\d{1,2}){1,2}$/.test(text)) {
      return text.split(":").reduce(function (sum, part) { return sum * 60 + Number(part); }, 0);
    }
    var m = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
    if (!m || (!m[1] && !m[2] && !m[3])) return 0;
    return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  }

  function startOf(url) {
    var hash = url.hash.replace(/^#/, "");
    var fromHash = (hash.match(/(?:^|&)t=([^&]+)/) || [])[1];
    return seconds(url.searchParams.get("t") || url.searchParams.get("start") || url.searchParams.get("time_continue") || fromHash || "");
  }

  function originOf(opts) {
    if (opts && opts.origin) return String(opts.origin);
    try { return root.location && /^https?:/.test(root.location.protocol) ? root.location.origin : ""; } catch (_) { return ""; }
  }

  function hostOf(opts) {
    if (opts && opts.host) return String(opts.host);
    var origin = originOf(opts);
    try { return origin ? new URL(origin).hostname : "localhost"; } catch (_) { return "localhost"; }
  }

  var YT_ID = /^[A-Za-z0-9_-]{11}$/;

  function youtube(url) {
    var host = bareHost(url);
    var id = "";
    var tall = false;
    if (host === "youtu.be") {
      id = url.pathname.split("/")[1] || "";
    } else if (host === "youtube.com" || host === "music.youtube.com" || host === "youtube-nocookie.com") {
      var path = url.pathname.match(/^\/(shorts|embed|live|v|e)\/([^/?#]+)/);
      if (path) {
        id = path[2];
        tall = path[1] === "shorts";
      } else if (/^\/watch\/?$/.test(url.pathname)) {
        id = url.searchParams.get("v") || "";
      }
    } else {
      return null;
    }
    if (!YT_ID.test(id)) return null;
    return { id: id, tall: tall, start: startOf(url) };
  }

  function vimeo(url) {
    var host = bareHost(url);
    if (host !== "vimeo.com" && host !== "player.vimeo.com") return null;
    var m = url.pathname.match(/^\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/|showcase\/\d+\/video\/)?(\d{6,12})(?:\/([0-9a-f]{6,20}))?\/?$/i);
    if (!m) return null;
    return { id: m[1], hash: m[2] || url.searchParams.get("h") || "", start: startOf(url) };
  }

  function dailymotion(url) {
    var host = bareHost(url);
    var m = null;
    if (host === "dai.ly") m = url.pathname.match(/^\/(x[a-z0-9]{4,12})\/?$/i);
    else if (host === "dailymotion.com") m = url.pathname.match(/^\/(?:embed\/)?video\/(x[a-z0-9]{4,12})/i);
    else if (host === "geo.dailymotion.com") m = [null, url.searchParams.get("video") || ""];
    if (!m || !/^x[a-z0-9]{4,12}$/i.test(m[1] || "")) return null;
    return { id: m[1], start: startOf(url) };
  }

  var TWITCH_RESERVED = /^(videos|directory|downloads|jobs|p|settings|search|subscriptions|inventory|wallet|friends|messages|turbo|prime|store|login|signup)$/i;

  function twitch(url) {
    var host = bareHost(url);
    if (host === "clips.twitch.tv") {
      var slug = url.pathname.split("/")[1] || url.searchParams.get("clip") || "";
      if (slug === "embed") slug = url.searchParams.get("clip") || "";
      return /^[A-Za-z0-9_-]{4,100}$/.test(slug) ? { clip: slug } : null;
    }
    if (host !== "twitch.tv" && host !== "player.twitch.tv") return null;
    if (host === "player.twitch.tv") {
      var v = (url.searchParams.get("video") || "").replace(/^v/, "");
      return /^\d{5,12}$/.test(v) ? { video: v, start: startOf(url) } : null;
    }
    var vod = url.pathname.match(/^\/videos\/(\d{5,12})\/?$/);
    if (vod) return { video: vod[1], start: startOf(url) };
    var clip = url.pathname.match(/^\/([A-Za-z0-9_]{3,25})\/clip\/([A-Za-z0-9_-]{4,100})\/?$/);
    if (clip && !TWITCH_RESERVED.test(clip[1])) return { clip: clip[2] };
    return null;
  }

  function streamable(url) {
    if (bareHost(url) !== "streamable.com") return null;
    var m = url.pathname.match(/^\/(?:[eos]\/)?([a-z0-9]{4,12})\/?$/i);
    return m ? { id: m[1] } : null;
  }

  var KICK_RESERVED = /^(categories|category|browse|following|search|video|videos|clips|terms-of-service|privacy-policy|dmca-policy|community-guidelines|about|contact|login|signup|settings|dashboard|subscriptions|help|app|api|stream|kick-cares)$/i;

  /* Kick documents an embed for live channels only, so a clip or VOD link
     stays a link unless the page itself exposes a player. */
  function kick(url) {
    var host = bareHost(url);
    if (host === "player.kick.com") {
      var name = url.pathname.split("/")[1] || "";
      return /^[A-Za-z0-9_-]{3,30}$/.test(name) ? { channel: name } : null;
    }
    if (host !== "kick.com") return null;
    if (url.searchParams.get("clip")) return null;
    var m = url.pathname.match(/^\/([A-Za-z0-9_-]{3,30})\/?$/);
    if (!m || KICK_RESERVED.test(m[1])) return null;
    return { channel: m[1] };
  }

  function odysee(url) {
    if (bareHost(url) !== "odysee.com") return null;
    var path = url.pathname.replace(/^\/\$\/embed\//, "/");
    var m = path.match(/^\/(@[^/]+\/[^/]+)\/?$/) || path.match(/^\/([^@/$][^/]*:[0-9a-f]{1,40})\/?$/i);
    if (!m) return null;
    return { path: m[1], start: startOf(url) };
  }

  function bitchute(url) {
    var host = bareHost(url);
    if (host !== "bitchute.com" && host !== "old.bitchute.com") return null;
    var m = url.pathname.match(/^\/(?:video|embed)\/([A-Za-z0-9_-]{6,20})\/?$/);
    return m ? { id: m[1] } : null;
  }

  function rumble(url) {
    if (bareHost(url) !== "rumble.com") return null;
    var embed = url.pathname.match(/^\/embed\/(v[a-z0-9]{3,12})\/?$/i);
    if (embed) return { embed: embed[1] };
    /* Page ids (/v4ab12-title.html) are not embed ids. The page's own oEmbed
       answer carries the player URL, so the card waits for it. */
    if (/^\/v[a-z0-9]{3,12}-[^/]*\.html$/i.test(url.pathname)) return { page: true };
    return null;
  }

  function tiktok(url) {
    var host = bareHost(url);
    if (host !== "tiktok.com") return null;
    var m = url.pathname.match(/^\/@[^/]+\/video\/(\d{8,25})/) || url.pathname.match(/^\/(?:embed\/v2|embed|player\/v1|v)\/(\d{8,25})/);
    return m ? { id: m[1] } : null;
  }

  function facebook(url) {
    var host = bareHost(url);
    if (host === "fb.watch") return /^\/[A-Za-z0-9_-]{4,20}\/?$/.test(url.pathname) ? { tall: false } : null;
    if (host !== "facebook.com" && host !== "web.facebook.com") return null;
    if (/^\/reel\/\d{5,25}\/?$/.test(url.pathname)) return { tall: true };
    if (/^\/watch\/?$/.test(url.pathname) && /^\d{5,25}$/.test(url.searchParams.get("v") || "")) return { tall: false };
    if (/^\/[^/]+\/videos\/(?:[^/]+\/)?\d{5,25}\/?$/.test(url.pathname)) return { tall: false };
    return null;
  }

  function instagram(url) {
    if (bareHost(url) !== "instagram.com") return null;
    var m = url.pathname.match(/^\/(?:[A-Za-z0-9._]+\/)?(reels?|tv)\/([A-Za-z0-9_-]{5,40})\/?/);
    return m ? { code: m[2] } : null;
  }

  /* PeerTube runs on any host. The path shape only nominates a candidate;
     the page's own oEmbed or og:video player has to confirm it. */
  function peertube(url) {
    var m = url.pathname.match(/^\/videos\/(?:watch|embed)\/([A-Za-z0-9-]{8,40})\/?$/) || url.pathname.match(/^\/w\/([A-Za-z0-9-]{8,40})\/?$/);
    return m ? { id: m[1], start: startOf(url) } : null;
  }

  function q(params) {
    var parts = [];
    Object.keys(params).forEach(function (key) {
      var value = params[key];
      if (value === "" || value == null || value === false) return;
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
    });
    return parts.length ? "?" + parts.join("&") : "";
  }

  var PROVIDERS = [
    {
      id: "youtube",
      name: "YouTube",
      hosts: ["www.youtube-nocookie.com"],
      pause: "youtube",
      match: youtube,
      build: function (m, opts) {
        return {
          embed: "https://www.youtube-nocookie.com/embed/" + m.id + q({ autoplay: 1, playsinline: 1, rel: 0, enablejsapi: 1, origin: originOf(opts), start: m.start || "" }),
          aspect: m.tall ? TALL : WIDE,
          thumb: "https://i.ytimg.com/vi/" + m.id + "/hqdefault.jpg",
          key: m.id
        };
      }
    },
    {
      id: "vimeo",
      name: "Vimeo",
      hosts: ["player.vimeo.com"],
      pause: "vimeo",
      match: vimeo,
      build: function (m) {
        return {
          embed: "https://player.vimeo.com/video/" + m.id + q({ h: m.hash, autoplay: 1, playsinline: 1, dnt: 1 }) + (m.start ? "#t=" + m.start + "s" : ""),
          aspect: WIDE,
          key: m.id
        };
      }
    },
    {
      id: "dailymotion",
      name: "Dailymotion",
      hosts: ["www.dailymotion.com"],
      match: dailymotion,
      build: function (m) {
        return { embed: "https://www.dailymotion.com/embed/video/" + m.id + q({ autoplay: 1, "queue-enable": "false", start: m.start || "" }), aspect: WIDE, key: m.id };
      }
    },
    {
      id: "twitch",
      name: "Twitch",
      hosts: ["clips.twitch.tv", "player.twitch.tv"],
      match: twitch,
      build: function (m, opts) {
        var parent = hostOf(opts);
        if (m.clip) return { embed: "https://clips.twitch.tv/embed" + q({ clip: m.clip, parent: parent, autoplay: "true" }), aspect: WIDE, key: m.clip };
        var t = m.start ? Math.floor(m.start / 3600) + "h" + Math.floor((m.start % 3600) / 60) + "m" + (m.start % 60) + "s" : "";
        return { embed: "https://player.twitch.tv/" + q({ video: "v" + m.video, parent: parent, autoplay: "true", time: t }), aspect: WIDE, key: m.video };
      }
    },
    {
      id: "streamable",
      name: "Streamable",
      hosts: ["streamable.com"],
      match: streamable,
      build: function (m) {
        return { embed: "https://streamable.com/e/" + m.id + q({ autoplay: 1 }), aspect: WIDE, key: m.id };
      }
    },
    {
      id: "kick",
      name: "Kick",
      hosts: ["player.kick.com"],
      match: kick,
      build: function (m) {
        return { embed: "https://player.kick.com/" + encodeURIComponent(m.channel) + q({ autoplay: "true" }), aspect: WIDE, key: m.channel.toLowerCase(), live: true };
      }
    },
    {
      id: "odysee",
      name: "Odysee",
      hosts: ["odysee.com"],
      match: odysee,
      build: function (m) {
        var path = m.path.split("/").map(function (part) { return encodeURIComponent(decodeURIComponent(part)).replace(/%40/g, "@").replace(/%3A/gi, ":"); }).join("/");
        return { embed: "https://odysee.com/$/embed/" + path + q({ autoplay: "true", t: m.start || "" }), aspect: WIDE, key: m.path };
      }
    },
    {
      id: "bitchute",
      name: "BitChute",
      hosts: ["www.bitchute.com"],
      match: bitchute,
      build: function (m) {
        return { embed: "https://www.bitchute.com/embed/" + m.id + "/", aspect: WIDE, key: m.id };
      }
    },
    {
      id: "rumble",
      name: "Rumble",
      hosts: ["rumble.com"],
      match: rumble,
      build: function (m) {
        if (!m.embed) return null;
        return { embed: "https://rumble.com/embed/" + m.embed + "/" + q({ autoplay: 2 }), aspect: WIDE, key: m.embed };
      }
    },
    {
      id: "tiktok",
      name: "TikTok",
      hosts: ["www.tiktok.com"],
      match: tiktok,
      build: function (m) {
        return { embed: "https://www.tiktok.com/player/v1/" + m.id + q({
          autoplay: 1, loop: 1, controls: 0, progress_bar: 0, play_button: 0,
          volume_control: 0, fullscreen_button: 0, timestamp: 0, music_info: 0,
          description: 0, rel: 0, closed_caption: 0
        }), aspect: TALL, key: m.id };
      }
    },
    {
      id: "facebook",
      name: "Facebook",
      hosts: ["www.facebook.com"],
      match: facebook,
      build: function (m, opts, url) {
        return { embed: "https://www.facebook.com/plugins/video.php" + q({ href: url.href, show_text: "false", autoplay: "true", mute: 0 }), aspect: m.tall ? TALL : WIDE, key: url.pathname + url.search };
      }
    },
    {
      id: "instagram",
      name: "Instagram",
      hosts: ["www.instagram.com"],
      match: instagram,
      build: function (m) {
        return { embed: "https://www.instagram.com/reel/" + m.code + "/embed/", aspect: TALL, key: m.code };
      }
    }
  ];

  var EXTENSION = /\.(mp4|m4v|webm|mov|m3u8|mpd|mp3|ogg|ogv)(\?|#|$)/i;
  var PLAYER_PATH = /\/(embed|player|videos\/embed|e|v)\/|[?&](embed|player)=|player\.|\/plugins\/video/i;

  function https(raw) {
    var url = parse(raw);
    return url && url.protocol === "https:" && !url.username && !url.password ? url : null;
  }

  /* An official player the page itself advertises: an oEmbed "video" iframe
     src, or an og:video / twitter:player URL that is a page, not a file. */
  function metaPlayer(meta) {
    meta = meta || {};
    var embed = meta.embed && typeof meta.embed === "object" ? meta.embed : null;
    var src = embed && https(embed.src);
    var w = 0;
    var h = 0;
    if (src) {
      w = Number(embed.width) || 0;
      h = Number(embed.height) || 0;
    } else {
      var video = https(meta.video);
      var type = String(meta.videoType || "").toLowerCase();
      if (!video || EXTENSION.test(video.pathname) || /^(video|audio|application\/(x-mpegurl|vnd\.apple\.mpegurl|dash))/.test(type)) return null;
      if (type.indexOf("html") < 0 && !PLAYER_PATH.test(video.pathname + video.search) && !/player|embed/i.test(video.hostname)) return null;
      src = video;
      w = Number(meta.videoWidth) || 0;
      h = Number(meta.videoHeight) || 0;
    }
    var aspect = w && h && h > w * 1.05 ? TALL : WIDE;
    return { embed: src.href, aspect: aspect, host: src.hostname };
  }

  function firstMatch(url) {
    for (var i = 0; i < PROVIDERS.length; i += 1) {
      var m = PROVIDERS[i].match(url);
      if (m) return { provider: PROVIDERS[i], m: m };
    }
    return null;
  }

  /* resolve(pageUrl, meta?, opts?) -> { provider, name, embed, aspect, thumb,
     open, key, generic } or null. meta is the link preview row, when one has
     loaded; opts.origin / opts.host give the page origin for YouTube origin=
     and Twitch parent=. */
  function resolve(raw, meta, opts) {
    var url = parse(raw);
    if (!url) return null;
    var hit = firstMatch(url);
    var out = null;
    if (hit) {
      var built = hit.provider.build(hit.m, opts || {}, url);
      if (built) {
        out = { provider: hit.provider.id, name: hit.provider.name, embed: built.embed, aspect: built.aspect, thumb: built.thumb || "", key: hit.provider.id + ":" + built.key, pause: hit.provider.pause || "", live: !!built.live };
      }
    }
    if (!out) {
      var player = metaPlayer(meta);
      if (player) {
        var nominee = hit ? hit.provider : null;
        var peer = !nominee && peertube(url);
        var id = nominee ? nominee.id : peer ? "peertube" : "embed";
        out = { provider: id, name: nominee ? nominee.name : (meta && meta.site) || bareHost(url), embed: player.embed, aspect: player.aspect, thumb: "", key: id + ":" + player.embed, pause: "", generic: !nominee };
      }
    }
    if (!out) return null;
    var image = meta && https(meta.image);
    if (!out.thumb && image) out.thumb = image.href;
    out.open = url.href;
    return out;
  }

  /* Matches without any page metadata, so a card can draw its facade at once. */
  function known(raw) {
    var url = parse(raw);
    if (!url) return false;
    var hit = firstMatch(url);
    return !!(hit && hit.provider.build(hit.m, {}, url));
  }

  /* Whether a URL is worth waiting on page metadata for a player. */
  function candidate(raw) {
    var url = parse(raw);
    if (!url) return false;
    return !!(firstMatch(url) || peertube(url));
  }

  /* Hosts a known provider frames from (for a future CSP frame-src list). */
  function frameHosts() {
    var out = [];
    PROVIDERS.forEach(function (p) { p.hosts.forEach(function (h) { if (out.indexOf(h) < 0) out.push(h); }); });
    return out;
  }

  /* The message that pauses a provider's player in place, or "" when the
     player has no documented pause message (the card unloads it instead). */
  function pauseMessage(kind) {
    if (kind === "youtube") return JSON.stringify({ event: "command", func: "pauseVideo", args: [] });
    if (kind === "vimeo") return JSON.stringify({ method: "pause" });
    return "";
  }

  var api = {
    resolve: resolve,
    known: known,
    candidate: candidate,
    metaPlayer: metaPlayer,
    frameHosts: frameHosts,
    pauseMessage: pauseMessage,
    seconds: seconds,
    providers: PROVIDERS.map(function (p) { return p.id; }).concat(["peertube", "embed"])
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ViktorychVideoProviders = api;
})(typeof self !== "undefined" ? self : this);
