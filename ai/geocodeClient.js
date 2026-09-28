/**
 * Free geocoders: Photon (Komoot) + Nominatim (OSM).
 * Used only to refine/fill address after LLM cascade — never blind overwrite.
 */

const NOMINATIM_MIN_INTERVAL_MS = 1100;
let nominatimNextAt = 0;
let nominatimChain = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function geocodeEnabled() {
  const raw = String(process.env.GEOCODE_ENABLED || 'true').toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

function userAgent() {
  return (
    process.env.GEOCODE_USER_AGENT ||
    'PropSyncPropertyNormalizer/1.0 (contact: propsync-local)'
  );
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[–—\-_/\\,.*]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function overlapScore(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const b = new Set(bTokens);
  let hit = 0;
  for (const t of aTokens) {
    if (b.has(t)) hit += 1;
  }
  return hit / Math.max(aTokens.length, 1);
}

function buildGeocodeQuery(schema, messageText) {
  const parts = [];
  const vicinity = String(schema?.vicinity || '').trim();
  const area = String(schema?.area || '').trim();
  const city = String(schema?.city || '').trim();
  if (vicinity) parts.push(vicinity);
  if (area && area.toLowerCase() !== vicinity.toLowerCase()) parts.push(area);
  if (city) parts.push(city);

  // If LLM gave almost nothing useful, pull a short place-ish slice from the message
  if (parts.length < 2) {
    const msg = String(messageText || '')
      .replace(/\*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const placeHint = msg
      .split(/[\n|]/)
      .map((s) => s.trim())
      .find((s) =>
        /\b(street|st|road|rd|drive|sector|block|phase|khayaban|dha|defence|korangi|clifton|gulshan)\b/i.test(
          s
        )
      );
    if (placeHint) parts.unshift(placeHint.slice(0, 120));
  }

  if (!parts.length) return '';
  if (!/\bpakistan\b/i.test(parts.join(' '))) parts.push('Pakistan');
  return parts.join(', ').slice(0, 180);
}

function mapNominatimAddress(item) {
  const a = item?.address || {};
  const city =
    a.city || a.town || a.municipality || a.county || a.state_district || null;
  const area =
    a.suburb ||
    a.neighbourhood ||
    a.city_district ||
    a.quarter ||
    a.village ||
    a.hamlet ||
    null;
  const vicinity =
    a.road ||
    a.pedestrian ||
    a.residential ||
    a.street ||
    a.neighbourhood ||
    null;
  return {
    source: 'nominatim',
    display: item.display_name || '',
    city,
    area,
    vicinity,
    importance: Number(item.importance) || 0,
    lat: item.lat,
    lon: item.lon,
    countryCode: String(a.country_code || '').toLowerCase()
  };
}

function mapPhotonFeature(feature) {
  const p = feature?.properties || {};
  const city = p.city || p.county || p.state || null;
  const area = p.district || p.locality || p.suburb || p.neighbourhood || null;
  const vicinity = p.street || p.name || p.road || null;
  return {
    source: 'photon',
    display: [p.name, p.street, p.district, p.city, p.country]
      .filter(Boolean)
      .join(', '),
    city,
    area,
    vicinity,
    importance: Number(p.extent ? 0.4 : 0.35) + (p.osm_key === 'highway' ? 0.1 : 0),
    lat: feature?.geometry?.coordinates?.[1],
    lon: feature?.geometry?.coordinates?.[0],
    countryCode: String(p.countrycode || p.country || '')
      .toLowerCase()
      .slice(0, 2)
  };
}

async function fetchPhoton(query, limit = 5) {
  const url = new URL('https://photon.komoot.io/api/');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('lang', 'en');
  // Rough Pakistan focus (west,south,east,north)
  url.searchParams.set('bbox', '60.8,23.5,77.9,37.2');

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json', 'User-Agent': userAgent() }
  });
  if (!res.ok) {
    const err = new Error(`Photon HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return (json?.features || []).map(mapPhotonFeature);
}

function enqueueNominatim(fn) {
  nominatimChain = nominatimChain.then(fn, fn);
  return nominatimChain;
}

async function fetchNominatim(query, limit = 5) {
  return enqueueNominatim(async () => {
    const wait = Math.max(0, nominatimNextAt - Date.now());
    if (wait) await sleep(wait);
    nominatimNextAt = Date.now() + NOMINATIM_MIN_INTERVAL_MS;

    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('countrycodes', 'pk');

    const res = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': userAgent()
      }
    });
    if (!res.ok) {
      const err = new Error(`Nominatim HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    return (Array.isArray(json) ? json : []).map(mapNominatimAddress);
  });
}

/**
 * Score a geocode candidate vs original message + current LLM fields.
 * Higher = more relevant. Pakistan / message overlap dominate.
 */
function scoreCandidate(candidate, messageText, schema) {
  const msgTokens = tokenize(messageText);
  const candTokens = tokenize(
    [candidate.vicinity, candidate.area, candidate.city, candidate.display].join(' ')
  );
  const schemaTokens = tokenize(
    [schema?.vicinity, schema?.area, schema?.city].join(' ')
  );

  let score = 0;
  score += overlapScore(candTokens, msgTokens) * 100;
  score += overlapScore(candTokens, schemaTokens) * 40;
  score += Math.min(30, (candidate.importance || 0) * 40);

  if (candidate.countryCode === 'pk' || /\bpakistan\b/i.test(candidate.display || '')) {
    score += 25;
  } else if (candidate.countryCode && candidate.countryCode !== 'pk') {
    score -= 50;
  }

  // Prefer candidates that preserve strong LLM tokens already present
  for (const key of ['vicinity', 'area', 'city']) {
    const cur = String(schema?.[key] || '').trim().toLowerCase();
    if (!cur || cur.length < 3) continue;
    const blob = String(candidate[key] || candidate.display || '').toLowerCase();
    if (blob.includes(cur) || cur.split(/\s+/).every((t) => t.length < 3 || blob.includes(t))) {
      score += 15;
    }
  }

  return score;
}

/**
 * Field-level relevance: how well does this value appear in the WhatsApp message?
 */
function fieldMessageScore(value, messageText) {
  const v = String(value || '').trim();
  if (!v) return 0;
  const msg = String(messageText || '').toLowerCase();
  const lower = v.toLowerCase();
  if (msg.includes(lower)) return 1;
  const toks = tokenize(v).filter((t) => t.length >= 3);
  if (!toks.length) return 0;
  const msgToks = new Set(tokenize(msg));
  const hit = toks.filter((t) => msgToks.has(t)).length;
  return hit / toks.length;
}

function isStrongField(value, messageText) {
  const v = String(value || '').trim();
  if (!v) return false;
  // Phase / Khayaban / named street with message support = strong
  if (/\bphase\s*\d+\b/i.test(v) && fieldMessageScore(v, messageText) >= 0.5) return true;
  if (/khayaban/i.test(v) && fieldMessageScore(v, messageText) >= 0.4) return true;
  if (fieldMessageScore(v, messageText) >= 0.75 && tokenize(v).length >= 2) return true;
  return false;
}

/**
 * Pick best among Photon+Nominatim, then merge into schema without
 * destroying stronger LLM values.
 */
function mergeBestGeocode(schema, messageText, candidates) {
  if (!schema || typeof schema !== 'object') return { schema, applied: false, best: null };
  if (!candidates.length) return { schema, applied: false, best: null };

  const ranked = candidates
    .map((c) => ({ ...c, score: scoreCandidate(c, messageText, schema) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  // Require real message relevance (avoid random OSM hits)
  if (!best || best.score < 45) {
    return { schema, applied: false, best };
  }

  const out = { ...schema };
  let changed = false;

  const tryField = (key, geoVal) => {
    if (!geoVal || !String(geoVal).trim()) return;
    const geo = String(geoVal).trim();
    const cur = out[key];
    const curEmpty = !cur || !String(cur).trim();
    const geoMsg = fieldMessageScore(geo, messageText);
    const curMsg = fieldMessageScore(cur, messageText);

    // Never overwrite a strong LLM field that clearly matches the message
    if (!curEmpty && isStrongField(cur, messageText) && curMsg >= geoMsg) return;

    // Fill empty / weak
    if (curEmpty || curMsg < 0.35) {
      if (geoMsg >= 0.35 || best.score >= 70) {
        out[key] = geo;
        changed = true;
      }
      return;
    }

    // Both present: only replace if geocode matches message clearly better
    if (geoMsg >= curMsg + 0.35 && geoMsg >= 0.6) {
      out[key] = geo;
      changed = true;
    }
  };

  tryField('city', best.city);
  tryField('area', best.area);
  tryField('vicinity', best.vicinity);

  // If area empty but vicinity looks like a society name from geocode display
  if ((!out.area || !String(out.area).trim()) && best.area) {
    out.area = best.area;
    changed = true;
  }

  return { schema: out, applied: changed, best };
}

async function refineWithGeocode(schema, messageText) {
  if (!geocodeEnabled() || !schema) {
    return { schema, stages: ['geocode:skip'], best: null };
  }

  const query = buildGeocodeQuery(schema, messageText);
  if (!query || query.length < 5) {
    return { schema, stages: ['geocode:skip-thin'], best: null };
  }

  const stages = [];
  const candidates = [];

  const tasks = [
    fetchPhoton(query, 5)
      .then((rows) => {
        candidates.push(...rows);
        stages.push(`photon:${rows.length}`);
      })
      .catch((err) => {
        stages.push(`photon:err:${String(err.message || err).slice(0, 40)}`);
      }),
    fetchNominatim(query, 5)
      .then((rows) => {
        candidates.push(...rows);
        stages.push(`nominatim:${rows.length}`);
      })
      .catch((err) => {
        stages.push(`nominatim:err:${String(err.message || err).slice(0, 40)}`);
      })
  ];

  await Promise.all(tasks);

  const { schema: merged, applied, best } = mergeBestGeocode(
    schema,
    messageText,
    candidates
  );
  stages.push(
    applied
      ? `geocode:applied:${best?.source || '?'}:${Math.round(best?.score || 0)}`
      : `geocode:keep-llm:${best ? Math.round(best.score) : 0}`
  );

  return { schema: merged, stages, best };
}

module.exports = {
  refineWithGeocode,
  buildGeocodeQuery,
  mergeBestGeocode,
  scoreCandidate,
  geocodeEnabled,
  fetchPhoton,
  fetchNominatim
};
