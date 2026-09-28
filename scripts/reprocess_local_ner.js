require('dotenv').config();
const db = require('../db');
const { extractMessageSchema, LOCAL_MODEL, refreshGazetteer } = require('../ai/localNer');
const { saveNormalized } = require('../ai/normalizer');

(async () => {
  await refreshGazetteer(true);
  const limit = Math.min(parseInt(process.env.NER_REPROCESS_LIMIT || '1500', 10), 4000);
  const userId = process.env.NER_USER_ID ? Number(process.env.NER_USER_ID) : null;
  const params = [LOCAL_MODEL, limit];
  let userSql = '';
  if (Number.isFinite(userId) && userId > 0) {
    params.push(userId);
    userSql = `AND m.user_id = $${params.length}`;
  }
  const rows = await db.query(
    `SELECT m.id, m.user_id, m.chat_jid, m.sender, m.message
     FROM whatsapp_messages m
     WHERE EXISTS (
       SELECT 1 FROM normalized_messages n
       WHERE n.whatsapp_message_id = m.id AND n.model_used = $1
     )
     AND NOT EXISTS (
       SELECT 1 FROM normalized_messages g
       WHERE g.whatsapp_message_id = m.id
         AND g.model_used IS DISTINCT FROM $1
     )
     ${userSql}
     ORDER BY m.id DESC
     LIMIT $2`,
    params
  );
  let ok = 0;
  let fail = 0;
  for (const job of rows.rows) {
    try {
      const schema = await extractMessageSchema(job.message, job.sender);
      if (!schema) {
        fail += 1;
        continue;
      }
      await saveNormalized(job, schema, LOCAL_MODEL);
      ok += 1;
    } catch (err) {
      fail += 1;
      console.warn('reprocess fail', job.id, err.message);
    }
  }
  console.log('REPROCESS', JSON.stringify({ scanned: rows.rowCount, ok, fail }));
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
