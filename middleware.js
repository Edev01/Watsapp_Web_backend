const jwt = require('jsonwebtoken');
const { sendResponse } = require('./responseHelper');
require('dotenv').config();

const BILLING_OPEN_PATHS = [
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/reset-password',
  '/api/billing/me',
  '/api/billing/checkout',
  '/api/billing/confirm',
  '/api/billing/webhook'
];

function isBillingOpenPath(req) {
  const path = String(req.path || req.originalUrl || '').split('?')[0];
  return BILLING_OPEN_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  // Expecting format: Bearer TOKEN
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return sendResponse(res, 401, true, null, 'Access token is required');
  }

  jwt.verify(token, process.env.JWT_SECRET || 'super_secret_jwt_key_123!', (err, user) => {
    if (err) {
      return sendResponse(res, 403, true, null, 'Token is invalid or expired');
    }
    req.user = user;
    requirePaidAccess(req, res, next);
  });
};

async function requirePaidAccess(req, res, next) {
  try {
    if (!req.user) return next();
    if (String(req.user.role || '').toLowerCase() === 'admin') return next();
    if (isBillingOpenPath(req)) return next();
    const db = require('./db');
    const billing = require('./billing');
    const sub = await billing.ensureSubscription(db, req.user);
    if (billing.hasAccess(sub)) return next();
    return sendResponse(res, 402, true, { billing: billing.publicBilling(sub) }, 'Payment required');
  } catch (err) {
    console.warn('[billing] access check failed:', err.message);
    return next();
  }
}

const isAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return sendResponse(res, 403, true, null, 'Access denied. Administrator privileges required.');
  }
  next();
};

module.exports = {
  authenticateToken,
  isAdmin,
  requirePaidAccess,
  isBillingOpenPath
};
