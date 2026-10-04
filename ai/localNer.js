/**
 * Local property NER — same fields the LLM writes to normalized_messages.
 * Gazetteer is seeded plus names learned from existing (Danish) listings.
 * No Ollama / remote LLM required.
 */

const db = require('../db');
const { parsePriceInPKR } = require('../propertyHelper');
const { SEED_LOCALITIES, setExtraLocalities, matchLocality, canonicalizePlaceText } = require('../pakistanLocalities');
const { splitPropertyOffers, extractSharedContacts, looksLikeOffer } = require('./listingSplitter');

const LOCAL_MODEL = 'local-ner';

const CITIES = [
  'Karachi',
  'Lahore',
  'Islamabad',
  'Rawalpindi',
  'Faisalabad',
  'Multan',
  'Peshawar',
  'Hyderabad',
  'Gujranwala',
  'Sialkot',
  'Quetta',
  'Bahawalpur'
];

const TYPE_PATTERNS = [
  [/\bfarm\s*house\b|\bfarmhouse\b/i, 'FARMHOUSE', 'Agricultural Land'],
  [/\bbungalow\b|\bbanglow\b|\bbangla\b/i, 'BUNGALOW', null],
  [/\bapartment\b|\bappartments?\b/i, 'APARTMENT', null],
  [/\bflat\b/i, 'FLAT', null],
  [/\bshop\b/i, 'SHOP', 'Shop'],
  [/\boffice\b/i, 'COMMERCIAL', 'Office'],
  [/\bwarehouse\b|\bgodown\b/i, 'COMMERCIAL', 'Warehouse'],
  [/\bcommercial\s+plot\b/i, 'PLOT', 'Commercial Plot'],
  [/\bresidential\s+plot\b|\bresi(?:dential)?\s+plot\b/i, 'PLOT', 'Residential Plot'],
  [/\bplot\b/i, 'PLOT', null],
  [/\bhouse\b|\bhome\b/i, 'HOUSE', null],
  [/\bcommercial\b/i, 'COMMERCIAL', null]
];

const SUBTYPE_PATTERNS = [
  [/\btriple\s*storey\b|\b3\s*storey\b/i, 'Triple Storey'],
  [/\bdouble\s*storey\b|\b2\s*storey\b/i, 'Double Storey'],
  [/\bsingle\s*storey\b|\b1\s*storey\b/i, 'Single Storey'],
  [/\bpenthouse\b/i, 'Penthouse'],
  [/\blower\s*portion\b/i, 'Lower Portion'],
  [/\bupper\s*portion\b/i, 'Upper Portion'],
  [/\bstudio\b/i, 'Studio'],
  [/\b3\s*bed/i, '3 Bed'],
  [/\b2\s*bed/i, '2 Bed'],
  [/\b1\s*bed/i, '1 Bed']
];

const SIZE_RE =
  /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s*(?:\+|\&|and)\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?))?\s*[*]*\s*(yard|yrd|yards|sq\.?\s*yds?|sq\.?\s*yards?|marla|kanal|sq\.?\s*ft|sq\.?\s*feet|sqfeet|sq\.?ft)\b/i;

const PRICE_UNIT_RE =
  /(\d+(?:\.\d+)?)\s*(crores?|cror|crs?|lakhs?|lacs?|lac)\b/i;
const PRICE_K_RE =
  /\b(?:demand|budget|asking|price|rent|dmnd)\s*[:=]?\s*(?:(?:pkr|rs\.?)\s*)?(\d+(?:\.\d+)?)\s*k\b/i;
const PRICE_DEMAND_NUM_RE =
  /\b(?:demand|budget|asking|price|dmnd)\s*[:=]?\s*(?:(?:pkr|rs\.?)\s*)?(\d{1,3}(?:\s*,\s*\d{3})+|\d{4,}|\d+(?:\.\d+)?)(?!\s*(?:yard|yrd|marla|kanal|sq|bed|floor|%))/i;
const PRICE_BEFORE_WORD_RE =
  /(\d{1,3}(?:\s*,\s*\d{3})+|\d{5,})\s*(?:\/\s*-)?\s*(?:price|demand|only)\b/i;
const PRICE_SLASH_CRORE_RE = /\b(?:demand|budget|asking)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*\/\s*-/i;
const PRICE_AT_CR_RE = /@\s*(\d+(?:\.\d+)?)\s*(cr|crore)\b/i;
const PRICE_PKR_FULL_RE =
  /(?:pkr|rs\.?)\s*(\d+(?:\.\d+)?)\s*(crores?|cror|crs?|lakhs?|lacs?|lac)?\b/i;

const PHASE_WORD_NUM = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
  xi: 11,
  xii: 12
};
const PHASE_RE =
  /\bphase\s*(?:no\.?|number|#)?\s*([0-9]{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|viii|vii|vi|iv|ix|iii|ii|xii|xi|x|v|i)\b/i;
const BLOCK_RE = /\bblock\s*([a-z0-9]{1,4})\b/i;
const STREET_RE = /\b(?:street|st\.?)\s*(\d{1,4})\b/i;
const SCHEME_RE = /\bscheme\s*(\d{1,3})\b/i;

function parsePhaseNumber(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return String(parseInt(s, 10));
  if (PHASE_WORD_NUM[s] != null) return String(PHASE_WORD_NUM[s]);
  return null;
}

function isPhaseLikePlace(name) {
  return /^(phase|street|st|block|scheme|sector)(\s|$)/i.test(String(name || '').trim());
}

let gazetteerAt = 0;

function prettyPlace(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  if (/^dha$/i.test(raw)) return 'DHA';
  return raw
    .split(/[\s-]+/)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

async function refreshGazetteer(force = false) {
  if (!force && Date.now() - gazetteerAt < 5 * 60 * 1000) return;
  gazetteerAt = Date.now();
  try {
    const rows = await db.query(
      `SELECT LOWER(TRIM(area)) AS n FROM normalized_messages
       WHERE area IS NOT NULL AND TRIM(area) <> ''
       UNION
       SELECT LOWER(TRIM(vicinity)) FROM normalized_messages
       WHERE vicinity IS NOT NULL AND TRIM(vicinity) <> ''
       UNION
       SELECT LOWER(TRIM(city)) FROM normalized_messages
       WHERE city IS NOT NULL AND TRIM(city) <> ''`
    );
    const names = [
      ...SEED_LOCALITIES,
      ...rows.rows.map((r) => r.n).filter((n) => n && !isPhaseLikePlace(n))
    ];
    setExtraLocalities(names);
  } catch (err) {
    console.warn('[ner] gazetteer load failed:', err.message);
  }
}

function findCity(text) {
  const t = String(text || '');
  for (const city of CITIES) {
    const re = new RegExp(`\\b${city.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (re.test(t)) return city;
  }
  return null;
}

function findArea(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  const candidates = [...SEED_LOCALITIES].sort((a, b) => b.length - a.length);
  for (const name of candidates) {
    if (name.length < 3) continue;
    if (CITIES.some((c) => c.toLowerCase() === name)) continue;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (re.test(lower)) return prettyPlace(name);
  }
  const words = lower.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  for (let n = 3; n >= 1; n -= 1) {
    for (let i = 0; i + n <= words.length; i += 1) {
      const phrase = words.slice(i, i + n).join(' ');
      if (/^(phase|street|block|scheme|sector)$/i.test(phrase)) continue;
      const hit = matchLocality(phrase);
      if (!hit || CITIES.some((c) => c.toLowerCase() === hit) || isPhaseLikePlace(hit)) continue;
      return prettyPlace(hit);
    }
  }
  return null;
}

function findVicinity(text) {
  const bits = [];
  const phase = String(text || '').match(PHASE_RE);
  const phaseNum = phase ? parsePhaseNumber(phase[1]) : null;
  if (phaseNum) bits.push(`Phase ${phaseNum}`);
  const block = text.match(BLOCK_RE);
  if (block) bits.push(`Block ${block[1].toUpperCase()}`);
  const scheme = text.match(SCHEME_RE);
  if (scheme) bits.push(`Scheme ${scheme[1]}`);
  const street = text.match(STREET_RE);
  if (street) bits.push(`Street ${street[1]}`);
  return bits.length ? bits.join(', ') : null;
}

function findType(text) {
  for (const [re, type, sub] of TYPE_PATTERNS) {
    if (re.test(text)) return { property_type: type, property_sub_type: sub };
  }
  return { property_type: null, property_sub_type: null };
}

function findSubtype(text, fallback) {
  for (const [re, label] of SUBTYPE_PATTERNS) {
    if (re.test(text)) return label;
  }
  return fallback || null;
}

function findSize(text) {
  const m = String(text || '').match(SIZE_RE);
  if (!m) return { size: null, size_value: null, size_unit: null };
  const a = parseFloat(String(m[1]).replace(/,/g, ''));
  const b = m[2] ? parseFloat(String(m[2]).replace(/,/g, '')) : 0;
  const value = a + (Number.isFinite(b) ? b : 0);
  const rawUnit = String(m[3] || '').toLowerCase();
  // Prefer Sq. Ft. — convert Marla (1 = 225 Sq. Ft.); keep yards/kanal as stated
  let unit = 'Sq. Yd.';
  let outValue = value;
  if (/marla/.test(rawUnit)) {
    unit = 'Sq. Ft.';
    outValue = value * 225;
  } else if (/kanal/.test(rawUnit)) {
    unit = 'Kanal';
  } else if (/ft|feet/.test(rawUnit)) {
    unit = 'Sq. Ft.';
  }
  const size = `${outValue} ${unit}`;
  return { size, size_value: outValue, size_unit: unit };
}

function findPurpose(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(for\s+rent|to\s+rent|rental|for\s+lease|on\s+rent|available for rent)\b/.test(t)) {
    return 'RENT';
  }
  if (
    /\b(for\s+sale|for\s+sell|selling|available for sale|plot for sale|house for sale|to sell|sell my)\b/.test(
      t
    )
  ) {
    return 'SALE';
  }
  if (/\b(buy|buying|purchase|khareed|kharid)\b/.test(t)) return 'SALE';
  if (SIZE_RE.test(t) && /\bdemand\b/.test(t) && !/\brent\b/.test(t)) return 'SALE';
  if (/\bdemand\b/.test(t) && /\b(house|plot|flat|apartment|marla|kanal|phase|dha)\b/.test(t)) {
    return 'SALE';
  }
  return null;
}

function cleanAmountToken(raw) {
  return String(raw || '')
    .replace(/\s*,\s*/g, ',')
    .replace(/,/g, '')
    .trim();
}

function formatUnit(unit) {
  const u = String(unit || '').toLowerCase();
  if (/^cr/.test(u)) return 'Crore';
  if (/^lac|^lakh/.test(u)) return 'Lakh';
  return unit;
}

function findPrice(text) {
  const t = String(text || '');
  const onCallOnly =
    /\b((?:price|demand)\s+on\s+call|on\s+call|demand\s*\?)\b/i.test(t) &&
    !PRICE_UNIT_RE.test(t) &&
    !PRICE_K_RE.test(t) &&
    !PRICE_SLASH_CRORE_RE.test(t) &&
    !PRICE_AT_CR_RE.test(t) &&
    !PRICE_BEFORE_WORD_RE.test(t);
  if (onCallOnly) return { price: null, price_value: null };

  // 1) Explicit unit: 2.50 Crore / 80 Lakh / 22 cr (prefer over bare PKR)
  let m = t.match(PRICE_UNIT_RE);
  if (m) {
    const price = `${m[1]} ${formatUnit(m[2])}`;
    return { price, price_value: parsePriceInPKR(price, '') };
  }

  // 2) @22 cr
  m = t.match(PRICE_AT_CR_RE);
  if (m) {
    const price = `${m[1]} Crore`;
    return { price, price_value: parsePriceInPKR(price, '') };
  }

  // 3) PKR/Rs + optional unit (PKR 2.50 Crore, not "PKR 2")
  m = t.match(PRICE_PKR_FULL_RE);
  if (m) {
    const amount = m[1];
    const unit = m[2] ? formatUnit(m[2]) : null;
    if (unit) {
      const price = `${amount} ${unit}`;
      return { price, price_value: parsePriceInPKR(price, '') };
    }
    const n = parseFloat(amount);
    // Ignore tiny course/spam amounts without a unit
    if (Number.isFinite(n) && n >= 10000) {
      const price = `PKR ${amount}`;
      return { price, price_value: n };
    }
  }

  // 4) Demand 95k / rent 30k
  m = t.match(PRICE_K_RE);
  if (m) {
    const n = parseFloat(m[1]);
    if (Number.isFinite(n)) {
      const price = `${m[1]}k`;
      return { price, price_value: n * 1000 };
    }
  }

  // 5) Broker shorthand Demand 27/-
  m = t.match(PRICE_SLASH_CRORE_RE);
  if (m) {
    const price = `${m[1]} Crore`;
    return { price, price_value: parsePriceInPKR(price, '') };
  }

  // 6) "95, 000 price" / "250,000 demand"
  m = t.match(PRICE_BEFORE_WORD_RE);
  if (m) {
    const n = parseFloat(cleanAmountToken(m[1]));
    if (Number.isFinite(n) && n >= 1000) {
      const price = m[1].replace(/\s*,\s*/g, ',').trim();
      return { price, price_value: n };
    }
  }

  // 7) Demand/budget/asking: 250,000
  m = t.match(PRICE_DEMAND_NUM_RE);
  if (m) {
    const n = parseFloat(cleanAmountToken(m[1]));
    if (Number.isFinite(n) && n >= 1000) {
      const price = m[1].replace(/\s*,\s*/g, ',').trim();
      return { price, price_value: n };
    }
  }

  return { price: null, price_value: null };
}

function inferCity(text, area) {
  const explicit = findCity(text);
  if (explicit) return explicit;
  const blob = `${text} ${area || ''}`.toLowerCase();
  if (/\bdha\s+lahore\b|\blahore\s+dha\b|\bjohar town\b|\bmodel town\b/.test(blob)) return 'Lahore';
  if (/\bdha\s+islamabad\b|\bbahria enclave\b|\bblue area\b/.test(blob)) return 'Islamabad';
  if (/\brawalpindi\b|\brwp\b/.test(blob)) return 'Rawalpindi';
  if (/\bkarachi\b/.test(blob)) return 'Karachi';
  return null;
}

function isPropertyText(text) {
  const t = String(text || '');
  // Jobs / courses / events often mention DHA Phase — not listings
  if (
    /\b(job title|we are hiring|urgently hiring|shift timing|years? of experience|graphic designer|sqa engineer|e-?sports|digital skills|course select)\b/i.test(
      t
    )
  ) {
    return false;
  }
  const hasSize = SIZE_RE.test(t);
  const hasType = /\b(plot|house|flat|apartment|appartments?|bungalow|banglow|shop|farmhouse)\b/i.test(
    t
  );
  const hasPlace =
    /\b(dha|bahria|clifton|gulshan|phase|block|scheme|marla|kanal|yard|defence)\b/i.test(t) ||
    Boolean(findArea(t));
  const hasDeal =
    /\b(for sale|for rent|for lease|plot for|house for|available for|to sell|sell my|demand)\b/i.test(
      t
    ) || /\b(buy|buying|purchase|khareed|kharid|looking to buy|need an? |looking for)\b/i.test(t);
  if (hasSize && (hasDeal || hasPlace || hasType)) return true;
  if (hasDeal && (hasPlace || hasType)) return true;
  if (hasType && hasPlace) return true;
  if (looksLikeOffer(t) && (hasSize || hasDeal)) return true;
  return false;
}

function extractChunk(text, sender, sharedContact) {
  let area = findArea(text);
  if (isPhaseLikePlace(area)) area = null;
  if (area) area = canonicalizePlaceText(area);
  const city = inferCity(text, area);
  let vicinity = findVicinity(text);
  if (vicinity) vicinity = canonicalizePlaceText(vicinity);
  const types = findType(text);
  const size = findSize(text);
  const purpose = findPurpose(text);
  const price = findPrice(text);
  const isProp = isPropertyText(text);
  const contact = extractSharedContacts(text) || sharedContact;
  const summary = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);

  return {
    is_property_listing_or_inquiry: isProp,
    summary: summary || (isProp ? 'Property listing' : 'Chat message'),
    category: isProp ? 'SALES' : 'GENERAL',
    intent: isProp ? (purpose === 'RENT' ? 'Rent listing' : 'Sale listing') : '',
    sentiment: 'NEUTRAL',
    language: /[\u0600-\u06FF]/.test(text) ? 'ur' : 'hinglish',
    confidence_score: isProp ? 0.78 : 0.35,
    purpose: isProp ? purpose : null,
    property_type: isProp ? types.property_type : null,
    property_sub_type: isProp ? findSubtype(text, types.property_sub_type) : null,
    city: isProp ? city : null,
    area: isProp ? area : null,
    vicinity: isProp ? vicinity : null,
    size: isProp ? size.size : null,
    size_value: isProp ? size.size_value : null,
    size_unit: isProp ? size.size_unit : null,
    price: isProp ? price.price : null,
    price_value: isProp ? price.price_value : null,
    contact_number: isProp ? contact : null,
    listing_excerpt: String(text || '').slice(0, 2000),
    entities: {
      products: types.property_type ? [types.property_type] : [],
      dates_mentioned: [],
      action_items: [],
      names: sender ? [sender] : []
    }
  };
}

async function extractMessageSchema(message, sender) {
  await refreshGazetteer();
  const text = String(message || '').trim();
  if (!text) return null;
  const shared = extractSharedContacts(text);
  const chunks = splitPropertyOffers(text);
  const useChunks = chunks.length >= 2;
  if (!useChunks) {
    return extractChunk(text, sender, shared);
  }
  const listings = chunks.map((chunk) => {
    const row = extractChunk(chunk, sender, shared);
    return {
      purpose: row.purpose,
      property_type: row.property_type,
      property_sub_type: row.property_sub_type,
      city: row.city,
      area: row.area,
      vicinity: row.vicinity,
      size: row.size,
      size_value: row.size_value,
      size_unit: row.size_unit,
      price: row.price,
      price_value: row.price_value,
      contact_number: row.contact_number || shared,
      summary: row.summary,
      listing_excerpt: row.listing_excerpt
    };
  });
  const first = extractChunk(chunks[0], sender, shared);
  const anyProp = listings.some((L) =>
    Boolean(L.size || L.purpose || L.area || L.property_type)
  );
  first.is_property_listing_or_inquiry = anyProp || first.is_property_listing_or_inquiry;
  first.listings = anyProp
    ? listings.filter((L) => L.size || L.purpose || L.area || L.property_type)
    : listings;
  return first;
}

module.exports = {
  LOCAL_MODEL,
  extractMessageSchema,
  refreshGazetteer
};
