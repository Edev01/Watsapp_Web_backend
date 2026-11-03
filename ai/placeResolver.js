/**
 * Seed place_regions from the search gazetteer. Search reads that table.
 * Listing rows are not retagged here.
 */
const db = require('../db');
const { seedRows } = require('./placeRegions');

let regionsSeeded = false;

async function ensurePlaceRegionsSeeded() {
  if (regionsSeeded) return;
  try {
    for (const row of seedRows()) {
      await db.query(
        `INSERT INTO place_regions (parent_key, aliases, children, source, updated_at)
         VALUES ($1, $2::text[], $3::text[], $4, NOW())
         ON CONFLICT (parent_key) DO UPDATE SET
           aliases = EXCLUDED.aliases,
           children = EXCLUDED.children,
           source = EXCLUDED.source,
           updated_at = NOW()`,
        [row.parent_key, row.aliases, row.children, row.source]
      );
    }
    regionsSeeded = true;
  } catch (err) {
    console.warn('[placeResolver] seed place_regions:', err.message);
  }
}

module.exports = { ensurePlaceRegionsSeeded };
