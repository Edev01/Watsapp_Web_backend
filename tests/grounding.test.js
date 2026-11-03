const test = require('node:test');
const assert = require('node:assert/strict');
const { correctListingFields } = require('../ai/extract/grounding');

const MSG_15398 = `For Sale

P8 1460 series
Loop Road with Allotment

P10B 1340 series
Road 5 with Allotment

P15 1100 series
Road 2 Jinnah back Allotment

P16 2090 series
Heighted plot with Allotment

P17 1000 sqyds 790 ser Allotment

P47 Corner Street 4
386 sqyds with Allotment


*Golf ⛳️*

• 500 sqyds
Street 34B Allotment near EV Station

• 1000 sqyds

Road 1 Heighted plot with Allotment

Street 24 Park face single belt Allotment


Usama Shaikh
03020300567
03302477365`;

test('15398 golf street 24 does not keep Phase 8 or sibling precincts', () => {
  const { row, changes } = correctListingFields({
    is_property: true,
    listing_excerpt: 'Street 24 Park face single belt Allotment',
    city: null,
    area: 'Bahria Town Karachi',
    vicinity: 'Phase 8, Street 24',
    phase: null,
    street_text: 'Street 24',
    location_text: null,
    place_tags: ['Street 24', 'Bahria Town Karachi', 'BTK', 'Precinct 8', 'P8', 'Precinct 10B', 'P10B', 'Precinct 15', 'P15'],
    property_type: 'PLOT',
    listing_kind: 'OFFER',
    size: null,
    size_value: null,
    price: null,
    price_value: null,
  }, MSG_15398);
  assert.equal(row.phase, null);
  assert.equal(row.vicinity, 'Street 24');
  assert.ok(!row.place_tags.includes('P8'));
  assert.ok(!row.place_tags.includes('Precinct 15'));
  assert.ok(row.place_tags.includes('Street 24'));
  assert.ok(row.place_tags.includes('BTK'));
  assert.ok(changes.includes('vicinity'));
  assert.ok(changes.includes('place_tags'));
});

test('P8 series is not a size; precinct stays on that excerpt only', () => {
  const { row } = correctListingFields({
    is_property: true,
    listing_excerpt: 'P8 1460 series\nLoop Road with Allotment',
    area: 'Bahria Town Karachi',
    vicinity: 'Phase 8',
    phase: 8,
    place_tags: ['Phase 8', 'P15'],
    size: '1460 Sq. Yd.',
    size_value: 1460,
    size_unit: 'Sq. Yd.',
    listing_kind: 'OFFER',
  }, MSG_15398);
  assert.equal(row.phase, null);
  assert.equal(row.size_value, null);
  assert.match(String(row.vicinity), /Precinct 8/);
  assert.ok(row.place_tags.includes('P8'));
  assert.ok(!row.place_tags.includes('P15'));
  assert.ok(!row.place_tags.some((t) => /^phase 8$/i.test(t)));
});

test('D-Cutting is Phase 8, not an invented Phase 5', () => {
  const { row } = correctListingFields({
    is_property: true,
    listing_excerpt: '500+500 Yards\n21St Street \nD-Cutting 5th Belt\nDemand 13/ Each',
    area: 'DHA',
    vicinity: 'D-Cutting, 21st Street',
    phase: 5,
    street_text: '21st Street',
    place_tags: ['DHA', 'Phase 5', 'D-Cutting', '21st Street'],
    listing_kind: 'OFFER',
    size: '500 yards',
    size_value: 500,
    size_unit: 'Sq. Yd.',
  }, 'Plots for Sale\n500+500 Yards\n21St Street \nD-Cutting 5th Belt\nDemand 13/ Each');
  assert.equal(row.phase, 8);
  assert.ok(row.place_tags.includes('Phase 8'));
  assert.ok(!row.place_tags.includes('Phase 5'));
  assert.ok(row.place_tags.includes('D-Cutting'));
  assert.equal(row.size_value, 500);
});

test('phase lists keep every written phase, not a filled range', () => {
  const { row } = correctListingFields({
    is_property: true,
    listing_excerpt: 'Required 2 Bed Portion For Rent\nLocation: DHA Phase 4, 5, 6, 8',
    vicinity: 'Phase 4, Phase 5, Phase 6, Phase 8',
    phase: 4,
    phase_max: 8,
    place_tags: ['Phase 4', 'Phase 5', 'Phase 6', 'Phase 8', 'Phase 7'],
    listing_kind: 'REQUIREMENT',
  }, 'Required 2 Bed Portion For Rent\nLocation: DHA Phase 4, 5, 6, 8');
  assert.deepEqual(
    row.place_tags.filter((t) => /^Phase/.test(t)).sort(),
    ['Phase 4', 'Phase 5', 'Phase 6', 'Phase 8']
  );
  assert.match(String(row.vicinity), /Phase 5/);
  assert.ok(!row.place_tags.includes('Phase 7'));
});

test('PHASE.7EXT still counts as phase 7 and Bahria street is not BTK', () => {
  const ext = correctListingFields({
    is_property: true,
    listing_excerpt: 'PLOT FOR SALE AVAILABLE PHASE.7EXT.\n142 SQ.YARD.PLOT',
    vicinity: 'Phase 7 Extension',
    phase: 7,
    place_tags: ['Phase 7 Extension', 'Phase 7'],
    listing_kind: 'OFFER',
  }, 'PLOT FOR SALE AVAILABLE PHASE.7EXT.\n142 SQ.YARD.PLOT');
  assert.equal(ext.row.phase, 7);

  const bahriaStreet = correctListingFields({
    is_property: true,
    listing_excerpt: 'Required 500 Yard In Phase 5,6 Preferred street 3 (Muhafiz, Bahria, Hilal)',
    area: 'DHA',
    vicinity: 'Phase 5, Phase 6',
    phase: 5,
    phase_max: 6,
    place_tags: ['Phase 5', 'Phase 6'],
    listing_kind: 'REQUIREMENT',
  }, 'Required 500 Yard In Phase 5,6 Preferred street 3 (Muhafiz, Bahria, Hilal)');
  assert.notEqual(bahriaStreet.row.area, 'Bahria Town Karachi');
  assert.equal(bahriaStreet.row.phase, 5);
});

test('DHA header phase is kept when the excerpt omits it', () => {
  const { row } = correctListingFields({
    is_property: true,
    listing_excerpt: '500 yards street 12 west open',
    area: 'DHA',
    vicinity: 'Phase 6, Street 12',
    phase: 6,
    street_text: 'Street 12',
    place_tags: ['Phase 6', 'Street 12', 'DHA'],
    listing_kind: 'OFFER',
    size: '500 yards',
    size_value: 500,
    size_unit: 'Sq. Yd.',
  }, 'DHA PHASE 6\n500 yards street 12 west open');
  assert.equal(row.phase, 6);
  assert.match(String(row.vicinity), /Street 12/i);
  assert.ok(row.place_tags.includes('Phase 6'));
});
