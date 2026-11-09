/* Compare-and-swap for the source-list index.
   R2's conditional put returns null when the condition fails. It does not
   throw. A thrown precondition is the same failure. */

const JSON_TYPE = { httpMetadata: { contentType: "application/json; charset=utf-8" } };

function rejected(err) {
  const name = String((err && err.name) || "");
  const message = String((err && err.message) || err || "");
  return name === "PreconditionFailed" || (err && err.status === 412) || /precondition/i.test(message);
}

export async function putJsonIfMatch(bucket, key, value, etag) {
  const opts = Object.assign({}, JSON_TYPE);
  if (etag) opts.onlyIf = { etagMatches: etag };
  else opts.onlyIf = { etagDoesNotMatch: "*" };
  try {
    const stored = await bucket.put(key, JSON.stringify(value), opts);
    return !!stored;
  } catch (err) {
    if (rejected(err)) return false;
    throw err;
  }
}

export function sameIds(left, right) {
  const a = (left || []).map(String);
  const b = (right || []).map(String);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* True only for the exact entry this publish wrote. A newer hash, a
   different source list, or a different membership is left alone. */
export function isExactPublication(row, update) {
  if (!row || !update || !update.entry) return false;
  const members = update.entry.membersKey || (update.expectMembers || []).join("\n");
  const sources = update.expectSources || update.entry.sources || [];
  return row.hash === update.entry.hash
    && String(row.membersKey || "") === String(members)
    && sameIds(row.sources, sources);
}

export function notifyIds(ids) {
  const out = [];
  (ids || []).forEach((id) => {
    const text = String(id || "");
    if (text && out.indexOf(text) < 0) out.push(text);
  });
  return out;
}

/* Stop reading once maxBytes is in hand. The rest of the body is cancelled. */
export async function readBounded(res, maxBytes) {
  const cap = Math.max(0, Number(maxBytes) || 0);
  if (!res || !res.body || typeof res.body.getReader !== "function") {
    const text = res && res.text ? await res.text() : "";
    return String(text).slice(0, cap);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < cap) {
    const step = await reader.read();
    if (step.done) break;
    const chunk = step.value || new Uint8Array();
    const room = cap - total;
    if (chunk.byteLength > room) {
      chunks.push(chunk.subarray(0, room));
      total += room;
      try { await reader.cancel(); } catch (err) { /* the producer may already be done */ }
      break;
    }
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total >= cap) {
      try { await reader.cancel(); } catch (err) { /* the producer may already be done */ }
      break;
    }
  }
  const buf = new Uint8Array(total);
  let at = 0;
  chunks.forEach((chunk) => { buf.set(chunk, at); at += chunk.byteLength; });
  return new TextDecoder().decode(buf);
}
