
require("dotenv").config();
const db = require("../db");

(async () => {
  const start = "2026-11-01 00:00:00+05";
  const end = "2026-12-01 00:00:00+05";

  // How Nov messages were normalized (via normalized_messages fields)
  const byModel = await db.query(`
    SELECT
      CASE
        WHEN n.summary = '[skipped duplicate listing content]' OR n.intent = 'duplicate' THEN 'dup-skip'
        WHEN COALESCE(n.model_used,'') ILIKE '%extract%' AND n.summary IS DISTINCT FROM '[skipped duplicate listing content]' THEN 'llm-or-other'
        ELSE COALESCE(n.model_used, '(null)')
      END AS bucket,
      COUNT(DISTINCT m.id)::int AS msgs,
      COUNT(DISTINCT COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,''))))::int AS unique_fps
    FROM whatsapp_messages m
    JOIN normalized_messages n ON n.whatsapp_message_id = m.id
    WHERE m.user_id = 4
      AND m.created_at >= $1 AND m.created_at < $2
    GROUP BY 1
    ORDER BY msgs DESC
  `, [start, end]);
  console.log("===BY_BUCKET===");
  console.log(JSON.stringify(byModel.rows, null, 2));

  const dupDetail = await db.query(`
    SELECT
      COUNT(DISTINCT m.id)::int AS msgs_dup_skip,
      COUNT(DISTINCT COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,''))))::int AS unique_fps_dup_skip,
      COUNT(DISTINCT m.id) FILTER (WHERE LENGTH(TRIM(COALESCE(m.message,''))) < 12)::int AS short_msgs,
      COUNT(DISTINCT m.id) FILTER (
        WHERE n.summary = '[skipped duplicate listing content]' OR n.intent = 'duplicate'
      )::int AS marked_duplicate,
      COUNT(DISTINCT m.id) FILTER (
        WHERE LENGTH(TRIM(COALESCE(m.message,''))) < 12
          AND NOT (n.summary = '[skipped duplicate listing content]' OR n.intent = 'duplicate')
      )::int AS short_not_dup
    FROM whatsapp_messages m
    JOIN normalized_messages n ON n.whatsapp_message_id = m.id
    WHERE m.user_id = 4
      AND m.created_at >= $1 AND m.created_at < $2
  `, [start, end]);
  console.log("===DUP_SHORT===");
  console.log(JSON.stringify(dupDetail.rows[0], null, 2));

  // Msgs with norm row but NO openai hit in Nov (or ever)
  const noHit = await db.query(`
    SELECT
      COUNT(DISTINCT m.id)::int AS norm_msgs_no_hit_ever,
      COUNT(DISTINCT m.id) FILTER (
        WHERE n.summary = '[skipped duplicate listing content]' OR n.intent = 'duplicate'
      )::int AS of_those_dup,
      COUNT(DISTINCT m.id) FILTER (
        WHERE LENGTH(TRIM(COALESCE(m.message,''))) < 12
      )::int AS of_those_short,
      COUNT(DISTINCT COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,''))))::int AS unique_fps_no_hit
    FROM whatsapp_messages m
    JOIN normalized_messages n ON n.whatsapp_message_id = m.id
    WHERE m.user_id = 4
      AND m.created_at >= $1 AND m.created_at < $2
      AND NOT EXISTS (
        SELECT 1 FROM openai_api_hits h WHERE h.message_id = m.id AND h.ok
      )
  `, [start, end]);
  console.log("===NORM_NO_HIT===");
  console.log(JSON.stringify(noHit.rows[0], null, 2));

  // Sample of no-hit reasons
  const sample = await db.query(`
    SELECT m.id,
           LEFT(REPLACE(COALESCE(m.message,''), E'\\n', ' '), 80) AS preview,
           LENGTH(TRIM(COALESCE(m.message,'')))::int AS chars,
           n.intent,
           LEFT(COALESCE(n.summary,''), 60) AS summary,
           n.model_used,
           n.is_property
    FROM whatsapp_messages m
    JOIN normalized_messages n ON n.whatsapp_message_id = m.id AND n.listing_index = 0
    WHERE m.user_id = 4
      AND m.created_at >= $1 AND m.created_at < $2
      AND NOT EXISTS (SELECT 1 FROM openai_api_hits h WHERE h.message_id = m.id)
    ORDER BY m.id DESC
    LIMIT 8
  `, [start, end]);
  console.log("===SAMPLE_NO_HIT===");
  console.log(JSON.stringify(sample.rows, null, 2));

  // Bridge the numbers
  const bridge = await db.query(`
    WITH nov AS (
      SELECT m.id,
             COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,''))) AS fp,
             LENGTH(TRIM(COALESCE(m.message,''))) AS chars,
             EXISTS (SELECT 1 FROM openai_api_hits h WHERE h.message_id = m.id AND h.ok) AS had_hit,
             EXISTS (
               SELECT 1 FROM normalized_messages n
               WHERE n.whatsapp_message_id = m.id
                 AND (n.summary = '[skipped duplicate listing content]' OR n.intent = 'duplicate')
             ) AS is_dup
      FROM whatsapp_messages m
      WHERE m.user_id = 4 AND m.created_at >= $1 AND m.created_at < $2
    )
    SELECT
      COUNT(*)::int AS total_msgs,
      COUNT(DISTINCT fp)::int AS unique_fps,
      COUNT(*) FILTER (WHERE had_hit)::int AS msgs_with_hit,
      COUNT(*) FILTER (WHERE is_dup)::int AS msgs_dup_skip,
      COUNT(*) FILTER (WHERE chars < 12)::int AS msgs_short,
      COUNT(*) FILTER (WHERE NOT had_hit AND is_dup)::int AS no_hit_because_dup,
      COUNT(*) FILTER (WHERE NOT had_hit AND chars < 12 AND NOT is_dup)::int AS no_hit_because_short,
      COUNT(*) FILTER (WHERE NOT had_hit AND NOT is_dup AND chars >= 12)::int AS no_hit_other
    FROM nov
  `, [start, end]);
  console.log("===BRIDGE===");
  console.log(JSON.stringify(bridge.rows[0], null, 2));

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
