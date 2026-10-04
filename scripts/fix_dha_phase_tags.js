#!/usr/bin/env node
/**
 * Re-tag + correct area/vicinity for DHA commercials (e.g. Rahat → Phase 6).
 * Usage: node scripts/fix_dha_phase_tags.js [limit]
 */
require('dotenv').config();
const db = require('../db');
const { resolveAndSavePlaceTags, ensurePlaceRegionsSeeded } = require('../ai/placeResolver');

const limit = Math.min(Math.max(parseInt(process.argv[2] || '2000', 10) || 2000, 1), 20000);

async function main() {
  await ensurePlaceRegionsSeeded();
  const { rows } = await db.query(
    `SELECT id, is_property, area, vicinity, city, summary, listing_excerpt,
            (SELECT m.message FROM whatsapp_messages m
             WHERE m.id = n.whatsapp_message_id LIMIT 1) AS raw_message
     FROM normalized_messages n
     WHERE n.is_property = true
       AND (
         LOWER(COALESCE(n.area,'') || ' ' || COALESCE(n.vicinity,'')) ~ 'rahat|bukhari|ittehad|nishat|sehar|badar|tauheed|zamzama|khadda'
         OR EXISTS (
           SELECT 1 FROM unnest(COALESCE(n.place_tags, ARRAY[]::text[])) t
           WHERE LOWER(t) ~ 'rahat|bukhari|phase-5|phase 5|phase-6'
         )
       )
     ORDER BY n.id DESC
     LIMIT $1`,
    [limit]
  );
  console.log(`candidates=${rows.length}`);
  let ok = 0;
  for (const row of rows) {
    try {
      const r = await resolveAndSavePlaceTags(row);
      if (r) {
        ok += 1;
        if (ok <= 15) {
          console.log(`#${row.id}`, { area: r.area, vicinity: r.vicinity, tags: (r.tags || []).slice(0, 8) });
        }
      }
    } catch (err) {
      console.warn(`fail #${row.id}:`, err.message);
    }
  }
  console.log(`updated=${ok}`);
  await db.pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
