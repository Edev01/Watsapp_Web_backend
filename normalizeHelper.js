const db = require('./db');

const DEFAULT_MODEL = process.env.NORMALIZE_MODEL || 'openai/gpt-oss-20b';

/**
 * Counts for one portal user's normalization progress.
 */
async function getNormalizeCounts(userId, model = DEFAULT_MODEL) {
  const uid = Number(userId);
  const [totalRes, doneRes, propRes, embRes] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS c
       FROM whatsapp_messages
       WHERE user_id = $1 AND message IS NOT NULL AND TRIM(message) <> ''`,
      [uid]
    ),
    db.query(
      `SELECT COUNT(*)::int AS c
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
       WHERE m.user_id = $1 AND n.model_used = $2`,
      [uid, model]
    ),
    db.query(
      `SELECT COUNT(*)::int AS c
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
       WHERE m.user_id = $1 AND n.model_used = $2 AND n.is_property = true`,
      [uid, model]
    ),
    db.query(
      `SELECT COUNT(*)::int AS c
       FROM message_embeddings e
       JOIN whatsapp_messages m ON m.id = e.whatsapp_message_id
       WHERE m.user_id = $1 AND e.model_used = $2`,
      [uid, model]
    )
  ]);

  const totalMessages = totalRes.rows[0]?.c || 0;
  const normalizedCount = doneRes.rows[0]?.c || 0;
  const pendingCount = Math.max(totalMessages - normalizedCount, 0);
  const propertyCount = propRes.rows[0]?.c || 0;
  const embeddedCount = embRes.rows[0]?.c || 0;
  const percentage =
    totalMessages === 0
      ? 100
      : Math.round((normalizedCount / totalMessages) * 1000) / 10;

  return {
    totalMessages,
    normalizedCount,
    pendingCount,
    propertyCount,
    embeddedCount,
    percentage
  };
}

async function getNormalizeJob(userId) {
  const result = await db.query(
    `SELECT user_id, status, model_used, embed, batch_size,
            processed_this_run, started_at, finished_at, last_error, updated_at
     FROM normalize_jobs
     WHERE user_id = $1`,
    [Number(userId)]
  );
  return result.rows[0] || null;
}

/**
 * Upsert a queued job for this user. Returns the job row.
 * If already running/queued, returns existing without restarting.
 */
async function queueNormalizeJob(userId, opts = {}) {
  const uid = Number(userId);
  const model = opts.model || DEFAULT_MODEL;
  const embed = opts.embed !== false;
  const batchSize = Math.min(Math.max(Number(opts.batchSize) || 50, 1), 200);

  const existing = await getNormalizeJob(uid);
  if (existing && (existing.status === 'running' || existing.status === 'queued')) {
    return { job: existing, alreadyActive: true };
  }

  const result = await db.query(
    `INSERT INTO normalize_jobs (
       user_id, status, model_used, embed, batch_size,
       processed_this_run, started_at, finished_at, last_error, updated_at
     ) VALUES ($1, 'queued', $2, $3, $4, 0, NOW(), NULL, NULL, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       status = 'queued',
       model_used = EXCLUDED.model_used,
       embed = EXCLUDED.embed,
       batch_size = EXCLUDED.batch_size,
       processed_this_run = 0,
       started_at = NOW(),
       finished_at = NULL,
       last_error = NULL,
       updated_at = NOW()
     RETURNING *`,
    [uid, model, embed, batchSize]
  );

  return { job: result.rows[0], alreadyActive: false };
}

async function markNormalizeJobError(userId, message) {
  await db.query(
    `UPDATE normalize_jobs
     SET status = 'failed', last_error = $2, finished_at = NOW(), updated_at = NOW()
     WHERE user_id = $1 AND status IN ('queued', 'running')`,
    [Number(userId), String(message || 'Unknown error').slice(0, 2000)]
  );
}

/**
 * Ask the AI bot to start processing. Non-fatal if unreachable —
 * auto_pipeline / bot can still claim queued jobs from DB.
 */
async function notifyNormalizeBot(userId, job) {
  const baseUrl = (process.env.AI_BOT_URL || '').replace(/\/$/, '');
  if (!baseUrl) {
    return { notified: false, reason: 'AI_BOT_URL not configured' };
  }

  const secret = process.env.NORMALIZE_SERVICE_SECRET || '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${baseUrl}/api/normalize/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { 'X-Normalize-Secret': secret } : {})
      },
      body: JSON.stringify({
        user_id: Number(userId),
        model: job.model_used,
        batch_size: job.batch_size,
        embed: job.embed
      }),
      signal: controller.signal
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        notified: false,
        reason: body.detail || body.error || `AI bot HTTP ${res.status}`
      };
    }
    return { notified: true, bot: body };
  } catch (err) {
    return {
      notified: false,
      reason: err.name === 'AbortError' ? 'AI bot timeout' : (err.message || 'AI bot unreachable')
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildStatusPayload(userId, counts, job, model = DEFAULT_MODEL) {
  const jobStatus = job?.status || 'idle';
  let status = jobStatus;

  if (counts.totalMessages === 0) {
    status = 'nothing_to_normalize';
  } else if (counts.pendingCount === 0 && jobStatus !== 'running' && jobStatus !== 'queued') {
    status = 'completed';
  }

  return {
    userId: Number(userId),
    model: job?.model_used || model,
    status,
    percentage: counts.percentage,
    totalMessages: counts.totalMessages,
    normalizedCount: counts.normalizedCount,
    pendingCount: counts.pendingCount,
    propertyCount: counts.propertyCount,
    embeddedCount: counts.embeddedCount,
    isComplete: counts.pendingCount === 0 && counts.totalMessages > 0,
    job: job
      ? {
          status: job.status,
          model: job.model_used,
          embed: job.embed,
          batchSize: job.batch_size,
          processedThisRun: job.processed_this_run,
          startedAt: job.started_at,
          finishedAt: job.finished_at,
          lastError: job.last_error,
          updatedAt: job.updated_at
        }
      : null
  };
}

module.exports = {
  DEFAULT_MODEL,
  getNormalizeCounts,
  getNormalizeJob,
  queueNormalizeJob,
  markNormalizeJobError,
  notifyNormalizeBot,
  buildStatusPayload
};
