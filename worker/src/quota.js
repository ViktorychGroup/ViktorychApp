/* How close today is to the free daily limits, as one percent.

   Each isolate asks Cloudflare's analytics at most once every three minutes,
   in the background (ctx.waitUntil), so no request ever waits for it. Every
   answer then carries X-Quota-Pct: Worker requests today against the free
   100k/day. Clients move reads to the backup origin when it gets high, before
   Cloudflare starts refusing. D1 is shared by every origin, so it is not
   part of this number (the owner usage panel shows it). */

import { FREE_LIMITS } from "./usage.js";

const EVERY_MS = 3 * 60 * 1000;
let pct = -1;
let checkedAt = 0;
let day = "";
let busy = false;
let d1Pct = -1;

const QUERY = `query Q($acc: String!, $today: Date!) {
  viewer { accounts(filter: { accountTag: $acc }) {
    w: workersInvocationsAdaptive(limit: 100, filter: { date: $today }) { sum { requests } }
    d: d1AnalyticsAdaptiveGroups(limit: 10, filter: { date: $today }) { sum { rowsRead } }
  } }
}`;

export function quotaPct(now) {
  const today = new Date(Number(now) || Date.now()).toISOString().slice(0, 10);
  if (day && today !== day) return 0;
  return pct;
}

/* D1 rows read today against the free 5M/day, as one percent; -1 unknown. */
export function d1ReadPct(now) {
  const today = new Date(Number(now) || Date.now()).toISOString().slice(0, 10);
  if (day && today !== day) return 0;
  return d1Pct;
}

export function d1PctFrom(acc) {
  const rows = (acc && acc.d) || [];
  if (!rows.length) return -1;
  const n = rows.reduce((t, r) => t + Number(r.sum && r.sum.rowsRead || 0), 0);
  return Math.min(999, Math.round(n / FREE_LIMITS.d1RowsReadDay * 100));
}

export function quotaFrom(acc) {
  const sum = (rows, key) => (rows || []).reduce((n, r) => n + Number(r.sum && r.sum[key] || 0), 0);
  return Math.min(999, Math.round(sum(acc.w, "requests") / FREE_LIMITS.workerRequestsDay * 100));
}

export function refreshQuota(env, ctx, now, fetcher) {
  const at = Number(now) || Date.now();
  if (busy || at - checkedAt < EVERY_MS || !env || !env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return null;
  busy = true;
  checkedAt = at;
  const today = new Date(at).toISOString().slice(0, 10);
  const run = (fetcher || fetch)("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer " + env.CF_ANALYTICS_TOKEN },
    body: JSON.stringify({ query: QUERY, variables: { acc: env.CF_ACCOUNT_ID, today } })
  }).then((res) => res.ok ? res.json() : null).then((body) => {
    const acc = body && body.data && body.data.viewer && body.data.viewer.accounts && body.data.viewer.accounts[0];
    if (!acc) return;
    pct = quotaFrom(acc);
    d1Pct = d1PctFrom(acc);
    day = today;
  }).catch(() => {}).finally(() => { busy = false; });
  if (ctx && ctx.waitUntil) ctx.waitUntil(run);
  return run;
}

export function resetQuota() { pct = -1; d1Pct = -1; checkedAt = 0; day = ""; busy = false; }
export function setQuotaForTest(value, today, d1) { pct = value; day = today || ""; if (d1 !== undefined) d1Pct = d1; }
