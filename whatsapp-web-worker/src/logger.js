const pino = require('pino');
const config = require('./config');

module.exports = pino({
  level: config.logLevel,
  base: { service: 'whatsapp-web-worker' },
  timestamp: pino.stdTimeFunctions.isoTime
});
