#!/usr/bin/env node
/**
 * Purge duplicate property listings per user (keep newest id per content fingerprint).
 * Usage: node scripts/purge_duplicate_listings.js [userId]
 */
require('dotenv').config();
const db = require('../db');
const { userListingFingerprint } = require('../contentFingerprint');

(async () => {
  const userId = process.argv[2] ? Number(process.argv[2]) : null;
  const params = [];
  let filter = '';
  if (userId != null) {
    params.push(userId);
    filter = 'AND m.user_id = $1';
  }

  const { rows } = await db.query(
    `SELECT n.id, m.user_id, n.listing_excerpt, n.summary, n.purpose, n.content_fingerprint
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE n.is_property IS TRUE
       ${filter}
     ORDER BY n.id DESC`,
    params
  );

  const keepByFp = new Map();
  const deleteIds = [];
  const fingerprintUpdates = []; // [id, fp]

  for (const r of rows) {
    const fp =
      r.content_fingerprint ||
      userListingFingerprint(r.user_id, {
        listing_excerpt: r.listing_excerpt,
        summary: r.summary,
        purpose: r.purpose
      });
    if (!fp) continue;

    if (keepByFp.has(fp)) {
      deleteIds.push(r.id);
      continue;
    }
    keepByFp.set(fp, r.id);
    if (!r.content_fingerprint) fingerprintUpdates.push([r.id, fp]);
  }

  console.log(
    JSON.stringify({
      scanned: rows.length,
      uniqueKeep: keepByFp.size,
      toDelete: deleteIds.length,
      toFingerprint: fingerprintUpdates.length
    })
  );

  // Batch fingerprint keepers
  let fingerprinted = 0;
  for (let i = 0; i < fingerprintUpdates.length; i += 200) {
    const slice = fingerprintUpdates.slice(i, i + 200);
    const values = [];
    const p = [];
    let n = 1;
    for (const [id, fp] of slice) {
      values.push(`($${n++}::int, $${n++}::text)`);
      p.push(id, fp);
    }
    await db.query(
      `UPDATE normalized_messages AS n
       SET content_fingerprint = v.fp
       FROM (VALUES ${values.join(',')}) AS v(id, fp)
       WHERE n.id = v.id`,
      p
    );
    fingerprinted += slice.length;
  }

  let deleted = 0;
  for (let i = 0; i < deleteIds.length; i += 500) {
    const slice = deleteIds.slice(i, i + 500);
    const res = await db.query(
      `DELETE FROM normalized_messages WHERE id = ANY($1::int[])`,
      [slice]
    );
    deleted += res.rowCount || 0;
  }

  try {
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_nm_content_fingerprint
        ON normalized_messages (content_fingerprint)
        WHERE content_fingerprint IS NOT NULL AND is_property IS TRUE;
    `);
  } catch (e) {
    console.warn('unique index:', e.message);
  }

  console.log(JSON.stringify({ fingerprinted, deleted, uniqueKeep: keepByFp.size }, null, 2));
  console.log('PURGE_COMPLETE');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
