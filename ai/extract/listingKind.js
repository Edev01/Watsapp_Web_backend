/**
 * Buyer/tenant-wanted vs inventory offer.
 * "Req 500 yards" / "plot chahiye" / "looking to rent" = REQUIREMENT.
 * Commission required, profile required, white money, buyer-wanted = OFFER.
 * Never trust LLM kind alone — only the listing excerpt (not the sibling ads).
 */

const OFFER_SIDE =
  /\b(?:buyers?|clients?|investors?|tenants?|customers?)\s+(?:required|wanted|needed)\b|\b(?:required|wanted)\s+(?:buyers?|clients?|investors?|tenants?)\b|\b(?:looking\s+for|need)\s+(?:serious\s+)?(?:buyers?|clients?|investors?|tenants?)\b/i;

const REQUIREMENT =
  /\b(?:reqs?|req\.|required|requirements?|chahiye|want(?:s|ed)?\s+to\s+(?:buy|purchase|rent)|looking\s+to\s+(?:buy|purchase|rent)|looking\s+for\s+(?:a\s+|an\s+)?(?:plot|house|flat|apartment|bungalow|shop|office|portion|unit|property|home|villa|file)|need(?:s|ed)?\s+(?:a\s+|an\s+)?(?:plot|house|flat|apartment|bungalow|shop|office|portion|property|home)|need(?:s|ed)?\s+\d+|in\s+search\s+of|purchase\s+requirement|rent(?:al)?\s+requirement)\b/i;

/** Postgres regexp for stripping deal-term "required" before the requirement search. */
const NON_INVENTORY_REQUIRED_SQL =
  '(tenant[[:space:]]+)?profile[[:space:]]+required|' +
  'comm[a-z]*[[:space:]]+(is[[:space:]]+)?required|' +
  '(percentage|percent|covering|renovation|renovations)[[:space:]]+(is[[:space:]]+)?required|' +
  'required[[:space:]]+(comm[a-z]*|percentage|percent|covering|renovation|renovations|profile|offer|quote)|' +
  'required[[:space:]]+well[[:space:]]+m[a-z]*|' +
  'well[[:space:]]+m[ae]nt[a-z]*[[:space:]]+required|' +
  'required[[:space:]]+to[[:space:]]+(build|construct)|' +
  'street[[:space:]]+required|' +
  'quote[[:space:]]+required|' +
  '(confirm[[:space:]]+|close[[:space:]]+)?offers?[[:space:]]+(is[[:space:]]+)?(required|reqs?)|' +
  'required[[:space:]]+[0-9]+([.][0-9]+)?[[:space:]]*%?[[:space:]]*(white|black)[[:space:]]*money|' +
  '[0-9]+([.][0-9]+)?[[:space:]]*%[[:space:]]*(white|black)?[[:space:]]*(money[[:space:]]+)?required|' +
  '(white|black)[[:space:]]*money[[:space:]]+required|' +
  'percentage[[:space:]]*%[[:space:]]*required|' +
  '%[[:space:]]*required';

const REQUIREMENT_SQL =
  '\\y(reqs?|req\\.|required|requirements?|chahiye|looking[[:space:]]+to[[:space:]]+(buy|purchase|rent)|want[[:space:]]+to[[:space:]]+(buy|purchase|rent)|purchase[[:space:]]+requirement|rent(al)?[[:space:]]+requirement)\\y';

function maskNonInventoryRequired(text) {
  return String(text || '')
    .replace(/\btenant\s+profile\s+required\b/gi, ' ')
    .replace(/\b(?:buyer|client|customer)?\s*profile\s+required\b/gi, ' ')
    .replace(/\b(?:confirm\s+|close\s+)?offers?\s+(?:is\s+)?(?:required|reqs?)\b/gi, ' ')
    .replace(/\bcomm[a-z]*\s+(?:is\s+)?required\b/gi, ' ')
    .replace(/\b(?:percentage|percent|covering|renovation|renovations)\s+(?:is\s+)?required\b/gi, ' ')
    .replace(/\brequired\s+(?:comm[a-z]*|percentage|percent|covering|renovation|renovations|profile|offer|quote)\b/gi, ' ')
    .replace(/\brequired\s+well\s+m\w*/gi, ' ')
    .replace(/\bwell\s+m[ae]nt\w*\s+required\b/gi, ' ')
    .replace(/\brequired\s+to\s+(?:build|construct)\b/gi, ' ')
    .replace(/\bstreet\s+required\b/gi, ' ')
    .replace(/\bquote\s+required\b/gi, ' ')
    .replace(/\brequired\s+\d+(?:\.\d+)?\s*%?\s*(?:white|black)\s*money\b/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*%\s*(?:white|black)?\s*(?:money\s+)?required\b/gi, ' ')
    .replace(/\b(?:white|black)\s*money\s+required\b/gi, ' ')
    .replace(/\bpercentage\s*%?\s*required\b/gi, ' ')
    .replace(/%\s*required\b/gi, ' ');
}

function listingExcerptText(rowOrBits) {
  if (Array.isArray(rowOrBits)) {
    return rowOrBits.map((bit) => String(bit || '')).join(' ');
  }
  const row = rowOrBits || {};
  const excerpt = String(row.listing_excerpt || row.listingExcerpt || '').trim();
  if (excerpt) return excerpt;
  return String(row.summary || '').trim();
}

function looksLikeRequirement(_kind, ...bits) {
  const text = maskNonInventoryRequired(listingExcerptText(bits));
  if (OFFER_SIDE.test(text)) return false;
  if (REQUIREMENT.test(text)) return true;
  return false;
}

function isRequirementListing(row) {
  return looksLikeRequirement(null, listingExcerptText(row));
}

function isRequirementFilter(filters = {}) {
  const listingKind = String(filters.listingKind || filters.listing_kind || '').trim().toUpperCase();
  const propertyType = String(filters.propertyType || filters.property_type || '').trim();
  return listingKind === 'REQUIREMENT' || /^requirement/i.test(propertyType);
}

function hasDealTermRequired(text) {
  return /\b(?:confirm\s+|close\s+)?offers?\s+(?:is\s+)?(?:required|reqs?)\b|\b(?:tenant\s+)?profile\s+required\b|\bcomm[a-z]*\s+(?:is\s+)?required\b|\b(?:percentage|percent|covering|renovation|renovations)\s+(?:is\s+)?required\b|\bpercentage\s*%?\s*required\b|%\s*required\b|\brequired\s+(?:comm[a-z]*|percentage|percent|covering|renovation|renovations|profile|offer|quote)\b|\brequired\s+well\s+m|\bwell\s+m[ae]nt\w*\s+required\b|\brequired\s+to\s+(?:build|construct)\b|\bstreet\s+required\b|\bquote\s+required\b/i.test(
    String(text || '')
  );
}

module.exports = {
  looksLikeRequirement,
  isRequirementListing,
  isRequirementFilter,
  maskNonInventoryRequired,
  listingExcerptText,
  hasDealTermRequired,
  NON_INVENTORY_REQUIRED_SQL,
  REQUIREMENT_SQL,
};
