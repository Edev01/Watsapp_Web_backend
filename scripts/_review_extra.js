require('dotenv').config();
const {Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL});
function redact(s){return String(s||'').replace(/(\+?92|0)?3\d{2}[-\s]?\d{7}/g,'03XX-XXXXXXX');}
(async()=>{
  const multi = await p.query(`
    SELECT m.id AS message_id, left(m.message, 1600) AS raw_message,
           COUNT(n.id)::int AS listing_count,
           json_agg(json_build_object(
             'id', n.id, 'listing_index', n.listing_index,
             'size', n.size, 'price', n.price, 'area', n.area, 'vicinity', n.vicinity,
             'is_property', n.is_property,
             'excerpt', left(COALESCE(n.listing_excerpt,n.summary,''), 180)
           ) ORDER BY COALESCE(n.listing_index,0), n.id) AS listings
    FROM whatsapp_messages m
    JOIN normalized_messages n ON n.whatsapp_message_id = m.id
    GROUP BY m.id, m.message
    HAVING COUNT(n.id) >= 2
    ORDER BY COUNT(n.id) DESC, m.id DESC
    LIMIT 12`);
  const out = { multi: multi.rows.map(r=>({...r, raw_message: redact(r.raw_message)})) };
  const explain = await p.query(`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT n.id, n.area, n.vicinity, n.place_tags
    FROM normalized_messages n
    JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
    WHERE m.user_id = 4
      AND n.is_property IS TRUE
      AND (
        COALESCE(n.area,'') || ' ' || COALESCE(n.vicinity,'') || ' ' || COALESCE(n.city,'') || ' ' ||
        COALESCE(array_to_string(n.place_tags,' '),'') || ' ' || COALESCE(m.message,'')
      ) ~* 'phase[- ]*5|phase[- ]*v\\b|ittehad|bukhari|badar|tauheed|zamzama|khadda'
    ORDER BY n.id DESC
    LIMIT 50`);
  out.explain_phase5_approx = explain.rows.map(r=>r['QUERY PLAN']);
  const compound = await p.query(`
    SELECT n.id, n.price, n.price_value, left(m.message, 500) AS raw
    FROM normalized_messages n
    JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
    WHERE n.is_property AND m.message ~* '\\d+(\\.\\d+)?\\s*crore.{0,30}\\d+(\\.\\d+)?\\s*(lakh|lac)'
    ORDER BY n.id DESC LIMIT 15`);
  out.compound_crore_lakh = compound.rows.map(r=>({...r, raw: redact(r.raw)}));
  console.log(JSON.stringify(out));
  await p.end();
})().catch(e=>{console.error(e);process.exit(1)});
