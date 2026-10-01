#!/usr/bin/env node
/**
 * Quick Phase VIII quality probe against local backend.
 */
const http = require('http');

const body = JSON.stringify({
  query: 'Phase Viii',
  limit: 80,
  offset: 30,
  skipCount: true,
  sortBy: 'Newest First',
  status: 'AVAILABLE',
  userId: 4,
  user_id: 4
});

const req = http.request(
  {
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/dashboard-search',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    timeout: 60000
  },
  (res) => {
    let data = '';
    res.on('data', (c) => {
      data += c;
    });
    res.on('end', () => {
      const j = JSON.parse(data);
      const results = j.results || [];
      const sample = results.slice(0, 8).map((r) => ({
        id: r.id,
        type: r.property_type || '-',
        size: r.size || '-',
        price: r.price || '-',
        sum: String(r.summary || '').slice(0, 60)
      }));
      const junk = results.filter((r) => {
        const t = String(r.summary || '').toLowerCase();
        const thin =
          !String(r.property_type || '').trim() &&
          !String(r.size || '').trim() &&
          r.price_value == null &&
          !String(r.price || '').trim();
        return (
          thin &&
          (/location\s*phase|consultant|coral towers|prime investment/i.test(t) ||
            (String(r.summary || '').length < 85 && /phase\s*(8|viii)/i.test(t)))
        );
      });
      console.log(
        JSON.stringify(
          {
            count: j.count,
            totalMatched: j.totalMatched,
            totalReturned: j.totalReturned,
            uniqueInPool: j.uniqueInPool,
            n: results.length,
            sample,
            thin_suspect: junk.length,
            suspect0: junk[0] ? String(junk[0].summary || '').slice(0, 100) : null
          },
          null,
          2
        )
      );
    });
  }
);
req.on('error', (e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
req.write(body);
req.end();
