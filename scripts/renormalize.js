#!/usr/bin/env node
/**
 * Re-normalize existing WhatsApp messages with extract v2.
 *
 *   node scripts/renormalize.js --user 4                      # DRY RUN, 20 messages, prints results, writes nothing
 *   node scripts/renormalize.js --user 4 --limit 200          # DRY RUN on 200
 *   node scripts/renormalize.js --user 4 --ids 11859,11710    # DRY RUN on specific messages
 *   node scripts/renormalize.js --user 4 --apply              # REAL RUN, all pending messages (resumable)
 *   node scripts/renormalize.js --user 4 --apply --force      # redo messages already on v2
 *   node scripts/renormalize.js --user 4 --btk --apply --force  # Bahria Town Karachi chats + BTK/precinct ads
 *
 * Options: --concurrency 6  --from-id N  --chat-default Karachi  --no-backup
 * Needs: migration applied, EXTRACT_PROVIDER / EXTRACT_MODEL / API keys in .env
 * Sends SMTP alert on exit (SMTP_* in .env) with stop reason and Gemini/Together 429 counts.
 */
require('dotenv').config();
const fs = require('fs');
const db = require('../db');
const { extractMessage, buildRows } = require('../ai/extract/extractor');
const { saveMessageRows } = require('../ai/extract/persist');
const { bumpRateLimitStats } = require('../ai/extract/errorClassify');

const args = (() => {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
  return {
    user: Number(get('user')),
    apply: a.includes('--apply'),
    force: a.includes('--force'),
    btk: a.includes('--btk'),
    noBackup: a.includes('--no-backup'),
    limit: get('limit') ? Number(get('limit')) : null,
    ids: get('ids') ? get('ids').split(',').map(Number).filter(Boolean) : null,
    idsFile: get('ids-file') || null,
    fromId: Number(get('from-id') || 0),
    concurrency: Number(get('concurrency') || 6),
    chatDefault: get('chat-default') || null,
    model: get('model') || null
  };
})();

if (args.idsFile) {
  const extra = fs.readFileSync(args.idsFile, 'utf8').split(/\s+/).map(Number).filter(Boolean);
  args.ids = [...new Set([...(args.ids || []), ...extra])];
}

if (!args.user) {
  console.error('Usage: node scripts/renormalize.js --user <id> [--apply] [--limit N] [--ids a,b] [--force] [--btk] [--concurrency 6]');
  process.exit(1);
}
const DRY = !args.apply;
const LIMIT = args.limit ?? (DRY ? 20 : 1e9);
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const BACKUP = `normalized_messages_bak_${stamp.slice(0, 8)}`;
const reportPath = `renormalize-report-${stamp}.jsonl`;
const failedPath = `renormalize-failed-${stamp}.txt`;

const QUOTA_ABORT_STREAK = Number(process.env.RENORMALIZE_QUOTA_ABORT_STREAK || 12);

async function ensureBackup() {
  const ex = await db.query(`SELECT to_regclass($1) AS t`, [BACKUP]);
  if (ex.rows[0].t) { console.log(`[backup] ${BACKUP} already exists, keeping it`); return; }
  await db.query(`CREATE TABLE ${BACKUP} AS TABLE normalized_messages`);
  const n = await db.query(`SELECT count(*)::int AS c FROM ${BACKUP}`);
  console.log(`[backup] created ${BACKUP} (${n.rows[0].c} rows)`);
}

async function loadMessages() {
  const params = [args.user];
  let where = `m.user_id = $1 AND m.message IS NOT NULL AND length(trim(m.message)) > 0`;
  if (args.ids) {
    params.push(args.ids);
    where += ` AND m.id = ANY($${params.length}::int[])`;
    if (!args.force) where += ` AND NOT EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id AND n.extract_version = 2)`;
  }
  else {
    params.push(args.fromId);
    where += ` AND m.id > $${params.length}`;
    if (!args.force) where += ` AND NOT EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id AND n.extract_version = 2)`;
    if (args.model) {
      params.push(args.model);
      where += ` AND EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id AND n.model_used = $${params.length})`;
    }
  }
  if (args.btk) {
    where += ` AND (
      (
        (c.name ILIKE '%btk%' OR c.name ILIKE '%bahria town%')
        AND c.name !~* 'rawalpindi|lahore|islamabad|\\\\brwp\\\\b'
      )
      OR (
        m.message ~* '(btk|bahria town karachi|bahria town|precincts?|precints?)'
        AND m.message !~* 'bahria[[:space:]]+(rwp|rawalpindi|lahore|islamabad)'
      )
    )`;
  }
  params.push(Math.min(LIMIT, 1e9));
  const res = await db.query(
    `SELECT m.id, m.user_id, m.chat_jid, m.sender, m.sender_phone, m.message, c.default_city
       FROM whatsapp_messages m
       LEFT JOIN whatsapp_chats c ON c.user_id = m.user_id AND c.jid = m.chat_jid
      WHERE ${where}
      ORDER BY m.id ASC
      LIMIT $${params.length}`,
    params
  );
  return res.rows;
}

const stats = {
  total: 0,
  done: 0,
  errors: 0,
  property: 0,
  nonProperty: 0,
  rows: 0,
  review: 0,
  withPrice: 0,
  withSize: 0,
  withPhase: 0,
  skippedDup: 0,
  rateLimit: { gemini429: 0, together429: 0, together402: 0, geminiOther: 0, togetherOther: 0, unknown429: 0 },
  sampleErrors: [],
  providersUsed: { openai: 0, together: 0, gemini: 0, anthropic: 0 }
};

let stopReason = null;
let shouldStop = false;
let consecutiveQuotaFails = 0;
let startedAt = new Date().toISOString();

function noteError(err) {
  stats.errors += 1;
  bumpRateLimitStats(stats, err);
  const line = String(err?.message || err).slice(0, 200);
  if (stats.sampleErrors.length < 8) stats.sampleErrors.push(line);
  else stats.sampleErrors.shift(), stats.sampleErrors.push(line);

  const msg = String(err?.message || '');
  const quotaHit =
    /429/.test(msg) &&
    (/quota|exceeded your current quota|rate limit/i.test(msg) || /^gemini 429|^together 429/i.test(msg));
  if (quotaHit) {
    consecutiveQuotaFails += 1;
    if (consecutiveQuotaFails >= QUOTA_ABORT_STREAK) {
      shouldStop = true;
      stopReason = 'aborted_consecutive_api_quota';
      console.error(
        `[stop] ${consecutiveQuotaFails} consecutive quota/rate-limit failures — halting (Gemini 429: ${stats.rateLimit.gemini429}, Together 429: ${stats.rateLimit.together429})`
      );
    }
  } else {
    consecutiveQuotaFails = 0;
  }
}

async function processOne(msg) {
  if (shouldStop) return;
  try {
    let rows;
    if (msg.message.trim().length < 12) {
      rows = buildRows({ is_property: false, language: 'en', listings: [] }, ctxOf(msg, 'none'));
    } else {
      const { extraction, model, provider } = await extractMessage(msg);
      if (provider && stats.providersUsed[provider] != null) stats.providersUsed[provider] += 1;
      rows = buildRows(extraction, ctxOf(msg, model));
      try {
        const { correctSplitListingPhases, fillMissingPhases } = require('../ai/googlePhaseMap');
        await correctSplitListingPhases(rows);
        await fillMissingPhases(require('../db'), rows);
      } catch (_) { /* optional */ }
      try {
        const { fillBtkNamedPrecincts } = require('../ai/btkPrecincts');
        await fillBtkNamedPrecincts(rows);
      } catch (_) { /* optional */ }
    }
    consecutiveQuotaFails = 0;

    const props = rows.filter((r) => r.is_property);
    stats.property += props.length;
    stats.nonProperty += props.length ? 0 : 1;
    stats.rows += rows.length;
    stats.review += rows.filter((r) => r.needs_review).length;
    stats.withPrice += props.filter((r) => r.price_value != null).length;
    stats.withSize += props.filter((r) => r.size_sqft != null).length;
    stats.withPhase += props.filter((r) => r.phase != null).length;

    fs.appendFileSync(reportPath, JSON.stringify({
      message_id: msg.id,
      text: msg.message.slice(0, 400),
      rows: rows.map((r) => ({
        i: r.listing_index, prop: r.is_property, kind: r.listing_kind, purpose: r.purpose, type: r.property_type,
        city: r.city, city_src: r.city_source, society: r.society_key, phase: r.phase, loc: r.location_text,
        price_text: r.price, price: r.price_value, price_basis: r.price_basis, price_inferred: r.price_inferred,
        size_text: r.size, sqft: r.size_sqft, review: r.needs_review, trace: JSON.parse(r.extract_trace || '{}').warnings
      }))
    }) + '\n');

    if (!DRY) {
      const res = await saveMessageRows(db, msg.id, rows);
      stats.skippedDup += res.skipped;
    }
    stats.done += 1;
  } catch (err) {
    if (err.primaryError) bumpRateLimitStats(stats, err.primaryError);
    noteError(err);
    fs.appendFileSync(failedPath, `${msg.id}\t${String(err.message).slice(0, 200)}\n`);
    console.error(`[err] msg ${msg.id}: ${err.message}`);
  }
  if (stats.done % 25 === 0 && stats.done) log();
}

const ctxOf = (m, model) => ({
  messageId: m.id, chatJid: m.chat_jid, sender: m.sender, senderPhone: m.sender_phone,
  messageText: m.message, chatDefaultCity: args.chatDefault || m.default_city || 'Karachi',
  userId: m.user_id, model
});

function log() {
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
  console.log(
    `[${DRY ? 'dry' : 'live'}] ${stats.done}/${stats.total} done, ${stats.errors} errors | listings ${stats.property} ` +
    `price ${pct(stats.withPrice, stats.property)} size ${pct(stats.withSize, stats.property)} phase ${pct(stats.withPhase, stats.property)} ` +
    `review ${stats.review}`
  );
}

function buildRateLimitNote() {
  const g = stats.rateLimit.gemini429;
  const t = stats.rateLimit.together429;
  if (!g && !t) return 'No 429/quota errors recorded in this run.';
  const parts = [];
  if (g) parts.push(`Gemini returned ${g} quota/rate-limit error(s) — add keys, wait for daily reset, or rely on Together fallback.`);
  const t402 = stats.rateLimit.together402;
  if (t) parts.push(`Together returned ${t} rate-limit (429) error(s) — lower concurrency.`);
  if (t402) parts.push(`Together returned ${t402} billing (402) error(s) — add credits at together.ai/settings/billing.`);
  return parts.join(' ');
}

function resolveStopReason(fatalMessage) {
  if (fatalMessage) return `fatal: ${fatalMessage.slice(0, 120)}`;
  if (stopReason) return stopReason;
  if (stats.total === 0) return 'no_messages_to_process';
  if (stats.done === 0 && stats.errors > 0) return 'failed_all_messages';
  if (stats.errors > 0) return 'completed_with_errors';
  return 'completed_ok';
}

async function sendStopEmail(extra = {}) {
  const summary = {
    stopReason: resolveStopReason(extra.fatalMessage),
    dryRun: DRY,
    userId: args.user,
    extractProvider: process.env.EXTRACT_PROVIDER || 'together',
    extractFallback: process.env.EXTRACT_FALLBACK_PROVIDER || '',
    total: stats.total,
    done: stats.done,
    errors: stats.errors,
    property: stats.property,
    rateLimit: stats.rateLimit,
    rateLimitNote: buildRateLimitNote(),
    reportPath,
    failedPath: stats.errors ? failedPath : null,
    sampleErrors: stats.sampleErrors,
    providersUsed: stats.providersUsed,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...extra
  };
  try {
    const { sendRenormalizeStopEmail } = require('../mailHelper');
    const r = await sendRenormalizeStopEmail(summary);
    if (r.sent) console.log('[mail] stop alert sent');
    else console.warn(`[mail] stop alert not sent: ${r.reason}`);
  } catch (e) {
    console.error('[mail] stop alert failed:', e.message);
  }
}

async function main() {
  console.log(DRY ? '*** DRY RUN: nothing will be written to the database ***' : '*** LIVE RUN ***');
  console.log(
    `[extract] llm=gemini → openai → together`
  );
  if (!DRY && !args.noBackup) await ensureBackup();
  const msgs = await loadMessages();
  stats.total = msgs.length;
  console.log(`[load] ${msgs.length} messages for user ${args.user}`);

  let next = 0;
  const workers = Array.from({ length: Math.max(1, args.concurrency) }, async () => {
    while (!shouldStop && next < msgs.length) {
      const m = msgs[next++];
      await processOne(m);
    }
  });
  await Promise.all(workers);

  log();
  console.log(`[report] ${reportPath}`);
  if (stats.errors) console.log(`[failed] ${failedPath}  (re-run the same command: finished messages are skipped)`);
  if (DRY) console.log('Dry run finished. Review the report, then re-run with --apply.');
  await sendStopEmail();
  if (db.end) await db.end().catch(() => {});
  else if (db.pool?.end) await db.pool.end().catch(() => {});
  process.exit(stats.errors && !stats.done ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await sendStopEmail({ fatalMessage: e.message });
  process.exit(1);
});
