#!/usr/bin/env node
/**
 * Normalize specific whatsapp_messages ids: raw text → LLM → saved fields.
 * Usage: node scripts/normalize_message_ids.js 1845 1853
 */
require('dotenv').config();
const db = require('../db');
const { extractMessage, buildRows } = require('../ai/extract/extractor');
const { saveMessageRows } = require('../ai/extract/persist');
(async () => {
  const ids = process.argv.slice(2).map(Number).filter(Boolean);
  if (!ids.length) {
    console.error('Usage: node scripts/normalize_message_ids.js <id> [id...]');
    process.exit(1);
  }
  const { rows } = await db.query(
    `SELECT id, user_id, chat_jid, sender, sender_phone, message
     FROM whatsapp_messages WHERE id = ANY($1::int[])`,
    [ids]
  );
  for (const job of rows) {
    const { extraction, model, provider } = await extractMessage(job);
    const built = buildRows(extraction, {
      messageId: job.id,
      chatJid: job.chat_jid,
      sender: job.sender,
      senderPhone: job.sender_phone,
      messageText: job.message,
      userId: job.user_id,
      model
    });
    const saved = await saveMessageRows(db, job.id, built);
    const props = built.filter((r) => r.is_property).length;
    console.log('OK', job.id, provider, model, 'listings', props, 'inserted', saved.inserted);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
