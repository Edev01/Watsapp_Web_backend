#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || process.env.DB_PASS,
    database: process.env.DB_NAME || 'whatsapp_web'
  });
  const { rows } = await pool.query(
    `SELECT n.id, n.area, n.vicinity, n.city, n.property_type, n.size, n.price,
            LEFT(n.summary, 120) AS summary,
            LEFT(n.listing_excerpt, 120) AS excerpt,
            LEFT(m.message, 200) AS msg
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE n.id = 29092`
  );
  console.log(JSON.stringify(rows, null, 2));
  await pool.end();
  console.log('DONE_TEST');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
