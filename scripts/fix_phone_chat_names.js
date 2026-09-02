/**
 * Upgrade phone-number chat titles using message sender push names.
 * Usage: node scripts/fix_phone_chat_names.js [userId]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const userId = parseInt(process.argv[2] || '75', 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

async function main() {
  const result = await pool.query(
    `
    UPDATE whatsapp_chats c
    SET name = sub.best_sender
    FROM (
      SELECT m.chat_jid,
        (array_agg(m.sender ORDER BY m.id DESC))[1] AS best_sender
      FROM whatsapp_messages m
      WHERE m.user_id = $1
        AND m.from_me = false
        AND m.sender IS NOT NULL
        AND trim(m.sender) <> ''
        AND m.sender NOT IN ('Me', 'unknown')
        AND m.sender !~ '^[0-9+\\s()-]+$'
        AND length(trim(m.sender)) > 2
      GROUP BY m.chat_jid
    ) sub
    WHERE c.user_id = $1
      AND c.jid = sub.chat_jid
      AND (
        c.name ~ '^[0-9]+$'
        OR regexp_replace(c.name, '\\D', '', 'g') = regexp_replace(c.jid, '\\D', '', 'g')
      )
    RETURNING c.jid, c.name
    `,
    [userId]
  );

  console.log(`User ${userId}: updated ${result.rowCount} chat name(s) from message senders`);
  for (const row of result.rows.slice(0, 20)) {
    console.log(`  ${row.jid} -> ${row.name}`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
