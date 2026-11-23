/**
 * Periodic maintenance (no worker changes):
 * 1) Stamp seq_in_chat on any messages still missing a label
 * 2) Hide same-chat duplicate property listings via property_dup_hide
 *    (app-owned table — Contabo user may not ALTER normalized_messages)
 *    Chat history (whatsapp_messages) is never deleted.
 */
const {
  listingDedupeScope,
  listingFingerprint
} = require('./propertyHelper');
const {
  ensureMonitorLetter,
  allocateSeqInChat
} = require('./seqHelper');

function getDb() {
  return require('./db');
}

async function ensureHideTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS property_dup_hide (
      normalized_id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      chat_jid TEXT,
      kept_id INTEGER,
      marked_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_property_dup_hide_user ON property_dup_hide (user_id)`
  );
}

/**
 * Assign letter-n seq for messages that have NULL/empty seq_in_chat.
 * Safe to re-run; only touches rows missing a stamp.
 */
async function stampMissingSeqLabels(limit = 2000) {
  const db = getDb();
  const missing = await db.query(
    `SELECT m.id, m.user_id, m.chat_jid
     FROM whatsapp_messages m
     WHERE m.seq_in_chat IS NULL OR BTRIM(COALESCE(m.seq_in_chat, '')) = ''
     ORDER BY m.id ASC
     LIMIT $1`,
    [Math.max(1, Math.min(Number(limit) || 2000, 5000))]
  );
  if (!missing.rows.length) return { stamped: 0 };

  const client = await db.pool.connect();
  let stamped = 0;
  try {
    const byChat = new Map();
    for (const row of missing.rows) {
      const key = `${row.user_id}|${row.chat_jid}`;
      if (!byChat.has(key)) byChat.set(key, []);
      byChat.get(key).push(row);
    }

    for (const [, rows] of byChat) {
      const { user_id: userId, chat_jid: chatJid } = rows[0];
      await client.query('BEGIN');
      try {
        await client.query(
          `SELECT id FROM whatsapp_chats WHERE user_id = $1 AND jid = $2 FOR UPDATE`,
          [userId, chatJid]
        );
        await ensureMonitorLetter(userId, chatJid, client);
        for (const row of rows) {
          const nextSeq = await allocateSeqInChat(client, userId, chatJid);
          const r = await client.query(
            `UPDATE whatsapp_messages
             SET seq_in_chat = $2
             WHERE id = $1
               AND (seq_in_chat IS NULL OR BTRIM(COALESCE(seq_in_chat, '')) = '')
             RETURNING id`,
            [row.id, nextSeq]
          );
          if (r.rowCount) stamped += 1;
        }
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {}
        console.warn(
          `[maintenance] seq stamp failed user=${userId} jid=${chatJid}:`,
          err.message
        );
      }
    }
  } finally {
    client.release();
  }
  return { stamped };
}

/**
 * Soft-hide older duplicate property rows in the same chat (same content fingerprint).
 * Keeps the newest normalized_messages.id. Writes to property_dup_hide only.
 */
async function markDuplicateProperties(batchSize = 8000) {
  const db = getDb();
  await ensureHideTable(db);

  const result = await db.query(
    `SELECT n.id, n.whatsapp_message_id, n.chat_jid, n.purpose, n.size, n.price,
            n.contact_number, n.area, n.vicinity, n.listing_excerpt, n.summary,
            n.listing_index, m.user_id,
            LEFT(COALESCE(NULLIF(TRIM(n.listing_excerpt), ''), m.message), 280) AS raw_message
     FROM normalized_messages n
     INNER JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE n.is_property IS TRUE
       AND NOT EXISTS (
         SELECT 1 FROM property_dup_hide h WHERE h.normalized_id = n.id
       )
     ORDER BY n.id DESC
     LIMIT $1`,
    [Math.max(100, Math.min(Number(batchSize) || 8000, 20000))]
  );

  const keepByScope = new Map();
  const hideRows = [];

  for (const row of result.rows) {
    const fp = listingFingerprint(row);
    const meaningful = fp.replace(/\|/g, '').trim().length >= 12;
    if (!meaningful) continue;

    const scope = listingDedupeScope({
      ...row,
      userId: row.user_id,
      chatJid: row.chat_jid,
      contactNumber: row.contact_number,
      rawMessage: row.raw_message
    });

    if (keepByScope.has(scope)) {
      hideRows.push({
        normalized_id: row.id,
        user_id: row.user_id,
        chat_jid: row.chat_jid,
        kept_id: keepByScope.get(scope)
      });
    } else {
      keepByScope.set(scope, row.id);
    }
  }

  let marked = 0;
  const CHUNK = 100;
  for (let i = 0; i < hideRows.length; i += CHUNK) {
    const slice = hideRows.slice(i, i + CHUNK);
    const params = [];
    const values = [];
    let p = 1;
    for (const h of slice) {
      values.push(`($${p++},$${p++},$${p++},$${p++})`);
      params.push(h.normalized_id, h.user_id, h.chat_jid, h.kept_id);
    }
    const upd = await db.query(
      `INSERT INTO property_dup_hide (normalized_id, user_id, chat_jid, kept_id)
       VALUES ${values.join(',')}
       ON CONFLICT (normalized_id) DO NOTHING`,
      params
    );
    marked += upd.rowCount || 0;
  }

  return {
    scanned: result.rows.length,
    marked,
    kept: keepByScope.size
  };
}

async function runDuplicateMaintenance(opts = {}) {
  const seqLimit = opts.seqLimit ?? 2000;
  const propBatch = opts.propBatch ?? 8000;
  const seq = await stampMissingSeqLabels(seqLimit);
  const dups = await markDuplicateProperties(propBatch);
  return { seq, dups };
}

module.exports = {
  stampMissingSeqLabels,
  markDuplicateProperties,
  runDuplicateMaintenance,
  ensureHideTable
};
