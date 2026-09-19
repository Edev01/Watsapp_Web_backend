/**
 * Smart location query parsing for Pakistan real-estate search.
 * AND-groups of synonyms + boundary-safe phase matching
 * (so "phase vi" never matches "phase viii").
 */

const {
  correctLocalityTypos,
  localityVariants,
  matchLocality,
  editDistance
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
  'tower', 'towers', 'commercial', 'between', 'corner'
]);

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
  const forms = new Set([t]);
  if (t === 'dha' || t === 'defence' || t === 'defense') {
    ['dha', 'defence', 'defense', 'defance'].forEach((x) => forms.add(x));
  }
  const hit = matchLocality(t);
  if (hit) localityVariants(hit).forEach((v) => forms.add(v.toLowerCase()));
  return [...forms];
}

function khayabanForms(name) {
  const n = String(name || '').toLowerCase().trim();
  if (!n) return [];
  const forms = new Set();
  [
    `khayaban-e-${n}`,
    `khayaban e ${n}`,
    `khayaban ${n}`,
    `khy-e-${n}`,
    `khy e ${n}`,
    `khy-${n}`,
    `kh-e-${n}`,
    `kh e ${n}`,
    `kh ${n}`,
    `khyaban-e-${n}`,
    `khyaban e ${n}`,
    `kh rizwan`.includes(n) ? null : null,
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
      displayQuery: '',
      rawQuery: ''
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
      displayQuery: input,
      rawQuery: input
    };
  }
  if (/^\d{1,12}$/.test(input)) {
    return {
      isId: parseInt(input, 10),
      isMessageId: null,
      mustGroups: [],
      phaseNumber: null,
      displayQuery: input,
      rawQuery: input
    };
  }

  let text = correctPhaseTypos(input);
  text = correctLocalityTypos(text);
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

  // Khayaban / Khy-e-X
  const khyRe =
    /\b(?:khayaban|khyaban|khy|kh)\s*-?\s*e?\s*-?\s*([a-z][a-z0-9]{2,})\b/i;
  const khyMatch = lower.match(khyRe);
  if (khyMatch) {
    mustGroups.push(khayabanForms(khyMatch[1]));
    consumed.add(khyMatch[1].toLowerCase());
    ['khayaban', 'khyaban', 'khy', 'kh', 'e'].forEach((w) => consumed.add(w));
  }

  const tokens = lower.split(/[\s,&/|]+/).map(cleanToken).filter(Boolean);
  for (const tok of tokens) {
    if (STOP.has(tok) || consumed.has(tok)) continue;
    if (/^\d{1,2}$/.test(tok) && phaseNumber != null) continue;
    if (tok === 'phase' || ROMAN_TO_INT[tok] || WORD_TO_INT[tok]) continue;
    // ordinals like 25th / 4th are weak alone — keep only with street context via direct match
    if (/^\d{1,3}(st|nd|rd|th)$/i.test(tok)) continue;

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
    mustGroups.push(
      [spaced, spaced.replace(/\s+/g, '-'), spaced.replace(/\s+/g, '')].filter(Boolean)
    );
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

  return {
    isId: null,
    isMessageId: null,
    mustGroups: capped,
    phaseNumber,
    displayQuery: text,
    rawQuery: input
  };
}

/**
 * Build SQL fragment + params for smart location match.
 * Always OR-match exact/substring area|vicinity|city so every DB place name is searchable.
 */
function buildSmartLocationSql(parsed, searchableExpr, params) {
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
  if (raw.length >= 3) {
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

  if (parsed.phaseNumber != null) {
    if (textHasPhase(text, parsed.phaseNumber)) score += 50;
    else if (score < 80) score -= 100;
    // Penalize other phases dominating vicinity/area
    for (let p = 1; p <= 12; p += 1) {
      if (p === parsed.phaseNumber) continue;
      if (textHasPhase(`${row.vicinity || ''} ${row.area || ''}`, p) && !textHasPhase(`${row.vicinity || ''} ${row.area || ''}`, parsed.phaseNumber)) {
        score -= 40;
      }
    }
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
  textHasPhase,
  scoreLocationMatch,
  khayabanForms,
  correctPhaseTypos
};
