#!/usr/bin/env node
/**
 * Force-normalize specific whatsapp_messages ids (uses multi-offer chunk split).
 * Usage: node scripts/normalize_message_ids.js 1845 1853
 */
require('dotenv').config();
const db = require('../db');
const { LLMClient, expandListingSchemas } = require('../ai/llmClient');
const { splitPropertyOffers, extractSharedContacts } = require('../ai/listingSplitter');
const { getConfig } = require('../ai/config');

async function saveNormalized(job, schema, targetModel) {
  const listingRows = expandListingSchemas(schema);
  if (!listingRows.length) return 0;
  await db.query(
    `DELETE FROM normalized_messages WHERE whatsapp_message_id = $1 AND model_used = $2`,
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
         $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,NOW()
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
        JSON.stringify(row.entities || {}),
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

async function normalizeJob(job, llm, model) {
  const sharedContact = extractSharedContacts(job.message);
  const chunks = splitPropertyOffers(job.message);
  console.log('message', job.id, 'chunks', chunks.length);

  if (chunks.length >= 2) {
    const listingSchemas = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const result = await llm.normalizeMessage(chunk, job.sender, model);
      if (!result.isValid || !result.schema) {
        console.warn('chunk fail', i, (result.errorReason || '').slice(0, 100));
        continue;
      }
      for (const row of expandListingSchemas(result.schema)) {
        row.listing_excerpt = chunk.slice(0, 2000);
        row.listing_index = listingSchemas.length;
        if (!row.contact_number && sharedContact) row.contact_number = sharedContact;
        row.is_property_listing_or_inquiry = true;
        listingSchemas.push(row);
      }
    }
    if (!listingSchemas.length) return 0;
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
    return saveNormalized(job, envelope, model);
  }

  const result = await llm.normalizeMessage(job.message, job.sender, model);
  if (!result.isValid) {
    console.log('FAIL', job.id, result.errorReason);
    return 0;
  }
  if (sharedContact && !result.schema.contact_number) {
    result.schema.contact_number = sharedContact;
  }
  return saveNormalized(job, result.schema, model);
}

(async () => {
  const ids = process.argv.slice(2).map(Number).filter(Boolean);
  if (!ids.length) {
    console.error('Usage: node scripts/normalize_message_ids.js <id> [id...]');
    process.exit(1);
  }
  const { rows } = await db.query(
    `SELECT id, user_id, chat_jid, sender, message FROM whatsapp_messages WHERE id = ANY($1)`,
    [ids]
  );
  const llm = new LLMClient();
  const model = llm.defaultModel || getConfig().defaultModel;
  for (const job of rows) {
    const saved = await normalizeJob(job, llm, model);
    console.log('OK', job.id, 'listings', saved);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
