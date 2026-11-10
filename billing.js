/**
 * Monthly Safepay subscription (PKR 7000).
 * - New users: paywall from day one (no free trial).
 * - After a paid month ends: 5-day grace, then lock.
 * - 6-month chat retention window.
 */
const PLAN_AMOUNT_PKR = 7000;
const GRACE_DAYS = 5;
const RETENTION_MONTHS = 6;

function pktParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const day = Number(parts.find((p) => p.type === 'day')?.value);
  return { year, month, day };
}

function pktMonthStart(year, month) {
  return `${year}-${String(month).padStart(2, '0')}-01 00:00:00+05`;
}

function addMonths(year, month, delta) {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function calendarMonthsInclusive(from, to) {
  const a = pktParts(from);
  const b = pktParts(to);
  return (b.year - a.year) * 12 + (b.month - a.month) + 1;
}

function retentionCutoffIso(now = new Date()) {
  const cur = pktParts(now);
  const start = addMonths(cur.year, cur.month, -(RETENTION_MONTHS - 1));
  return pktMonthStart(start.year, start.month);
}

function graceUntilFrom(start, days = GRACE_DAYS) {
  const t = new Date(start).getTime() + days * 24 * 60 * 60 * 1000;
  return new Date(t);
}

function addOneMonth(from) {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/** Grace applies only after a paid month ends — never for brand-new unpaid accounts. */
function inRenewalGrace(sub, now = new Date()) {
  if (!sub) return false;
  const status = String(sub.status || '').toLowerCase();
  const grace = sub.grace_until ? new Date(sub.grace_until) : null;
  if (!grace || Number.isNaN(grace.getTime()) || now.getTime() > grace.getTime()) return false;
  if (status === 'complimentary' || status === 'canceled') return false;
  // Must have been a paying subscriber (or mid-renewal past_due/active after period end).
  if (status === 'past_due' || status === 'active') return true;
  return Boolean(sub.last_paid_at);
}

function hasAccess(sub, now = new Date()) {
  if (!sub) return false;
  const status = String(sub.status || '').toLowerCase();
  if (status === 'complimentary') return true;
  if (status === 'active') {
    const end = sub.current_period_end ? new Date(sub.current_period_end) : null;
    if (end && now.getTime() <= end.getTime()) return true;
  }
  if (inRenewalGrace(sub, now)) return true;
  return false;
}

function daysRemaining(sub, now = new Date()) {
  if (!sub) return 0;
  const status = String(sub.status || '').toLowerCase();
  if (status === 'complimentary') return null;
  if (!hasAccess(sub, now)) return 0;
  const grace = sub.grace_until ? new Date(sub.grace_until) : null;
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
  let end = null;
  if (status === 'active' && periodEnd && now.getTime() <= periodEnd.getTime()) {
    end = periodEnd;
  } else if (inRenewalGrace(sub, now)) {
    end = grace;
  } else {
    end = periodEnd;
  }
  if (!end || Number.isNaN(end.getTime())) return null;
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}

function publicBilling(sub, now = new Date()) {
  const allowed = hasAccess(sub, now);
  const status = sub?.status || 'unpaid';
  return {
    status,
    allowed,
    amountPkr: PLAN_AMOUNT_PKR,
    interval: 'month',
    graceDays: GRACE_DAYS,
    daysLeft: daysRemaining(sub, now),
    currentPeriodStart: sub?.current_period_start || null,
    currentPeriodEnd: sub?.current_period_end || null,
    graceUntil: sub?.grace_until || null,
    lastPaidAt: sub?.last_paid_at || null,
    safepaySubscriptionId: sub?.safepay_subscription_id || null,
    paywall: !allowed
  };
}

async function ensureSubscription(db, user, { existingFree = false } = {}) {
  const userId = Number(user.id || user);
  const { rows } = await db.query('SELECT * FROM subscriptions WHERE user_id = $1', [userId]);
  if (rows[0]) return rows[0];
  const now = new Date();
  const status = existingFree || String(user.role || '').toLowerCase() === 'admin'
    ? 'complimentary'
    : 'unpaid';
  // New billed users: no grace_until — must subscribe on day one.
  const inserted = await db.query(
    `INSERT INTO subscriptions
       (user_id, status, amount_pkr, current_period_start, current_period_end, grace_until)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [userId, status, PLAN_AMOUNT_PKR, null, null, null]
  );
  return inserted.rows[0];
}

async function getSubscription(db, userId) {
  const { rows } = await db.query('SELECT * FROM subscriptions WHERE user_id = $1', [Number(userId)]);
  return rows[0] || null;
}

async function billingForUser(db, user) {
  if (!user) return { allowed: false, paywall: true, status: 'unpaid' };
  if (String(user.role || '').toLowerCase() === 'admin') {
    return {
      status: 'complimentary',
      allowed: true,
      paywall: false,
      amountPkr: 0,
      interval: 'month',
      graceDays: GRACE_DAYS
    };
  }
  const sub = await ensureSubscription(db, user, { existingFree: false });
  return publicBilling(sub);
}

async function markPaid(db, userId, extra = {}) {
  const now = new Date();
  const periodEnd = extra.currentPeriodEnd ? new Date(extra.currentPeriodEnd) : addOneMonth(now);
  const grace = graceUntilFrom(periodEnd);
  const { rows } = await db.query(
    `UPDATE subscriptions SET
        status = 'active',
        last_paid_at = $2,
        current_period_start = $3,
        current_period_end = $4,
        grace_until = $5,
        safepay_subscription_id = COALESCE($6, safepay_subscription_id),
        safepay_customer_id = COALESCE($7, safepay_customer_id),
        lock_emailed_at = NULL,
        updated_at = NOW()
      WHERE user_id = $1
      RETURNING *`,
    [
      Number(userId),
      extra.lastPaidAt || now,
      extra.currentPeriodStart || now,
      periodEnd,
      grace,
      extra.safepaySubscriptionId || null,
      extra.safepayCustomerId || null
    ]
  );
  return rows[0];
}

async function setStatus(db, userId, status, patch = {}) {
  const setGrace = Object.prototype.hasOwnProperty.call(patch, 'graceUntil');
  const setEnd = Object.prototype.hasOwnProperty.call(patch, 'currentPeriodEnd');
  const { rows } = await db.query(
    `UPDATE subscriptions SET
        status = $2,
        grace_until = CASE WHEN $3 THEN $4 ELSE grace_until END,
        current_period_end = CASE WHEN $5 THEN $6 ELSE current_period_end END,
        safepay_subscription_id = CASE WHEN $7 THEN NULL ELSE safepay_subscription_id END,
        updated_at = NOW()
      WHERE user_id = $1
      RETURNING *`,
    [
      Number(userId),
      status,
      setGrace,
      setGrace ? patch.graceUntil : null,
      setEnd,
      setEnd ? patch.currentPeriodEnd : null,
      Boolean(patch.clearSafepay)
    ]
  );
  return rows[0];
}

async function recordPayment(db, {
  userId,
  amountPkr = PLAN_AMOUNT_PKR,
  status = 'succeeded',
  safepayRef = null,
  source = 'safepay',
  payload = null
} = {}) {
  const { rows } = await db.query(
    `INSERT INTO payments
       (user_id, amount_pkr, status, safepay_ref, source, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING *`,
    [Number(userId), amountPkr, status, safepayRef, source, payload ? JSON.stringify(payload) : null]
  );
  return rows[0];
}

function shouldPurgeUser(userCreatedAt, now = new Date()) {
  if (!userCreatedAt) return false;
  return calendarMonthsInclusive(new Date(userCreatedAt), now) >= RETENTION_MONTHS + 1;
}

async function purgeOldChats(db, now = new Date()) {
  const cutoff = retentionCutoffIso(now);
  const users = await db.query(
    `SELECT id, created_at FROM users WHERE LOWER(COALESCE(role, 'user')) <> 'admin'`
  );
  let messages = 0;
  let listings = 0;
  for (const user of users.rows) {
    if (!shouldPurgeUser(user.created_at, now)) continue;
    const nm = await db.query(
      `DELETE FROM normalized_messages n
        USING whatsapp_messages m
       WHERE n.whatsapp_message_id = m.id
         AND m.user_id = $1
         AND m.created_at < $2::timestamptz`,
      [user.id, cutoff]
    );
    listings += nm.rowCount || 0;
    const wm = await db.query(
      `DELETE FROM whatsapp_messages
        WHERE user_id = $1 AND created_at < $2::timestamptz`,
      [user.id, cutoff]
    );
    messages += wm.rowCount || 0;
  }
  if (messages || listings) {
    console.info(`[billing] 6-month purge cutoff=${cutoff} messages=${messages} listings=${listings}`);
  }
  return { cutoff, messages, listings };
}

async function refreshLocks(db, now = new Date()) {
  await db.query(
    `UPDATE subscriptions
        SET status = 'past_due', updated_at = NOW()
      WHERE status = 'active'
        AND current_period_end IS NOT NULL
        AND current_period_end < $1
        AND (grace_until IS NULL OR grace_until >= $1)`,
    [now]
  );
  const locked = await db.query(
    `UPDATE subscriptions
        SET status = CASE WHEN status IN ('active', 'past_due') THEN 'unpaid' ELSE status END,
            lock_emailed_at = NOW(),
            updated_at = NOW()
      WHERE status IN ('active', 'past_due', 'unpaid')
        AND grace_until IS NOT NULL
        AND grace_until < $1
        AND lock_emailed_at IS NULL
      RETURNING user_id`,
    [now]
  );
  return locked.rows.map((row) => row.user_id);
}

module.exports = {
  PLAN_AMOUNT_PKR,
  GRACE_DAYS,
  RETENTION_MONTHS,
  pktParts,
  retentionCutoffIso,
  calendarMonthsInclusive,
  graceUntilFrom,
  addOneMonth,
  hasAccess,
  inRenewalGrace,
  daysRemaining,
  publicBilling,
  ensureSubscription,
  getSubscription,
  billingForUser,
  markPaid,
  setStatus,
  recordPayment,
  shouldPurgeUser,
  purgeOldChats,
  refreshLocks
};
