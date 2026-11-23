
require("dotenv").config();
const db = require("../db");
(async () => {
  // Find the Taqi Zaidi multi-listing from the video
  const rows = await db.query(`
    SELECT m.id, LEFT(m.message, 250) AS msg,
           (SELECT json_agg(json_build_object('nid', n.id, 'idx', n.listing_index, 'area', n.area, 'vicinity', n.vicinity, 'is_property', n.is_property, 'ex', LEFT(COALESCE(n.listing_excerpt,''),80)) ORDER BY n.listing_index)
            FROM normalized_messages n WHERE n.whatsapp_message_id=m.id) AS norms
    FROM whatsapp_messages m
    WHERE m.user_id=4
      AND (m.message ILIKE '%TAQI ZAIDI%' OR m.message ILIKE '%0324-827-4073%' OR m.message ILIKE '%03248274073%'
           OR (m.message ILIKE '%Ali Block%' AND m.message ILIKE '%P16%' AND m.message ILIKE '%1100%'))
    ORDER BY m.id DESC LIMIT 5
  `);
  console.log(JSON.stringify(rows.rows, null, 2));

  // PM2 / nginx search hints
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
