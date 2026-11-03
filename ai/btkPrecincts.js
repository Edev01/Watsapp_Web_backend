/**
 * Bahria Town Karachi precincts (P10A) — not DHA phases.
 * Sq-yd cuttings come from the BTK key plan. Written size always wins.
 */
const DATA = require('../data/btkKarachiPrecincts.json');

const PRECINCT_WORD = /\b(?:precincts?|precints?)\s*[-:]?\s*(\d{1,2}[A-Za-z]?)\b/gi;
const P_CODE = /(?:^|[^A-Za-z])P[\.\-\s]?(\d{1,2}[A-Za-z]?)\b/gi;
const NOT_BTK =
  /\b(?:bahria\s+(?:rwp|rawalpindi|lahore|islamabad|enclave|heights)|khayaban[\s-]*e[\s-]*bahria)\b/i;

function normPrecinct(raw) {
  const t = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const m = t.match(/^(\d{1,2})([A-Z]?)$/);
  if (!m) return null;
  return `${parseInt(m[1], 10)}${m[2] || ''}`;
}

function parentOf(code) {
  const n = String(code || '').match(/^(\d{1,2})/);
  return n ? String(parseInt(n[1], 10)) : null;
}

const CUTTING_BY_PRECINCT = (() => {
  const map = new Map();
  for (const [yards, list] of Object.entries(DATA.cuttings || {})) {
    const n = Number(yards);
    for (const raw of list) {
      const code = normPrecinct(raw);
      if (!code) continue;
      if (!map.has(code)) map.set(code, []);
      if (!map.get(code).includes(n)) map.get(code).push(n);
    }
  }
  for (const arr of map.values()) arr.sort((a, b) => a - b);
  return map;
})();

const ALL_CODES = [...new Set([
  ...CUTTING_BY_PRECINCT.keys(),
  DATA.apartmentPrecinct,
  DATA.farmhousePrecinct,
].map(normPrecinct).filter(Boolean))].sort((a, b) => {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  if (na !== nb) return na - nb;
  return a.localeCompare(b);
});

function isBtkKarachiText(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (NOT_BTK.test(t) && !/\b(?:btk|bahria town karachi)\b/i.test(t)) return false;
  if (/\b(?:btk|bahria town karachi|bahria town)\b/i.test(t)) return true;
  if (/\bbahria\b/i.test(t) && !/\b(lahore|islamabad|rawalpindi|\brwp\b)\b/i.test(t)) return true;
  if (PRECINCT_WORD.test(t)) return true;
  PRECINCT_WORD.lastIndex = 0;
  return false;
}

function parsePrecincts(text) {
  const seen = new Set();
  const out = [];
  const push = (raw) => {
    const code = normPrecinct(raw);
    if (!code || seen.has(code)) return;
    seen.add(code);
    out.push(code);
  };
  const src = String(text || '');
  for (const re of [PRECINCT_WORD, P_CODE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) push(m[1]);
  }
  return out;
}

function expandParent(code) {
  const exact = normPrecinct(code);
  if (!exact) return [];
  const letter = /[A-Z]$/.test(exact);
  if (letter) return [exact];
  const parent = parentOf(exact);
  return ALL_CODES.filter((c) => parentOf(c) === parent);
}

function sizesForPrecincts(codes) {
  const yards = new Set();
  for (const code of codes || []) {
    for (const n of expandParent(code)) {
      for (const y of CUTTING_BY_PRECINCT.get(n) || []) yards.add(y);
    }
  }
  return [...yards].sort((a, b) => a - b);
}

function precinctLabel(code) {
  const n = normPrecinct(code);
  return n ? `Precinct ${n}` : '';
}

function precinctSearchTerms(code) {
  const n = normPrecinct(code);
  if (!n) return [];
  return [
    `precinct ${n}`,
    `precinct-${n}`,
    `p${n}`,
    `p ${n}`,
    `p.${n}`,
    `p-${n}`,
  ];
}

function chipLabels() {
  return ALL_CODES.map(precinctLabel);
}

function listingPrecincts(row) {
  const excerpt = String(row?.listing_excerpt || row?.listingExcerpt || '').trim();
  const fromExcerpt = parsePrecincts(excerpt);
  if (fromExcerpt.length) return fromExcerpt;
  if (excerpt) return [];
  return parsePrecincts([
    row?.vicinity,
    row?.location_text,
    ...(Array.isArray(row?.place_tags) ? row.place_tags : []),
    ...(Array.isArray(row?.placeTags) ? row.placeTags : []),
  ].join(' '));
}

function inferredYardages(row) {
  if (row?.size_value != null && String(row.size_value).trim() !== '') return null;
  const codes = listingPrecincts(row);
  if (!codes.length) return null;
  const yards = sizesForPrecincts(codes);
  return yards.length ? yards : null;
}

function applyBtkListing(row, messageText = '', opts = {}) {
  if (!row || !row.is_property) return row;
  const blob = [
    messageText,
    row.listing_excerpt,
    row.area,
    row.vicinity,
    row.location_text,
    row.street_text,
    row.property_type,
    ...(Array.isArray(row.place_tags) ? row.place_tags : []),
  ].join(' ');
  if (NOT_BTK.test(blob) && !/\b(?:btk|bahria town karachi)\b/i.test(blob)) return row;

  const excerpt = String(row.listing_excerpt || '').trim();
  let codes = parsePrecincts(excerpt);
  if (!codes.length && Array.isArray(opts.precincts) && opts.precincts.length) {
    codes = opts.precincts.map(normPrecinct).filter(Boolean);
  }
  if (!codes.length && !excerpt) {
    codes = parsePrecincts(`${row.vicinity || ''} ${row.location_text || ''}`);
  }
  const btk = isBtkKarachiText(blob) || codes.some((c) => CUTTING_BY_PRECINCT.has(c) || c === DATA.apartmentPrecinct || c === DATA.farmhousePrecinct);
  if (!btk) return row;

  const type = String(row.property_type || '').toUpperCase();
  if (!codes.length) {
    if (/\b(apartment|flat|penthouse|tower)\b/i.test(`${type} ${blob}`)) codes = [DATA.apartmentPrecinct];
    else if (/\bfarm\s*house\b/i.test(`${type} ${blob}`) || type === 'FARMHOUSE') codes = [DATA.farmhousePrecinct];
  }
  if (!codes.length) {
    if (!/\b(btk|bahria town)/i.test(blob)) return row;
    row.area = row.area && !/\bdha\b/i.test(row.area) ? row.area : 'Bahria Town Karachi';
    row.phase = null;
    row.phase_max = null;
    row.vicinity = stripInventedPhasePhrase(row.vicinity);
    row.location_text = stripInventedPhasePhrase(row.location_text);
    const tags = (Array.isArray(row.place_tags) ? row.place_tags : []).filter((t) => {
      const s = String(t);
      return !/^phase\s+\d+/i.test(s) && !/^precinct\s+\d/i.test(s) && !/^p\d{1,2}[a-z]?$/i.test(s);
    });
    for (const label of ['Bahria Town Karachi', 'BTK']) {
      if (!tags.some((t) => String(t).toLowerCase() === label.toLowerCase())) tags.push(label);
    }
    row.place_tags = tags;
    return row;
  }

  row.phase = null;
  row.phase_max = null;
  row.area = 'Bahria Town Karachi';
  row.vicinity = codes.map(precinctLabel).join(', ');

  const tags = (Array.isArray(row.place_tags) ? row.place_tags : []).filter((t) => {
    const s = String(t);
    return !/^phase\s+\d+/i.test(s) && !/^precinct\s+\d/i.test(s) && !/^p\d{1,2}[a-z]?$/i.test(s);
  });
  const seen = new Set(tags.map((t) => String(t).toLowerCase()));
  const add = (label) => {
    const key = String(label).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(label);
  };
  add('Bahria Town Karachi');
  add('BTK');
  for (const code of codes) {
    add(precinctLabel(code));
    add(`P${code}`);
  }
  row.place_tags = tags;

  const extraOnly = /\bextra\s+land\b/i.test(blob) && !/\d+(?:\.\d+)?\s*(?:\+|and)\s*\d+/i.test(blob)
    && !/\b\d+(?:\.\d+)?\s*(?:sq\.?\s*)?(?:yd|yard|gaz)s?\b/i.test(blob.replace(/\([^)]*extra[^)]*\)/gi, ' '));
  if (extraOnly) {
    row.size_value = null;
    row.size = null;
  }

  const seriesOnly = /\b\d{2,5}\s*(?:s\b|series|ser\b)/i.test(excerpt)
    && !/\b\d+(?:\.\d+)?\s*(?:sq\.?\s*)?(?:yd|yard|gaz|yrd)s?\b/i.test(excerpt);
  if (row.size_value == null && !seriesOnly) {
    const yards = sizesForPrecincts(codes);
    if (yards.length === 1) {
      row.size_value = yards[0];
      row.size_unit = 'Sq. Yd.';
      row.size = row.size || `${yards[0]} Sq. Yd.`;
    }
  }
  return row;
}

function interpretBtkSearch(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (NOT_BTK.test(text) && !/\bbtk\b/i.test(text) && !/\bbahria town karachi\b/i.test(text)) return null;

  const codes = parsePrecincts(text);
  if (codes.length) {
    const code = codes[0];
    const letter = /[A-Z]$/.test(code);
    const match = letter ? [code] : expandParent(code);
    const chips = (match.length ? match : [code]).map(precinctLabel);
    return {
      kind: letter ? 'btk-exact' : 'btk-parent',
      precinct: code,
      matchPrecincts: match.length ? match : [code],
      chips: chips.length ? chips : chipLabels(),
    };
  }

  if (/\b(?:btk|bahria(?:\s+town(?:\s+karachi)?)?)\b/i.test(text)) {
    return { kind: 'btk-all', precinct: null, matchPrecincts: ALL_CODES.slice(), chips: chipLabels() };
  }
  return null;
}

function precinctRegexes(codes) {
  return (codes || []).map((code) => {
    const n = normPrecinct(code);
    const letter = (n.match(/[A-Z]$/) || [''])[0];
    const num = parseInt(n, 10);
    const letterRe = letter ? letter.toLowerCase() : '';
    if (letter) {
      return `(^|[^[:alnum:]])(p|precincts?|precints?)[[:space:].\\-]*${num}${letterRe}([^[:alnum:]]|$)`;
    }
    return `(^|[^[:alnum:]])(p|precincts?|precints?)[[:space:].\\-]*${num}([a-z]([^[:alnum:]]|$)|[^[:alnum:]0-9]|$)`;
  });
}

function btkSearchKeeps(row, parsed) {
  if (!parsed || !String(parsed.regionMode || '').startsWith('btk')) return true;
  const blob = [
    row.area, row.vicinity, row.location_text, row.listing_excerpt, row.summary,
    ...(Array.isArray(row.place_tags) ? row.place_tags : []),
  ].join(' ').toLowerCase();
  if (NOT_BTK.test(blob) && !/\b(?:btk|bahria town karachi)\b/i.test(blob)) return false;
  if (parsed.regionMode === 'btk-all') {
    return isBtkKarachiText(blob) || listingPrecincts(row).length > 0;
  }
  const want = new Set((parsed.btkPrecincts || []).map(normPrecinct));
  const have = listingPrecincts(row);
  if (!have.length) {
    return parsed.regionMode === 'btk-all' && isBtkKarachiText(blob);
  }
  if (parsed.regionMode === 'btk-parent') {
    const parent = parentOf(parsed.precinct) || parentOf([...want][0]);
    return have.some((c) => c === parent || parentOf(c) === parent);
  }
  return have.some((c) => want.has(c));
}

function precinctFromGoogleBlob(blob) {
  const m = String(blob || '').match(/\bprecincts?\s*[-:]?\s*(\d{1,2}[A-Za-z]?)\b/i);
  return m ? normPrecinct(m[1]) : null;
}

function stripInventedPhasePhrase(text) {
  const next = String(text || '')
    .replace(/\bphase\s+\d{1,2}[A-Za-z]?\b/gi, '')
    .replace(/\bph\.?\s*-?\s*\d{1,2}\b/gi, '')
    .replace(/(^|,)\s*,+/g, '$1')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return next || null;
}

function looksLikeBareStreetPlace(name) {
  return /^(?:phase\s+\d{1,2},?\s*)?(?:street|st\.?|road|rd\.?|lane|ln\.?)\s*\d+[A-Za-z]?\b/i.test(String(name || '').trim());
}

async function fillBtkNamedPrecincts(rows, geocodeFn) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const geocode = geocodeFn || (async (place) => {
    const { geocodeAddress } = require('./googlePhaseMap');
    return geocodeAddress(`${place}, Bahria Town Karachi, Pakistan`);
  });
  for (const row of rows) {
    if (!row?.is_property) continue;
    const blob = [row.area, row.vicinity, row.listing_excerpt, ...(row.place_tags || [])].join(' ');
    if (!isBtkKarachiText(blob) && !parsePrecincts(blob).length) continue;
    if (listingPrecincts(row).length) continue;
    const name = String(row.vicinity || row.location_text || row.area || '').trim();
    if (!name || /^(bahria town karachi|btk|bahria town)$/i.test(name)) continue;
    if (looksLikeBareStreetPlace(name)) continue;
    let hit;
    try {
      hit = await geocode(name);
    } catch (_) {
      continue;
    }
    const formatted = String(hit?.formatted || '');
    if (/\b(?:dha|defence|defense)\b/i.test(formatted) && !/\bprecinct/i.test(formatted)) continue;
    const code = precinctFromGoogleBlob(formatted)
      || precinctFromGoogleBlob((hit?.components || []).map((c) => c.long_name || '').join(' '));
    if (!code) continue;
    applyBtkListing(row, row.listing_excerpt || '', { precincts: [code] });
  }
  return rows;
}

module.exports = {
  DATA,
  ALL_CODES,
  normPrecinct,
  parentOf,
  parsePrecincts,
  expandParent,
  sizesForPrecincts,
  precinctLabel,
  precinctSearchTerms,
  chipLabels,
  listingPrecincts,
  inferredYardages,
  applyBtkListing,
  interpretBtkSearch,
  precinctRegexes,
  btkSearchKeeps,
  isBtkKarachiText,
  precinctFromGoogleBlob,
  fillBtkNamedPrecincts,
  stripInventedPhasePhrase,
  looksLikeBareStreetPlace,
};
