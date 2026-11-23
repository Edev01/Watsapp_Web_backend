
require("dotenv").config();
const db = require("../db");
const { parseSmartLocationQuery, textHasStreet, streetMatchText, extractStreetNumber } = require("../smartLocationSearch");
(async () => {
  console.log("extract", extractStreetNumber("Precinct 48, Road 5"));
  console.log("parsed", parseSmartLocationQuery("Precinct 48, Road 5"));
  const { rows } = await db.query(`
    SELECT n.id, n.area, n.vicinity, n.location_text, n.street_text, n.listing_excerpt, n.summary, n.place_tags, n.size_value
    FROM normalized_messages n WHERE n.id=45325`);
  const r = rows[0];
  console.log("row", r);
  console.log("streetMatchText", streetMatchText(r));
  console.log("has5", textHasStreet(streetMatchText(r), 5));
  console.log("has14", textHasStreet(streetMatchText(r), 14));

  // 42482 norms after requeue
  const n = await db.query(`SELECT listing_index, area, vicinity, is_property, LEFT(listing_excerpt,80) AS ex FROM normalized_messages WHERE whatsapp_message_id=42482 ORDER BY listing_index`);
  console.log("42482", n.rows);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
