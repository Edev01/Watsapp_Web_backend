#!/usr/bin/env node
/**
 * One-off probe: Danish unique normalize volume + OpenAI hit stats for budget.
 */
require('dotenv').config();
const db = require('../db');

(async () => {
  const userQ = await db.query(
    `SELECT id, email, name FROM users
     WHERE id = 4 OR LOWER(email) LIKE '%danish%' OR LOWER(COALESCE(name,'')) LIKE '%danish%'
     ORDER BY id`
  );
  const userId = userQ.rows.find((r) => r.id === 4)?.id || userQ.rows[0]?.id;
  console.log(JSON.stringify({ users: userQ.rows, usingUserId: userId }, null, 2));

  const chats = await db.query(
    `SELECT c.jid, c.name, c.is_monitored, c.monitor_letter,
            COUNT(m.id)::int AS total_msgs,
            COUNT(DISTINCT COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,''))))::int AS unique_body_fps,
            COUNT(DISTINCT m.id) FILTER (
              WHERE EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id)
            )::int AS msgs_with_norm,
            COUNT(DISTINCT COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,'')))) FILTER (
              WHERE EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id)
            )::int AS unique_fps_normalized
     FROM whatsapp_chats c
     LEFT JOIN whatsapp_messages m ON m.user_id = c.user_id AND m.chat_jid = c.jid
     WHERE c.user_id = $1
     GROUP BY c.jid, c.name, c.is_monitored, c.monitor_letter
     ORDER BY c.is_monitored DESC, total_msgs DESC`,
    [userId]
  );
  console.log('===CHATS===');
  console.log(JSON.stringify(chats.rows, null, 2));

  const dailyAvg = await db.query(
    `WITH msg AS (
       SELECT m.id, m.chat_jid,
              COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,''))) AS fp,
              ((m.created_at AT TIME ZONE 'Asia/Karachi')::date) AS pkt_day
       FROM whatsapp_messages m
       WHERE m.user_id = $1
         AND EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id)
         AND EXISTS (
           SELECT 1 FROM whatsapp_chats c
           WHERE c.user_id = m.user_id AND c.jid = m.chat_jid AND c.is_monitored IS TRUE
         )
     ),
     per_day AS (
       SELECT chat_jid, pkt_day, COUNT(DISTINCT fp)::int AS unique_fps
       FROM msg GROUP BY chat_jid, pkt_day
     )
     SELECT chat_jid,
            COUNT(*)::int AS active_days,
            ROUND(AVG(unique_fps)::numeric, 1) AS avg_unique_norm_per_day,
            ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY unique_fps)::numeric, 1) AS median_unique_norm_per_day,
            MAX(unique_fps)::int AS max_unique_norm_day,
            SUM(unique_fps)::int AS total_unique_norm_day_sums
     FROM per_day
     GROUP BY chat_jid
     ORDER BY avg_unique_norm_per_day DESC`,
    [userId]
  );
  console.log('===DAILY_AVG_PER_MONITORED_CHAT===');
  console.log(JSON.stringify(dailyAvg.rows, null, 2));

  const overallAvg = await db.query(
    `WITH msg AS (
       SELECT m.id, m.chat_jid,
              COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,''))) AS fp,
              ((m.created_at AT TIME ZONE 'Asia/Karachi')::date) AS pkt_day
       FROM whatsapp_messages m
       WHERE m.user_id = $1
         AND EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id)
         AND EXISTS (
           SELECT 1 FROM whatsapp_chats c
           WHERE c.user_id = m.user_id AND c.jid = m.chat_jid AND c.is_monitored IS TRUE
         )
     ),
     per_chat_day AS (
       SELECT chat_jid, pkt_day, COUNT(DISTINCT fp)::int AS unique_fps
       FROM msg GROUP BY chat_jid, pkt_day
     )
     SELECT
       COUNT(*)::int AS chat_days,
       COUNT(DISTINCT chat_jid)::int AS monitored_chats_with_norm,
       COUNT(DISTINCT pkt_day)::int AS active_days,
       ROUND(AVG(unique_fps)::numeric, 1) AS avg_unique_norm_msgs_per_group_per_day,
       ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY unique_fps)::numeric, 1) AS median_per_group_per_day,
       ROUND((SUM(unique_fps)::numeric / NULLIF(COUNT(DISTINCT pkt_day),0)), 1) AS avg_total_unique_across_all_groups_per_day
     FROM per_chat_day`,
    [userId]
  );
  console.log('===OVERALL_AVG===');
  console.log(JSON.stringify(overallAvg.rows[0], null, 2));

  // Also: unique msgs that actually caused OpenAI hits (true billable)
  const hitPerGroupDay = await db.query(
    `WITH hit_msgs AS (
       SELECT DISTINCT h.message_id, m.chat_jid,
              ((h.hit_at AT TIME ZONE 'Asia/Karachi')::date) AS pkt_day
       FROM openai_api_hits h
       JOIN whatsapp_messages m ON m.id = h.message_id
       WHERE h.user_id = $1 AND h.ok IS TRUE AND h.message_id IS NOT NULL
     ),
     per AS (
       SELECT chat_jid, pkt_day, COUNT(*)::int AS unique_hit_msgs
       FROM hit_msgs GROUP BY chat_jid, pkt_day
     )
     SELECT
       ROUND(AVG(unique_hit_msgs)::numeric, 1) AS avg_ok_hit_msgs_per_group_per_day,
       ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY unique_hit_msgs)::numeric, 1) AS median,
       COUNT(DISTINCT chat_jid)::int AS chats,
       COUNT(DISTINCT pkt_day)::int AS days,
       ROUND((SUM(unique_hit_msgs)::numeric / NULLIF(COUNT(DISTINCT pkt_day),0)), 1) AS avg_total_ok_hit_msgs_per_day
     FROM per`,
    [userId]
  );
  console.log('===OK_HIT_MSGS_PER_GROUP_DAY===');
  console.log(JSON.stringify(hitPerGroupDay.rows[0], null, 2));

  const hits = await db.query(
    `SELECT
       COUNT(*)::int AS total_hits,
       COUNT(*) FILTER (WHERE ok)::int AS ok_hits,
       COUNT(DISTINCT message_id)::int AS distinct_messages,
       MIN(hit_at) AS first_hit,
       MAX(hit_at) AS last_hit
     FROM openai_api_hits WHERE user_id = $1`,
    [userId]
  );
  console.log('===HITS===');
  console.log(JSON.stringify(hits.rows[0], null, 2));

  const hitsDaily = await db.query(
    `SELECT ((hit_at AT TIME ZONE 'Asia/Karachi')::date) AS pkt_day,
            COUNT(*)::int AS hits,
            COUNT(*) FILTER (WHERE ok)::int AS ok_hits,
            COUNT(DISTINCT message_id)::int AS distinct_msgs
     FROM openai_api_hits
     WHERE user_id = $1
     GROUP BY 1
     ORDER BY 1 DESC
     LIMIT 30`,
    [userId]
  );
  console.log('===HITS_DAILY===');
  console.log(JSON.stringify(hitsDaily.rows, null, 2));

  const hitAvg = await db.query(
    `SELECT
       COUNT(DISTINCT ((hit_at AT TIME ZONE 'Asia/Karachi')::date))::int AS days_with_hits,
       ROUND((COUNT(*)::numeric / NULLIF(COUNT(DISTINCT ((hit_at AT TIME ZONE 'Asia/Karachi')::date)),0)), 1) AS avg_hits_per_day,
       ROUND((COUNT(*) FILTER (WHERE ok)::numeric / NULLIF(COUNT(DISTINCT ((hit_at AT TIME ZONE 'Asia/Karachi')::date)),0)), 1) AS avg_ok_hits_per_day
     FROM openai_api_hits WHERE user_id = $1`,
    [userId]
  );
  console.log('===HIT_AVG===');
  console.log(JSON.stringify(hitAvg.rows[0], null, 2));

  const sizes = await db.query(
    `SELECT
       COUNT(*)::int AS n,
       ROUND(AVG(LENGTH(m.message))::numeric, 0) AS avg_chars,
       ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY LENGTH(m.message))::numeric, 0) AS median_chars,
       ROUND(AVG(LENGTH(m.message)/4.0)::numeric, 0) AS approx_avg_input_msg_tokens,
       MAX(LENGTH(m.message))::int AS max_chars
     FROM openai_api_hits h
     JOIN whatsapp_messages m ON m.id = h.message_id
     WHERE h.user_id = $1 AND h.ok IS TRUE AND m.message IS NOT NULL`,
    [userId]
  );
  console.log('===MSG_SIZES_FOR_HITS===');
  console.log(JSON.stringify(sizes.rows[0], null, 2));

  const counter = await db.query(
    `SELECT total_hits, last_hit_at FROM openai_api_counter WHERE id=1`
  );
  console.log('===GLOBAL_COUNTER===');
  console.log(JSON.stringify(counter.rows[0], null, 2));

  const models = await db.query(
    `SELECT model, COUNT(*)::int AS n FROM openai_api_hits WHERE user_id=$1 GROUP BY model ORDER BY n DESC`,
    [userId]
  );
  console.log('===MODELS===');
  console.log(JSON.stringify(models.rows, null, 2));

  const mon = await db.query(
    `SELECT COUNT(*)::int AS monitored FROM whatsapp_chats WHERE user_id=$1 AND is_monitored`,
    [userId]
  );
  console.log('===MONITORED===', JSON.stringify(mon.rows[0]));

  // Prompt overhead estimate from extract prompt length on disk
  const fs = require('fs');
  const path = require('path');
  try {
    const extractPath = path.join(__dirname, '../ai/extract/extractor.js');
    const txt = fs.readFileSync(extractPath, 'utf8');
    console.log('===EXTRACTOR_FILE_CHARS===', txt.length);
  } catch (_) {}

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
