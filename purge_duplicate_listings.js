#!/usr/bin/env node
/**
 * Backfill content fingerprints and purge duplicate property listings per user.
 * Keeps the newest row (highest id) for each fingerprint.
 *
 * Usage: node scripts/purge_duplicate_listings.js [userId]
 *        node scripts/purge_duplicate_listings.js           # all users
 */
require('dotenv').config();
const db = require('../db');
const {
  userListingFingerprint,
  userMessageFingerprint
} = require('../contentFingerprint');

async function ensureColumns() {
  await db.query(`
    ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS content_fingerprint TEXT;
    ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS content_fingerprint TEXT;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_nm_content_fingerprint
      ON normalized_messages (content_fingerprint)
      WHERE content_fingerprint IS NOT NULL;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_wm_user_content_fp
      ON whatsapp_messages (user_id, content_fingerprint)
      WHERE content_fingerprint IS NOT NULL;
  `);
}

async function backfillMessageFingerprints(userId) {
  const params = [];
  let filter = '';
  if (userId != null) {
    params.push(Number(userId));
    filter = `AND user_id = $1`;
  }
  const { rows } = await db.query(
    `SELECT id, user_id, message
     FROM whatsapp_messages
     WHERE content_fingerprint IS NULL
       AND message IS NOT NULL
       AND length(trim(message)) >= 40
       ${filter}
     ORDER BY id DESC
     LIMIT 30000`,
    params
  );
  let updated = 0;
  for (const r of rows) {
    const fp = userMessageFingerprint(r.user_id, r.message);
    if (!fp) continue;
    await db.query(`UPDATE whatsapp_messages SET content_fingerprint = $2 WHERE id = $1`, [
      r.id,
      fp
    ]);
    updated += 1;
  }
  return updated;
}

async function backfillListingFingerprints(userId) {
  const params = [];
  let filter = '';
  if (userId != null) {
    params.push(Number(userId));
    filter = `AND m.user_id = $1`;
  }
  const { rows } = await db.query(
    `SELECT n.id, m.user_id, n.listing_excerpt, n.summary, n.purpose,
            n.is_property, n.content_fingerprint
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE n.is_property IS TRUE
       ${filter}
     ORDER BY n.id DESC`,
    params
  );

  const keepByFp = new Map(); // fp -> newest id
  const deleteIds = [];
  let fingerprinted = 0;

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
    if (!r.content_fingerprint) {
      await db.query(
        `UPDATE normalized_messages SET content_fingerprint = $2 WHERE id = $1`,
        [r.id, fp]
      );
      fingerprinted += 1;
    }
  }

  const uniqueDelete = [...new Set(deleteIds)];
  let deleted = 0;
  const chunk = 500;
  for (let i = 0; i < uniqueDelete.length; i += chunk) {
    const slice = uniqueDelete.slice(i, i + chunk);
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
    console.warn('unique index deferred:', e.message);
  }

  return { fingerprinted, deleted, uniqueKeep: keepByFp.size };
}

(async () => {
  const userId = process.argv[2] ? Number(process.argv[2]) : null;
  await ensureColumns();
  console.log('backfill messages…');
  const msgUpdated = await backfillMessageFingerprints(userId);
  console.log('message fingerprints set:', msgUpdated);
  console.log('backfill + purge listings…');
  const listing = await backfillListingFingerprints(userId);
  console.log(JSON.stringify({ userId: userId || 'all', messages_fp: msgUpdated, ...listing }, null, 2));
  console.log('DONE_TEST');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
