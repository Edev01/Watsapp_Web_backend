#!/usr/bin/env node
/**
 * Probe dashboard-search for "Khayaban" and classify match quality.
 */
require('dotenv').config();
const http = require('http');

const query = process.argv[2] || 'Khayaban';
const userId = Number(process.argv[3] || 4);
const limit = Number(process.argv[4] || 80);

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
        timeout: 90000
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
  /\b(khayaban|khyaban|khybn|khaybn|khayabn|khayban|khyabn|khayaben|kh[\s.-]*e[\s.-]+[a-z])/i;

function classify(r) {
  const area = String(r.area || '');
  const vicinity = String(r.vicinity || '');
  const city = String(r.city || '');
  const summary = String(r.summary || '');
  const raw = String(r.raw_message || '');
  const structured = `${area} ${vicinity} ${city} ${summary}`;
  const all = `${structured} ${raw}`;

  const inArea = KHAY_RE.test(area);
  const inVicinity = KHAY_RE.test(vicinity);
  const inSummary = KHAY_RE.test(summary);
  const inRaw = KHAY_RE.test(raw);
  const inStructured = KHAY_RE.test(structured);

  let bucket = 'ok_structured';
  if (!inStructured && inRaw) bucket = 'raw_only_maybe_footer';
  if (!inStructured && !inRaw) bucket = 'no_khayaban_anywhere';
  if (inArea || inVicinity) bucket = 'ok_place_fields';

  return {
    id: r.id,
    bucket,
    area,
    vicinity,
    city,
    property_type: r.property_type,
    size: r.size,
    price: r.price,
    summary: summary.slice(0, 100),
    raw_snip: raw.slice(0, 140).replace(/\s+/g, ' '),
    flags: { inArea, inVicinity, inSummary, inRaw }
  };
}

(async () => {
  const j = await post('/api/dashboard-search', {
    query,
    limit,
    offset: 0,
    skipCount: true,
    status: 'AVAILABLE',
    userId
  });

  const results = j.results || [];
  const classified = results.map(classify);
  const counts = {};
  for (const c of classified) {
    counts[c.bucket] = (counts[c.bucket] || 0) + 1;
  }

  const bad = classified.filter((c) =>
    ['raw_only_maybe_footer', 'no_khayaban_anywhere'].includes(c.bucket)
  );

  // Group place_fields by area/vicinity for top locations
  const placeOk = classified.filter((c) => c.bucket === 'ok_place_fields');
  const locFreq = {};
  for (const c of placeOk) {
    const key = [c.area, c.vicinity].filter(Boolean).join(' | ') || '(empty)';
    locFreq[key] = (locFreq[key] || 0) + 1;
  }
  const topLocs = Object.entries(locFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  console.log(
    JSON.stringify(
      {
        query,
        uniqueInPool: j.uniqueInPool,
        returned: results.length,
        counts,
        top_place_locations: topLocs,
        bad_samples: bad.slice(0, 25),
        ok_samples: placeOk.slice(0, 8)
      },
      null,
      2
    )
  );
  console.log('ZZ_DONE');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
