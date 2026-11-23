
require("dotenv").config();
const db = require("../db");

(async () => {
  const month = await db.query(`
    SELECT
      COUNT(*)::int AS hits,
      COUNT(*) FILTER (WHERE ok)::int AS ok_hits,
      COUNT(DISTINCT user_id)::int AS users,
      COUNT(DISTINCT message_id)::int AS distinct_msgs,
      MIN(hit_at) AS first_hit,
      MAX(hit_at) AS last_hit
    FROM openai_api_hits
    WHERE hit_at >= '2026-11-01 00:00:00+05'
      AND hit_at <  '2026-12-01 00:00:00+05'
  `);
  console.log("===NOV_PKT===");
  console.log(JSON.stringify(month.rows[0], null, 2));

  const byUser = await db.query(`
    SELECT user_id, COUNT(*)::int AS hits
    FROM openai_api_hits
    WHERE hit_at >= '2026-11-01 00:00:00+05'
      AND hit_at <  '2026-12-01 00:00:00+05'
    GROUP BY user_id
    ORDER BY hits DESC
  `);
  console.log("===BY_USER===");
  console.log(JSON.stringify(byUser.rows, null, 2));

  const byDay = await db.query(`
    SELECT ((hit_at AT TIME ZONE 'Asia/Karachi')::date) AS pkt_day,
           COUNT(*)::int AS hits
    FROM openai_api_hits
    WHERE hit_at >= '2026-11-01 00:00:00+05'
      AND hit_at <  '2026-12-01 00:00:00+05'
    GROUP BY 1
    ORDER BY 1
  `);
  console.log("===BY_DAY===");
  console.log(JSON.stringify(byDay.rows, null, 2));

  const all = await db.query(`SELECT total_hits FROM openai_api_counter WHERE id=1`);
  console.log("===ALL_TIME_COUNTER===");
  console.log(JSON.stringify(all.rows[0], null, 2));

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
