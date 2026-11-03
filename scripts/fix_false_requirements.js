#!/usr/bin/env node
/**
 * Count + flip Danish (user 4) listings that only have deal-term "required"
 * (commission / % / covering / renovation / profile / offer). No LLM.
 *
 *   node scripts/fix_false_requirements.js           # dry run
 *   node scripts/fix_false_requirements.js --apply
 */
require('dotenv').config();
const db = require('../db');
const {
  looksLikeRequirement,
  hasDealTermRequired,
} = require('../ai/extract/listingKind');

const APPLY = process.argv.includes('--apply');
const USER = 4;

(async () => {
  const { rows } = await db.query(
    `SELECT n.id, n.listing_kind, n.listing_excerpt, n.summary, n.is_property,
            LEFT(m.message, 400) AS preview
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
      WHERE m.user_id = $1
        AND COALESCE(n.is_property, true) = true`,
    [USER]
  );

  const dealTerm = [];
  const shownAsReq = [];
  const toFlip = [];
  for (const row of rows) {
    const excerpt = String(row.listing_excerpt || '').trim() || String(row.summary || '').trim();
    const deal = hasDealTermRequired(excerpt);
    if (deal) dealTerm.push(row);
    const shown = looksLikeRequirement(null, excerpt);
    if (deal && shown) shownAsReq.push(row);
    if (String(row.listing_kind || '').toUpperCase() === 'REQUIREMENT'
      && !looksLikeRequirement(null, excerpt)) {
      toFlip.push(row);
    }
  }

  console.log(JSON.stringify({
    user: USER,
    property_rows: rows.length,
    deal_term_required_in_excerpt: dealTerm.length,
    those_shown_as_requirement: shownAsReq.length,
    listing_kind_requirement_to_offer: toFlip.length,
    apply: APPLY,
    sample_ids: shownAsReq.slice(0, 15).map((r) => r.id),
  }));

  if (APPLY && toFlip.length) {
    const ids = toFlip.map((r) => r.id);
    const upd = await db.query(
      `UPDATE normalized_messages
          SET listing_kind = 'OFFER'
        WHERE id = ANY($1::int[])
          AND UPPER(COALESCE(listing_kind, '')) = 'REQUIREMENT'
      RETURNING id`,
      [ids]
    );
    console.log(JSON.stringify({ flipped: upd.rowCount }));
  } else if (!APPLY) {
    console.log('DRY_RUN — re-run with --apply to write OFFER');
  }
  process.exit(0);
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
