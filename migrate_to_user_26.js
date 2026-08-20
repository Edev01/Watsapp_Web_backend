/**
 * One-off: migrate all scraped whatsapp_chats + whatsapp_messages to user_id = 26
 *
 * Handles unique constraints and child FKs:
 *   normalized_messages, model_comparisons, message_embeddings
 *
 * Moved messages keep their child rows. Duplicate leftover messages' child rows are deleted.
 */
require('dotenv').config();
const { Pool } = require('pg');

const TARGET_USER_ID = 26;

const CHILD_TABLES = [
  'normalized_messages',
  'model_comparisons',
  'message_embeddings'
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const user = await client.query('SELECT id, email, name FROM users WHERE id = $1', [
      TARGET_USER_ID
    ]);
    if (!user.rows[0]) {
      throw new Error(`User ${TARGET_USER_ID} does not exist — create the user first`);
    }
    console.log('Target user:', user.rows[0]);

    const before = await client.query(
      `
      SELECT
        (SELECT count(*)::int FROM whatsapp_chats) AS chats_total,
        (SELECT count(*)::int FROM whatsapp_chats WHERE user_id = $1) AS chats_target,
        (SELECT count(*)::int FROM whatsapp_messages) AS msgs_total,
        (SELECT count(*)::int FROM whatsapp_messages WHERE user_id = $1) AS msgs_target,
        (SELECT json_agg(row_to_json(t)) FROM (
           SELECT user_id, count(*)::int AS n FROM whatsapp_chats GROUP BY user_id ORDER BY user_id
         ) t) AS chats_by_user,
        (SELECT json_agg(row_to_json(t)) FROM (
           SELECT user_id, count(*)::int AS n FROM whatsapp_messages GROUP BY user_id ORDER BY user_id
         ) t) AS msgs_by_user
    `,
      [TARGET_USER_ID]
    );
    console.log('Before:', JSON.stringify(before.rows[0], null, 2));

    // 1) Move one message per unique key that is not already on target
    const movedMsgs = await client.query(
      `
      WITH candidates AS (
        SELECT DISTINCT ON (chat_jid, sender, "timestamp", message)
          id
        FROM whatsapp_messages
        WHERE user_id <> $1
        ORDER BY chat_jid, sender, "timestamp", message, id
      )
      UPDATE whatsapp_messages m
      SET user_id = $1
      FROM candidates c
      WHERE m.id = c.id
        AND NOT EXISTS (
          SELECT 1
          FROM whatsapp_messages m2
          WHERE m2.user_id = $1
            AND m2.chat_jid IS NOT DISTINCT FROM m.chat_jid
            AND m2.sender IS NOT DISTINCT FROM m.sender
            AND m2."timestamp" IS NOT DISTINCT FROM m."timestamp"
            AND m2.message IS NOT DISTINCT FROM m.message
        )
      RETURNING m.id
      `,
      [TARGET_USER_ID]
    );

    // 2) Delete child FK rows pointing at messages that will be removed (duplicates)
    const childStats = {};
    for (const table of CHILD_TABLES) {
      const deleted = await client.query(
        `
        DELETE FROM ${table} child
        USING whatsapp_messages m
        WHERE child.whatsapp_message_id = m.id
          AND m.user_id <> $1
        `,
        [TARGET_USER_ID]
      );
      childStats[table] = { deletedOrphans: deleted.rowCount };
    }

    // 3) Drop remaining messages still on other users
    const deletedDupMsgs = await client.query(
      `DELETE FROM whatsapp_messages WHERE user_id <> $1 RETURNING id`,
      [TARGET_USER_ID]
    );

    // 4) Move chats that won't violate unique_user_chat (one per jid)
    const movedChats = await client.query(
      `
      WITH candidates AS (
        SELECT DISTINCT ON (jid)
          id
        FROM whatsapp_chats
        WHERE user_id <> $1
        ORDER BY jid, id
      )
      UPDATE whatsapp_chats c
      SET user_id = $1
      FROM candidates cand
      WHERE c.id = cand.id
        AND NOT EXISTS (
          SELECT 1 FROM whatsapp_chats c2
          WHERE c2.user_id = $1 AND c2.jid = c.jid
        )
      RETURNING c.id
      `,
      [TARGET_USER_ID]
    );

    // 5) Merge monitored/name/avatar from leftover duplicates, then delete them
    await client.query(
      `
      UPDATE whatsapp_chats dest
      SET is_monitored = dest.is_monitored OR src.is_monitored,
          name = COALESCE(NULLIF(dest.name, ''), src.name),
          avatar = COALESCE(dest.avatar, src.avatar)
      FROM whatsapp_chats src
      WHERE dest.user_id = $1
        AND src.user_id <> $1
        AND dest.jid = src.jid
      `,
      [TARGET_USER_ID]
    );

    const deletedDupChats = await client.query(
      `DELETE FROM whatsapp_chats WHERE user_id <> $1 RETURNING id`,
      [TARGET_USER_ID]
    );

    const after = await client.query(
      `
      SELECT
        (SELECT count(*)::int FROM whatsapp_chats) AS chats_total,
        (SELECT count(*)::int FROM whatsapp_chats WHERE user_id = $1) AS chats_target,
        (SELECT count(*)::int FROM whatsapp_messages) AS msgs_total,
        (SELECT count(*)::int FROM whatsapp_messages WHERE user_id = $1) AS msgs_target,
        (SELECT count(*)::int FROM whatsapp_chats WHERE user_id <> $1) AS chats_other,
        (SELECT count(*)::int FROM whatsapp_messages WHERE user_id <> $1) AS msgs_other
    `,
      [TARGET_USER_ID]
    );

    await client.query('COMMIT');

    console.log('Migration result:', {
      movedMessages: movedMsgs.rowCount,
      childStats,
      deletedDuplicateMessages: deletedDupMsgs.rowCount,
      movedChats: movedChats.rowCount,
      deletedDuplicateChats: deletedDupChats.rowCount,
      after: after.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
