const HEARTBEAT_STALE_MS = () => (Number(process.env.SCRAPE_HEARTBEAT_STALE_MIN) || 5) * 60 * 1000;
const STALL_MS = () => (Number(process.env.SCRAPE_STALL_HOURS) || 3) * 60 * 60 * 1000;
const GRACE_MS = {
  worker_down: 5 * 60 * 1000,
  not_linked: 15 * 60 * 1000,
  not_saving: 0
};

function pktHour(now) {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    hour: '2-digit',
    hourCycle: 'h23'
  }).format(now);
  return Number(hour);
}

function formatPkt(value) {
  if (!value) return 'never';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date) + ' PKT';
}

function ageMs(value, now) {
  if (!value) return Infinity;
  const date = value instanceof Date ? value : new Date(value);
  const ms = now.getTime() - date.getTime();
  return Number.isFinite(ms) ? ms : Infinity;
}

/**
 * Why this user's scrape is down, or null when it should stay quiet.
 * Silent stalls (connected, but nothing saved) are ignored overnight PKT
 * so a quiet group does not look like a dead worker.
 */
function classifyScrape(row, now = new Date()) {
  const monitored = Number(row.monitored) || 0;
  if (monitored < 1) return null;

  const heartbeatAge = ageMs(row.lastHeartbeatAt || row.last_heartbeat_at, now);
  const saveAge = ageMs(row.lastMessageAt || row.last_message_at, now);
  const status = String(row.workerStatus || row.worker_status || 'unknown').toLowerCase();
  const scrapeOk = row.scrapeOk === true || row.scrape_ok === true;

  if (!row.lastHeartbeatAt && !row.last_heartbeat_at || heartbeatAge > HEARTBEAT_STALE_MS()) {
    return {
      reason: 'worker_down',
      detail: 'The scrape worker has not checked in.'
    };
  }

  if (!scrapeOk || status === 'offline' || status === 'disconnected' || status === 'auth_failure') {
    return {
      reason: 'not_linked',
      detail: `WhatsApp is not ready (${status}).`
    };
  }

  if (saveAge >= STALL_MS()) {
    const hour = pktHour(now);
    if (hour >= 23 || hour < 8) return null;
    const hours = Math.floor(saveAge / (60 * 60 * 1000));
    return {
      reason: 'not_saving',
      detail: saveAge === Infinity
        ? 'The worker says it is connected, but no message has been saved.'
        : `The worker says it is connected, but nothing has been saved for ${hours} hour${hours === 1 ? '' : 's'}.`
    };
  }

  return null;
}

async function ensureAlertTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS scrape_down_alerts (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      reason VARCHAR(32) NOT NULL,
      detail TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      alerted_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ
    )
  `);
}

function alertRecipient() {
  const { getSmtpConfig } = require('./mailHelper');
  const to = String(getSmtpConfig().to || '').trim().toLowerCase();
  return to || null;
}

function userPhone(row) {
  const raw = String(row.bound_whatsapp_phone || row.phone_number || '').trim();
  if (!raw) return '';
  if (raw.startsWith('+')) return raw;
  if (/^\d+$/.test(raw)) return `+${raw}`;
  return raw;
}

function buildEmail(downRows) {
  const lines = [
    downRows.length === 1
      ? 'Scraping has stopped for this user.'
      : `Scraping has stopped for ${downRows.length} users.`,
    ''
  ];
  for (const row of downRows) {
    const name = row.name || row.email || `user ${row.id}`;
    const phone = userPhone(row);
    lines.push(`Username: ${name}`);
    lines.push(`Email: ${row.email || 'not set'}`);
    lines.push(`Number: ${phone || 'not linked'}`);
    lines.push(`User id: ${row.id}`);
    lines.push(`Details: ${row.problem.detail}`);
    lines.push(`Monitored groups: ${row.monitored}`);
    lines.push(`Worker: ${row.worker_status || 'unknown'}`);
    lines.push(`Last message saved: ${formatPkt(row.last_message_at)}`);
    lines.push('');
  }
  lines.push('This email is sent once per stop. It is sent again only after messages start saving and then stop.');
  const text = lines.join('\n');
  const first = downRows[0];
  const firstPhone = userPhone(first);
  const who = first.name || first.email || `user ${first.id}`;
  const subject = downRows.length === 1
    ? `[PropSync] Scraping stopped — ${who}${firstPhone ? ` (${firstPhone})` : ''}`
    : `[PropSync] Scraping stopped — ${downRows.length} users`;
  return { subject, text };
}

async function watchScrapeHealth(db, now = new Date()) {
  await ensureAlertTable(db);
  const { rows } = await db.query(`
    SELECT u.id,
           u.name,
           u.email,
           u.phone_number,
           u.bound_whatsapp_phone,
           (SELECT count(*)::int FROM whatsapp_chats c
             WHERE c.user_id = u.id AND c.is_monitored IS TRUE) AS monitored,
           (SELECT MAX(m.created_at) FROM whatsapp_messages m WHERE m.user_id = u.id) AS last_message_at,
           h.worker_status,
           h.scrape_ok,
           h.last_heartbeat_at,
           a.reason AS alert_reason,
           a.first_seen_at,
           a.alerted_at,
           (a.user_id IS NOT NULL AND a.resolved_at IS NULL) AS alert_open
      FROM users u
      JOIN whatsapp_scrape_health h ON h.user_id = u.id
      LEFT JOIN scrape_down_alerts a ON a.user_id = u.id
     WHERE LOWER(COALESCE(u.role, '')) <> 'admin'
       AND EXISTS (
         SELECT 1 FROM whatsapp_chats c
          WHERE c.user_id = u.id AND c.is_monitored IS TRUE
       )
  `);

  const toMail = [];
  for (const row of rows) {
    const problem = classifyScrape({
      monitored: row.monitored,
      lastMessageAt: row.last_message_at,
      workerStatus: row.worker_status,
      scrapeOk: row.scrape_ok,
      lastHeartbeatAt: row.last_heartbeat_at
    }, now);

    if (!problem) {
      if (row.alert_open) {
        await db.query(
          `UPDATE scrape_down_alerts SET resolved_at = NOW() WHERE user_id = $1 AND resolved_at IS NULL`,
          [row.id]
        );
      }
      continue;
    }

    const sameOpen = row.alert_open && row.alert_reason === problem.reason;
    let firstSeen = sameOpen && row.first_seen_at ? new Date(row.first_seen_at) : null;
    if (!firstSeen) {
      await db.query(
        `INSERT INTO scrape_down_alerts (user_id, reason, detail, first_seen_at, alerted_at, resolved_at)
         VALUES ($1, $2, $3, $4, NULL, NULL)
         ON CONFLICT (user_id) DO UPDATE SET
           reason = EXCLUDED.reason,
           detail = EXCLUDED.detail,
           first_seen_at = EXCLUDED.first_seen_at,
           alerted_at = NULL,
           resolved_at = NULL`,
        [row.id, problem.reason, problem.detail, now]
      );
      firstSeen = now;
    }

    const alreadySent = sameOpen && row.alerted_at;
    const grace = GRACE_MS[problem.reason] ?? 0;
    if (!alreadySent && now.getTime() - firstSeen.getTime() >= grace) {
      toMail.push({ ...row, problem });
    }
  }

  if (!toMail.length) return { sent: false, users: 0 };

  const { getSmtpConfig, sendMail } = require('./mailHelper');
  const recipient = alertRecipient();
  const { subject, text } = buildEmail(toMail);
  if (!recipient || !getSmtpConfig().configured) {
    console.warn('[scrape-watch] scraping stopped for', toMail.map((r) => r.id).join(','), '— email skipped (SMTP not configured)');
    return { sent: false, users: toMail.length, reason: 'SMTP not configured' };
  }

  const result = await sendMail({
    to: recipient,
    subject,
    text,
    bccAdmin: false
  });
  if (result.sent) {
    await db.query(
      `UPDATE scrape_down_alerts SET alerted_at = NOW() WHERE user_id = ANY($1::int[])`,
      [toMail.map((r) => r.id)]
    );
  }
  console.log('[scrape-watch] emailed', toMail.length, 'stopped user(s) to', recipient);
  return { sent: Boolean(result.sent), users: toMail.length };
}

module.exports = {
  classifyScrape,
  watchScrapeHealth,
  formatPkt,
  pktHour
};
