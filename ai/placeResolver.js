/**
 * Background place resolver: tag listings with parent/child regions.
 * Google Geocoding when GOOGLE_MAPS_API_KEY is set; else gazetteer + optional Nominatim bits.
 * Never called from the search hot path.
 */

const db = require('../db');
const {
  tagsFromPlaceFields,
  seedRows,
  enrichSchemaWithLocalDhaPhase,
  norm
} = require('./placeRegions');

function placeResolveEnabled() {
  const raw = String(process.env.PLACE_RESOLVE_ENABLED || 'true').toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

function googleKey() {
  return String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
}

let regionsSeeded = false;

async function ensurePlaceRegionsSeeded() {
  if (regionsSeeded) return;
  try {
    for (const row of seedRows()) {
      await db.query(
        `INSERT INTO place_regions (parent_key, aliases, children, source, updated_at)
         VALUES ($1, $2::text[], $3::text[], $4, NOW())
         ON CONFLICT (parent_key) DO UPDATE SET
           aliases = EXCLUDED.aliases,
           -- Replace children (do not merge) so gazetteer corrections stick
           children = EXCLUDED.children,
           source = EXCLUDED.source,
           updated_at = NOW()`,
        [row.parent_key, row.aliases, row.children, row.source]
      );
    }
    regionsSeeded = true;
  } catch (err) {
    console.warn('[placeResolver] seed place_regions:', err.message);
  }
}

async function geocodeGoogle(query) {
  const key = googleKey();
  if (!key || !query) return null;
  const url =
    'https://maps.googleapis.com/maps/api/geocode/json?' +
    new URLSearchParams({
      address: query,
      key,
      region: 'pk',
      components: 'country:PK'
    }).toString();

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const data = await res.json();
    if (data.status !== 'OK' || !data.results?.[0]) return null;
    const top = data.results[0];
    const comps = (top.address_components || []).map((c) => ({
      long: c.long_name,
      short: c.short_name,
      types: c.types || []
    }));
    const names = comps
      .filter((c) =>
        c.types.some((t) =>
          [
            'sublocality',
            'sublocality_level_1',
            'neighborhood',
            'locality',
            'administrative_area_level_2',
            'administrative_area_level_3',
            'route'
          ].includes(t)
        )
      )
      .map((c) => c.long);
    return {
      lat: top.geometry?.location?.lat ?? null,
      lng: top.geometry?.location?.lng ?? null,
      formatted: top.formatted_address || '',
      componentNames: names
    };
  } catch (err) {
    console.warn('[placeResolver] google geocode:', err.message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

function buildQuery({ area, vicinity, city }) {
  const parts = [vicinity, area, city].map((x) => String(x || '').trim()).filter(Boolean);
  if (!parts.length) return '';
  let q = parts.join(', ');
  if (!/\bkarachi\b/i.test(q)) q += ', Karachi';
  if (!/\bpakistan\b/i.test(q)) q += ', Pakistan';
  return q.slice(0, 180);
}

/**
 * Resolve + persist place_tags for one normalized_messages row.
 */
async function resolveAndSavePlaceTags(row) {
  if (!placeResolveEnabled()) return null;
  if (!row?.id || !row.is_property) return null;

  await ensurePlaceRegionsSeeded();

  const query = buildQuery(row);
  let lat = null;
  let lng = null;
  let extra = [];

  if (googleKey() && query) {
    const geo = await geocodeGoogle(query);
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
      extra = geo.componentNames || [];
    }
  }

  // Correct DHA commercial→phase (e.g. Rahat → Phase 6) on stored fields
  const enriched = enrichSchemaWithLocalDhaPhase(
    { area: row.area, vicinity: row.vicinity, city: row.city },
    row.raw_message || row.listing_excerpt || row.summary || ''
  );

  const tags = tagsFromPlaceFields({
    area: enriched.area,
    vicinity: enriched.vicinity,
    city: enriched.city,
    extra
  });

  if (!tags.length && !lat) return null;

  await db.query(
    `UPDATE normalized_messages
     SET place_tags = $2::text[],
         area = COALESCE(NULLIF(TRIM($5), ''), area),
         vicinity = COALESCE(NULLIF(TRIM($6), ''), vicinity),
         city = COALESCE(NULLIF(TRIM($7), ''), city),
         geo_lat = COALESCE($3, geo_lat),
         geo_lng = COALESCE($4, geo_lng),
         place_resolved_at = NOW()
     WHERE id = $1`,
    [
      row.id,
      tags,
      lat,
      lng,
      enriched.area || null,
      enriched.vicinity || null,
      enriched.city || null
    ]
  );

  return { id: row.id, tags, lat, lng, area: enriched.area, vicinity: enriched.vicinity };
}

/**
 * Fire-and-forget after normalize save (does not block pipeline hard).
 */
function schedulePlaceResolve(row) {
  if (!placeResolveEnabled() || !row?.id) return;
  setImmediate(() => {
    resolveAndSavePlaceTags(row).catch((err) => {
      console.warn('[placeResolver] async resolve failed:', err.message);
    });
  });
}

module.exports = {
  placeResolveEnabled,
  ensurePlaceRegionsSeeded,
  resolveAndSavePlaceTags,
  schedulePlaceResolve,
  geocodeGoogle,
  buildQuery,
  norm
};
