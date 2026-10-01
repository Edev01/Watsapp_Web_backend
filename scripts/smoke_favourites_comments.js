#!/usr/bin/env node
/**
 * Smoke-test favourites + private comments APIs.
 * Usage: node scripts/smoke_favourites_comments.js [email] [password]
 */
require('dotenv').config();
const http = require('http');

const email = process.argv[2] || 'danish@gmail.com';
const password = process.argv[3] || 'danish123';

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
          let json = null;
          try {
            json = JSON.parse(d);
          } catch (_) {
            json = { raw: d };
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const login = await request('POST', '/api/auth/login', {
    body: { email, password }
  });
  if (!login.json?.data?.token) {
    console.error('LOGIN_FAIL', login.status, login.json);
    process.exit(1);
  }
  const token = login.json.data.token;
  const userId = login.json.data.user.id;
  console.log('login_ok', { userId, email });

  const search = await request('POST', '/api/dashboard-search', {
    token,
    body: { query: '', limit: 3, offset: 0, skipCount: true, status: 'AVAILABLE', userId }
  });
  const first = (search.json?.results || [])[0];
  if (!first?.id) {
    console.error('NO_PROPERTY', search.status, search.json);
    process.exit(1);
  }
  console.log('sample_property', {
    id: first.id,
    isFavourite: first.isFavourite,
    comments: first.comments
  });

  const fav = await request('POST', '/api/favourites', {
    token,
    body: { propertyId: first.id }
  });
  console.log('post_favourite', fav.status, {
    propertyId: fav.json?.data?.propertyId,
    isFavourite: fav.json?.data?.property?.isFavourite
  });

  const commentText = `Agent quoted last deal — smoke ${Date.now()}`;
  const cmt = await request('POST', `/api/properties/${first.id}/comments`, {
    token,
    body: { comment: commentText }
  });
  console.log('post_comment', cmt.status, cmt.json?.data);

  const favs = await request('GET', '/api/favourites', { token });
  const match = (favs.json?.data?.favourites || []).find((f) => f.id === first.id);
  console.log('get_favourites', {
    status: favs.status,
    total: favs.json?.data?.total,
    hasCard: Boolean(match),
    commentCount: match?.comments?.length || 0,
    lastComment: match?.comments?.slice(-1)[0]?.comment
  });

  const search2 = await request('POST', '/api/dashboard-search', {
    token,
    body: { query: '', limit: 20, offset: 0, skipCount: true, status: 'AVAILABLE', userId }
  });
  const again = (search2.json?.results || []).find((r) => r.id === first.id);
  console.log('search_includes_meta', {
    found: Boolean(again),
    isFavourite: again?.isFavourite,
    comments: again?.comments?.map((c) => c.comment)
  });

  console.log('ZZ_DONE');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
