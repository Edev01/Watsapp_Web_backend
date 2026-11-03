#!/usr/bin/env node
/**
 * Re-extract Danish's non-Karachi property messages with OpenAI only.
 * Preview: node scripts/renormalize_non_karachi.js
 * Apply/resume: node scripts/renormalize_non_karachi.js --apply --run-dir /tmp/city-repair
 * The private run directory contains the original rows/references, cached model
 * responses, and per-message completion records. Keep it to audit or resume.
 * Existing card IDs, comments, favourites, statuses and dates are preserved.
 * This one-off does not change or restart the live normalization worker.
 */
const fs = require('node:fs');
const path = require('node:path');
const USER_ID = 4;
const SELECT_SQL = `
SELECT m.id, m.user_id, m.chat_jid, m.sender, m.sender_phone, m.message
  FROM whatsapp_messages m
 WHERE m.user_id = $1
   AND EXISTS (
     SELECT 1 FROM normalized_messages n
      WHERE n.whatsapp_message_id = m.id AND n.is_property
        AND n.city IS NOT NULL AND btrim(n.city) <> '' AND n.city !~* 'karachi'
   )
 ORDER BY m.id`;

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function getOptions(argv) {
  let apply = false;
  let runDir;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') apply = true;
    else if (argv[i] === '--run-dir' && argv[i + 1] && !argv[i + 1].startsWith('--')) runDir = path.resolve(argv[++i]);
    else throw new Error(`Unknown or incomplete option: ${argv[i]}`);
  }
  if (apply && !runDir) throw new Error('--apply requires --run-dir so the run can be resumed');
  return { apply, runDir };
}

async function makeSnapshot(db, model) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const jobs = (await client.query(SELECT_SQL, [USER_ID])).rows;
    const ids = jobs.map(job => job.id);
    const oldRows = (await client.query(
      'SELECT * FROM normalized_messages WHERE whatsapp_message_id = ANY($1::int[]) ORDER BY whatsapp_message_id, listing_index, id', [ids]
    )).rows;
    const cardIds = oldRows.map(row => row.id);
    const favourites = (await client.query('SELECT * FROM property_favourites WHERE property_id = ANY($1::int[]) ORDER BY id', [cardIds])).rows;
    const comments = (await client.query('SELECT * FROM property_comments WHERE property_id = ANY($1::int[]) ORDER BY id', [cardIds])).rows;
    await client.query('COMMIT');
    return {
      version: 1, userId: USER_ID, model, createdAt: new Date().toISOString(),
      jobs: jobs.map(job => ({ ...job, oldRows: oldRows.filter(row => row.whatsapp_message_id === job.id) })),
      favourites, comments
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function acquireLock(runDir) {
  const file = path.join(runDir, 'running.pid');
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid run lock: ${file}`);
    try {
      process.kill(pid, 0);
      throw new Error(`Run already active (pid ${pid})`);
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
      fs.unlinkSync(file);
    }
  }
  fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
  return () => fs.unlinkSync(file);
}

async function run(db, options) {
  const { extractMessage, buildRows, callOpenAI } = require('../ai/extract/extractor');
  const { saveRows } = require('./renormalize_city_persist');
  const explicit = process.env.EXTRACT_MODEL || '';
  const configuredModel = /^gpt-/i.test(explicit) ? explicit : process.env.OPENAI_MODEL || 'gpt-4o-mini';
  if (!options.apply) {
    const snapshot = await makeSnapshot(db, configuredModel);
    console.log(`PREVIEW messages=${snapshot.jobs.length} cards=${snapshot.jobs.reduce((n, job) => n + job.oldRows.length, 0)} user=${USER_ID} model=${snapshot.model}`);
    return;
  }
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  fs.mkdirSync(options.runDir, { recursive: true, mode: 0o700 });
  const unlock = acquireLock(options.runDir);
  try {
    const snapshotPath = path.join(options.runDir, 'before.json');
    let snapshot = readJson(snapshotPath);
    if (!snapshot) {
      snapshot = await makeSnapshot(db, configuredModel);
      writeJson(snapshotPath, snapshot);
    }
    if (snapshot.version !== 1 || snapshot.userId !== USER_ID) throw new Error('Incompatible run snapshot');
    // Optional human-reviewed exceptions, scoped to message IDs in this snapshot.
    // Keep their extractions separate so the first model response remains auditable.
    const reviewed = readJson(path.join(options.runDir, 'reviewed.json')) || {};
    for (const id of Object.keys(reviewed)) {
      if (!snapshot.jobs.some(job => String(job.id) === id)) throw new Error(`Review is outside the saved cohort: ${id}`);
    }
    console.log(`POOL messages=${snapshot.jobs.length} user=${USER_ID} model=openai/${snapshot.model} backup=${snapshotPath}`);
    let ok = 0;
    let failed = 0;
    let consecutiveFails = 0;
    let stopReason = 'finished';
    const failures = [];
    for (const job of snapshot.jobs) {
      const donePath = path.join(options.runDir, `${job.id}.done.json`);
      if (readJson(donePath)) {
        ok += 1;
        console.log(`SKIP id=${job.id} already_completed`);
        continue;
      }
      try {
        const review = reviewed[job.id];
        const extractionPath = path.join(options.runDir, `${job.id}${review ? '.reviewed' : ''}.extraction.json`);
        let result = readJson(extractionPath);
        if (!result) {
          result = await extractMessage({ message: job.message, sender: job.sender }, {
            model: snapshot.model,
            callModel: args => callOpenAI({
              ...args, model: snapshot.model,
              system: review?.extractionInstructions
                ? `${args.system}\n\nReview of this message:\n${review.extractionInstructions}`
                : args.system
            })
          });
          writeJson(extractionPath, result);
        }
        const rows = buildRows(result.extraction, {
          messageId: job.id, chatJid: job.chat_jid, sender: job.sender,
          senderPhone: job.sender_phone, messageText: job.message,
          userId: job.user_id, model: snapshot.model
        });
        if (!result.extraction.is_property || !rows.length || rows.some(row => !row.is_property)) {
          throw new Error('No usable property extraction; existing cards retained');
        }
        for (const row of rows) row.model_used = `openai/${snapshot.model}`;
        const saved = await saveRows(db, job, job.oldRows, rows, {
          allowLegacyAggregateSplit: review?.allowLegacyAggregateSplit === true
        });
        const done = { messageId: job.id, model: `openai/${snapshot.model}`, cities: rows.map(row => row.city), ...saved, finishedAt: new Date().toISOString() };
        writeJson(donePath, done);
        ok += 1;
        consecutiveFails = 0;
        console.log(`OK id=${job.id} updated=${saved.updated} inserted=${saved.inserted} cities=${JSON.stringify(done.cities)}`);
      } catch (err) {
        failed += 1;
        consecutiveFails += 1;
        const failure = { messageId: job.id, reason: String(err.message || err).slice(0, 300) };
        failures.push(failure);
        console.error(`FAIL id=${job.id} ${failure.reason}`);
        if (/no credits remaining|insufficient_quota|insufficient.*quota|billing_hard_limit/i.test(failure.reason)) {
          stopReason = 'openai_quota';
          console.error('STOP OpenAI credits exhausted; fund the API account before resuming');
          break;
        }
        if (consecutiveFails >= 5) {
          stopReason = 'consecutive_failures';
          console.error('STOP five consecutive failures; originals retained for failed messages');
          break;
        }
      }
    }
    const summary = {
      userId: USER_ID, model: `openai/${snapshot.model}`, total: snapshot.jobs.length,
      ok, failed, remaining: snapshot.jobs.length - ok, stopReason, failures, finishedAt: new Date().toISOString()
    };
    writeJson(path.join(options.runDir, 'summary.json'), summary);
    console.log('DONE', JSON.stringify(summary));
    if (summary.remaining) process.exitCode = 1;
    return summary;
  } finally {
    unlock();
  }
}

if (require.main === module) {
  require('dotenv').config();
  const db = require('../db');
  Promise.resolve().then(() => run(db, getOptions(process.argv.slice(2))))
    .catch(err => { console.error(err.message); process.exitCode = 1; })
    .finally(() => db.pool.end());
}

module.exports = { SELECT_SQL, getOptions, makeSnapshot, run };
