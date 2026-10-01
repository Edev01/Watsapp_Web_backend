#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');
const { filterAndSortProperties } = require('../propertyHelper');

(async () => {
  const userId = Number(process.argv[2] || 4);
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

  const all = filterAndSortProperties(r.rows, { sortBy: 'Newest First' });
  const signal = all.filter(
    (x) =>
      String(x.propertyType || '').trim() ||
      String(x.size || '').trim() ||
      String(x.price || '').trim() ||
      x.parsedPricePKR != null ||
      x.parsedAreaInTargetUnit != null
  );

  console.log(
    JSON.stringify({
      raw: r.rows.length,
      afterDedupeJunk: all.length,
      withSignal: signal.length
    })
  );
  console.log('DONE_TEST');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
