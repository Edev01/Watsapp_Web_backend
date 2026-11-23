
require("dotenv").config();
const db = require("../db");
(async () => {
  const row = await db.query(`
    SELECT n.id, n.area, n.vicinity, n.summary, n.listing_excerpt, n.location_text, n.street_text, n.place_tags,
           LOWER(CONCAT_WS(' ', n.area, n.vicinity, n.city, n.location_text, n.street_text,
             array_to_string(n.place_tags,' '), n.listing_excerpt, n.summary)) AS blob
    FROM normalized_messages n WHERE n.id IN (59213, 59456, 58885)
  `);
  for (const r of row.rows) {
    const blob = r.blob || '';
    const idx = blob.indexOf('dha');
    console.log('---', r.id, 'dha_idx', idx, 'snippet', idx>=0 ? blob.slice(Math.max(0,idx-20), idx+30) : 'NONE');
    console.log('tags', r.place_tags, 'excerpt', (r.listing_excerpt||'').slice(0,80));
  }

  // Does 59213 match dha-all via google areas?
  const { discoverDhaAreas } = require("../ai/googlePhaseMap");
  const found = await discoverDhaAreas(db);
  const areas = Array.isArray(found) ? found : (found.areas || []);
  console.log('dha_areas_count', areas.length, 'sample', areas.slice(0, 15));
  const blob = row.rows.find(x=>x.id===59213)?.blob || '';
  const hits = areas.filter(a => blob.includes(String(a).toLowerCase()));
  console.log('59213 area hits', hits.slice(0, 20));

  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
