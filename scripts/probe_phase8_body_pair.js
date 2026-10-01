#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');

(async () => {
  const r = await db.query(
    `SELECT n.id, n.whatsapp_message_id, n.area, n.vicinity, n.summary,
            LEFT(COALESCE(m.body, ''), 200) AS body_head,
            LENGTH(COALESCE(m.body, '')) AS body_len,
            md5(lower(regexp_replace(COALESCE(m.body, ''), '\\s+', ' ', 'g'))) AS body_md5,
            n.content_fingerprint
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE n.id IN (15906, 15902)
     ORDER BY n.id`
  );
  console.log(JSON.stringify(r.rows, null, 2));
  console.log('ZZ_DONE');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
