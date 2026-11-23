/**
 * Extract v2: ONE structured-output LLM call per message -> rows for normalized_messages.
 *
 *   extractMessage(msg, opts)  -> raw model output (validated)
 *   buildRows(extraction, ctx) -> rows ready for persist.saveMessageRows()
 *
 * Provider: OpenAI gpt-4o-mini only. Nothing else normalizes the message.
 */
const {
  EXTRACT_VERSION,
  SYSTEM_PROMPT,
  EXTRACTION_SCHEMA,
  toGeminiSchema,
  buildUserMessage
} = require('./schema');
const { cleanText, parsePrice, parsePhase, detectBasis, SQFT_PER } = require('./parsers');
const { looksLikeRequirement } = require('./listingKind');
const { applyBtkListing } = require('../btkPrecincts');
const {
  recordOpenAiHit,
  countHitsForMessage,
  maxHitsPerMessage
} = require('./openaiHitCounter');

let userListingFingerprint = null;
let normalizePkMobile = (p) => p || null;
try { ({ userListingFingerprint } = require('../../contentFingerprint')); } catch (_) { /* optional */ }
try { ({ normalizePkMobile } = require('../listingSplitter')); } catch (_) { /* optional */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

/** GEMINI_API_KEYS (comma) and/or GEMINI_API_KEY / GEMINI_API_KEY_1..N */
function loadGeminiKeys() {
  const keys = csv(process.env.GEMINI_API_KEYS);
  if (process.env.GEMINI_API_KEY) keys.push(String(process.env.GEMINI_API_KEY).trim());
  for (let i = 1; i <= 50; i += 1) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k) keys.push(String(k).trim());
  }
  return [...new Set(keys.filter(Boolean))];
}

function parseJsonFromLlm(text) {
  let s = String(text || '').trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

function isGeminiQuotaError(err) {
  const m = String(err?.message || '');
  return /gemini 429/i.test(m) && /quota|exceeded your current quota/i.test(m);
}

/* ------------------------------------------------------------ model adapters */

let keyCursor = 0;
async function callGemini({ system, user, model }) {
  const keys = loadGeminiKeys();
  if (!keys.length) throw new Error('GEMINI_API_KEYS not set');
  let lastErr;
  for (let attempt = 0; attempt < Math.max(4, keys.length * 2); attempt += 1) {
    const key = keys[keyCursor % keys.length];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(EXTRACTION_SCHEMA),
          maxOutputTokens: 8192
        }
      })
    });
    if (res.ok) {
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      if (!text) throw new Error('gemini: empty response');
      return JSON.parse(text);
    }
    const body = await res.text();
    lastErr = new Error(`gemini ${res.status}: ${body.slice(0, 200)}`);
    if (res.status === 429 || res.status >= 500) {
      keyCursor += 1; // rotate key (never log the key itself)
      const quotaDead = /exceeded your current quota|quota exceeded/i.test(body);
      // After one full pass of keys all hit daily quota, stop — waiting won't help today
      if (quotaDead && attempt + 1 >= keys.length) throw lastErr;
      const retrySec = Number((body.match(/retry in ([\d.]+)s/i) || [])[1]) || 0;
      const fullCycle = attempt > 0 && attempt % keys.length === 0;
      const waitMs = quotaDead
        ? 200
        : Math.max(retrySec * 1000, fullCycle ? 8000 : 600, 400 * (attempt + 1));
      console.warn(
        `[extract] gemini ${res.status}; rotating key slot ${keyCursor % keys.length}/${keys.length}; wait ${Math.round(waitMs)}ms`
      );
      await sleep(waitMs);
      continue;
    }
    throw lastErr; // 400/401/403: not retryable
  }
  throw lastErr;
}

async function callAnthropic({ system, user, model }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: user }],
        tools: [{ name: 'save_extraction', description: 'Save the extracted listings.', input_schema: EXTRACTION_SCHEMA }],
        tool_choice: { type: 'tool', name: 'save_extraction' }
      })
    });
    if (res.ok) {
      const data = await res.json();
      const block = (data.content || []).find((b) => b.type === 'tool_use');
      if (!block) throw new Error('anthropic: no tool_use block');
      return block.input;
    }
    const body = await res.text();
    lastErr = new Error(`anthropic ${res.status}: ${body.slice(0, 200)}`);
    if (res.status === 429 || res.status >= 500 || res.status === 529) {
      await sleep(600 * (attempt + 1));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

/** OpenAI-compatible chat completions. Exactly one HTTP attempt per message (no retries). */
async function callOpenAiCompatible({
  system,
  user,
  model,
  apiKey,
  baseUrl,
  label,
  messageId = null,
  userId = null
}) {
  if (!apiKey) throw new Error(`${label}: API key not set`);
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error(`${label}: base URL not set`);
  if (!model) throw new Error(`${label}: model not set`);

  if (label === 'openai' && messageId != null) {
    const prior = await countHitsForMessage(messageId);
    const maxHits = maxHitsPerMessage();
    if (prior >= maxHits) {
      const err = new Error(`${label} hit_cap: message ${messageId} already has ${prior} hit(s)`);
      err.hitCap = true;
      throw err;
    }
  }

  const schemaNote =
    'Return one JSON object only (no markdown). Schema:\n' + JSON.stringify(EXTRACTION_SCHEMA);
  // Prefer params that work on current OpenAI models; one request only (no retry storm).
  const body = {
    model,
    max_completion_tokens: 8192,
    messages: [
      { role: 'system', content: `${system}\n\n${schemaNote}` },
      { role: 'user', content: user }
    ],
    response_format: { type: 'json_object' }
  };
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  if (label === 'openai') {
    await recordOpenAiHit({
      messageId,
      userId,
      model,
      ok: Boolean(res.ok),
      httpStatus: res.status,
      attempt: 1
    });
  }
  if (res.ok) {
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error(`${label}: empty response`);
    return parseJsonFromLlm(text);
  }
  const errBody = await res.text();
  throw new Error(`${label} ${res.status}: ${errBody.slice(0, 200)}`);
}

/** Together.ai (OpenAI-compatible). Uses LLM_BASE_URL + LLM_API_KEY from .env. */
async function callTogether({ system, user, model }) {
  return callOpenAiCompatible({
    system,
    user,
    model: model || process.env.NORMALIZE_MODEL || process.env.DEFAULT_MODEL,
    apiKey: process.env.LLM_API_KEY,
    baseUrl: process.env.LLM_BASE_URL || 'https://api.together.ai/v1',
    label: 'together'
  });
}

/** OpenAI official API. Uses OPENAI_API_KEY (+ optional OPENAI_BASE_URL). */
async function callOpenAI({ system, user, model, messageId = null, userId = null }) {
  return callOpenAiCompatible({
    system,
    user,
    model:
      model ||
      process.env.OPENAI_MODEL ||
      (process.env.EXTRACT_MODEL && !/^gemini|^qwen/i.test(process.env.EXTRACT_MODEL)
        ? process.env.EXTRACT_MODEL
        : null) ||
      'gpt-5-nano',
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    label: 'openai',
    messageId,
    userId
  });
}

/** Live normalize uses OpenAI only. */
const LLM_PROVIDERS = ['openai'];

function callForProvider(provider) {
  const p = String(provider || 'openai').toLowerCase();
  if (p === 'openai') return callOpenAI;
  throw new Error(`extract provider ${p} is disabled; OpenAI gpt-4o-mini only`);
}

function resolveModelName(provider) {
  const p = String(provider || process.env.EXTRACT_PROVIDER || 'openai').toLowerCase();
  if (p !== 'openai' && p !== 'test') {
    return process.env.OPENAI_MODEL || 'gpt-5-nano';
  }
  const explicit = process.env.EXTRACT_MODEL || '';
  if (explicit && /^gpt-/i.test(explicit)) return explicit;
  return process.env.OPENAI_MODEL || 'gpt-5-nano';
}

/* -------------------------------------------------------------- extraction */

function validate(out) {
  if (!out || typeof out !== 'object') throw new Error('extraction: not an object');
  const listings = Array.isArray(out.listings) ? out.listings.filter((l) => l && typeof l === 'object') : [];
  const isProperty = out.is_property_listing_or_inquiry != null
    ? Boolean(out.is_property_listing_or_inquiry)
    : Boolean(out.is_property);
  return {
    is_property: isProperty,
    language: out.language || null,
    listings: listings.slice(0, 15),
    summary: typeof out.summary === 'string' ? out.summary : '',
    category: out.category || null,
    intent: typeof out.intent === 'string' ? out.intent : '',
    sentiment: out.sentiment || null,
    purpose: out.purpose || null,
    property_type: out.property_type || null,
    property_sub_type: out.property_sub_type || null,
    city: out.city || null,
    area: out.area || null,
    vicinity: out.vicinity || null,
    size: out.size || null,
    size_value: out.size_value,
    size_unit: out.size_unit || null,
    price: out.price || null,
    price_value: out.price_value,
    contact_number: out.contact_number || null,
    entities: out.entities && typeof out.entities === 'object' ? out.entities : null,
    confidence_score: out.confidence_score
  };
}

/**
 * @param {{message:string, sender?:string}} msg
 * @param {{callModel?:Function, model?:string}} [opts]
 */
async function extractMessage(msg, opts = {}) {
  const text = cleanText(msg.message);
  const chain = opts.callModel
    ? [{ provider: 'test', call: opts.callModel }]
    : LLM_PROVIDERS.map((provider) => ({ provider, call: callForProvider(provider) }));

  const user = buildUserMessage(text.slice(0, 12000), { sender: msg.sender });
  let lastErr;
  let firstErr = null;
  for (let i = 0; i < chain.length; i += 1) {
    const { provider, call } = chain[i];
    const model = opts.model || resolveModelName(provider);
    if (!model) throw new Error(`Set EXTRACT_MODEL (provider=${provider})`);
    try {
      const raw = await call({
        system: SYSTEM_PROMPT,
        user,
        model,
        messageId: msg.id != null ? msg.id : msg.messageId,
        userId: msg.user_id != null ? msg.user_id : msg.userId
      });
      if (i > 0) {
        console.warn(`[extract] used fallback provider ${provider} after ${chain[0].provider} failed`);
      }
      return { extraction: validate(raw), model, provider, cleanedText: text };
    } catch (err) {
      if (!firstErr) firstErr = err;
      lastErr = err;
      const canFallback = i < chain.length - 1;
      if (canFallback) {
        console.warn(`[extract] ${chain[i].provider} failed (${String(err.message).slice(0, 120)}); trying ${chain[i + 1].provider}`);
        continue;
      }
      if (firstErr && firstErr !== lastErr) {
        const combo = new Error(String(lastErr.message));
        combo.primaryError = firstErr;
        throw combo;
      }
      throw err;
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------- row builder */

const UNIT_LABEL = { SQ_YD: 'Sq. Yd.', SQ_FT: 'Sq. Ft.', SQ_M: 'Sq. M.', MARLA: 'Marla', KANAL: 'Kanal', ACRE: 'Acre' };
const UNIT_CODE = {
  SQ_YD: 'SQ_YD', SQ_FT: 'SQ_FT', SQ_M: 'SQ_M', MARLA: 'MARLA', KANAL: 'KANAL', ACRE: 'ACRE',
  'SQ. YD.': 'SQ_YD', 'SQ. FT.': 'SQ_FT', 'SQ. M.': 'SQ_M'
};
const LANG = { en: 'en', ur: 'ur', roman_ur: 'hinglish', mixed: 'hinglish' };
const PRICE_BASIS = new Set(['TOTAL', 'PER_MONTH', 'PER_SQ_YD', 'PER_SQ_FT', 'PER_FLOOR', 'ON_CALL', 'UNKNOWN']);
const CATEGORY_SET = new Set(['INQUIRY', 'SUPPORT', 'SALES', 'COMPLAINT', 'GENERAL', 'SPAM']);
const SENTIMENT_SET = new Set(['POSITIVE', 'NEUTRAL', 'NEGATIVE']);

function mapLanguage(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'en';
  if (LANG[s]) return LANG[s];
  if (s === 'urdu') return 'ur';
  if (s === 'english') return 'en';
  if (s === 'hinglish' || s === 'roman urdu' || s === 'roman-urdu') return 'hinglish';
  return s.slice(0, 32);
}

function unitCode(raw) {
  const key = String(raw || '').trim().toUpperCase();
  return UNIT_CODE[key] || null;
}

function entityBag(raw, extraName) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const list = (key) => (Array.isArray(src[key]) ? src[key].map((x) => textOrNull(x)).filter(Boolean) : []);
  const names = list('names');
  const extra = textOrNull(extraName);
  if (extra && !names.some((n) => n.toLowerCase() === extra.toLowerCase())) names.push(extra);
  return {
    products: list('products'),
    dates_mentioned: list('dates_mentioned'),
    action_items: list('action_items'),
    names
  };
}

function textOrNull(value) {
  const s = cleanText(value || '');
  return s || null;
}

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function phaseOrNull(value) {
  const n = numOrNull(value);
  if (n == null) return null;
  const phase = Math.trunc(n);
  return phase >= 1 && phase <= 20 ? phase : null;
}

function phaseRangeFromText(text) {
  const match = String(text || '').match(
    /\bphase\s*(\d{1,2})\s*(?:to|-|–|—)\s*(?:phase\s*)?(\d{1,2})\b/i
  );
  if (!match) return null;
  let first = Number(match[1]);
  let last = Number(match[2]);
  if (!first || !last || first > 20 || last > 20) return null;
  if (first > last) [first, last] = [last, first];
  return { phase: first, phaseMax: last };
}

function knownPlacePhase(text) {
  const blob = String(text || '');
  if (/\b(?:a|b)\s*market\b/i.test(blob)) return 2;
  if (/\bzone\s*[a-e]\b/i.test(blob) || /\bd[\s-]*cutting\b/i.test(blob) || /\bara[f]?at\b/i.test(blob)) {
    return 8;
  }
  return null;
}

function withPhaseTags(tags, from, to) {
  const seen = new Set((tags || []).map((tag) => String(tag).toLowerCase()));
  const out = Array.isArray(tags) ? tags.slice() : [];
  const start = Number(from);
  const end = Number(to || from);
  if (!start) return out.length ? out : null;
  for (let n = start; n <= end; n += 1) {
    const label = `Phase ${n}`;
    if (seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push(label);
  }
  return out.length ? out : null;
}

function tagsFromLlm(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const tags = [];
  for (const raw of value) {
    const t = textOrNull(raw);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(t);
    if (tags.length >= 40) break;
  }
  return tags.length ? tags : null;
}

/**
 * Save the LLM listing as the search row. No gazetteer, no phase rewrite.
 * @param {{is_property:boolean,language:string|null,listings:object[]}} extraction
 * @param {object} ctx { messageId, chatJid, sender, senderPhone, messageText, userId, model }
 */
function buildRows(extraction, ctx) {
  const rows = [];
  const messageText = cleanText(ctx.messageText);
  const language = mapLanguage(extraction.language);
  const modelCategory = CATEGORY_SET.has(String(extraction.category || '').toUpperCase())
    ? String(extraction.category).toUpperCase()
    : null;
  const sentiment = SENTIMENT_SET.has(String(extraction.sentiment || '').toUpperCase())
    ? String(extraction.sentiment).toUpperCase()
    : 'NEUTRAL';
  const intent = typeof extraction.intent === 'string' ? extraction.intent : '';

  let listings = Array.isArray(extraction.listings)
    ? extraction.listings.filter((l) => l && typeof l === 'object')
    : [];
  if (!listings.length && extraction.is_property) {
    listings = [{
      purpose: extraction.purpose,
      property_type: extraction.property_type,
      property_sub_type: extraction.property_sub_type,
      city: extraction.city,
      area: extraction.area,
      vicinity: extraction.vicinity,
      size: extraction.size,
      size_value: extraction.size_value,
      size_unit: extraction.size_unit,
      price: extraction.price,
      price_value: extraction.price_value,
      contact_number: extraction.contact_number,
      summary: extraction.summary,
      listing_excerpt: null
    }];
  }

  listings.forEach((l, idx) => {
    const purpose = l.purpose === 'SALE' || l.purpose === 'RENT' ? l.purpose : null;
    const city = textOrNull(l.city);
    const area = textOrNull(l.area);
    const vicinity = textOrNull(l.vicinity);
    const locationText = textOrNull(l.location_text);
    const streetText = textOrNull(l.street_text);
    const excerpt = textOrNull(l.listing_excerpt);
    const range = phaseRangeFromText(`${excerpt || ''} ${textOrNull(l.vicinity) || ''} ${textOrNull(l.summary) || ''}`);
    let phase = phaseOrNull(l.phase) || (range && range.phase) || null;
    let phaseMax = phaseOrNull(l.phase_max) || (range && range.phaseMax) || null;
    if (phaseMax && phase && phaseMax < phase) [phase, phaseMax] = [phaseMax, phase];
    if (phaseMax && phase && phaseMax === phase) phaseMax = null;
    const known = knownPlacePhase(`${excerpt || ''} ${textOrNull(l.area) || ''} ${textOrNull(l.vicinity) || ''} ${textOrNull(l.location_text) || ''}`);
    if (phase == null && known) phase = known;
    const sizeValue = numOrNull(l.size_value);
    const code = unitCode(l.size_unit);
    const sizeUnit = code && UNIT_LABEL[code] ? UNIT_LABEL[code] : textOrNull(l.size_unit);
    let sizeSqft = numOrNull(l.size_sqft);
    if (sizeSqft == null && sizeValue != null && code && SQFT_PER[code]) {
      sizeSqft = Math.round(sizeValue * SQFT_PER[code] * 100) / 100;
    }
    let priceValue = numOrNull(l.price_value);
    let priceText = textOrNull(l.price);
    let priceMin = numOrNull(l.price_min);
    let priceMax = numOrNull(l.price_max);
    let priceBasis = PRICE_BASIS.has(l.price_basis) ? l.price_basis : null;
    if (priceValue == null && /@\s*\d/.test(`${excerpt || ''} ${priceText || ''} ${ctx.messageText || ''}`)) {
      const parsedAt = parsePrice(excerpt || priceText || ctx.messageText, { purpose });
      if (parsedAt.value) {
        priceValue = parsedAt.value;
        priceText = priceText || ((excerpt || '').match(/@\s*\d+(?:\.\d+)?(?:\s*(?:cr|crore|lac|lakh))?/i) || [])[0] || null;
        if (priceMin == null) priceMin = parsedAt.min;
        if (priceMax == null) priceMax = parsedAt.max;
        if (!priceBasis && PRICE_BASIS.has(parsedAt.basis)) priceBasis = parsedAt.basis;
      }
    }
    if (priceValue == null && priceText) {
      const parsed = parsePrice(priceText, { purpose });
      if (parsed.value != null) {
        priceValue = parsed.value;
        if (priceMin == null) priceMin = parsed.min;
        if (priceMax == null) priceMax = parsed.max;
        if (!priceBasis && PRICE_BASIS.has(parsed.basis)) priceBasis = parsed.basis;
      }
    }
    if (!priceBasis && priceText) {
      const detected = detectBasis(priceText);
      if (detected) priceBasis = detected;
    }
    const rawTags = tagsFromLlm(l.place_tags);
    const hasCore = Boolean(
      l.property_type || sizeValue != null || priceValue != null
      || area || vicinity || locationText || streetText || rawTags
    );
    if (phase == null && hasCore) {
      const parsedPhase = parsePhase([vicinity, area, excerpt, textOrNull(l.summary)].filter(Boolean).join(' '));
      if (parsedPhase.phase) phase = parsedPhase.phase;
    }
    const placeTags = withPhaseTags(rawTags, phase, phaseMax);
    const requirement = looksLikeRequirement(l.kind, excerpt);
    const hasSubstance = hasCore || phase != null;
    if (!hasSubstance) return;

    const listedPhones = Array.isArray(l.contact_numbers) && l.contact_numbers.length
      ? l.contact_numbers.join(', ')
      : null;
    const fromListing = Number(l.confidence);
    const fromTop = Number(extraction.confidence_score);
    const confidence = Number.isFinite(fromListing) ? fromListing : (Number.isFinite(fromTop) ? fromTop : null);

    const row = {
      whatsapp_message_id: ctx.messageId,
      chat_jid: ctx.chatJid,
      sender: ctx.sender,
      category: modelCategory || (requirement ? 'INQUIRY' : 'SALES'),
      intent,
      sentiment,
      language,
      summary: textOrNull(l.summary) || (listings.length === 1 ? textOrNull(extraction.summary) : null),
      entities: JSON.stringify(entityBag(extraction.entities, l.agent_name)),
      city,
      city_source: city ? 'llm' : null,
      is_property: true,
      listing_kind: requirement ? 'REQUIREMENT' : 'OFFER',
      purpose,
      property_type: l.property_type || null,
      property_sub_type: textOrNull(l.property_sub_type),
      area,
      society_key: null,
      vicinity,
      phase,
      phase_max: phaseMax,
      place_tags: placeTags,
      location_text: locationText,
      street_text: streetText,
      size: textOrNull(l.size),
      size_value: sizeValue,
      size_unit: sizeUnit,
      size_sqft: sizeSqft,
      price: priceText,
      price_value: priceValue,
      price_min: priceMin,
      price_max: priceMax,
      price_basis: priceBasis,
      price_inferred: false,
      price_flagged: Boolean(l.price_flagged),
      price_flag_reason: textOrNull(l.price_flag_reason),
      contact_number:
        textOrNull(l.contact_number) ||
        listedPhones ||
        textOrNull(extraction.contact_number) ||
        normalizePkMobile(ctx.senderPhone) || ctx.senderPhone || null,
      confidence_score: confidence,
      model_used: 'extract-v2',
      listing_index: idx,
      listing_excerpt: excerpt ? excerpt.slice(0, 2000) : null,
      needs_review: Boolean(l.price_flagged),
      extract_version: EXTRACT_VERSION,
      extract_trace: JSON.stringify({
        model: ctx.model,
        place_tag_count: placeTags ? placeTags.length : 0,
        llm: l
      })
    };
    applyBtkListing(row, `${excerpt || ''} ${ctx.messageText || ''}`);
    row.content_fingerprint = userListingFingerprint
      ? userListingFingerprint(ctx.userId == null ? 1 : Number(ctx.userId), {
          listing_excerpt: row.listing_excerpt,
          summary: row.summary,
          purpose: row.purpose,
          rawMessage: ctx.messageText || '',
          contact_number: row.contact_number
        })
      : null;
    rows.push(row);
  });

  // Not a property (or the model returned nothing usable): one stub row so the
  // message is never re-queued as "pending".
  if (!rows.length) {
    rows.push({
      whatsapp_message_id: ctx.messageId, chat_jid: ctx.chatJid, sender: ctx.sender,
      category: modelCategory || 'GENERAL', intent, sentiment, language,
      summary: textOrNull(extraction.summary) || messageText.slice(0, 160),
      entities: extraction.entities ? JSON.stringify(entityBag(extraction.entities)) : '{}',
      city: null, city_source: null,
      is_property: false, listing_kind: null, purpose: null, property_type: null, property_sub_type: null,
      area: null, society_key: null, vicinity: null, phase: null, location_text: null, street_text: null,
      size: null, size_value: null, size_unit: null, size_sqft: null,
      price: null, price_value: null, price_min: null, price_max: null, price_basis: null, price_inferred: false,
      contact_number: null, confidence_score: null, model_used: 'extract-v2', listing_index: 0,
      listing_excerpt: null, content_fingerprint: null,
      needs_review: extraction.is_property, // model said "property" but nothing usable came out
      extract_version: EXTRACT_VERSION,
      extract_trace: JSON.stringify({ model: ctx.model, warnings: extraction.is_property ? ['property_without_listings'] : [] })
    });
  }
  return rows;
}

module.exports = {
  extractMessage,
  buildRows,
  looksLikeRequirement,
  callGemini,
  callAnthropic,
  callTogether,
  callOpenAI,
  parseJsonFromLlm,
  LLM_PROVIDERS
};
