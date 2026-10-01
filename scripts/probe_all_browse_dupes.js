#!/usr/bin/env node
/**
 * Page through empty (all) browse and check same-id / same-body duplicates.
 * Usage: node scripts/probe_all_browse_dupes.js [userId] [pageSize]
 */
require('dotenv').config();
const http = require('http');
const crypto = require('crypto');

const userId = Number(process.argv[2] || 4);
const pageSize = Math.min(Number(process.argv[3] || 500), 500);

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
        timeout: 180000
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

(async () => {
  const all = [];
  let offset = 0;
  let uniqueInPool = null;
  let totalMatched = null;
  let pages = 0;

  while (true) {
    const j = await post({
      query: '',
      limit: pageSize,
      offset,
      skipCount: pages > 0,
      status: 'AVAILABLE',
      userId
    });
    const batch = j.results || j.properties || [];
    if (uniqueInPool == null) uniqueInPool = j.uniqueInPool;
    if (totalMatched == null) totalMatched = j.totalMatched ?? j.count;
    pages += 1;
    all.push(...batch);
    if (!batch.length || batch.length < pageSize) break;
    if (uniqueInPool != null && all.length >= uniqueInPool) break;
    if (pages > 30) break;
    offset += pageSize;
  }

  const byId = new Map();
  const byBody = new Map();
  for (const r of all) {
    byId.set(r.id, (byId.get(r.id) || 0) + 1);
    const bodyKey = fp(r.raw_message || r.rawMessage || r.summary || '');
    if (!byBody.has(bodyKey)) byBody.set(bodyKey, []);
    byBody.get(bodyKey).push(r.id);
  }

  const idDups = [...byId.entries()].filter(([, n]) => n > 1);
  const bodyDups = [...byBody.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([k, ids]) => {
      const sample = all.find((r) => r.id === ids[0]);
      return {
        bodyFp: k,
        count: ids.length,
        ids: ids.slice(0, 8),
        head: String(sample?.raw_message || sample?.rawMessage || '').slice(0, 100).replace(/\s+/g, ' ')
      };
    });

  console.log(
    JSON.stringify(
      {
        query: '(empty / all browse)',
        userId,
        pages,
        collected: all.length,
        uniqueInPool,
        totalMatched,
        uniqueIds: new Set(all.map((r) => r.id)).size,
        duplicateSameId: idDups.length,
        duplicateSameBody: bodyDups.length,
        duplicateSameBodyCards: bodyDups.reduce((a, d) => a + d.count - 1, 0),
        bodyDupSamples: bodyDups.slice(0, 10)
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
