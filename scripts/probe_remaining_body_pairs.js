#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');
const { normalizeFingerprintText } = require('../contentFingerprint');

const pairs = [
  [29808, 29481],
  [29657, 29656],
  [29424, 28087],
  [29042, 28941],
  [28349, 18293],
  [27781, 787]
];

(async () => {
  const ids = pairs.flat();
  const r = await db.query(
    `SELECT n.id, n.listing_index, n.summary, LEFT(COALESCE(n.listing_excerpt,''), 120) AS excerpt,
            LEFT(COALESCE(m.message,''), 200) AS raw,
            LENGTH(COALESCE(m.message,'')) AS raw_len
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE n.id = ANY($1::int[])`,
    [ids]
  );
  const byId = Object.fromEntries(r.rows.map((x) => [x.id, x]));
  for (const [a, b] of pairs) {
    const A = byId[a];
    const B = byId[b];
    const na = normalizeFingerprintText(A?.raw || A?.excerpt || A?.summary || '').slice(0, 400);
    const nb = normalizeFingerprintText(B?.raw || B?.excerpt || B?.summary || '').slice(0, 400);
    console.log({
      a,
      b,
      sameNorm: na === nb,
      na: na.slice(0, 120),
      nb: nb.slice(0, 120),
      rawA: String(A?.raw || '').slice(0, 100),
      rawB: String(B?.raw || '').slice(0, 100)
    });
  }
  console.log('ZZ_DONE');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
