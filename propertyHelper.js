/**
 * Property listing lifecycle statuses (portal manual updates).
 */
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
  matchLocality
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
  const deTypo = correctLocalityTypos(keywordFixed);
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
 */
function parsePriceInPKR(priceStr, rawMsg) {
  const sourceStr = priceStr || '';
  if (!sourceStr && !rawMsg) return null;
  const str = String(sourceStr || rawMsg).toLowerCase().replace(/,/g, '').trim();

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

  // K / Thousand
  let kMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:k|thousand)\b/i);
  if (kMatch) {
    total += parseFloat(kMatch[1]) * 1000;
    matchedAny = true;
  }

  if (matchedAny) return total;

  // Direct currency format: PKR 45000, Rs. 150000
  let pkrMatch = str.match(/(?:pkr|rs\.?|\$)\s*(\d+(?:\.\d+)?)/i);
  if (pkrMatch) {
    return parseFloat(pkrMatch[1]);
  }

  // Pure digits: 15000000, 45000
  let digitMatch = str.match(/(\d{5,})/);
  if (digitMatch) {
    return parseFloat(digitMatch[1]);
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

function collapseRepeatedText(raw) {
  let t = String(raw || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length < 40) return t;
  const half = Math.floor(t.length / 2);
  if (t.slice(0, half).trim() === t.slice(half).trim()) {
    return t.slice(0, half).trim();
  }
  const noPunct = t.replace(/[.,!?;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  const h2 = Math.floor(noPunct.length / 2);
  if (h2 >= 20 && noPunct.slice(0, h2).trim() === noPunct.slice(h2).trim()) {
    return noPunct.slice(0, h2).trim();
  }
  return t;
}

/**
 * Collapse doubled paste ("hellohello") and whitespace so duplicate scrapes match.
 */
function listingFingerprint(row) {
  const raw = collapseRepeatedText(row.rawMessage || row.raw_message || row.summary || '');
  return [raw.slice(0, 200), String(row.purpose || '').toLowerCase()].join('|');
}

function dedupeListings(items) {
  const seenMsg = new Set();
  const seenFp = new Set();
  const out = [];
  for (const item of items) {
    const mid = item.whatsappMessageId || item.whatsapp_message_id;
    if (mid != null) {
      const key = String(mid);
      if (seenMsg.has(key)) continue;
      seenMsg.add(key);
    }
    const fp = listingFingerprint(item);
    if (fp && seenFp.has(fp)) continue;
    if (fp) seenFp.add(fp);
    out.push(item);
  }
  return out;
}
function filterAndSortProperties(rawRows, filters = {}) {
  const targetUnit = filters.areaUnit || 'Marla';

  let items = rawRows.map(r => {
    const parsedPrice = parsePriceInPKR(r.price, r.raw_message);
    const parsedArea = parseAreaInUnit(r.size, r.raw_message, targetUnit);

    return {
      id: r.id,
      whatsappMessageId: r.whatsapp_message_id,
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
      fromMe: r.from_me || r.fromMe || false,
      from_me: r.from_me || r.fromMe || false,
      userId: r.user_id || 1,
      user_id: r.user_id || 1,
      createdAt: r.created_at
    };
  });

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
  if (sort.includes('price') && (sort.includes('low') || sort.includes('asc'))) {
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
