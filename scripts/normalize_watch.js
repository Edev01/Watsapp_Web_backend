#!/usr/bin/env node
/**
 * Background watcher: polls for raw WhatsApp messages without normalized rows
 * and runs Extract v2 (Together → Gemini fallback) via the in-process pipeline.
 *
 *   node scripts/normalize_watch.js
 *
 * Needs: AI_PIPELINE=local, EXTRACT_*, LLM_API_KEY / GEMINI_API_KEYS, DATABASE_URL
 * Stop emails: SMTP_* (sent when quota kills a drain cycle)
 */
require('dotenv').config();

if (!process.env.AI_PIPELINE || process.env.AI_PIPELINE === 'off') {
  process.env.AI_PIPELINE = 'local';
}

const db = require('../db');
const { queueNormalizeJob } = require('../normalizeHelper');
const { startPipelineWorker, wakePipeline, getPipelineStats } = require('../ai/pipelineWorker');

async function enqueueUsersWithPending() {
  const { rows } = await db.query(
    `SELECT m.user_id, COUNT(*)::int AS pending
       FROM whatsapp_messages m
      WHERE m.message IS NOT NULL AND TRIM(m.message) <> ''
        AND m.user_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id
        )
      GROUP BY m.user_id
      ORDER BY pending DESC`
  );
  for (const r of rows) {
    const { job, alreadyActive } = await queueNormalizeJob(r.user_id, {
      model: 'extract-v2',
      embed: false,
      batchSize: 50
    });
    console.info(
      `[watch] user=${r.user_id} pending=${r.pending} job=${job.status}` +
        (alreadyActive ? ' (already active)' : ' (queued)')
    );
    wakePipeline(r.user_id);
  }
  if (!rows.length) console.info('[watch] no pending raw messages');
  return rows.length;
}

async function main() {
  console.info(
    `[watch] extract provider=${process.env.EXTRACT_PROVIDER || 'together'} ` +
      `fallback=${process.env.EXTRACT_FALLBACK_PROVIDER || 'none'} ` +
      `model=${process.env.EXTRACT_MODEL || process.env.NORMALIZE_MODEL}`
  );
  const started = startPipelineWorker();
  console.info('[watch] pipeline worker', started);

  await enqueueUsersWithPending();
  // Re-scan pending every poll interval so new inserts (even without wake) get jobs
  const poll = Math.max(15000, Number(process.env.PIPELINE_POLL_MS || 15000));
  setInterval(() => {
    enqueueUsersWithPending().catch((e) => console.warn('[watch] enqueue failed:', e.message));
    const s = getPipelineStats();
    console.info(
      `[watch] stats running=${s.running} lastNorm=${s.lastNormalized} totalNorm=${s.totalNormalized} err=${s.lastError || '-'}`
    );
  }, poll);

  console.info(`[watch] polling every ${poll}ms — Ctrl+C to stop`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
