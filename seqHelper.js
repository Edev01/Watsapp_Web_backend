/**
 * Monitored-chat sequence labels: first chat a-1,a-2,… second b-1,b-2,…
 * Letter is sticky on whatsapp_chats.monitor_letter once assigned.
 */

function getDb() {
  return require('./db');
}

function indexToLetter(index) {
  let n = Number(index);
  if (!Number.isFinite(n) || n < 0) n = 0;
  let s = '';
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function letterToIndex(letter) {
  const s = String(letter || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (!s) return -1;
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    n = n * 26 + (s.charCodeAt(i) - 96);
  }
  return n - 1;
}

function parseSeqNumber(seq) {
  const s = String(seq || '').trim();
  if (!s) return null;
  const m = s.match(/^[a-z]+-(\d+)$/i);
  if (m) return parseInt(m[1], 10);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

function formatSeq(letter, num) {
  return `${String(letter).toLowerCase()}-${num}`;
}

async function nextMonitorLetter(userId, client = null) {
  const db = client || getDb();
  const r = await db.query(
    `SELECT monitor_letter FROM whatsapp_chats
     WHERE user_id = $1 AND monitor_letter IS NOT NULL AND BTRIM(monitor_letter) <> ''`,
    [userId]
  );
  let maxIdx = -1;
  for (const row of r.rows) {
    const idx = letterToIndex(row.monitor_letter);
    if (idx > maxIdx) maxIdx = idx;
  }
  return indexToLetter(maxIdx + 1);
}

/**
 * Ensure a monitored chat has a stable letter. Assigns next free letter if missing.
 */
async function ensureMonitorLetter(userId, chatJid, client = null) {
  const db = client || getDb();
  const existing = await db.query(
    `SELECT monitor_letter, is_monitored FROM whatsapp_chats
     WHERE user_id = $1 AND jid = $2`,
    [userId, chatJid]
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (row.monitor_letter && String(row.monitor_letter).trim()) {
    return String(row.monitor_letter).trim().toLowerCase();
  }
  const letter = await nextMonitorLetter(userId, db);
  const upd = await db.query(
    `UPDATE whatsapp_chats
     SET monitor_letter = $3
     WHERE user_id = $1 AND jid = $2
       AND (monitor_letter IS NULL OR BTRIM(monitor_letter) = '')
     RETURNING monitor_letter`,
    [userId, chatJid, letter]
  );
  return (upd.rows[0]?.monitor_letter || letter).toLowerCase();
}

/** Assign letters: monitored chats first (by monitored_at), then other chats that have msgs. */
async function backfillMonitorLetters(userId = null, client = null) {
  const db = client || getDb();
  const params = [];
  let userSql = '';
  if (userId != null) {
    params.push(userId);
    userSql = `AND c.user_id = $${params.length}`;
  }
  const chats = await db.query(
    `SELECT c.user_id, c.jid FROM whatsapp_chats c
     WHERE (monitor_letter IS NULL OR BTRIM(monitor_letter) = '')
       AND (
         c.is_monitored = TRUE
         OR EXISTS (
           SELECT 1 FROM whatsapp_messages m
           WHERE m.user_id = c.user_id AND m.chat_jid = c.jid
             AND m.seq_in_chat IS NOT NULL
         )
       )
       ${userSql}
     ORDER BY c.user_id,
       CASE WHEN c.is_monitored THEN 0 ELSE 1 END,
       COALESCE(c.monitored_at, c.created_at) ASC NULLS LAST,
       c.id ASC`,
    params
  );
  let assigned = 0;
  for (const c of chats.rows) {
    await ensureMonitorLetter(c.user_id, c.jid, db);
    assigned += 1;
  }
  return assigned;
}

/**
 * Next seq label for a chat: "{letter}-{n}" (1-based within that chat).
 */
async function allocateSeqInChat(client, userId, chatJid) {
  const letter = (await ensureMonitorLetter(userId, chatJid, client)) || 'x';
  const r = await client.query(
    `SELECT COALESCE(MAX(
       CASE
         WHEN seq_in_chat ~ ('^' || $3 || '-[0-9]+$') THEN CAST(split_part(seq_in_chat, '-', 2) AS INTEGER)
         WHEN seq_in_chat ~ '^[0-9]+$' THEN CAST(seq_in_chat AS INTEGER) + 1
         ELSE 0
       END
     ), 0) + 1 AS next_num
     FROM whatsapp_messages
     WHERE user_id = $1 AND chat_jid = $2`,
    [userId, chatJid, letter]
  );
  return formatSeq(letter, r.rows[0].next_num);
}

/**
 * Re-stamp every message seq as {letter}-{1..n} in chat order (id ASC).
 */
async function rebuildAllSeqLabels(client = null) {
  const db = client || getDb();
  const result = await db.query(`
    WITH ordered AS (
      SELECT m.id,
             lower(c.monitor_letter) AS letter,
             ROW_NUMBER() OVER (
               PARTITION BY m.user_id, m.chat_jid
               ORDER BY m.id ASC
             ) AS rn
      FROM whatsapp_messages m
      JOIN whatsapp_chats c
        ON c.user_id = m.user_id AND c.jid = m.chat_jid
      WHERE c.monitor_letter IS NOT NULL
        AND BTRIM(c.monitor_letter) <> ''
        AND m.seq_in_chat IS NOT NULL
    )
    UPDATE whatsapp_messages m
    SET seq_in_chat = o.letter || '-' || o.rn::text
    FROM ordered o
    WHERE m.id = o.id
  `);
  return result.rowCount || 0;
}

/**
 * Migrate legacy integer seq_in_chat values to letter-n for chats that have a monitor_letter.
 * Old 0-based ints become letter-(n+1).
 */
async function rewriteLegacySeqLabels(client = null) {
  const db = client || getDb();
  const result = await db.query(`
    UPDATE whatsapp_messages m
    SET seq_in_chat = lower(c.monitor_letter) || '-' || (CAST(m.seq_in_chat AS INTEGER) + 1)::text
    FROM whatsapp_chats c
    WHERE c.user_id = m.user_id
      AND c.jid = m.chat_jid
      AND c.monitor_letter IS NOT NULL
      AND BTRIM(c.monitor_letter) <> ''
      AND m.seq_in_chat IS NOT NULL
      AND m.seq_in_chat ~ '^[0-9]+$'
  `);
  return result.rowCount || 0;
}

/**
 * One-shot: clear letters, assign monitored-first, rebuild all seq labels.
 */
async function reassignMonitorLettersAndSeqs(client = null) {
  const db = client || getDb();
  await db.query(`UPDATE whatsapp_chats SET monitor_letter = NULL`);
  const letters = await backfillMonitorLetters(null, db);
  const rebuilt = await rebuildAllSeqLabels(db);
  return { letters, rebuilt };
}

module.exports = {
  indexToLetter,
  letterToIndex,
  parseSeqNumber,
  formatSeq,
  nextMonitorLetter,
  ensureMonitorLetter,
  backfillMonitorLetters,
  allocateSeqInChat,
  rewriteLegacySeqLabels,
  rebuildAllSeqLabels,
  reassignMonitorLettersAndSeqs
};
