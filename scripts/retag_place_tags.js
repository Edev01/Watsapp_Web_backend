#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');
const { resolveAndSavePlaceTags } = require('../ai/placeResolver');

(async () => {
  await db.query(
    `UPDATE normalized_messages
     SET place_tags = NULL, place_resolved_at = NULL
     WHERE is_property IS TRUE
       AND (
         LOWER(TRIM(COALESCE(area,''))) IN ('tariq', 'dubai', 'askari')
         OR id = ANY($1::int[])
       )`,
    [[28712, 27809, 21997, 28995]]
  );

  const { rows } = await db.query(
    `SELECT n.id, n.is_property, n.area, n.vicinity, n.city
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE m.user_id = 4
       AND n.is_property IS TRUE
       AND n.place_resolved_at IS NULL
     ORDER BY n.id DESC
     LIMIT 600`
  );

  let ok = 0;
  for (const row of rows) {
    try {
      await resolveAndSavePlaceTags(row);
      ok += 1;
    } catch (_) {}
  }
  console.log(JSON.stringify({ retagged: ok, scanned: rows.length }));
  console.log('ZZ_DONE');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
