#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');
const ids = process.argv.slice(2).map(Number).filter(Boolean);
(async () => {
  const { rows } = await db.query(
    `SELECT n.id, n.whatsapp_message_id, n.listing_index, n.city, n.area, n.vicinity, n.phase, n.phase_max,
            n.location_text, n.street_text, n.place_tags, n.listing_excerpt, n.summary, n.property_type,
            n.purpose, n.size, n.size_value, n.price, n.price_value, n.listing_kind, n.model_used,
            m.created_at, m.message
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
      WHERE n.id = ANY($1::int[]) OR n.whatsapp_message_id = ANY($1::int[])
      ORDER BY n.id`,
    [ids]
  );
  for (const r of rows) {
    console.log(JSON.stringify({
      listing_id: r.id,
      message_id: r.whatsapp_message_id,
      created_at: r.created_at,
      city: r.city, area: r.area, vicinity: r.vicinity, phase: r.phase,
      location_text: r.location_text, street_text: r.street_text,
      place_tags: r.place_tags, excerpt: r.listing_excerpt,
      summary: r.summary, type: r.property_type, kind: r.listing_kind,
      model: r.model_used,
      message: r.message,
    }, null, 2));
  }
  if (!rows.length) console.log('NO_ROWS');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
