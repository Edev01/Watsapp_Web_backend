#!/usr/bin/env node
/**
 * One-off. Re-split Danish messages that contain several offers, then set
 * each offer's phase from Google when the place is not the header phase.
 *
 *   node scripts/fix_danish_multi_phases.js
 *   node scripts/fix_danish_multi_phases.js --apply
 */
require('dotenv').config();
const fs = require('fs');
const db = require('../db');
const { extractMessage, buildRows, callOpenAI } = require('../ai/extract/extractor');
const { saveMessageRows } = require('../ai/extract/persist');
const { splitPropertyOffers } = require('../ai/listingSplitter');
const { areaKey, geocodePlace, correctSplitListingPhases } = require('../ai/googlePhaseMap');

const USER_ID = 4;
const DONE_FILE = process.env.MULTI_DONE_FILE || '/tmp/danish-multi-done.txt';

function loadDone() {
  try {
    return new Set(
      fs.readFileSync(DONE_FILE, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
    );
  } catch (_) {
    return new Set();
  }
}

function markDone(id) {
  fs.appendFileSync(DONE_FILE, `${id}\n`);
}

async function loadJobs() {
  const { rows } = await db.query(
    `SELECT m.id, m.user_id, m.chat_jid, m.sender, m.sender_phone, m.message
       FROM whatsapp_messages m
       JOIN normalized_messages n ON n.whatsapp_message_id = m.id AND n.is_property
      WHERE m.user_id = $1
        AND m.message IS NOT NULL
        AND length(btrim(m.message)) >= 20`,
    [USER_ID]
  );
  return rows.filter((row) => splitPropertyOffers(row.message).length >= 2);
}

function phaseLookup() {
  const cache = new Map();
  return async (place) => {
    const key = areaKey(place);
    if (cache.has(key)) return cache.get(key);
    const hit = await geocodePlace(place);
    const phase = hit && hit.phaseNumber ? hit.phaseNumber : null;
    cache.set(key, phase);
    return phase;
  };
}

async function remapRefs(oldIds, newId) {
  if (!oldIds.length || !newId) return;
  for (const oldId of oldIds) {
    if (Number(oldId) === Number(newId)) continue;
    try {
      await db.query(
        `UPDATE property_favourites SET property_id = $1 WHERE property_id = $2`,
        [newId, oldId]
      );
    } catch (err) {
      if (err.code !== '23505') throw err;
      await db.query(`DELETE FROM property_favourites WHERE property_id = $1`, [oldId]);
    }
    await db.query(
      `UPDATE property_comments SET property_id = $1 WHERE property_id = $2`,
      [newId, oldId]
    );
  }
}

async function normalizeOne(job, openaiModel, lookup) {
  const old = await db.query(
    `SELECT id FROM normalized_messages WHERE whatsapp_message_id = $1 ORDER BY id`,
    [job.id]
  );
  const { extraction, model } = await extractMessage(
    { message: job.message, sender: job.sender },
    {
      model: openaiModel,
      callModel: (args) => callOpenAI({ ...args, model: openaiModel })
    }
  );
  const built = buildRows(extraction, {
    messageId: job.id,
    chatJid: job.chat_jid,
    sender: job.sender,
    senderPhone: job.sender_phone,
    messageText: job.message,
    userId: job.user_id,
    model
  });
  await correctSplitListingPhases(built, lookup);
  const props = built.filter((row) => row.is_property);
  if (props.length < 2) {
    return { props: props.length, inserted: 0, phases: '', kept: true };
  }
  const saved = await saveMessageRows(db, job.id, built);
  const label = `openai/${model}`;
  await db.query(
    `UPDATE normalized_messages SET model_used = $2 WHERE whatsapp_message_id = $1`,
    [job.id, label]
  );
  const fresh = await db.query(
    `SELECT id FROM normalized_messages
      WHERE whatsapp_message_id = $1 AND is_property
      ORDER BY listing_index, id LIMIT 1`,
    [job.id]
  );
  await remapRefs(old.rows.map((row) => row.id), fresh.rows[0] && fresh.rows[0].id);
  return {
    props: props.length,
    inserted: saved.inserted,
    phases: props.map((row) => (row.phase == null ? '-' : String(row.phase))).join(','),
    kept: false
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const done = loadDone();
  const jobs = (await loadJobs()).filter((job) => !done.has(String(job.id)));
  console.log(`POOL ${jobs.length} already_done ${done.size} model=${openaiModel} apply=${apply}`);
  if (!apply) {
    process.exit(0);
  }
  const lookup = phaseLookup();
  for (const id of [12135, 3759]) {
    const { rows } = await db.query(
      `SELECT m.id, m.user_id, m.chat_jid, m.sender, m.sender_phone, m.message,
              bool_or(n.is_property) AS still_property
         FROM whatsapp_messages m
         LEFT JOIN normalized_messages n ON n.whatsapp_message_id = m.id
        WHERE m.id = $1
        GROUP BY m.id`,
      [id]
    );
    const job = rows[0];
    if (!job || job.still_property) continue;
    const { extraction, model } = await extractMessage(
      { message: job.message, sender: job.sender },
      { model: openaiModel, callModel: (args) => callOpenAI({ ...args, model: openaiModel }) }
    );
    const built = buildRows(extraction, {
      messageId: job.id,
      chatJid: job.chat_jid,
      sender: job.sender,
      senderPhone: job.sender_phone,
      messageText: job.message,
      userId: job.user_id,
      model
    });
    await correctSplitListingPhases(built, lookup);
    const props = built.filter((row) => row.is_property);
    if (!props.length) {
      console.log(`RESTORE_EMPTY ${id}`);
      continue;
    }
    await saveMessageRows(db, job.id, built);
    await db.query(
      `UPDATE normalized_messages SET model_used = $2 WHERE whatsapp_message_id = $1`,
      [job.id, `openai/${model}`]
    );
    console.log(`RESTORED ${id} listings=${props.length} phases=${props.map((row) => row.phase == null ? '-' : row.phase).join(',')}`);
  }
  let ok = 0;
  let failed = 0;
  let consecutiveFails = 0;
  for (const job of jobs) {
    try {
      const result = await normalizeOne(job, openaiModel, lookup);
      markDone(job.id);
      ok += 1;
      consecutiveFails = 0;
      if (result.kept) {
        console.log(`KEEP ${job.id} model returned ${result.props} listing(s); old card left in place`);
      } else {
        console.log(`OK ${job.id} listings=${result.props} phases=${result.phases} inserted=${result.inserted}`);
      }
    } catch (err) {
      failed += 1;
      consecutiveFails += 1;
      console.error(`FAIL ${job.id} ${String(err.message || err).slice(0, 180)}`);
      if (consecutiveFails >= 5) {
        console.error('STOP five failures in a row');
        break;
      }
    }
  }
  console.log(`DONE ok=${ok} failed=${failed} remaining=${jobs.length - ok - failed}`);
  process.exit(failed && ok === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
