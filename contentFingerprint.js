/**
 * Stable content fingerprints for ingest / normalize / search dedupe.
 * Same ad text (whitespace/markdown noise ignored) → same fingerprint.
 */

function collapseRepeatedText(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (t.length < 40) return t;
  const half = Math.floor(t.length / 2);
  if (half >= 20 && t.slice(0, half).trim() === t.slice(half).trim()) {
    return t.slice(0, half).trim();
  }
  const noPunct = t.replace(/[.,!?;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  const h2 = Math.floor(noPunct.length / 2);
  if (h2 >= 20 && noPunct.slice(0, h2).trim() === noPunct.slice(h2).trim()) {
    return noPunct.slice(0, h2).trim();
  }
  return t;
}

function normalizeFingerprintText(s) {
  return collapseRepeatedText(String(s || ''))
    .toLowerCase()
    .replace(/[*_`~#>|]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s./-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fingerprint for raw WhatsApp message bodies (ingest / skip-normalize).
 * Returns null for short messages so we do not block "ok" / OTPs.
 */
function messageContentFingerprint(text, { minLen = 40, maxLen = 220 } = {}) {
  const n = normalizeFingerprintText(text);
  if (n.length < minLen) return null;
  return n.slice(0, maxLen);
}

/**
 * Fingerprint for a normalized listing row / search card.
 */
function listingContentFingerprint(row, { minLen = 24, maxLen = 180 } = {}) {
  const structured = normalizeFingerprintText(
    row.listingExcerpt || row.listing_excerpt || row.summary || ''
  );
  const raw =
    structured ||
    normalizeFingerprintText(row.rawMessage || row.raw_message || row.message || '');
  if (!raw || raw.length < minLen) return null;
  const purpose = String(row.purpose || '')
    .toLowerCase()
    .trim();
  return `${raw.slice(0, maxLen)}|${purpose}`;
}

module.exports = {
  collapseRepeatedText,
  normalizeFingerprintText,
  messageContentFingerprint,
  listingContentFingerprint
};
