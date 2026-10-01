#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');
const { filterAndSortProperties } = require('../propertyHelper');

(async () => {
  const userId = Number(process.argv[2] || 4);

  const msgs = await db.query(
    `SELECT COUNT(*)::int AS n FROM whatsapp_messages WHERE user_id = $1`,
    [userId]
  );
  const norm = await db.query(
    `SELECT
       COUNT(*)::int AS all_norm,
       COUNT(*) FILTER (WHERE n.is_property IS TRUE)::int AS is_property,
       COUNT(*) FILTER (WHERE n.is_property IS TRUE AND UPPER(COALESCE(n.property_status,'AVAILABLE'))='AVAILABLE')::int AS available_property,
       COUNT(*) FILTER (WHERE n.is_property IS NOT TRUE)::int AS not_property
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE m.user_id = $1`,
    [userId]
  );
  const multi = await db.query(
    `SELECT COUNT(*)::int AS msgs_with_multi_listings
     FROM (
       SELECT n.whatsapp_message_id
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
       WHERE m.user_id = $1 AND n.is_property IS TRUE
       GROUP BY n.whatsapp_message_id
       HAVING COUNT(*) > 1
     ) t`,
    [userId]
  );

  const r = await db.query(
    `SELECT n.id, n.whatsapp_message_id, n.chat_jid, n.purpose, n.city, n.area, n.vicinity,
            n.property_type, n.property_sub_type, n.size, n.price, n.contact_number,
            n.summary, n.property_status, n.created_at, n.category, n.intent, n.sentiment,
            n.listing_index, n.listing_excerpt,
            LEFT(COALESCE(NULLIF(TRIM(n.listing_excerpt), ''), m.message), 500) AS raw_message,
            m.timestamp AS message_timestamp, m.from_me, m.user_id, m.seq_in_chat
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE m.user_id = $1
       AND n.is_property IS TRUE
       AND UPPER(COALESCE(n.property_status, 'AVAILABLE')) = 'AVAILABLE'
     ORDER BY n.id DESC`,
    [userId]
  );

  // Without junk filter: temporarily map like filter but skip noise — approximate via fingerprint only
  const withJunk = filterAndSortProperties(r.rows, { sortBy: 'Newest First' });

  console.log(
    JSON.stringify(
      {
        userId,
        whatsapp_messages: msgs.rows[0].n,
        normalized_rows: norm.rows[0].all_norm,
        not_property_rows: norm.rows[0].not_property,
        is_property_rows: norm.rows[0].is_property,
        available_property_rows: norm.rows[0].available_property,
        messages_with_multiple_listings: multi.rows[0].msgs_with_multi_listings,
        unique_cards_after_dedupe_junk: withJunk.length,
        dropped_by_dedupe_or_junk:
          norm.rows[0].available_property - withJunk.length
      },
      null,
      2
    )
  );
  console.log('DONE_TEST');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
