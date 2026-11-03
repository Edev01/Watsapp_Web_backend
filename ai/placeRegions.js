/**
 * Karachi parent→child place regions for search expand.
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

module.exports = {
  REGION_SEED,
  norm,
  classifyLocationQuery,
  seedRows,
  isDhaPhaseParent,
  loadDhaRegionsFromJson
};
