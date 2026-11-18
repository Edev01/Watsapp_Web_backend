require('dotenv').config();
const path = require('path');

function parseUserIds(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

module.exports = {
  backendApiUrl: (process.env.BACKEND_API_URL || 'https://watsapp-web-backend.onrender.com').replace(/\/$/, ''),
  userIds: parseUserIds(process.env.WEB_USER_IDS || '4'),
  sessionsDir: path.resolve(process.env.SESSIONS_DIR || './sessions'),
  /** Sticky proxy only — e.g. http://user:pass@host:port */
  proxyUrl: (process.env.PROXY_URL || '').trim(),
  backfillHours: parseInt(process.env.BACKFILL_HOURS || '6', 10),
  backfillFetchLimit: parseInt(process.env.BACKFILL_FETCH_LIMIT || '500', 10),
  backfillCron: process.env.BACKFILL_CRON || '5 * * * *',
  puppeteerExecutablePath: (process.env.PUPPETEER_EXECUTABLE_PATH || '').trim() || undefined,
  port: parseInt(process.env.PORT || '4200', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  monitoredPollMs: parseInt(process.env.MONITORED_POLL_MS || '30000', 10)
};
