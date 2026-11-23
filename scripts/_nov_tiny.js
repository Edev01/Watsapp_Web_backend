
require("dotenv").config();
const db = require("../db");
(async () => {
  const start = "2026-11-01 00:00:00+05";
  const end = "2026-12-01 00:00:00+05";
  const msgs = await db.query(`
    SELECT COUNT(*)::int AS total_msgs,
           COUNT(DISTINCT COALESCE(NULLIF(content_fingerprint,''), md5(COALESCE(message,''))))::int AS unique_msgs
    FROM whatsapp_messages WHERE user_id=4 AND created_at >= $1 AND created_at < $2`, [start, end]);
  const hits = await db.query(`
    SELECT COUNT(*)::int AS total_hits
    FROM openai_api_hits WHERE user_id=4 AND hit_at >= $1 AND hit_at < $2`, [start, end]);
  console.log(JSON.stringify({msgs: msgs.rows[0], hits: hits.rows[0]}));
  process.exit(0);
})().catch(e=>{console.error(e); process.exit(1);});
