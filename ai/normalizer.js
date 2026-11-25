const db = require('../db');
const { getConfig } = require('./config');
const {
  loadSkippedIds,
  logNormalizationFailure,
  getSkippedIds
} = require('./failureLog');

const EXTRACT_V2_MODEL = 'extract-v2';

// Messages before 25 Nov 2026 00:00 PKT are never sent to OpenAI.
const NORMALIZE_NOT_BEFORE = process.env.NORMALIZE_NOT_BEFORE || '2026-11-25T00:00:00+05:00';

// Messages already placed in a completed OpenAI batch. They stay unnormalized if the
// model omitted them, and they do not trigger another call until the process restarts.
const alreadySentIds = new Set();

/** Normalization is always scraped message → one LLM call → saved fields. */
function useExtractV2() {
  return true;
}

function tenantId(userId) {
  return userId == null ? 1 : Number(userId);
}

async function alreadyNormalizedSameBody(job) {
  // Skip OpenAI only for true duplicates: same body + same footer.
  // Same body + different footer must normalize (new agent/contact).
  const {
    userMessageFingerprint,
    userMessageBodyFingerprint
  } = require('../contentFingerprint');
  const uid = tenantId(job.user_id);
  const fullFp = userMessageFingerprint(uid, job.message);
  const bodyFp = userMessageBodyFingerprint(uid, job.message);
  if (!fullFp) return false;

  const { rows } = await db.query(
    `SELECT m.message, m.content_fingerprint
       FROM whatsapp_messages m
       JOIN normalized_messages n ON n.whatsapp_message_id = m.id
      WHERE m.user_id IS NOT DISTINCT FROM $1
        AND m.id <> $2
        AND (
          m.content_fingerprint = $3
          OR ($4::text IS NOT NULL AND m.content_fingerprint = $4)
        )
      LIMIT 30`,
    [job.user_id, job.id, fullFp, bodyFp]
  );
  for (const r of rows) {
    if (r.content_fingerprint === fullFp) return true;
    // Legacy body-only fingerprints: compare live full fingerprint from message text.
    if (userMessageFingerprint(uid, r.message) === fullFp) return true;
  }
  return false;
}

const NON_REUSE_INTENTS = new Set(['extract_failed', 'duplicate']);
const NON_REUSE_MODELS = new Set(['skip-auth', 'dup-skip', 'hit-cap', 'none']);

/**
 * If any other user already extracted the same body+footer, copy their rows (0 OpenAI).
 */
async function copyCrossUserExtraction(job) {
  const {
    messageContentFingerprint,
    userListingFingerprint
  } = require('../contentFingerprint');
  const globalFp = messageContentFingerprint(job.message);
  if (!globalFp) return null;

  const { rows: srcMsgs } = await db.query(
    `SELECT m.id
       FROM whatsapp_messages m
      WHERE m.id <> $1
        AND m.content_fingerprint IS NOT NULL
        AND regexp_replace(m.content_fingerprint, '^u[0-9]+\\|', '') = $2
        AND EXISTS (
          SELECT 1 FROM normalized_messages n
           WHERE n.whatsapp_message_id = m.id
             AND COALESCE(n.intent, '') <> ALL($3::text[])
             AND COALESCE(n.model_used, '') <> ALL($4::text[])
        )
      ORDER BY m.id ASC
      LIMIT 1`,
    [job.id, globalFp, [...NON_REUSE_INTENTS], [...NON_REUSE_MODELS]]
  );
  if (!srcMsgs.length) return null;

  const srcId = srcMsgs[0].id;
  const { rows: srcRows } = await db.query(
    `SELECT * FROM normalized_messages
      WHERE whatsapp_message_id = $1
      ORDER BY listing_index ASC`,
    [srcId]
  );
  if (!srcRows.length) return null;

  const uid = tenantId(job.user_id);
  const copied = srcRows.map((r) => {
    const {
      id: _id,
      created_at: _ca,
      place_resolved_at: _pra,
      ...rest
    } = r;
    const row = {
      ...rest,
      whatsapp_message_id: job.id,
      chat_jid: job.chat_jid,
      sender: job.sender,
      model_used: 'cross-user-reuse',
      extract_trace: JSON.stringify({
        reused_from_message_id: srcId,
        prior_model: r.model_used
      })
    };
    if (row.is_property && userListingFingerprint) {
      row.content_fingerprint = userListingFingerprint(uid, {
        listing_excerpt: row.listing_excerpt,
        summary: row.summary,
        purpose: row.purpose,
        rawMessage: job.message || '',
        contact_number: row.contact_number
      });
    }
    return row;
  });

  const { saveMessageRows } = require('./extract/persist');
  await saveMessageRows(db, job.id, copied);
  const props = copied.filter((r) => r.is_property).length;
  console.info(
    `[ai] Message ${job.id} (user ${uid}) cross-user-reuse from msg ${srcId} → ${props} listing(s)`
  );
  return { id: job.id, ok: true, listings: props, provider: 'cross-user-reuse' };
}

async function deadLetterMessage(job, { intent = 'extract_failed', model = 'skip-auth', summary = '' } = {}) {
  const { buildRows } = require('./extract/extractor');
  const { saveMessageRows } = require('./extract/persist');
  const rows = buildRows(
    { is_property: false, language: 'en', listings: [] },
    {
      messageId: job.id,
      chatJid: job.chat_jid,
      sender: job.sender,
      senderPhone: job.sender_phone,
      messageText: job.message || '',
      userId: job.user_id,
      model
    }
  );
  if (rows[0]) {
    rows[0].intent = intent;
    rows[0].summary = summary || `[${intent}]`;
    rows[0].model_used = model;
    rows[0].category = 'skipped';
  }
  await saveMessageRows(db, job.id, rows);
}

function extractionContext(job, model) {
  return {
    messageId: job.id,
    chatJid: job.chat_jid,
    sender: job.sender,
    senderPhone: job.sender_phone,
    messageText: job.message || '',
    userId: job.user_id,
    model
  };
}

/** Duplicate, already-extracted, or too-short rows. Null means this row needs the model. */
async function skipWithoutModel(job) {
  const { buildRows } = require('./extract/extractor');
  const { saveMessageRows } = require('./extract/persist');

  if (await alreadyNormalizedSameBody(job)) {
    const rows = buildRows(
      { is_property: false, language: 'en', listings: [] },
      extractionContext(job, 'dup-skip')
    );
    if (rows[0]) {
      rows[0].intent = 'duplicate';
      rows[0].summary = '[skipped duplicate listing content]';
      rows[0].model_used = 'dup-skip';
    }
    await saveMessageRows(db, job.id, rows);
    console.info(`[ai] Message ${job.id} skipped OpenAI — same body+footer already normalized`);
    return { id: job.id, ok: true, listings: 0, provider: 'dup-skip' };
  }

  const reused = await copyCrossUserExtraction(job);
  if (reused) return reused;

  if (!job.message || String(job.message).trim().length < 12) {
    const rows = buildRows(
      { is_property: false, language: 'en', listings: [] },
      extractionContext(job, 'none')
    );
    await saveMessageRows(db, job.id, rows);
    return { id: job.id, ok: true, listings: 0 };
  }

  return null;
}

async function persistExtraction(job, extraction, model, provider) {
  const { buildRows } = require('./extract/extractor');
  const { saveMessageRows } = require('./extract/persist');
  const { correctSplitListingPhases, fillMissingPhases } = require('./googlePhaseMap');

  const rows = buildRows(extraction, extractionContext(job, model));
  await correctSplitListingPhases(rows);
  try {
    await fillMissingPhases(db, rows);
  } catch (err) {
    console.info(`[extract] google missing-phase fill skipped: ${String(err.message || err).slice(0, 120)}`);
  }
  try {
    const { fillBtkNamedPrecincts } = require('./btkPrecincts');
    await fillBtkNamedPrecincts(rows);
  } catch (_) { /* named BTK precinct lookup is optional */ }
  const saved = await saveMessageRows(db, job.id, rows);
  const props = rows.filter((r) => r.is_property).length;
  console.info(
    `[ai] Message ${job.id} (user ${tenantId(job.user_id)}) extract-v2 [${provider}/${model}] → ${props} listing(s) inserted=${saved.inserted}`
  );
  return { id: job.id, ok: true, listings: props, provider };
}

async function failExtract(job, err) {
  const { classifyExtractError } = require('./extract/errorClassify');
  const classified = classifyExtractError(err);
  const reason = `${err.name || 'Error'}: ${err.message}`;
  if (classified.isQuota || classified.is429 || classified.is402) {
    console.warn(`[ai] Rate/quota on message ${job.id} (${classified.provider || '?'}): ${reason.slice(0, 160)}`);
    try {
      await deadLetterMessage(job, {
        intent: 'extract_failed',
        model: 'skip-quota',
        summary: `[quota/rate] ${reason.slice(0, 160)}`
      });
    } catch (_) { /* ignore */ }
    return {
      id: job.id,
      ok: false,
      rateLimited: true,
      quotaProvider: classified.provider,
      is402: classified.is402,
      authFailed: false
    };
  }
  if (err.primaryError) {
    const p = classifyExtractError(err.primaryError);
    if (p.isQuota || p.is429 || p.is402) {
      try {
        await deadLetterMessage(job, {
          intent: 'extract_failed',
          model: 'skip-quota',
          summary: `[quota/rate] ${String(err.primaryError.message || '').slice(0, 160)}`
        });
      } catch (_) { /* ignore */ }
      return {
        id: job.id,
        ok: false,
        rateLimited: true,
        quotaProvider: p.provider,
        is402: p.is402
      };
    }
  }
  logNormalizationFailure({
    messageId: job.id,
    modelName: EXTRACT_V2_MODEL,
    reason
  });
  const model = classified.isHitCap ? 'hit-cap' : classified.isAuth ? 'skip-auth' : 'skip-fail';
  try {
    await deadLetterMessage(job, {
      intent: 'extract_failed',
      model,
      summary: `[${model}] ${reason.slice(0, 160)}`
    });
  } catch (_) { /* ignore */ }
  console.error(`[ai] Error processing message ${job.id}: ${reason}`);
  return {
    id: job.id,
    ok: false,
    authFailed: Boolean(classified.isAuth),
    hardFail: Boolean(classified.isHardFail)
  };
}

/**
 * One message. Used when a batch reply omits an id.
 * The batch path sends 50 messages in one OpenAI call.
 */
async function normalizeOneExtractV2(job) {
  const { extractMessage } = require('./extract/extractor');
  try {
    const skipped = await skipWithoutModel(job);
    if (skipped) return skipped;
    const { extraction, model, provider } = await extractMessage(job);
    return await persistExtraction(job, extraction, model, provider);
  } catch (err) {
    return failExtract(job, err);
  } finally {
    await releaseClaim(job.id, EXTRACT_V2_MODEL);
  }
}

/**
 * One OpenAI HTTP for exactly 50 messages.
 * Fewer than 50 never calls the API. A failed call retries once, then the batch is skipped.
 * A missing id is released and waits until it can sit in another full batch of 50.
 */
async function normalizeAiChunk(jobs) {
  const { extractMessages, NORMALIZE_AI_BATCH } = require('./extract/extractor');
  if (jobs.length !== NORMALIZE_AI_BATCH) {
    console.error(
      `[ai] Refusing OpenAI call for ${jobs.length} message(s); a call is only made at ${NORMALIZE_AI_BATCH}`
    );
    for (const job of jobs) await releaseClaim(job.id, EXTRACT_V2_MODEL);
    return jobs.map((job) => ({ id: job.id, ok: false, shortBatch: true }));
  }
  let extracted;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      extracted = await extractMessages(jobs);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      console.warn(
        `[ai] OpenAI batch of ${jobs.length} failed (attempt ${attempt}/2): ${String(err.message || err).slice(0, 160)}`
      );
    }
  }
  if (lastErr) {
    const reason = String(lastErr.message || lastErr).slice(0, 160);
    console.error(`[ai] OpenAI batch of ${jobs.length} failed twice; skipping batch`);
    const outcomes = [];
    for (const job of jobs) {
      try {
        await deadLetterMessage(job, {
          intent: 'extract_failed',
          model: 'skip-fail',
          summary: `[batch-skip] ${reason}`
        });
      } catch (_) { /* ignore */ }
      await releaseClaim(job.id, EXTRACT_V2_MODEL);
      outcomes.push({ id: job.id, ok: false, skippedBatch: true });
    }
    return outcomes;
  }

  for (const job of jobs) alreadySentIds.add(Number(job.id));

  const outcomes = [];
  for (const job of jobs) {
    const extraction = extracted.byId.get(Number(job.id));
    if (!extraction) {
      // Do not call OpenAI again. A solo retry is a full-price call per missed id.
      console.warn(`[ai] Batch missed message ${job.id}; it will not be sent again`);
      outcomes.push({ id: job.id, ok: false, missingFromBatch: true });
      await releaseClaim(job.id, EXTRACT_V2_MODEL);
      continue;
    }
    try {
      outcomes.push(await persistExtraction(job, extraction, extracted.model, extracted.provider));
    } catch (err) {
      outcomes.push(await failExtract(job, err));
    } finally {
      await releaseClaim(job.id, EXTRACT_V2_MODEL);
    }
  }
  console.info(
    `[ai] OpenAI batch ${jobs.length} message(s) → ${extracted.byId.size} matched, ${extracted.missing.length} missing`
  );
  return outcomes;
}

async function normalizeClaimed(jobs) {
  const { NORMALIZE_AI_BATCH } = require('./extract/extractor');
  const outcomes = [];
  const aiJobs = [];
  for (const job of jobs) {
    try {
      const skipped = await skipWithoutModel(job);
      if (skipped) {
        outcomes.push(skipped);
        await releaseClaim(job.id, EXTRACT_V2_MODEL);
      } else {
        aiJobs.push(job);
      }
    } catch (err) {
      outcomes.push(await failExtract(job, err));
      await releaseClaim(job.id, EXTRACT_V2_MODEL);
    }
  }
  const full = aiJobs.length - (aiJobs.length % NORMALIZE_AI_BATCH);
  for (let i = 0; i < full; i += NORMALIZE_AI_BATCH) {
    const chunk = aiJobs.slice(i, i + NORMALIZE_AI_BATCH);
    const part = await normalizeAiChunk(chunk);
    outcomes.push(...part);
  }
  const held = aiJobs.slice(full);
  for (const job of held) await releaseClaim(job.id, EXTRACT_V2_MODEL);
  if (held.length) {
    console.info(
      `[ai] Held ${held.length} unique message(s); OpenAI waits until ${NORMALIZE_AI_BATCH}`
    );
  }
  return outcomes;
}

/**
 * Walk pending rows, clear duplicates without a model call, and return at most
 * `need` messages that still require OpenAI. Stops once that many are in hand.
 */
async function gatherModelJobs(targetModel, userId, need) {
  const outcomes = [];
  const aiJobs = [];
  let cursor = 0;
  let scanned = 0;
  let heldFromEarlierBatch = 0;
  const pageSize = 200;
  const scanCap = 2000;
  while (aiJobs.length < need && scanned < scanCap) {
    const page = await loadPendingJobs(targetModel, userId, pageSize, {
      ignoreSkips: false,
      minId: cursor
    });
    if (!page.length) break;
    for (const job of page) {
      cursor = Number(job.id);
      scanned += 1;
      if (alreadySentIds.has(Number(job.id))) {
        heldFromEarlierBatch += 1;
        continue;
      }
      try {
        const skipped = await skipWithoutModel(job);
        if (skipped) outcomes.push(skipped);
        else aiJobs.push(job);
      } catch (err) {
        outcomes.push(await failExtract(job, err));
      }
      if (aiJobs.length >= need || scanned >= scanCap) break;
    }
    if (page.length < pageSize) break;
  }
  return { outcomes, aiJobs: aiJobs.slice(0, need), scanned, heldFromEarlierBatch };
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

async function loadPendingJobs(targetModel, userId, window, { ignoreSkips = true, minId = 0 } = {}) {
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

  // Only messages scraped after this id. Older rows, including removed local-NER cards, stay untouched.
  const afterId = Math.max(
    Number(process.env.NORMALIZE_AFTER_ID || 0),
    Number(minId) || 0
  );
  let afterFilter = '';
  if (afterId > 0) {
    params.push(afterId);
    afterFilter = `AND m.id > $${params.length}`;
  }

  params.push(NORMALIZE_NOT_BEFORE);
  const notBeforeIdx = params.length;
  const notBeforeFilter = `
       AND (
         (m.timestamp ~ '^[0-9]+$' AND to_timestamp(m.timestamp::bigint) >= $${notBeforeIdx}::timestamptz)
         OR (
           (m.timestamp IS NULL OR m.timestamp !~ '^[0-9]+$')
           AND m.created_at >= $${notBeforeIdx}::timestamptz
         )
       )`;

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
       ${afterFilter}
       ${notBeforeFilter}
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
 * Normalize a batch of pending WhatsApp messages.
 * Scraped text → OpenAI gpt-4o-mini only. No NER, gazetteer, or geocode.
 * @returns {{ successCount: number, failCount: number, claimed: number }}
 */
async function processUnnormalizedMessages({
  batchSize = 50,
  userId = null,
  concurrency = null
} = {}) {
  const cfg = getConfig();
  const targetModel = EXTRACT_V2_MODEL;
  const perUser = cfg.normalizePerUser;

  if (userId != null) {
    const paused = await db.query(
      `SELECT 1 FROM normalize_jobs WHERE user_id = $1 AND status = 'paused' LIMIT 1`,
      [Number(userId)]
    );
    if (paused.rowCount > 0) {
      console.info(`[ai] Skip normalize; user=${userId} job is paused`);
      return {
        successCount: 0,
        failCount: 0,
        claimed: 0,
        rateLimited: 0,
        authFailed: 0,
        paused: true
      };
    }
  }

  loadSkippedIds();
  await releaseStaleClaims(targetModel);

  const { NORMALIZE_AI_BATCH } = require('./extract/extractor');
  const need = NORMALIZE_AI_BATCH;
  const gathered = await gatherModelJobs(targetModel, userId, need);
  const outcomes = gathered.outcomes;

  if (gathered.aiJobs.length < need) {
    console.info(
      `[ai] ${gathered.aiJobs.length} new unique unnormalized message(s); OpenAI waits until ${need}` +
        (gathered.heldFromEarlierBatch
          ? ` (${gathered.heldFromEarlierBatch} already sent, not called again)`
          : '')
    );
    let successCount = 0;
    let failCount = 0;
    for (const o of outcomes) {
      if (o?.ok) successCount += 1;
      else failCount += 1;
    }
    return {
      successCount,
      failCount,
      claimed: 0,
      rateLimited: 0,
      authFailed: 0,
      waitingForBatch: true,
      ready: gathered.aiJobs.length
    };
  }

  const selected = fairPick(gathered.aiJobs, need, perUser);
  const claimed = selected.length === need ? await claimJobs(selected, targetModel) : [];
  if (claimed.length !== need) {
    for (const job of claimed) await releaseClaim(job.id, EXTRACT_V2_MODEL);
    console.info(`[ai] Claimed ${claimed.length}/${need}; OpenAI not called`);
    let successCount = 0;
    let failCount = 0;
    for (const o of outcomes) {
      if (o?.ok) successCount += 1;
      else failCount += 1;
    }
    return {
      successCount,
      failCount,
      claimed: 0,
      rateLimited: 0,
      authFailed: 0,
      waitingForBatch: true,
      ready: claimed.length
    };
  }

  const tenantCounts = {};
  for (const job of claimed) {
    const uid = tenantId(job.user_id);
    tenantCounts[uid] = (tenantCounts[uid] || 0) + 1;
  }

  console.info(
    `[ai] Processing ${claimed.length} messages ` +
      `(llm=openai/${process.env.OPENAI_MODEL || process.env.EXTRACT_MODEL || 'gpt-5-nano'} batch=${need}, tenants=${JSON.stringify(tenantCounts)})`
  );

  const started = Date.now();
  outcomes.push(...(await normalizeAiChunk(claimed)));

  let successCount = 0;
  let failCount = 0;
  let rateLimited = 0;
  let authFailed = 0;
  const quotaHits = { gemini: 0, together: 0, openai: 0 };
  for (const o of outcomes) {
    if (o?.ok) successCount += 1;
    else {
      failCount += 1;
      if (o?.authFailed) authFailed += 1;
      if (o?.rateLimited) {
        rateLimited += 1;
        if (o.quotaProvider === 'gemini') quotaHits.gemini += 1;
        else if (o.quotaProvider === 'together') quotaHits.together += 1;
        else quotaHits.openai += 1;
      }
    }
  }

  const elapsed = (Date.now() - started) / 1000;
  console.info(
    `[ai] Batch complete: ${successCount}/${claimed.length} normalized, ${failCount} failed` +
      (rateLimited ? ` (${rateLimited} rate/quota)` : '') +
      (authFailed ? ` (${authFailed} auth)` : '') +
      ` in ${elapsed.toFixed(1)}s`
  );

  return {
    successCount,
    failCount,
    claimed: claimed.length,
    rateLimited,
    authFailed,
    quotaHits
  };
}

module.exports = {
  processUnnormalizedMessages,
  fairPick,
  releaseStaleClaims,
  tenantId,
  EXTRACT_V2_MODEL,
  useExtractV2
};
