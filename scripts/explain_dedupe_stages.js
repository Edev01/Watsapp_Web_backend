#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');
const { filterAndSortProperties } = require('../propertyHelper');
const {
  normalizeFingerprintText,
  listingContentFingerprint
} = require('../contentFingerprint');

(async () => {
  const userId = Number(process.argv[2] || 4);
  const r = await db.query(
    `SELECT n.id, n.whatsapp_message_id, n.chat_jid, n.purpose, n.city, n.area, n.vicinity,
            n.property_type, n.property_sub_type, n.size, n.price, n.contact_number,
            n.summary, n.property_status, n.created_at, n.category, n.intent, n.sentiment,
            n.listing_index, n.listing_excerpt,
            LEFT(COALESCE(NULLIF(TRIM(n.listing_excerpt), ''), m.message), 500) AS raw_message,
            m.timestamp AS message_timestamp, m.from_me, m.user_id, m.seq_in_chat
     FROM normalized_messages n
     JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE m.user_id = $1
       AND n.is_property IS TRUE
       AND UPPER(COALESCE(n.property_status, 'AVAILABLE')) = 'AVAILABLE'
     ORDER BY n.id DESC`,
    [userId]
  );

  const raw = r.rows.length;
  const byMsg = new Set(r.rows.map((x) => x.whatsapp_message_id));

  // Content fingerprint only (same ad text → one)
  const seenFp = new Set();
  let uniqueByContent = 0;
  let contentDupRows = 0;
  for (const row of r.rows) {
    const fp =
      listingContentFingerprint({
        listing_excerpt: row.listing_excerpt,
        summary: row.summary,
        raw_message: row.raw_message,
        purpose: row.purpose
      }) || `id:${row.id}`;
    if (seenFp.has(fp)) {
      contentDupRows += 1;
      continue;
    }
    seenFp.add(fp);
    uniqueByContent += 1;
  }

  const finalCards = filterAndSortProperties(r.rows, { sortBy: 'Newest First' });
  const junkRemovedApprox = Math.max(0, uniqueByContent - finalCards.length);

  // Top duplicate fingerprints (how often same ad repeats)
  const counts = new Map();
  for (const row of r.rows) {
    const fp =
      listingContentFingerprint({
        listing_excerpt: row.listing_excerpt,
        summary: row.summary,
        raw_message: row.raw_message,
        purpose: row.purpose
      }) || `id:${row.id}`;
    counts.set(fp, (counts.get(fp) || 0) + 1);
  }
  const top = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([fp, n]) => ({ times: n, text: fp.slice(0, 80) }));

  const multiPosted = [...counts.values()].filter((n) => n > 1).length;

  console.log(
    JSON.stringify(
      {
        available_property_rows: raw,
        from_distinct_whatsapp_messages: byMsg.size,
        unique_by_same_ad_text: uniqueByContent,
        rows_that_were_content_duplicates: contentDupRows,
        distinct_ads_that_were_reposted: multiPosted,
        junk_or_thin_removed_after_that: junkRemovedApprox,
        final_search_cards: finalCards.length,
        top_repeated_ads: top
      },
      null,
      2
    )
  );
  console.log('DONE_TEST');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
