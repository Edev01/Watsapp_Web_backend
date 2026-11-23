
require("dotenv").config();
const db = require("../db");
(async () => {
  // Message 43310 and its listings
  const msg = await db.query(`
    SELECT m.id, m.user_id, m.chat_jid, m.sender, LEFT(m.message, 800) AS preview,
           LENGTH(m.message)::int AS chars, m.created_at, m.timestamp
    FROM whatsapp_messages m WHERE m.id = 43310`);
  console.log("===MSG===");
  console.log(JSON.stringify(msg.rows[0], null, 2));

  const norms = await db.query(`
    SELECT id, listing_index, is_property, area, vicinity, phase, place_tags,
           LEFT(COALESCE(listing_excerpt,''), 120) AS excerpt,
           LEFT(COALESCE(summary,''), 80) AS summary,
           model_used
    FROM normalized_messages WHERE whatsapp_message_id = 43310
    ORDER BY listing_index`);
  console.log("===NORMS===");
  console.log(JSON.stringify(norms.rows, null, 2));

  // Card 43321 Bahria showing on DHA search - check row
  const card = await db.query(`
    SELECT n.id, n.area, n.vicinity, n.city, n.phase, n.place_tags,
           LEFT(COALESCE(n.listing_excerpt,n.summary,''), 100) AS ex,
           m.chat_jid, c.name AS chat_name
    FROM normalized_messages n
    JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
    LEFT JOIN whatsapp_chats c ON c.user_id = m.user_id AND c.jid = m.chat_jid
    WHERE n.id = 43321`);
  console.log("===CARD43321===");
  console.log(JSON.stringify(card.rows[0], null, 2));

  // Stats for Danish
  const stats = await db.query(`
    SELECT
      (SELECT COUNT(*)::int FROM whatsapp_chats WHERE user_id=4) AS chats,
      (SELECT COUNT(*)::int FROM whatsapp_chats WHERE user_id=4 AND is_monitored) AS monitored,
      (SELECT COUNT(*)::int FROM whatsapp_messages WHERE user_id=4) AS msgs,
      (SELECT MIN(created_at) FROM whatsapp_messages WHERE user_id=4) AS first_msg,
      (SELECT MAX(created_at) FROM whatsapp_messages WHERE user_id=4) AS last_msg
  `);
  console.log("===STATS===");
  console.log(JSON.stringify(stats.rows[0], null, 2));

  process.exit(0);
})().catch(e=>{console.error(e); process.exit(1);});
