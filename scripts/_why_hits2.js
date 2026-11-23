
require("dotenv").config();
const db = require("../db");
(async () => {
  const start = "2026-11-01 00:00:00+05";
  const end = "2026-12-01 00:00:00+05";

  // Hits in Nov: are the target messages from Nov or older / missing?
  const hitJoin = await db.query(`
    SELECT
      COUNT(*)::int AS nov_hits,
      COUNT(m.id)::int AS hit_msg_still_exists,
      COUNT(m.id) FILTER (WHERE m.created_at >= $1 AND m.created_at < $2)::int AS hit_on_nov_created_msg,
      COUNT(m.id) FILTER (WHERE m.created_at < $1)::int AS hit_on_pre_nov_msg,
      COUNT(*) FILTER (WHERE m.id IS NULL)::int AS hit_orphaned_deleted_msg
    FROM openai_api_hits h
    LEFT JOIN whatsapp_messages m ON m.id = h.message_id
    WHERE h.user_id = 4 AND h.hit_at >= $1 AND h.hit_at < $2
  `, [start, end]);
  console.log("===HIT_JOIN===");
  console.log(JSON.stringify(hitJoin.rows[0], null, 2));

  // Unique Nov msgs: outcome
  const outcomes = await db.query(`
    WITH nov AS (
      SELECT m.id, m.message,
             COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,''))) AS fp,
             LENGTH(TRIM(COALESCE(m.message,''))) AS chars
      FROM whatsapp_messages m WHERE m.user_id=4 AND m.created_at >= $1 AND m.created_at < $2
    ),
    tagged AS (
      SELECT n.*,
        EXISTS (SELECT 1 FROM openai_api_hits h WHERE h.message_id=n.id AND h.ok) AS has_hit,
        EXISTS (SELECT 1 FROM normalized_messages x WHERE x.whatsapp_message_id=n.id
                AND (x.summary='[skipped duplicate listing content]' OR x.intent='duplicate')) AS is_dup,
        EXISTS (SELECT 1 FROM normalized_messages x WHERE x.whatsapp_message_id=n.id) AS has_norm,
        EXISTS (
          SELECT 1 FROM whatsapp_messages older
          JOIN normalized_messages xn ON xn.whatsapp_message_id = older.id
          WHERE older.user_id = 4
            AND older.id < n.id
            AND older.created_at < $1
            AND COALESCE(NULLIF(older.content_fingerprint,''), md5(COALESCE(older.message,''))) = n.fp
        ) AS fp_seen_before_nov
      FROM nov n
    )
    SELECT
      COUNT(*)::int AS msgs,
      COUNT(DISTINCT fp)::int AS unique_fps,
      COUNT(*) FILTER (WHERE has_hit)::int AS with_hit_on_same_id,
      COUNT(*) FILTER (WHERE is_dup)::int AS dup_skip_marked,
      COUNT(*) FILTER (WHERE chars < 12)::int AS short,
      COUNT(*) FILTER (WHERE fp_seen_before_nov)::int AS unique_body_existed_before_nov,
      COUNT(*) FILTER (WHERE NOT has_hit AND has_norm AND NOT is_dup AND chars >= 12)::int AS norm_llm_but_no_hit_row_on_id
    FROM tagged
  `, [start, end]);
  console.log("===OUTCOMES===");
  console.log(JSON.stringify(outcomes.rows[0], null, 2));

  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
