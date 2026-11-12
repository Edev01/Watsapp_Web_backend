const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function mockLoad(request, parent, isMain) {
  if (request === 'dotenv') return { config: () => ({}) };
  return originalLoad.apply(this, arguments);
};
const { parseWebhook } = require('../safepayClient');
Module._load = originalLoad;

/** Payload shape from Safepay sandbox Webhook Logs (PAYMENT:CREATED). */
const createdBody = {
  type: 'PAYMENT:CREATED',
  data: {
    amount: '7000.00',
    currency: 'PKR',
    fee: '443.45',
    intent: 'CYBERSOURCE',
    merchant_api_key: 'sec_test',
    net: '6556.55',
    notification_id: 'DBQPU15L2AHS7395P81G',
    payment_metadata: [
      {
        created_at: '2026-11-12T11:12:04Z',
        meta_key: 'order_id',
        meta_value: 'user-8-1794481807570',
        payment_notification_id: 'DBQPU15L2AHS7395P820',
        token: 'DBQPU15L2AHS7395P82G',
        updated_at: '2026-11-12T11:12:06Z',
      },
      {
        created_at: '2026-11-12T11:12:04Z',
        meta_key: 'source',
        meta_value: 'custom',
      },
    ],
  },
};

test('PAYMENT:CREATED with payment_metadata order_id maps user and marks paid', () => {
  const ev = parseWebhook(createdBody);
  assert.equal(ev.userId, 8);
  assert.equal(ev.reference, 'user-8-1794481807570');
  assert.equal(ev.meta.order_id, 'user-8-1794481807570');
  assert.equal(ev.paid, true);
  assert.equal(ev.failed, false);
});

test('wrapped {data} without type still maps order_id and marks paid', () => {
  const ev = parseWebhook({ data: createdBody.data });
  assert.equal(ev.userId, 8);
  assert.equal(ev.reference, 'user-8-1794481807570');
  assert.equal(ev.paid, true);
});

test('PAYMENT.SUCCEEDED with payment_metadata order_id marks paid', () => {
  const ev = parseWebhook({
    type: 'PAYMENT.SUCCEEDED',
    data: {
      amount: '7000.00',
      payment_metadata: [{ meta_key: 'order_id', meta_value: 'user-8-99' }],
    },
  });
  assert.equal(ev.userId, 8);
  assert.equal(ev.paid, true);
});

test('payment.completed event marks paid', () => {
  const ev = parseWebhook({
    type: 'payment.completed',
    data: { reference: 'user-4-123', state: 'TRACKER_ENDED' },
  });
  assert.equal(ev.userId, 4);
  assert.equal(ev.paid, true);
});

test('failed payment does not mark paid', () => {
  const ev = parseWebhook({
    type: 'PAYMENT.FAILED',
    data: {
      amount: '7000.00',
      payment_metadata: [{ meta_key: 'order_id', meta_value: 'user-8-1' }],
    },
  });
  assert.equal(ev.userId, 8);
  assert.equal(ev.failed, true);
  assert.equal(ev.paid, false);
});

test('live Safepay envelope: data.notification.state=PAID + metadata.order_id', () => {
  const ev = parseWebhook({
    data: {
      token: 'DBQRF9DL2AHS7395P8A0',
      type: 'payment:created',
      endpoint: 'https://example.com/api/billing/webhook',
      notification: {
        tracker: 'track_90523d16-314f-46f2-aa56-27f83d34de7d',
        reference: '738987',
        intent: 'CYBERSOURCE',
        fee: '443.45',
        net: '6556.55',
        user: 'omerkhan.dev@ae.co',
        state: 'PAID',
        amount: '7000.00',
        currency: 'PKR',
        metadata: { order_id: 'user-8-1794488138729', source: 'custom' },
      },
      delivery_attempts: 1,
      resource: 'notification',
    },
  });
  assert.equal(ev.userId, 8);
  assert.equal(ev.reference, 'user-8-1794488138729');
  assert.equal(ev.paid, true);
  assert.equal(ev.meta.order_id, 'user-8-1794488138729');
});
