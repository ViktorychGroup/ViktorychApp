/* Items the owner has parked on purpose. They show as paused, not as alerts.
   Delete a row to make that item alert again. Do not delete queued videos.

   telegram-backup.yml is a priority and is not in this list. It copies the
   site's private R2 media to Telegram, not only TikTok. Do not pause it
   unless the owner says so. media-extract.yml is also not paused: its last
   failures were a stalled read, which is fixed. A new failure of either
   workflow, or of any workflow that is not listed here, still alerts. */

export const STATUS_PAUSED = [
  {
    id: "tiktok-live",
    reason: "Paused: TikTok live stays off until you turn tiktok-live.yml back on in Actions.",
    match: (row) => row && (row.code === "workflow_off_tiktok-live.yml" || row.code === "workflow_failing_tiktok-live.yml")
  },
  {
    id: "tiktok-save-age",
    reason: "Paused: the TikTok save queue has a known backlog of videos waiting over six hours. Those videos stay queued. Delete tiktok-save-age from the paused list to alert on the age again.",
    match: (row) => row && row.code === "tiktok_save_queue" && /waiting over six hours/i.test(String(row.text || ""))
  }
];

export function splitPaused(problems, list) {
  const rules = Array.isArray(list) ? list : STATUS_PAUSED;
  const alerts = [];
  const paused = [];
  (Array.isArray(problems) ? problems : []).forEach((row) => {
    const rule = rules.find((item) => {
      try { return item.match(row); } catch (err) { return false; }
    });
    if (!rule) {
      alerts.push(row);
      return;
    }
    paused.push({
      code: row.code,
      level: "paused",
      id: rule.id,
      reason: rule.reason,
      text: rule.reason,
      since: row.since
    });
  });
  return { alerts, paused };
}

/* Reclassify a stored health document. A paused row whose id was removed
   from the list is dropped here; the next watchdog run records it as an alert. */
export function applyPaused(doc, list) {
  const source = doc && typeof doc === "object" ? doc : {};
  const rules = Array.isArray(list) ? list : STATUS_PAUSED;
  const split = splitPaused(source.problems, rules);
  const allowed = new Set(rules.map((item) => item.id));
  const paused = split.paused.slice();
  const seen = new Set(paused.map((row) => row.id + "\n" + row.code));
  (Array.isArray(source.paused) ? source.paused : []).forEach((row) => {
    if (!row || !allowed.has(row.id)) return;
    const key = row.id + "\n" + (row.code || "");
    if (seen.has(key)) return;
    seen.add(key);
    paused.push(row);
  });
  const problems = split.alerts;
  return Object.assign({}, source, {
    problems,
    paused,
    ok: !problems.some((row) => row && row.level === "down")
  });
}
