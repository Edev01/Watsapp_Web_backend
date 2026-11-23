
require("dotenv").config();
const db = require("../db");
(async () => {
  const start = "2026-11-01 00:00:00+05";
  const end = "2026-11-12 00:00:00+05"; // through end of Nov 11 PKT
  const r = await db.query(`
    SELECT COUNT(*)::int AS total_msgs,
           COUNT(DISTINCT COALESCE(NULLIF(content_fingerprint,''), md5(COALESCE(message,''))))::int AS unique_msgs,
           COUNT(DISTINCT ((created_at AT TIME ZONE 'Asia/Karachi')::date))::int AS active_days
    FROM whatsapp_messages
    WHERE user_id=4 AND created_at >= $1 AND created_at < $2
  `, [start, end]);
  const h = await db.query(`
    SELECT COUNT(*)::int AS hits
    FROM openai_api_hits
    WHERE user_id=4 AND hit_at >= $1 AND hit_at < $2
  `, [start, end]);
  console.log(JSON.stringify({...r.rows[0], db_hits: h.rows[0].hits}));
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
