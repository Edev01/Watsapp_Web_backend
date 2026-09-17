const db = require('../db');
const { getConfig } = require('./config');
const { LLMClient } = require('./llmClient');
const {
  loadSkippedIds,
  logNormalizationFailure,
  getSkippedIds
} = require('./failureLog');

function tenantId(userId) {
  return userId == null ? 1 : Number(userId);
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

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () =>
    run()
  );
  await Promise.all(runners);
  return results;
}

function fairPick(jobs, batchSize, perUser) {
  if (!jobs.length) return [];
  const byUser = new Map();
  for (const job of jobs) {
    const uid = tenantId(job.user_id);
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(job);
  }

  const userIds = [...byUser.keys()];
  if (userIds.length === 1) return jobs.slice(0, batchSize);

  const picked = [];
  const indexes = Object.fromEntries(userIds.map((uid) => [uid, 0]));

  for (const uid of userIds) {
    const take = Math.min(perUser, byUser.get(uid).length, batchSize - picked.length);
    picked.push(...byUser.get(uid).slice(0, take));
    indexes[uid] = take;
    if (picked.length >= batchSize) return picked.slice(0, batchSize);
  }

  while (picked.length < batchSize) {
    let progressed = false;
    for (const uid of userIds) {
      const list = byUser.get(uid);
      const idx = indexes[uid];
      if (idx < list.length) {
        picked.push(list[idx]);
        indexes[uid] = idx + 1;
        progressed = true;
        if (picked.length >= batchSize) break;
      }
    }
    if (!progressed) break;
  }
  return picked.slice(0, batchSize);
}

async function releaseStaleClaims(modelName) {
  const cfg = getConfig();
  const result = await db.query(
    `DELETE FROM normalize_claims
     WHERE model_used = $1
       AND claimed_at < NOW() - ($2::text || ' seconds')::interval`,
    [modelName, String(cfg.claimStaleSeconds)]
  );
  if (result.rowCount > 0) {
    console.info(`[ai] Released ${result.rowCount} stale normalize claims.`);
  }
}

async function claimJobs(jobs, modelName) {
  const claimed = [];
  for (const job of jobs) {
    try {
      await db.query(
        `INSERT INTO normalize_claims (whatsapp_message_id, model_used, user_id, claimed_at)
         VALUES ($1, $2, $3, NOW())`,
        [job.id, modelName, tenantId(job.user_id)]
      );
      claimed.push(job);
    } catch (err) {
      // unique violation = already claimed
      if (err.code !== '23505') {
        console.warn(`[ai] claim failed for ${job.id}:`, err.message);
      }
    }
  }
  return claimed;
}

async function releaseClaim(messageId, modelName) {
  try {
    await db.query(
      `DELETE FROM normalize_claims
       WHERE whatsapp_message_id = $1 AND model_used = $2`,
      [messageId, modelName]
    );
  } catch {
    /* ignore */
  }
}

async function saveNormalized(job, schema, targetModel) {
  const isProp = Boolean(schema.is_property_listing_or_inquiry);
  const entities = schema.entities || {
    products: [],
    dates_mentioned: [],
    action_items: [],
    names: []
  };

  await db.query(
    `INSERT INTO normalized_messages (
       whatsapp_message_id, chat_jid, sender, category, intent, sentiment, language,
       summary, entities, city, is_property, purpose, property_type, property_sub_type,
       area, vicinity, size, size_value, size_unit, price, price_value, contact_number,
       confidence_score, model_used, created_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,
       $8,$9::jsonb,$10,$11,$12,$13,$14,
       $15,$16,$17,$18,$19,$20,$21,$22,
       $23,$24,NOW()
     )`,
    [
      job.id,
      job.chat_jid,
      job.sender,
      schema.category,
      schema.intent,
      schema.sentiment,
      schema.language,
      schema.summary,
      JSON.stringify(entities),
      isProp ? schema.city : null,
      isProp,
      isProp ? schema.purpose : null,
      isProp ? schema.property_type : null,
      isProp ? schema.property_sub_type : null,
      isProp ? schema.area : null,
      isProp ? schema.vicinity : null,
      isProp ? schema.size : null,
      isProp ? schema.size_value : null,
      isProp ? schema.size_unit : null,
      isProp ? schema.price : null,
      isProp ? schema.price_value : null,
      isProp ? schema.contact_number : null,
      schema.confidence_score,
      targetModel
    ]
  );
}

async function loadPendingJobs(targetModel, userId, window) {
  const skipped = [...getSkippedIds()];
  const params = [targetModel];
  let userFilter = '';

  if (userId != null) {
    const uid = Number(userId);
    if (uid === 1) {
      params.push(1);
      userFilter = `AND (m.user_id = $${params.length} OR m.user_id IS NULL)`;
    } else {
      params.push(uid);
      userFilter = `AND m.user_id = $${params.length}`;
    }
  }

  let skipFilter = '';
  if (skipped.length) {
    params.push(skipped);
    skipFilter = `AND m.id <> ALL($${params.length}::int[])`;
  }

  params.push(window);
  const limitIdx = params.length;

  const result = await db.query(
    `SELECT m.id, m.user_id, m.chat_jid, m.sender, m.message
     FROM whatsapp_messages m
     WHERE m.message IS NOT NULL
       AND TRIM(m.message) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM normalized_messages n
         WHERE n.whatsapp_message_id = m.id AND n.model_used = $1
       )
       AND NOT EXISTS (
         SELECT 1 FROM normalize_claims c
         WHERE c.whatsapp_message_id = m.id AND c.model_used = $1
       )
       ${userFilter}
       ${skipFilter}
     ORDER BY m.id ASC
     LIMIT $${limitIdx}`,
    params
  );

  return result.rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    chat_jid: row.chat_jid,
    sender: row.sender,
    message: row.message
  }));
}

async function normalizeOne(job, llmClient, targetModel) {
  try {
    const result = await llmClient.normalizeMessage(
      job.message,
      job.sender,
      targetModel
    );

    if (result.isValid && result.schema) {
      await saveNormalized(job, result.schema, targetModel);
      console.info(
        `[ai] Message ${job.id} (user ${tenantId(job.user_id)}) normalized in ${result.latency.toFixed(2)}s`
      );
      return { id: job.id, ok: true };
    }

    const reason = result.errorReason || 'Unknown parse/validation failure';
    if (
      reason.startsWith('RATE_LIMIT') ||
      /rate.?limit/i.test(reason)
    ) {
      console.warn(`[ai] Rate-limited on message ${job.id}; will retry later.`);
      return { id: job.id, ok: false, rateLimited: true };
    }

    const transient =
      /JSONDecodeError|Unexpected end of JSON|RATE_LIMIT|timeout|ECONNRESET/i.test(reason);
    if (!transient) {
      logNormalizationFailure({
        messageId: job.id,
        modelName: targetModel,
        reason,
        rawSnippet: result.rawOutput
      });
    }
    console.warn(`[ai] Failed to normalize message ${job.id}: ${reason.slice(0, 200)}`);
    return { id: job.id, ok: false };
  } catch (err) {
    const reason = `${err.name || 'Error'}: ${err.message}`;
    if (/rate.?limit/i.test(reason)) {
      return { id: job.id, ok: false, rateLimited: true };
    }
    logNormalizationFailure({
      messageId: job.id,
      modelName: targetModel,
      reason
    });
    console.error(`[ai] Error processing message ${job.id}: ${reason}`);
    return { id: job.id, ok: false };
  } finally {
    await releaseClaim(job.id, targetModel);
  }
}

/**
 * Normalize a batch of pending WhatsApp messages.
 * @returns {{ successCount: number, failCount: number, claimed: number }}
 */
async function processUnnormalizedMessages({
  llmClient,
  modelName = null,
  batchSize = 50,
  userId = null,
  concurrency = null
} = {}) {
  const cfg = getConfig();
  const client = llmClient || new LLMClient();
  const targetModel = modelName || client.defaultModel || cfg.defaultModel;
  const workers = concurrency || cfg.normalizeConcurrency;
  const perUser = cfg.normalizePerUser;

  loadSkippedIds();
  await releaseStaleClaims(targetModel);

  const window = Math.max(batchSize * 4, 80);
  const candidates = await loadPendingJobs(targetModel, userId, window);
  const selected = fairPick(candidates, batchSize, perUser);
  const claimed = await claimJobs(selected, targetModel);

  if (!claimed.length) {
    return { successCount: 0, failCount: 0, claimed: 0 };
  }

  const tenantCounts = {};
  for (const job of claimed) {
    const uid = tenantId(job.user_id);
    tenantCounts[uid] = (tenantCounts[uid] || 0) + 1;
  }

  console.info(
    `[ai] Processing ${claimed.length} messages with ${workers} parallel calls ` +
      `(model '${targetModel}', tenants=${JSON.stringify(tenantCounts)})`
  );

  const started = Date.now();
  const outcomes = await mapPool(claimed, workers, (job) =>
    normalizeOne(job, client, targetModel)
  );

  let successCount = 0;
  let failCount = 0;
  for (const o of outcomes) {
    if (o?.ok) successCount += 1;
    else failCount += 1;
  }

  const elapsed = (Date.now() - started) / 1000;
  console.info(
    `[ai] Batch complete: ${successCount}/${claimed.length} normalized, ${failCount} failed in ${elapsed.toFixed(1)}s`
  );

  return { successCount, failCount, claimed: claimed.length };
}

module.exports = {
  processUnnormalizedMessages,
  fairPick,
  releaseStaleClaims,
  tenantId
};
