const db = require('../db');
const { getConfig } = require('./config');
const { LLMClient, expandListingSchemas } = require('./llmClient');
const { splitPropertyOffers, extractSharedContacts } = require('./listingSplitter');
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
  const listingRows = expandListingSchemas(schema);
  if (!listingRows.length) return 0;

  const entities = schema.entities || {
    products: [],
    dates_mentioned: [],
    action_items: [],
    names: []
  };

  // Replace prior rows for this message+model so re-runs can split multi-listings
  await db.query(
    `DELETE FROM normalized_messages
     WHERE whatsapp_message_id = $1 AND model_used = $2`,
    [job.id, targetModel]
  );

  let saved = 0;
  for (const row of listingRows) {
    const isProp = Boolean(row.is_property_listing_or_inquiry);
    await db.query(
      `INSERT INTO normalized_messages (
         whatsapp_message_id, chat_jid, sender, category, intent, sentiment, language,
         summary, entities, city, is_property, purpose, property_type, property_sub_type,
         area, vicinity, size, size_value, size_unit, price, price_value, contact_number,
         confidence_score, model_used, listing_index, listing_excerpt, created_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,
         $8,$9::jsonb,$10,$11,$12,$13,$14,
         $15,$16,$17,$18,$19,$20,$21,$22,
         $23,$24,$25,$26,NOW()
       )`,
      [
        job.id,
        job.chat_jid,
        job.sender,
        row.category,
        row.intent,
        row.sentiment,
        row.language,
        row.summary,
        JSON.stringify(entities),
        isProp ? row.city : null,
        isProp,
        isProp ? row.purpose : null,
        isProp ? row.property_type : null,
        isProp ? row.property_sub_type : null,
        isProp ? row.area : null,
        isProp ? row.vicinity : null,
        isProp ? row.size : null,
        isProp ? row.size_value : null,
        isProp ? row.size_unit : null,
        isProp ? row.price : null,
        isProp ? row.price_value : null,
        isProp ? row.contact_number : null,
        row.confidence_score,
        targetModel,
        Number(row.listing_index) || 0,
        row.listing_excerpt ? String(row.listing_excerpt).slice(0, 2000) : null
      ]
    );
    saved += 1;
  }
  return saved;
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
    const sharedContact = extractSharedContacts(job.message);
    const chunks = splitPropertyOffers(job.message);
    const useChunks = chunks.length >= 2;

    let listingSchemas = [];

    if (useChunks) {
      // Normalize each offer slice separately (reliable for agent multi-dumps)
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const result = await llmClient.normalizeMessage(chunk, job.sender, targetModel);
        if (!result.isValid || !result.schema) {
          console.warn(
            `[ai] Chunk ${i + 1}/${chunks.length} failed for message ${job.id}: ${(result.errorReason || '').slice(0, 120)}`
          );
          continue;
        }
        const rows = expandListingSchemas(result.schema);
        for (const row of rows) {
          row.listing_excerpt = chunk.slice(0, 2000);
          row.listing_index = listingSchemas.length;
          if (!row.contact_number && sharedContact) row.contact_number = sharedContact;
          // Prefer SALE/RENT from chunk; keep is_property true if chunk looks like a listing
          if (row.is_property_listing_or_inquiry == null) {
            row.is_property_listing_or_inquiry = true;
          }
          listingSchemas.push(row);
        }
      }
      if (!listingSchemas.length) {
        return { id: job.id, ok: false };
      }
      // Wrap as synthetic schema for saveNormalized
      const envelope = {
        ...listingSchemas[0],
        is_property_listing_or_inquiry: true,
        listings: listingSchemas.map((r) => ({
          purpose: r.purpose,
          property_type: r.property_type,
          property_sub_type: r.property_sub_type,
          city: r.city,
          area: r.area,
          vicinity: r.vicinity,
          size: r.size,
          size_value: r.size_value,
          size_unit: r.size_unit,
          price: r.price,
          price_value: r.price_value,
          contact_number: r.contact_number || sharedContact,
          summary: r.summary,
          listing_excerpt: r.listing_excerpt
        }))
      };
      const saved = await saveNormalized(job, envelope, targetModel);
      console.info(
        `[ai] Message ${job.id} (user ${tenantId(job.user_id)}) split → ${saved} listing(s) from ${chunks.length} chunks`
      );
      return { id: job.id, ok: true, listings: saved };
    }

    const result = await llmClient.normalizeMessage(
      job.message,
      job.sender,
      targetModel
    );

    if (result.isValid && result.schema) {
      if (sharedContact && Array.isArray(result.schema.listings)) {
        for (const L of result.schema.listings) {
          if (L && !L.contact_number) L.contact_number = sharedContact;
        }
      }
      if (sharedContact && !result.schema.contact_number) {
        result.schema.contact_number = sharedContact;
      }
      const saved = await saveNormalized(job, result.schema, targetModel);
      console.info(
        `[ai] Message ${job.id} (user ${tenantId(job.user_id)}) → ${saved} listing(s) in ${result.latency.toFixed(2)}s`
      );
      return { id: job.id, ok: true, listings: saved };
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
