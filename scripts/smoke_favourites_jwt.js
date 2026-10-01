#!/usr/bin/env node
/**
 * Smoke-test favourites + comments using a locally signed JWT (no password needed).
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const db = require('../db');
const http = require('http');

function request(method, path, { token, body } = {}) {
  const payload = body != null ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3000,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(d) });
          } catch (_) {
            resolve({ status: res.statusCode, json: { raw: d } });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const tables = await db.query(
    `SELECT to_regclass('public.property_favourites') AS fav,
            to_regclass('public.property_comments') AS cmt`
  );
  console.log('tables', tables.rows[0]);

  const userRes = await db.query(
    `SELECT id, email, role FROM users
     WHERE id = 4 OR email ILIKE '%danish%'
     ORDER BY id LIMIT 1`
  );
  const u = userRes.rows[0];
  if (!u) throw new Error('Danish user not found');
  console.log('user', u);

  const token = jwt.sign(
    { id: u.id, email: u.email, role: u.role },
    process.env.JWT_SECRET || 'super_secret_jwt_key_123!',
    { expiresIn: '1h' }
  );

  const prop = await db.query(
    `SELECT n.id
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE m.user_id = $1 AND n.is_property IS TRUE
     ORDER BY n.id DESC LIMIT 1`,
    [u.id]
  );
  const propertyId = prop.rows[0]?.id;
  if (!propertyId) throw new Error('No property found');
  console.log('propertyId', propertyId);

  const fav = await request('POST', '/api/favourites', {
    token,
    body: { propertyId }
  });
  console.log('post_favourite', fav.status, fav.json?.message, fav.json?.data?.propertyId);

  const cmt = await request('POST', `/api/properties/${propertyId}/comments`, {
    token,
    body: { comment: `Agent quoted 2.15 crore last deal — smoke ${Date.now()}` }
  });
  console.log('post_comment', cmt.status, cmt.json?.data);

  const list = await request('GET', '/api/favourites', { token });
  const match = (list.json?.data?.favourites || []).find((f) => f.id === propertyId);
  console.log('get_favourites', list.status, {
    total: list.json?.data?.total,
    comments: match?.comments?.length,
    sample: match?.comments?.slice(-1)[0]?.comment
  });

  const search = await request('POST', '/api/dashboard-search', {
    token,
    body: {
      query: '',
      limit: 5,
      offset: 0,
      skipCount: true,
      status: 'AVAILABLE',
      userId: u.id
    }
  });
  const again = (search.json?.results || []).find((r) => r.id === propertyId);
  console.log('search_meta', {
    found: Boolean(again),
    isFavourite: again?.isFavourite,
    comments: again?.comments?.map((c) => c.comment)
  });

  console.log('ZZ_DONE');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
