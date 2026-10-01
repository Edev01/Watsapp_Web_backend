#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');

(async () => {
  const hours = await db.query(
    `SELECT to_char(timezone('Asia/Karachi', created_at), 'YYYY-MM-DD HH24:00') AS hour_pkt,
            COUNT(*)::int AS n
     FROM whatsapp_messages
     WHERE user_id = 4
       AND created_at >= NOW() - INTERVAL '36 hours'
     GROUP BY 1
     ORDER BY 1 DESC`
  );

  const monitored = await db.query(
    `SELECT c.name,
            to_char(timezone('Asia/Karachi', c.last_scraped_at), 'YYYY-MM-DD HH24:MI') AS last_scraped_pkt,
            to_char(timezone('Asia/Karachi', (
              SELECT MAX(m.created_at) FROM whatsapp_messages m
              WHERE m.user_id = c.user_id AND m.chat_jid = c.jid
            )), 'YYYY-MM-DD HH24:MI') AS last_msg_pkt,
            to_char(timezone('Asia/Karachi', c.monitored_at), 'YYYY-MM-DD HH24:MI') AS monitored_at_pkt
     FROM whatsapp_chats c
     WHERE c.user_id = 4 AND c.is_monitored IS TRUE`
  );

  const latest = await db.query(
    `SELECT to_char(timezone('Asia/Karachi', created_at), 'YYYY-MM-DD HH24:MI:SS') AS saved_pkt,
            sender, LEFT(message, 70) AS msg
     FROM whatsapp_messages
     WHERE user_id = 4
     ORDER BY created_at DESC
     LIMIT 5`
  );

  console.log(JSON.stringify({ hours: hours.rows, monitored: monitored.rows, latest: latest.rows }, null, 2));
  console.log('ZZ_DONE');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
