const db = require('../db');
const { getConfig } = require('./config');
const { generateEmbedding } = require('./llmClient');

function buildRichEmbeddingText(rec) {
  const parts = [];
  if (rec.property_type) parts.push(rec.property_type);
  if (rec.purpose) parts.push(`for ${rec.purpose}`);
  if (rec.area) parts.push(rec.area);
  if (rec.vicinity) parts.push(rec.vicinity);
  if (rec.city) parts.push(rec.city);
  if (rec.size) parts.push(rec.size);
  if (rec.price) parts.push(`Price: ${rec.price}`);
  if (rec.summary) parts.push(rec.summary);
  return parts.length ? parts.join(' | ') : rec.summary || '';
}

function toPgVector(vector) {
  return `[${vector.join(',')}]`;
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length || 1) }, () =>
    run()
  );
  await Promise.all(runners);
  return results;
}

/**
 * Generate embeddings for property-normalized rows missing vectors.
 * Failures are logged; caller should not leave jobs stuck forever.
 *
 * @returns {{ successCount: number, failCount: number, skipped: boolean, error?: string }}
 */
async function generateAndStoreEmbeddings({
  targetLlmModel,
  embeddingModel = null,
  userId = null,
  limit = 500
} = {}) {
  const cfg = getConfig();
  const model = targetLlmModel || cfg.defaultModel;
  const embedModel = embeddingModel || cfg.embeddingModel;
  const workers = cfg.embedConcurrency;

  const params = [model];
  let userFilter = '';
  if (userId != null) {
    params.push(Number(userId));
    userFilter = `AND m.user_id = $${params.length}`;
  }
  params.push(limit);
  const limitIdx = params.length;

  let pending;
  try {
    const result = await db.query(
      `SELECT n.whatsapp_message_id, n.property_type, n.purpose, n.area, n.vicinity,
              n.city, n.size, n.price, n.summary
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
       WHERE n.model_used = $1
         AND n.is_property = true
         AND NOT EXISTS (
           SELECT 1 FROM message_embeddings e
           WHERE e.whatsapp_message_id = n.whatsapp_message_id
             AND e.model_used = $1
         )
         ${userFilter}
       ORDER BY n.id ASC
       LIMIT $${limitIdx}`,
      params
    );
    pending = result.rows;
  } catch (err) {
    console.error('[ai] Failed loading pending embeddings:', err.message);
    return {
      successCount: 0,
      failCount: 0,
      skipped: true,
      error: err.message
    };
  }

  if (!pending.length) {
    return { successCount: 0, failCount: 0, skipped: false };
  }

  const jobs = [];
  for (const rec of pending) {
    const richText = buildRichEmbeddingText(rec);
    if (richText) {
      jobs.push({
        messageId: rec.whatsapp_message_id,
        richText
      });
    }
  }

  console.info(
    `[ai] Generating embeddings for ${jobs.length} messages using '${embedModel}' (${workers} parallel)`
  );

  let successCount = 0;
  let failCount = 0;
  let firstError = null;

  const outcomes = await mapPool(jobs, workers, async (job) => {
    try {
      const vector = await generateEmbedding(job.richText, embedModel);
      await db.query(
        `INSERT INTO message_embeddings (
           whatsapp_message_id, model_used, content_chunk, embedding, created_at
         ) VALUES ($1, $2, $3, $4::vector, NOW())`,
        [job.messageId, model, job.richText, toPgVector(vector)]
      );
      return { ok: true };
    } catch (err) {
      console.warn(
        `[ai] Skipping embedding for message ${job.messageId}: ${String(err.message || err).slice(0, 160)}`
      );
      return { ok: false, error: err.message };
    }
  });

  for (const o of outcomes) {
    if (o?.ok) successCount += 1;
    else {
      failCount += 1;
      if (!firstError && o?.error) firstError = o.error;
    }
  }

  console.info(`[ai] Saved ${successCount} embeddings (${failCount} failed).`);
  return {
    successCount,
    failCount,
    skipped: false,
    error: firstError || undefined
  };
}

module.exports = {
  buildRichEmbeddingText,
  generateAndStoreEmbeddings,
  toPgVector
};
