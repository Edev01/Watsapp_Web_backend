/**
 * Smart location query parsing for Pakistan real-estate search.
 * AND-groups of synonyms + boundary-safe phase matching
 * (so "phase vi" never matches "phase viii").
 */

const {
  correctLocalityTypos,
  localityVariants,
  matchLocality,
  editDistance,
  isKhayabanFamilyToken,
  khayabanSearchPatterns,
  canonicalizePlaceText
} = require('./pakistanLocalities');

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

const STOP = new Set([
  'the', 'a', 'an', 'in', 'at', 'of', 'for', 'and', 'or', 'near', 'to', 'on',
  'by', 'from', 'with', 'area', 'plot', 'house', 'main', 'new', 'old', 'ph',
  'street', 'st', 'avenue', 'ave', 'road', 'rd', 'lane', 'ln', 'belt', 'zone',
  'tower', 'towers', 'commercial', 'between', 'corner',
  // Urdu "in" (میں) — often written mein/main/mai; must not become a place
  'mein', 'mai', 'meny', 'mayn', 'me'
]);

/** True when every token is noise (main/mein/new/…) — not a real place query. */
function isWeakOnlyLocationQuery(raw) {
  const toks = normalizeSpaces(raw)
    .toLowerCase()
    .split(/\s+/)
    .map(cleanToken)
    .filter(Boolean);
  if (!toks.length) return true;
  return toks.every(
    (t) => STOP.has(t) || t === 'phase' || ROMAN_TO_INT[t] != null || WORD_TO_INT[t] != null || /^\d{1,2}$/.test(t)
  );
}

function correctPhaseTypos(text) {
  return String(text || '').replace(/[A-Za-z]+/g, (word) => {
    const lower = word.toLowerCase();
    if (lower === 'phase' || lower === 'phasee') {
      return word[0] === word[0].toUpperCase() ? 'Phase' : 'phase';
    }
    if (lower.length >= 3 && lower.length <= 6 && editDistance(lower, 'phase') <= 2 && lower[0] === 'p') {
      return word === word.toUpperCase() ? 'PHASE' : word[0] === word[0].toUpperCase() ? 'Phase' : 'phase';
    }
    return word;
  });
}

function normalizeSpaces(s) {
  return String(s || '')
    .replace(/[–—\-_/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip commas/ampersands so "coral," / "5," never become must-tokens. */
function cleanToken(tok) {
  return String(tok || '')
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .trim();
}

function normalizeLoose(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[&,./\\|]+/g, ' ')
    .replace(/[–—\-_/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePhaseNumber(token) {
  const t = String(token || '').toLowerCase();
  if (/^\d{1,2}$/.test(t)) return parseInt(t, 10);
  if (ROMAN_TO_INT[t]) return ROMAN_TO_INT[t];
  if (WORD_TO_INT[t]) return WORD_TO_INT[t];
  return null;
}

/**
 * Postgres regex that matches phase N with digit/roman/word, without
 * substring collisions (vi ⊂ viii, v ⊂ vii, etc.).
 */
function buildPhaseRegex(num) {
  const n = Number(num);
  const roman = INT_TO_ROMAN[String(n)] || '';
  const word = INT_TO_WORD[String(n)] || '';
  const alts = [String(n)];
  if (roman) alts.push(roman);
  if (word) alts.push(word);
  const body = alts
    .filter(Boolean)
    .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  // phase / ph / pahse / phse / fase, then number — next char must not be a-z/0-9
  return `(^|[^a-z0-9])(phase|pahse|phse|fase|ph)[[:space:]-]*(${body})([^a-z0-9]|$)`;
}

function societyForms(token) {
  const t = String(token || '').toLowerCase().trim();
  if (!t) return [];
  // Bare numbers are too noisy ("%10%" hits 1,100 / phones / 10th)
  if (/^\d+$/.test(t)) return [];
  const forms = new Set([t]);
  if (t === 'dha' || t === 'defence' || t === 'defense') {
    ['dha', 'defence', 'defense', 'defance'].forEach((x) => forms.add(x));
  }
  const hit = matchLocality(t);
  if (hit) localityVariants(hit).forEach((v) => forms.add(v.toLowerCase()));
  return [...forms];
}

/** Boundary-safe "street 10" / "st 10" (not 100, not 10th, not St 10.60 sizes). */
function buildStreetRegex(num) {
  const n = String(parseInt(num, 10));
  // Negative lookahead: reject Street 100 and St 10.60 (size decimals)
  return `(^|[^a-z0-9])(street|st\\.?)[[:space:]\\-#]*${n}(?![0-9.])`;
}

function textHasStreet(text, num) {
  const t = String(text || '').toLowerCase();
  const n = String(parseInt(num, 10));
  const re = new RegExp(`(^|[^a-z0-9])(street|st\\.?)[\\s\\-#]*${n}(?![0-9.])`, 'i');
  return re.test(t);
}

/** Prefer structured place fields — raw dumps often list many streets. */
function streetMatchText(row) {
  // Join with a barrier so "...Street" + "10)..." cannot form "Street 10"
  return [row.area, row.vicinity, row.listing_excerpt, row.summary]
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .join(' | ');
}

function khayabanForms(name) {
  const n = String(name || '').toLowerCase().trim();
  if (!n) return [];
  const forms = new Set();
  [
    `khayaban-e-${n}`,
    `khayaban e ${n}`,
    `khayaban ${n}`,
    `khyaban-e-${n}`,
    `khyaban e ${n}`,
    `khy-e-${n}`,
    `khy e ${n}`,
    `khy-${n}`,
    `kh-e-${n}`,
    `kh e ${n}`,
    `kh ${n}`,
    `khybn ${n}`,
    `khaybn ${n}`,
    `khayabn ${n}`,
    n
  ]
    .filter(Boolean)
    .forEach((v) => forms.add(v));
  return [...forms];
}

/**
 * @returns {{
 *   isId: number|null,
 *   mustGroups: string[][],
 *   phaseNumber: number|null,
 *   displayQuery: string
 * }}
 */
function parseSmartLocationQuery(raw) {
  const input = String(raw || '').trim();
  if (!input) {
    return {
      isId: null,
      isMessageId: null,
      mustGroups: [],
      phaseNumber: null,
      streetNumber: null,
      displayQuery: '',
      rawQuery: '',
      rejectAll: false
    };
  }

  // msg:123 / message:123 → WhatsApp message id; bare digits → listing id
  const msgId = input.match(/^(?:msg|message|m)[:#\-]?(\d{1,12})$/i);
  if (msgId) {
    return {
      isId: null,
      isMessageId: parseInt(msgId[1], 10),
      mustGroups: [],
      phaseNumber: null,
      streetNumber: null,
      displayQuery: input,
      rawQuery: input,
      rejectAll: false
    };
  }
  if (/^\d{1,12}$/.test(input)) {
    return {
      isId: parseInt(input, 10),
      isMessageId: null,
      mustGroups: [],
      phaseNumber: null,
      streetNumber: null,
      displayQuery: input,
      rawQuery: input,
      rejectAll: false
    };
  }

  // "street 10" / "st 10" / "st-10" — dedicated matcher (never bare %10%)
  const streetOnly = input.match(
    /^\s*(?:street|st\.?)\s*[#\-:]?\s*(\d{1,3})\s*$/i
  );
  if (streetOnly) {
    const streetNumber = parseInt(streetOnly[1], 10);
    return {
      isId: null,
      isMessageId: null,
      mustGroups: [],
      phaseNumber: null,
      streetNumber,
      displayQuery: `street ${streetNumber}`,
      rawQuery: input,
      rejectAll: false
    };
  }

  let text = correctPhaseTypos(input);
  text = canonicalizePlaceText(text);
  text = normalizeSpaces(text);
  const lower = text.toLowerCase();

  const mustGroups = [];
  let phaseNumber = null;
  const consumed = new Set();

  // phase 6 / pahse 7 / ph 8 / phase vii
  const phaseRe =
    /\b(?:phase|pahse|phse|fase|ph)\s*([ivxlcdm]{1,6}|\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i;
  const phaseMatch = lower.match(phaseRe);
  if (phaseMatch) {
    phaseNumber = parsePhaseNumber(phaseMatch[1]);
    if (phaseNumber) {
      consumed.add('phase');
      consumed.add('pahse');
      consumed.add('phse');
      consumed.add('fase');
      consumed.add('ph');
      consumed.add(phaseMatch[1].toLowerCase());
    }
  }

  // Khayaban-e-X / typo forms — require a real street name after the stem.
  // Short "kh"/"khy" ONLY match when "e" is present (khy-e-ittehad), so bare
  // "khayaban" is not eaten as kh + ayaban.
  const khyFullRe =
    /\b(?:khayaban|khyaban|khybn|khaybn|khayabn|khayban|khyabn|khayaben)\s*(?:-?\s*e\s*-?\s*|\s+)([a-z][a-z0-9]{2,})\b/i;
  const khyShortRe =
    /\b(?:khy|kh)\s*-?\s*e\s*-?\s*([a-z][a-z0-9]{2,})\b/i;
  const khyMatch = lower.match(khyFullRe) || lower.match(khyShortRe);
  if (khyMatch) {
    mustGroups.push(khayabanForms(khyMatch[1]));
    consumed.add(khyMatch[1].toLowerCase());
    [
      'khayaban', 'khyaban', 'khybn', 'khaybn', 'khayabn', 'khayban', 'khyabn',
      'khayaben', 'khy', 'kh', 'e'
    ].forEach((w) => consumed.add(w));
  }

  const tokens = lower.split(/[\s,&/|]+/).map(cleanToken).filter(Boolean);

  // Bare "khayaban" / "khybn" (no street name) → match entire Khayaban family
  if (!khyMatch) {
    const bareKhy = tokens.find((tok) => isKhayabanFamilyToken(tok));
    if (bareKhy) {
      mustGroups.push(khayabanSearchPatterns());
      consumed.add(bareKhy);
      [
        'khayaban', 'khyaban', 'khybn', 'khaybn', 'khayabn', 'khayban', 'khyabn',
        'khayaben', 'khy', 'kh', 'e'
      ].forEach((w) => consumed.add(w));
    }
  }

  for (const tok of tokens) {
    if (STOP.has(tok) || consumed.has(tok)) continue;
    if (/^\d{1,3}$/.test(tok)) continue; // bare nums never become ILIKE %10%
    if (/^\d{1,2}$/.test(tok) && phaseNumber != null) continue;
    if (tok === 'phase' || ROMAN_TO_INT[tok] || WORD_TO_INT[tok]) continue;
    // ordinals like 25th / 4th are weak alone — keep only with street context via direct match
    if (/^\d{1,3}(st|nd|rd|th)$/i.test(tok)) continue;
    if (isKhayabanFamilyToken(tok)) continue;

    const forms = societyForms(tok);
    if (forms.length) {
      mustGroups.push(forms);
      consumed.add(tok);
      continue;
    }

    if (tok.length >= 3) {
      const group = new Set([tok]);
      const hit = matchLocality(tok);
      if (hit) localityVariants(hit).forEach((v) => group.add(v.toLowerCase()));
      mustGroups.push([...group]);
    }
  }

  if (!mustGroups.length && phaseNumber == null) {
    const spaced = normalizeSpaces(lower);
    // Do not fall back to ILIKE %main%/%mein% — weak-only queries match nothing useful
    if (!isWeakOnlyLocationQuery(spaced)) {
      mustGroups.push(
        [spaced, spaced.replace(/\s+/g, '-'), spaced.replace(/\s+/g, '')].filter(Boolean)
      );
    }
  }

  const cleaned = mustGroups
    .map((g) => [
      ...new Set(
        g
          .map((x) => String(x).trim().toLowerCase())
          .filter((x) => x.length >= 2)
      )
    ])
    .filter((g) => g.length > 0);

  // Cap AND fan-out so long street strings don't over-constrain
  const capped = cleaned.slice(0, phaseNumber != null ? 2 : 3);

  const rejectAll =
    !capped.length &&
    phaseNumber == null &&
    isWeakOnlyLocationQuery(input);

  return {
    isId: null,
    isMessageId: null,
    mustGroups: capped,
    phaseNumber,
    streetNumber: null,
    displayQuery: text,
    rawQuery: input,
    rejectAll
  };
}

/**
 * Build SQL fragment + params for smart location match.
 * Always OR-match exact/substring area|vicinity|city so every DB place name is searchable.
 */
function buildSmartLocationSql(parsed, searchableExpr, params) {
  if (parsed.rejectAll) {
    return { sql: ' AND FALSE ', parsed };
  }

  if (parsed.isMessageId != null) {
    params.push(parsed.isMessageId);
    const idx = params.length;
    return {
      sql: ` AND n.whatsapp_message_id = $${idx} `,
      parsed
    };
  }

  if (parsed.isId != null) {
    params.push(parsed.isId);
    const idx = params.length;
    // Prefer exact listing row id; only if none, match WhatsApp message id (scrap check)
    return {
      sql: ` AND (
        n.id = $${idx}
        OR (
          NOT EXISTS (SELECT 1 FROM normalized_messages nx WHERE nx.id = $${idx})
          AND n.whatsapp_message_id = $${idx}
        )
      ) `,
      parsed
    };
  }

  // Street N: boundary-safe only on place fields (never bare %10%, never raw dump)
  if (parsed.streetNumber != null) {
    const n = parsed.streetNumber;
    const placeExpr =
      `LOWER(CONCAT_WS(' | ', NULLIF(TRIM(COALESCE(n.area,'')), ''), ` +
      `NULLIF(TRIM(COALESCE(n.vicinity,'')), ''), ` +
      `NULLIF(TRIM(COALESCE(n.summary,'')), ''), ` +
      `NULLIF(TRIM(COALESCE(n.listing_excerpt,'')), '')))`;
    params.push(buildStreetRegex(n));
    const reIdx = params.length;
    return {
      sql: ` AND (${placeExpr} ~* $${reIdx}) `,
      parsed
    };
  }

  const parts = [];

  // Boundary-safe phase match (critical: vi must not match viii)
  if (parsed.phaseNumber != null) {
    params.push(buildPhaseRegex(parsed.phaseNumber));
    parts.push(`${searchableExpr} ~* $${params.length}`);
  }

  for (const group of parsed.mustGroups || []) {
    const patterns = group.map((v) => `%${v}%`);
    params.push(patterns);
    parts.push(`${searchableExpr} ILIKE ANY($${params.length})`);
  }

  // Direct place-name match: raw query against area / vicinity / city
  const directParts = [];
  const raw = String(parsed.rawQuery || '').trim();
  if (raw.length >= 3 && !isWeakOnlyLocationQuery(raw)) {
    const exact = raw.toLowerCase();
    const loose = normalizeLoose(raw);
    params.push(exact);
    const exactIdx = params.length;
    directParts.push(`LOWER(TRIM(COALESCE(n.area, ''))) = $${exactIdx}`);
    directParts.push(`LOWER(TRIM(COALESCE(n.vicinity, ''))) = $${exactIdx}`);
    directParts.push(`LOWER(TRIM(COALESCE(n.city, ''))) = $${exactIdx}`);
    params.push(`%${exact}%`);
    const likeIdx = params.length;
    directParts.push(`LOWER(COALESCE(n.area, '')) LIKE $${likeIdx}`);
    directParts.push(`LOWER(COALESCE(n.vicinity, '')) LIKE $${likeIdx}`);
    directParts.push(`LOWER(COALESCE(n.city, '')) LIKE $${likeIdx}`);
    if (loose && loose !== exact) {
      params.push(`%${loose}%`);
      const looseIdx = params.length;
      directParts.push(
        `regexp_replace(LOWER(COALESCE(n.area, '')), '[,&/|]+', ' ', 'g') LIKE $${looseIdx}`
      );
      directParts.push(
        `regexp_replace(LOWER(COALESCE(n.vicinity, '')), '[,&/|]+', ' ', 'g') LIKE $${looseIdx}`
      );
    }
  }

  if (!parts.length && !directParts.length) {
    return { sql: '', parsed };
  }

  if (parts.length && directParts.length) {
    return {
      sql: ` AND ((${parts.join(' AND ')}) OR (${directParts.join(' OR ')})) `,
      parsed
    };
  }
  if (directParts.length) {
    return { sql: ` AND (${directParts.join(' OR ')}) `, parsed };
  }
  return {
    sql: ` AND (${parts.join(' AND ')}) `,
    parsed
  };
}

/** JS-side guard: does text contain phase N with proper boundaries? */
function textHasPhase(text, num) {
  const t = String(text || '').toLowerCase();
  const roman = INT_TO_ROMAN[String(num)] || '';
  const word = INT_TO_WORD[String(num)] || '';
  const alts = [String(num), roman, word].filter(Boolean).join('|');
  const re = new RegExp(
    `(^|[^a-z0-9])(phase|pahse|phse|fase|ph)[\\s\\-]*(${alts})([^a-z0-9]|$)`,
    'i'
  );
  return re.test(t);
}

function scoreLocationMatch(row, parsed) {
  if (!parsed || parsed.isId != null || parsed.isMessageId != null) return 0;
  const text = [
    row.area,
    row.vicinity,
    row.city,
    row.summary,
    row.listing_excerpt,
    row.raw_message
  ]
    .map((x) => String(x || '').toLowerCase())
    .join(' ');

  let score = 0;
  const raw = String(parsed.rawQuery || '').toLowerCase().trim();
  const area = String(row.area || '').toLowerCase().trim();
  const vicinity = String(row.vicinity || '').toLowerCase().trim();
  const city = String(row.city || '').toLowerCase().trim();
  if (raw && (area === raw || vicinity === raw || city === raw)) score += 120;
  else if (raw && (area.includes(raw) || vicinity.includes(raw) || city.includes(raw))) score += 80;

  if (parsed.streetNumber != null) {
    if (textHasStreet(streetMatchText(row), parsed.streetNumber)) score += 80;
    else score -= 100;
  }

  if (parsed.phaseNumber != null) {
    if (textHasPhase(text, parsed.phaseNumber)) score += 100;
    else if (score < 80) score -= 100;
    // Penalize other phases dominating vicinity/area
    for (let p = 1; p <= 12; p += 1) {
      if (p === parsed.phaseNumber) continue;
      if (textHasPhase(`${row.vicinity || ''} ${row.area || ''}`, p) && !textHasPhase(`${row.vicinity || ''} ${row.area || ''}`, parsed.phaseNumber)) {
        score -= 40;
      }
    }
  }
  // Weak token "main" alone in area should not outrank real phase hits
  const areaVic = `${area} ${vicinity}`;
  if (/\bmain\b/i.test(areaVic) && !/\bphase\b/i.test(areaVic) && parsed.phaseNumber != null) {
    score -= 30;
  }
  for (const group of parsed.mustGroups || []) {
    if (group.some((g) => text.includes(String(g).toLowerCase()))) score += 20;
  }
  return score;
}

module.exports = {
  parseSmartLocationQuery,
  buildSmartLocationSql,
  buildPhaseRegex,
  buildStreetRegex,
  textHasPhase,
  textHasStreet,
  streetMatchText,
  scoreLocationMatch,
  khayabanForms,
  correctPhaseTypos
};
