#!/usr/bin/env node
/**
 * Probe DHA phase parent expand from local JSON (no Maps).
 * Usage: node scripts/probe_dha_phase_expand.js "Phase 5" [userId] [limit]
 */
require('dotenv').config();
const http = require('http');
const { classifyLocationQuery, isDhaPhaseParent } = require('../ai/placeRegions');

const query = process.argv[2] || 'Phase 5';
const userId = Number(process.argv[3] || 4);
const limit = Number(process.argv[4] || 30);

function post(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3000,
        path: '/api/dashboard-search',
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
  const j = await post({
    query,
    limit,
    offset: 0,
    skipCount: true,
    status: 'AVAILABLE',
    userId
  });
  const results = j.results || [];
  const samples = results.slice(0, 8).map((r) => ({
    id: r.id,
    area: r.area,
    vicinity: r.vicinity,
    place_tags: (r.place_tags || r.placeTags || []).slice(0, 8),
    head: String(r.raw_message || r.rawMessage || '').slice(0, 90).replace(/\s+/g, ' ')
  }));

  console.log(
    JSON.stringify(
      {
        query,
        classified: {
          mode: classified.mode,
          parentKey: classified.parentKey,
          isDhaPhase: isDhaPhaseParent(classified.parentKey),
          termCount: classified.terms.length,
          sampleTerms: classified.terms.slice(0, 20)
        },
        uniqueInPool: j.uniqueInPool,
        returned: results.length,
        samples
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
