require('dotenv').config();
const db = require('../db');
const { extractMessageSchema, LOCAL_MODEL, refreshGazetteer } = require('../ai/localNer');

function norm(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function fieldHit(gold, got) {
  const g = norm(gold);
  const x = norm(got);
  if (!g) return null;
  if (!x) return false;
  return g === x || g.includes(x) || x.includes(g);
}

(async () => {
  await refreshGazetteer(true);

  const counts = await db.query(`
    SELECT m.user_id,
           COUNT(*)::int AS messages,
           COUNT(n.id)::int AS normalized_rows,
           COUNT(DISTINCT n.whatsapp_message_id)::int AS normalized_msgs,
           COUNT(*) FILTER (WHERE n.id IS NULL)::int AS pending_msgs
    FROM whatsapp_messages m
    LEFT JOIN LATERAL (
      SELECT id, whatsapp_message_id FROM normalized_messages nx
      WHERE nx.whatsapp_message_id = m.id
      LIMIT 1
    ) n ON TRUE
    GROUP BY m.user_id
    ORDER BY m.user_id
  `);

  const byModel = await db.query(`
    SELECT COALESCE(model_used, '?') AS model_used,
           COUNT(*)::int AS rows,
           COUNT(*) FILTER (WHERE is_property IS TRUE)::int AS property_rows,
           MAX(created_at) AS newest
    FROM normalized_messages
    GROUP BY 1
    ORDER BY rows DESC
  `);

  console.log('COUNTS', JSON.stringify(counts.rows));
  console.log('BY_MODEL', JSON.stringify(byModel.rows));

  const gold = await db.query(
    `SELECT m.id, m.message, m.sender,
            n.city, n.area, n.vicinity, n.purpose, n.property_type, n.size_unit
     FROM normalized_messages n
     INNER JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE m.user_id = 4
       AND n.is_property IS TRUE
       AND COALESCE(n.model_used, '') NOT ILIKE '%local-ner%'
     ORDER BY n.id DESC
     LIMIT 250`
  );

  const stats = {
    n: 0,
    city: [0, 0],
    area: [0, 0],
    vicinity: [0, 0],
    purpose: [0, 0],
    property_type: [0, 0],
    size_unit: [0, 0]
  };
  for (const row of gold.rows) {
    const schema = await extractMessageSchema(row.message, row.sender);
    if (!schema) continue;
    stats.n += 1;
    const got = schema.listings && schema.listings[0] ? { ...schema, ...schema.listings[0] } : schema;
    for (const key of ['city', 'area', 'vicinity', 'purpose', 'property_type', 'size_unit']) {
      const hit = fieldHit(row[key], got[key]);
      if (hit == null) continue;
      stats[key][1] += 1;
      if (hit) stats[key][0] += 1;
    }
  }
  const acc = {};
  for (const key of ['city', 'area', 'vicinity', 'purpose', 'property_type', 'size_unit']) {
    const [ok, tot] = stats[key];
    acc[key] = tot ? `${ok}/${tot} (${Math.round((ok / tot) * 100)}%)` : 'n/a';
  }
  console.log('GOLD_EVAL', JSON.stringify({ compared: stats.n, acc }));

  const weak = await db.query(
    `DELETE FROM normalized_messages n
     WHERE n.model_used = $1
       AND n.is_property IS NOT TRUE
       AND NOT EXISTS (
         SELECT 1 FROM normalized_messages g
         WHERE g.whatsapp_message_id = n.whatsapp_message_id
           AND g.model_used IS DISTINCT FROM $1
       )
     RETURNING n.id`,
    [LOCAL_MODEL]
  );
  console.log('WEAK_NER_DELETED', weak.rowCount);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
