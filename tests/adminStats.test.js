const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUsageQuery } = require('../adminStats');

test('custom from/to is inclusive PKT and exclusive end', () => {
  const parsed = parseUsageQuery({ from: '2026-10-01', to: '2026-10-10' });
  assert.equal(parsed.custom, true);
  assert.equal(parsed.all, false);
  assert.equal(parsed.start, '2026-10-01 00:00:00+05');
  assert.equal(parsed.end, '2026-10-11 00:00:00+05');
  assert.match(parsed.rangeLabel, /Oct/);
});

test('swaps inverted custom range', () => {
  const parsed = parseUsageQuery({ from: '2026-11-10', to: '2026-11-01' });
  assert.equal(parsed.from, '2026-11-01');
  assert.equal(parsed.to, '2026-11-10');
});

test('all time still works', () => {
  const parsed = parseUsageQuery({ all: '1' });
  assert.equal(parsed.all, true);
  assert.equal(parsed.custom, false);
  assert.equal(parseUsageQuery({ all: 'all' }).all, true);
});

test('month query still works', () => {
  const parsed = parseUsageQuery({ year: '2026', month: '7' });
  assert.equal(parsed.all, false);
  assert.equal(parsed.custom, false);
  assert.equal(parsed.year, 2026);
  assert.equal(parsed.month, 7);
  assert.match(parsed.start, /^2026-07-01/);
});
