const db = require('../db');
const { getConfig, getConfigSafe } = require('./config');
const { processUnnormalizedMessages, useExtractV2 } = require('./normalizer');

async function generateAndStoreEmbeddings(opts) {
  try {
    return await require('./embeddings').generateAndStoreEmbeddings(opts);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return { successCount: 0, failCount: 0, skipped: true, error: err.message };
    }
    throw err;
  }
}

let wakeResolve = null;
let wakePromise = null;
/** @type {undefined|null|number} undefined=none, null=any, number=user */
let pendingWakeUser = undefined;
let started = false;
let shuttingDown = false;
let runLock = false;
let llmClient = null;

function ensureLlmClient() {
  if (useExtractV2()) return null;
  if (!llmClient) {
    const { LLMClient } = require('./llmClient');
    llmClient = new LLMClient();
  }
  return llmClient;
}

const stats = {
  running: false,
  lastRun: null,
  lastNormalized: 0,
  lastEmbedded: 0,
  totalNormalized: 0,
  totalEmbedded: 0,
  lastError: null,
  currentUserId: null,
  consecutiveQuotaBatches: 0,
  lastQuotaEmailAt: null
};

const QUOTA_EMAIL_STREAK = Number(process.env.RENORMALIZE_QUOTA_ABORT_STREAK || 3);
const QUOTA_EMAIL_COOLDOWN_MS = 30 * 60 * 1000;

async function maybeEmailQuotaStop({ gemini = 0, together = 0, detail = '' } = {}) {
  const now = Date.now();
  if (stats.lastQuotaEmailAt && now - stats.lastQuotaEmailAt < QUOTA_EMAIL_COOLDOWN_MS) {
    return;
  }
  stats.lastQuotaEmailAt = now;
  try {
    const { sendRenormalizeStopEmail } = require('../mailHelper');
    await sendRenormalizeStopEmail({
      stopReason: 'live_pipeline_quota_pause',
      dryRun: false,
      userId: stats.currentUserId,
      extractProvider: process.env.EXTRACT_PROVIDER || 'together',
      extractFallback: process.env.EXTRACT_FALLBACK_PROVIDER || '',
      total: 0,
      done: stats.totalNormalized,
      errors: stats.consecutiveQuotaBatches,
      property: 0,
      rateLimit: {
        gemini429: gemini,
        together429: together > 0 && !/402|credit/i.test(detail) ? together : 0,
        together402: /402|credit/i.test(detail) ? Math.max(together, 1) : 0,
        geminiOther: 0,
        togetherOther: 0
      },
      rateLimitNote: detail || 'Live pipeline hit API quota/rate limits and paused this drain cycle.',
      sampleErrors: [detail].filter(Boolean),
      finishedAt: new Date().toISOString()
    });
    console.warn('[pipeline] Quota stop email sent');
  } catch (e) {
    console.warn('[pipeline] Quota stop email failed:', e.message);
  }
}

function armWake() {
  if (!wakePromise) {
    wakePromise = new Promise((resolve) => {
      wakeResolve = resolve;
    });
  }
  return wakePromise;
}

function wakePipeline(userId = null) {
  if (userId != null) {
    console.info(`[pipeline] Wake requested by user_id=${userId}`);
  } else {
    console.info('[pipeline] Wake requested');
  }
  pendingWakeUser = userId == null ? null : Number(userId);
  if (wakeResolve) {
    const resolve = wakeResolve;
    wakeResolve = null;
    wakePromise = null;
    resolve(pendingWakeUser);
  }
}

function consumePendingWake() {
  if (pendingWakeUser === undefined) return null;
  const value = pendingWakeUser;
  pendingWakeUser = undefined;
  return value;
}

function getPipelineStats() {
  const cfg = getConfigSafe();
  return {
    ...stats,
    model: cfg.defaultModel || null,
    concurrency: cfg.normalizeConcurrency || null,
    workerStarted: started,
    shuttingDown,
    pipelineMode: cfg.pipelineMode || process.env.AI_PIPELINE || 'local'
  };
}

async function reclaimStaleJobs() {
  const cfg = getConfig();
  const result = await db.query(
    `UPDATE normalize_jobs
     SET status = 'queued',
         last_error = COALESCE(last_error, '') || ' [reclaimed after stale running]',
         updated_at = NOW()
     WHERE status = 'running'
       AND updated_at < NOW() - ($1::text || ' seconds')::interval
     RETURNING user_id`,
    [String(cfg.jobStaleSeconds)]
  );
  if (result.rowCount > 0) {
    console.warn(
      `[pipeline] Reclaimed ${result.rowCount} stale running job(s): ${result.rows
        .map((r) => r.user_id)
        .join(', ')}`
    );
  }
}

async function claimNextJob(preferredUserId = null) {
  await reclaimStaleJobs();

  if (preferredUserId != null) {
    const preferred = await db.query(
      `UPDATE normalize_jobs
       SET status = 'running', updated_at = NOW(), last_error = NULL
       WHERE user_id = $1 AND status = 'queued'
       RETURNING *`,
      [Number(preferredUserId)]
    );
    if (preferred.rows[0]) return preferred.rows[0];
  }

  const result = await db.query(
    `UPDATE normalize_jobs j
     SET status = 'running', updated_at = NOW(), last_error = NULL
     WHERE j.user_id = (
       SELECT user_id FROM normalize_jobs
       WHERE status = 'queued'
       ORDER BY started_at ASC NULLS LAST, updated_at ASC
       LIMIT 1
     )
     RETURNING *`
  );
  return result.rows[0] || null;
}

async function bumpJobProgress(userId, delta) {
  await db.query(
    `UPDATE normalize_jobs
     SET processed_this_run = processed_this_run + $2,
         updated_at = NOW()
     WHERE user_id = $1 AND status = 'running'`,
    [Number(userId), delta]
  );
}

async function completeJob(userId, embedNote = null) {
  const note = embedNote
    ? String(embedNote).slice(0, 1500)
    : null;
  await db.query(
    `UPDATE normalize_jobs
     SET status = 'completed',
         finished_at = NOW(),
         updated_at = NOW(),
         last_error = $2
     WHERE user_id = $1 AND status = 'running'`,
    [Number(userId), note]
  );
}

async function failJob(userId, message) {
  await db.query(
    `UPDATE normalize_jobs
     SET status = 'failed',
         finished_at = NOW(),
         updated_at = NOW(),
         last_error = $2
     WHERE user_id = $1 AND status IN ('queued', 'running')`,
    [Number(userId), String(message || 'Unknown error').slice(0, 2000)]
  );
}

async function processJob(job) {
  const cfg = getConfig();
  const userId = Number(job.user_id);
  const model = job.model_used || cfg.defaultModel;
  const batchSize = Math.min(
    200,
    Math.max(1, Number(job.batch_size) || cfg.defaultBatchSize)
  );
  const embedHost = String(process.env.EMBEDDING_BASE_URL || '');
  const doEmbed =
    job.embed !== false &&
    Boolean(embedHost) &&
    !/localhost|127\.0\.0\.1/.test(embedHost);

  stats.currentUserId = userId;
  console.info(
    `[pipeline] Running job user=${userId} model=${model} batch=${batchSize} embed=${doEmbed}`
  );

  let totalNorm = 0;
  let idleWaves = 0;
  let embedError = null;

  while (!shuttingDown && idleWaves < 2) {
    const result = await processUnnormalizedMessages({
      llmClient: ensureLlmClient(),
      modelName: model,
      batchSize,
      userId,
      concurrency: cfg.normalizeConcurrency
    });

    totalNorm += result.successCount;
    if (result.rateLimited > 0 && result.successCount === 0) {
      stats.consecutiveQuotaBatches += 1;
      if (stats.consecutiveQuotaBatches >= QUOTA_EMAIL_STREAK) {
        await maybeEmailQuotaStop({
          gemini: result.quotaHits?.gemini || 0,
          together: result.quotaHits?.together || 0,
          detail: `Batch all rate/quota limited (gemini=${result.quotaHits?.gemini || 0}, together=${result.quotaHits?.together || 0})`
        });
        console.warn('[pipeline] Pausing job drain after consecutive quota batches');
        break;
      }
    } else if (result.successCount > 0) {
      stats.consecutiveQuotaBatches = 0;
    }

    if (result.successCount > 0) {
      await bumpJobProgress(userId, result.successCount);
      idleWaves = 0;
    } else {
      idleWaves += 1;
    }
  }

  let embedded = 0;
  if (doEmbed && !shuttingDown) {
    try {
      const emb = await generateAndStoreEmbeddings({
        targetLlmModel: model,
        userId,
        limit: Math.max(batchSize * 4, 200)
      });
      embedded = emb.successCount;
      if (emb.error && emb.successCount === 0 && emb.failCount > 0) {
        embedError = `embed incomplete: ${emb.error}`;
      } else if (emb.skipped && emb.error) {
        embedError = `embed skipped: ${emb.error}`;
      }
    } catch (err) {
      embedError = `embed failed: ${err.message}`;
      console.warn(`[pipeline] Embed step failed for user ${userId}:`, err.message);
    }
  }

  if (shuttingDown) {
    // Re-queue so another process can finish after restart
    await db.query(
      `UPDATE normalize_jobs
       SET status = 'queued', updated_at = NOW(),
           last_error = 'Interrupted by shutdown; re-queued'
       WHERE user_id = $1 AND status = 'running'`,
      [userId]
    );
    return { normalized: totalNorm, embedded, interrupted: true };
  }

  const pendingRes = await db.query(
    `SELECT COUNT(*)::int AS c
     FROM whatsapp_messages m
     WHERE m.user_id = $1
       AND m.message IS NOT NULL AND TRIM(m.message) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM normalized_messages n
         WHERE n.whatsapp_message_id = m.id
       )`,
    [userId]
  );
  const pending = pendingRes.rows[0]?.c || 0;
  if (pending > 0) {
    await db.query(
      `UPDATE normalize_jobs
       SET status = 'queued', updated_at = NOW(),
           last_error = $2
       WHERE user_id = $1 AND status = 'running'`,
      [
        userId,
        totalNorm === 0
          ? `No listings written for ${pending} pending message(s); re-queued`
          : `Partial NER run (${totalNorm}); ${pending} still pending`
      ]
    );
    console.warn(`[pipeline] Job user=${userId} re-queued; ${pending} still pending`);
    return { normalized: totalNorm, embedded, interrupted: false, embedError };
  }

  await completeJob(userId, embedError);
  return { normalized: totalNorm, embedded, interrupted: false, embedError };
}

async function drainOnce(preferredUserId = null) {
  const job = await claimNextJob(preferredUserId);
  if (!job) {
    // Opportunistic fair drain for any pending without a job row (legacy / auto)
    const cfg = getConfig();
    const result = await processUnnormalizedMessages({
      llmClient: ensureLlmClient(),
      modelName: cfg.defaultModel,
      batchSize: Math.max(32, cfg.normalizeConcurrency * 2),
      userId: preferredUserId,
      concurrency: cfg.normalizeConcurrency
    });
    let embedded = 0;
    let embedError = null;
    // Skip embeddings when local Ollama/openai deps aren't installed — normalize still runs.
    if (process.env.EMBEDDING_BASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.EMBEDDING_BASE_URL)) {
      try {
        const emb = await generateAndStoreEmbeddings({
          targetLlmModel: cfg.defaultModel,
          userId: preferredUserId,
          limit: 200
        });
        embedded = emb.successCount;
        if (emb.error && !/Cannot find module/.test(String(emb.error))) embedError = emb.error;
      } catch (err) {
        if (!/Cannot find module/.test(String(err.message))) embedError = err.message;
      }
    }
    return {
      normalized: result.successCount,
      embedded,
      hadJob: false,
      embedError
    };
  }

  const out = await processJob(job);
  return {
    normalized: out.normalized,
    embedded: out.embedded,
    hadJob: true,
    embedError: out.embedError || null
  };
}

async function runLoop() {
  const cfg = getConfig();
  ensureLlmClient();
  console.info(
    `[pipeline] Worker started (extract-v2=${useExtractV2()} model=${cfg.defaultModel}, concurrency=${cfg.normalizeConcurrency}, mode=${cfg.pipelineMode})`
  );

  while (!shuttingDown) {
    let preferred = consumePendingWake();
    if (preferred === undefined) {
      const wait = armWake();
      const timeout = new Promise((resolve) =>
        setTimeout(() => resolve('__timeout__'), cfg.pollIntervalMs)
      );
      const raced = await Promise.race([wait, timeout]);
      if (raced === '__timeout__') {
        preferred = consumePendingWake(); // may still be undefined
      } else {
        preferred = raced; // null | number
        pendingWakeUser = undefined;
      }
    }

    if (shuttingDown) break;
    if (runLock) continue;

    runLock = true;
    stats.running = true;
    try {
      let idleWaves = 0;
      // undefined → poll all queued jobs; null/number → hint user
      let wakeUser = preferred === undefined ? null : preferred;

      while (!shuttingDown && idleWaves < 2) {
        const result = await drainOnce(wakeUser);
        wakeUser = null;
        stats.lastRun = new Date().toISOString();
        stats.lastNormalized = result.normalized;
        stats.lastEmbedded = result.embedded;
        stats.totalNormalized += result.normalized;
        stats.totalEmbedded += result.embedded;
        stats.lastError = result.embedError || null;
        stats.currentUserId = null;

        if (result.normalized === 0 && result.embedded === 0 && !result.hadJob) {
          idleWaves += 1;
        } else if (result.normalized === 0 && result.hadJob) {
          idleWaves += 1;
        } else {
          idleWaves = 0;
        }
      }
    } catch (err) {
      stats.lastError = err.message;
      console.error('[pipeline] Drain failed:', err);
      await new Promise((r) => setTimeout(r, 5000));
    } finally {
      stats.running = false;
      runLock = false;
    }
  }

  console.info('[pipeline] Worker loop exited');
}

function installSignalHandlers() {
  const onSignal = (sig) => {
    if (shuttingDown) return;
    console.info(`[pipeline] ${sig} received — graceful shutdown`);
    shuttingDown = true;
    wakePipeline();
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
}

function startPipelineWorker() {
  if (started) return { started: true, already: true };

  const mode = String(process.env.AI_PIPELINE || 'local').toLowerCase();
  if (mode === 'off' || mode === 'disabled') {
    console.warn('[pipeline] AI_PIPELINE is off — worker not started');
    return { started: false, reason: 'disabled' };
  }

  // Validate config (fail fast for local pipeline)
  getConfig();

  started = true;
  installSignalHandlers();
  armWake();
  setImmediate(() => {
    runLoop().catch((err) => {
      console.error('[pipeline] Fatal worker error:', err);
      started = false;
    });
  });
  // Kick an initial drain after boot
  setTimeout(() => wakePipeline(), 1500);
  return { started: true, already: false };
}

module.exports = {
  startPipelineWorker,
  wakePipeline,
  getPipelineStats
};
