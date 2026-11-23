#!/usr/bin/env node
/**
 * Backfill place_tags for existing property listings (gazetteer; Google if keyed).
 * Usage: node scripts/backfill_place_tags.js [userId] [limit]
 */
require('dotenv').config();
const db = require('../db');
const {
  ensurePlaceRegionsSeeded,
  resolveAndSavePlaceTags
} = require('../ai/placeResolver');

(async () => {
  const userId = process.argv[2] ? Number(process.argv[2]) : null;
  const limit = Math.min(Number(process.argv[3] || 500), 5000);

  await ensurePlaceRegionsSeeded();

  const params = [];
  let sql = `
    SELECT n.id, n.is_property, n.area, n.vicinity, n.city
    FROM normalized_messages n
    JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
    WHERE n.is_property IS TRUE
      AND (n.place_resolved_at IS NULL OR n.place_tags IS NULL)
  `;
  if (userId) {
    params.push(userId);
    sql += ` AND m.user_id = $${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY n.id DESC LIMIT $${params.length}`;

  const { rows } = await db.query(sql, params);
  console.log(`backfill candidates=${rows.length}`);

  let ok = 0;
  let fail = 0;
  for (const row of rows) {
    try {
      const r = await resolveAndSavePlaceTags(row);
      if (r) ok += 1;
    } catch (e) {
      fail += 1;
      console.warn('fail', row.id, e.message);
    }
  }

  console.log(JSON.stringify({ ok, fail, scanned: rows.length }));
  console.log('ZZ_DONE');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
