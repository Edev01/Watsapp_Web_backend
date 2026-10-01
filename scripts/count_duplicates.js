#!/usr/bin/env node
/**
 * Count duplicate rows in whatsapp_messages and normalized_messages.
 * Usage: node scripts/count_duplicates.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: String(process.env.DATABASE_URL || '').includes('localhost')
      ? false
      : { rejectUnauthorized: false }
  });

  const msgCols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_messages'
    ORDER BY ordinal_position
  `);
  const normCols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'normalized_messages'
    ORDER BY ordinal_position
  `);

  // Exact duplicate key used by unique_user_message constraint
  const messages = await pool.query(`
    WITH totals AS (
      SELECT COUNT(*)::bigint AS total FROM whatsapp_messages
    ),
    by_unique_key AS (
      SELECT user_id, chat_jid, sender, timestamp, message, COUNT(*)::bigint AS c
      FROM whatsapp_messages
      GROUP BY user_id, chat_jid, sender, timestamp, message
      HAVING COUNT(*) > 1
    ),
    by_seq AS (
      SELECT user_id, chat_jid, seq_in_chat, COUNT(*)::bigint AS c
      FROM whatsapp_messages
      WHERE seq_in_chat IS NOT NULL AND TRIM(seq_in_chat) <> ''
      GROUP BY user_id, chat_jid, seq_in_chat
      HAVING COUNT(*) > 1
    ),
    by_body AS (
      SELECT user_id, chat_jid, LEFT(COALESCE(message,''), 800) AS body, COUNT(*)::bigint AS c
      FROM whatsapp_messages
      WHERE COALESCE(TRIM(message), '') <> ''
      GROUP BY user_id, chat_jid, LEFT(COALESCE(message,''), 800)
      HAVING COUNT(*) > 1
    ),
    by_body_global AS (
      SELECT LEFT(COALESCE(message,''), 800) AS body, COUNT(*)::bigint AS c
      FROM whatsapp_messages
      WHERE COALESCE(TRIM(message), '') <> ''
      GROUP BY LEFT(COALESCE(message,''), 800)
      HAVING COUNT(*) > 1
    )
    SELECT
      (SELECT total FROM totals) AS total_rows,
      (SELECT COUNT(*) FROM by_unique_key) AS exact_key_dup_groups,
      (SELECT COALESCE(SUM(c),0) FROM by_unique_key) AS rows_in_exact_key_dup_groups,
      (SELECT COALESCE(SUM(c - 1),0) FROM by_unique_key) AS extra_exact_key_duplicates,
      (SELECT COUNT(*) FROM by_seq) AS seq_dup_groups,
      (SELECT COALESCE(SUM(c - 1),0) FROM by_seq) AS extra_seq_duplicates,
      (SELECT COUNT(*) FROM by_body) AS same_chat_same_body_groups,
      (SELECT COALESCE(SUM(c),0) FROM by_body) AS rows_in_same_chat_same_body_groups,
      (SELECT COALESCE(SUM(c - 1),0) FROM by_body) AS extra_same_chat_same_body_duplicates,
      (SELECT COUNT(*) FROM by_body_global) AS global_same_body_groups,
      (SELECT COALESCE(SUM(c - 1),0) FROM by_body_global) AS extra_global_same_body_duplicates
  `);

  const normalized = await pool.query(`
    WITH totals AS (
      SELECT COUNT(*)::bigint AS total FROM normalized_messages
    ),
    by_msg AS (
      SELECT whatsapp_message_id, COUNT(*)::bigint AS c
      FROM normalized_messages
      GROUP BY whatsapp_message_id
      HAVING COUNT(*) > 1
    ),
    by_msg_listing AS (
      SELECT whatsapp_message_id, COALESCE(listing_index, 0) AS li, COUNT(*)::bigint AS c
      FROM normalized_messages
      GROUP BY whatsapp_message_id, COALESCE(listing_index, 0)
      HAVING COUNT(*) > 1
    ),
    by_same_content AS (
      SELECT
        LEFT(COALESCE(NULLIF(TRIM(listing_excerpt), ''), summary, ''), 400) AS body,
        COUNT(*)::bigint AS c
      FROM normalized_messages
      WHERE COALESCE(NULLIF(TRIM(listing_excerpt), ''), summary, '') <> ''
      GROUP BY LEFT(COALESCE(NULLIF(TRIM(listing_excerpt), ''), summary, ''), 400)
      HAVING COUNT(*) > 1
    )
    SELECT
      (SELECT total FROM totals) AS total_rows,
      (SELECT COUNT(*) FROM by_msg) AS whatsapp_msgs_with_multiple_normalized_rows,
      (SELECT COALESCE(SUM(c),0) FROM by_msg) AS normalized_rows_sharing_a_whatsapp_message,
      (SELECT COALESCE(SUM(c - 1),0) FROM by_msg) AS extra_rows_same_whatsapp_message_id,
      (SELECT COUNT(*) FROM by_msg_listing) AS exact_listing_dup_groups,
      (SELECT COALESCE(SUM(c),0) FROM by_msg_listing) AS rows_in_exact_listing_dup_groups,
      (SELECT COALESCE(SUM(c - 1),0) FROM by_msg_listing) AS extra_exact_listing_duplicates,
      (SELECT COUNT(*) FROM by_same_content) AS same_excerpt_or_summary_groups,
      (SELECT COALESCE(SUM(c),0) FROM by_same_content) AS rows_in_same_excerpt_or_summary_groups,
      (SELECT COALESCE(SUM(c - 1),0) FROM by_same_content) AS extra_same_excerpt_or_summary_duplicates
  `);

  const msgSamples = await pool.query(`
    SELECT user_id, chat_jid, COUNT(*)::int AS c,
           LEFT(MAX(COALESCE(message,'')), 80) AS body_preview
    FROM whatsapp_messages
    WHERE COALESCE(TRIM(message), '') <> ''
    GROUP BY user_id, chat_jid, LEFT(COALESCE(message,''), 800)
    HAVING COUNT(*) > 1
    ORDER BY c DESC
    LIMIT 5
  `);

  const normSamples = await pool.query(`
    SELECT whatsapp_message_id, COALESCE(listing_index, 0) AS listing_index, COUNT(*)::int AS c
    FROM normalized_messages
    GROUP BY whatsapp_message_id, COALESCE(listing_index, 0)
    HAVING COUNT(*) > 1
    ORDER BY c DESC
    LIMIT 5
  `);

  const normContentSamples = await pool.query(`
    SELECT COUNT(*)::int AS c,
           LEFT(MAX(COALESCE(NULLIF(TRIM(listing_excerpt), ''), summary, '')), 100) AS preview
    FROM normalized_messages
    WHERE COALESCE(NULLIF(TRIM(listing_excerpt), ''), summary, '') <> ''
    GROUP BY LEFT(COALESCE(NULLIF(TRIM(listing_excerpt), ''), summary, ''), 400)
    HAVING COUNT(*) > 1
    ORDER BY c DESC
    LIMIT 5
  `);

  console.log(JSON.stringify({
    whatsapp_messages_columns: msgCols.rows.map((r) => r.column_name),
    normalized_messages_columns: normCols.rows.map((r) => r.column_name),
    whatsapp_messages: messages.rows[0],
    normalized_messages: normalized.rows[0],
    sample_whatsapp_same_chat_same_body: msgSamples.rows,
    sample_normalized_exact_listing_dups: normSamples.rows,
    sample_normalized_same_content: normContentSamples.rows
  }, null, 2));

  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
