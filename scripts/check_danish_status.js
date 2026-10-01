#!/usr/bin/env node
/**
 * Danish (or given user) WhatsApp connection + last scrape activity.
 * Usage: node scripts/check_danish_status.js [email|userId]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const arg = process.argv[2] || 'danish@gmail.com';

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: String(process.env.DATABASE_URL || '').includes('localhost')
      ? false
      : { rejectUnauthorized: false }
  });

  let user;
  if (/^\d+$/.test(arg)) {
    const { rows } = await pool.query(
      `SELECT id, email, name, created_at FROM users WHERE id = $1`,
      [parseInt(arg, 10)]
    );
    user = rows[0];
  } else {
    const { rows } = await pool.query(
      `SELECT id, email, name, created_at FROM users WHERE LOWER(email) = LOWER($1)`,
      [arg]
    );
    user = rows[0];
  }
  if (!user) {
    console.log(JSON.stringify({ error: 'user_not_found', arg }, null, 2));
    await pool.end();
    process.exit(1);
  }

  const uid = user.id;

  // Session / QR / link state if tables exist
  let sessions = [];
  try {
    const s = await pool.query(
      `SELECT * FROM whatsapp_link_sessions WHERE user_id = $1 ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST LIMIT 5`,
      [uid]
    );
    sessions = s.rows;
  } catch (_) {
    try {
      const s = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'whatsapp_link_sessions'`
      );
      sessions = [{ _note: 'query_failed', columns: s.rows.map((r) => r.column_name) }];
    } catch (e2) {
      sessions = [{ _error: e2.message }];
    }
  }

  let qr = [];
  try {
    const q = await pool.query(
      `SELECT id, user_id, status, created_at, updated_at
       FROM qr_codes WHERE user_id = $1
       ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 3`,
      [uid]
    );
    qr = q.rows;
  } catch (e) {
    qr = [{ _error: e.message }];
  }

  const monitored = await pool.query(
    `SELECT jid, name, is_monitored, monitored_at, last_scraped_at, monitor_letter
     FROM whatsapp_chats
     WHERE user_id = $1 AND is_monitored = TRUE
     ORDER BY last_scraped_at DESC NULLS LAST`,
    [uid]
  );

  const lastMsg = await pool.query(
    `SELECT m.id, m.chat_jid, c.name AS chat_name, m.sender, m.timestamp,
            m.created_at, m.seq_in_chat, LEFT(m.message, 80) AS preview
     FROM whatsapp_messages m
     LEFT JOIN whatsapp_chats c ON c.jid = m.chat_jid AND c.user_id = m.user_id
     WHERE m.user_id = $1
     ORDER BY m.id DESC
     LIMIT 8`,
    [uid]
  );

  const lastByChat = await pool.query(
    `SELECT m.chat_jid, c.name AS chat_name,
            MAX(m.id) AS last_msg_id,
            MAX(m.created_at) AS last_created_at,
            COUNT(*)::int AS msg_count
     FROM whatsapp_messages m
     LEFT JOIN whatsapp_chats c ON c.jid = m.chat_jid AND c.user_id = m.user_id
     WHERE m.user_id = $1
       AND m.chat_jid IN (
         SELECT jid FROM whatsapp_chats WHERE user_id = $1 AND is_monitored = TRUE
       )
     GROUP BY m.chat_jid, c.name
     ORDER BY MAX(m.created_at) DESC NULLS LAST`,
    [uid]
  );

  const totals = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM whatsapp_messages WHERE user_id = $1) AS messages,
       (SELECT COUNT(*)::int FROM whatsapp_chats WHERE user_id = $1 AND is_monitored) AS monitored_chats,
       (SELECT MAX(created_at) FROM whatsapp_messages WHERE user_id = $1) AS last_message_created_at,
       (SELECT MAX(last_scraped_at) FROM whatsapp_chats WHERE user_id = $1 AND is_monitored) AS last_chat_scraped_at`,
    [uid]
  );

  // Worker health scrape table if present
  let scrapeHealth = [];
  try {
    const h = await pool.query(
      `SELECT * FROM whatsapp_scrape_health WHERE user_id = $1 ORDER BY updated_at DESC NULLS LAST LIMIT 5`,
      [uid]
    );
    scrapeHealth = h.rows;
  } catch (_) {
    scrapeHealth = [];
  }

  console.log(
    JSON.stringify(
      {
        user,
        totals: totals.rows[0],
        sessions,
        qr,
        scrapeHealth,
        monitored_chats: monitored.rows,
        last_messages_overall: lastMsg.rows,
        last_message_per_monitored_chat: lastByChat.rows
      },
      null,
      2
    )
  );
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
