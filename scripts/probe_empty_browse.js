#!/usr/bin/env node
/**
 * Probe empty browse search (no query) for Danish.
 */
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
        timeout: 120000
      },
      (res) => {
        let d = '';
        res.on('data', (c) => {
          d += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(new Error(d.slice(0, 300)));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(b);
    req.end();
  });
}

(async () => {
  const cases = [
    { label: 'empty_off0_l100', body: { limit: 100, offset: 0, skipCount: true, sortBy: 'Newest First', status: 'AVAILABLE', userId: 4 } },
    { label: 'empty_off190_l100', body: { limit: 100, offset: 190, skipCount: true, sortBy: 'Newest First', status: 'AVAILABLE', userId: 4 } },
    { label: 'empty_off190_l200', body: { limit: 200, offset: 190, skipCount: true, sortBy: 'Newest First', status: 'AVAILABLE', userId: 4 } },
    { label: 'empty_off280_l100', body: { limit: 100, offset: 280, skipCount: true, sortBy: 'Newest First', status: 'AVAILABLE', userId: 4 } },
    { label: 'empty_off400_l100', body: { limit: 100, offset: 400, skipCount: true, sortBy: 'Newest First', status: 'AVAILABLE', userId: 4 } },
    { label: 'empty_countOn', body: { limit: 50, offset: 0, skipCount: false, sortBy: 'Newest First', status: 'AVAILABLE', userId: 4 } }
  ];

  for (const c of cases) {
    const j = await post(c.body);
    const ids = (j.results || []).map((r) => r.id);
    console.log(
      c.label,
      JSON.stringify({
        count: j.count,
        totalMatched: j.totalMatched,
        totalReturned: j.totalReturned,
        uniqueInPool: j.uniqueInPool,
        limit: j.limit,
        offset: j.offset,
        firstId: ids[0] || null,
        lastId: ids[ids.length - 1] || null
      })
    );
  }
  console.log('DONE_TEST');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
