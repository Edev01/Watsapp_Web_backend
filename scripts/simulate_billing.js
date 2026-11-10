#!/usr/bin/env node
/**
 * Dev helper to force a user's subscription into a billing state for manual QA.
 *
 * Usage:
 *   node scripts/simulate_billing.js <userId|email> <scenario>
 *
 * Scenarios:
 *   new_user     unpaid, no grace → hard paywall (must subscribe day one)
 *   grace_1d     paid month ended, 1 day of renewal grace left
 *   grace_over   renewal grace expired → hard paywall
 *   month_end    paid month ended yesterday, 5-day renewal grace
 *   paid         active for the next month
 *   complimentary
 *
 * Examples:
 *   node scripts/simulate_billing.js 42 new_user
 *   node scripts/simulate_billing.js agent@example.com month_end
 */
require('dotenv').config();
const db = require('../db');
const billing = require('../billing');

const [target, scenario] = process.argv.slice(2);
const allowed = new Set(['new_user', 'grace_1d', 'grace_over', 'month_end', 'paid', 'complimentary']);

async function resolveUser(raw) {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const { rows } = await db.query('SELECT id, email, role FROM users WHERE id = $1', [Number(raw)]);
    return rows[0] || null;
  }
  const { rows } = await db.query(
    'SELECT id, email, role FROM users WHERE LOWER(email) = LOWER($1)',
    [raw]
  );
  return rows[0] || null;
}

async function apply(userId, name) {
  const now = new Date();
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;

  if (name === 'complimentary') {
    return billing.setStatus(db, userId, 'complimentary', { graceUntil: null });
  }
  if (name === 'paid') {
    return billing.markPaid(db, userId, {});
  }
  if (name === 'new_user') {
    await db.query(
      `UPDATE subscriptions SET
          status = 'unpaid',
          last_paid_at = NULL,
          current_period_start = NULL,
          current_period_end = NULL,
          grace_until = NULL,
          lock_emailed_at = NULL,
          updated_at = NOW()
        WHERE user_id = $1`,
      [userId]
    );
    return billing.getSubscription(db, userId);
  }
  if (name === 'grace_1d') {
    const periodEnd = new Date(now.getTime() - day);
    const grace = new Date(now.getTime() + day);
    await db.query(
      `UPDATE subscriptions SET
          status = 'past_due',
          last_paid_at = COALESCE(last_paid_at, $2),
          current_period_end = $3,
          grace_until = $4,
          lock_emailed_at = NULL,
          updated_at = NOW()
        WHERE user_id = $1`,
      [userId, new Date(now.getTime() - 30 * day), periodEnd, grace]
    );
    return billing.getSubscription(db, userId);
  }
  if (name === 'grace_over') {
    const periodEnd = new Date(now.getTime() - (billing.GRACE_DAYS + 1) * day);
    const grace = new Date(now.getTime() - hour);
    await db.query(
      `UPDATE subscriptions SET
          status = 'unpaid',
          last_paid_at = COALESCE(last_paid_at, $2),
          current_period_end = $3,
          grace_until = $4,
          lock_emailed_at = NULL,
          updated_at = NOW()
        WHERE user_id = $1`,
      [userId, periodEnd, periodEnd, grace]
    );
    return billing.getSubscription(db, userId);
  }
  if (name === 'month_end') {
    const periodEnd = new Date(now.getTime() - day);
    const grace = new Date(now.getTime() + billing.GRACE_DAYS * day);
    await db.query(
      `UPDATE subscriptions SET
          status = 'past_due',
          last_paid_at = COALESCE(last_paid_at, $2),
          current_period_end = $3,
          grace_until = $4,
          lock_emailed_at = NULL,
          updated_at = NOW()
        WHERE user_id = $1`,
      [userId, new Date(now.getTime() - 30 * day), periodEnd, grace]
    );
    return billing.getSubscription(db, userId);
  }
  throw new Error(`Unknown scenario: ${name}`);
}

async function main() {
  if (!target || !scenario || !allowed.has(scenario)) {
    console.error(`Usage: node scripts/simulate_billing.js <userId|email> <${[...allowed].join('|')}>`);
    process.exit(1);
  }
  const user = await resolveUser(target);
  if (!user) {
    console.error(`User not found: ${target}`);
    process.exit(1);
  }
  if (String(user.role || '').toLowerCase() === 'admin') {
    console.error('Admin accounts are not billed');
    process.exit(1);
  }
  await billing.ensureSubscription(db, user);
  const sub = await apply(user.id, scenario);
  const info = billing.publicBilling(sub);
  console.log(JSON.stringify({
    user: { id: user.id, email: user.email },
    scenario,
    billing: info
  }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
