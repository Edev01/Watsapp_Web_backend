
require("dotenv").config();
const db = require("../db");
const http = require("http");

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1", port: 3000, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "x-user-id": "4" }
    }, (res) => {
      let buf = "";
      res.on("data", (c) => buf += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, raw: buf.slice(0,500) }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  // 1) Bahria Town Karachi + 250-250 area
  const bahria250 = await post("/api/dashboard-search", {
    userId: 4, location: "Bahria Town Karachi", areaMin: 250, areaMax: 250, areaUnit: "Sq. Yd.", limit: 50, offset: 0
  });
  const props = bahria250.json?.data?.properties || bahria250.json?.properties || bahria250.json?.data?.results || bahria250.json?.results || [];
  const bad = props.filter((p) => {
    const blob = `${p.area||""} ${p.vicinity||""} ${p.city||""} ${(p.place_tags||[]).join(" ")} ${p.summary||""}`.toLowerCase();
    return /\bphase\s*\d/.test(blob) || (/\b(dha|defence)\b/.test(blob) && !/\b(bahria|btk|precinct)\b/.test(blob));
  });
  console.log("===BAHRIA_250===");
  console.log(JSON.stringify({
    status: bahria250.status,
    total: bahria250.json?.data?.total ?? bahria250.json?.total ?? props.length,
    returned: props.length,
    badCount: bad.length,
    badSample: bad.slice(0, 8).map((p) => ({
      id: p.id || p.listing_id, msg: p.message_id || p.whatsapp_message_id,
      area: p.area, vicinity: p.vicinity, size: p.size, size_value: p.size_value,
      tags: p.place_tags
    })),
    sampleOk: props.slice(0, 5).map((p) => ({ id: p.id||p.listing_id, area: p.area, vicinity: p.vicinity, size: p.size, size_value: p.size_value }))
  }, null, 2));

  // 2) plain dha
  const dha = await post("/api/dashboard-search", { userId: 4, location: "dha", limit: 40, offset: 0 });
  const dhaProps = dha.json?.data?.properties || dha.json?.properties || dha.json?.data?.results || dha.json?.results || [];
  const dhaBad = dhaProps.filter((p) => {
    const blob = `${p.area||""} ${p.vicinity||""} ${(p.place_tags||[]).join(" ")}`.toLowerCase();
    return /\b(bahria|btk|precinct)\b/.test(blob);
  });
  console.log("===DHA===");
  console.log(JSON.stringify({
    status: dha.status,
    total: dha.json?.data?.total ?? dha.json?.total ?? dhaProps.length,
    returned: dhaProps.length,
    bahriaBleed: dhaBad.length,
    bleedSample: dhaBad.slice(0, 6).map((p) => ({ id: p.id||p.listing_id, area: p.area, vicinity: p.vicinity, tags: p.place_tags })),
    phaseAreas: (dha.json?.data?.phaseAreas || dha.json?.phaseAreas || []).slice(0, 20)
  }, null, 2));

  // 3) Precinct 48 Road 5
  const p48 = await post("/api/dashboard-search", { userId: 4, location: "Precinct 48, Road 5", limit: 40, offset: 0 });
  const p48props = p48.json?.data?.properties || p48.json?.properties || p48.json?.data?.results || p48.json?.results || [];
  console.log("===P48_ROAD5===");
  console.log(JSON.stringify({
    status: p48.status,
    total: p48.json?.data?.total ?? p48.json?.total ?? p48props.length,
    returned: p48props.length,
    cards: p48props.map((p) => ({
      id: p.id||p.listing_id, msg: p.message_id||p.whatsapp_message_id,
      area: p.area, vicinity: p.vicinity, excerpt: (p.listing_excerpt||p.summary||"").slice(0,80)
    }))
  }, null, 2));

  // 4) google phase areas polluted with bahria?
  const poll = await db.query(`
    SELECT phase_number, area_names
    FROM google_phase_area_sets
    WHERE EXISTS (
      SELECT 1 FROM unnest(area_names) a WHERE LOWER(a) LIKE '%bahria%' OR LOWER(a) LIKE '%btk%' OR LOWER(a) LIKE '%precinct%'
    )
    ORDER BY phase_number
  `);
  console.log("===POLLUTED_PHASE_SETS===");
  console.log(JSON.stringify(poll.rows.map((r) => ({
    phase: r.phase_number,
    bad: (r.area_names||[]).filter((a) => /bahria|btk|precinct/i.test(a))
  })), null, 2));

  const places = await db.query(`
    SELECT area_key, area_name, phase_number FROM google_phase_places
    WHERE LOWER(area_name) LIKE '%bahria%' OR LOWER(area_key) LIKE '%bahria%'
    LIMIT 20
  `);
  console.log("===BAHRIA_IN_PHASE_PLACES===");
  console.log(JSON.stringify(places.rows, null, 2));

  // msg 13087
  const m = await db.query(`
    SELECT n.id, n.whatsapp_message_id, n.area, n.vicinity, n.phase, n.size, n.size_value, n.size_unit, n.place_tags,
           LEFT(COALESCE(n.listing_excerpt,n.summary,''),120) AS ex
    FROM normalized_messages n
    WHERE n.whatsapp_message_id = 13087 OR n.id = 13087
  `);
  console.log("===CARD_13087===");
  console.log(JSON.stringify(m.rows, null, 2));

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
