#!/usr/bin/env node
/**
 * Empty-query dashboard search totals for a user (what FE pagination uses).
 */
require('dotenv').config();
const http = require('http');
const db = require('../db');

const userId = Number(process.argv[2] || 4);

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
  const dbCounts = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE n.is_property IS TRUE)::int AS raw_properties,
       COUNT(*) FILTER (
         WHERE n.is_property IS TRUE
           AND UPPER(COALESCE(n.property_status, 'AVAILABLE')) = 'AVAILABLE'
       )::int AS available
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE m.user_id = $1`,
    [userId]
  );

  const browse = await post('/api/dashboard-search', {
    query: '',
    limit: 20,
    offset: 0,
    status: 'AVAILABLE',
    userId
  });

  const browseNoStatus = await post('/api/dashboard-search', {
    query: '',
    limit: 20,
    offset: 0,
    userId
  });

  console.log(
    JSON.stringify(
      {
        db: dbCounts.rows[0],
        withStatusAvailable: {
          count: browse.count,
          totalMatched: browse.totalMatched,
          uniqueInPool: browse.uniqueInPool,
          results: (browse.results || []).length
        },
        noStatusFilter: {
          count: browseNoStatus.count,
          totalMatched: browseNoStatus.totalMatched,
          uniqueInPool: browseNoStatus.uniqueInPool,
          results: (browseNoStatus.results || []).length
        },
        feShown: 3811,
        gapVsAvailable: (dbCounts.rows[0].available || 0) - 3811
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
