'use strict';

const { normalizeFingerprintText } = require('../contentFingerprint');

const PROTECTED_COLUMNS = new Set(['id', 'whatsapp_message_id', 'listing_index', 'property_status', 'created_at']);
const JSONB_COLUMNS = new Set(['entities', 'extract_trace']);

function excerptKey(row) {
  return normalizeFingerprintText(row.listing_excerpt || '');
}

/** Match identity independently of the model's listing order. */
function matchRows(oldRows, newRows, options = {}) {
  if (!Array.isArray(oldRows) || !oldRows.length || !Array.isArray(newRows) || !newRows.length) {
    throw new Error('Cannot replace existing cards with an empty extraction');
  }
  if (newRows.some((row) => !row || row.is_property !== true)) {
    throw new Error('Extraction did not return usable property cards; keeping existing rows');
  }
  if (oldRows.length === 1 && newRows.length === 1) {
    return { matches: [{ oldRow: oldRows[0], newRow: newRows[0] }], additions: [] };
  }
  // Explicitly reviewed legacy cards represented an entire message, with no
  // offer excerpt or only a shared header. Only unannotated aggregates may reuse
  // their ID for offer 1, or for the unique offer beginning with that header.
  // saveRows additionally checks live favourites/comments before any writes.
  if (options.allowLegacyAggregateSplit === true && oldRows.length === 1 && newRows.length > 1) {
    const oldRow = oldRows[0];
    if (oldRow.is_property !== true) {
      throw new Error('Legacy aggregate splitting requires an existing property card');
    }
    if (oldRow.property_status != null && oldRow.property_status !== 'AVAILABLE') {
      throw new Error('Legacy aggregate splitting cannot assign a non-default property status to one offer');
    }
    let matchedIndex = 0;
    if (String(oldRow.listing_excerpt || '').trim()) {
      const header = excerptKey(oldRow);
      const prefixMatches = header.length >= 40
        ? newRows.map((row, index) => excerptKey(row).startsWith(header) ? index : -1).filter(index => index >= 0)
        : [];
      if (prefixMatches.length !== 1) {
        throw new Error('Legacy aggregate splitting requires no listing excerpt or a unique matching header of at least 40 characters');
      }
      [matchedIndex] = prefixMatches;
    }
    return {
      matches: [{ oldRow, newRow: newRows[matchedIndex] }],
      additions: newRows.filter((_row, index) => index !== matchedIndex),
      legacyAggregateSplit: true
    };
  }

  const candidates = oldRows.map((oldRow) => {
    const excerpt = excerptKey(oldRow);
    return newRows.filter((newRow) => {
      const sameExcerpt = excerpt && excerpt === excerptKey(newRow);
      // A single old card split into several needs an exact excerpt match.
      const sameFingerprint = oldRows.length > 1 && oldRow.content_fingerprint
        && oldRow.content_fingerprint === newRow.content_fingerprint;
      return sameExcerpt || sameFingerprint;
    });
  });
  const used = new Set();
  const matches = oldRows.map((oldRow, index) => {
    const possible = candidates[index];
    if (possible.length !== 1 || used.has(possible[0])) {
      throw new Error(`Ambiguous or missing extraction match for existing card ${oldRow.id}`);
    }
    used.add(possible[0]);
    return { oldRow, newRow: possible[0] };
  });
  return { matches, additions: newRows.filter((row) => !used.has(row)) };
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function verifySnapshot(snapshot, current) {
  const byId = new Map(current.map((row) => [String(row.id), row]));
  if (current.length !== snapshot.length || byId.size !== snapshot.length
      || new Set(snapshot.map((row) => String(row.id))).size !== snapshot.length) {
    throw new Error('Message cards changed since extraction; refusing stale update');
  }
  for (const row of snapshot) {
    if (JSON.stringify(canonical(row)) !== JSON.stringify(canonical(byId.get(String(row.id))))) {
      throw new Error(`Card ${row.id} changed since extraction; refusing stale update`);
    }
  }
}

function columnName(column) {
  if (!/^[a-z][a-z0-9_]*$/.test(column)) throw new Error(`Invalid column name: ${column}`);
  return `"${column}"`;
}

function placeholder(column, index) {
  return `$${index}${JSONB_COLUMNS.has(column) ? '::jsonb' : ''}`;
}

/**
 * Update a complete message snapshot atomically while retaining existing card IDs.
 * Extraction happens before this function. Any stale snapshot, match ambiguity or
 * constraint failure leaves all cards and their favourites/comments untouched.
 */
async function saveRows(db, job, oldRows, newRows, options = {}) {
  const messageId = Number(job.id);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error('Invalid message ID');
  for (const row of [...oldRows, ...newRows]) {
    if (Number(row.whatsapp_message_id) !== messageId) {
      throw new Error('Card belongs to a different WhatsApp message');
    }
  }
  const { matches, additions, legacyAggregateSplit } = matchRows(oldRows, newRows, options);
  const pool = db.pool && typeof db.pool.connect === 'function' ? db.pool : db;
  if (typeof pool.connect !== 'function') throw new Error('A transactional database connection is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT * FROM normalized_messages WHERE whatsapp_message_id = $1 ORDER BY id FOR UPDATE',
      [messageId]
    );
    verifySnapshot(oldRows, locked.rows);
    if (legacyAggregateSplit) {
      const references = await client.query(
        `SELECT (SELECT COUNT(*) FROM property_favourites WHERE property_id = $1)::int AS favourites,
                (SELECT COUNT(*) FROM property_comments WHERE property_id = $1)::int AS comments`,
        [oldRows[0].id]
      );
      const counts = references.rows[0];
      if (!counts || Number(counts.favourites) !== 0 || Number(counts.comments) !== 0) {
        throw new Error('Legacy aggregate card has favourites or comments; refusing to attach them to one offer');
      }
    }
    const ids = [];
    for (const { oldRow, newRow } of matches) {
      const columns = Object.keys(newRow).filter((column) => !PROTECTED_COLUMNS.has(column) && newRow[column] !== undefined);
      if (!columns.length) throw new Error('No extracted fields to update');
      const assignments = columns.map((column, index) => `${columnName(column)} = ${placeholder(column, index + 1)}`);
      const parameters = columns.map((column) => newRow[column]);
      parameters.push(oldRow.id, messageId);
      const saved = await client.query(
        `UPDATE normalized_messages SET ${assignments.join(', ')} WHERE id = $${columns.length + 1} AND whatsapp_message_id = $${columns.length + 2} RETURNING id`,
        parameters
      );
      if (saved.rowCount !== 1) throw new Error(`Card ${oldRow.id} disappeared during update`);
      ids.push(saved.rows[0].id);
    }

    const usedIndexes = new Set(oldRows.map((row) => row.listing_index).filter(Number.isInteger));
    let nextIndex = 0;
    for (const fresh of additions) {
      while (usedIndexes.has(nextIndex)) nextIndex += 1;
      const row = Object.fromEntries(Object.entries(fresh)
        .filter(([column, value]) => !PROTECTED_COLUMNS.has(column) && value !== undefined));
      row.whatsapp_message_id = messageId;
      row.listing_index = nextIndex;
      usedIndexes.add(nextIndex);
      const columns = Object.keys(row);
      const saved = await client.query(
        `INSERT INTO normalized_messages (${columns.map(columnName).join(', ')}) VALUES (${columns.map((column, index) => placeholder(column, index + 1)).join(', ')}) RETURNING id`,
        columns.map((column) => row[column])
      );
      if (saved.rowCount !== 1) throw new Error('New extracted card was not inserted');
      ids.push(saved.rows[0].id);
    }
    await client.query('COMMIT');
    return { updated: matches.length, inserted: additions.length, ids };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* preserve the original failure */ }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { matchRows, saveRows };
