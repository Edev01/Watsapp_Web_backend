#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');

(async () => {
  const userId = Number(process.argv[2] || 4);
  const stats = await db.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE contact_number IS NULL OR TRIM(contact_number)='')::int AS empty_contact
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE m.user_id = $1 AND n.is_property IS TRUE`,
    [userId]
  );
  const samples = await db.query(
    `SELECT m.sender, m.chat_jid, m.from_me,
            LEFT(m.message, 90) AS msg,
            n.contact_number
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE m.user_id = $1
       AND n.is_property IS TRUE
       AND (n.contact_number IS NULL OR TRIM(n.contact_number)='')
     ORDER BY n.id DESC
     LIMIT 10`,
    [userId]
  );
  const senders = await db.query(
    `SELECT sender, COUNT(*)::int AS c
     FROM whatsapp_messages
     WHERE user_id = $1
     GROUP BY sender
     ORDER BY c DESC
     LIMIT 12`,
    [userId]
  );
  console.log(JSON.stringify({ stats: stats.rows[0], sender_samples: senders.rows, empty_contact_samples: samples.rows }, null, 2));
  console.log('ZZ_DONE');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
