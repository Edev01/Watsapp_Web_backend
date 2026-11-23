
require("dotenv").config();
const http = require("http");
const db = require("../db");
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname:"127.0.0.1", port:3000, path, method:"POST",
      headers:{ "Content-Type":"application/json","Content-Length":Buffer.byteLength(data),"x-user-id":"4"}
    }, res => { let b=""; res.on("data",c=>b+=c); res.on("end",()=>{ try{resolve(JSON.parse(b))}catch(e){resolve({raw:b.slice(0,400)})}})});
    req.on("error", reject); req.write(data); req.end();
  });
}
(async () => {
  const body = { userId:4, location:"Bahria Town Karachi", areaMin:250, areaMax:250, areaUnit:"Sq. Yd.", limit:200, offset:0 };
  const j = await post("/api/dashboard-search", body);
  const props = j?.data?.properties || j?.properties || j?.data?.results || j?.results || [];
  const hit13087 = props.find(p => String(p.message_id||p.whatsapp_message_id||p.id) === "13087" || String(p.id)==="37448");
  const phase8 = props.filter(p => {
    const blob = `${p.area||""} ${p.vicinity||""} ${(p.place_tags||[]).join(" ")}`.toLowerCase();
    return /\bphase\s*8\b/.test(blob) && !/\b(bahria|btk|precinct)\b/.test(blob);
  });
  const nullSize = props.filter(p => p.size_value == null && !(p.size||"").match(/250/));
  console.log(JSON.stringify({
    total: j?.data?.total ?? props.length,
    returned: props.length,
    stillHas13087: Boolean(hit13087),
    phase8DhaCount: phase8.length,
    phase8Sample: phase8.slice(0,5),
    nullSizeCount: nullSize.length,
    nullSizeSample: nullSize.slice(0,5).map(p=>({id:p.id, area:p.area, vicinity:p.vicinity, size:p.size, size_value:p.size_value}))
  }, null, 2));

  // How many P48 road 5 exist in DB vs returned
  const dbP48r5 = await db.query(`
    SELECT n.id, n.whatsapp_message_id, n.vicinity, n.size_value, LEFT(COALESCE(n.listing_excerpt,n.summary,''),100) AS ex
    FROM normalized_messages n
    JOIN whatsapp_messages m ON m.id=n.whatsapp_message_id
    WHERE m.user_id=4 AND n.is_property
      AND (
        COALESCE(n.vicinity,'') ~* 'precinct\\s*48' OR COALESCE(array_to_string(n.place_tags,' '),'') ~* '\\mP48\\M'
        OR COALESCE(n.listing_excerpt,'') ~* '\\mP\\s*48\\M' OR COALESCE(n.summary,'') ~* '\\mP\\s*48\\M'
      )
      AND (
        COALESCE(n.vicinity,'') ~* 'road\\s*5\\M' OR COALESCE(n.listing_excerpt,'') ~* 'road\\s*5\\M'
        OR COALESCE(n.listing_excerpt,'') ~* '\\mrd\\.?\\s*5\\M' OR COALESCE(n.summary,'') ~* '\\mrd\\.?\\s*5\\M'
        OR COALESCE(n.street_text,'') ~* '\\m5\\M'
      )
    ORDER BY n.id DESC LIMIT 30
  `);
  console.log("===DB_P48_ROAD5===");
  console.log(JSON.stringify(dbP48r5.rows, null, 2));

  // Search logs? check tables
  const tables = await db.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND (table_name ILIKE '%search%' OR table_name ILIKE '%log%' OR table_name ILIKE '%audit%')
    ORDER BY 1`);
  console.log("===TABLES===", tables.rows);

  process.exit(0);
})().catch(e=>{console.error(e); process.exit(1);});
