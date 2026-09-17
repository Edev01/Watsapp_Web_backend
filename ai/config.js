/**
 * Validated AI / pipeline configuration.
 * Fail fast when local pipeline is enabled without required LLM env.
 */
require('dotenv').config();

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig({ requireLlm = true } = {}) {
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) {
    throw new Error('[ai] DATABASE_URL is required');
  }

  const pipelineMode = String(process.env.AI_PIPELINE || 'local').toLowerCase();
  const llmBaseUrl = (process.env.LLM_BASE_URL || '').replace(/\/$/, '');
  const llmApiKey = process.env.LLM_API_KEY || '';
  const defaultModel =
    process.env.NORMALIZE_MODEL ||
    process.env.DEFAULT_MODEL ||
    'Qwen/Qwen3.5-9B';

  if (requireLlm && pipelineMode === 'local') {
    if (!llmBaseUrl) {
      throw new Error('[ai] LLM_BASE_URL is required when AI_PIPELINE=local');
    }
    if (!llmApiKey) {
      throw new Error('[ai] LLM_API_KEY is required when AI_PIPELINE=local');
    }
  }

  const embeddingBaseUrl = (
    process.env.EMBEDDING_BASE_URL ||
    'http://localhost:11434/v1'
  ).replace(/\/$/, '');
  const embeddingApiKey = process.env.EMBEDDING_API_KEY || 'ollama';
  const embeddingModel = process.env.EMBEDDING_MODEL || 'nomic-embed-text';

  if (pipelineMode === 'local' && !process.env.EMBEDDING_BASE_URL) {
    console.warn(
      '[ai] EMBEDDING_BASE_URL not set — defaulting to http://localhost:11434/v1 (Ollama). Normalize will still run if embed fails.'
    );
  }

  return {
    pipelineMode,
    databaseUrl,
    llmBaseUrl,
    llmApiKey,
    defaultModel,
    embeddingBaseUrl,
    embeddingApiKey,
    embeddingModel,
    normalizeConcurrency: Math.max(1, intEnv('NORMALIZE_CONCURRENCY', 8)),
    normalizePerUser: Math.max(1, intEnv('NORMALIZE_PER_USER', 4)),
    embedConcurrency: Math.max(1, intEnv('EMBED_CONCURRENCY', 3)),
    llmMaxRetries: Math.max(1, intEnv('LLM_MAX_RETRIES', 6)),
    claimStaleSeconds: Math.max(60, intEnv('CLAIM_STALE_SECONDS', 900)),
    jobStaleSeconds: Math.max(60, intEnv('JOB_STALE_SECONDS', 1800)),
    pollIntervalMs: Math.max(5000, intEnv('PIPELINE_POLL_MS', 15000)),
    defaultBatchSize: Math.min(200, Math.max(1, intEnv('NORMALIZE_BATCH_SIZE', 50)))
  };
}

let cached = null;

function getConfig() {
  if (!cached) {
    cached = loadConfig({ requireLlm: true });
  }
  return cached;
}

/** Soft load for health endpoints when keys might be missing during boot diagnostics. */
function getConfigSafe() {
  try {
    return loadConfig({ requireLlm: false });
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = {
  loadConfig,
  getConfig,
  getConfigSafe
};
