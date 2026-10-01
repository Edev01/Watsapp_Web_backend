#!/usr/bin/env node
/**
 * Check location search results for near-duplicate cards.
 * Usage: node scripts/probe_search_dupes.js "Phase 8" [userId] [limit]
 */
require('dotenv').config();
const http = require('http');
const crypto = require('crypto');

const query = process.argv[2] || 'Phase 8';
const userId = Number(process.argv[3] || 4);
const limit = Number(process.argv[4] || 100);

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

function normBody(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
}

function fp(s) {
  return crypto.createHash('sha1').update(normBody(s)).digest('hex').slice(0, 12);
}

function softKey(r) {
  const size = String(r.size || '').toLowerCase().replace(/\s+/g, '');
  const price = String(r.price || '').toLowerCase().replace(/\s+/g, '');
  const area = String(r.area || '').toLowerCase().trim();
  const type = String(r.property_type || '').toLowerCase().trim();
  const purpose = String(r.purpose || '').toLowerCase().trim();
  return [purpose, type, size, price, area].join('|');
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

  const byId = new Map();
  const byBody = new Map();
  const bySoft = new Map();

  for (const r of results) {
    byId.set(r.id, (byId.get(r.id) || 0) + 1);
    const bodyKey = fp(r.raw_message || r.summary || '');
    if (!byBody.has(bodyKey)) byBody.set(bodyKey, []);
    byBody.get(bodyKey).push(r.id);

    const sk = softKey(r);
    if (sk.replace(/\|/g, '').length >= 8) {
      if (!bySoft.has(sk)) bySoft.set(sk, []);
      bySoft.get(sk).push(r.id);
    }
  }

  const idDups = [...byId.entries()].filter(([, n]) => n > 1);
  const bodyDups = [...byBody.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([k, ids]) => ({ bodyFp: k, count: ids.length, ids: ids.slice(0, 8) }));
  const softDups = [...bySoft.entries()]
    .filter(([, ids]) => new Set(ids).size > 1 && ids.length > 1)
    .map(([k, ids]) => ({ softKey: k, count: ids.length, ids: [...new Set(ids)].slice(0, 8) }))
    .slice(0, 15);

  const bodyDupSamples = bodyDups.slice(0, 5).map((d) => {
    const sample = results.find((r) => r.id === d.ids[0]);
    return {
      ...d,
      area: sample?.area,
      vicinity: sample?.vicinity,
      size: sample?.size,
      price: sample?.price,
      head: String(sample?.raw_message || '').slice(0, 120).replace(/\s+/g, ' ')
    };
  });

  console.log(
    JSON.stringify(
      {
        query,
        uniqueInPool: j.uniqueInPool,
        returned: results.length,
        uniqueIds: new Set(results.map((r) => r.id)).size,
        duplicateSameId: idDups.length,
        duplicateSameBody: bodyDups.length,
        duplicateSameBodyCards: bodyDups.reduce((a, d) => a + d.count - 1, 0),
        softLookalikeGroups: softDups.length,
        bodyDupSamples,
        softDupSamples: softDups.slice(0, 8)
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
