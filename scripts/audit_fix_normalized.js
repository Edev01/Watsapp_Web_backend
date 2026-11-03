#!/usr/bin/env node
/**
 * From 20 Oct 2026, compare every stored listing field to the raw WhatsApp
 * message and rewrite invented values. No LLM.
 *
 *   node scripts/audit_fix_normalized.js
 *   node scripts/audit_fix_normalized.js --apply
 */
require('dotenv').config();
const db = require('../db');
const { correctListingFields } = require('../ai/extract/grounding');

const APPLY = process.argv.includes('--apply');
const SINCE = process.env.SINCE || '2026-10-20';

(async () => {
  const { rows } = await db.query(
    `SELECT n.id, n.whatsapp_message_id, n.is_property, n.city, n.area, n.vicinity, n.phase, n.phase_max,
            n.location_text, n.street_text, n.place_tags, n.listing_excerpt, n.summary,
            n.property_type, n.purpose, n.size, n.size_value, n.size_unit, n.price, n.price_value,
            n.listing_kind, n.category, m.message, m.created_at, m.user_id
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
      WHERE n.is_property IS TRUE
        AND m.created_at >= $1::date
      ORDER BY n.id`,
    [SINCE]
  );

  const samples = [];
  const updates = [];
  const changeCount = {};
  for (const row of rows) {
    const { row: next, changes } = correctListingFields(row, row.message);
    if (!changes.length) continue;
    for (const k of changes) changeCount[k] = (changeCount[k] || 0) + 1;
    updates.push({ id: row.id, message_id: row.whatsapp_message_id, changes, next });
    if (samples.length < 25) {
      const before = {};
      const after = {};
      for (const k of changes) {
        before[k] = row[k];
        after[k] = next[k];
      }
      samples.push({
        listing_id: row.id,
        message_id: row.whatsapp_message_id,
        excerpt: String(row.listing_excerpt || '').slice(0, 160),
        before,
        after,
      });
    }
  }

  if (APPLY && updates.length) {
    for (const u of updates) {
      const n = u.next;
      await db.query(
        `UPDATE normalized_messages
            SET city = $2,
                area = $3,
                vicinity = $4,
                phase = $5,
                phase_max = $6,
                location_text = $7,
                street_text = $8,
                place_tags = $9::text[],
                size = $10,
                size_value = $11,
                size_unit = $12,
                price = $13,
                price_value = $14,
                listing_kind = $15,
                category = $16
          WHERE id = $1`,
        [
          u.id, n.city, n.area, n.vicinity, n.phase, n.phase_max,
          n.location_text, n.street_text, n.place_tags || [],
          n.size, n.size_value, n.size_unit, n.price, n.price_value,
          n.listing_kind, n.category,
        ]
      );
    }
  }

  const hit15398 = updates.filter((u) => u.message_id === 15398 || u.id === 15398);
  console.log(JSON.stringify({
    since: SINCE,
    scanned: rows.length,
    would_fix: updates.length,
    apply: APPLY,
    changeCount,
    message_15398_fixes: hit15398.map((u) => ({ listing_id: u.id, changes: u.changes, vicinity: u.next.vicinity, tags: u.next.place_tags })),
    samples,
  }, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
