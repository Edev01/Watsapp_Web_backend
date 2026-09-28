/**
 * Fill-only merge for Gemini → Qwen → local NER cascade.
 * Later stages may ONLY fill empty fields — never overwrite a non-empty
 * value from an earlier (stronger) stage.
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

const SCALAR_FIELDS = [
  'summary',
  'intent',
  'category',
  'sentiment',
  'language',
  'purpose',
  'property_type',
  'property_sub_type',
  'city',
  'area',
  'vicinity',
  'size',
  'size_value',
  'size_unit',
  'price',
  'price_value',
  'contact_number'
];

const LOCATION_FIELDS = new Set(['city', 'area', 'vicinity']);

function isEmpty(value) {
  if (value == null) return true;
  if (typeof value === 'string' && !value.trim()) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function isWeakLocation(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[–—\-_/\\,]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!raw) return true;
  const toks = raw.split(' ').filter(Boolean);
  if (!toks.length) return true;
  // bare "main" / "mein" / "main dha" without phase → too weak to trust from lower tiers
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

function scrubWeakLocations(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { ...schema };
  for (const key of LOCATION_FIELDS) {
    if (isWeakLocation(out[key])) out[key] = null;
  }
  if (Array.isArray(out.listings)) {
    out.listings = out.listings.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const row = { ...item };
      for (const key of LOCATION_FIELDS) {
        if (isWeakLocation(row[key])) row[key] = null;
      }
      return row;
    });
  }
  return out;
}

function fillScalarGaps(target, source) {
  if (!target || !source) return target;
  for (const key of SCALAR_FIELDS) {
    if (!isEmpty(target[key])) continue;
    if (isEmpty(source[key])) continue;
    if (LOCATION_FIELDS.has(key) && isWeakLocation(source[key])) continue;
    target[key] = source[key];
  }
  // Boolean: only set if target never decided
  if (
    typeof target.is_property_listing_or_inquiry !== 'boolean' &&
    typeof source.is_property_listing_or_inquiry === 'boolean'
  ) {
    target.is_property_listing_or_inquiry = source.is_property_listing_or_inquiry;
  }
  // Never let a later stage flip true → false (worse)
  if (
    target.is_property_listing_or_inquiry === true &&
    source.is_property_listing_or_inquiry === false
  ) {
    /* keep true */
  }
  if (
    target.confidence_score == null &&
    source.confidence_score != null
  ) {
    target.confidence_score = source.confidence_score;
  } else if (
    target.confidence_score != null &&
    source.confidence_score != null
  ) {
    target.confidence_score = Math.max(
      Number(target.confidence_score) || 0,
      Number(source.confidence_score) || 0
    );
  }
  return target;
}

function fillListingGaps(targetListings, sourceListings) {
  if (!Array.isArray(sourceListings) || !sourceListings.length) {
    return Array.isArray(targetListings) ? targetListings : null;
  }
  if (!Array.isArray(targetListings) || !targetListings.length) {
    // Primary had no listings — adopt secondary offers (Gemini missed multi-split)
    return sourceListings.map((item) => ({ ...item }));
  }
  // Same count preference: fill gaps per index only (do not append extras that invent offers)
  const out = targetListings.map((item, i) => {
    const row = { ...(item || {}) };
    const src = sourceListings[i];
    if (src && typeof src === 'object') fillScalarGaps(row, src);
    return row;
  });
  return out;
}

/**
 * Merge secondary into primary fill-only. Primary wins on every non-empty field.
 */
function fillGapsOnly(primary, secondary) {
  if (!primary || typeof primary !== 'object') {
    return secondary && typeof secondary === 'object'
      ? scrubWeakLocations({ ...secondary })
      : null;
  }
  if (!secondary || typeof secondary !== 'object') {
    return scrubWeakLocations({ ...primary });
  }

  const out = scrubWeakLocations({ ...primary });
  const src = scrubWeakLocations({ ...secondary });

  fillScalarGaps(out, src);

  if (!out.entities || typeof out.entities !== 'object') {
    out.entities = src.entities || {
      products: [],
      dates_mentioned: [],
      action_items: [],
      names: []
    };
  } else if (src.entities && typeof src.entities === 'object') {
    for (const ek of ['products', 'dates_mentioned', 'action_items', 'names']) {
      if (
        (!Array.isArray(out.entities[ek]) || !out.entities[ek].length) &&
        Array.isArray(src.entities[ek]) &&
        src.entities[ek].length
      ) {
        out.entities[ek] = src.entities[ek];
      }
    }
  }

  out.listings = fillListingGaps(out.listings, src.listings);
  return scrubWeakLocations(out);
}

module.exports = {
  fillGapsOnly,
  scrubWeakLocations,
  isEmpty,
  isWeakLocation,
  WEAK_LOCATION_TOKENS
};
