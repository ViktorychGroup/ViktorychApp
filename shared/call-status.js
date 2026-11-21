/* Live-call status line and when the screen may remount.
   A brief ICE or signaling blip must not flash "Reconnecting" or rebuild
   the chat (that drops focus, scroll, and typed text). */

export const RECONNECT_HOLD_MS = 2000;

const HEALTHY = { connected: 1, joined: 1, "translating-ready": 1 };

export function applyStatusCode(prev, code) {
  if (code === "translating-ready") {
    if (!prev || prev === "reconnecting" || prev === "translator-reconnecting") return "connected";
    return prev;
  }
  if (code === "translator-reconnecting") {
    return prev && HEALTHY[prev] ? prev : (prev || "connected");
  }
  return code;
}

export function holdStatus(prev, code, now, heldAt, holdMs) {
  const ms = holdMs == null ? RECONNECT_HOLD_MS : holdMs;
  if (code === "connected" || code === "joined") {
    return { code: code, heldAt: 0 };
  }
  if (code === "reconnecting" && prev && HEALTHY[prev]) {
    if (!heldAt) return { code: prev, heldAt: now };
    if (now - heldAt < ms) return { code: prev, heldAt: heldAt };
  }
  return { code: applyStatusCode(prev, code), heldAt: 0 };
}

export function shouldRemountOnStatus(phase, code) {
  return (code === "joined" || code === "connected") && phase !== "active";
}

export function shouldRemountOnPeer(prev, next) {
  const name = (next && next.name) || "";
  const degraded = !!(next && next.degraded);
  if (!prev) return true;
  return (name !== "" && name !== (prev.name || "")) || degraded !== !!prev.degraded;
}

export function iceAlreadyUp(state) {
  return state === "connected" || state === "completed";
}

/* ICE is clearly down; a signaling reopen must not show Connected. */
export function iceClearlyDown(state) {
  return state === "failed" || state === "disconnected" || state === "closed";
}

export function signalOpenRestores(iceState, peerJoined) {
  if (iceClearlyDown(iceState)) return false;
  return !!(peerJoined || iceAlreadyUp(iceState));
}

/* Fresh TURN / STUN from a later ticket replace the current set. */
export function iceConfigWithServers(current, iceServers) {
  if (!Array.isArray(iceServers) || !iceServers.length) return null;
  const base = current && typeof current === "object" ? Object.assign({}, current) : { bundlePolicy: "max-bundle" };
  return Object.assign({}, base, { iceServers: iceServers });
}

/* Distinct peers cap the room at two. A reconnect from the same peer
   replaces its existing socket instead of being rejected as "full". */
export function signalAdmit(open, peer) {
  const list = Array.isArray(open) ? open : [];
  const stale = [];
  const others = [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (row && row.peer === peer) stale.push(row);
    else others.push(row);
  }
  if (others.length >= 2) return { ok: false, stale: [], others: others };
  return { ok: true, stale: stale, others: others };
}

/* After the phone was locked or backgrounded, a Live socket can still look
   open (readyState 1) while it is dead. Refresh it when the tab was hidden
   long enough, or when it has been idle longer than a keep-alive. */
export const FOREGROUND_PIPE_MS = 8000;
export const LIVE_PIPE_IDLE_MS = 60 * 1000;

export function shouldRefreshLivePipe(hiddenMs, lastAct, now, hiddenLimit, idleLimit) {
  if ((Number(hiddenMs) || 0) >= (hiddenLimit == null ? FOREGROUND_PIPE_MS : hiddenLimit)) return true;
  return (Number(now) || 0) - (Number(lastAct) || 0) >= (idleLimit == null ? LIVE_PIPE_IDLE_MS : idleLimit);
}

/* A getUserMedia stream is only usable while at least one audio track is live. */
export function micTrackLive(stream) {
  if (!stream || typeof stream.getAudioTracks !== "function") return false;
  return stream.getAudioTracks().some((track) => track && track.readyState === "live");
}

/* A guest session lives only on this tab or this device. The raw token is
   never sent to another machine. It expires, and hanging up deletes it. */
export const GUEST_SESSION_KEY = "viktorych-calls-guest-session-v1";
export const GUEST_SESSION_MS = 2 * 60 * 60 * 1000;

export function guestSessionRecord(input, now) {
  const src = input || {};
  const token = String(src.token || "");
  const callId = String(src.callId || "");
  if (!token.startsWith("cg1.") || token.length > 80) return null;
  if (!/^[a-f0-9]{32}$/.test(callId)) return null;
  const expiresAt = Number(src.expiresAt) || (Number(now) || Date.now()) + GUEST_SESSION_MS;
  if (expiresAt <= (Number(now) || Date.now())) return null;
  return {
    token: token,
    callId: callId,
    invite: String(src.invite || "").slice(0, 80),
    name: String(src.name || "").slice(0, 40),
    expiresAt: expiresAt,
    at: Number(src.at) || (Number(now) || Date.now())
  };
}

export function guestSessionLive(row, now) {
  if (!row || !row.token || !row.callId) return false;
  if (!String(row.token).startsWith("cg1.") || !/^[a-f0-9]{32}$/.test(String(row.callId))) return false;
  return Number(row.expiresAt) > (Number(now) || Date.now());
}

export function guestSessionForRoute(row, route, now) {
  if (!guestSessionLive(row, now)) return null;
  const r = route || {};
  if (r.name === "callguest" || r.name === "callschedule") {
    if (r.token && row.invite && row.invite !== r.token) return null;
    return row;
  }
  if (r.name === "calllink") {
    const key = r.slug ? "link:" + r.slug : "";
    if (r.slug && row.invite && row.invite !== r.slug && row.invite !== key) return null;
    return row;
  }
  if (r.name === "calls" || !r.name) return row;
  return row;
}

/* Map a Worker or HTTP failure to a stable kind. The call page turns the
   kind into a translated line. Unknown 5xx errors are a service problem,
   not the person's network. */
export function callErrorKind(res) {
  const status = res && res.status;
  const code = res && res.data && res.data.error;
  if (code === "not_configured") return "not_configured";
  if (code === "calls_closed") return "calls_closed";
  if (code === "not_found" || code === "token") return "not_found";
  if (code === "ended" || code === "missed") return "ended";
  if (code === "cancelled") return "cancelled";
  if (code === "not_due") return "not_due";
  if (code === "in_call") return "in_call";
  if (code === "guests") return "guests";
  if (code === "unauthorized") return "unauthorized";
  if (code === "quota") return "quota";
  if (code === "unavailable" || code === "upstream" || code === "channel") return "unavailable";
  if (code === "ticket") return "ticket";
  if (code === "slug_taken") return "slug_taken";
  if (code === "bad_slug") return "bad_slug";
  if (code === "bad_key" || code === "badkey") return "bad_key";
  if (code === "lang") return "lang";
  if (code === "clone" || code === "method" || code === "bad_call" || code === "state" || code === "ids" || code === "text" || code === "rsvp" || code === "when") {
    return "failed";
  }
  if (status === 429) return "quota";
  if (status === 401) return "unauthorized";
  if (status === 403) return "calls_closed";
  if (status === 404) return "not_found";
  if (status === 410) return "ended";
  if (status >= 500) return "unavailable";
  return "network";
}
