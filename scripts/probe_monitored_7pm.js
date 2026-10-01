#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');
const http = require('http');

(async () => {
  const userId = 4;

  const monitored = await db.query(
    `SELECT jid, name FROM whatsapp_chats WHERE user_id=$1 AND is_monitored IS TRUE`,
    [userId]
  );

  for (const chat of monitored.rows) {
    const around7 = await db.query(
      `SELECT id, sender, timestamp, created_at, seq_in_chat, LEFT(message, 90) AS msg
       FROM whatsapp_messages
       WHERE user_id=$1 AND chat_jid=$2
         AND created_at >= TIMESTAMPTZ '2026-09-30 13:00:00+00'
         AND created_at <  TIMESTAMPTZ '2026-09-30 16:00:00+00'
       ORDER BY created_at DESC
       LIMIT 15`,
      [userId, chat.jid]
    );
    const latest = await db.query(
      `SELECT id, sender, timestamp, created_at, seq_in_chat, LEFT(message, 80) AS msg
       FROM whatsapp_messages
       WHERE user_id=$1 AND chat_jid=$2
       ORDER BY created_at DESC
       LIMIT 5`,
      [userId, chat.jid]
    );
    const counts = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (
                WHERE created_at::date = DATE '2026-09-30'
                   OR timestamp::date = DATE '2026-09-30'
              )::int AS on_sep30
       FROM whatsapp_messages WHERE user_id=$1 AND chat_jid=$2`,
      [userId, chat.jid]
    );
    console.log(
      JSON.stringify(
        {
          chat: chat.name,
          jid: chat.jid,
          counts: counts.rows[0],
          around_13_to_16_utc_possible_7pm_pkt: around7.rows,
          latest5: latest.rows
        },
        null,
        2
      )
    );
  }

  // What monitored API returns
  const monApi = await db.query(
    `SELECT c.jid, c.name, c.monitored_at, c.last_scraped_at, c.created_at
     FROM whatsapp_chats c
     WHERE c.user_id=$1 AND c.is_monitored IS TRUE`,
    [userId]
  );
  console.log('monitored_api_fields', JSON.stringify(monApi.rows, null, 2));

  // Sample messages endpoint shape for first monitored chat
  const jid = monitored.rows[0]?.jid;
  if (jid) {
    const msgs = await new Promise((resolve, reject) => {
      const url = `http://127.0.0.1:3000/api/scraped-chats/messages?userId=4&chatId=${encodeURIComponent(jid)}&limit=10`;
      http
        .get(url, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(d));
            } catch (e) {
              reject(e);
            }
          });
        })
        .on('error', reject);
    }).catch((e) => ({ error: e.message }));
    const data = msgs?.data || msgs;
    const list = Array.isArray(data) ? data : data?.messages || data?.chats || [];
    console.log(
      'messages_api_sample',
      JSON.stringify(
        {
          topKeys: msgs && typeof msgs === 'object' ? Object.keys(msgs) : null,
          dataKeys: data && !Array.isArray(data) ? Object.keys(data) : null,
          first3: (Array.isArray(list) ? list : []).slice(0, 3)
        },
        null,
        2
      )
    );
  }

  console.log('ZZ_DONE');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
