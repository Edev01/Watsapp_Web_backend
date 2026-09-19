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
  'by', 'from', 'with', 'area', 'plot', 'house', 'main', 'new', 'old', 'ph'
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
    return { isId: null, isMessageId: null, mustGroups: [], phaseNumber: null, displayQuery: '' };
  }

  // msg:123 / message:123 → WhatsApp message id; bare digits → listing id
  const msgId = input.match(/^(?:msg|message|m)[:#\-]?(\d{1,12})$/i);
  if (msgId) {
    return {
      isId: null,
      isMessageId: parseInt(msgId[1], 10),
      mustGroups: [],
      phaseNumber: null,
      displayQuery: input
    };
  }
  if (/^\d{1,12}$/.test(input)) {
    return {
      isId: parseInt(input, 10),
      isMessageId: null,
      mustGroups: [],
      phaseNumber: null,
      displayQuery: input
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

  const tokens = lower.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    if (STOP.has(tok) || consumed.has(tok)) continue;
    if (/^\d{1,2}$/.test(tok) && phaseNumber != null) continue;
    if (tok === 'phase' || ROMAN_TO_INT[tok] || WORD_TO_INT[tok]) continue;

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

  return {
    isId: null,
    isMessageId: null,
    mustGroups: cleaned.slice(0, 6),
    phaseNumber,
    displayQuery: text
  };
}

/**
 * Build SQL fragment + params for smart location match.
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

  if (!parts.length) {
    return { sql: '', parsed };
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
  if (!parsed || parsed.isId != null) return 0;
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
  if (parsed.phaseNumber != null) {
    if (textHasPhase(text, parsed.phaseNumber)) score += 50;
    else score -= 100;
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
