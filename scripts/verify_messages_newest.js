#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');
const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get(
        { hostname: '127.0.0.1', port: 3000, path, headers: { 'x-user-id': '4' } },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(d));
            } catch (e) {
              reject(new Error(`bad json: ${d.slice(0, 200)}`));
            }
          });
        }
      )
      .on('error', reject);
  });
}

(async () => {
  const chats = await db.query(
    `SELECT jid, name FROM whatsapp_chats WHERE user_id = 4 AND is_monitored ORDER BY name`
  );
  console.log('monitored', chats.rows);

  for (const chat of chats.rows) {
    const body = await get(
      `/api/scraped-chats/messages?chatId=${encodeURIComponent(chat.jid)}&limit=3`
    );
    const rows = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
    const sample = rows.slice(0, 3).map((m) => ({
      id: m.id,
      created_at: m.created_at,
      pkt: m.created_at
        ? new Date(m.created_at).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })
        : null,
      msg: String(m.message || '').slice(0, 50),
    }));
    const dbTop = await db.query(
      `SELECT id, created_at,
              to_char(timezone('Asia/Karachi', created_at), 'YYYY-MM-DD HH24:MI') AS pkt
       FROM whatsapp_messages
       WHERE user_id = 4 AND chat_jid = $1
       ORDER BY id DESC LIMIT 3`,
      [chat.jid]
    );
    console.log(
      JSON.stringify(
        { chat: chat.name, api_first_page: sample, db_newest: dbTop.rows },
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
