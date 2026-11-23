#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');
const {
  looksLikeRequirement,
  maskNonInventoryRequired,
  listingExcerptText,
} = require('../ai/extract/listingKind');

const USER = 4;
const WHY = [
  ['req_shorthand', /\breqs?\b/i],
  ['required', /\brequired\b/i],
  ['requirement', /\brequirements?\b/i],
  ['chahiye', /\bchahiye\b/i],
  ['looking_to', /\blooking\s+to\s+(?:buy|purchase|rent)\b/i],
  ['want_to', /\bwant(?:s|ed)?\s+to\s+(?:buy|purchase|rent)\b/i],
  ['looking_for_type', /\blooking\s+for\s+(?:a\s+|an\s+)?(?:plot|house|flat|apartment|bungalow|shop|office|portion|unit|property|home|villa|file)\b/i],
  ['need_type', /\bneed(?:s|ed)?\s+(?:a\s+|an\s+)?(?:plot|house|flat|apartment|bungalow|shop|office|portion|property|home)\b/i],
  ['need_number', /\bneed(?:s|ed)?\s+\d+/i],
];

(async () => {
  const { rows } = await db.query(
    `SELECT n.id, n.whatsapp_message_id, n.listing_kind, n.listing_excerpt, n.summary
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
      WHERE m.user_id = $1 AND n.is_property IS TRUE`,
    [USER]
  );
  const hits = [];
  for (const r of rows) {
    const excerpt = listingExcerptText(r);
    if (!looksLikeRequirement(null, excerpt)) continue;
    const masked = maskNonInventoryRequired(excerpt);
    const why = WHY.filter(([, re]) => re.test(masked)).map(([n]) => n);
    hits.push({
      id: r.id,
      msg: r.whatsapp_message_id,
      kind: r.listing_kind,
      why,
      excerpt: String(excerpt).replace(/\s+/g, ' ').slice(0, 220),
    });
  }
  const byWhy = {};
  for (const h of hits) {
    const key = h.why.join(',') || 'unknown';
    byWhy[key] = (byWhy[key] || 0) + 1;
  }
  console.log(JSON.stringify({ total: hits.length, byWhy }, null, 2));
  for (const h of hits) {
    console.log(`${h.msg}\t${h.id}\t${h.why.join('|')}\t${h.excerpt}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
