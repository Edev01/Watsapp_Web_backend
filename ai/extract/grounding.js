/**
 * Keep stored listing fields that the raw WhatsApp text actually supports.
 * Invented phase / sibling precincts / series-as-size are dropped.
 * Spelling expansions (Comm → Commercial, Khy → Khayaban, Ext → Extension) stay.
 */

const { parseSize } = require('./parsers');
const {
  applyBtkListing,
  parsePrecincts,
  listingPrecincts,
} = require('../btkPrecincts');

const PHASE_TOKEN_RE = /\b(?:phase|ph)\.?\s*[-#:]?\s*(\d{1,2}|[ivx]{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)(?![0-9])/gi;
const PHASE_LIST_RE = /\b(?:phase|ph)\.?\s*[-#:]?\s*(\d{1,2})(?:\s*(?:,|&|and|\/|\+)\s*(?:phase\s*)?(\d{1,2}))+/gi;
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function fold(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/khayaban[\s-]*e[\s-]*/g, 'khayaban ')
    .replace(/\bkhy(?:[\s-]*e)?\b/g, 'khayaban ')
    .replace(/\bkhe\b/g, 'khayaban ')
    .replace(/\bkh[\s-]+e\b/g, 'khayaban ')
    .replace(/\bdefen[cs]e\b/g, 'defence ')
    .replace(/\bcom\b/g, 'commercial ')
    .replace(/(\d+)(?:st|nd|rd|th)\b/g, '$1')
    .replace(/\b(?:st|str)\b/g, 'street')
    .replace(/\b(?:rd)\b/g, 'road')
    .replace(/\b(?:ln)\b/g, 'lane')
    .replace(/\bph(?:ase)?\b/g, 'phase')
    .replace(/\bext(?:n|ention)?\b/g, 'extension')
    .replace(/\bcomm(?:ercial|erce|ericai?l)?\b/g, 'commercial')
    .replace(/\bprecints?\b/g, 'precinct')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function phaseNumber(raw) {
  const t = String(raw || '').toLowerCase();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return ROMAN[t] ?? WORDS[t] ?? null;
}

function phasesIn(text) {
  const out = [];
  const src = String(text || '');
  const push = (raw) => {
    const n = phaseNumber(raw);
    if (n >= 1 && n <= 12 && !out.includes(n)) out.push(n);
  };
  PHASE_LIST_RE.lastIndex = 0;
  let list;
  while ((list = PHASE_LIST_RE.exec(src))) {
    const chunk = list[0];
    for (const num of chunk.match(/\d{1,2}/g) || []) push(num);
  }
  PHASE_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = PHASE_TOKEN_RE.exec(src))) push(m[1]);
  return out;
}

function isBtkRow(excerpt, message, row) {
  const local = `${excerpt} ${row.area || ''} ${row.vicinity || ''}`;
  if (parsePrecincts(excerpt).length) return true;
  if (/\b(?:btk|bahria town(?:\s+karachi)?)\b/i.test(local)) return true;
  if (/\b(?:btk|bahria town(?:\s+karachi)?)\b/i.test(message) && !/\bdha\b/i.test(excerpt)) return true;
  if (/\bbahria\b/i.test(row.area || '') && !/\bdha\b/i.test(excerpt)) return true;
  return false;
}

function phraseIn(phrase, source) {
  const p = fold(phrase);
  const s = fold(source);
  if (!p) return true;
  if (!s) return false;
  if (s.includes(p)) return true;
  if (/^p\d{1,2}[a-z]?$/.test(p) && (s.includes(`p ${p.slice(1)}`) || s.includes(`precinct ${p.slice(1)}`))) return true;
  if (/^precinct \d{1,2}[a-z]?$/.test(p)) {
    const code = p.replace('precinct ', '');
    if (s.includes(`p${code}`) || s.includes(`p ${code}`)) return true;
  }
  const tokens = p.split(' ').filter((t) => t.length > 1 || /^\d/.test(t));
  if (tokens.length >= 2 && tokens.every((t) => s.includes(t))) return true;
  if (/khayaban|commercial/.test(p) && tokens.length && s.includes(tokens[tokens.length - 1])) return true;
  return false;
}

function knownPlacePhase(text) {
  const blob = String(text || '');
  if (/\b(?:a|b)\s*market\b/i.test(blob)) return 2;
  if (/\bzone\s*[a-e]\b/i.test(blob) || /\bd[\s-]*cutting\b/i.test(blob)) return 8;
  return null;
}

function streetFrom(excerpt) {
  const m = String(excerpt || '').match(/\b(?:street|st\.?|road|rd\.?|lane|ln\.?)\s*[-:]?\s*(\d+[A-Za-z]?)\b/i);
  if (!m) return null;
  const kind = /road|rd/i.test(m[0]) ? 'Road' : /lane|ln/i.test(m[0]) ? 'Lane' : 'Street';
  return `${kind} ${String(m[1]).toUpperCase()}`;
}

function seriesSize(excerpt, sizeValue) {
  if (sizeValue == null) return false;
  const n = Number(sizeValue);
  if (!n) return false;
  const re = new RegExp(`(?<!\\d)${n}(?:\\.0+)?\\s*(?:s\\b|series|ser\\b)`, 'i');
  if (!re.test(String(excerpt || ''))) return false;
  return parseSize(excerpt).value == null;
}

function same(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a || []) === JSON.stringify(b || []);
  if (a == null && b == null) return true;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a || '') === String(b || '');
}

function isStreetish(text) {
  return /\b(?:street|st\.?|road|rd\.?|lane|ln\.?)\s*[-:]?\s*\d/i.test(String(text || ''));
}

function tagAllowed(tag, excerpt, message, btk, allowedPhases) {
  const t = String(tag || '').trim();
  if (!t) return false;
  const low = t.toLowerCase();
  if (low === 'btk' || low === 'bahria town karachi' || low === 'bahria town') {
    return btk;
  }
  if (/^phase\s+\d{1,2}/i.test(t)) {
    if (btk) return false;
    return allowedPhases.has(Number(String(t).match(/\d{1,2}/)[0]));
  }
  if (/^sector\s+/i.test(t)) {
    const code = fold(t).replace(/^sector /, '');
    return fold(excerpt).includes(code) || fold(excerpt).includes(fold(t));
  }
  if (/^precinct\s+\d{1,2}[a-z]?$/i.test(t) || /^p\d{1,2}[a-z]?$/i.test(t)) {
    return parsePrecincts(excerpt).some((c) => phraseIn(t, `P${c} Precinct ${c}`));
  }
  if (isStreetish(t)) return phraseIn(t, excerpt);
  if (phraseIn(t, excerpt)) return true;
  if (
    phraseIn(t, message)
    && !isStreetish(t)
    && !/^phase\s/i.test(t)
    && !/^precinct\s/i.test(t)
    && !/^p\d{1,2}[a-z]?$/i.test(t)
  ) return true;
  return false;
}

function correctListingFields(row, messageText) {
  const next = { ...row, place_tags: Array.isArray(row.place_tags) ? row.place_tags.slice() : [] };
  const excerpt = String(row.listing_excerpt || '').trim();
  const message = String(messageText || '');
  const btk = isBtkRow(excerpt, message, row);

  const origSize = { size: row.size, size_value: row.size_value, size_unit: row.size_unit };
  if (btk) applyBtkListing(next, `${excerpt} ${message}`);
  next.size = origSize.size;
  next.size_value = origSize.size_value;
  next.size_unit = origSize.size_unit;

  const excerptPhases = phasesIn(excerpt);
  const messagePhases = phasesIn(message);
  const known = btk ? null : knownPlacePhase(excerpt);
  let phase = row.phase == null ? null : Number(row.phase);
  if (btk) phase = null;
  else if (excerptPhases.length) phase = excerptPhases[0];
  else if (known) phase = known;
  else if (/\bsector\s*\d/i.test(excerpt) || /\bdha\s*city\b|\bdck\b/i.test(`${excerpt} ${row.area || ''}`)) {
    phase = null;
  }
  else if (phase && excerptPhases.includes(phase)) { /* keep */ }
  else if (messagePhases.length === 1) {
    const needle = excerpt.slice(0, 40);
    const idx = needle ? message.toLowerCase().indexOf(needle.toLowerCase()) : -1;
    const before = idx >= 0 ? message.slice(0, idx) : '';
    phase = phasesIn(before).includes(messagePhases[0]) ? messagePhases[0] : null;
  } else {
    phase = null;
  }

  const allowedPhases = new Set(excerptPhases);
  if (phase) allowedPhases.add(phase);
  if (row.phase_max != null && (excerptPhases.includes(Number(row.phase_max)) || messagePhases.includes(Number(row.phase_max)))) {
    allowedPhases.add(Number(row.phase_max));
  }

  next.phase = phase;
  if (next.phase_max != null) {
    const mx = Number(next.phase_max);
    if (btk || !allowedPhases.has(mx)) next.phase_max = null;
  }

  if (btk) next.area = 'Bahria Town Karachi';
  else if (next.area && /\bbahria\b/i.test(next.area) && !btk) next.area = null;

  const street = streetFrom(excerpt);
  if (next.street_text && !phraseIn(next.street_text, excerpt)) next.street_text = street;
  else if (!next.street_text && street) next.street_text = street;

  if (next.location_text) {
    const loc = String(next.location_text);
    const badPhase = phasesIn(loc).some((n) => !allowedPhases.has(n));
    const badPrecinct = parsePrecincts(loc).length && !parsePrecincts(excerpt).length;
    const badStreet = isStreetish(loc) && !phraseIn(loc, excerpt);
    const wrongSociety = btk && /\bdha\b/i.test(loc) && !/\bbahria\b/i.test(loc);
    if (badPhase || badPrecinct || badStreet || wrongSociety) next.location_text = null;
  }

  const codes = listingPrecincts({ ...next, listing_excerpt: excerpt });
  if (btk && codes.length) {
    const parts = codes.map((c) => `Precinct ${c}`);
    if (street) parts.push(street);
    next.vicinity = parts.join(', ');
  } else {
    const parts = String(next.vicinity || '').split(',').map((p) => p.trim()).filter(Boolean);
    const kept = [];
    for (const part of parts) {
      if (/^phase\s+\d{1,2}/i.test(part)) {
        const n = Number(String(part).match(/\d{1,2}/)[0]);
        if (!btk && allowedPhases.has(n)) kept.push(part.replace(/\bph(?:ase)?\b/i, 'Phase'));
        continue;
      }
      if (/^precinct\s+\d/i.test(part) && !codes.length) continue;
      if (/^sector\s+/i.test(part) && phraseIn(part.replace(/^sector\s+/i, ''), excerpt)) {
        kept.push(part);
        continue;
      }
      if (isStreetish(part) && !phraseIn(part, excerpt)) continue;
      if (phraseIn(part, excerpt) || (!isStreetish(part) && phraseIn(part, `${excerpt} ${message}`))) kept.push(part);
    }
    if (street && !kept.some((p) => phraseIn(street, p))) kept.push(street);
    if (phase && !btk && !kept.some((p) => /^phase\s/i.test(p))
      && (excerptPhases.length || known || messagePhases.length === 1)) {
      kept.unshift(`Phase ${phase}`);
    }
    for (const n of excerptPhases) {
      if (!kept.some((p) => new RegExp(`^phase\\s+${n}\\b`, 'i').test(p))) kept.push(`Phase ${n}`);
    }
    next.vicinity = kept.filter(Boolean).join(', ') || null;
  }

  next.place_tags = (next.place_tags || []).filter((t) => tagAllowed(t, excerpt, message, btk, allowedPhases));
  const addTag = (label) => {
    if (!label) return;
    if (next.place_tags.some((t) => String(t).toLowerCase() === label.toLowerCase())) return;
    next.place_tags.push(label);
  };
  if (btk) {
    addTag('Bahria Town Karachi');
    addTag('BTK');
    for (const c of codes) {
      addTag(`Precinct ${c}`);
      addTag(`P${c}`);
    }
  } else {
    for (const n of excerptPhases.length ? excerptPhases : (phase ? [phase] : [])) addTag(`Phase ${n}`);
  }
  if (street) addTag(street);

  if (seriesSize(excerpt, next.size_value)) {
    next.size = null;
    next.size_value = null;
    next.size_unit = null;
  }

  const changes = [];
  for (const key of [
    'city', 'area', 'vicinity', 'phase', 'phase_max', 'place_tags', 'location_text', 'street_text',
    'size', 'size_value', 'size_unit', 'price', 'price_value', 'listing_kind', 'category',
  ]) {
    if (!same(row[key], next[key])) changes.push(key);
  }
  return { row: next, changes };
}

module.exports = {
  correctListingFields,
  phasesIn,
  phraseIn,
};
