
require("dotenv").config();
const db = require("../db");
(async () => {
  const norms = await db.query(`
    SELECT id, listing_index, is_property, area, vicinity, LEFT(COALESCE(listing_excerpt,''),100) AS ex
    FROM normalized_messages WHERE whatsapp_message_id=43310 ORDER BY listing_index`);
  console.log(JSON.stringify(norms.rows, null, 2));
  const job = await db.query(`SELECT status, processed_this_run, last_error FROM normalize_jobs WHERE user_id=4`);
  console.log("job", job.rows[0]);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
