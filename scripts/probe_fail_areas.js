#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const needles = [
  'badban', 'bakar', '25th', 'zahra', 'coral', 'peral', 'pearl',
  '4th belt', '1st belt', 'saba avenue', 'abu bakar'
];

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: String(process.env.DATABASE_URL || '').includes('localhost')
      ? false
      : { rejectUnauthorized: false }
  });
  for (const n of needles) {
    const { rows } = await pool.query(
      `SELECT n.id, n.area, n.vicinity, n.city,
              (n.is_property IS TRUE OR n.purpose IS NOT NULL OR n.property_type IS NOT NULL) AS propish
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
       WHERE m.user_id = 4
         AND (
           LOWER(COALESCE(n.area,'')) LIKE $1
           OR LOWER(COALESCE(n.vicinity,'')) LIKE $1
           OR LOWER(COALESCE(n.city,'')) LIKE $1
         )
       LIMIT 5`,
      [`%${n}%`]
    );
    console.log('\n===', n, 'count_sample', rows.length);
    for (const r of rows) console.log(JSON.stringify(r));
  }
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
