require('dotenv').config();
const { PLAN_AMOUNT_PKR } = require('./billing');

function safepayConfigured() {
  return Boolean(process.env.SAFEPAY_API_KEY && (process.env.SAFEPAY_V1_SECRET || process.env.SAFEPAY_SECRET_KEY));
}

function environment() {
  const raw = String(process.env.SAFEPAY_ENVIRONMENT || process.env.SAFEPAY_ENV || 'sandbox').toLowerCase();
  return raw === 'production' || raw === 'prod' ? 'production' : 'sandbox';
}

function checkoutHost() {
  return environment() === 'production'
    ? 'https://api.getsafepay.com'
    : 'https://sandbox.api.getsafepay.com';
}

function frontendBase() {
  return String(process.env.FRONTEND_URL || 'https://propsync-delta.vercel.app').replace(/\/$/, '');
}

function v1Secret() {
  return process.env.SAFEPAY_V1_SECRET || process.env.SAFEPAY_SECRET_KEY || '';
}

function webhookSecret() {
  return process.env.SAFEPAY_WEBHOOK_SECRET || v1Secret();
}

function amountMinorUnits() {
  return PLAN_AMOUNT_PKR * 100;
}

function makeClient() {
  const { Safepay } = require('@sfpy/node-sdk');
  return new Safepay({
    environment: environment(),
    apiKey: process.env.SAFEPAY_API_KEY,
    v1Secret: v1Secret(),
    webhookSecret: webhookSecret()
  });
}

async function createSubscriptionCheckout({ userId, email }) {
  if (!safepayConfigured()) {
    const err = new Error('Safepay is not configured (SAFEPAY_API_KEY / SAFEPAY_V1_SECRET)');
    err.code = 'SAFEPAY_NOT_CONFIGURED';
    throw err;
  }
  const planId = process.env.SAFEPAY_PLAN_ID || '';
  const reference = `user-${userId}-${Date.now()}`;
  const redirectUrl = `${frontendBase()}/dashboard?billing=success`;
  const cancelUrl = `${frontendBase()}/dashboard?billing=cancel`;

  if (planId) {
    try {
      const client = makeClient();
      const url = await client.checkout.createSubscription({
        planId,
        reference,
        redirectUrl,
        cancelUrl
      });
      return {
        url: typeof url === 'string' ? url : url?.url || url,
        reference,
        planId,
        mode: 'subscription'
      };
    } catch (err) {
      if (err.code !== 'MODULE_NOT_FOUND') {
        console.warn('[safepay] subscription checkout failed, trying one-time:', err.message);
      }
    }
  }

  return createOneTimeCheckout({ userId, email, reference, redirectUrl, cancelUrl });
}

async function createOneTimeCheckout({ userId, email, reference, redirectUrl, cancelUrl }) {
  const amount = amountMinorUnits();
  try {
    const client = makeClient();
    const created = await client.payments.create({
      amount,
      currency: 'PKR'
    });
    const token = created?.token || created?.data?.token || created;
    const url = client.checkout.create({
      token,
      orderId: reference,
      cancelUrl,
      redirectUrl,
      source: 'custom',
      webhooks: true
    });
    return {
      url: typeof url === 'string' ? url : url?.url || url,
      reference,
      token: typeof token === 'string' ? token : null,
      mode: 'payment',
      amountPkr: PLAN_AMOUNT_PKR
    };
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      const params = new URLSearchParams({
        amount: String(amount),
        currency: 'PKR',
        reference,
        redirect_url: redirectUrl,
        cancel_url: cancelUrl,
        env: environment() === 'production' ? 'prod' : 'sandbox',
        source: 'custom'
      });
      if (email) params.set('email', email);
      if (userId) params.set('user_id', String(userId));
      return {
        url: `${checkoutHost()}/checkout/pay?${params.toString()}`,
        reference,
        mode: 'payment',
        amountPkr: PLAN_AMOUNT_PKR
      };
    }
    throw err;
  }
}

function parseWebhook(body) {
  const payload = body && typeof body === 'object' ? body : {};
  const data = payload.data || payload.payload || payload;
  const tracker = data.tracker || payload.tracker || {};
  const type = String(
    payload.type || payload.event || payload.name || data.type || tracker.state || ''
  ).toLowerCase();
  const blob = JSON.stringify(payload);
  const reference = String(
    data.reference
    || data.metadata?.reference
    || data.metadata?.order_id
    || payload.reference
    || tracker.reference
    || tracker.metadata?.order_id
    || tracker.metadata?.reference
    || data.tracker?.reference
    || data.order_id
    || (blob.match(/user-\d+-\d+/) || [''])[0]
    || ''
  );
  const userIdMatch = blob.match(/user-(\d+)/i) || reference.match(/user-(\d+)/i);
  const userId = userIdMatch
    ? Number(userIdMatch[1])
    : Number(data.user_id || data.customer?.metadata?.user_id || 0) || null;
  const subscriptionId = data.subscription_id || data.subscription?.id || data.id || null;
  const paid =
    /success|succeeded|paid|charged|completed|tracker_ended|payment_complete/i.test(type) ||
    /success|succeeded|paid|completed|ended/i.test(String(data.state || data.status || tracker.state || ''));
  const failed = /fail|declined|unpaid/i.test(type) || /fail|declined/i.test(String(data.state || data.status || ''));
  const canceled = /cancel/i.test(type) || /cancel/i.test(String(data.state || data.status || ''));
  return {
    type,
    userId,
    reference,
    subscriptionId,
    paid,
    failed,
    canceled,
    payload
  };
}

module.exports = {
  safepayConfigured,
  environment,
  createSubscriptionCheckout,
  parseWebhook
};
