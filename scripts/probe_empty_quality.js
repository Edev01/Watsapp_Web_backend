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
        timeout: 180000
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

(async () => {
  // Pull a large page from offset 0 by paging through unique pool reported
  const page = await post({
    limit: 100,
    offset: 0,
    skipCount: true,
    sortBy: 'Newest First',
    status: 'AVAILABLE',
    userId: 4
  });
  const pool = page.uniqueInPool;
  console.log('pool', pool, 'count', page.count);

  const all = [];
  for (let offset = 0; offset < pool; offset += 100) {
    const j = await post({
      limit: 100,
      offset,
      skipCount: true,
      sortBy: 'Newest First',
      status: 'AVAILABLE',
      userId: 4
    });
    all.push(...(j.results || []));
    if (!(j.results || []).length) break;
    // pool can grow with offset — use max
    if (j.uniqueInPool > pool) {
      // continue until empty
    }
  }

  const ids = new Set(all.map((r) => r.id));
  const withSignal = all.filter(
    (r) =>
      String(r.property_type || '').trim() ||
      String(r.size || '').trim() ||
      String(r.price || '').trim()
  );
  const thin = all.length - withSignal.length;
  console.log(
    JSON.stringify({
      fetchedCards: all.length,
      uniqueIds: ids.size,
      withTypeSizeOrPrice: withSignal.length,
      thin: thin,
      sampleThin: all
        .filter(
          (r) =>
            !String(r.property_type || '').trim() &&
            !String(r.size || '').trim() &&
            !String(r.price || '').trim()
        )
        .slice(0, 5)
        .map((r) => String(r.summary || '').slice(0, 70))
    })
  );
  console.log('DONE_TEST');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
