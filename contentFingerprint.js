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

const PHONE_RE = /(?:\+?92|0)?3\d{2}[\s-]?\d{7}|\+?\d{10,15}/g;
const CONTACT_LINE_RE = /^(?:contact|whats?app|wa|call|mobile|phone|cell|number|regards|thanks|thank\s+you|sent\s+by|for\s+details)\b[:.\-\s]*/i;
const PROPERTY_NAME_BLOCK = /\b(?:phase|plot|yard|gaz|flat|house|bungalow|shop|demand|budget|street|dha|defence|commercial|size|sq)\b/i;

function isNameLine(line) {
  const t = String(line || '').replace(/[.,!]/g, '').trim();
  if (!t || t.length > 48) return false;
  if (/\d/.test(t)) return false;
  if (PROPERTY_NAME_BLOCK.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 4 && /^[\p{L}\s.'-]+$/u.test(t);
}

function isContactOrNameLine(line) {
  const t = String(line || '').trim();
  if (!t) return true;
  if (PHONE_RE.test(t)) return true;
  PHONE_RE.lastIndex = 0;
  if (CONTACT_LINE_RE.test(t)) return true;
  return isNameLine(t);
}

/** Drop WhatsApp forward wrappers so a repost matches the original body. */
function stripForwardedHeader(raw) {
  return String(raw || '')
    .replace(/^\u200f?\s*(?:this is a )?forwarded(?:\s+message)?\s*$/gim, '')
    .replace(/^\s*\[?forwarded\]?\s*$/gim, '')
    .trim();
}

/** Drop trailing contact / agent-name lines. Rest of the body stays character-exact. */
function stripTrailingContactAndName(raw) {
  const lines = String(raw || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim());
  while (lines.length) {
    const last = lines[lines.length - 1];
    if (!last) {
      lines.pop();
      continue;
    }
    if (isContactOrNameLine(last)) {
      lines.pop();
      continue;
    }
    const withoutPhone = last.replace(PHONE_RE, ' ').replace(/\s+/g, ' ').trim();
    PHONE_RE.lastIndex = 0;
    if (withoutPhone !== last) {
      if (!withoutPhone || isContactOrNameLine(withoutPhone)) {
        lines.pop();
        continue;
      }
      lines[lines.length - 1] = withoutPhone;
      continue;
    }
    break;
  }
  return lines.join('\n').trim();
}

/**
 * Exact body key after stripping trailing contact/name.
 * Any remaining character difference keeps two messages separate.
 */
function bodyExactKey(text, { minLen = 8, maxLen = 800 } = {}) {
  const stripped = stripTrailingContactAndName(stripForwardedHeader(text));
  const n = String(stripped || '')
    .toLowerCase()
    .replace(/[*_`~#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (n.length < minLen) return null;
  return n.slice(0, maxLen);
}

/** Offer text for dedupe. Excerpt first, so two plots in one chat stay separate and reposts collapse. */
function pickListingBodyText(row) {
  const excerpt = String(row.listingExcerpt || row.listing_excerpt || '').trim();
  const summary = String(row.summary || '').trim();
  const raw = String(row.rawMessage || row.raw_message || row.message || '').trim();
  if (excerpt.length >= 24) return excerpt;
  if (summary.length >= 24) return summary;
  return raw || excerpt || summary;
}

/**
 * Fingerprint for raw WhatsApp message bodies (ingest / skip-normalize).
 * Returns null for short messages so we do not block "ok" / OTPs.
 */
function messageContentFingerprint(text, { minLen = 40, maxLen = 800 } = {}) {
  return bodyExactKey(text, { minLen, maxLen });
}

/**
 * Fingerprint for a normalized listing row / search card.
 * Prefer the full offer text (raw/excerpt) so reposts with different AI summaries still collapse.
 */
function listingContentFingerprint(row, { minLen = 8, maxLen = 800 } = {}) {
  const body = bodyExactKey(pickListingBodyText(row), { minLen, maxLen });
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
  bodyExactKey,
  stripTrailingContactAndName,
  stripForwardedHeader,
  pickListingBodyText,
  messageContentFingerprint,
  listingContentFingerprint,
  userListingFingerprint,
  userMessageFingerprint
};
