#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: String(process.env.DATABASE_URL || '').includes('localhost')
      ? false
      : { rejectUnauthorized: false }
  });

  // Same excerpt across different whatsapp_message_ids (repost duplicates)
  const r1 = await pool.query(`
    SELECT LEFT(COALESCE(NULLIF(TRIM(listing_excerpt), ''), summary, ''), 100) AS preview,
           COUNT(*)::int AS rows,
           COUNT(DISTINCT whatsapp_message_id)::int AS distinct_msgs,
           COUNT(DISTINCT COALESCE(listing_index,0))::int AS distinct_listing_idx
    FROM normalized_messages
    WHERE COALESCE(NULLIF(TRIM(listing_excerpt), ''), summary, '') <> ''
    GROUP BY 1
    HAVING COUNT(*) BETWEEN 2 AND 8
       AND COUNT(DISTINCT whatsapp_message_id) > 1
    ORDER BY rows DESC
    LIMIT 10
  `);

  // Same message + same excerpt (true multi-normalize dup)
  const r2 = await pool.query(`
    SELECT whatsapp_message_id,
           LEFT(COALESCE(NULLIF(TRIM(listing_excerpt), ''), summary, ''), 80) AS preview,
           COUNT(*)::int AS c,
           ARRAY_AGG(id ORDER BY id) AS ids,
           ARRAY_AGG(COALESCE(listing_index,0) ORDER BY id) AS idxs
    FROM normalized_messages
    WHERE COALESCE(NULLIF(TRIM(listing_excerpt), ''), summary, '') <> ''
    GROUP BY whatsapp_message_id, LEFT(COALESCE(NULLIF(TRIM(listing_excerpt), ''), summary, ''), 80)
    HAVING COUNT(*) > 1
    ORDER BY c DESC
    LIMIT 10
  `);

  console.log(JSON.stringify({ cross_message_same_text: r1.rows, same_message_same_text: r2.rows }, null, 2));
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
