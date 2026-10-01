#!/usr/bin/env node
const http = require('http');

function post(body) {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3000,
        path: '/api/dashboard-search',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(b)
        },
        timeout: 60000
      },
      (res) => {
        let d = '';
        res.on('data', (c) => {
          d += c;
        });
        res.on('end', () => resolve(JSON.parse(d)));
      }
    );
    req.on('error', reject);
    req.write(b);
    req.end();
  });
}

function thinRows(results) {
  return (results || []).filter(
    (r) =>
      !String(r.property_type || '').trim() &&
      !String(r.size || '').trim() &&
      !String(r.price || '').trim()
  );
}

(async () => {
  for (const [label, body] of [
    ['off0', { query: 'Phase Viii', limit: 80, offset: 0, skipCount: true, status: 'AVAILABLE', userId: 4 }],
    ['off30', { query: 'Phase Viii', limit: 80, offset: 30, skipCount: true, status: 'AVAILABLE', userId: 4 }],
    ['countOn', { query: 'Phase Viii', limit: 20, offset: 0, skipCount: false, status: 'AVAILABLE', userId: 4 }]
  ]) {
    const j = await post(body);
    const thin = thinRows(j.results);
    console.log(
      label,
      JSON.stringify({
        count: j.count,
        returned: j.totalReturned,
        unique: j.uniqueInPool,
        thin: thin.length,
        thinSamples: thin.slice(0, 6).map((t) => String(t.summary || '').slice(0, 70))
      })
    );
  }
  console.log('DONE_TEST');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
