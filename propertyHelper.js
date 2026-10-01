/**
 * Property listing lifecycle statuses (portal manual updates).
 */
const {
  normalizeFingerprintText,
  listingContentFingerprint
} = require('./contentFingerprint');

const PROPERTY_STATUSES = Object.freeze([
  'AVAILABLE',
  'SOLD',
  'RENTED',
  'RESERVED',
  'WITHDRAWN',
  'ON_HOLD'
]);

const PROPERTY_STATUS_ALIASES = Object.freeze({
  ACTIVE: 'AVAILABLE',
  OPEN: 'AVAILABLE',
  FOR_SALE: 'AVAILABLE',
  FOR_RENT: 'AVAILABLE',
  PENDING: 'ON_HOLD',
  HOLD: 'ON_HOLD',
  REMOVED: 'WITHDRAWN',
  INACTIVE: 'WITHDRAWN',
  LEASED: 'RENTED'
});

function normalizePropertyStatus(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const key = String(raw)
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (PROPERTY_STATUSES.includes(key)) return key;
  if (PROPERTY_STATUS_ALIASES[key]) return PROPERTY_STATUS_ALIASES[key];
  return null;
}

function isValidPropertyStatus(raw) {
  return normalizePropertyStatus(raw) != null;
}

const {
  correctLocalityTypos,
  localityVariants,
  matchLocality,
  canonicalizePlaceText
} = require('./pakistanLocalities');

/** Roman / English word ↔ Arabic for DHA-style phase queries. */
const ROMAN_TO_INT = Object.freeze({
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
  xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20
});
const WORD_TO_INT = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20
});
const INT_TO_ROMAN = Object.freeze(
  Object.fromEntries(Object.entries(ROMAN_TO_INT).map(([k, v]) => [String(v), k]))
);
const INT_TO_WORD = Object.freeze(
  Object.fromEntries(Object.entries(WORD_TO_INT).map(([k, v]) => [String(v), k]))
);

/** Levenshtein edit distance (case-insensitive). */
function editDistance(a, b) {
  const s = String(a || '').toLowerCase();
  const t = String(b || '').toLowerCase();
  if (s === t) return 0;
  const n = s.length;
  const m = t.length;
  if (!n) return m;
  if (!m) return n;
  const prev = new Array(m + 1);
  const cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= m; j++) prev[j] = cur[j];
  }
  return prev[m];
}

/** Canonical location keywords we fuzzy-correct toward. */
const LOCATION_CANONICALS = Object.freeze([
  'phase', 'sector', 'block', 'street', 'avenue', 'road',
  'building', 'extension', 'plaza', 'boulevard', 'lane', 'society'
]);

/**
 * Map near-miss tokens (phse, fase, setor, …) onto canonical keywords.
 * Max distance scales with word length so short typos still resolve.
 */
function correctLocationTypos(text) {
  return String(text || '').replace(/[A-Za-z]+/g, (word) => {
    const lower = word.toLowerCase();
    if (lower.length < 3 || lower.length > 14) return word;
    let best = null;
    let bestDist = Infinity;
    for (const canon of LOCATION_CANONICALS) {
      const lenDiff = Math.abs(lower.length - canon.length);
      if (lenDiff > 2) continue;
      const maxDist = canon.length <= 5 ? 2 : 3;
      const d = editDistance(lower, canon);
      if (d > 0 && d <= maxDist && d < bestDist) {
        best = canon;
        bestDist = d;
      }
    }
    if (!best) return word;
    // Preserve original casing style loosely (all-caps / title / lower)
    if (word === word.toUpperCase()) return best.toUpperCase();
    if (word[0] === word[0].toUpperCase()) {
      return best.charAt(0).toUpperCase() + best.slice(1);
    }
    return best;
  });
}

/**
 * Expand a free-text location query into equivalent spellings so
 * "phase one" / "phase 1" / "phase I" / "phase-1" / "phse 8" hit the same listings.
 * Returns unique ILIKE patterns (without surrounding %).
 */
function expandLocationQuery(raw) {
  const input = String(raw || '').trim();
  if (!input) return [];

  const variants = new Set();
  const push = (s) => {
    const t = String(s || '').trim();
    if (t) variants.add(t);
  };

  push(input);
  // Fuzzy-fix structural keywords (phse→phase) then Pakistan area names (clfton→clifton)
  const keywordFixed = correctLocationTypos(input.replace(/\bphasee\b/gi, 'phase'));
  const deTypo = canonicalizePlaceText(keywordFixed);
  push(keywordFixed);
  push(deTypo);
  const spaced = deTypo.replace(/[–—\-_/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
  push(spaced);
  push(spaced.toLowerCase());

  // Expand matched localities into hyphen/space/alias forms
  const words = spaced.toLowerCase().split(/\s+/).filter(Boolean);
  for (let n = Math.min(4, words.length); n >= 1; n -= 1) {
    for (let i = 0; i + n <= words.length; i += 1) {
      const phrase = words.slice(i, i + n).join(' ');
      const hit = matchLocality(phrase);
      if (hit) {
        for (const v of localityVariants(hit)) push(v);
      }
    }
  }

  const wordAlt = Object.keys(WORD_TO_INT).join('|');
  const phaseRe = new RegExp(
    `\\bphase\\s*([ivxlcdm]{1,6}|\\d{1,2}|${wordAlt})\\b`,
    'gi'
  );
  let m;
  const phaseHits = [];
  while ((m = phaseRe.exec(spaced)) !== null) {
    phaseHits.push({ full: m[0], token: m[1] });
  }

  for (const hit of phaseHits) {
    const token = hit.token.toLowerCase();
    let num = null;
    if (/^\d+$/.test(token)) {
      num = parseInt(token, 10);
    } else if (ROMAN_TO_INT[token]) {
      num = ROMAN_TO_INT[token];
    } else if (WORD_TO_INT[token]) {
      num = WORD_TO_INT[token];
    }
    if (!num) continue;

    const roman = INT_TO_ROMAN[String(num)] || null;
    const word = INT_TO_WORD[String(num)] || null;

    const forms = [
      `phase ${num}`,
      `phase${num}`,
      `phase-${num}`
    ];
    if (roman) {
      forms.push(
        `phase ${roman}`,
        `phase ${roman.toUpperCase()}`,
        `phase-${roman}`,
        `phase${roman}`
      );
    }
    if (word) {
      forms.push(`phase ${word}`, `phase-${word}`, `phase${word}`);
    }
    for (const form of forms) {
      push(form);
      push(spaced.replace(new RegExp(hit.full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), form));
    }
  }

  // Common street / building abbreviations
  const abbrPairs = [
    [/\bstreet\b/gi, 'st'],
    [/\bst\b/gi, 'street'],
    [/\bavenue\b/gi, 'ave'],
    [/\bave\b/gi, 'avenue'],
    [/\broad\b/gi, 'rd'],
    [/\brd\b/gi, 'road'],
    [/\bbuilding\b/gi, 'bldg'],
    [/\bbldg\b/gi, 'building'],
    [/\bextension\b/gi, 'ext'],
    [/\bext\b/gi, 'extension'],
  ];
  for (const v of [...variants]) {
    for (const [re, repl] of abbrPairs) {
      const copy = new RegExp(re.source, re.flags);
      if (copy.test(v)) {
        push(v.replace(new RegExp(re.source, re.flags), repl));
      }
    }
  }

  // Keep patterns reasonably short (locality + phase variants)
  return [...variants].filter((v) => v.length >= 1 && v.length <= 80).slice(0, 48);
}

/**
 * Parses real estate price strings (e.g. "PKR 1.8 Cr", "85 Lac", "45,000 / month", "15000000") into numeric PKR.
 * Never treats Pakistani mobile numbers (03XXXXXXXXX) as prices — that caused fake "322 Cr" demands.
 */
function isLikelyPhoneNumber(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (!d) return false;
  // 03XXXXXXXXX (11), 923XXXXXXXXX (12), or 3XXXXXXXXX (10) mobile shapes
  if (/^03\d{9}$/.test(d)) return true;
  if (/^923\d{9}$/.test(d)) return true;
  if (/^3\d{9}$/.test(d)) return true;
  return false;
}

function parsePriceInPKR(priceStr, rawMsg) {
  const explicit = String(priceStr || '').trim();
  // Prefer the structured price field; only fall back to raw text when needed
  const primary = explicit && !/^(null|n\/?a|none|price on call|on call|call|demand\?+)$/i.test(explicit)
    ? explicit
    : '';
  const source = primary || String(rawMsg || '');
  if (!source) return null;

  const str = source.toLowerCase().replace(/,/g, '').trim();

  // When scanning raw WhatsApp text, require a price cue so phone digits are not used
  const scanningRaw = !primary && Boolean(rawMsg);
  if (scanningRaw) {
    const hasPriceCue = /(?:\b(?:cr|crore|cror|crores|lac|lacs|lakh|lakhs|million|price|demand|pkr|rs\.?)\b|\b\d+(?:\.\d+)?\s*(?:cr|lac|lakh))/i.test(str);
    if (!hasPriceCue) return null;
  }

  let total = 0;
  let matchedAny = false;

  // Crores / Cr / Cror
  let crMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:cr|crore|cror|crores)\b/i);
  if (crMatch) {
    total += parseFloat(crMatch[1]) * 10000000;
    matchedAny = true;
  }

  // Lac / Lakh / Lacs
  let lacMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:lac|lacs|lakh|lakhs)\b/i);
  if (lacMatch) {
    total += parseFloat(lacMatch[1]) * 100000;
    matchedAny = true;
  }

  // K / Thousand (only with explicit price field, not raw "75" frontage etc.)
  if (primary) {
    let kMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:k|thousand)\b/i);
    if (kMatch) {
      total += parseFloat(kMatch[1]) * 1000;
      matchedAny = true;
    }
  }

  if (matchedAny) return total;

  // Direct currency format: PKR 45000, Rs. 150000
  let pkrMatch = str.match(/(?:pkr|rs\.?|\$)\s*(\d+(?:\.\d+)?)/i);
  if (pkrMatch) {
    const n = parseFloat(pkrMatch[1]);
    if (!isLikelyPhoneNumber(String(Math.trunc(n)))) return n;
  }

  // Pure digits only from explicit price field (never from raw message — phones live there)
  if (primary) {
    let digitMatch = str.match(/(\d{5,})/);
    if (digitMatch && !isLikelyPhoneNumber(digitMatch[1])) {
      return parseFloat(digitMatch[1]);
    }
  }

  return null;
}

/**
 * Converts size strings (e.g. "2 Kanal", "5 Marla", "120 Sq Yd", "450 Sq Ft") to target area unit.
 * Standard Pakistani land units:
 * 1 Kanal = 20 Marla
 * 1 Marla = 25 Sq. Yd (Yards) = 225 Sq. Ft (Feet)
 */
function parseAreaInUnit(sizeStr, rawMsg, targetUnit = 'Marla') {
  const sourceStr = sizeStr || '';
  if (!sourceStr && !rawMsg) return null;
  const str = String(sourceStr || rawMsg).toLowerCase().replace(/,/g, '').trim();

  let marlaVal = null;

  let kanalMatch = str.match(/(\d+(?:\.\d+)?)\s*kanal/i);
  if (kanalMatch) {
    marlaVal = parseFloat(kanalMatch[1]) * 20;
  } else {
    let marlaMatch = str.match(/(\d+(?:\.\d+)?)\s*marla/i);
    if (marlaMatch) {
      marlaVal = parseFloat(marlaMatch[1]);
    } else {
      let ydMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:sq\.?\s*yd|sq\.?\s*yard|yard|yards|yrd|yd)/i);
      if (ydMatch) {
        marlaVal = parseFloat(ydMatch[1]) / 25;
      } else {
        let ftMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:sq\.?\s*ft|sq\.?\s*feet|ft|feet)/i);
        if (ftMatch) {
          marlaVal = parseFloat(ftMatch[1]) / 225;
        }
      }
    }
  }

  if (marlaVal === null) return null;

  const tu = (targetUnit || 'Marla').toLowerCase().trim();
  if (tu.includes('kanal')) return marlaVal / 20;
  if (tu.includes('marla')) return marlaVal;
  if (tu.includes('yd') || tu.includes('yard')) return marlaVal * 25;
  if (tu.includes('ft') || tu.includes('feet')) return marlaVal * 225;

  return marlaVal;
}

/**
 * Content fingerprint for search cards (shared with ingest/normalize).
 */
function listingFingerprint(row) {
  const fp = listingContentFingerprint(row);
  if (fp) return fp;
  // Too thin to safely collapse — keep row identity
  return row.id != null ? `id:${row.id}` : '';
}

function dedupeListings(items) {
  const seenId = new Set();
  const seenFp = new Set();
  const seenMsgExcerpt = new Set();
  const seenBodyOnly = new Set();
  const out = [];
  for (const item of items) {
    if (item.id != null) {
      const key = `id:${item.id}`;
      if (seenId.has(key)) continue;
      seenId.add(key);
    }

    // Same WhatsApp message + same excerpt body → keep one card
    const msgId = item.whatsappMessageId ?? item.whatsapp_message_id;
    const excerptKey = normalizeFingerprintText(
      item.listingExcerpt || item.listing_excerpt || item.summary || ''
    ).slice(0, 160);
    if (msgId != null && excerptKey.length >= 24) {
      const mk = `m:${msgId}|${excerptKey}`;
      if (seenMsgExcerpt.has(mk)) continue;
      seenMsgExcerpt.add(mk);
    }

    // Same offer body across different message ids / summaries (reposts)
    const bodyOnly = normalizeFingerprintText(
      item.rawMessage ||
        item.raw_message ||
        item.listingExcerpt ||
        item.listing_excerpt ||
        item.summary ||
        ''
    ).slice(0, 220);
    if (bodyOnly.length >= 40) {
      if (seenBodyOnly.has(bodyOnly)) continue;
      seenBodyOnly.add(bodyOnly);
    }

    const fp = listingFingerprint(item);
    if (fp && seenFp.has(fp)) continue;
    if (fp) seenFp.add(fp);
    out.push(item);
  }
  return out;
}

/**
 * Drop agent footers / bare "Location Phase 8" fragments that are not real offers.
 */
function isListingNoise(item) {
  const text = String(
    item.listingExcerpt || item.listing_excerpt || item.summary || item.rawMessage || item.raw_message || ''
  ).trim();
  const lower = text.toLowerCase().replace(/\s+/g, ' ');
  const hasType = Boolean(String(item.propertyType || item.property_type || '').trim());
  const hasSize =
    Boolean(String(item.size || '').trim()) ||
    (item.parsedAreaInTargetUnit != null && !Number.isNaN(item.parsedAreaInTargetUnit));
  const hasPrice =
    Boolean(String(item.price || '').trim()) ||
    (item.parsedPricePKR != null && !Number.isNaN(item.parsedPricePKR));
  const offerWords =
    /\b(sale|rent|plot|yard|yds|sq\.?\s*(ft|yd|yard)|bed|bungalow|apartment|flat|shop|house|demand|crore|lakh|lac|marla|kanal|basement|floor)\b/i;

  if (!text || text.length < 12) return true;

  // Bare location lines
  if (/^(📍\s*)?(location\s*)?(dha\s*)?phase\s*(viii|8|vi{1,3}|\d+)\s*$/i.test(lower)) return true;
  if (/^(📍\s*)?location\s*[:\-]?\s*phase\b/i.test(lower) && text.length < 70 && !hasSize && !hasPrice) {
    return true;
  }
  if (
    /^(📍\s*)?dha\s+phase\s*(viii|8)\s*[—\-–]?\s*[\w\s]*$/i.test(lower) &&
    !hasType &&
    !hasSize &&
    !hasPrice &&
    text.length < 90
  ) {
    return true;
  }

  // Buyer RFPs / requirements (not an offer card)
  if (
    /\b(urgent\s+)?requirement\b|\blooking for\b|\bwanted\b|\bbasement required\b/i.test(lower) &&
    /\bbudget\b/i.test(lower) &&
    !/\b(for sale|for rent|demand\s*:|@\s*\d)/i.test(lower)
  ) {
    return true;
  }
  if (
    !hasType &&
    !hasSize &&
    /^[\s📍*]*location\s*[:\-]/i.test(lower) &&
    /phase\s*(viii|8|0?8)\b/i.test(lower) &&
    (/\bbudget\b|\brequired\b|\blooking\b/i.test(lower) || text.length < 160)
  ) {
    return true;
  }

  // Agent / office signature without an offer
  if (!hasType && !hasSize && !hasPrice) {
    if (
      text.length < 240 &&
      /(consultant|realtor|enterprises?|builders?|\bestate\b|for details call|contact (us|for|me)|suite\s*#?\d+|office\s*:|coral towers)/i.test(
        lower
      )
    ) {
      return true;
    }
    if (text.length < 110 && /phase\s*(viii|8|0?8)\b/i.test(lower) && !offerWords.test(lower)) {
      return true;
    }
    // Header-only inventory titles (phase digit alone is not an offer signal)
    if (
      text.length < 100 &&
      /(plots? for sale|apartments? for sale|prime investment|opportunity|inventory)\b/i.test(lower)
    ) {
      const withoutPhase = lower.replace(/phase\s*(viii|vi{1,3}|0?8|\d+)/gi, ' ');
      if (!offerWords.test(withoutPhase.replace(/plots? for sale|apartments? for sale/gi, ' '))) {
        return true;
      }
    }
  }

  return false;
}

function filterAndSortProperties(rawRows, filters = {}) {
  const targetUnit = filters.areaUnit || 'Marla';

  let items = rawRows.map(r => {
    const parsedPrice = parsePriceInPKR(r.price, r.raw_message);
    const parsedArea = parseAreaInUnit(r.size, r.raw_message, targetUnit);

    return {
      id: r.id,
      whatsappMessageId: r.whatsapp_message_id,
      listingIndex: r.listing_index ?? 0,
      seqInChat: r.seq_in_chat ?? r.seqInChat ?? null,
      seq_in_chat: r.seq_in_chat ?? r.seqInChat ?? null,
      chatJid: r.chat_jid,
      chatName: r.chat_name,
      sender: r.sender,
      purpose: r.purpose || 'SALE',
      city: r.city,
      location: r.vicinity || r.area || r.city,
      area: r.area,
      vicinity: r.vicinity,
      propertyType: r.property_type,
      propertySubType: r.property_sub_type || null,
      size: r.size,
      parsedPricePKR: parsedPrice,
      parsedAreaInTargetUnit: parsedArea,
      targetAreaUnit: targetUnit,
      price: r.price,
      contactNumber: r.contact_number,
      summary: r.summary,
      propertyStatus: (r.property_status || 'AVAILABLE').toUpperCase(),
      property_status: (r.property_status || 'AVAILABLE').toUpperCase(),
      rawMessage: r.raw_message,
      listingExcerpt: r.listing_excerpt || null,
      placeTags: Array.isArray(r.place_tags) ? r.place_tags : [],
      place_tags: Array.isArray(r.place_tags) ? r.place_tags : [],
      fromMe: r.from_me || r.fromMe || false,
      from_me: r.from_me || r.fromMe || false,
      userId: r.user_id || 1,
      user_id: r.user_id || 1,
      createdAt: r.created_at
    };
  });

  // Drop signature / bare-location junk cards
  items = items.filter((item) => !isListingNoise(item));

  // Price Min Filter
  if (filters.priceMin !== undefined && filters.priceMin !== null && String(filters.priceMin).trim() !== '') {
    const minP = parseFloat(filters.priceMin);
    if (!isNaN(minP)) {
      items = items.filter(r => r.parsedPricePKR !== null && r.parsedPricePKR >= minP);
    }
  }

  // Price Max Filter
  if (filters.priceMax !== undefined && filters.priceMax !== null && String(filters.priceMax).trim() !== '') {
    const maxP = parseFloat(filters.priceMax);
    if (!isNaN(maxP)) {
      items = items.filter(r => r.parsedPricePKR !== null && r.parsedPricePKR <= maxP);
    }
  }

  // Area Min Filter
  if (filters.areaMin !== undefined && filters.areaMin !== null && String(filters.areaMin).trim() !== '') {
    const minA = parseFloat(filters.areaMin);
    if (!isNaN(minA)) {
      items = items.filter(r => r.parsedAreaInTargetUnit !== null && r.parsedAreaInTargetUnit >= minA);
    }
  }

  // Area Max Filter
  if (filters.areaMax !== undefined && filters.areaMax !== null && String(filters.areaMax).trim() !== '') {
    const maxA = parseFloat(filters.areaMax);
    if (!isNaN(maxA)) {
      items = items.filter(r => r.parsedAreaInTargetUnit !== null && r.parsedAreaInTargetUnit <= maxA);
    }
  }

  // Sorting
  const sort = (filters.sortBy || 'Newest First').toLowerCase();
  if (sort.includes('relevance') || sort.includes('best') || sort.includes('match')) {
    // Keep caller order (already relevance-ranked)
  } else if (sort.includes('price') && (sort.includes('low') || sort.includes('asc'))) {
    items.sort((a, b) => (a.parsedPricePKR || 0) - (b.parsedPricePKR || 0));
  } else if (sort.includes('price') && (sort.includes('high') || sort.includes('desc'))) {
    items.sort((a, b) => (b.parsedPricePKR || 0) - (a.parsedPricePKR || 0));
  } else if (sort.includes('oldest') || sort.includes('asc')) {
    items.sort((a, b) => a.id - b.id);
  } else {
    // Newest First (default)
    items.sort((a, b) => b.id - a.id);
  }

  return dedupeListings(items);
}

module.exports = {
  PROPERTY_STATUSES,
  normalizePropertyStatus,
  isValidPropertyStatus,
  expandLocationQuery,
  parsePriceInPKR,
  parseAreaInUnit,
  filterAndSortProperties
};
