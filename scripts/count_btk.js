#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');

(async () => {
  const chats = await db.query(
    `SELECT user_id, name, jid,
            (SELECT COUNT(*)::int FROM whatsapp_messages m
              WHERE m.user_id = c.user_id AND m.chat_jid = c.jid) AS msgs
       FROM whatsapp_chats c
      WHERE (c.name ILIKE '%btk%' OR c.name ILIKE '%bahria%')
      ORDER BY user_id, name`
  );
  console.log('CHATS');
  for (const r of chats.rows) {
    console.log(JSON.stringify({ user_id: r.user_id, name: r.name, msgs: r.msgs }));
  }
  const msgs = await db.query(
    `SELECT m.user_id, COUNT(*)::int AS n
       FROM whatsapp_messages m
       LEFT JOIN whatsapp_chats c ON c.user_id = m.user_id AND c.jid = m.chat_jid
      WHERE m.message IS NOT NULL AND length(trim(m.message)) > 0
        AND (
          ((c.name ILIKE '%btk%' OR c.name ILIKE '%bahria town%')
            AND c.name !~* 'rawalpindi|lahore|islamabad|rwp')
          OR (
            m.message ~* '(btk|bahria town karachi|bahria town|precincts?|precints?)'
            AND m.message !~* 'bahria[[:space:]]+(rwp|rawalpindi|lahore|islamabad)'
          )
        )
      GROUP BY m.user_id
      ORDER BY m.user_id`
  );
  console.log('BTK_QUEUE');
  for (const r of msgs.rows) console.log(JSON.stringify(r));
  process.exit(0);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
