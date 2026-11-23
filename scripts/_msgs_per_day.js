
require("dotenv").config();
const db = require("../db");

(async () => {
  // Per monitored group: avg msgs/day over all days that had any msgs
  const perGroup = await db.query(`
    WITH daily AS (
      SELECT m.chat_jid,
             ((m.created_at AT TIME ZONE 'Asia/Karachi')::date) AS pkt_day,
             COUNT(*)::int AS msgs
      FROM whatsapp_messages m
      JOIN whatsapp_chats c
        ON c.user_id = m.user_id AND c.jid = m.chat_jid AND c.is_monitored IS TRUE
      WHERE m.user_id = 4
      GROUP BY m.chat_jid, 2
    )
    SELECT c.name,
           c.monitor_letter,
           d.chat_jid,
           COUNT(*)::int AS active_days,
           ROUND(AVG(d.msgs)::numeric, 1) AS avg_msgs_per_day,
           ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY d.msgs)::numeric, 1) AS median_msgs_per_day,
           MIN(d.msgs)::int AS min_day,
           MAX(d.msgs)::int AS max_day,
           SUM(d.msgs)::int AS total_msgs
    FROM daily d
    JOIN whatsapp_chats c ON c.user_id = 4 AND c.jid = d.chat_jid
    GROUP BY c.name, c.monitor_letter, d.chat_jid
    ORDER BY avg_msgs_per_day DESC
  `);
  console.log("===PER_GROUP_ALL_TIME===");
  console.log(JSON.stringify(perGroup.rows, null, 2));

  // Same for last 7 days
  const recent = await db.query(`
    WITH daily AS (
      SELECT m.chat_jid,
             ((m.created_at AT TIME ZONE 'Asia/Karachi')::date) AS pkt_day,
             COUNT(*)::int AS msgs
      FROM whatsapp_messages m
      JOIN whatsapp_chats c
        ON c.user_id = m.user_id AND c.jid = m.chat_jid AND c.is_monitored IS TRUE
      WHERE m.user_id = 4
        AND m.created_at >= NOW() - INTERVAL '7 days'
      GROUP BY m.chat_jid, 2
    )
    SELECT c.name,
           c.monitor_letter,
           COUNT(*)::int AS active_days,
           ROUND(AVG(d.msgs)::numeric, 1) AS avg_msgs_per_day,
           ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY d.msgs)::numeric, 1) AS median_msgs_per_day,
           SUM(d.msgs)::int AS total_msgs
    FROM daily d
    JOIN whatsapp_chats c ON c.user_id = 4 AND c.jid = d.chat_jid
    GROUP BY c.name, c.monitor_letter
    ORDER BY avg_msgs_per_day DESC
  `);
  console.log("===PER_GROUP_LAST7===");
  console.log(JSON.stringify(recent.rows, null, 2));

  const overall = await db.query(`
    WITH daily AS (
      SELECT m.chat_jid,
             ((m.created_at AT TIME ZONE 'Asia/Karachi')::date) AS pkt_day,
             COUNT(*)::int AS msgs
      FROM whatsapp_messages m
      JOIN whatsapp_chats c
        ON c.user_id = m.user_id AND c.jid = m.chat_jid AND c.is_monitored IS TRUE
      WHERE m.user_id = 4
      GROUP BY m.chat_jid, 2
    )
    SELECT ROUND(AVG(msgs)::numeric, 1) AS avg_per_group_per_day,
           ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY msgs)::numeric, 1) AS median_per_group_per_day,
           ROUND((SUM(msgs)::numeric / NULLIF(COUNT(DISTINCT pkt_day),0)), 1) AS avg_total_across_all_groups_per_day
    FROM daily
  `);
  console.log("===OVERALL===");
  console.log(JSON.stringify(overall.rows[0], null, 2));

  const overall7 = await db.query(`
    WITH daily AS (
      SELECT m.chat_jid,
             ((m.created_at AT TIME ZONE 'Asia/Karachi')::date) AS pkt_day,
             COUNT(*)::int AS msgs
      FROM whatsapp_messages m
      JOIN whatsapp_chats c
        ON c.user_id = m.user_id AND c.jid = m.chat_jid AND c.is_monitored IS TRUE
      WHERE m.user_id = 4
        AND m.created_at >= NOW() - INTERVAL '7 days'
      GROUP BY m.chat_jid, 2
    )
    SELECT ROUND(AVG(msgs)::numeric, 1) AS avg_per_group_per_day,
           ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY msgs)::numeric, 1) AS median_per_group_per_day,
           ROUND((SUM(msgs)::numeric / NULLIF(COUNT(DISTINCT pkt_day),0)), 1) AS avg_total_across_all_groups_per_day
    FROM daily
  `);
  console.log("===OVERALL7===");
  console.log(JSON.stringify(overall7.rows[0], null, 2));

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
