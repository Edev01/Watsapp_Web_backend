const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stripTrailingContactAndName,
  bodyExactKey,
  userMessageFingerprint,
} = require('../contentFingerprint');

test('same body with different trailing contact and name shares a fingerprint', () => {
  const a = '500 yards Phase 6 west open\nDemand 5 cr\nContact: 03001234567\nAli Khan';
  const b = '500 yards Phase 6 west open\nDemand 5 cr\n03219876543\nSara Ahmed';
  assert.equal(stripTrailingContactAndName(a), '500 yards Phase 6 west open\nDemand 5 cr');
  assert.equal(bodyExactKey(a), bodyExactKey(b));
  assert.equal(userMessageFingerprint(4, a), userMessageFingerprint(4, b));
});

test('a forwarded copy matches the original body fingerprint', () => {
  const original = '500 yards Phase 6 west open\nDemand 5 cr\n03001234567';
  const forwarded = 'Forwarded\n\n500 yards Phase 6 west open\nDemand 5 cr\n03219876543\nAli';
  assert.equal(bodyExactKey(original), bodyExactKey(forwarded));
});

test('one character change in the body keeps two fingerprints', () => {
  const a = '500 yards Phase 6 west open\nDemand 5 cr\n03001234567';
  const b = '500 yards Phase 6 west open\nDemand 5.1 cr\n03001234567';
  assert.notEqual(bodyExactKey(a), bodyExactKey(b));
});
