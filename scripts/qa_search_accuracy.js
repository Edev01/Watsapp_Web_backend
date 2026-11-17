#!/usr/bin/env node
/**
 * Replay high-value location searches for a tenant and flag irrelevant cards.
 *
 * Usage:
 *   node scripts/qa_search_accuracy.js [userId=4]
 */
require('dotenv').config();
const http = require('http');

const userId = Number(process.argv[2] || 4);

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(process.env.PORT || 3000),
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'x-user-id': String(userId)
        }
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf) });
          } catch (e) {
            resolve({ status: res.statusCode, raw: buf.slice(0, 400) });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function propsOf(j) {
  return (
    j?.data?.properties ||
    j?.properties ||
    j?.data?.results ||
    j?.results ||
    []
  );
}

function blob(p) {
  return `${p.area || ''} ${p.vicinity || ''} ${p.city || ''} ${(p.place_tags || []).join(' ')} ${p.listing_excerpt || ''} ${p.summary || ''}`.toLowerCase();
}

function isBahria(p) {
  const b = blob(p);
  return /\b(bahria|btk|precincts?)\b/.test(b) || /(^|[^a-z0-9])p[\.\-\s]?\d{1,2}[a-z]?\b/.test(b);
}

function isDha(p) {
  const b = blob(p);
  return /\b(dha|d\.h\.a|defence|defense)\b/.test(b) || p.phase != null;
}

const CASES = [
  { name: 'dha', body: { location: 'dha', limit: 40 }, expect: (p) => !isBahria(p) || isDha(p) },
  { name: 'dha phase 8', body: { location: 'dha phase 8', limit: 40 }, expect: (p) => !isBahria(p) },
  { name: 'Bahria Town Karachi', body: { location: 'Bahria Town Karachi', limit: 40 }, expect: (p) => isBahria(p) && !(isDha(p) && !isBahria(p)) },
  {
    name: 'Bahria Town Karachi + 250 exact',
    body: { location: 'Bahria Town Karachi', areaMin: 250, areaMax: 250, areaUnit: 'Sq. Yd.', limit: 80 },
    expect: (p) => {
      if (!isBahria(p)) return false;
      if (isDha(p) && !isBahria(p)) return false;
      const n = Number(p.size_value ?? p.parsedAreaInTargetUnit);
      return Number.isFinite(n) && Math.abs(n - 250) <= 0.6;
    }
  },
  {
    name: 'Precinct 48, Road 5',
    body: { location: 'Precinct 48, Road 5', limit: 40 },
    expect: (p) => {
      const b = blob(p);
      if (!/\bprecinct\s*48\b|\bp\s*48\b/.test(b)) return false;
      return /\broad\s*5\b|\brd\.?\s*5\b/.test(b);
    }
  },
  { name: 'Precinct 48', body: { location: 'Precinct 48', limit: 40 }, expect: (p) => /\bprecinct\s*48\b|\bp\s*48\b/.test(blob(p)) },
  {
    name: 'bukhari',
    body: { location: 'bukhari', limit: 30 },
    expect: (p) => /bu?okhari|bukhari/.test(blob(p))
  },
  { name: 'phase 6', body: { location: 'phase 6', limit: 30 }, expect: (p) => !isBahria(p) },
  { name: 'phase 8', body: { location: 'phase 8', limit: 40 }, expect: (p) => !isBahria(p) },
  {
    name: 'dha phase 2',
    body: { location: 'dha phase 2', limit: 30 },
    expect: (p) => !isBahria(p)
  },
  {
    name: 'Precinct 32',
    body: { location: 'Precinct 32', limit: 30 },
    expect: (p) => /\bprecinct\s*32\b|\bp\s*32\b/.test(blob(p)) && !(isDha(p) && !isBahria(p))
  },
  {
    name: 'Ali Block',
    body: { location: 'Ali Block', limit: 30 },
    // Ali Block is BTK; area may still say Defence on legacy rows — require Ali Block text.
    expect: (p) => /ali\s*block/.test(blob(p))
  },
  {
    name: 'clifton',
    body: { location: 'clifton', limit: 20 },
    expect: (p) => /clifton/.test(blob(p))
  },
  {
    name: 'saba avenue',
    body: { location: 'saba', limit: 20 },
    expect: (p) => /saba/.test(blob(p)) && !isBahria(p)
  },
  {
    name: 'sehar',
    body: { location: 'sehar', limit: 20 },
    expect: (p) => /seh[ae]r|sahar/.test(blob(p)) && !isBahria(p)
  }
];

(async () => {
  const report = [];
  for (const c of CASES) {
    const res = await post('/api/dashboard-search', { userId, ...c.body, offset: 0 });
    const props = propsOf(res.json);
    const bad = props.filter((p) => !c.expect(p));
    const chips = res.json?.data?.phaseAreas || res.json?.phaseAreas || [];
    const chipBahria = chips.filter((x) => /bahria|btk|precinct/i.test(String(x)));
    report.push({
      case: c.name,
      status: res.status,
      total: res.json?.data?.total ?? res.json?.total ?? props.length,
      returned: props.length,
      bad: bad.length,
      badSample: bad.slice(0, 5).map((p) => ({
        id: p.id || p.listing_id,
        area: p.area,
        vicinity: p.vicinity,
        size: p.size,
        size_value: p.size_value
      })),
      chipBahria: /^(dha|phase)/i.test(c.name) ? chipBahria : []
    });
  }
  console.log(JSON.stringify({ userId, report }, null, 2));
  const fail = report.filter((r) => r.bad > 0 || (r.chipBahria && r.chipBahria.length));
  process.exit(fail.length ? 2 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
