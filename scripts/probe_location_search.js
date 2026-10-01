#!/usr/bin/env node
/**
 * Probe location search relevancy + full message + uniqueness.
 * Usage: node scripts/probe_location_search.js "Malir" [userId] [limit]
 */
require('dotenv').config();
const http = require('http');
const { classifyLocationQuery } = require('../ai/placeRegions');

const query = process.argv[2] || 'Malir';
const userId = Number(process.argv[3] || 4);
const limit = Number(process.argv[4] || 40);

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

(async () => {
  const classified = classifyLocationQuery(query);
  const j = await post('/api/dashboard-search', {
    query,
    limit,
    offset: 0,
    skipCount: true,
    status: 'AVAILABLE',
    userId
  });
  const results = j.results || [];
  const ids = results.map((r) => r.id);
  const uniqueIds = new Set(ids);

  const samples = results.slice(0, 12).map((r) => ({
    id: r.id,
    area: r.area,
    vicinity: r.vicinity,
    place_tags: r.place_tags,
    raw_len: String(r.raw_message || '').length,
    raw_head: String(r.raw_message || '').slice(0, 100).replace(/\s+/g, ' ')
  }));

  console.log(
    JSON.stringify(
      {
        query,
        classified,
        uniqueInPool: j.uniqueInPool,
        returned: results.length,
        uniqueIds: uniqueIds.size,
        duplicateIds: ids.length - uniqueIds.size,
        samples
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
