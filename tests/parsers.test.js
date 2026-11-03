const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanText, parsePrice, parseSize, parsePhase } = require('../ai/extract/parsers');

const P = (t, o) => parsePrice(t, o);

test('price: BTK @ prefix is asking price', () => {
  assert.equal(P('@ 4.50').value, 45000000);
  assert.equal(P('@85').value, 8500000);
  assert.equal(P('@ 85 lac').value, 8500000);
});

test('price: compound crore + lakh (prod id 30834)', () => {
  assert.equal(P('PKR (1 Crore 90 Lakh)').value, 19000000);
  assert.equal(P('1 crore 15 lakh').value, 11500000);
  assert.equal(P('1 Crore 15 lak').value, 11500000);
  assert.equal(P('1 Crore 15 lack').value, 11500000);
});

test('price: repeated figure in brackets is not double counted', () => {
  assert.equal(P('1 Crore 90 Lakh (1.9 Cr)').value, 19000000);
});

test('price: dot glued to unit and markdown asterisks (A1, A3)', () => {
  assert.equal(P('13.Crore').value, 130000000);
  assert.equal(P('*Rs. 4.5* Cr').value, 45000000);
  assert.equal(P('Rs. 5.25* Lac Negotiable').value, 525000);
});

test('price: lac + thousand (C9)', () => {
  assert.equal(P('2 LAC 50 THOUSAND').value, 250000);
});

test('price: trailing bare number is next unit, flagged inferred', () => {
  const r = P('1 crore 15');
  assert.equal(r.value, 11500000);
  assert.equal(r.inferred, true);
});

test('price: range', () => {
  const r = P('80 to 85 lakh');
  assert.deepEqual([r.min, r.max], [8000000, 8500000]);
  const r2 = P('80-85 lac');
  assert.deepEqual([r2.min, r2.max], [8000000, 8500000]);
});

test('price: bare numbers need a unit hint', () => {
  assert.equal(P('145').value, null);
  assert.ok(P('145').warnings.includes('bare_number_no_unit'));
  const r = P('145', { bareUnit: 'LAKH' });
  assert.equal(r.value, 14500000);
  assert.equal(r.inferred, true);
  assert.equal(P('Dem 12', { bareUnit: 'CRORE' }).value, 120000000);
});

test('price: k and rupees, rent defaults to monthly', () => {
  const r = P('Rs 150,000', { purpose: 'RENT' });
  assert.equal(r.value, 150000);
  assert.equal(r.basis, 'PER_MONTH');
  assert.equal(P('Demand 95k').value, 95000);
});

test('price: rates and per-floor are not totals', () => {
  assert.equal(P('4 Crore/floor').basis, 'PER_FLOOR');
  assert.equal(P('1.5 lakh per sq yd').basis, 'PER_SQ_YD');
});

test('price: phone numbers are never prices', () => {
  assert.equal(P('03001234567').value, null);
  assert.equal(P('Call 0321-8274073').value, null);
});

test('price: on call', () => {
  assert.equal(P('Demand?').value, null);
  assert.equal(P('Price on call').basis, 'ON_CALL');
});

test('size: yards / yrds / sqft variants (A2, C2, C9)', () => {
  assert.equal(parseSize('500 yards').sqft, 4500);
  assert.equal(parseSize('1000yrds').sqft, 9000);
  assert.equal(parseSize('100 YARDS').sqft, 900);
  assert.equal(parseSize('200 Sqyds').sqft, 1800);
  assert.equal(parseSize('530 Square Yards').sqft, 4770);
  assert.equal(parseSize('2000sq.ft').sqft, 2000);
});

test('size: "850 & 300 sqfeet" keeps primary + extra', () => {
  const s = parseSize('850 & 300 sqfeet');
  assert.equal(s.value, 850);
  assert.equal(s.sqft, 850);
  assert.equal(s.extra_sqft, 300);
});

test('size: marla / kanal, and LLM fallback, and dims fallback', () => {
  assert.equal(parseSize('5 marla').sqft, 1125);
  assert.equal(parseSize('2 Kanal').sqft, 9000);
  assert.equal(parseSize(null, { value: 300, unit: 'SQ_YD' }).sqft, 2700);
  assert.equal(parseSize(null, { dimensionsText: '60x100' }).sqft, 6000);
});

test('size: bedrooms, series and phone numbers are not sizes', () => {
  assert.equal(parseSize('2+1 bedrooms').value, null);
  assert.equal(parseSize('PLOT 50 SERIES').value, null);
});

test('phase: only from literal text', () => {
  assert.equal(parsePhase('PHASE 6').phase, 6);
  assert.equal(parsePhase('Defence Phase VI').phase, 6);
  assert.equal(parsePhase('Phase VIII E8').phase, 8);
  assert.equal(parsePhase('Ph-5').phase, 5);
  assert.equal(parsePhase('DHA Phase 7 Extension').extension, true);
  assert.equal(parsePhase('Rahat Commercial').phase, null);
  assert.equal(parsePhase(null).phase, null);
});

test('cleanText fixes WhatsApp noise', () => {
  assert.equal(cleanText('*Demand:* 13.Crore'), 'Demand: 13 Crore');
  assert.equal(cleanText('٢ لاکھ'), '2 لاکھ');
});
