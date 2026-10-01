#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');

(async () => {
  const userId = Number(process.argv[2] || 4);

  const msgs = await db.query(
    `SELECT COUNT(*)::int AS total FROM whatsapp_messages WHERE user_id = $1`,
    [userId]
  );

  const coverage = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE n.id IS NULL)::int AS messages_not_normalized_yet,
       COUNT(*) FILTER (WHERE n.id IS NOT NULL)::int AS messages_with_at_least_one_norm_row,
       COUNT(*) FILTER (WHERE n.is_property IS TRUE)::int AS norm_property_rows,
       COUNT(*) FILTER (WHERE n.id IS NOT NULL AND n.is_property IS NOT TRUE)::int AS norm_non_property_rows
     FROM whatsapp_messages m
     LEFT JOIN normalized_messages n ON n.whatsapp_message_id = m.id
     WHERE m.user_id = $1`,
    [userId]
  );

  const msgOutcomes = await db.query(
    `SELECT
       COUNT(*)::int AS messages_total,
       COUNT(*) FILTER (WHERE has_norm AND has_property)::int AS messages_that_became_property,
       COUNT(*) FILTER (WHERE has_norm AND NOT has_property)::int AS messages_normalized_as_non_property,
       COUNT(*) FILTER (WHERE NOT has_norm)::int AS messages_not_normalized,
       COUNT(*) FILTER (WHERE listing_count > 1)::int AS messages_split_into_multi_listings,
       COALESCE(SUM(listing_count) FILTER (WHERE has_property), 0)::int AS property_rows_from_those_messages,
       COALESCE(SUM(listing_count) FILTER (WHERE has_property AND listing_count > 1), 0)::int AS property_rows_from_multi_only
     FROM (
       SELECT m.id,
              COUNT(n.id) > 0 AS has_norm,
              BOOL_OR(n.is_property IS TRUE) AS has_property,
              COUNT(n.id) FILTER (WHERE n.is_property IS TRUE) AS listing_count
       FROM whatsapp_messages m
       LEFT JOIN normalized_messages n ON n.whatsapp_message_id = m.id
       WHERE m.user_id = $1
       GROUP BY m.id
     ) t`,
    [userId]
  );

  console.log(
    JSON.stringify(
      {
        whatsapp_messages: msgs.rows[0].total,
        join_check: coverage.rows[0],
        per_message: msgOutcomes.rows[0]
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
