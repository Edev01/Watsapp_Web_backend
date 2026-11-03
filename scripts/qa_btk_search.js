#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');
const { interpretBtkSearch, btkSearchKeeps, listingPrecincts } = require('../ai/btkPrecincts');

const USER = 4;
const queries = ['bahria', 'BTK', 'precinct 10', 'precint 10', 'P10', 'P10A', 'P15B'];

(async () => {
  const { rows } = await db.query(
    `SELECT n.id, n.listing_excerpt, n.vicinity, n.location_text, n.area, n.place_tags, n.summary
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
      WHERE m.user_id = $1 AND n.is_property IS TRUE`,
    [USER]
  );
  for (const q of queries) {
    const intent = interpretBtkSearch(q);
    const parsed = intent && {
      regionMode: intent.kind === 'btk-all' ? 'btk-all' : intent.kind === 'btk-parent' ? 'btk-parent' : 'btk-exact',
      precinct: intent.precinct,
      btkPrecincts: intent.matchPrecincts,
    };
    const kept = parsed ? rows.filter((r) => btkSearchKeeps(r, parsed)) : [];
    const other = [];
    if (intent && intent.kind !== 'btk-all') {
      const want = new Set(intent.matchPrecincts);
      const parent = intent.precinct && !/[A-Z]$/.test(intent.precinct) ? intent.precinct : null;
      for (const r of kept) {
        const have = listingPrecincts(r);
        const ok = have.some((c) => want.has(c) || (parent && (c === parent || c.startsWith(parent))));
        if (!ok) other.push({ id: r.id, have, excerpt: String(r.listing_excerpt || '').slice(0, 80) });
      }
    }
    console.log(JSON.stringify({
      q,
      kind: intent && intent.kind,
      chips: intent ? (intent.chips || []).length : 0,
      kept: kept.length,
      leak: other.length,
      leak_sample: other.slice(0, 5),
    }));
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
