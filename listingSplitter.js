/**
 * Heuristic split of agent broadcast WhatsApp messages into separate property offers.
 * Used before LLM normalize so each offer becomes its own listing row.
 */

const OFFER_HINT =
  /\b(?:yard|yrd|yards|marla|kanal|plot|street|st\b|phase|demand|for sale|for rent|bungalow|banglow|house|flat|apartment|shop|commercial|residential)\b/i;

const SIZE_START =
  /(?:^|\n)\s*\*??\s*(?:\d+\s*\+\s*)?\d+(?:\.\d+)?\s*(?:yard|yrd|yards|sq\.?\s*yd|marla|kanal|sq\.?\s*ft)\b/gi;

function normalizePkMobile(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('92') && digits.length >= 12) digits = `0${digits.slice(2)}`;
  if (/^3\d{9}$/.test(digits)) digits = `0${digits}`;
  if (!/^03\d{9}$/.test(digits)) {
    // Keep plausible international numbers; reject short junk
    if (digits.length >= 10 && digits.length <= 15) return digits;
    return null;
  }
  return digits;
}

function extractSharedContacts(text) {
  const t = String(text || '');
  const found = new Set();
  // Allow dashes/spaces/markdown: 0318-2427563, 0309 8196446, +92 318 2427563, `0315-3732175`
  const re = /(?:\+?92[\s\-.]*)?0?3(?:[\s\-.]*\d){9}/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const phone = normalizePkMobile(m[0]);
    if (phone) found.add(phone);
  }
  return found.size ? [...found].join(', ') : null;
}

function looksLikeOffer(chunk) {
  const t = String(chunk || '').trim();
  if (t.length < 20) return false;
  if (!OFFER_HINT.test(t)) return false;
  // Ignore pure header/footer brand blocks without a size or street
  if (!/\d/.test(t) && !/\bstreet\b|\bphase\b|\blane\b/i.test(t)) return false;
  return true;
}

/**
 * @param {string} rawText
 * @returns {string[]} one or more offer text slices (max 15)
 */
function splitPropertyOffers(rawText) {
  const text = String(rawText || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  // 1) Split on blank lines first (common in agent broadcasts)
  let parts = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  // 2) If still one block, split before size markers (100 yard / 100+100 yard)
  if (parts.length < 2) {
    const idxs = [];
    let m;
    const re = new RegExp(SIZE_START.source, SIZE_START.flags);
    while ((m = re.exec(text)) !== null) {
      idxs.push(m.index === 0 ? 0 : m.index + (m[0].startsWith('\n') ? 1 : 0));
    }
    if (idxs.length >= 2) {
      parts = [];
      for (let i = 0; i < idxs.length; i += 1) {
        const start = idxs[i];
        const end = i + 1 < idxs.length ? idxs[i + 1] : text.length;
        const slice = text.slice(start, end).trim();
        if (slice) parts.push(slice);
      }
    }
  }

  // 3) Keep offer-like chunks; drop tiny brand-only headers when other offers exist
  let offers = parts.filter(looksLikeOffer);

  // If filtering wiped everything, fall back to whole message
  if (!offers.length) return [text];

  // If we only got the whole thing as one offer, return single
  if (offers.length === 1 && offers[0].length > text.length * 0.85) {
    return [text];
  }

  return offers.slice(0, 15);
}

module.exports = {
  splitPropertyOffers,
  extractSharedContacts,
  looksLikeOffer,
  normalizePkMobile
};
