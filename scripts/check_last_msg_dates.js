#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');

(async () => {
  const userId = Number(process.argv[2] || 4);

  const global = await db.query(
    `SELECT COUNT(*)::int AS messages,
            MAX(created_at) AS last_saved,
            MAX(timestamp) AS last_msg_timestamp
     FROM whatsapp_messages WHERE user_id = $1`,
    [userId]
  );

  const byDay = await db.query(
    `SELECT DATE(created_at AT TIME ZONE 'Asia/Karachi') AS day_pkt, COUNT(*)::int AS n
     FROM whatsapp_messages
     WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '20 days'
     GROUP BY 1 ORDER BY 1 DESC`,
    [userId]
  );

  const monitored = await db.query(
    `SELECT c.jid, c.name, c.is_monitored, c.monitored_at, c.last_scraped_at,
            (SELECT COUNT(*)::int FROM whatsapp_messages m WHERE m.user_id=c.user_id AND m.chat_jid=c.jid) AS msgs,
            (SELECT MAX(m.created_at) FROM whatsapp_messages m WHERE m.user_id=c.user_id AND m.chat_jid=c.jid) AS last_saved,
            (SELECT MAX(m.timestamp) FROM whatsapp_messages m WHERE m.user_id=c.user_id AND m.chat_jid=c.jid) AS last_ts
     FROM whatsapp_chats c
     WHERE c.user_id = $1 AND c.is_monitored IS TRUE
     ORDER BY c.last_scraped_at DESC NULLS LAST`,
    [userId]
  );

  const recentSaved = await db.query(
    `SELECT id, chat_jid, sender, timestamp, created_at, LEFT(message,70) AS msg
     FROM whatsapp_messages WHERE user_id=$1
     ORDER BY created_at DESC LIMIT 6`,
    [userId]
  );

  const health = await db.query(
    `SELECT * FROM whatsapp_scrape_health WHERE user_id=$1`,
    [userId]
  ).catch(() => ({ rows: [] }));

  // Chats whose UI-ish last activity looks stuck around mid-September
  const stuck = await db.query(
    `SELECT c.jid, c.name, c.is_monitored, c.last_scraped_at,
            (SELECT MAX(m.created_at) FROM whatsapp_messages m WHERE m.user_id=c.user_id AND m.chat_jid=c.jid) AS last_saved
     FROM whatsapp_chats c
     WHERE c.user_id=$1
       AND (
         c.last_scraped_at::date = DATE '2026-09-15'
         OR (SELECT MAX(m.created_at)::date FROM whatsapp_messages m WHERE m.user_id=c.user_id AND m.chat_jid=c.jid) = DATE '2026-09-15'
       )
     ORDER BY c.is_monitored DESC, c.last_scraped_at DESC NULLS LAST
     LIMIT 20`,
    [userId]
  );

  console.log(JSON.stringify({
    global: global.rows[0],
    messages_per_day_pkt: byDay.rows,
    monitored_chats: monitored.rows,
    health: health.rows[0] || null,
    newest_saved_messages: recentSaved.rows,
    sample_chats_showing_sep15: stuck.rows
  }, null, 2));
  console.log('ZZ_DONE');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
