/* Daily D1 export into the private R2 bucket. The minute cron calls
   maybeBackupD1 once the UTC clock reaches 04:17, and again at :17 after
   that until today's object exists. Fourteen daily objects are kept.
   D1 Time Travel remains the 7-day point-in-time restore. */

export const BACKUP_PREFIX = "backups/d1/";
export const KEEP_DAYS = 14;

export function backupSlot(at) {
  const when = new Date(Number(at) || 0);
  if (Number.isNaN(when.getTime())) return false;
  return when.getUTCMinutes() === 17 && when.getUTCHours() >= 4;
}

export function dayStamp(at) {
  return new Date(Number(at) || Date.now()).toISOString().slice(0, 10);
}

export function backupKey(at) {
  return BACKUP_PREFIX + dayStamp(at) + ".sql.gz";
}

function quoteIdent(name) {
  const text = String(name || "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return "";
  return '"' + text + '"';
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function keepTable(name) {
  const text = String(name || "");
  if (!text) return false;
  if (text.indexOf("sqlite_") === 0) return false;
  if (text.indexOf("_cf_") === 0) return false;
  if (text.indexOf("d1_") === 0) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text);
}

async function gzipText(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const PAGE_ROWS = 500;
export const MAX_ROWS = 200000;

function pushRows(chunks, ident, cols, rows) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const values = cols.map((col) => sqlLiteral(row[col.slice(1, -1)]));
    chunks.push("INSERT INTO " + ident + " (" + cols.join(", ") + ") VALUES (" + values.join(", ") + ");\n");
  }
}

/* Pages walk the rowid, so each row is read once. LIMIT/OFFSET re-read every
   earlier row on each page: the 18k-row telegram_files table alone cost about
   two million D1 rows read per backup. WITHOUT ROWID tables have no rowid and
   fall back to OFFSET pages. */
async function dumpTable(env, name, chunks) {
  const ident = quoteIdent(name);
  if (!ident) return;
  const info = await env.DB.prepare("PRAGMA table_info(" + ident + ")").all();
  const cols = ((info && info.results) || []).map((row) => quoteIdent(row.name)).filter(Boolean);
  if (!cols.length) return;
  const select = "SELECT " + cols.join(", ");
  let done = 0;
  let last = null;
  let keyset = true;
  while (done < MAX_ROWS) {
    let page = null;
    if (keyset) {
      try {
        page = last === null
          ? await env.DB.prepare(select + ", rowid AS \"__vk_rowid\" FROM " + ident + " ORDER BY rowid LIMIT " + PAGE_ROWS).all()
          : await env.DB.prepare(select + ", rowid AS \"__vk_rowid\" FROM " + ident + " WHERE rowid > ? ORDER BY rowid LIMIT " + PAGE_ROWS).bind(last).all();
      } catch (err) {
        if (done > 0) throw err;
        keyset = false;
      }
    }
    if (!keyset) page = await env.DB.prepare(select + " FROM " + ident + " LIMIT " + PAGE_ROWS + " OFFSET " + done).all();
    const rows = (page && page.results) || [];
    if (!rows.length) break;
    pushRows(chunks, ident, cols, rows);
    done += rows.length;
    if (keyset) last = rows[rows.length - 1].__vk_rowid;
    if (rows.length < PAGE_ROWS) break;
  }
}

export async function exportDatabase(env, at) {
  if (!env || !env.DB || !env.DATA) return null;
  const listed = await env.DB.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all();
  const rows = ((listed && listed.results) || []).filter((row) => keepTable(row.name) && row.sql);
  const rank = { table: 0, view: 1, index: 2, trigger: 3 };
  rows.sort((a, b) => (rank[a.type] == null ? 9 : rank[a.type]) - (rank[b.type] == null ? 9 : rank[b.type]));
  const tables = rows.filter((row) => row.type === "table");
  const rest = rows.filter((row) => row.type !== "table");
  const chunks = [];
  chunks.push("-- ViktorychApp D1 backup\n");
  chunks.push("-- day: " + dayStamp(at) + "\n");
  chunks.push("PRAGMA foreign_keys=OFF;\nBEGIN;\n");
  for (let i = 0; i < tables.length; i++) {
    const ident = quoteIdent(tables[i].name);
    if (ident) chunks.push("DROP TABLE IF EXISTS " + ident + ";\n");
  }
  for (let i = 0; i < tables.length; i++) chunks.push(String(tables[i].sql).trim() + ";\n");
  for (let i = 0; i < tables.length; i++) await dumpTable(env, tables[i].name, chunks);
  for (let i = 0; i < rest.length; i++) chunks.push(String(rest[i].sql).trim() + ";\n");
  chunks.push("COMMIT;\n");
  const bytes = await gzipText(chunks.join(""));
  const key = backupKey(at);
  await env.DATA.put(key, bytes, { httpMetadata: { contentType: "application/gzip" } });
  return { key: key, bytes: bytes.byteLength };
}

async function listBackupKeys(env) {
  const names = [];
  let cursor = undefined;
  for (let page = 0; page < 20; page++) {
    const listed = await env.DATA.list({ prefix: BACKUP_PREFIX, cursor: cursor });
    const objects = (listed && listed.objects) || [];
    for (let i = 0; i < objects.length; i++) {
      const key = String(objects[i] && objects[i].key || "");
      if (/^backups\/d1\/\d{4}-\d{2}-\d{2}\.sql\.gz$/.test(key)) names.push(key);
    }
    if (!listed || !listed.truncated) break;
    cursor = listed.cursor;
    if (!cursor) break;
  }
  names.sort();
  return names;
}

export async function pruneBackups(env, at, keep) {
  if (!env || !env.DATA) return [];
  const days = Math.max(1, Number(keep) || KEEP_DAYS);
  const names = await listBackupKeys(env);
  const cutoff = dayStamp(Number(at) - (days - 1) * 24 * 60 * 60 * 1000);
  const removed = [];
  for (let i = 0; i < names.length; i++) {
    const day = names[i].slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10);
    if (day < cutoff) {
      await env.DATA.delete(names[i]);
      removed.push(names[i]);
    }
  }
  return removed;
}

export async function maybeBackupD1(env, at) {
  if (!env || !env.DB || !env.DATA) return false;
  if (!backupSlot(at)) return false;
  const key = backupKey(at);
  const existing = await env.DATA.head(key);
  if (existing) {
    await pruneBackups(env, at, KEEP_DAYS);
    return false;
  }
  const lockKey = BACKUP_PREFIX + "_lock";
  const lock = await env.DATA.get(lockKey);
  if (lock) {
    const started = Number(await lock.text());
    if (Number.isFinite(started) && Date.now() - started < 20 * 60 * 1000) return false;
  }
  await env.DATA.put(lockKey, String(Date.now()));
  try {
    await exportDatabase(env, at);
    await pruneBackups(env, at, KEEP_DAYS);
    return true;
  } finally {
    try { await env.DATA.delete(lockKey); }
    catch (err) { /* the next hour can take the lock */ }
  }
}
