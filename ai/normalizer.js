const db = require('../db');
const { getConfig } = require('./config');
const { LLMClient, expandListingSchemas } = require('./llmClient');
const { GeminiClient } = require('./geminiClient');
const { fillGapsOnly, scrubWeakLocations } = require('./cascadeMerge');
const { refineWithGeocode } = require('./geocodeClient');
const { schedulePlaceResolve } = require('./placeResolver');
const { splitPropertyOffers, extractSharedContacts, normalizePkMobile } = require('./listingSplitter');
const { extractMessageSchema } = require('./localNer');
const { canonicalizePlaceText } = require('../pakistanLocalities');
const { userListingFingerprint } = require('../contentFingerprint');
const {
  loadSkippedIds,
  logNormalizationFailure,
  getSkippedIds
} = require('./failureLog');

const CASCADE_MODEL = 'cascade';

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

async function listingFingerprintExists(userId, fingerprint) {
  if (!fingerprint) return false;
  const { rows } = await db.query(
    `SELECT 1
     FROM normalized_messages n
     INNER JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE n.content_fingerprint = $1
       AND n.is_property IS TRUE
       AND m.user_id IS NOT DISTINCT FROM $2
     LIMIT 1`,
    [fingerprint, Number(userId)]
  );
  return rows.length > 0;
}

async function loadUserListingFingerprints(userId) {
  if (userId == null) return new Set();
  const { rows } = await db.query(
    `SELECT n.content_fingerprint, n.listing_excerpt, n.summary, n.purpose
     FROM normalized_messages n
     INNER JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE m.user_id = $1
       AND n.is_property IS TRUE
     ORDER BY n.id DESC
     LIMIT 20000`,
    [Number(userId)]
  );
  const set = new Set();
  for (const r of rows) {
    if (r.content_fingerprint) {
      set.add(r.content_fingerprint);
      continue;
    }
    const fp = userListingFingerprint(userId, r);
    if (fp) set.add(fp);
  }
  return set;
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

  const userId = tenantId(job.user_id);
  const existingFingerprints = await loadUserListingFingerprints(userId);

  const toSave = [];
  for (const row of listingRows) {
    const isProp = Boolean(row.is_property_listing_or_inquiry);
    const areaCanon = isProp && row.area ? canonicalizePlaceText(row.area) : null;
    const vicinityCanon = isProp && row.vicinity ? canonicalizePlaceText(row.vicinity) : null;

    let fp = null;
    if (isProp) {
      fp = userListingFingerprint(userId, {
        listing_excerpt: row.listing_excerpt,
        summary: row.summary,
        purpose: row.purpose
      });
      if (fp && (existingFingerprints.has(fp) || (await listingFingerprintExists(userId, fp)))) {
        existingFingerprints.add(fp);
        continue;
      }
      if (fp) existingFingerprints.add(fp);
    }

    toSave.push({
      row,
      isProp,
      areaCanon,
      vicinityCanon,
      fp: isProp ? fp : null
    });
  }

  // Replace prior rows for this message+model so re-runs can split multi-listings
  await db.query(
    `DELETE FROM normalized_messages
     WHERE whatsapp_message_id = $1 AND model_used = $2`,
    [job.id, targetModel]
  );

  // All offers already stored as another message — leave a stub so we don't re-queue forever
  if (!toSave.length) {
    await db.query(
      `INSERT INTO normalized_messages (
         whatsapp_message_id, chat_jid, sender, category, intent, sentiment, language,
         summary, entities, city, is_property, purpose, property_type, property_sub_type,
         area, vicinity, size, size_value, size_unit, price, price_value, contact_number,
         confidence_score, model_used, listing_index, listing_excerpt, content_fingerprint, created_at
       ) VALUES (
         $1,$2,$3,'skipped','duplicate','neutral','en',
         $4,'{}'::jsonb,NULL,FALSE,NULL,NULL,NULL,
         NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
         0,$5,0,NULL,NULL,NOW()
       )`,
      [
        job.id,
        job.chat_jid,
        job.sender,
        '[skipped duplicate listing content]',
        targetModel
      ]
    );
    return 0;
  }

  let saved = 0;
  for (const item of toSave) {
    const { row, isProp, areaCanon, vicinityCanon, fp } = item;
    try {
      const inserted = await db.query(
        `INSERT INTO normalized_messages (
           whatsapp_message_id, chat_jid, sender, category, intent, sentiment, language,
           summary, entities, city, is_property, purpose, property_type, property_sub_type,
           area, vicinity, size, size_value, size_unit, price, price_value, contact_number,
           confidence_score, model_used, listing_index, listing_excerpt, content_fingerprint, created_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,
           $8,$9::jsonb,$10,$11,$12,$13,$14,
           $15,$16,$17,$18,$19,$20,$21,$22,
           $23,$24,$25,$26,$27,NOW()
         )
         RETURNING id, is_property, area, vicinity, city`,
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
          areaCanon,
          vicinityCanon,
          isProp ? row.size : null,
          isProp ? row.size_value : null,
          isProp ? row.size_unit : null,
          isProp ? row.price : null,
          isProp ? row.price_value : null,
          isProp
            ? row.contact_number ||
              normalizePkMobile(job.sender_phone) ||
              job.sender_phone ||
              null
            : null,
          row.confidence_score,
          targetModel,
          Number(row.listing_index) || 0,
          row.listing_excerpt ? String(row.listing_excerpt).slice(0, 2000) : null,
          fp
        ]
      );
      saved += 1;
      if (inserted.rows[0]?.is_property) {
        schedulePlaceResolve(inserted.rows[0]);
      }
    } catch (err) {
      // Unique fingerprint race — another worker saved the same ad
      if (err.code === '23505' && fp) {
        console.info(`[ai] skip duplicate listing fp for msg=${job.id}`);
        continue;
      }
      throw err;
    }
  }
  return saved;
}

async function loadPendingJobs(targetModel, userId, window, { ignoreSkips = true } = {}) {
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
  if (!ignoreSkips && skipped.length) {
    params.push(skipped);
    skipFilter = `AND m.id <> ALL($${params.length}::int[])`;
  }

  params.push(window);
  const limitIdx = params.length;

  const result = await db.query(
    `SELECT m.id, m.user_id, m.chat_jid, m.sender, m.sender_phone, m.message
     FROM whatsapp_messages m
     WHERE m.message IS NOT NULL
       AND TRIM(m.message) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM normalized_messages n
         WHERE n.whatsapp_message_id = m.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM normalize_claims c
         WHERE c.whatsapp_message_id = m.id AND c.model_used = $1
       )
       -- Skip exact body already normalized for this user (repost with new timestamp)
       AND NOT EXISTS (
         SELECT 1
         FROM whatsapp_messages m2
         INNER JOIN normalized_messages n2 ON n2.whatsapp_message_id = m2.id
         WHERE m2.user_id IS NOT DISTINCT FROM m.user_id
           AND m2.id <> m.id
           AND length(COALESCE(m.message, '')) >= 40
           AND md5(regexp_replace(lower(left(m2.message, 800)), E'\\s+', ' ', 'g'))
             = md5(regexp_replace(lower(left(m.message, 800)), E'\\s+', ' ', 'g'))
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
    sender_phone: row.sender_phone || null,
    message: row.message
  }));
}

/**
 * Gemini (primary) → Qwen (fill) → local NER (fill) → Photon/Nominatim (best-match refine).
 * Geocode may only fill gaps or replace a field when it matches the message MORE
 * strongly than the current LLM value — never blindly overwrite Gemini.
 */
async function cascadeNormalizeText(text, sender, llmClient, qwenModel, geminiClient) {
  const stages = [];
  let schema = null;

  // 1) Gemini
  if (geminiClient && geminiClient.isConfigured()) {
    const g = await geminiClient.normalizeMessage(text, sender);
    if (g.isValid && g.schema) {
      schema = scrubWeakLocations(g.schema);
      stages.push(`gemini:${g.modelUsed || 'ok'}`);
    } else if (g.errorReason && g.errorReason !== 'GEMINI_NOT_CONFIGURED') {
      stages.push(`gemini:miss:${String(g.errorReason).slice(0, 40)}`);
    }
  } else {
    stages.push('gemini:skip');
  }

  // 2) Qwen — fill only what Gemini left empty
  const q = await llmClient.normalizeMessage(text, sender, qwenModel);
  if (q.isValid && q.schema) {
    if (!schema) {
      schema = scrubWeakLocations(q.schema);
      stages.push('qwen:primary');
    } else {
      schema = fillGapsOnly(schema, q.schema);
      stages.push('qwen:fill');
    }
  } else if (q.errorReason) {
    stages.push(`qwen:miss:${String(q.errorReason).slice(0, 40)}`);
    if (/RATE_LIMIT/i.test(String(q.errorReason))) {
      return { schema, stages, rateLimited: true };
    }
  }

  // 3) Local NER — fill only remaining gaps
  const local = await extractMessageSchema(text, sender);
  if (local) {
    if (!schema) {
      schema = scrubWeakLocations(local);
      stages.push('ner:primary');
    } else {
      schema = fillGapsOnly(schema, local);
      stages.push('ner:fill');
    }
  } else {
    stages.push('ner:miss');
  }

  // 4) Free geocode (Photon + Nominatim) — best relevance wins per field
  if (schema) {
    try {
      const geo = await refineWithGeocode(schema, text);
      schema = scrubWeakLocations(geo.schema || schema);
      stages.push(...(geo.stages || []));
    } catch (err) {
      stages.push(`geocode:err:${String(err.message || err).slice(0, 40)}`);
    }
  }

  return { schema, stages, rateLimited: false };
}

async function normalizeOne(job, llmClient, targetModel, geminiClient) {
  try {
    const senderFallback =
      normalizePkMobile(job.sender_phone) ||
      (job.sender_phone ? String(job.sender_phone).trim() : null) ||
      null;
    const sharedContact = extractSharedContacts(job.message) || senderFallback;
    const gemini = geminiClient || new GeminiClient();
    const chunks = splitPropertyOffers(job.message);
    const useChunks = chunks.length >= 2;

    let listingSchemas = [];

    if (useChunks) {
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const { schema, stages, rateLimited } = await cascadeNormalizeText(
          chunk,
          job.sender,
          llmClient,
          targetModel,
          gemini
        );
        if (rateLimited) {
          return { id: job.id, ok: false, rateLimited: true };
        }
        if (!schema) {
          console.warn(
            `[ai] Chunk ${i + 1}/${chunks.length} cascade miss for message ${job.id}: ${stages.join(' → ')}`
          );
          continue;
        }
        const rows = expandListingSchemas(schema);
        for (const row of rows) {
          row.listing_excerpt = chunk.slice(0, 2000);
          row.listing_index = listingSchemas.length;
          if (!row.contact_number && sharedContact) row.contact_number = sharedContact;
          if (row.is_property_listing_or_inquiry == null) {
            row.is_property_listing_or_inquiry = true;
          }
          listingSchemas.push(row);
        }
        console.info(
          `[ai] Message ${job.id} chunk ${i + 1}/${chunks.length}: ${stages.join(' → ')}`
        );
      }
      if (!listingSchemas.length) {
        return { id: job.id, ok: false };
      }
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
      const saved = await saveNormalized(job, envelope, CASCADE_MODEL);
      console.info(
        `[ai] Message ${job.id} (user ${tenantId(job.user_id)}) cascade-split → ${saved} listing(s)`
      );
      return { id: job.id, ok: true, listings: saved };
    }

    const { schema, stages, rateLimited } = await cascadeNormalizeText(
      job.message,
      job.sender,
      llmClient,
      targetModel,
      gemini
    );

    if (rateLimited) {
      console.warn(`[ai] Rate-limited on message ${job.id}; will retry later.`);
      return { id: job.id, ok: false, rateLimited: true };
    }

    if (schema) {
      if (sharedContact && Array.isArray(schema.listings)) {
        for (const L of schema.listings) {
          if (L && !L.contact_number) L.contact_number = sharedContact;
        }
      }
      if (sharedContact && !schema.contact_number) {
        schema.contact_number = sharedContact;
      }
      const saved = await saveNormalized(job, schema, CASCADE_MODEL);
      console.info(
        `[ai] Message ${job.id} (user ${tenantId(job.user_id)}) cascade [${stages.join(' → ')}] → ${saved} listing(s)`
      );
      return { id: job.id, ok: true, listings: saved };
    }

    const reason = `cascade miss: ${stages.join(' → ')}`;
    logNormalizationFailure({
      messageId: job.id,
      modelName: CASCADE_MODEL,
      reason
    });
    console.warn(`[ai] Failed to normalize message ${job.id}: ${reason}`);
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
  const gemini = new GeminiClient();
  const targetModel = modelName || client.defaultModel || cfg.defaultModel;
  const workers = concurrency || cfg.normalizeConcurrency;
  const perUser = cfg.normalizePerUser;

  loadSkippedIds();
  await releaseStaleClaims(targetModel);

  const window = Math.max(batchSize * 4, 80);
  const candidates = await loadPendingJobs(targetModel, userId, window, { ignoreSkips: true });
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
    `[ai] Processing ${claimed.length} messages cascade ` +
      `(gemini=${gemini.isConfigured() ? 'on' : 'off'} → qwen → ner → geocode, ` +
      `workers=${workers}, tenants=${JSON.stringify(tenantCounts)})`
  );

  const started = Date.now();
  const outcomes = await mapPool(claimed, workers, (job) =>
    normalizeOne(job, client, targetModel, gemini)
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
  saveNormalized,
  fairPick,
  releaseStaleClaims,
  tenantId,
  CASCADE_MODEL,
  cascadeNormalizeText
};
