
require("dotenv").config();
const db = require("../db");
(async () => {
  const u = await db.query(`SELECT id,email,name FROM users WHERE id=4`);
  const msgs = await db.query(`
    SELECT COUNT(*)::int AS total_msgs,
           COUNT(DISTINCT COALESCE(NULLIF(content_fingerprint,''), md5(COALESCE(message,''))))::int AS unique_msgs,
           MIN(created_at) AS first_msg,
           MAX(created_at) AS last_msg
    FROM whatsapp_messages WHERE user_id=4`);
  const hits = await db.query(`
    SELECT COUNT(*)::int AS total_hits,
           COUNT(*) FILTER (WHERE ok)::int AS ok_hits,
           MIN(hit_at) AS first_hit,
           MAX(hit_at) AS last_hit
    FROM openai_api_hits WHERE user_id=4`);
  const nov = await db.query(`
    SELECT COUNT(*)::int AS nov_hits
    FROM openai_api_hits
    WHERE user_id=4
      AND hit_at >= '2026-11-01 00:00:00+05'
      AND hit_at <  '2026-12-01 00:00:00+05'`);
  console.log(JSON.stringify({user:u.rows[0], msgs:msgs.rows[0], hits:hits.rows[0], nov:nov.rows[0]}, null, 2));
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
