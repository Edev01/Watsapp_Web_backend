/**
 * Replace all normalized_messages rows of ONE whatsapp message with freshly built rows.
 * - Runs in a transaction when the db module exposes a pool (db.pool or db.connect).
 * - Keeps the original created_at (search "newest" order does not jump) and any
 *   non-default property_status a user set (SOLD, HOLD, ...) per listing_index.
 * - Rows whose fingerprint already exists as another message's property row are skipped
 *   (same behaviour as the old saveNormalized). If every row is skipped, a stub row is
 *   written so the message is never re-queued as pending.
 */

const JSONB_COLS = new Set(['entities', 'extract_trace']);

async function withTx(db, fn) {
  const pool = db.pool && typeof db.pool.connect === 'function' ? db.pool : typeof db.connect === 'function' ? db : null;
  if (!pool) {
    if (!withTx.warned) {
      console.warn('[persist] db module exposes no pool/connect: running WITHOUT a transaction');
      withTx.warned = true;
    }
    return fn({ query: (...a) => db.query(...a) });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function insertRow(q, row) {
  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  const params = cols.map((k) => row[k]);
  const ph = cols.map((k, i) => (JSONB_COLS.has(k) ? `$${i + 1}::jsonb` : `$${i + 1}`));
  const res = await q.query(
    `INSERT INTO normalized_messages (${cols.join(', ')})
     VALUES (${ph.join(', ')})
     ON CONFLICT DO NOTHING
     RETURNING id`,
    params
  );
  return res.rowCount > 0 ? res.rows[0].id : null;
}

/**
 * @param {object} db   repo's ../db module
 * @param {number} messageId
 * @param {object[]} rows output of buildRows()
 * @returns {Promise<{inserted:number, skipped:number}>}
 */
async function saveMessageRows(db, messageId, rows) {
  return withTx(db, async (q) => {
    const old = await q.query(
      `SELECT listing_index, property_status, created_at FROM normalized_messages WHERE whatsapp_message_id = $1`,
      [messageId]
    );
    const statusByIdx = new Map();
    let createdAt = null;
    for (const o of old.rows) {
      if (o.property_status && o.property_status !== 'AVAILABLE') statusByIdx.set(o.listing_index, o.property_status);
      if (o.created_at && (!createdAt || o.created_at < createdAt)) createdAt = o.created_at;
    }

    await q.query(`DELETE FROM normalized_messages WHERE whatsapp_message_id = $1`, [messageId]);

    let inserted = 0;
    let skipped = 0;
    for (const r of rows) {
      const row = { ...r };
      if (createdAt) row.created_at = createdAt;
      if (statusByIdx.has(row.listing_index)) row.property_status = statusByIdx.get(row.listing_index);
      const id = await insertRow(q, row);
      if (id) inserted += 1; else skipped += 1;
    }

    if (inserted === 0 && rows.some((r) => r.is_property)) {
      const first = rows[0];
      await insertRow(q, {
        whatsapp_message_id: messageId, chat_jid: first.chat_jid, sender: first.sender,
        category: 'skipped', intent: 'duplicate', sentiment: 'NEUTRAL', language: first.language,
        summary: '[skipped duplicate listing content]', entities: '{}', is_property: false,
        model_used: 'extract-v2', listing_index: 0, extract_version: first.extract_version,
        created_at: createdAt || undefined
      });
    }
    return { inserted, skipped };
  });
}

module.exports = { saveMessageRows, withTx };
