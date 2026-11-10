const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasAccess,
  publicBilling,
  daysRemaining,
  inRenewalGrace,
  calendarMonthsInclusive,
  shouldPurgeUser,
  retentionCutoffIso,
  graceUntilFrom,
  PLAN_AMOUNT_PKR,
  GRACE_DAYS
} = require('../billing');

test('PKR 7000 monthly plan constant', () => {
  assert.equal(PLAN_AMOUNT_PKR, 7000);
});

test('complimentary always has access', () => {
  assert.equal(hasAccess({ status: 'complimentary' }), true);
  assert.equal(publicBilling({ status: 'complimentary' }).paywall, false);
});

test('new unpaid user is paywalled on day one (no grace)', () => {
  const now = new Date('2026-11-05T10:00:00+05:00');
  assert.equal(hasAccess({ status: 'unpaid', grace_until: null }, now), false);
  assert.equal(publicBilling({ status: 'unpaid', grace_until: null }, now).paywall, true);
  // Even a future grace_until must not unlock brand-new accounts that never paid.
  assert.equal(hasAccess({
    status: 'unpaid',
    grace_until: new Date('2026-11-10T10:00:00+05:00'),
    last_paid_at: null
  }, now), false);
});

test('after paid month ends, 5-day renewal grace applies', () => {
  const now = new Date('2026-12-04T10:00:00+05:00');
  assert.equal(hasAccess({
    status: 'active',
    last_paid_at: new Date('2026-11-02T10:00:00+05:00'),
    current_period_end: new Date('2026-12-02T10:00:00+05:00'),
    grace_until: new Date('2026-12-07T10:00:00+05:00')
  }, now), true);
  assert.equal(inRenewalGrace({
    status: 'past_due',
    last_paid_at: new Date('2026-11-02T10:00:00+05:00'),
    grace_until: new Date('2026-12-07T10:00:00+05:00')
  }, now), true);
  assert.equal(hasAccess({
    status: 'past_due',
    last_paid_at: new Date('2026-11-02T10:00:00+05:00'),
    grace_until: new Date('2026-12-07T10:00:00+05:00')
  }, new Date('2026-12-08T10:00:00+05:00')), false);
});

test('daysRemaining: active uses period end; renewal grace uses grace_until', () => {
  const now = new Date('2026-11-05T10:00:00+05:00');
  assert.equal(daysRemaining({
    status: 'unpaid',
    grace_until: null
  }, now), 0);
  assert.equal(daysRemaining({
    status: 'past_due',
    last_paid_at: new Date('2026-10-05T10:00:00+05:00'),
    grace_until: new Date('2026-11-10T10:00:00+05:00')
  }, now), 5);
  assert.equal(daysRemaining({
    status: 'active',
    last_paid_at: new Date('2026-10-15T10:00:00+05:00'),
    current_period_end: new Date('2026-11-15T10:00:00+05:00'),
    grace_until: new Date('2026-11-20T10:00:00+05:00')
  }, now), 10);
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

test('grace is 5 days', () => {
  assert.equal(GRACE_DAYS, 5);
  const start = new Date('2026-11-02T00:00:00Z');
  const g = graceUntilFrom(start, GRACE_DAYS);
  assert.equal(Math.round((g.getTime() - start.getTime()) / 86400000), 5);
});
