const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePrecincts,
  expandParent,
  sizesForPrecincts,
  interpretBtkSearch,
  applyBtkListing,
  inferredYardages,
} = require('../ai/btkPrecincts');

test('P10a / precinct 10A / P-10A are the same precinct', () => {
  assert.deepEqual(parsePrecincts('P10a villa'), ['10A']);
  assert.deepEqual(parsePrecincts('precinct 10A'), ['10A']);
  assert.deepEqual(parsePrecincts('P-10A'), ['10A']);
  assert.deepEqual(parsePrecincts('P.10A'), ['10A']);
});

test('bahria and BTK are the same all-precinct search', () => {
  const a = interpretBtkSearch('bahria');
  const b = interpretBtkSearch('BTK');
  assert.equal(a.kind, 'btk-all');
  assert.equal(b.kind, 'btk-all');
  assert.ok(a.chips.includes('Precinct 10A'));
});

test('street-only BTK excerpt does not inherit sibling precincts or Phase 8', () => {
  const row = applyBtkListing({
    is_property: true,
    property_type: 'PLOT',
    listing_excerpt: 'Street 24 Park face single belt Allotment',
    vicinity: 'Phase 8, Street 24',
    phase: 8,
    place_tags: ['Phase 8', 'Street 24', 'Precinct 8', 'P8', 'Precinct 15', 'P15'],
  }, 'BTK\nP8 1460 series\nP15 1100 series\nStreet 24 Park face');
  assert.equal(row.phase, null);
  assert.ok(!/phase\s*8/i.test(String(row.vicinity || '')));
  assert.ok(!row.place_tags.includes('P8'));
  assert.ok(!row.place_tags.includes('P15'));
  assert.ok(!row.place_tags.some((t) => /^phase 8$/i.test(t)));
  assert.ok(row.place_tags.includes('BTK'));
});

test('listing tags follow the excerpt precinct, not sibling ads in the same message', () => {
  const row = applyBtkListing({
    is_property: true,
    property_type: 'PLOT',
    listing_excerpt: 'P10A 200 yards west open',
    place_tags: ['Precinct 15', 'P15'],
  }, 'BTK\nP10A 200 yards\nP15 125 yards');
  assert.ok(row.place_tags.includes('P10A'));
  assert.ok(!row.place_tags.includes('P15'));
  assert.ok(!row.place_tags.includes('Precinct 15'));
});

test('parent P10 search expands to lettered precincts', () => {
  const hit = interpretBtkSearch('P10');
  assert.equal(hit.kind, 'btk-parent');
  assert.ok(hit.matchPrecincts.includes('10A'));
  assert.ok(hit.matchPrecincts.includes('10B'));
  const exact = interpretBtkSearch('P10A');
  assert.equal(exact.kind, 'btk-exact');
  assert.deepEqual(exact.matchPrecincts, ['10A']);
});

test('multi-cutting precinct is in every sq-yd bucket', () => {
  assert.deepEqual(sizesForPrecincts(['17']), [500, 1000, 2000]);
  assert.deepEqual(sizesForPrecincts(['15B']), [125, 500]);
  assert.deepEqual(expandParent('35'), ['35']);
  assert.deepEqual(sizesForPrecincts(['35']), [350]);
});

test('written size wins; otherwise size stays empty so all cuttings match', () => {
  const written = applyBtkListing({
    is_property: true,
    property_type: 'PLOT',
    listing_excerpt: 'P17 500 square yards',
    size_value: 500,
    size_unit: 'Sq. Yd.',
    place_tags: [],
  }, 'BTK P17 500 square yards');
  assert.equal(written.size_value, 500);
  assert.equal(inferredYardages(written), null);

  const inferred = applyBtkListing({
    is_property: true,
    property_type: 'PLOT',
    listing_excerpt: 'P17 west open',
    size_value: null,
    place_tags: [],
  }, 'BTK P17 west open');
  assert.equal(inferred.size_value, null);
  assert.deepEqual(inferredYardages(inferred), [500, 1000, 2000]);
  assert.equal(inferred.phase, null);
  assert.ok(inferred.place_tags.includes('Precinct 17'));
});

test('P4 is not DHA phase 4', () => {
  const row = applyBtkListing({
    is_property: true,
    property_type: 'PLOT',
    listing_excerpt: 'P4 800s with allotment',
    phase: 4,
    place_tags: ['Phase 4'],
  }, '*BAHRIA TOWN KARACHI*\nP4 800s with allotment');
  assert.equal(row.phase, null);
  assert.equal(row.area, 'Bahria Town Karachi');
  assert.ok(row.place_tags.includes('P4'));
  assert.ok(!row.place_tags.some((t) => /^phase 4$/i.test(t)));
});

test('Bahria Rwp and Khayaban-e-Bahria are not BTK', () => {
  assert.equal(interpretBtkSearch('Bahria Rwp Sector F3'), null);
  const row = applyBtkListing({
    is_property: true,
    listing_excerpt: 'For Sale Bahria Rwp Sector F3',
    phase: 3,
    place_tags: [],
  }, 'For Sale Bahria Rwp Sector F3');
  assert.equal(row.phase, 3);
});

test('BTK search chips include precincts', () => {
  const all = interpretBtkSearch('BTK');
  assert.equal(all.kind, 'btk-all');
  assert.ok(all.chips.includes('Precinct 10A'));
  assert.ok(all.chips.includes('Precinct 19'));
  assert.ok(all.chips.includes('Precinct 18'));
});
