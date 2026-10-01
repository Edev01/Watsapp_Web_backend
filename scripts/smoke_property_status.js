#!/usr/bin/env node
require('dotenv').config();
const jwt = require('jsonwebtoken');
const db = require('../db');
const http = require('http');

function req(method, path, { token, body } = {}) {
  const payload = body != null ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const r = http.request(
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
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  const u = (await db.query('SELECT id, email, role FROM users WHERE id=4')).rows[0];
  const token = jwt.sign(
    { id: u.id, email: u.email, role: u.role },
    process.env.JWT_SECRET || 'super_secret_jwt_key_123!',
    { expiresIn: '1h' }
  );

  const prop = (
    await db.query(
      `SELECT n.id, n.whatsapp_message_id, n.property_status
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
       WHERE m.user_id = 4 AND n.is_property IS TRUE
       ORDER BY n.id DESC LIMIT 1`
    )
  ).rows[0];
  console.log('target', prop);

  const next = String(prop.property_status || '').toUpperCase() === 'SOLD' ? 'AVAILABLE' : 'SOLD';
  const byListing = await req('PATCH', `/api/properties/${prop.id}/status`, {
    token,
    body: { status: next }
  });
  console.log('by_listing_id', byListing.status, byListing.json?.message, {
    propertyId: byListing.json?.data?.propertyId,
    status: byListing.json?.data?.status
  });

  const byMsg = await req('PATCH', `/api/properties/${prop.whatsapp_message_id}/status`, {
    token,
    body: { status: prop.property_status || 'AVAILABLE' }
  });
  console.log('by_message_id', byMsg.status, byMsg.json?.message, {
    propertyId: byMsg.json?.data?.propertyId,
    status: byMsg.json?.data?.status
  });

  const missing = await req('PATCH', '/api/properties/999999999/status', {
    token,
    body: { status: 'SOLD' }
  });
  console.log('missing', missing.status, missing.json?.message);
  console.log('ZZ_DONE');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
