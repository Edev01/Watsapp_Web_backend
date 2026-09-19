#!/usr/bin/env node
/**
 * Pull distinct area/vicinity/city values from DB and verify each returns
 * at least one hit via /api/properties/filter for a given user.
 *
 * Usage: node scripts/audit_all_areas.js [userId]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const USER_ID = parseInt(process.argv[2] || '4', 10);
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:3000';
const MIN_LEN = 3;
const CONCURRENCY = 4;

async function search(q) {
  const body = JSON.stringify({
    userId: USER_ID,
    filters: { location: q, limit: 50 },
    limit: 50
  });
  const res = await fetch(`${BASE}/api/properties/filter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': String(USER_ID) },
    body
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${q}`);
  const json = await res.json();
  return (json.data && json.data.properties) || [];
}

function normalizeQuery(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

/** Skip junk / pure size / phone-like / too generic */
function shouldSkip(name) {
  const n = name.toLowerCase();
  if (n.length < MIN_LEN) return true;
  if (/^\d+(\.\d+)?$/.test(n)) return true;
  if (/^\d+\s*(marla|kanal|sq|sqft|sq\.?\s*yd|yard)/i.test(n)) return true;
  if (/^(sale|rent|wanted|available|urgent|plot|house|flat|apartment)$/i.test(n)) return true;
  if (/^0?\d{10,}$/.test(n.replace(/\D/g, ''))) return true;
  return false;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: String(process.env.DATABASE_URL || '').includes('localhost')
      ? false
      : { rejectUnauthorized: false }
  });

  // Only areas visible to this user (filter endpoint scopes by m.user_id)
  const { rows } = await pool.query(
    `
    SELECT LOWER(TRIM(name)) AS name, COUNT(*)::int AS c
    FROM (
      SELECT n.area AS name
      FROM normalized_messages n
      INNER JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
      WHERE m.user_id = $1
        AND n.area IS NOT NULL AND TRIM(n.area) <> ''
        AND (n.is_property IS TRUE OR n.purpose IS NOT NULL OR n.property_type IS NOT NULL)
      UNION ALL
      SELECT n.vicinity
      FROM normalized_messages n
      INNER JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
      WHERE m.user_id = $1
        AND n.vicinity IS NOT NULL AND TRIM(n.vicinity) <> ''
        AND (n.is_property IS TRUE OR n.purpose IS NOT NULL OR n.property_type IS NOT NULL)
      UNION ALL
      SELECT n.city
      FROM normalized_messages n
      INNER JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
      WHERE m.user_id = $1
        AND n.city IS NOT NULL AND TRIM(n.city) <> ''
        AND (n.is_property IS TRUE OR n.purpose IS NOT NULL OR n.property_type IS NOT NULL)
    ) t
    WHERE LENGTH(TRIM(name)) BETWEEN ${MIN_LEN} AND 80
    GROUP BY 1
    ORDER BY c DESC, name ASC
  `,
    [USER_ID]
  );
  await pool.end();

  const areas = rows
    .map((r) => ({ name: normalizeQuery(r.name), count: r.c }))
    .filter((r) => r.name && !shouldSkip(r.name));

  // Dedupe exact
  const seen = new Set();
  const unique = [];
  for (const a of areas) {
    if (seen.has(a.name)) continue;
    seen.add(a.name);
    unique.push(a);
  }

  console.log(JSON.stringify({ phase: 'start', userId: USER_ID, areas: unique.length }));

  const fails = [];
  const ok = [];
  const errors = [];

  await mapPool(unique, CONCURRENCY, async (area) => {
    try {
      const props = await search(area.name);
      const n = props.length;
      if (n > 0) {
        ok.push({ name: area.name, dbCount: area.count, hits: n });
        process.stdout.write('.');
      } else {
        fails.push({ name: area.name, dbCount: area.count, hits: 0 });
        process.stdout.write('X');
      }
    } catch (e) {
      errors.push({ name: area.name, error: e.message });
      process.stdout.write('!');
    }
  });

  console.log('');
  const report = {
    phase: 'done',
    userId: USER_ID,
    total: unique.length,
    ok: ok.length,
    fail: fails.length,
    error: errors.length,
    fails: fails.sort((a, b) => b.dbCount - a.dbCount),
    errors
  };
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
