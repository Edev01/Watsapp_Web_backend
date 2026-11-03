const test = require('node:test');
const assert = require('node:assert/strict');
const {
  looksLikeRequirement,
  isRequirementListing,
  maskNonInventoryRequired,
} = require('../ai/extract/listingKind');

test('deal-term required phrases are not requirement inventory', () => {
  const cases = [
    '500 yards Phase 6 west open. Commission required.',
    'Plot available. Percentage % required.',
    'Bungalow for sale covering required',
    'House Phase 6 renovation required',
    'Serious buyer. Profile required.',
    'For rent Phase 8 tenant profile required',
    '500 yards available offer required',
    'Commision required on this deal 500 yards',
    'BAHRIA TOWN KARACHI 15B 500 YARDS OFFER REQ',
    'CORAL TOWER 2 DEMAND 5.50 CONFIRM OFFER REQ',
    'P30 Plot 1630 series Allotment Confirm offer req',
    'Strt 31 avl for sale Dmnd 42 close offer req',
    'OFFICE FOR SALE 1000 SGFT REQUIRED WELL MENTAIN',
    '100 yd plot sale Ph7 ext Required QUOTE ONLY DIRECT INVENTORY',
    '600 yards plot. Required to build duplexes. 42 street required.',
  ];
  for (const text of cases) {
    assert.equal(looksLikeRequirement('REQUIREMENT', text), false, text);
    assert.equal(
      isRequirementListing({ listing_kind: 'REQUIREMENT', listing_excerpt: text, raw_message: `Req 200 yards\n${text}` }),
      false,
      text
    );
  }
});

test('real buy/rent reqs stay requirements even if commission is also mentioned', () => {
  const text = 'Req 500 yards Phase 6. Commission required.';
  assert.equal(looksLikeRequirement('OFFER', text), true);
});

test('mask strips percentage % required', () => {
  const left = maskNonInventoryRequired('West open. Percentage % required. Demand 4 cr');
  assert.equal(/\brequired\b/i.test(left), false);
});
