
require("dotenv").config();
const db = require("../db");
(async () => {
  const r = await db.query(`
    SELECT
      COUNT(*)::int AS hits_today,
      COUNT(*) FILTER (WHERE ok)::int AS ok_hits,
      COUNT(DISTINCT message_id)::int AS distinct_msgs,
      COUNT(DISTINCT user_id)::int AS users,
      MIN(hit_at) AS first_hit,
      MAX(hit_at) AS last_hit
    FROM openai_api_hits
    WHERE hit_at >= ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Karachi')::date)::timestamp AT TIME ZONE 'Asia/Karachi'
      AND hit_at <  (((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Karachi')::date) + 1)::timestamp AT TIME ZONE 'Asia/Karachi'
  `);
  const byUser = await db.query(`
    SELECT user_id, COUNT(*)::int AS hits
    FROM openai_api_hits
    WHERE hit_at >= ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Karachi')::date)::timestamp AT TIME ZONE 'Asia/Karachi'
      AND hit_at <  (((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Karachi')::date) + 1)::timestamp AT TIME ZONE 'Asia/Karachi'
    GROUP BY user_id ORDER BY hits DESC
  `);
  const day = await db.query(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Karachi')::date AS pkt_today`);
  console.log(JSON.stringify({ day: day.rows[0], totals: r.rows[0], byUser: byUser.rows }, null, 2));
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
