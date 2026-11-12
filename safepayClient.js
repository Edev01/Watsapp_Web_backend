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

/** Safepay Payments UI sends order_id inside payment_metadata[{meta_key, meta_value}]. */
function metaFromPaymentMetadata(data) {
  const rows = []
    .concat(data?.payment_metadata || [])
    .concat(data?.metadata || [])
    .concat(payloadArraySafe(data?.meta));
  const out = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const key = String(row.meta_key || row.key || row.name || '').trim();
    const val = row.meta_value ?? row.value ?? row.val;
    if (key && val != null && String(val).trim() !== '') out[key] = String(val).trim();
  }
  return out;
}

function payloadArraySafe(v) {
  return Array.isArray(v) ? v : [];
}

function parseWebhook(body) {
  const payload = body && typeof body === 'object' ? body : {};
  // Safepay may wrap as { data: {...} } or send notification at the root.
  const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data
    : (payload.payload && typeof payload.payload === 'object' ? payload.payload : payload);
  // Live deliveries nest amount/state/metadata under data.notification.
  const notice = (data.notification && typeof data.notification === 'object')
    ? data.notification
    : data;
  const tracker = notice.tracker || data.tracker || payload.tracker || {};
  const trackerObj = tracker && typeof tracker === 'object' ? tracker : {};
  const meta = {
    ...metaFromPaymentMetadata(notice),
    ...metaFromPaymentMetadata(data),
  };
  // object-style metadata: { order_id, source }
  for (const src of [notice.metadata, data.metadata, payload.metadata]) {
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      for (const [k, v] of Object.entries(src)) {
        if (v != null && String(v).trim() !== '' && meta[k] == null) meta[k] = String(v).trim();
      }
    }
  }
  const headerType = String(
    payload.headers?.['x-sfpy-event-type']
    || payload['X-SFPY-EVENT-TYPE']
    || ''
  );
  const type = String(
    payload.type
    || payload.event
    || payload.name
    || payload.event_type
    || data.type
    || data.event
    || data.event_type
    || notice.type
    || trackerObj.state
    || headerType
    || ''
  ).toLowerCase();
  const blob = JSON.stringify(payload);
  const reference = String(
    meta.order_id
    || meta.reference
    || notice.reference
    || notice.metadata?.order_id
    || notice.metadata?.reference
    || data.reference
    || data.metadata?.reference
    || data.metadata?.order_id
    || (typeof data.metadata === 'object' && !Array.isArray(data.metadata) ? data.metadata.order_id : null)
    || payload.reference
    || trackerObj.reference
    || trackerObj.metadata?.order_id
    || trackerObj.metadata?.reference
    || data.order_id
    || (blob.match(/user-\d+-\d+/) || [''])[0]
    || ''
  );
  // Prefer user-N from order_id; ignore bare tracker references like "738987".
  const orderRef = String(meta.order_id || notice.metadata?.order_id || data.metadata?.order_id || '')
    || (String(reference).match(/^user-\d+/i) ? reference : '')
    || (blob.match(/user-\d+-\d+/) || [''])[0]
    || reference;
  const userIdMatch = String(orderRef).match(/user-(\d+)/i) || blob.match(/user-(\d+)/i);
  const userId = userIdMatch
    ? Number(userIdMatch[1])
    : Number(notice.user_id || data.user_id || data.customer?.metadata?.user_id || 0) || null;
  const subscriptionId = data.subscription_id || data.subscription?.id || data.id || null;
  const state = String(
    notice.state || notice.status || data.state || data.status || trackerObj.state || data.payment_status || ''
  ).toLowerCase();
  const amount = notice.amount ?? data.amount;
  const fee = notice.fee ?? data.fee;
  const net = notice.net ?? data.net;
  const successType = /success|succeeded|paid|charged|completed|tracker_ended|payment_complete|payment\.completed|payment:succeeded|payment\.succeeded/i.test(type);
  const successState = /success|succeeded|paid|completed|ended|captured|complete/i.test(state);
  const failed = /fail|declined|unpaid|rejected/i.test(type) || /fail|declined|rejected/i.test(state);
  const canceled = /cancel|void/i.test(type) || /cancel|void/i.test(state);
  const isRefund = /refund/i.test(type) || /refund/i.test(String(notice.intent || data.intent || ''));
  // payment:created + notification.state=PAID (or amount/fee) + order_id → unlock
  const paymentNoticeWithOrder = Boolean(orderRef && userId)
    && (amount != null || fee != null || net != null || successState)
    && !isRefund
    && (!type || /payment|created|success|complete|paid|tracker/i.test(type));
  const paid = Boolean(successType || successState || paymentNoticeWithOrder);
  return {
    type,
    userId,
    reference: orderRef || reference,
    subscriptionId,
    paid: paid && !failed && !canceled,
    failed,
    canceled,
    meta,
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
