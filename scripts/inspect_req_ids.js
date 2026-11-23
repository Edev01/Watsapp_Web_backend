#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');
const { looksLikeRequirement, maskNonInventoryRequired, listingExcerptText } = require('../ai/extract/listingKind');

const ids = process.argv.slice(2).map(Number).filter(Boolean);

(async () => {
  const { rows } = await db.query(
    `SELECT n.id, n.whatsapp_message_id, n.listing_kind, n.listing_excerpt, n.summary,
            n.property_type, n.purpose, n.is_property, LEFT(m.message, 2500) AS message
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
      WHERE n.id = ANY($1::int[]) OR n.whatsapp_message_id = ANY($1::int[])
      ORDER BY n.id`,
    [ids]
  );
  for (const r of rows) {
    const excerpt = listingExcerptText(r);
    const masked = maskNonInventoryRequired(excerpt);
    console.log(JSON.stringify({
      listing_id: r.id,
      message_id: r.whatsapp_message_id,
      listing_kind: r.listing_kind,
      property_type: r.property_type,
      looks: looksLikeRequirement(null, excerpt),
      excerpt,
      summary: r.summary,
      masked,
      message: r.message,
    }, null, 2));
  }
  if (!rows.length) console.log('NO_ROWS');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
