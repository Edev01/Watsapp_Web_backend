
require("dotenv").config();
const db = require("../db");
(async () => {
  // ID on card might be message id 43321
  const byMsg = await db.query(`
    SELECT n.id AS prop_id, n.whatsapp_message_id, n.area, n.vicinity, n.city, n.phase,
           n.place_tags, n.is_property, LEFT(COALESCE(n.listing_excerpt,''),100) AS ex,
           LEFT(COALESCE(m.message,''),200) AS msg,
           c.name AS chat_name
    FROM normalized_messages n
    JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
    LEFT JOIN whatsapp_chats c ON c.user_id=m.user_id AND c.jid=m.chat_jid
    WHERE n.whatsapp_message_id = 43321 OR n.id = 43321
    ORDER BY n.listing_index`);
  console.log("===BY_ID_43321===");
  console.log(JSON.stringify(byMsg.rows, null, 2));

  // Why would dha match bahria? Sample Bahria props that match %dha%
  const bleed = await db.query(`
    SELECT n.id, n.area, n.vicinity, n.place_tags,
           (LOWER(CONCAT_WS(' ', n.area, n.vicinity, n.city, n.location_text, n.street_text,
             array_to_string(n.place_tags,' '), n.listing_excerpt, n.summary)) ILIKE '%dha%') AS text_has_dha,
           (LOWER(m.message) ILIKE '%dha%') AS raw_msg_has_dha,
           LEFT(m.message, 160) AS msg
    FROM normalized_messages n
    JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
    WHERE m.user_id = 4 AND n.is_property
      AND (
        COALESCE(n.area,'') ILIKE '%bahria%'
        OR COALESCE(n.vicinity,'') ILIKE '%precinct%'
        OR COALESCE(n.area,'') ILIKE '%btk%'
        OR array_to_string(n.place_tags,' ') ILIKE '%bahria%'
        OR array_to_string(n.place_tags,' ') ILIKE '%precinct%'
      )
      AND (
        LOWER(CONCAT_WS(' ', n.area, n.vicinity, n.city, n.location_text, n.street_text,
          array_to_string(n.place_tags,' '), n.listing_excerpt, n.summary, m.message)) ILIKE '%dha%'
      )
    ORDER BY n.id DESC
    LIMIT 8
  `);
  console.log("===BAHRIA_WITH_DHA_TEXT===");
  console.log(JSON.stringify(bleed.rows, null, 2));

  // Count how many Bahria props match dha-all style filter
  const counts = await db.query(`
    WITH searchable AS (
      SELECT n.id,
        LOWER(CONCAT_WS(' ', n.area, n.vicinity, n.city, n.location_text, n.street_text,
          array_to_string(COALESCE(n.place_tags, ARRAY[]::text[]),' '),
          n.listing_excerpt, n.summary, m.message)) AS s,
        n.area, n.vicinity
      FROM normalized_messages n
      JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
      WHERE m.user_id=4 AND n.is_property
    )
    SELECT
      COUNT(*) FILTER (WHERE s ILIKE '%bahria%' OR s ILIKE '%precinct%' OR s ~* '(^|[^[:alnum:]])p[[:space:].\\-]*[0-9]{1,2}')::int AS bahria_ish,
      COUNT(*) FILTER (
        WHERE (s ILIKE '%bahria%' OR s ILIKE '%precinct%' OR vicinity ILIKE '%precinct%')
          AND (s ILIKE '%dha%' OR s ILIKE '%defence%' OR s ILIKE '%defense%')
      )::int AS bahria_and_dha_text,
      COUNT(*) FILTER (
        WHERE (s ILIKE '%bahria%' OR vicinity ILIKE '%precinct%')
          AND NOT (s ILIKE '%dha%' OR s ILIKE '%defence%' OR s ILIKE '%defense%' OR s ILIKE '%d.h.a%')
      )::int AS bahria_without_dha_text
    FROM searchable
  `);
  console.log("===COUNTS===");
  console.log(JSON.stringify(counts.rows[0], null, 2));

  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
