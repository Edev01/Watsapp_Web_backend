require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const one = async (sql, params = []) => (await p.query(sql, params)).rows[0];
  const many = async (sql, params = []) => (await p.query(sql, params)).rows;
  const out = {
    messages: (await one('SELECT COUNT(*)::int AS c FROM whatsapp_messages')).c,
    normalized_rows: (await one('SELECT COUNT(*)::int AS c FROM normalized_messages')).c,
    msgs_with_norm: (await one('SELECT COUNT(DISTINCT whatsapp_message_id)::int AS c FROM normalized_messages')).c,
    unnormalized: (await one(`SELECT COUNT(*)::int AS c FROM whatsapp_messages m
      WHERE NOT EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id)`)).c,
    unnormalized_last_24h: (await one(`SELECT COUNT(*)::int AS c FROM whatsapp_messages m
      WHERE m.created_at > NOW() - INTERVAL '24 hours'
        AND NOT EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id)`)).c,
    unnormalized_last_7d: (await one(`SELECT COUNT(*)::int AS c FROM whatsapp_messages m
      WHERE m.created_at > NOW() - INTERVAL '7 days'
        AND NOT EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id)`)).c,
    by_user: await many(`SELECT m.user_id, COUNT(*)::int AS unnormalized
      FROM whatsapp_messages m
      WHERE NOT EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id)
      GROUP BY m.user_id ORDER BY unnormalized DESC LIMIT 10`)
  };
  try {
    out.queue = await many(`SELECT status, COUNT(*)::int AS c FROM normalize_claims GROUP BY status ORDER BY c DESC`);
  } catch (_) {
    out.queue = null;
  }
  console.log(JSON.stringify(out, null, 2));
  await p.end();
})().catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });
