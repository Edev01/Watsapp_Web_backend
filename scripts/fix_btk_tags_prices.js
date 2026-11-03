#!/usr/bin/env node
/** Rewrite BTK place_tags from listing excerpt only, fill @ prices. No LLM. */
require('dotenv').config();
const db = require('../db');
const { applyBtkListing, listingPrecincts, interpretBtkSearch, btkSearchKeeps } = require('../ai/btkPrecincts');
const { parsePrice } = require('../ai/extract/parsers');

const APPLY = process.argv.includes('--apply');
const USER = 4;

(async () => {
  const { rows } = await db.query(
    `SELECT n.id, n.listing_excerpt, n.vicinity, n.location_text, n.area, n.place_tags,
            n.property_type, n.price, n.price_value, n.size_value, n.size, n.size_unit,
            n.phase, n.phase_max, n.is_property, n.purpose
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
      WHERE m.user_id = $1 AND n.is_property IS TRUE
        AND (
          n.area ILIKE '%bahria%'
          OR COALESCE(array_to_string(n.place_tags, ' '), '') ILIKE '%btk%'
          OR COALESCE(n.listing_excerpt, '') ~* '(btk|bahria|precinct|\\mp[0-9]{1,2})'
        )`,
    [USER]
  );

  let retagged = 0;
  let priced = 0;
  const leakBefore = { p10: 0, other: 0 };
  const parsed10 = {
    regionMode: 'btk-parent',
    precinct: '10',
    btkPrecincts: ['10A', '10B'],
  };
  for (const row of rows) {
    if (btkSearchKeeps(row, parsed10)) leakBefore.p10 += 1;
  }

  const updates = [];
  for (const row of rows) {
    const next = applyBtkListing({
      ...row,
      is_property: true,
      place_tags: Array.isArray(row.place_tags) ? row.place_tags.slice() : [],
    }, row.listing_excerpt || '');
    const codes = listingPrecincts(next);
    let price = row.price;
    let priceValue = row.price_value;
    if (priceValue == null && /@\s*\d/.test(String(row.listing_excerpt || ''))) {
      const parsed = parsePrice(row.listing_excerpt, { purpose: row.purpose });
      if (parsed.value) {
        priceValue = parsed.value;
        price = (String(row.listing_excerpt).match(/@\s*\d+(?:\.\d+)?(?:\s*(?:cr|crore|lac|lakh))?/i) || [])[0] || price;
        priced += 1;
      }
    }
    const tagsChanged = JSON.stringify(next.place_tags || []) !== JSON.stringify(row.place_tags || []);
    const priceChanged = priceValue != null && Number(priceValue) !== Number(row.price_value);
    if (tagsChanged) retagged += 1;
    if (tagsChanged || priceChanged) {
      updates.push({
        id: row.id,
        place_tags: next.place_tags,
        vicinity: next.vicinity || row.vicinity,
        area: next.area || row.area,
        phase: next.phase,
        price,
        price_value: priceValue,
        codes,
      });
    }
  }

  let leakAfter = 0;
  if (APPLY && updates.length) {
    for (const u of updates) {
      await db.query(
        `UPDATE normalized_messages
            SET place_tags = $2::text[],
                vicinity = COALESCE($3, vicinity),
                area = COALESCE($4, area),
                phase = $5,
                price = COALESCE($6, price),
                price_value = COALESCE($7, price_value)
          WHERE id = $1`,
        [u.id, u.place_tags, u.vicinity, u.area, u.phase, u.price, u.price_value]
      );
    }
    const after = await db.query(
      `SELECT n.id, n.listing_excerpt, n.vicinity, n.location_text, n.place_tags, n.area
         FROM normalized_messages n
         JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
        WHERE m.user_id = $1 AND n.is_property IS TRUE AND n.id = ANY($2::int[])`,
      [USER, updates.map((u) => u.id)]
    );
    leakAfter = after.rows.filter((r) => btkSearchKeeps(r, parsed10)).length;
  }

  console.log(JSON.stringify({
    scanned: rows.length,
    retagged,
    priced,
    would_write: updates.length,
    apply: APPLY,
    precinct10_keep_before: leakBefore.p10,
  }));
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
