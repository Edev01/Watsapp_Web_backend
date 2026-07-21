const jwt = require('jsonwebtoken');
const { sendResponse } = require('./responseHelper');
require('dotenv').config();

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
    next();
  });
};

const isAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return sendResponse(res, 403, true, null, 'Access denied. Administrator privileges required.');
  }
  next();
};

module.exports = {
  authenticateToken,
  isAdmin
};
