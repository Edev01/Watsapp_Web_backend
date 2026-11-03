/**
 * Search drops place names that are only filler words ("main", "mein", "phase").
 */
const WEAK_LOCATION_TOKENS = new Set([
  'main',
  'mein',
  'mai',
  'meny',
  'mayn',
  'me',
  'new',
  'old',
  'the',
  'a',
  'an',
  'in',
  'at',
  'of',
  'near',
  'area',
  'plot',
  'house',
  'road',
  'street',
  'st',
  'phase',
  'block',
  'sector'
]);

function isWeakLocation(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[–—\-_/\\,]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!raw) return true;
  const toks = raw.split(' ').filter(Boolean);
  if (!toks.length) return true;
  if (toks.every((t) => WEAK_LOCATION_TOKENS.has(t))) return true;
  if (
    toks.length <= 2 &&
    WEAK_LOCATION_TOKENS.has(toks[0]) &&
    (toks[1] === 'dha' || toks[1] === 'defence' || toks[1] === 'defense')
  ) {
    return true;
  }
  return false;
}

module.exports = { isWeakLocation };
