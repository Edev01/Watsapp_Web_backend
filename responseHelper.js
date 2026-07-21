/**
 * Generic response helper to format all API responses uniformly.
 * @param {Object} res - Express response object
 * @param {number} status - HTTP status code
 * @param {boolean|string|null} error - Error state or message (true/false, or description)
 * @param {Object|Array|null} data - Response payload
 * @param {string} message - User-friendly message
 */
const sendResponse = (res, status, error, data, message) => {
  return res.status(status).json({
    error: error,
    data: data,
    status: status,
    message: message
  });
};

module.exports = {
  sendResponse
};
