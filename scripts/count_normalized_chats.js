#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');

(async () => {
  const userId = Number(process.argv[2] || 4);

  const chats = await db.query(
    'SELECT COUNT(*)::int AS n FROM whatsapp_chats WHERE user_id=$1',
    [userId]
  );
  const monitored = await db.query(
    'SELECT COUNT(*)::int AS n FROM whatsapp_chats WHERE user_id=$1 AND is_monitored',
    [userId]
  );
  const withMsgs = await db.query(
    'SELECT COUNT(DISTINCT chat_jid)::int AS n FROM whatsapp_messages WHERE user_id=$1',
    [userId]
  );
  const withNorm = await db.query(
    `SELECT COUNT(DISTINCT n.chat_jid)::int AS n
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE m.user_id = $1`,
    [userId]
  );
  const withProp = await db.query(
    `SELECT COUNT(DISTINCT n.chat_jid)::int AS n
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE m.user_id = $1 AND n.is_property IS TRUE`,
    [userId]
  );
  const overall = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM whatsapp_messages WHERE user_id = $1) AS messages,
       (SELECT COUNT(*)::int
          FROM normalized_messages n
          JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
         WHERE m.user_id = $1) AS normalized_rows,
       (SELECT COUNT(*)::int
          FROM normalized_messages n
          JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
         WHERE m.user_id = $1 AND n.is_property IS TRUE) AS property_rows,
       (SELECT COUNT(DISTINCT m.id)::int
          FROM whatsapp_messages m
         WHERE m.user_id = $1
           AND EXISTS (
             SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id
           )) AS msgs_with_any_normalize`,
    [userId]
  );

  const perMonitored = await db.query(
    `SELECT c.name, c.jid,
            COUNT(DISTINCT m.id)::int AS messages,
            COUNT(DISTINCT n.id)::int AS normalized_rows,
            COUNT(DISTINCT n.id) FILTER (WHERE n.is_property IS TRUE)::int AS property_rows,
            COUNT(DISTINCT m.id) FILTER (
              WHERE EXISTS (
                SELECT 1 FROM normalized_messages nx WHERE nx.whatsapp_message_id = m.id
              )
            )::int AS msgs_normalized
     FROM whatsapp_chats c
     LEFT JOIN whatsapp_messages m ON m.user_id = c.user_id AND m.chat_jid = c.jid
     LEFT JOIN normalized_messages n ON n.whatsapp_message_id = m.id
     WHERE c.user_id = $1 AND c.is_monitored
     GROUP BY c.name, c.jid
     ORDER BY c.name`,
    [userId]
  );

  console.log(
    JSON.stringify(
      {
        userId,
        total_chats: chats.rows[0].n,
        monitored_chats: monitored.rows[0].n,
        chats_with_messages: withMsgs.rows[0].n,
        chats_with_any_normalized: withNorm.rows[0].n,
        chats_with_property_listings: withProp.rows[0].n,
        overall: overall.rows[0],
        monitored_breakdown: perMonitored.rows
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
