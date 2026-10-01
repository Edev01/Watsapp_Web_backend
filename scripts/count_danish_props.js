#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');

(async () => {
  const users = await db.query(
    `SELECT id, email, name FROM users
     WHERE id = 4
        OR LOWER(email) LIKE '%danish%'
        OR LOWER(COALESCE(name, '')) LIKE '%danish%'`
  );
  console.log('users', users.rows);

  const userId = 4;
  const counts = await db.query(
    `SELECT
       COUNT(*)::int AS all_normalized,
       COUNT(*) FILTER (WHERE n.is_property IS TRUE)::int AS properties,
       COUNT(*) FILTER (
         WHERE n.is_property IS TRUE
           AND UPPER(COALESCE(n.property_status, 'AVAILABLE')) = 'AVAILABLE'
       )::int AS available,
       COUNT(*) FILTER (
         WHERE n.is_property IS TRUE
           AND UPPER(COALESCE(n.property_status, 'AVAILABLE')) <> 'AVAILABLE'
       )::int AS not_available
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE m.user_id = $1`,
    [userId]
  );
  console.log('counts', counts.rows[0]);
  console.log('ZZ_DONE');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
