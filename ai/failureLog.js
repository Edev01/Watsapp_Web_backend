const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'normalize_failures.log');

const skippedIds = new Set();

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function loadSkippedIds() {
  try {
    ensureLogDir();
    if (!fs.existsSync(LOG_FILE)) return skippedIds;
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/message_id=(\d+)/);
      if (m) skippedIds.add(Number(m[1]));
    }
  } catch (err) {
    console.warn('[ai] Could not load normalize failure log:', err.message);
  }
  return skippedIds;
}

/**
 * Permanent skip for hard parse failures (not rate limits).
 * Do not log full message bodies in production.
 */
function logNormalizationFailure({ messageId, modelName, reason, rawSnippet }) {
  skippedIds.add(Number(messageId));
  try {
    ensureLogDir();
    const snippet = String(rawSnippet || '')
      .replace(/\s+/g, ' ')
      .slice(0, 180);
    const line = `${new Date().toISOString()} message_id=${messageId} model=${modelName} reason=${String(
      reason || ''
    )
      .replace(/\s+/g, ' ')
      .slice(0, 400)} raw=${snippet}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    console.warn('[ai] Failed writing normalize failure log:', err.message);
  }
}

function getSkippedIds() {
  return skippedIds;
}

module.exports = {
  loadSkippedIds,
  logNormalizationFailure,
  getSkippedIds
};
