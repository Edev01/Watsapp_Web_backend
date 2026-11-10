require('dotenv').config();
const { PLAN_AMOUNT_PKR } = require('./billing');

function safepayConfigured() {
  return Boolean(process.env.SAFEPAY_API_KEY && (process.env.SAFEPAY_V1_SECRET || process.env.SAFEPAY_SECRET_KEY));
}

function environment() {
  const raw = String(process.env.SAFEPAY_ENVIRONMENT || process.env.SAFEPAY_ENV || 'sandbox').toLowerCase();
  return raw === 'production' || raw === 'prod' ? 'production' : 'sandbox';
}

function apiHost() {
  return environment() === 'production'
    ? 'https://api.getsafepay.com'
    : 'https://sandbox.api.getsafepay.com';
}

function checkoutHost() {
  return apiHost();
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

// Safepay PKR via @sfpy/node-sdk expects amount in rupees (not paisa).
function amountForCheckout() {
  return PLAN_AMOUNT_PKR;
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

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function normalizePkPhone(phone) {
  let p = String(phone || '').replace(/[^\d+]/g, '');
  if (!p) return '';
  if (p.startsWith('00')) p = `+${p.slice(2)}`;
  if (p.startsWith('+92')) return p;
  if (p.startsWith('92') && p.length >= 12) return `+${p}`;
  if (p.startsWith('0') && p.length === 11) return `+92${p.slice(1)}`;
  if (/^\d{10}$/.test(p)) return `+92${p}`;
  return p.startsWith('+') ? p : `+${p}`;
}

function customerFromUser(user = {}) {
  const { firstName, lastName } = splitName(user.name || user.fullName || '');
  return {
    email: String(user.email || '').trim(),
    firstName,
    lastName,
    phone: normalizePkPhone(user.phone_number || user.phone || ''),
    country: 'PK'
  };
}

async function createSafepayCustomer(customer) {
  if (!customer.email && !customer.phone) return null;
  try {
    const res = await fetch(`${apiHost()}/user/customers/v1/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sfpy-merchant-secret': v1Secret()
      },
      body: JSON.stringify({
        first_name: customer.firstName || 'PropSync',
        last_name: customer.lastName || 'User',
        email: customer.email || undefined,
        phone_number: customer.phone || undefined,
        country: customer.country || 'PK',
        is_guest: true
      })
    });
    const json = await res.json().catch(() => ({}));
    const token = json?.data?.token || json?.token || null;
    if (!token) {
      console.warn('[safepay] customer create skipped:', json?.status?.message || res.status);
    }
    return token;
  } catch (err) {
    console.warn('[safepay] customer create failed:', err.message);
    return null;
  }
}

function withCustomerPrefill(checkoutUrl, customer, customerToken) {
  if (!checkoutUrl) return checkoutUrl;
  try {
    const u = new URL(checkoutUrl);
    if (customerToken) u.searchParams.set('user_id', customerToken);
    if (customer.email) {
      u.searchParams.set('email', customer.email);
    }
    if (customer.firstName) {
      u.searchParams.set('first_name', customer.firstName);
      u.searchParams.set('firstName', customer.firstName);
    }
    if (customer.lastName) {
      u.searchParams.set('last_name', customer.lastName);
      u.searchParams.set('lastName', customer.lastName);
    }
    if (customer.phone) {
      u.searchParams.set('phone', customer.phone);
      u.searchParams.set('phone_number', customer.phone);
      u.searchParams.set('contact', customer.phone);
    }
    if (customer.country) {
      u.searchParams.set('country', customer.country);
    }
    // Sensible PK defaults so Pay button can enable when admin only stored name/email/phone.
    if (!u.searchParams.get('city')) u.searchParams.set('city', 'Karachi');
    if (!u.searchParams.get('street_address') && !u.searchParams.get('address')) {
      u.searchParams.set('street_address', 'PropSync account');
      u.searchParams.set('address', 'PropSync account');
    }
    return u.toString();
  } catch (_) {
    return checkoutUrl;
  }
}

async function createSubscriptionCheckout({ userId, email, name, phone } = {}) {
  if (!safepayConfigured()) {
    const err = new Error('Safepay is not configured (SAFEPAY_API_KEY / SAFEPAY_V1_SECRET)');
    err.code = 'SAFEPAY_NOT_CONFIGURED';
    throw err;
  }
  const customer = customerFromUser({ email, name, phone_number: phone });
  const customerToken = await createSafepayCustomer(customer);
  const planId = process.env.SAFEPAY_PLAN_ID || '';
  const reference = `user-${userId}-${Date.now()}`;
  const redirectUrl = `${frontendBase()}/dashboard?billing=success`;
  const cancelUrl = `${frontendBase()}/dashboard?billing=cancel`;

  if (planId) {
    try {
      const client = makeClient();
      let url = await client.checkout.createSubscription({
        planId,
        reference,
        redirectUrl,
        cancelUrl
      });
      url = typeof url === 'string' ? url : url?.url || url;
      return {
        url: withCustomerPrefill(url, customer, customerToken),
        reference,
        planId,
        mode: 'subscription',
        amountPkr: PLAN_AMOUNT_PKR,
        prefill: {
          email: customer.email,
          firstName: customer.firstName,
          lastName: customer.lastName,
          phone: customer.phone
        }
      };
    } catch (err) {
      if (err.code !== 'MODULE_NOT_FOUND') {
        console.warn('[safepay] subscription checkout failed, trying one-time:', err.message);
      }
    }
  }

  return createOneTimeCheckout({
    userId,
    reference,
    redirectUrl,
    cancelUrl,
    customer,
    customerToken
  });
}

async function createOneTimeCheckout({
  userId,
  reference,
  redirectUrl,
  cancelUrl,
  customer = {},
  customerToken = null
} = {}) {
  const amount = amountForCheckout();
  try {
    const client = makeClient();
    const created = await client.payments.create({
      amount,
      currency: 'PKR'
    });
    const token = created?.token || created?.data?.token || created;
    let url = client.checkout.create({
      token,
      orderId: reference,
      cancelUrl,
      redirectUrl,
      source: 'custom',
      webhooks: true
    });
    url = typeof url === 'string' ? url : url?.url || url;
    return {
      url: withCustomerPrefill(url, customer, customerToken),
      reference,
      token: typeof token === 'string' ? token : null,
      mode: 'payment',
      amountPkr: PLAN_AMOUNT_PKR,
      prefill: {
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone
      }
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
      if (customer.email) params.set('email', customer.email);
      if (customer.firstName) params.set('first_name', customer.firstName);
      if (customer.lastName) params.set('last_name', customer.lastName);
      if (customer.phone) params.set('phone_number', customer.phone);
      if (customerToken) params.set('user_id', customerToken);
      if (userId) params.set('user_id_internal', String(userId));
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
  parseWebhook,
  customerFromUser,
  normalizePkPhone
};
