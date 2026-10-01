#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');

(async () => {
  const userId = Number(process.argv[2] || 4);
  const q = `
    SELECT
      COUNT(*)::int AS total_rows,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(property_status,'AVAILABLE')) = 'AVAILABLE')::int AS available_rows,
      COUNT(DISTINCT n.id) FILTER (
        WHERE UPPER(COALESCE(property_status,'AVAILABLE')) = 'AVAILABLE'
          AND (
            LOWER(CONCAT_WS(' ', COALESCE(n.area,''), COALESCE(n.vicinity,''), COALESCE(n.city,''), COALESCE(n.summary,''), COALESCE(n.listing_excerpt,'')))
              ~* '(^|[^a-z0-9])(dha|defence|defense)([^a-z0-9]|$)'
          )
      )::int AS available_dha_structured
    FROM normalized_messages n
    JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
    WHERE m.user_id = $1 AND n.is_property IS TRUE
  `;
  const { rows } = await db.query(q, [userId]);

  // Broader DHA hit via search-like text (area/vicinity/city/summary/excerpt)
  const dha = await db.query(
    `SELECT COUNT(*)::int AS hits
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE m.user_id = $1
       AND n.is_property IS TRUE
       AND UPPER(COALESCE(n.property_status,'AVAILABLE')) = 'AVAILABLE'
       AND LOWER(CONCAT_WS(' ', COALESCE(n.area,''), COALESCE(n.vicinity,''), COALESCE(n.city,''), COALESCE(n.summary,''), COALESCE(n.listing_excerpt,'')))
           ~* '(^|[^a-z0-9])(dha|defence|defense)([^a-z0-9]|$)'`,
    [userId]
  );

  // Exclude Bahria-only rows from DHA count
  const dhaNoBahria = await db.query(
    `SELECT COUNT(*)::int AS hits
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE m.user_id = $1
       AND n.is_property IS TRUE
       AND UPPER(COALESCE(n.property_status,'AVAILABLE')) = 'AVAILABLE'
       AND LOWER(CONCAT_WS(' ', COALESCE(n.area,''), COALESCE(n.vicinity,''), COALESCE(n.city,''), COALESCE(n.summary,''), COALESCE(n.listing_excerpt,'')))
           ~* '(^|[^a-z0-9])(dha|defence|defense)([^a-z0-9]|$)'
       AND NOT (
         LOWER(CONCAT_WS(' ', COALESCE(n.area,''), COALESCE(n.vicinity,''), COALESCE(n.city,''))) ~* '\\bbahria\\b'
         AND NOT LOWER(CONCAT_WS(' ', COALESCE(n.area,''), COALESCE(n.vicinity,''), COALESCE(n.city,''))) ~* '\\b(dha|defence|defense)\\b'
       )`,
    [userId]
  );

  console.log(
    JSON.stringify(
      {
        userId,
        all_property_rows: rows[0],
        available_dha_mentions: dha.rows[0].hits,
        available_dha_excl_bahria_only: dhaNoBahria.rows[0].hits
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
