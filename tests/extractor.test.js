const test = require('node:test');
const assert = require('node:assert/strict');
const { extractMessage, buildRows, LLM_PROVIDERS } = require('../ai/extract/extractor');
const { EXTRACTION_SCHEMA, toGeminiSchema } = require('../ai/extract/schema');

const ctx = (text) => ({
  messageId: 1, chatJid: 'g@g.us', sender: 'x', senderPhone: '03001234567',
  messageText: text, userId: 4, model: 'mock'
});

test('LLM phase 6 and price are stored as returned, not rewritten', () => {
  const text = '*500 YARDS BUNGALOW FOR RENT*\n\nPHASE 6\nDEMAND 4.50';
  const [row] = buildRows({
    is_property: true, language: 'en',
    listings: [{
      listing_excerpt: text, kind: 'OFFER', purpose: 'RENT', property_type: 'BUNGALOW',
      area: 'DHA', vicinity: 'Phase 6', phase: 6,
      place_tags: ['DHA', 'Phase 6'],
      size: '500 YARDS', size_value: 500, size_unit: 'SQ_YD',
      price: '4.50', price_value: 450000, price_basis: 'PER_MONTH', confidence: 0.9
    }]
  }, ctx(text));
  assert.equal(row.phase, 6);
  assert.equal(row.vicinity, 'Phase 6');
  assert.equal(row.area, 'DHA');
  assert.deepEqual(row.place_tags, ['DHA', 'Phase 6']);
  assert.equal(row.price_value, 450000);
  assert.equal(row.price, '4.50');
  assert.equal(row.price_basis, 'PER_MONTH');
  assert.equal(row.size_value, 500);
  assert.equal(row.size_unit, 'Sq. Yd.');
  assert.equal(row.purpose, 'RENT');
  assert.equal(row.society_key, null);
});

test('place tags stay the phrases the model returned', () => {
  const text = '500 Sqy\n33rd Street\nPhase 6';
  const [row] = buildRows({
    is_property: true, listings: [{
      listing_excerpt: text, kind: 'OFFER', purpose: 'SALE', property_type: 'PLOT',
      area: 'DHA', vicinity: 'Phase 6, 33rd Street', phase: 6,
      street_text: '33rd Street',
      place_tags: ['DHA', 'Phase 6', '33rd Street']
    }]
  }, ctx(text));
  assert.equal(row.phase, 6);
  assert.equal(row.vicinity, 'Phase 6, 33rd Street');
  assert.deepEqual(row.place_tags, ['DHA', 'Phase 6', '33rd Street']);
  assert.ok(!row.place_tags.includes('phase-5'));
  assert.ok(!row.place_tags.includes('phase-4'));
});

test('city and location are saved exactly as the model returned them', () => {
  const text = 'OFFICE FOR SALE\nBadar Commercial\nDemand: 4 Crore/floor';
  const [row] = buildRows({
    is_property: true, listings: [{
      listing_excerpt: text, kind: 'OFFER', purpose: 'SALE', property_type: 'OFFICE',
      city: 'Islamabad', area: null, vicinity: 'Badar Commercial', phase: null,
      location_text: 'Badar Commercial',
      price: '4 Crore/floor', price_value: 40000000, price_basis: 'PER_FLOOR'
    }]
  }, ctx(text));
  assert.equal(row.city, 'Islamabad');
  assert.equal(row.city_source, 'llm');
  assert.equal(row.vicinity, 'Badar Commercial');
  assert.equal(row.phase, null);
  assert.equal(row.place_tags, null);
  assert.equal(row.price_value, 40000000);
  assert.equal(row.price_basis, 'PER_FLOOR');
});

test('header-only listing makes no card; non-property gets one stub row', () => {
  const empty = buildRows({ is_property: true, listings: [{ listing_excerpt: 'DHA PHASE 8 KARACHI', kind: 'OFFER' }] }, ctx('DHA PHASE 8 KARACHI'));
  assert.equal(empty.length, 1);
  assert.equal(empty[0].is_property, false);
  const chat = buildRows({ is_property: false, listings: [] }, ctx('Assalam o alaikum sab ko'));
  assert.equal(chat.length, 1);
  assert.equal(chat[0].is_property, false);
  assert.equal(chat[0].needs_review, false);
});

test('Req shorthand is tagged as a requirement', () => {
  const text = 'Req 500 yards plot in Phase 6';
  const [row] = buildRows({
    is_property: true, listings: [{
      listing_excerpt: text, kind: 'OFFER', property_type: 'PLOT',
      vicinity: 'Phase 6', phase: 6, size: '500 yards', size_value: 500, size_unit: 'SQ_YD'
    }]
  }, ctx(text));
  assert.equal(row.listing_kind, 'REQUIREMENT');
  assert.equal(row.category, 'INQUIRY');
});

test('phase 5 to 7 is kept for every phase in the range', () => {
  const text = 'Required 1000 yards Phase 5 to 7';
  const [row] = buildRows({
    is_property: true, listings: [{
      listing_excerpt: text, kind: 'REQUIREMENT', property_type: 'PLOT',
      vicinity: 'Phase 5 to 7', phase: 5, phase_max: 7, size: '1000 yards', size_value: 1000, size_unit: 'SQ_YD'
    }]
  }, ctx(text));
  assert.equal(row.phase, 5);
  assert.equal(row.phase_max, 7);
  assert.ok(row.place_tags.includes('Phase 6'));
});

test('A Market without a written phase is Phase 2', () => {
  const text = '500 yards A Market west open';
  const [row] = buildRows({
    is_property: true, listings: [{
      listing_excerpt: text, kind: 'OFFER', property_type: 'PLOT',
      vicinity: 'A Market', phase: null, size: '500 yards', size_value: 500, size_unit: 'SQ_YD'
    }]
  }, ctx(text));
  assert.equal(row.phase, 2);
});

test('REQUIREMENT posts keep the model phase', () => {
  const text = 'REQUIRED 1000 YARDS PLOT IN PHASE 6 MUST BE 75 FRONT';
  const [row] = buildRows({
    is_property: true, listings: [{
      listing_excerpt: text, kind: 'REQUIREMENT', property_type: 'PLOT',
      vicinity: 'Phase 6', phase: 6, size: '1000 YARDS', size_value: 1000, size_unit: 'SQ_YD'
    }]
  }, ctx(text));
  assert.equal(row.listing_kind, 'REQUIREMENT');
  assert.equal(row.category, 'INQUIRY');
  assert.equal(row.phase, 6);
});

test('commission / white-money required is not requirement inventory', () => {
  const cases = [
    '500 yards Phase 6 west open demand 5 cr. Commission required.',
    'Plot available Phase 5. Percentage % required.',
    'Bungalow for sale covering required',
    'House Phase 6 renovation required',
    'Serious buyer. Profile required.',
    'For rent Phase 8 tenant profile required',
    '500 yards available offer required',
    'Required 50% white money. 500 yards Phase 6 demand 4 cr',
  ];
  for (const text of cases) {
    const [row] = buildRows({
      is_property: true, listings: [{
        listing_excerpt: text, kind: 'REQUIREMENT', property_type: 'PLOT',
        vicinity: 'Phase 6', phase: 6, size: '500 yards', size_value: 500, size_unit: 'SQ_YD'
      }]
    }, ctx(text));
    assert.equal(row.listing_kind, 'OFFER', text);
  }
});

test('buyer-wanted inventory stays an offer, rent/purchase reqs stay requirements', () => {
  const buyers = buildRows({
    is_property: true, listings: [{
      listing_excerpt: 'Looking for serious buyers 500 yards Phase 6 demand 5 cr',
      kind: 'REQUIREMENT', property_type: 'PLOT', vicinity: 'Phase 6', phase: 6,
      size: '500 yards', size_value: 500, size_unit: 'SQ_YD'
    }]
  }, ctx('Looking for serious buyers 500 yards Phase 6 demand 5 cr'));
  assert.equal(buyers[0].listing_kind, 'OFFER');

  const rentReq = buildRows({
    is_property: true, listings: [{
      listing_excerpt: 'Looking to rent 500 yards bungalow in Phase 6',
      kind: 'OFFER', purpose: 'RENT', property_type: 'BUNGALOW', vicinity: 'Phase 6', phase: 6,
      size: '500 yards', size_value: 500, size_unit: 'SQ_YD'
    }]
  }, ctx('Looking to rent 500 yards bungalow in Phase 6'));
  assert.equal(rentReq[0].listing_kind, 'REQUIREMENT');

  const buyReq = buildRows({
    is_property: true, listings: [{
      listing_excerpt: 'Plot chahiye Phase 5 200 yards',
      kind: 'OFFER', purpose: 'SALE', property_type: 'PLOT', vicinity: 'Phase 5', phase: 5,
      size: '200 yards', size_value: 200, size_unit: 'SQ_YD'
    }]
  }, ctx('Plot chahiye Phase 5 200 yards'));
  assert.equal(buyReq[0].listing_kind, 'REQUIREMENT');
});

test('normalization calls OpenAI only', () => {
  assert.deepEqual(LLM_PROVIDERS, ['openai']);
});

test('extractMessage uses injected model and cleans the text it sends', async () => {
  let seen;
  const out = await extractMessage({ message: '*Demand:* 13.Crore', sender: 'a' }, {
    model: 'mock',
    callModel: async ({ user }) => { seen = user; return { is_property: false, listings: [] }; }
  });
  assert.match(seen, /Demand: 13 Crore/);
  assert.equal(out.extraction.is_property, false);
});

test('gemini schema asks for stored search fields', () => {
  const g = toGeminiSchema(EXTRACTION_SCHEMA);
  const l = g.properties.listings.items.properties;
  assert.equal(g.type, 'OBJECT');
  assert.equal(l.price.type, 'STRING');
  assert.equal(l.price.nullable, true);
  assert.equal(l.price_value.type, 'NUMBER');
  assert.equal(l.vicinity.type, 'STRING');
  assert.equal(l.phase.type, 'INTEGER');
  assert.equal(l.place_tags.type, 'ARRAY');
  assert.ok(!l.purpose.enum.includes(null));
  assert.equal(g.properties.listings.maxItems, '40');
});
