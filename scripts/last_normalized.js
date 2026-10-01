#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');

(async () => {
  const userId = Number(process.argv[2] || 4);
  const { rows } = await db.query(
    `SELECT
       n.id AS listing_id,
       n.whatsapp_message_id AS message_id,
       n.created_at AS normalized_at,
       n.model_used,
       n.is_property,
       n.purpose,
       n.property_type,
       n.city,
       n.area,
       n.vicinity,
       n.size,
       n.price,
       n.contact_number,
       n.listing_index,
       LEFT(COALESCE(n.listing_excerpt, n.summary, ''), 180) AS excerpt,
       m.sender,
       m.sender_phone,
       m.chat_jid,
       m.timestamp AS message_timestamp,
       m.seq_in_chat,
       m.created_at AS message_saved_at,
       c.name AS chat_name
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     LEFT JOIN whatsapp_chats c ON c.user_id = m.user_id AND c.jid = m.chat_jid
     WHERE m.user_id = $1
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT 5`,
    [userId]
  );

  const pending = await db.query(
    `SELECT COUNT(*)::int AS pending
     FROM whatsapp_messages m
     WHERE m.user_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id
       )`,
    [userId]
  );

  console.log(
    JSON.stringify(
      {
        userId,
        pending_messages_without_norm_row: pending.rows[0].pending,
        latest_normalized: rows
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
