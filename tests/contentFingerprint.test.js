const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stripTrailingContactAndName,
  bodyExactKey,
  footerExactKey,
  userMessageFingerprint,
  userMessageBodyFingerprint,
} = require('../contentFingerprint');

const BODY_A = '500 yards Phase 6 west open plot near park for sale Demand 5 cr only';
const BODY_B = '1000 yards Phase 8 corner plot near mosque for sale Demand 9 cr only';

test('strips trailing contact and name into body vs footer', () => {
  const a = `${BODY_A}\nContact: 03001234567\nAli Khan`;
  const b = `${BODY_A}\n03219876543\nSara Ahmed`;
  assert.equal(stripTrailingContactAndName(a), BODY_A);
  assert.equal(bodyExactKey(a), bodyExactKey(b));
  assert.notEqual(footerExactKey(a), footerExactKey(b));
});

test('same body + different footer → different full fingerprint (keep new)', () => {
  const a = `${BODY_A}\nContact: 03001234567\nAli Khan`;
  const b = `${BODY_A}\n03219876543\nSara Ahmed`;
  assert.ok(userMessageFingerprint(4, a));
  assert.ok(userMessageFingerprint(4, b));
  assert.equal(userMessageBodyFingerprint(4, a), userMessageBodyFingerprint(4, b));
  assert.notEqual(userMessageFingerprint(4, a), userMessageFingerprint(4, b));
});

test('same body + same footer → same full fingerprint (true duplicate)', () => {
  const a = `${BODY_A}\n03001234567\nAli Khan`;
  const b = `${BODY_A}\n0300-1234567\nAli Khan`;
  assert.equal(userMessageBodyFingerprint(4, a), userMessageBodyFingerprint(4, b));
  assert.equal(userMessageFingerprint(4, a), userMessageFingerprint(4, b));
});

test('different body + same footer → different fingerprints (keep both)', () => {
  const a = `${BODY_A}\n03001234567\nAli Khan`;
  const b = `${BODY_B}\n03001234567\nAli Khan`;
  assert.notEqual(userMessageBodyFingerprint(4, a), userMessageBodyFingerprint(4, b));
  assert.notEqual(userMessageFingerprint(4, a), userMessageFingerprint(4, b));
  assert.equal(footerExactKey(a), footerExactKey(b));
});

test('a forwarded copy matches body; footer still compared for full fp', () => {
  const original = `${BODY_A}\n03001234567`;
  const forwardedSameFooter = `Forwarded\n\n${BODY_A}\n03001234567`;
  const forwardedDiffFooter = `Forwarded\n\n${BODY_A}\n03219876543\nAli`;
  assert.equal(bodyExactKey(original), bodyExactKey(forwardedSameFooter));
  assert.equal(userMessageFingerprint(4, original), userMessageFingerprint(4, forwardedSameFooter));
  assert.equal(bodyExactKey(original), bodyExactKey(forwardedDiffFooter));
  assert.notEqual(userMessageFingerprint(4, original), userMessageFingerprint(4, forwardedDiffFooter));
});

test('one character change in the body keeps two fingerprints', () => {
  const a = `${BODY_A}\n03001234567`;
  const b = `${BODY_A.replace('5 cr', '5.1 cr')}\n03001234567`;
  assert.notEqual(bodyExactKey(a), bodyExactKey(b));
  assert.notEqual(userMessageFingerprint(4, a), userMessageFingerprint(4, b));
});
