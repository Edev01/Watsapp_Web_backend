const db = require('../db');
const { getConfig } = require('./config');
const {
  loadSkippedIds,
  logNormalizationFailure,
  getSkippedIds
} = require('./failureLog');

const EXTRACT_V2_MODEL = 'extract-v2';

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

/**
 * Extract v2 path: one LLM call, then Google corrects a header phase when
 * one offer in a multi-listing names a place in a different phase.
 */
async function normalizeOneExtractV2(job) {
  const { extractMessage, buildRows } = require('./extract/extractor');
  const { saveMessageRows } = require('./extract/persist');
  const { classifyExtractError } = require('./extract/errorClassify');
  const { correctSplitListingPhases, fillMissingPhases } = require('./googlePhaseMap');

  try {
    if (await alreadyNormalizedSameBody(job)) {
      const rows = buildRows(
        { is_property: false, language: 'en', listings: [] },
        {
          messageId: job.id,
          chatJid: job.chat_jid,
          sender: job.sender,
          senderPhone: job.sender_phone,
          messageText: job.message || '',
          userId: job.user_id,
          model: 'dup-skip'
        }
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
        {
          messageId: job.id,
          chatJid: job.chat_jid,
          sender: job.sender,
          senderPhone: job.sender_phone,
          messageText: job.message || '',
          userId: job.user_id,
          model: 'none'
        }
      );
      await saveMessageRows(db, job.id, rows);
      return { id: job.id, ok: true, listings: 0 };
    }

    // Exactly one OpenAI HTTP per message — no multi-chunk extract retries.
    let { extraction, model, provider } = await extractMessage(job);
    let rows = buildRows(extraction, {
      messageId: job.id,
      chatJid: job.chat_jid,
      sender: job.sender,
      senderPhone: job.sender_phone,
      messageText: job.message,
      userId: job.user_id,
      model
    });

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
  } catch (err) {
    const classified = classifyExtractError(err);
    const reason = `${err.name || 'Error'}: ${err.message}`;
    if (classified.isQuota || classified.is429 || classified.is402) {
      console.warn(`[ai] Rate/quota on message ${job.id} (${classified.provider || '?'}): ${reason.slice(0, 160)}`);
      // One-shot policy: dead-letter so this message is never retried for OpenAI.
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
    const model =
      classified.isHitCap ? 'hit-cap' : classified.isAuth ? 'skip-auth' : 'skip-fail';
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
  } finally {
    await releaseClaim(job.id, EXTRACT_V2_MODEL);
  }
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

  // Only messages scraped after this id. Older rows, including removed local-NER cards, stay untouched.
  const afterId = Number(process.env.NORMALIZE_AFTER_ID || 0);
  let afterFilter = '';
  if (afterId > 0) {
    params.push(afterId);
    afterFilter = `AND m.id > $${params.length}`;
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
       ${afterFilter}
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
  const workers = concurrency || cfg.normalizeConcurrency;
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

  const window = Math.max(batchSize * 4, 80);
  const candidates = await loadPendingJobs(targetModel, userId, window, { ignoreSkips: false });
  const selected = fairPick(candidates, batchSize, perUser);
  const claimed = await claimJobs(selected, targetModel);

  if (!claimed.length) {
    return { successCount: 0, failCount: 0, claimed: 0, rateLimited: 0, authFailed: 0 };
  }

  const tenantCounts = {};
  for (const job of claimed) {
    const uid = tenantId(job.user_id);
    tenantCounts[uid] = (tenantCounts[uid] || 0) + 1;
  }

  console.info(
    `[ai] Processing ${claimed.length} messages ` +
      `(llm=openai/${process.env.OPENAI_MODEL || process.env.EXTRACT_MODEL || 'gpt-5-nano'}, workers=${workers}, tenants=${JSON.stringify(tenantCounts)})`
  );

  const started = Date.now();
  const outcomes = await mapPool(claimed, workers, (job) => normalizeOneExtractV2(job));

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
