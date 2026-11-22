const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUsageQuery, parseMessageQuery } = require('../adminStats');

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

test('message custom range is inclusive PKT', () => {
  const parsed = parseMessageQuery({
    msgPreset: 'custom',
    msgFrom: '2026-11-01',
    msgTo: '2026-11-03'
  });
  assert.equal(parsed.preset, 'custom');
  assert.equal(parsed.from, '2026-11-01');
  assert.equal(parsed.to, '2026-11-03');
  assert.equal(parsed.start, '2026-11-01 00:00:00+05');
  assert.equal(parsed.end, '2026-11-04 00:00:00+05');
});

test('this week starts on Monday', () => {
  const parsed = parseMessageQuery({ msgPreset: 'this week' });
  const [y, m, d] = parsed.from.split('-').map(Number);
  assert.equal(new Date(Date.UTC(y, m - 1, d)).getUTCDay(), 1);
  assert.ok(parsed.from <= parsed.to);
});

test('last week is Monday through Sunday', () => {
  const parsed = parseMessageQuery({ msgPreset: 'lastweek' });
  const [y, m, d] = parsed.from.split('-').map(Number);
  const end = parsed.to.split('-').map(Number);
  assert.equal(new Date(Date.UTC(y, m - 1, d)).getUTCDay(), 1);
  assert.equal(new Date(Date.UTC(end[0], end[1] - 1, end[2])).getUTCDay(), 0);
  assert.ok(parsed.from < parsed.to);
});

test('month query still works', () => {
  const parsed = parseUsageQuery({ year: '2026', month: '7' });
  assert.equal(parsed.all, false);
  assert.equal(parsed.custom, false);
  assert.equal(parsed.year, 2026);
  assert.equal(parsed.month, 7);
  assert.match(parsed.start, /^2026-07-01/);
});
