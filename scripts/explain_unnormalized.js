#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');

(async () => {
  const userId = Number(process.argv[2] || 4);
  const r = await db.query(
    `SELECT
       COUNT(*)::int AS not_normalized,
       COUNT(*) FILTER (
         WHERE EXISTS (
           SELECT 1
           FROM whatsapp_messages m2
           INNER JOIN normalized_messages n2 ON n2.whatsapp_message_id = m2.id
           WHERE m2.user_id IS NOT DISTINCT FROM m.user_id
             AND m2.id <> m.id
             AND length(COALESCE(m.message, '')) >= 40
             AND md5(regexp_replace(lower(left(m2.message, 800)), E'\\s+', ' ', 'g'))
               = md5(regexp_replace(lower(left(m.message, 800)), E'\\s+', ' ', 'g'))
         )
       )::int AS skipped_because_same_body_already_normalized,
       COUNT(*) FILTER (
         WHERE length(COALESCE(m.message, '')) < 40
       )::int AS short_messages
     FROM whatsapp_messages m
     WHERE m.user_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id
       )`,
    [userId]
  );
  console.log(JSON.stringify(r.rows[0], null, 2));
  console.log('ZZ_DONE');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
