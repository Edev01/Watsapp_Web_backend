/**
 * Karachi parent→child place regions for search expand + listing tags.
 * DHA hierarchy comes from local JSON (no Google Maps).
 * place_regions DB table is a runtime cache seeded from this module.
 */
const fs = require('fs');
const path = require('path');

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[_/\\.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Non-DHA parents still seeded in code (Malir / Airport / Clifton). */
const BASE_REGION_SEED = [
  {
    parent_key: 'malir',
    aliases: ['malir', 'malir karachi', 'malir town'],
    children: [
      'malir',
      'malir cantt',
      'malir cantonment',
      'malir 15',
      'model colony',
      'kala board',
      'liaquat market',
      'liaquatabad malir',
      'anwar ibrahim',
      'bostan e rafi',
      'bostan-e-rafi',
      'gohar green city',
      'gohar green',
      'falaknaz',
      'falak naz',
      'saudabad',
      'jinnah avenue malir',
      'tariq bin ziyad',
      'tariq bin ziad',
      'tariq bin zyad',
      'tbz',
      'scheme 33',
      'gulzar e hijri',
      'memon goth',
      'quaidabad',
      'malir halt'
    ]
  },
  {
    parent_key: 'airport',
    aliases: [
      'airport',
      'karachi airport',
      'jinnah airport',
      'jinnah international airport',
      'airport road',
      'near airport'
    ],
    children: [
      'airport',
      'airport road',
      'near airport',
      'jinnah international airport',
      'malir cantt',
      'malir cantonment',
      'tariq bin ziyad',
      'tariq bin ziad',
      'tariq bin zyad',
      'tbz',
      'kala board',
      'model colony',
      'saudabad',
      'falaknaz',
      'falak naz',
      'gohar green city',
      'gohar green',
      'malir 15',
      'quaidabad'
    ]
  },
  {
    parent_key: 'clifton',
    aliases: ['clifton', 'clifton karachi'],
    children: [
      'clifton',
      'block 2 clifton',
      'block 4 clifton',
      'block 5 clifton',
      'boat basin',
      'seaview',
      'sea view'
    ]
  }
];

function loadDhaRegionsFromJson() {
  const jsonPath = path.join(__dirname, '..', 'data', 'dhaKarachiRegions.json');
  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    const regions = Array.isArray(parsed.regions) ? parsed.regions : [];
    return regions
      .filter((r) => r && r.parent_key)
      .map((r) => ({
        parent_key: String(r.parent_key).trim(),
        aliases: Array.isArray(r.aliases) ? r.aliases.map(String) : [],
        children: Array.isArray(r.children) ? r.children.map(String) : [],
        source: 'local_json'
      }));
  } catch (err) {
    console.warn('[placeRegions] failed to load dhaKarachiRegions.json:', err.message);
    return [];
  }
}

function mergeRegions(base, dha) {
  const byKey = new Map();
  for (const r of [...base, ...dha]) {
    const key = norm(r.parent_key).replace(/\s+/g, '-');
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        parent_key: r.parent_key,
        aliases: [...(r.aliases || [])],
        children: [...(r.children || [])],
        source: r.source || 'seed'
      });
      continue;
    }
    const aliasSet = new Set([...(existing.aliases || []), ...(r.aliases || [])].map(norm));
    const childSet = new Set([...(existing.children || []), ...(r.children || [])].map(norm));
    existing.aliases = [...aliasSet];
    existing.children = [...childSet];
    if (r.source === 'local_json') existing.source = 'local_json';
  }
  return [...byKey.values()];
}

const REGION_SEED = Object.freeze(mergeRegions(BASE_REGION_SEED, loadDhaRegionsFromJson()));

/** child → parent_keys (a child can sit under multiple parents) */
function buildChildToParents(regions) {
  const map = new Map();
  for (const r of regions) {
    const parents = [r.parent_key, ...(r.aliases || [])].map(norm);
    for (const child of r.children || []) {
      const c = norm(child);
      if (!c) continue;
      if (!map.has(c)) map.set(c, new Set());
      map.get(c).add(r.parent_key);
      for (const p of parents) map.get(c).add(norm(p));
    }
    if (!map.has(norm(r.parent_key))) map.set(norm(r.parent_key), new Set());
    map.get(norm(r.parent_key)).add(r.parent_key);
  }
  return map;
}

const CHILD_TO_PARENTS = buildChildToParents(REGION_SEED);

/**
 * Tags for a listing from area/vicinity/city (+ optional extra components).
 * Always includes matched locality + its parent regions.
 */
function tagsFromPlaceFields({ area, vicinity, city, extra = [] } = {}) {
  const tags = new Set();
  const blobs = [area, vicinity, city, ...extra].map(norm).filter(Boolean);

  const phraseIn = (blob, phrase) => {
    if (!blob || !phrase) return false;
    if (blob === phrase) return true;
    const re = new RegExp(
      `(?:^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`
    );
    return re.test(blob);
  };

  const addParentsForChild = (child) => {
    const primary = inferPrimaryDhaPhase(child);
    if (primary) {
      tags.add(`phase-${primary}`);
      tags.add(`phase ${primary}`);
      return;
    }
    const parents = CHILD_TO_PARENTS.get(child);
    if (!parents) return;
    for (const p of parents) tags.add(norm(p));
  };

  for (const blob of blobs) {
    tags.add(blob);
    if (CHILD_TO_PARENTS.has(blob)) addParentsForChild(blob);
    for (const [child] of CHILD_TO_PARENTS.entries()) {
      if (child.length < 4) continue;
      if (!phraseIn(blob, child)) continue;
      tags.add(child);
      addParentsForChild(child);
    }
  }

  return [...tags].filter((t) => t && t.length >= 3).slice(0, 40);
}

/**
 * Classify a user search query:
 * - parent: expand to all children localities (Phase 5 → ittehad, bukhari, …)
 * - exact: match only that locality (+ spellings)
 */
function classifyLocationQuery(rawQuery, regions = REGION_SEED) {
  const q = norm(rawQuery);
  if (!q) return { mode: 'none', terms: [], parentKey: null };

  // "dha phase 5" / "phase 5 dha" → prefer phase parent over bare dha
  const phaseMatch = q.match(/\bphase\s*([0-9]{1,2}|viii|vii|vi|iv|ix|v|iii|ii|i)\b/);
  if (phaseMatch) {
    const token = phaseMatch[1];
    const numMap = {
      i: '1',
      ii: '2',
      iii: '3',
      iv: '4',
      v: '5',
      vi: '6',
      vii: '7',
      viii: '8',
      ix: '9'
    };
    const n = /^\d+$/.test(token) ? token : numMap[token] || null;
    if (n) {
      const want = `phase-${n}`;
      const r = regions.find((x) => norm(x.parent_key) === want || norm(x.parent_key) === `phase ${n}`);
      if (r) {
        const keys = [r.parent_key, ...(r.aliases || [])].map(norm);
        const terms = new Set([r.parent_key, ...keys, ...(r.children || []).map(norm)]);
        return {
          mode: 'parent',
          parentKey: r.parent_key,
          terms: [...terms].filter(Boolean)
        };
      }
    }
  }

  // Parent hit (exact alias / parent_key)
  for (const r of regions) {
    const keys = [r.parent_key, ...(r.aliases || [])].map(norm);
    if (keys.some((k) => k === q || q === k.replace(/-/g, ' '))) {
      const terms = new Set([r.parent_key, ...keys, ...(r.children || []).map(norm)]);
      return {
        mode: 'parent',
        parentKey: r.parent_key,
        terms: [...terms].filter(Boolean)
      };
    }
  }

  // Exact child / locality — collect spelling variants only (no siblings)
  const terms = new Set([q]);
  for (const r of regions) {
    for (const child of r.children || []) {
      const c = norm(child);
      if (c === q || c.includes(q) || q.includes(c)) {
        if (c === q || Math.abs(c.length - q.length) <= 3) {
          terms.add(c);
        }
      }
    }
  }
  if (/tariq|tbz|ziyad|ziad|zyad/.test(q)) {
    ['tariq bin ziyad', 'tariq bin ziad', 'tariq bin zyad', 'tbz'].forEach((t) => terms.add(t));
  }

  return { mode: 'exact', parentKey: null, terms: [...terms].filter(Boolean) };
}

function seedRows() {
  return REGION_SEED.map((r) => ({
    parent_key: r.parent_key,
    aliases: r.aliases || [],
    children: r.children || [],
    source: r.source || 'seed'
  }));
}

/** True when parent_key is a DHA phase (phase-5, phase-8, …). */
function isDhaPhaseParent(parentKey) {
  return /^phase[- ]?\d+$/i.test(String(parentKey || '').replace(/\s+/g, '-'));
}

/**
 * Unambiguous commercial → DHA phase (Karachi). Used to correct LLM/OSM mistakes
 * like tagging Rahat Commercial as Phase 5 (it is Phase 6).
 * Longer keys win.
 */
const PRIMARY_LOCALITY_PHASE = Object.freeze({
  'rahat commercial': 6,
  'khayaban-e-rahat': 6,
  'khayaban e rahat': 6,
  rahat: 6,
  'bukhari commercial': 6,
  'khayaban-e-bukhari': 6,
  'khayaban e bukhari': 6,
  bukhari: 6,
  'ittehad commercial': 6,
  'khayaban-e-ittehad': 6,
  'khayaban e ittehad': 6,
  'shahbaz commercial': 6,
  'nishat commercial': 6,
  'khayaban-e-nishat': 6,
  'sehar commercial': 6,
  'khayaban-e-sehar': 6,
  'muslim commercial': 6,
  'badar commercial': 5,
  'tauheed commercial': 5,
  'toheed commercial': 5,
  'zamzama commercial': 5,
  zamzama: 5,
  'khadda market': 5,
  khadda: 5,
  'stadium market': 5
});

function phraseInBlob(blob, phrase) {
  if (!blob || !phrase) return false;
  if (blob === phrase) return true;
  const re = new RegExp(
    `(?:^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`
  );
  return re.test(blob);
}

/** Infer DHA phase number from message / area / vicinity using local commercial map. */
function inferPrimaryDhaPhase(...texts) {
  const blob = texts.map(norm).filter(Boolean).join(' | ');
  if (!blob) return null;
  const keys = Object.keys(PRIMARY_LOCALITY_PHASE).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (phraseInBlob(blob, norm(key))) return PRIMARY_LOCALITY_PHASE[key];
  }
  return null;
}

function phaseMentionedInText(text) {
  const m = String(text || '').match(/\bphase\s*([0-9]{1,2})\b/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * After LLM/geocode: force correct DHA phase for known commercials when the
 * WhatsApp message did not state a conflicting phase.
 */
function enrichSchemaWithLocalDhaPhase(schema, messageText) {
  if (!schema || typeof schema !== 'object') return schema;
  const msgPhase = phaseMentionedInText(messageText);
  const inferred = inferPrimaryDhaPhase(
    messageText,
    schema.area,
    schema.vicinity,
    schema.city
  );
  if (!inferred) return schema;

  // Explicit phase in the WhatsApp body wins
  const correctPhase = msgPhase || inferred;
  const label = `Phase ${correctPhase}`;
  const out = { ...schema };

  const scrubPhase = (val) => {
    let s = String(val || '').trim();
    if (!s) return s;
    // Drop wrong "phase-N" / "Phase N" tokens not matching correctPhase
    s = s
      .replace(/\bphase[-\s]*([0-9]{1,2})\b/gi, (full, n) =>
        parseInt(n, 10) === correctPhase ? full : ''
      )
      .replace(/[,\s|/]+/g, ' ')
      .replace(/\s*,\s*/g, ', ')
      .replace(/^[\s,|/-]+|[\s,|/-]+$/g, '')
      .trim();
    return s;
  };

  out.area = scrubPhase(out.area) || out.area;
  out.vicinity = scrubPhase(out.vicinity) || out.vicinity;

  const placeBlob = `${out.area || ''} ${out.vicinity || ''}`.toLowerCase();
  if (!/\bphase\s*\d+\b/i.test(placeBlob)) {
    // Prefer putting phase on vicinity (sub-location)
    if (out.vicinity && String(out.vicinity).trim()) {
      out.vicinity = `${String(out.vicinity).trim()}, ${label}`;
    } else if (out.area && String(out.area).trim()) {
      out.area = `${String(out.area).trim()}, ${label}`;
    } else {
      out.vicinity = label;
    }
  } else {
    // Ensure surviving phase token matches correctPhase
    const ensure = (val) => {
      const s = String(val || '');
      if (!/\bphase\s*\d+\b/i.test(s)) return s;
      return s.replace(/\bphase[-\s]*[0-9]{1,2}\b/gi, label);
    };
    out.area = ensure(out.area);
    out.vicinity = ensure(out.vicinity);
  }

  // Normalize OSM junk city
  const city = String(out.city || '').trim();
  if (/کراچی\s*ڈویژن/i.test(city) || /karachi\s*division/i.test(city)) {
    out.city = 'Karachi';
  }

  return out;
}

module.exports = {
  REGION_SEED,
  CHILD_TO_PARENTS,
  PRIMARY_LOCALITY_PHASE,
  norm,
  tagsFromPlaceFields,
  classifyLocationQuery,
  inferPrimaryDhaPhase,
  enrichSchemaWithLocalDhaPhase,
  seedRows,
  buildChildToParents,
  isDhaPhaseParent,
  loadDhaRegionsFromJson
};
