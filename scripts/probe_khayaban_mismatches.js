#!/usr/bin/env node
/**
 * Find Khayaban search hits where structured place ≠ raw message location.
 */
require('dotenv').config();
const http = require('http');
const db = require('../db');

const query = process.argv[2] || 'Khayaban';
const userId = Number(process.argv[3] || 4);

function post(path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3000,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-user-id': String(userId)
        },
        timeout: 120000
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const KHAY_RE =
  /\b(khayaban|khyaban|khybn|khaybn|khayabn|khayban|khyabn|khayaben|kheyaban|khyb)\b/i;

(async () => {
  const j = await post('/api/dashboard-search', {
    query,
    limit: 200,
    offset: 0,
    skipCount: true,
    status: 'AVAILABLE',
    userId
  });
  const results = j.results || [];

  const mismatches = [];
  const weak = [];

  for (const r of results) {
    const area = String(r.area || '');
    const vicinity = String(r.vicinity || '');
    const raw = String(r.raw_message || '');
    const summary = String(r.summary || '');
    const place = `${area} ${vicinity}`.trim();
    const rawHas = KHAY_RE.test(raw) || KHAY_RE.test(summary);
    const placeHas = KHAY_RE.test(place);

    // Structured says khayaban but message body does not
    if (placeHas && !rawHas) {
      mismatches.push({
        id: r.id,
        area,
        vicinity,
        city: r.city,
        size: r.size,
        price: r.price,
        summary: summary.slice(0, 120),
        raw: raw.slice(0, 180).replace(/\s+/g, ' ')
      });
    }

    // Bare area "khayaban" with no street — weak extraction
    if (/^khayaban$/i.test(area.trim()) && !KHAY_RE.test(vicinity)) {
      weak.push({
        id: r.id,
        area,
        vicinity,
        summary: summary.slice(0, 100),
        raw: raw.slice(0, 140).replace(/\s+/g, ' ')
      });
    }
  }

  // Also sample a couple specific wrong ones from DB full message
  const sampleIds = mismatches.slice(0, 8).map((m) => m.id);
  let fullMsgs = [];
  if (sampleIds.length) {
    const q = await db.query(
      `SELECT n.id, n.area, n.vicinity, n.city, n.summary,
              LEFT(m.message, 400) AS full_msg
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
       WHERE n.id = ANY($1::int[])`,
      [sampleIds]
    );
    fullMsgs = q.rows;
  }

  // Parse what the search thinks "Khayaban" means
  let parsed = null;
  try {
    const { parseSmartLocationQuery } = require('../smartLocationSearch');
    parsed = parseSmartLocationQuery(query);
  } catch (_) {}

  console.log(
    JSON.stringify(
      {
        query,
        uniqueInPool: j.uniqueInPool,
        returned: results.length,
        mismatch_count_in_page: mismatches.length,
        weak_bare_khayaban_count: weak.length,
        mismatch_samples: mismatches.slice(0, 15),
        weak_samples: weak.slice(0, 8),
        full_msg_samples: fullMsgs,
        parsed_query: parsed
          ? {
              mustGroups: parsed.mustGroups,
              placeOnlyGroups: (parsed.placeOnlyGroups || []).map((g) => g.slice(0, 8)),
              searchRegexes: (parsed.searchRegexes || []).map(String)
            }
          : null
      },
      null,
      2
    )
  );
  console.log('ZZ_DONE');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
