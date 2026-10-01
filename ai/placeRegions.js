/**
 * Karachi parent→child place regions for search expand + listing tags.
 * place_regions DB table is the runtime cache; this seed bootstraps it.
 */

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[_/\\.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Seeded parent regions. children = localities under the parent. */
const REGION_SEED = Object.freeze([
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
    parent_key: 'phase-8',
    aliases: ['phase 8', 'phase-8', 'phase viii', 'pha 8', 'ph 8', 'dha phase 8'],
    children: [
      'phase 8',
      'phase-8',
      'phase viii',
      'dha phase 8',
      'd.h.a phase 8'
    ]
  },
  {
    parent_key: 'phase-7',
    aliases: ['phase 7', 'phase-7', 'phase vii', 'ph 7', 'dha phase 7'],
    children: ['phase 7', 'phase-7', 'phase vii', 'dha phase 7']
  },
  {
    parent_key: 'phase-6',
    aliases: ['phase 6', 'phase-6', 'phase vi', 'ph 6', 'dha phase 6'],
    children: ['phase 6', 'phase-6', 'phase vi', 'dha phase 6']
  },
  {
    parent_key: 'phase-5',
    aliases: ['phase 5', 'phase-5', 'phase v', 'ph 5', 'dha phase 5'],
    children: ['phase 5', 'phase-5', 'phase v', 'dha phase 5']
  },
  {
    parent_key: 'clifton',
    aliases: ['clifton', 'clifton karachi'],
    children: ['clifton', 'block 2 clifton', 'block 4 clifton', 'block 5 clifton', 'boat basin', 'seaview']
  }
]);

/** child → parent_keys (a child can sit under multiple parents, e.g. TBZ → malir + airport) */
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
    // parent itself
    if (!map.has(r.parent_key)) map.set(r.parent_key, new Set());
    map.get(r.parent_key).add(r.parent_key);
  }
  return map;
}

const CHILD_TO_PARENTS = buildChildToParents(REGION_SEED);

/**
 * Tags for a listing from area/vicinity/city (+ optional google components).
 * Always includes matched locality + its parent regions.
 */
function tagsFromPlaceFields({ area, vicinity, city, extra = [] } = {}) {
  const tags = new Set();
  const blobs = [area, vicinity, city, ...extra]
    .map(norm)
    .filter(Boolean);

  const phraseIn = (blob, phrase) => {
    if (!blob || !phrase) return false;
    if (blob === phrase) return true;
    // Require full phrase as a token sequence (avoid "tariq" → "tariq bin ziyad")
    const re = new RegExp(
      `(?:^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`
    );
    return re.test(blob);
  };

  for (const blob of blobs) {
    tags.add(blob);
    if (CHILD_TO_PARENTS.has(blob)) {
      for (const p of CHILD_TO_PARENTS.get(blob)) tags.add(p);
    }
    for (const [child, parents] of CHILD_TO_PARENTS.entries()) {
      if (child.length < 4) continue;
      if (!phraseIn(blob, child)) continue;
      tags.add(child);
      for (const p of parents) tags.add(p);
    }
  }

  return [...tags].filter((t) => t && t.length >= 3).slice(0, 40);
}

/**
 * Classify a user search query:
 * - parentRegion: expand to children
 * - exact: match only that locality (+ aliases/spellings)
 */
function classifyLocationQuery(rawQuery, regions = REGION_SEED) {
  const q = norm(rawQuery);
  if (!q) return { mode: 'none', terms: [], parentKey: null };

  // Parent hit?
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
  // Common spellings for Tariq bin Ziyad
  if (/tariq|tbz|ziyad|ziad|zyad/.test(q)) {
    ['tariq bin ziyad', 'tariq bin ziad', 'tariq bin zyad', 'tbz'].forEach((t) =>
      terms.add(t)
    );
  }

  return { mode: 'exact', parentKey: null, terms: [...terms].filter(Boolean) };
}

function seedRows() {
  return REGION_SEED.map((r) => ({
    parent_key: r.parent_key,
    aliases: r.aliases || [],
    children: r.children || [],
    source: 'seed'
  }));
}

module.exports = {
  REGION_SEED,
  CHILD_TO_PARENTS,
  norm,
  tagsFromPlaceFields,
  classifyLocationQuery,
  seedRows,
  buildChildToParents
};
