const jwt = require('jsonwebtoken');
require('dotenv').config();

/**
 * Middleware to extract target user_id for multi-tenant data isolation.
 * Order of preference:
 * 1. Verified JWT Bearer token payload (req.user.id)
 * 2. Custom header (x-user-id)
 * 3. Request body (req.body.userId or req.body.user_id)
 * 4. Request query parameter (req.query.userId or req.query.user_id)
 * 5. Default fallback ID (1)
 */
const extractUserId = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  const customHeader = req.headers['x-user-id'];
  const bodyId = req.body?.userId || req.body?.user_id;
  const queryId = req.query?.userId || req.query?.user_id;

  if (token) {
    jwt.verify(token, process.env.JWT_SECRET || 'super_secret_jwt_key_123!', (err, user) => {
      if (!err && user && user.id) {
        req.userId = parseInt(user.id, 10);
      } else if (customHeader) {
        req.userId = parseInt(customHeader, 10);
      } else if (bodyId) {
        req.userId = parseInt(bodyId, 10);
      } else if (queryId) {
        req.userId = parseInt(queryId, 10);
      } else {
        req.userId = 1;
      }
      next();
    });
  } else {
    const fallbackId = customHeader || bodyId || queryId;
    if (fallbackId && !isNaN(parseInt(fallbackId, 10))) {
      req.userId = parseInt(fallbackId, 10);
    } else {
      req.userId = 1;
    }
    next();
  }
};

module.exports = {
  extractUserId
};
