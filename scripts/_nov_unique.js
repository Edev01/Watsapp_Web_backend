
require("dotenv").config();
const db = require("../db");

(async () => {
  // November PKT window
  const start = "2026-11-01 00:00:00+05";
  const end = "2026-12-01 00:00:00+05";

  // 1) All scraped msgs this month (Danish)
  const total = await db.query(
    `SELECT COUNT(*)::int AS total_msgs,
            COUNT(DISTINCT COALESCE(NULLIF(content_fingerprint,''), md5(COALESCE(message,''))))::int AS unique_fps,
            COUNT(DISTINCT chat_jid)::int AS chats
     FROM whatsapp_messages
     WHERE user_id = 4
       AND created_at >= $1 AND created_at < $2`,
    [start, end]
  );
  console.log("===ALL_MSGS_NOV===");
  console.log(JSON.stringify(total.rows[0], null, 2));

  // 2) Monitored groups only
  const mon = await db.query(
    `SELECT COUNT(*)::int AS total_msgs,
            COUNT(DISTINCT COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,''))))::int AS unique_fps,
            COUNT(DISTINCT m.chat_jid)::int AS chats
     FROM whatsapp_messages m
     JOIN whatsapp_chats c ON c.user_id=m.user_id AND c.jid=m.chat_jid AND c.is_monitored
     WHERE m.user_id = 4
       AND m.created_at >= $1 AND m.created_at < $2`,
    [start, end]
  );
  console.log("===MONITORED_MSGS_NOV===");
  console.log(JSON.stringify(mon.rows[0], null, 2));

  // 3) Unique that got normalized this month (by message created_at)
  const norm = await db.query(
    `SELECT COUNT(*)::int AS msgs_with_norm_row,
            COUNT(DISTINCT COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,''))))::int AS unique_fps_normalized,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM normalized_messages n
              WHERE n.whatsapp_message_id=m.id AND n.is_property IS TRUE
            ))::int AS msgs_with_property
     FROM whatsapp_messages m
     JOIN whatsapp_chats c ON c.user_id=m.user_id AND c.jid=m.chat_jid AND c.is_monitored
     WHERE m.user_id = 4
       AND m.created_at >= $1 AND m.created_at < $2
       AND EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id=m.id)`,
    [start, end]
  );
  console.log("===NORMALIZED_UNIQUE_NOV===");
  console.log(JSON.stringify(norm.rows[0], null, 2));

  // 4) Per group breakdown (monitored) — unique fps this month
  const perGroup = await db.query(
    `SELECT c.name, c.monitor_letter,
            COUNT(m.id)::int AS total_msgs,
            COUNT(DISTINCT COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,''))))::int AS unique_fps,
            COUNT(DISTINCT m.id) FILTER (
              WHERE EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id=m.id)
            )::int AS msgs_normalized,
            COUNT(DISTINCT COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,'')))) FILTER (
              WHERE EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id=m.id)
            )::int AS unique_fps_normalized
     FROM whatsapp_chats c
     LEFT JOIN whatsapp_messages m
       ON m.user_id=c.user_id AND m.chat_jid=c.jid
      AND m.created_at >= $1 AND m.created_at < $2
     WHERE c.user_id=4 AND c.is_monitored
     GROUP BY c.name, c.monitor_letter
     ORDER BY unique_fps DESC NULLS LAST`,
    [start, end]
  );
  console.log("===PER_GROUP_NOV===");
  console.log(JSON.stringify(perGroup.rows, null, 2));

  // 5) OpenAI hits this month + distinct msgs hit
  const hits = await db.query(
    `SELECT COUNT(*)::int AS hits,
            COUNT(DISTINCT message_id)::int AS distinct_msg_ids_hit
     FROM openai_api_hits
     WHERE user_id=4
       AND hit_at >= $1 AND hit_at < $2`,
    [start, end]
  );
  console.log("===HITS_NOV===");
  console.log(JSON.stringify(hits.rows[0], null, 2));

  // 6) Days in month so far (PKT)
  const days = await db.query(
    `SELECT COUNT(DISTINCT ((created_at AT TIME ZONE 'Asia/Karachi')::date))::int AS active_days
     FROM whatsapp_messages
     WHERE user_id=4 AND created_at >= $1 AND created_at < $2`,
    [start, end]
  );
  console.log("===ACTIVE_DAYS===");
  console.log(JSON.stringify(days.rows[0], null, 2));

  // 7) Daily unique across monitored
  const daily = await db.query(
    `WITH d AS (
       SELECT ((m.created_at AT TIME ZONE 'Asia/Karachi')::date) AS pkt_day,
              COUNT(*)::int AS msgs,
              COUNT(DISTINCT COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,''))))::int AS unique_fps
       FROM whatsapp_messages m
       JOIN whatsapp_chats c ON c.user_id=m.user_id AND c.jid=m.chat_jid AND c.is_monitored
       WHERE m.user_id=4 AND m.created_at >= $1 AND m.created_at < $2
       GROUP BY 1
     )
     SELECT ROUND(AVG(msgs)::numeric,1) AS avg_msgs_day,
            ROUND(AVG(unique_fps)::numeric,1) AS avg_unique_day,
            SUM(msgs)::int AS sum_msgs,
            SUM(unique_fps)::int AS sum_unique_day_sums,
            COUNT(*)::int AS days
     FROM d`,
    [start, end]
  );
  console.log("===DAILY_AVG_NOV===");
  console.log(JSON.stringify(daily.rows[0], null, 2));

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
