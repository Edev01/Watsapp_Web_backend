/**
 * When one WhatsApp message lists several properties under one phase header,
 * ask Google which phase each named place is in. A place Google puts in a
 * different phase is saved as that phase. A phase written on that offer
 * itself is kept.
 *
 * If a listing (including a single offer) has no phase after extract, Google
 * Geocoding fills Phase N from the named place so phase search can match it.
 * BTK precincts and Clifton-only posts are skipped — those are not DHA phases.
 *
 * Key: GOOGLE_MAPS_API_KEY
 */
const PHASE_IN_NAME = /\bphase\s*(?:\d{1,2}|[ivx]{1,5})\b/i;
const SKIP_PLACE = /^(dha|d\.h\.a\.?|defence|defense|defance|karachi|pakistan|clifton)$/i;
const GENERIC_PLACE = /^(commercial|street|block|lane|plot|house|near|main|road|avenue|area|society|phase)$/i;
const ROMAN_PHASE = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12
};

function areaKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addPhaseNumbers(text, into) {
  const source = String(text || '');
  for (const match of source.matchAll(/\bphase\s*(\d{1,2})\b/gi)) {
    const n = Number(match[1]);
    if (n >= 1 && n <= 20) into.add(n);
  }
  for (const match of source.matchAll(/\b(?:phase|defence|defense)\s+(xii|xi|x|ix|viii|vii|vi|iv|v|iii|ii|i)\b/gi)) {
    const n = ROMAN_PHASE[match[1].toLowerCase()];
    if (n) into.add(n);
  }
}

function phaseNumbersFromComponents(components, formatted) {
  const nums = new Set();
  for (const component of components || []) {
    addPhaseNumbers(component.long_name || component.long || '', nums);
  }
  addPhaseNumbers(formatted || '', nums);
  return [...nums];
}

function phaseNameFromNumber(n) {
  return n ? `Phase ${n}` : null;
}

/** A Google result we can treat as an area under a phase, not a floor or a sentence. */
function isSearchablePhaseArea(name) {
  const text = String(name || '').trim();
  const key = areaKey(text);
  if (!key || key.length < 4 || text.length > 42) return false;
  if (/[,:]/.test(text)) return false;
  if (SKIP_PLACE.test(key) || GENERIC_PLACE.test(key)) return false;
  if (/\d+\s*(yard|yds|sq)/i.test(text)) return false;
  if (/\b(floor|bungalow|banglow|plot|demand|front|corner|facing|bedroom|portion|apartment|flat|house|shop|close to|next to|between)\b/i.test(text)) {
    return false;
  }
  return true;
}

/** Area names Google Geocoding placed in this phase. */
async function areasForPhase(db, phaseNumber) {
  const n = Number(phaseNumber);
  if (!n) return [];
  await ensurePhaseTable(db);
  const { rows } = await db.query(
    `SELECT area_name FROM google_phase_places
      WHERE phase_number = $1 AND phase_name IS NOT NULL`,
    [n]
  );
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const name = String(row.area_name || '').trim();
    const key = areaKey(name);
    if (!isSearchablePhaseArea(name) || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function statedPhaseNumbers(row) {
  const nums = new Set();
  const bits = [row?.area, row?.vicinity, row?.location_text, row?.street_text, ...(row?.place_tags || [])];
  for (const bit of bits) addPhaseNumbers(bit, nums);
  return [...nums];
}

function splitPlaces(value) {
  return String(value || '')
    .split(/[,/|]|\s+&\s+|\s+\band\b\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Location strings worth sending to Google, most specific field first. */
function placeCandidates(row) {
  const seen = new Set();
  const out = [];
  const push = (raw) => {
    let text = String(raw || '').replace(/\bphase\s*(?:\d{1,2}|[ivx]{1,5})\b/gi, ' ').replace(/\s+/g, ' ').trim();
    const key = areaKey(text);
    if (!key || key.length < 4 || seen.has(key)) return;
    if (SKIP_PLACE.test(key) || GENERIC_PLACE.test(key) || PHASE_IN_NAME.test(text)) return;
    seen.add(key);
    out.push(text);
  };
  push(row?.area);
  push(row?.location_text);
  push(row?.street_text);
  for (const tag of row?.place_tags || []) push(tag);
  for (const part of splitPlaces(row?.vicinity)) push(part);
  for (const part of splitPlaces(row?.location_text)) push(part);
  for (const part of splitPlaces(row?.street_text)) push(part);
  return out.slice(0, 8);
}

async function ensurePhaseTable(db) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS google_phase_places (
       area_key TEXT PRIMARY KEY,
       area_name TEXT NOT NULL,
       phase_name TEXT,
       phase_number SMALLINT,
       formatted_address TEXT,
       lat DOUBLE PRECISION,
       lng DOUBLE PRECISION,
       updated_at TIMESTAMPTZ DEFAULT NOW()
     )`
  );
}

async function geocodeAddress(address) {
  const key = process.env.GOOGLE_MAPS_API_KEY || '';
  if (!key) return { error: 'GOOGLE_MAPS_API_KEY missing' };
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?' + new URLSearchParams({
    address,
    key,
    region: 'pk'
  });
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results?.[0]) {
    return { error: data.error_message || data.status || 'no result' };
  }
  const top = data.results[0];
  const nums = phaseNumbersFromComponents(top.address_components, top.formatted_address);
  const phaseNumber = nums.length === 1 ? nums[0] : null;
  return {
    phaseNumber,
    phaseName: phaseNameFromNumber(phaseNumber),
    formatted: top.formatted_address || null,
    components: top.address_components || [],
    lat: top.geometry?.location?.lat ?? null,
    lng: top.geometry?.location?.lng ?? null,
    error: nums.length > 1 ? 'multiple_phases' : null
  };
}

async function geocodePlace(place) {
  const queries = [`${place}, Karachi, Pakistan`, `${place}, DHA, Karachi, Pakistan`];
  if (/\bcomm\b/i.test(place)) {
    queries.push(`${place.replace(/\bcomm\b/gi, 'Commercial')}, DHA, Karachi, Pakistan`);
  }
  let last = { error: 'no result' };
  for (const address of queries) {
    const hit = await geocodeAddress(address);
    last = hit;
    if (hit.phaseNumber) return hit;
    if (hit.error === 'GOOGLE_MAPS_API_KEY missing' || /REQUEST_DENIED|API key/i.test(String(hit.error || ''))) {
      return hit;
    }
  }
  return last;
}

async function resolvePlace(db, place) {
  const key = areaKey(place);
  if (!key) return null;
  const cached = await db.query(
    `SELECT area_key, area_name, phase_name, phase_number FROM google_phase_places WHERE area_key = $1`,
    [key]
  );
  if (cached.rows[0]?.phase_name) return cached.rows[0];

  const geo = await geocodePlace(place);
  if (geo.error === 'GOOGLE_MAPS_API_KEY missing' || /REQUEST_DENIED|API key/i.test(String(geo.error || ''))) {
    return null;
  }
  await db.query(
    `INSERT INTO google_phase_places (
       area_key, area_name, phase_name, phase_number, formatted_address, lat, lng, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (area_key) DO UPDATE SET
       phase_name = EXCLUDED.phase_name,
       phase_number = EXCLUDED.phase_number,
       formatted_address = EXCLUDED.formatted_address,
       lat = EXCLUDED.lat,
       lng = EXCLUDED.lng,
       updated_at = NOW()`,
    [key, place, geo.phaseName || null, geo.phaseNumber || null, geo.formatted || null, geo.lat ?? null, geo.lng ?? null]
  );
  return { area_key: key, area_name: place, phase_name: geo.phaseName || null, phase_number: geo.phaseNumber || null };
}

function phasesNamedIn(text) {
  const nums = new Set();
  addPhaseNumbers(text, nums);
  for (const match of String(text || '').matchAll(/\bph\s*-?\s*(\d{1,2})\b/gi)) {
    const n = Number(match[1]);
    if (n >= 1 && n <= 20) nums.add(n);
  }
  return [...nums];
}

function sharedHeaderPhases(rows) {
  const lists = rows.map((row) => phasesNamedIn(row.listing_excerpt)).filter((list) => list.length);
  if (lists.length < 2) return new Set();
  const [first, ...rest] = lists;
  return new Set(first.filter((n) => rest.every((list) => list.includes(n))));
}

function isBareStreet(text) {
  const key = areaKey(text);
  return /^(?:street|st|lane|ln|road)\s*\d+$/.test(key) || /^\d+(?:st|nd|rd|th)?\s+(?:street|st|lane|ln)$/.test(key);
}

/** Place names on this offer, not the shared header and not a bare street number. */
function offerPlaceNames(row) {
  const seen = new Set();
  const out = [];
  const push = (raw) => {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    const key = areaKey(text);
    if (!key || key.length < 4 || seen.has(key) || isBareStreet(text)) return;
    if (SKIP_PLACE.test(key) || GENERIC_PLACE.test(key)) return;
    if (!/\b(khayaban|khyaban|commercial|comm|zone|sahil|sector|block)\b/i.test(text)) return;
    seen.add(key);
    out.push(text);
  };
  const excerpt = String(row?.listing_excerpt || '');
  const named = excerpt.match(
    /\b(?:khayaban(?:\s*-?\s*e)?\s*-?\s*[a-z]{3,}|zone\s+[a-e]|sahil(?:\s+commercial)?|[a-z]{4,}(?:\s+[a-z]{3,})?\s+commercial(?:\s+area)?)\b/gi
  ) || [];
  for (const name of named) push(name);
  for (const place of placeCandidates(row)) push(place);
  return out.slice(0, 4);
}

function replacePhaseMentions(text, from, to) {
  if (!text || from == null || Number(from) === Number(to)) return text;
  const roman = Object.entries(ROMAN_PHASE).find(([, n]) => n === Number(from));
  let out = String(text).replace(
    new RegExp(`\\b((?:dha|defence|defense)\\s+)?phase\\s*0*${Number(from)}\\b`, 'ig'),
    (_, prefix) => `${prefix || ''}Phase ${to}`
  );
  if (roman) {
    out = out.replace(
      new RegExp(`\\b((?:dha|defence|defense)\\s+)?phase\\s+${roman[0]}\\b`, 'ig'),
      (_, prefix) => `${prefix || ''}Phase ${to}`
    );
  }
  return out;
}

function rewriteListingPhase(row, next) {
  const previous = row.phase;
  for (const field of ['vicinity', 'location_text', 'street_text', 'summary']) {
    row[field] = replacePhaseMentions(row[field], previous, next);
  }
  const tags = (Array.isArray(row.place_tags) ? row.place_tags : [])
    .map((tag) => replacePhaseMentions(tag, previous, next));
  const phaseName = phaseNameFromNumber(next);
  if (!tags.some((tag) => areaKey(tag) === areaKey(phaseName))) tags.push(phaseName);
  const seen = new Set();
  row.place_tags = tags.filter((tag) => {
    const key = areaKey(tag);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  row.phase = next;
}

/**
 * Several offers under one phase header. Google's phase for a named place
 * replaces the header when it is different. An offer that writes its own
 * phase keeps that phase.
 */
async function correctSplitListingPhases(rows, lookup) {
  if (!Array.isArray(rows)) return rows;
  const props = rows.filter((row) => row && row.is_property);
  if (props.length < 2) return rows;
  const headerPhases = sharedHeaderPhases(props);
  const ask = lookup || googlePhaseForPlace;
  const cache = new Map();
  for (const row of props) {
    try {
      const { isBtkKarachiText, parsePrecincts } = require('./btkPrecincts');
      const blob = [row.area, row.vicinity, row.listing_excerpt, ...(row.place_tags || [])].join(' ');
      if (isBtkKarachiText(blob) || parsePrecincts(row.listing_excerpt || blob).length) continue;
    } catch (_) { /* optional */ }
    const own = phasesNamedIn(row.listing_excerpt).filter((n) => !headerPhases.has(n));
    if (own.length) continue;
    const phases = new Set();
    let matchedPlace = '';
    for (const place of offerPlaceNames(row)) {
      const key = areaKey(place);
      if (!cache.has(key)) {
        try {
          cache.set(key, await ask(place));
        } catch (err) {
          console.info(`[extract] google phase lookup failed for "${place}": ${String(err.message || err).slice(0, 120)}`);
          cache.set(key, null);
        }
      }
      const n = Number(cache.get(key));
      if (!n) continue;
      phases.add(n);
      if (!matchedPlace) matchedPlace = place;
    }
    if (phases.size !== 1) continue;
    const next = [...phases][0];
    if (next === row.phase) continue;
    const previous = row.phase;
    rewriteListingPhase(row, next);
    console.info(`[extract] listing "${matchedPlace}" is Phase ${next}, not Phase ${previous == null ? 'null' : previous}`);
  }
  return rows;
}

async function googlePhaseForPlace(place) {
  const hit = await geocodePlace(place);
  if (!hit || hit.error === 'GOOGLE_MAPS_API_KEY missing' || /REQUEST_DENIED|API key/i.test(String(hit.error || ''))) {
    return null;
  }
  return hit.phaseNumber || null;
}

function applyPhase(row, n) {
  if (n < 1 || n > 20) return false;
  const phaseName = phaseNameFromNumber(n);
  row.phase = n;
  const tags = Array.isArray(row.place_tags) ? row.place_tags.slice() : [];
  if (!tags.some((t) => String(t).toLowerCase() === phaseName.toLowerCase())) tags.push(phaseName);
  row.place_tags = tags;
  return true;
}

function skipGoogleDhaPhaseFill(row) {
  const blob = [row?.area, row?.vicinity, row?.location_text, row?.street_text, row?.listing_excerpt, ...(row?.place_tags || [])].join(' ');
  try {
    const { isBtkKarachiText, parsePrecincts } = require('./btkPrecincts');
    if (isBtkKarachiText(blob) || parsePrecincts(blob).length) return true;
  } catch (_) { /* optional */ }
  if (/\bclifton\b/i.test(blob) && !/\b(dha|defence|defense)\b/i.test(blob)) return true;
  if (/\bdefence view\b|\bdefense view\b/i.test(blob)) return true;
  return false;
}

/**
 * Fill phase + a "Phase N" search tag where the LLM left phase empty.
 * One phase written in any location field is kept. Otherwise the first
 * location field Google can place in a single phase is used.
 */
async function fillMissingPhases(db, rows, lookup) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  if (!lookup && db) await ensurePhaseTable(db);
  for (const row of rows) {
    if (!row?.is_property || row.phase != null) continue;
    if (skipGoogleDhaPhaseFill(row)) continue;
    const stated = statedPhaseNumbers(row);
    if (stated.length === 1) {
      applyPhase(row, stated[0]);
      continue;
    }
    if (stated.length > 1) continue;
    for (const place of placeCandidates(row)) {
      let n = null;
      if (lookup) {
        n = Number(await lookup(place));
      } else {
        const hit = await resolvePlace(db, place);
        n = Number(hit?.phase_number);
      }
      if (!n) continue;
      if (applyPhase(row, n)) {
        console.info(`[extract] Google filled Phase ${n} for "${place}"`);
        break;
      }
    }
  }
  return rows;
}

function isOnlyPhaseLabel(name, phaseNumber) {
  const key = areaKey(name);
  const n = String(phaseNumber);
  return (
    key === `phase ${n}` ||
    key === `dha phase ${n}` ||
    key === `defence phase ${n}` ||
    key === `defense phase ${n}`
  );
}

const BARE_STEM_BLOCK = new Set([
  'muslim', 'hilal', 'iqbal', 'tariq', 'hafiz', 'corner', 'creek', 'main', 'phase',
  'street', 'commercial', 'avenue', 'lane', 'road', 'block', 'area'
]);

const EXTRA_PHASE_AREAS = {
  2: ['A Market', 'B Market'],
  5: ['Saba Commercial', 'Saba Commercial Area'],
  8: ['Zone A', 'Zone B', 'Zone C', 'Zone D', 'Zone E', 'Khayaban-e-Arafat', 'Arafat', 'D Cutting']
};

/** A real place label. Drops message scraps such as "off Faisal". */
function isPhaseAreaLabel(name) {
  const text = String(name || '').trim();
  if (!isSearchablePhaseArea(text)) return false;
  if (/^(off|near|before|after|behind|opposite|opp|touch|main)\b/i.test(text)) return false;
  if (/\b(off|before|touch|demand|yards?)\b/i.test(text)) return false;
  if (/\bphase\b/i.test(text) && !/\b(commercial|khayaban|street|avenue|lane|road|boulevard)\b/i.test(text)) return false;
  return true;
}

function phaseChildren(phaseNumber) {
  const data = require('../data/dhaKarachiRegions.json');
  const region = (data.regions || []).find((r) => r.parent_key === `phase-${Number(phaseNumber)}`);
  return Array.isArray(region?.children) ? region.children : [];
}

/** Place names worth asking Google about for this phase. Phase aliases are skipped. */
function phasePlaceCandidates(phaseNumber) {
  const seen = new Set();
  const out = [];
  for (const raw of phaseChildren(phaseNumber)) {
    const name = String(raw || '').trim();
    const key = areaKey(name);
    if (!key || seen.has(key) || isOnlyPhaseLabel(name, phaseNumber)) continue;
    const stripped = key
      .replace(/\b(dha|defence|defense|ph)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (stripped === `phase ${phaseNumber}` || stripped === String(phaseNumber)) continue;
    if (!isPhaseAreaLabel(name)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function areaStem(name) {
  const parts = areaKey(name)
    .split(' ')
    .filter((w) => w && !['e', 'khayaban', 'khyaban', 'commercial', 'lane', 'street', 'avenue', 'road'].includes(w));
  return parts[parts.length - 1] || areaKey(name);
}

function titlePlace(name) {
  return String(name || '')
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bE\b/g, 'e');
}

function labelScore(name) {
  let score = String(name || '').length;
  if (/commercial/i.test(name)) score += 50;
  if (/khayaban/i.test(name)) score += 30;
  if (/\b(street|avenue|lane|road|boulevard)\b/i.test(name)) score += 20;
  return score;
}

/** One readable name per place, for the results row. */
function labelsFromConfirmed(names) {
  const groups = new Map();
  for (const name of names || []) {
    if (!isPhaseAreaLabel(name)) continue;
    const stem = areaStem(name);
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push(name);
  }
  const labels = [];
  for (const list of groups.values()) {
    const best = list.slice().sort((a, b) => labelScore(b) - labelScore(a))[0];
    labels.push(titlePlace(best));
  }
  return labels;
}

/** Search strings: the confirmed names, plus a short stem when ads only say "Bukhari". */
function searchTermsFromConfirmed(names) {
  const seen = new Set();
  const out = [];
  const push = (name) => {
    const text = String(name || '').trim();
    const key = areaKey(text);
    if (!key || seen.has(key) || !isPhaseAreaLabel(text)) return;
    seen.add(key);
    out.push(text);
  };
  for (const name of names || []) {
    push(name);
    const stem = areaStem(name);
    if (stem.length >= 5 && !BARE_STEM_BLOCK.has(stem)) push(stem);
  }
  return out;
}

function looksLikePhaseArea(name, types) {
  if (!isSearchablePhaseArea(name)) return false;
  const typeText = (types || []).join(' ');
  if (/neighborhood|sublocality|political|route|locality|geocode/.test(typeText)) return true;
  return /\b(commercial|khayaban|khyaban|street|lane|avenue|boulevard|block|sector|zone|extension|ext)\b/i.test(name);
}

/** Area names from a Places Text Search payload for one DHA phase. */
function collectPhaseAreaNames(results, phaseNumber) {
  const want = Number(phaseNumber);
  const seen = new Set();
  const out = [];
  const push = (name) => {
    const text = String(name || '').trim();
    if (!looksLikePhaseArea(text) || isOnlyPhaseLabel(text, want)) return;
    const key = areaKey(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };

  for (const result of results || []) {
    const blob = `${result?.name || ''} ${result?.formatted_address || ''}`;
    const nums = new Set();
    addPhaseNumbers(blob, nums);
    if (nums.size && !nums.has(want)) continue;
    const mentionsDha = /\b(dha|d\.h\.a|defence|defense)\b/i.test(blob);
    if (!nums.has(want) && !mentionsDha) continue;
    push(result?.name);
    for (const part of String(result?.formatted_address || '').split(',')) push(part);
  }
  return out;
}

async function ensurePhaseAreaSetTable(db) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS google_phase_area_sets (
       phase_number SMALLINT PRIMARY KEY,
       area_names TEXT[] NOT NULL DEFAULT '{}',
       updated_at TIMESTAMPTZ DEFAULT NOW()
     )`
  );
}

async function googleGet(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const data = await res.json();
  return data;
}

/** Ask Google which place names sit in this DHA phase. Cached for a day. */
async function discoverPhaseAreas(db, phaseNumber) {
  const n = Number(phaseNumber);
  if (!n) return { areas: [], labels: [] };
  const key = String(n);
  if (discoverInflight.has(key)) return discoverInflight.get(key);
  const job = discoverPhaseAreasOnce(db, n).finally(() => discoverInflight.delete(key));
  discoverInflight.set(key, job);
  return job;
}

const discoverInflight = new Map();

async function discoverPhaseAreasOnce(db, phaseNumber) {
  await ensurePhaseTable(db);
  await ensurePhaseAreaSetTable(db);
  const cached = await db.query(
    `SELECT area_names, updated_at FROM google_phase_area_sets WHERE phase_number = $1`,
    [phaseNumber]
  );
  const row = cached.rows[0];
  const fresh = row && Date.now() - new Date(row.updated_at).getTime() < 24 * 60 * 60 * 1000;
  const cachedNames = Array.isArray(row?.area_names) ? row.area_names : [];
  const cacheOk = fresh && cachedNames.length >= 8 && cachedNames.every((name) => isPhaseAreaLabel(name));
  if (cacheOk) {
    const extra = EXTRA_PHASE_AREAS[phaseNumber] || [];
    const merged = [...cachedNames];
    const seenCache = new Set(cachedNames.map((name) => areaKey(name)));
    for (const name of extra) {
      const key = areaKey(name);
      if (!key || seenCache.has(key)) continue;
      seenCache.add(key);
      merged.push(name);
    }
    return { areas: searchTermsFromConfirmed(merged), labels: labelsFromConfirmed(merged) };
  }

  const known = (await areasForPhase(db, phaseNumber)).filter((name) => isPhaseAreaLabel(name));
  const candidates = phasePlaceCandidates(phaseNumber);
  const confirmed = [];
  const queue = candidates.slice();
  async function confirmWorker() {
    while (queue.length) {
      const name = queue.shift();
      try {
        const hit = await resolvePlace(db, name);
        if (Number(hit?.phase_number) === Number(phaseNumber)) confirmed.push(name);
      } catch (_) {}
    }
  }
  await Promise.all([confirmWorker(), confirmWorker(), confirmWorker(), confirmWorker()]);

  let discovered = [];
  const apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
  if (apiKey) {
    const queries = [
      `DHA Phase ${phaseNumber} Karachi`,
      `commercial area DHA Phase ${phaseNumber} Karachi`
    ];
    const pages = await Promise.all(queries.map(async (q) => {
      try {
        const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json?' + new URLSearchParams({
          query: q,
          region: 'pk',
          key: apiKey
        });
        const data = await googleGet(url);
        if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') return [];
        return data.results || [];
      } catch (_) {
        return [];
      }
    }));
    discovered = collectPhaseAreaNames(pages.flat(), phaseNumber).filter((name) => isPhaseAreaLabel(name));
  }

  const seen = new Set();
  const confirmedNames = [];
  for (const name of [...confirmed, ...discovered, ...known, ...(EXTRA_PHASE_AREAS[phaseNumber] || [])]) {
    const text = String(name || '').trim();
    const akey = areaKey(text);
    if (!isPhaseAreaLabel(text) || isOnlyPhaseLabel(text, phaseNumber) || seen.has(akey)) continue;
    seen.add(akey);
    confirmedNames.push(text);
  }
  const names = searchTermsFromConfirmed(confirmedNames);

  await db.query(
    `INSERT INTO google_phase_area_sets (phase_number, area_names, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (phase_number) DO UPDATE SET
       area_names = EXCLUDED.area_names,
       updated_at = NOW()`,
    [phaseNumber, names]
  );
  return { areas: names, labels: labelsFromConfirmed(confirmedNames) };
}

async function discoverDhaAreas(db) {
  const phases = [1, 2, 4, 5, 6, 7, 8];
  const found = await Promise.all(phases.map((n) => discoverPhaseAreas(db, n)));
  const seen = new Set();
  const areas = [];
  const labels = [];
  for (const set of found) {
    for (const name of set.areas || []) {
      const key = areaKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      areas.push(name);
    }
    for (const name of set.labels || []) {
      const key = `label:${areaKey(name)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push(name);
    }
  }
  return { areas, labels };
}

const SPELL_GENERIC = new Set([
  'commercial', 'comm', 'area', 'khayaban', 'khyaban', 'street', 'st', 'lane', 'road',
  'avenue', 'block', 'phase', 'market', 'society', 'dha', 'defence', 'defense', 'defance',
  'housing', 'authority', 'officers', 'pakistan', 'karachi', 'e'
]);
const SPELL_VOWELS = ['a', 'e', 'i', 'o', 'u'];

function isDefenceKarachiText(text) {
  const blob = String(text || '').toLowerCase();
  const dha = /\b(dha|d\.h\.a|defence|defense)\b/.test(blob);
  const karachi = /\bkarachi\b/.test(blob) || dha;
  return dha && karachi;
}

function consonantKey(word) {
  return String(word || '').toLowerCase().replace(/[^a-z]/g, '').replace(/[aeiou]/g, '');
}

function distinctiveStem(phrase) {
  const words = areaKey(phrase).split(' ').filter((word) => word && !SPELL_GENERIC.has(word) && word.length >= 4);
  return words.sort((a, b) => b.length - a.length)[0] || '';
}

function isDhaParentName(name) {
  const key = areaKey(name);
  if (!key) return true;
  if (/^(dha|defence|defense|defance)( karachi| pakistan)?$/.test(key)) return true;
  if (/defence housing authority|pakistan defence|dha phase /.test(key)) return true;
  return false;
}

/** Vowel spellings of one Defence place: seher / sehar / sahar commercial. */
function areaSpellingTerms(canonical, typed) {
  const clean = (value) => areaKey(value).replace(/\bcomm\b/g, 'commercial');
  const base = clean(canonical);
  const typedKey = clean(typed);
  if (!base) return [];
  const words = base.split(' ').filter(Boolean);
  const withoutArea = words.filter((word) => word !== 'area').join(' ');
  const stems = words.filter((word) => !SPELL_GENERIC.has(word) && word.length >= 4);
  const stem = stems.sort((a, b) => b.length - a.length)[0] || '';
  const variants = new Set([base, withoutArea, typedKey].filter(Boolean));
  if (stem) {
    const skeleton = consonantKey(stem);
    const candidates = new Set([stem]);
    const chars = stem.split('');
    const vowelSlots = [];
    chars.forEach((ch, index) => {
      if ('aeiou'.includes(ch)) vowelSlots.push(index);
    });
    let lattice = [chars.slice()];
    for (const index of vowelSlots.slice(0, 3)) {
      const next = [];
      const choices = new Set([chars[index], 'a', 'e']);
      for (const form of lattice) {
        for (const vowel of choices) {
          const copy = form.slice();
          copy[index] = vowel;
          next.push(copy);
        }
      }
      lattice = next;
    }
    for (const form of lattice) candidates.add(form.join(''));
    chars.forEach((ch, index) => {
      if (!'aeiou'.includes(ch)) return;
      for (const vowel of SPELL_VOWELS) {
        const copy = chars.slice();
        copy[index] = vowel;
        candidates.add(copy.join(''));
      }
      candidates.add(chars.filter((_, i) => i !== index).join(''));
    });
    for (let index = 1; index < stem.length; index += 1) {
      for (const vowel of SPELL_VOWELS) {
        const copy = chars.slice();
        copy.splice(index, 0, vowel);
        candidates.add(copy.join(''));
      }
    }
    const tail = words.filter((word) => word !== stem && word !== 'area');
    for (const word of candidates) {
      if (word[0] !== stem[0] || consonantKey(word) !== skeleton || Math.abs(word.length - stem.length) > 2) continue;
      variants.add(tail.length ? `${word} ${tail.join(' ')}` : word);
      if (words.includes('commercial')) variants.add(`${word} commercial`);
      if (word.length >= 5) variants.add(word);
    }
  }
  return [...variants].map((term) => term.replace(/\s+/g, ' ').trim()).filter((term) => term.length >= 4);
}

function nameMatchesQuery(name, query) {
  const want = consonantKey(distinctiveStem(query));
  const got = consonantKey(distinctiveStem(name));
  if (!want || !got) return false;
  return want === got;
}

function defencePlaceName(geo, query) {
  if (!geo || geo.error === 'GOOGLE_MAPS_API_KEY missing') return null;
  const formatted = geo.formatted || '';
  if (!isDefenceKarachiText(formatted)) return null;
  const prefer = ['neighborhood', 'sublocality_level_1', 'sublocality', 'route'];
  const found = [];
  for (const type of prefer) {
    const hit = (geo.components || []).find((component) => (component.types || []).includes(type));
    const name = String(hit?.long_name || '').trim();
    if (name) found.push(name);
  }
  const first = formatted.split(',')[0].trim();
  if (first) found.push(first);
  return found.find((name) => isPhaseAreaLabel(name) && !isDhaParentName(name) && nameMatchesQuery(name, query)) || null;
}

function addressAreaName(formatted) {
  const matches = String(formatted || '').match(
    /\b([A-Za-z]{3,}(?:\s+[A-Za-z]{3,}){0,2}\s+(?:commercial|khayaban|khyaban)(?:\s+area)?)\b/gi
  ) || [];
  const names = matches
    .map((part) => part.trim())
    .filter((part) => isPhaseAreaLabel(part) && !isDhaParentName(part));
  return names.sort((a, b) => b.length - a.length)[0] || '';
}

function googleAreaFromResult(result, query) {
  const name = String(result?.name || '').trim();
  const formatted = String(result?.formatted_address || '').trim();
  const blob = `${name} ${formatted}`;
  if (!isDefenceKarachiText(blob)) return null;
  const fromAddress = addressAreaName(formatted);
  const options = [];
  if (name && isPhaseAreaLabel(name) && !isDhaParentName(name)) options.push(name);
  const samePlace = fromAddress && (
    (name && nameMatchesQuery(fromAddress, name)) ||
    (query && nameMatchesQuery(fromAddress, query))
  );
  if (samePlace) options.push(fromAddress);
  const matching = query
    ? options.filter((option) => nameMatchesQuery(option, query))
    : options;
  if (!matching.length) return null;
  matching.sort((a, b) => {
    const areaBoost = (value) => (/\barea\b/i.test(value) ? 1 : 0);
    return (areaBoost(b) - areaBoost(a)) || (b.length - a.length);
  });
  const chosen = matching[0];
  const score = (/\barea\b/i.test(chosen) ? 20 : 0) + chosen.length;
  return { name: chosen, formatted: formatted || blob, score };
}

function choosePlacesArea(results, query) {
  let best = null;
  for (const result of results || []) {
    const hit = googleAreaFromResult(result, query);
    if (!hit) continue;
    if (!best || hit.score > best.score) best = hit;
  }
  return best ? { name: best.name, formatted: best.formatted } : null;
}

async function placesDefenceArea(query) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
  if (!apiKey) return null;
  const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json?' + new URLSearchParams({
    query: `${query}, DHA Karachi`,
    region: 'pk',
    key: apiKey
  });
  let data;
  try {
    data = await googleGet(url);
  } catch (err) {
    console.info(`[search] google places failed ${String(err.message || err).slice(0, 120)}`);
    return null;
  }
  const rows = data.results || [];
  console.info(
    `[search] google places status=${data.status || 'ok'} query="${query}" ` +
      `results=${rows.slice(0, 5).map((row) => row.name).join(' | ') || '(none)'}`
  );
  return choosePlacesArea(rows, query);
}

/**
 * Snap a misspelled Defence Karachi area to the Google place, and list the
 * spellings that should match the same listings.
 */
async function correctDefenceArea(_db, query) {
  const typed = areaKey(query);
  if (!typed || typed.length < 4) return null;
  if (/^(dha|defence|defense|defance)( karachi)?$/.test(typed)) return null;

  console.info(`[search] google maps lookup "${typed}"`);
  let hit = await placesDefenceArea(typed);
  let via = 'places';
  if (!hit) {
    const geo = await geocodeAddress(`${typed}, DHA, Karachi, Pakistan`);
    console.info(`[search] google geocode status=${geo.error || 'ok'} formatted="${geo.formatted || ''}"`);
    if (geo.error === 'GOOGLE_MAPS_API_KEY missing' || /REQUEST_DENIED|API key/i.test(String(geo.error || ''))) {
      return null;
    }
    const name = defencePlaceName(geo, typed);
    if (name) hit = { name, formatted: geo.formatted || '' };
    via = 'geocode';
  }
  if (!hit) {
    console.info(`[search] google maps had no Defence area for "${typed}"`);
    return null;
  }
  const terms = areaSpellingTerms(hit.name, typed);
  console.info(`[search] google ${via} "${typed}" -> "${hit.name}" | ${hit.formatted || ''}`);
  if (!terms.length) return null;
  return { name: hit.name, terms, formatted: hit.formatted || '', via };
}

module.exports = {
  geocodeAddress,
  areaKey,
  areaSpellingTerms,
  choosePlacesArea,
  correctDefenceArea,
  phaseNumbersFromComponents,
  phaseNameFromNumber,
  placeCandidates,
  isSearchablePhaseArea,
  isPhaseAreaLabel,
  phasePlaceCandidates,
  labelsFromConfirmed,
  looksLikePhaseArea,
  collectPhaseAreaNames,
  areasForPhase,
  discoverPhaseAreas,
  discoverDhaAreas,
  ensurePhaseTable,
  geocodePlace,
  resolvePlace,
  fillMissingPhases,
  offerPlaceNames,
  correctSplitListingPhases
};
