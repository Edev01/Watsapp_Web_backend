#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');

(async () => {
  const userId = Number(process.argv[2] || 4);

  const today = await db.query(
    `SELECT COUNT(*)::int AS n
     FROM whatsapp_messages
     WHERE user_id = $1
       AND timezone('Asia/Karachi', created_at)::date = timezone('Asia/Karachi', NOW())::date`,
    [userId]
  );

  const byHour = await db.query(
    `SELECT to_char(date_trunc('hour', timezone('Asia/Karachi', created_at)), 'HH24:00') AS hour_pkt,
            COUNT(*)::int AS n
     FROM whatsapp_messages
     WHERE user_id = $1
       AND timezone('Asia/Karachi', created_at)::date = timezone('Asia/Karachi', NOW())::date
     GROUP BY 1
     ORDER BY 1`,
    [userId]
  );

  const byChat = await db.query(
    `SELECT COALESCE(c.name, m.chat_jid) AS chat,
            COUNT(*)::int AS n
     FROM whatsapp_messages m
     LEFT JOIN whatsapp_chats c
       ON c.user_id = m.user_id AND c.jid = m.chat_jid
     WHERE m.user_id = $1
       AND timezone('Asia/Karachi', m.created_at)::date = timezone('Asia/Karachi', NOW())::date
     GROUP BY 1
     ORDER BY n DESC`,
    [userId]
  );

  const range = await db.query(
    `SELECT
       to_char(MIN(timezone('Asia/Karachi', created_at)), 'YYYY-MM-DD HH24:MI') AS first_pkt,
       to_char(MAX(timezone('Asia/Karachi', created_at)), 'YYYY-MM-DD HH24:MI') AS last_pkt,
       to_char(timezone('Asia/Karachi', NOW()), 'YYYY-MM-DD HH24:MI') AS now_pkt
     FROM whatsapp_messages
     WHERE user_id = $1
       AND timezone('Asia/Karachi', created_at)::date = timezone('Asia/Karachi', NOW())::date`,
    [userId]
  );

  console.log(
    JSON.stringify(
      {
        userId,
        today_total: today.rows[0].n,
        range: range.rows[0],
        by_chat: byChat.rows,
        by_hour_pkt: byHour.rows
      },
      null,
      2
    )
  );
  console.log('ZZ_DONE');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
