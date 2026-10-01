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
 * Aggressive body key for search/purge dedupe — letters/digits/spaces only.
 * Collapses emoji/punct noise so "11. 5 cr" === "11.5 cr".
 */
function bodyDedupeKey(text, { minLen = 8, maxLen = 500 } = {}) {
  const n = normalizeFingerprintText(text)
    .replace(/[./-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (n.length < minLen) return null;
  return n.slice(0, maxLen);
}

/** Longest substantial text among listing fields (raw preferred when tied). */
function pickListingBodyText(row) {
  const candidates = [
    row.rawMessage || row.raw_message || row.message || '',
    row.listingExcerpt || row.listing_excerpt || '',
    row.summary || ''
  ].map((s) => String(s || ''));
  let best = '';
  for (const c of candidates) {
    if (c.replace(/\s+/g, ' ').trim().length > best.replace(/\s+/g, ' ').trim().length) {
      best = c;
    }
  }
  return best;
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
 * Prefer the full offer text (raw/excerpt) so reposts with different AI summaries still collapse.
 */
function listingContentFingerprint(row, { minLen = 8, maxLen = 400 } = {}) {
  const body = bodyDedupeKey(pickListingBodyText(row), { minLen, maxLen });
  if (!body) return null;

  const purpose = String(row.purpose || '')
    .toLowerCase()
    .trim();
  return `${body}|${purpose}`;
}

/** Per-user scoped listing fingerprint (safe for unique index). */
function userListingFingerprint(userId, row, opts) {
  const base = listingContentFingerprint(row, opts);
  if (!base) return null;
  return `u${Number(userId) || 0}|${base}`;
}

/** Per-user scoped message body fingerprint. */
function userMessageFingerprint(userId, text, opts) {
  const base = messageContentFingerprint(text, opts);
  if (!base) return null;
  return `u${Number(userId) || 0}|${base}`;
}

module.exports = {
  collapseRepeatedText,
  normalizeFingerprintText,
  bodyDedupeKey,
  pickListingBodyText,
  messageContentFingerprint,
  listingContentFingerprint,
  userListingFingerprint,
  userMessageFingerprint
};
