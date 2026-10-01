#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');
const { messageContentFingerprint } = require('../contentFingerprint');

(async () => {
  const userId = Number(process.argv[2] || 4);

  // Unnormalized messages
  const { rows: pending } = await db.query(
    `SELECT m.id, m.message, m.created_at, m.timestamp, m.sender, length(m.message) AS len
     FROM whatsapp_messages m
     WHERE m.user_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id
       )
     ORDER BY m.id ASC`,
    [userId]
  );

  // Fingerprints already covered by a normalized message for this user
  const { rows: done } = await db.query(
    `SELECT m.id, m.message
     FROM whatsapp_messages m
     WHERE m.user_id = $1
       AND EXISTS (
         SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id
       )
       AND length(COALESCE(m.message,'')) >= 40
     ORDER BY m.id DESC
     LIMIT 30000`,
    [userId]
  );

  const coveredFp = new Set();
  for (const r of done) {
    const fp = messageContentFingerprint(r.message);
    if (fp) coveredFp.add(fp);
  }

  let shortMsg = 0;
  let bodyAlreadyNormalized = 0;
  let trulyPending = 0;
  const pendingSamples = [];
  const shortSamples = [];

  for (const r of pending) {
    const len = Number(r.len || 0);
    if (len < 40) {
      shortMsg += 1;
      if (shortSamples.length < 5) {
        shortSamples.push({ id: r.id, sender: r.sender, text: String(r.message || '').slice(0, 60) });
      }
      continue;
    }
    const fp = messageContentFingerprint(r.message);
    if (fp && coveredFp.has(fp)) {
      bodyAlreadyNormalized += 1;
      continue;
    }
    trulyPending += 1;
    if (pendingSamples.length < 8) {
      pendingSamples.push({
        id: r.id,
        sender: r.sender,
        created_at: r.created_at,
        timestamp: r.timestamp,
        text: String(r.message || '').slice(0, 90)
      });
    }
  }

  // Claims / job status
  const claims = await db.query(
    `SELECT COUNT(*)::int AS active_claims
     FROM normalize_claims c
     JOIN whatsapp_messages m ON m.id = c.whatsapp_message_id
     WHERE m.user_id = $1`,
    [userId]
  );
  const job = await db.query(
    `SELECT status, model_used, processed_this_run, started_at, finished_at, last_error, updated_at
     FROM normalize_jobs WHERE user_id = $1`,
    [userId]
  ).catch(() => ({ rows: [] }));

  // Newest/oldest truly-pending ids already in samples; get date range of all pending
  const dates = await db.query(
    `SELECT MIN(m.created_at) AS oldest_unnorm, MAX(m.created_at) AS newest_unnorm
     FROM whatsapp_messages m
     WHERE m.user_id = $1
       AND NOT EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id)`,
    [userId]
  );

  console.log(
    JSON.stringify(
      {
        userId,
        total_unnormalized: pending.length,
        breakdown: {
          short_under_40_chars: shortMsg,
          same_body_already_normalized_elsewhere: bodyAlreadyNormalized,
          truly_still_pending_to_process: trulyPending
        },
        active_claims: claims.rows[0]?.active_claims ?? null,
        normalize_job: job.rows[0] || null,
        unnormalized_date_range: dates.rows[0],
        short_samples: shortSamples,
        truly_pending_samples: pendingSamples
      },
      null,
      2
    )
  );
  console.log('ZZ_DONE');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
