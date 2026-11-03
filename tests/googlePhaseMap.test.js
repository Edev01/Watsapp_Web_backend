const test = require('node:test');
const assert = require('node:assert/strict');
const {
  phaseNumbersFromComponents,
  placeCandidates,
  areaKey,
  isSearchablePhaseArea,
  offerPlaceNames,
  correctSplitListingPhases,
  fillMissingPhases
} = require('../ai/googlePhaseMap');

test('Google address component Phase 6 becomes one phase number', () => {
  const nums = phaseNumbersFromComponents([
    { long_name: 'Rahat Commercial Area' },
    { long_name: 'D.H.A Phase 6' },
    { long_name: 'Phase 6' },
    { long_name: 'Karachi' }
  ]);
  assert.deepEqual(nums, [6]);
});

test('Phase 8, Phase VIII, and Defence V are phases too', () => {
  assert.deepEqual(phaseNumbersFromComponents([
    { long_name: 'DHA Karachi Phase VIII Zone A' },
    { long_name: 'Phase 8' }
  ]), [8]);
  assert.deepEqual(phaseNumbersFromComponents([
    { long_name: 'Zamzama Commercial Area' },
    { long_name: 'Defence V' }
  ]), [5]);
  assert.deepEqual(phaseNumbersFromComponents([
    { long_name: 'DHA Phase 5' },
    { long_name: 'Defence V' }
  ]), [5]);
});

test('two different phases in one result are not a single match', () => {
  const nums = phaseNumbersFromComponents([
    { long_name: 'Phase 4' },
    { long_name: 'Phase 5' }
  ]);
  assert.deepEqual(nums, [4, 5]);
});

test('phase area list keeps Bukhari and drops floors and bungalows', () => {
  assert.equal(isSearchablePhaseArea('Bukhari Commercial'), true);
  assert.equal(isSearchablePhaseArea('11th Street'), true);
  assert.equal(isSearchablePhaseArea('6th Floor'), false);
  assert.equal(isSearchablePhaseArea('Bungalow'), false);
  assert.equal(isSearchablePhaseArea('100 Yards Commercial'), false);
});

test('phase lookup uses area, then every other location field', () => {
  assert.deepEqual(placeCandidates({
    area: 'EMAAR CORAL TOWER',
    vicinity: 'Phase 6, Rahat Commercial',
    location_text: 'Rahat Commercial',
    place_tags: ['DHA', 'Rahat Commercial']
  }), ['EMAAR CORAL TOWER', 'Rahat Commercial']);
  assert.deepEqual(placeCandidates({
    area: 'DHA',
    vicinity: 'Sahil Street 8',
    street_text: 'Sahil Street 8',
    place_tags: ['Defence']
  }), ['Sahil Street 8']);
  assert.equal(areaKey('EMAAR CORAL TOWER'), 'emaar coral tower');
});

test('a phase 8 header does not keep Khayaban-e-Tanzeem in phase 8', async () => {
  const phases = {
    sahil: 8,
    'zone d': 8,
    'khayaban e tanzeem': 5
  };
  const rows = [
    {
      is_property: true,
      phase: 8,
      listing_excerpt: '500 Sqyards Sahil available on st 29 big number',
      vicinity: 'Phase 8, Sahil',
      place_tags: ['DHA', 'Phase 8', 'Sahil']
    },
    {
      is_property: true,
      phase: 8,
      listing_excerpt: '1000 Sqyards zone D gola plot available on st 37',
      vicinity: 'Phase 8, Zone D',
      place_tags: ['DHA', 'Phase 8', 'Zone D']
    },
    {
      is_property: true,
      phase: 8,
      listing_excerpt: '500 Sqyards westopen plot in khayaban e tanzeem',
      vicinity: 'Phase 8, Khayaban-e-Tanzeem',
      place_tags: ['DHA', 'Phase 8', 'Khayaban-e-Tanzeem']
    }
  ];
  assert.deepEqual(offerPlaceNames(rows[2]).map(areaKey), ['khayaban e tanzeem']);
  await correctSplitListingPhases(rows, async (place) => phases[areaKey(place)] || null);
  assert.equal(rows[0].phase, 8);
  assert.equal(rows[1].phase, 8);
  assert.equal(rows[2].phase, 5);
  assert.equal(rows[2].vicinity, 'Phase 5, Khayaban-e-Tanzeem');
  assert.ok(rows[2].place_tags.some((tag) => areaKey(tag) === 'phase 5'));
  assert.equal(rows[2].place_tags.some((tag) => areaKey(tag) === 'phase 8'), false);
});

test('an offer that writes its own phase is not moved', async () => {
  const rows = [
    {
      is_property: true,
      phase: 8,
      listing_excerpt: '500 Sqyards Sahil available on st 29',
      vicinity: 'Phase 8, Sahil'
    },
    {
      is_property: true,
      phase: 6,
      listing_excerpt: 'Phase 6 Bukhari Commercial',
      vicinity: 'Phase 6, Bukhari Commercial',
      place_tags: ['Phase 6', 'Bukhari Commercial']
    }
  ];
  await correctSplitListingPhases(rows, async (place) => (/bukhari/i.test(place) ? 5 : 8));
  assert.equal(rows[0].phase, 8);
  assert.equal(rows[1].phase, 6);
  assert.equal(rows[1].vicinity, 'Phase 6, Bukhari Commercial');
});

test('one listing keeps the phase the model wrote', async () => {
  const rows = [{
    is_property: true,
    phase: 8,
    listing_excerpt: '500 Sqyards westopen plot in khayaban e tanzeem',
    vicinity: 'Phase 8, Khayaban-e-Tanzeem'
  }];
  await correctSplitListingPhases(rows, async () => 5);
  assert.equal(rows[0].phase, 8);
});

test('a single listing with no phase gets Google Phase N', async () => {
  const rows = [{
    is_property: true,
    phase: null,
    area: 'Rahat Commercial',
    vicinity: 'Rahat Commercial',
    listing_excerpt: '500 yards Rahat Commercial for sale',
    place_tags: ['Rahat Commercial', 'DHA']
  }];
  await fillMissingPhases(null, rows, async (place) => (/rahat/i.test(place) ? 6 : null));
  assert.equal(rows[0].phase, 6);
  assert.ok(rows[0].place_tags.some((tag) => /phase 6/i.test(tag)));
});

test('BTK and Clifton listings are not filled with a DHA phase', async () => {
  const btk = [{
    is_property: true,
    phase: null,
    vicinity: 'Precinct 10 Bahria Town Karachi',
    listing_excerpt: 'BTK P10 plot',
    place_tags: ['BTK', 'Precinct 10']
  }];
  await fillMissingPhases(null, btk, async () => 10);
  assert.equal(btk[0].phase, null);

  const clifton = [{
    is_property: true,
    phase: null,
    vicinity: 'Clifton Block 4',
    listing_excerpt: 'Clifton Block 4 house',
    place_tags: ['Clifton']
  }];
  await fillMissingPhases(null, clifton, async () => 4);
  assert.equal(clifton[0].phase, null);
});
