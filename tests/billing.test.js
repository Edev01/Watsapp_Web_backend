const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasAccess,
  publicBilling,
  calendarMonthsInclusive,
  shouldPurgeUser,
  retentionCutoffIso,
  graceUntilFrom,
  PLAN_AMOUNT_PKR
} = require('../billing');

test('PKR 7000 monthly plan constant', () => {
  assert.equal(PLAN_AMOUNT_PKR, 7000);
});

test('complimentary always has access', () => {
  assert.equal(hasAccess({ status: 'complimentary' }), true);
  assert.equal(publicBilling({ status: 'complimentary' }).paywall, false);
});

test('unpaid user keeps access until grace', () => {
  const now = new Date('2026-11-05T10:00:00+05:00');
  const grace = new Date('2026-11-12T10:00:00+05:00');
  assert.equal(hasAccess({ status: 'unpaid', grace_until: grace }, now), true);
  assert.equal(hasAccess({ status: 'unpaid', grace_until: grace }, new Date('2026-11-13T10:00:00+05:00')), false);
});

test('active period plus 10-day grace', () => {
  const now = new Date('2026-12-08T10:00:00+05:00');
  assert.equal(hasAccess({
    status: 'active',
    current_period_end: new Date('2026-12-02T10:00:00+05:00'),
    grace_until: new Date('2026-12-12T10:00:00+05:00')
  }, now), true);
  assert.equal(hasAccess({
    status: 'past_due',
    grace_until: new Date('2026-12-12T10:00:00+05:00')
  }, new Date('2026-12-13T10:00:00+05:00')), false);
});

test('7th calendar month is when first-month data can drop', () => {
  const created = new Date('2026-01-15T12:00:00+05:00');
  assert.equal(calendarMonthsInclusive(created, new Date('2026-06-20T12:00:00+05:00')), 6);
  assert.equal(shouldPurgeUser(created, new Date('2026-06-20T12:00:00+05:00')), false);
  assert.equal(shouldPurgeUser(created, new Date('2026-07-01T12:00:00+05:00')), true);
});

test('July cutoff keeps Feb–Jul (drops January)', () => {
  const cutoff = retentionCutoffIso(new Date('2026-07-15T12:00:00+05:00'));
  assert.match(cutoff, /^2026-02-01/);
});

test('grace is 10 days', () => {
  const start = new Date('2026-11-02T00:00:00Z');
  const g = graceUntilFrom(start, 10);
  assert.equal(Math.round((g.getTime() - start.getTime()) / 86400000), 10);
});
