
require("dotenv").config();
const db = require("../db");
const { SYSTEM_PROMPT, EXTRACTION_SCHEMA, buildUserMessage } = require("../ai/extract/schema");

(async () => {
  const schemaNote = "Return one JSON object only (no markdown). Schema:\n" + JSON.stringify(EXTRACTION_SCHEMA);
  const systemFull = SYSTEM_PROMPT + "\n\n" + schemaNote;
  const sampleUser = buildUserMessage("x".repeat(398), { sender: "Agent" });
  const medianUser = buildUserMessage("x".repeat(191), { sender: "Agent" });
  const approxTok = (s) => Math.ceil(String(s).length / 4);

  console.log(JSON.stringify({
    systemChars: systemFull.length,
    systemTokApprox: approxTok(systemFull),
    promptOnlyChars: SYSTEM_PROMPT.length,
    schemaNoteChars: schemaNote.length,
    avgMsgUserTokApprox: approxTok(sampleUser),
    medianMsgUserTokApprox: approxTok(medianUser),
    avgInputTokApprox: approxTok(systemFull) + approxTok(sampleUser),
    medianInputTokApprox: approxTok(systemFull) + approxTok(medianUser)
  }, null, 2));

  const mon = await db.query(
    `SELECT c.jid, c.name, c.monitor_letter,
            COUNT(m.id)::int AS total_msgs
     FROM whatsapp_chats c
     LEFT JOIN whatsapp_messages m ON m.user_id=c.user_id AND m.chat_jid=c.jid
     WHERE c.user_id=4 AND c.is_monitored
     GROUP BY c.jid, c.name, c.monitor_letter
     ORDER BY total_msgs DESC`
  );
  console.log("===MON_CHATS===");
  console.log(JSON.stringify(mon.rows, null, 2));

  const outEst = await db.query(`
    SELECT COUNT(*)::int AS n,
           ROUND(AVG(
             LENGTH(COALESCE(n.summary,'')) + LENGTH(COALESCE(n.area,'')) + LENGTH(COALESCE(n.vicinity,''))
             + LENGTH(COALESCE(n.city,'')) + LENGTH(COALESCE(n.price,'')) + LENGTH(COALESCE(n.size,''))
             + LENGTH(COALESCE(n.purpose,'')) + LENGTH(COALESCE(n.property_type,''))
             + LENGTH(COALESCE(n.listing_excerpt,''))
           )::numeric, 0) AS avg_field_chars,
           ROUND(AVG(listings_per_msg)::numeric, 2) AS avg_listings_per_msg
    FROM (
      SELECT m.id,
             COUNT(n.id) FILTER (WHERE n.is_property) AS listings_per_msg
      FROM openai_api_hits h
      JOIN whatsapp_messages m ON m.id = h.message_id
      LEFT JOIN normalized_messages n ON n.whatsapp_message_id = m.id
      WHERE h.user_id = 4 AND h.ok
      GROUP BY m.id
    ) x
    JOIN normalized_messages n ON n.whatsapp_message_id = x.id
  `);
  console.log("===OUT_EST===");
  console.log(JSON.stringify(outEst.rows[0], null, 2));

  const joinQ = await db.query(`
    SELECT
      COUNT(*)::int AS hits,
      COUNT(h.message_id)::int AS with_msg_id,
      COUNT(m.id)::int AS joined_msgs,
      COUNT(DISTINCT h.message_id)::int AS distinct_msg_ids
    FROM openai_api_hits h
    LEFT JOIN whatsapp_messages m ON m.id = h.message_id
    WHERE h.user_id = 4
  `);
  console.log("===JOINQ===");
  console.log(JSON.stringify(joinQ.rows[0], null, 2));

  const recent = await db.query(`
    WITH msg AS (
      SELECT m.chat_jid,
             COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,''))) AS fp,
             ((m.created_at AT TIME ZONE 'Asia/Karachi')::date) AS pkt_day
      FROM whatsapp_messages m
      JOIN whatsapp_chats c ON c.user_id=m.user_id AND c.jid=m.chat_jid AND c.is_monitored
      WHERE m.user_id=4
        AND m.created_at >= (NOW() - INTERVAL '7 days')
        AND EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id=m.id)
    ),
    per AS (
      SELECT chat_jid, pkt_day, COUNT(DISTINCT fp)::int AS u
      FROM msg GROUP BY 1,2
    )
    SELECT c.name, p.chat_jid,
           COUNT(*)::int AS days,
           ROUND(AVG(u)::numeric,1) AS avg_unique_norm_per_day,
           ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY u)::numeric,1) AS median
    FROM per p
    JOIN whatsapp_chats c ON c.user_id=4 AND c.jid=p.chat_jid
    GROUP BY c.name, p.chat_jid
    ORDER BY avg_unique_norm_per_day DESC
  `);
  console.log("===RECENT7===");
  console.log(JSON.stringify(recent.rows, null, 2));

  const recentOverall = await db.query(`
    WITH msg AS (
      SELECT m.chat_jid,
             COALESCE(NULLIF(m.content_fingerprint,''), md5(COALESCE(m.message,''))) AS fp,
             ((m.created_at AT TIME ZONE 'Asia/Karachi')::date) AS pkt_day
      FROM whatsapp_messages m
      JOIN whatsapp_chats c ON c.user_id=m.user_id AND c.jid=m.chat_jid AND c.is_monitored
      WHERE m.user_id=4
        AND m.created_at >= (NOW() - INTERVAL '7 days')
        AND EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id=m.id)
    ),
    per AS (
      SELECT chat_jid, pkt_day, COUNT(DISTINCT fp)::int AS u
      FROM msg GROUP BY 1,2
    )
    SELECT ROUND(AVG(u)::numeric,1) AS avg_per_group_day,
           ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY u)::numeric,1) AS median_per_group_day,
           ROUND((SUM(u)::numeric/NULLIF(COUNT(DISTINCT pkt_day),0)),1) AS avg_all_groups_day
    FROM per
  `);
  console.log("===RECENT7_OVERALL===");
  console.log(JSON.stringify(recentOverall.rows[0], null, 2));

  // Steady-state: hits last 7 days only
  const hit7 = await db.query(`
    SELECT COUNT(*)::int AS hits,
           COUNT(DISTINCT message_id)::int AS msgs,
           COUNT(DISTINCT ((hit_at AT TIME ZONE 'Asia/Karachi')::date))::int AS days,
           ROUND((COUNT(*)::numeric / NULLIF(COUNT(DISTINCT ((hit_at AT TIME ZONE 'Asia/Karachi')::date)),0)),1) AS avg_hits_day
    FROM openai_api_hits
    WHERE user_id=4 AND hit_at >= NOW() - INTERVAL '7 days'
  `);
  console.log("===HITS7===");
  console.log(JSON.stringify(hit7.rows[0], null, 2));

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
