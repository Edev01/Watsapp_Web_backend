const OpenAI = require('openai');
const { getConfig } = require('./config');
const { SYSTEM_PROMPT, CATEGORIES, SENTIMENTS } = require('./normalizePrompt');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err) {
  const status = err?.status || err?.response?.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('rate') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('fetch failed') ||
    msg.includes('529')
  );
}

function extractMessageText(response) {
  const msg = response?.choices?.[0]?.message || {};
  let content = msg.content;
  if (Array.isArray(content)) {
    content = content
      .map((part) => (typeof part === 'string' ? part : part?.text || part?.content || ''))
      .join('');
  }
  const text = String(content || msg.reasoning_content || msg.reasoning || '').trim();
  return text;
}

function stripThinkBlocks(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .trim();
}

function repairTruncatedJson(text) {
  let s = String(text || '').trim();
  if (!s) return s;
  let inString = false;
  let escape = false;
  let braces = 0;
  let brackets = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') braces += 1;
    else if (c === '}') braces -= 1;
    else if (c === '[') brackets += 1;
    else if (c === ']') brackets -= 1;
  }
  if (inString) s += '"';
  while (brackets > 0) {
    s += ']';
    brackets -= 1;
  }
  while (braces > 0) {
    s += '}';
    braces -= 1;
  }
  return s;
}

function cleanJsonResponse(text) {
  let out = stripThinkBlocks(text);
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) out = fence[1].trim();

  const start = out.indexOf('{');
  if (start !== -1) out = out.slice(start);

  const end = out.lastIndexOf('}');
  if (end !== -1) {
    out = out.slice(0, end + 1);
  } else {
    out = repairTruncatedJson(out);
  }

  out = out.replace(
    /("(?:size_value|price_value)"\s*:\s*)(\d+(?:\.\d+)?)\s*,\s*\d+(?:\.\d+)?/g,
    '$1$2'
  );
  return out;
}

function firstNumber(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const n = firstNumber(item);
      if (n != null) return n;
    }
    return null;
  }
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/,/g, '');
    const match = cleaned.match(/-?\d+(?:\.\d+)?/);
    if (match) {
      const n = Number.parseFloat(match[0]);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function coerceLlmDict(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }

  for (const key of ['summary', 'intent', 'language']) {
    if (data[key] == null) data[key] = '';
  }

  const purpose = data.purpose;
  if (typeof purpose === 'string') {
    const p = purpose.trim().toUpperCase();
    if (['BUY', 'SELL', 'SALE', 'FOR SALE', 'PURCHASE'].includes(p)) {
      data.purpose = 'SALE';
    } else if (['RENT', 'LEASE', 'FOR RENT', 'RENTAL'].includes(p)) {
      data.purpose = 'RENT';
    } else if (p === '' || p === 'NULL') {
      data.purpose = null;
    }
  }

  let ptype = data.property_type;
  if (typeof ptype === 'string' && (/[|,]/.test(ptype))) {
    data.property_type = ptype.split(/[|,]/)[0].trim() || null;
  } else if (Array.isArray(ptype) && ptype.length) {
    data.property_type = String(ptype[0]).trim();
  }

  let psubtype = data.property_sub_type;
  if (typeof psubtype === 'string' && (/[|,]/.test(psubtype))) {
    data.property_sub_type = psubtype.split(/[|,]/)[0].trim() || null;
  } else if (Array.isArray(psubtype) && psubtype.length) {
    data.property_sub_type = String(psubtype[0]).trim();
  }

  data.size_value = firstNumber(data.size_value);
  data.price_value = firstNumber(data.price_value);

  let sunit = data.size_unit;
  if (Array.isArray(sunit) && sunit.length) {
    data.size_unit = String(sunit[0]);
  } else if (typeof sunit === 'string' && sunit.includes('|')) {
    data.size_unit = sunit.split('|')[0].trim();
  }

  const contact = data.contact_number;
  if (Array.isArray(contact)) {
    data.contact_number = contact.filter(Boolean).map(String).join(', ') || null;
  } else if (contact != null && typeof contact !== 'string') {
    data.contact_number = String(contact);
  }

  if (!data.entities || typeof data.entities !== 'object' || Array.isArray(data.entities)) {
    data.entities = {
      products: [],
      dates_mentioned: [],
      action_items: [],
      names: []
    };
  } else {
    for (const ek of ['products', 'dates_mentioned', 'action_items', 'names']) {
      if (data.entities[ek] == null) data.entities[ek] = [];
      else if (!Array.isArray(data.entities[ek])) {
        data.entities[ek] = [String(data.entities[ek])];
      }
    }
  }

  if (typeof data.category === 'string') {
    data.category = data.category.trim().toUpperCase();
  }
  if (typeof data.sentiment === 'string') {
    data.sentiment = data.sentiment.trim().toUpperCase();
  }

  if (data.confidence_score == null) {
    data.confidence_score = 0.5;
  } else {
    const conf = Number(data.confidence_score);
    data.confidence_score = Number.isFinite(conf)
      ? Math.max(0, Math.min(1, conf))
      : 0.5;
  }

  data.is_property_listing_or_inquiry = Boolean(data.is_property_listing_or_inquiry);
  return data;
}

function validateSchema(data) {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'Not a JSON object' };
  }
  if (typeof data.is_property_listing_or_inquiry !== 'boolean') {
    return { ok: false, error: 'is_property_listing_or_inquiry must be boolean' };
  }
  if (typeof data.summary !== 'string') {
    return { ok: false, error: 'summary must be string' };
  }
  if (typeof data.intent !== 'string') {
    return { ok: false, error: 'intent must be string' };
  }
  if (!CATEGORIES.has(data.category)) {
    data.category = 'GENERAL';
  }
  if (!SENTIMENTS.has(data.sentiment)) {
    data.sentiment = 'NEUTRAL';
  }
  if (typeof data.language !== 'string') data.language = 'en';
  return { ok: true, data };
}

function parseLlmOutput(rawOutput) {
  const cleaned = cleanJsonResponse(rawOutput);
  let jsonDict;
  try {
    jsonDict = JSON.parse(cleaned);
  } catch (firstErr) {
    try {
      jsonDict = JSON.parse(repairTruncatedJson(cleaned));
    } catch (err) {
      return {
        schema: null,
        error: `JSONDecodeError: ${err.message}; cleaned=${cleaned.slice(0, 300)}`
      };
    }
  }
  if (!jsonDict || typeof jsonDict !== 'object' || Array.isArray(jsonDict)) {
    return { schema: null, error: 'LLM output is not a JSON object' };
  }
  const coerced = coerceLlmDict(jsonDict);
  const validated = validateSchema(coerced);
  if (!validated.ok) {
    return { schema: null, error: `ValidationError: ${validated.error}` };
  }
  return { schema: validated.data, error: null };
}

class LLMClient {
  constructor(opts = {}) {
    const cfg = getConfig();
    this.baseUrl = opts.baseUrl || cfg.llmBaseUrl;
    this.apiKey = opts.apiKey || cfg.llmApiKey;
    this.defaultModel = opts.defaultModel || cfg.defaultModel;
    this.maxRetries = opts.maxRetries ?? cfg.llmMaxRetries;
    this.client = new OpenAI({
      baseURL: this.baseUrl,
      apiKey: this.apiKey,
      maxRetries: 0
    });
  }

  _maxTokens() {
    const n = Number.parseInt(process.env.LLM_MAX_TOKENS || '4096', 10);
    return Number.isFinite(n) && n >= 256 ? n : 4096;
  }

  async _chatWithRetry(params) {
    let lastErr;
    let thinkingOff = true;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const payload = thinkingOff
        ? {
            ...params,
            enable_thinking: false,
            extra_body: {
              enable_thinking: false,
              chat_template_kwargs: { enable_thinking: false }
            }
          }
        : params;
      try {
        return await this.client.chat.completions.create(payload);
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || '');
        if (
          thinkingOff &&
          /enable_thinking|chat_template_kwargs|unrecognized|unknown parameter|extra inputs/i.test(
            msg
          )
        ) {
          thinkingOff = false;
          continue;
        }
        if (!isRetryableError(err) || attempt === this.maxRetries - 1) {
          throw err;
        }
        const backoff =
          Math.min(30000, 500 * 2 ** attempt) + Math.floor(Math.random() * 400);
        console.warn(
          `[ai] LLM retry ${attempt + 1}/${this.maxRetries} after ${backoff}ms: ${String(
            err.message || err
          ).slice(0, 160)}`
        );
        await sleep(backoff);
      }
    }
    throw lastErr;
  }

  async _completeJson(targetModel, messages, temperature) {
    const maxTokens = this._maxTokens();
    const base = {
      model: targetModel,
      messages,
      temperature,
      max_tokens: maxTokens
    };
    try {
      return await this._chatWithRetry({
        ...base,
        response_format: { type: 'json_object' }
      });
    } catch (err) {
      const msg = String(err?.message || '');
      if (/response_format|json_object|not supported/i.test(msg)) {
        return this._chatWithRetry(base);
      }
      throw err;
    }
  }

  async normalizeMessage(rawText, sender = null, modelName = null) {
    const targetModel = modelName || this.defaultModel;
    const clipped = String(rawText || '').slice(0, 8000);
    const userContent = `Sender: ${sender || 'Unknown'}\nMessage: ${clipped}`;
    const started = process.hrtime.bigint();
    let completionTokens = 0;
    let rawOutput = '';

    try {
      const response = await this._completeJson(
        targetModel,
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ],
        0.1
      );

      rawOutput = extractMessageText(response);
      completionTokens = response.usage?.completion_tokens || rawOutput.split(/\s+/).length;

      let { schema, error } = parseLlmOutput(rawOutput);
      if (schema) {
        const latency = Number(process.hrtime.bigint() - started) / 1e9;
        return {
          schema,
          latency,
          tokensPerSec: latency > 0 ? completionTokens / latency : 0,
          isValid: true,
          errorReason: null,
          rawOutput
        };
      }

      const retry = await this._completeJson(
        targetModel,
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
          { role: 'assistant', content: rawOutput.slice(0, 4000) },
          {
            role: 'user',
            content:
              `Your previous output was invalid. Error: ${error}. ` +
              'Reply with ONLY one valid JSON object. No thinking, no markdown. ' +
              'size_value and price_value must be single numbers or null, never arrays. ' +
              'intent must be a string.'
          }
        ],
        0
      );

      rawOutput = extractMessageText(retry);
      completionTokens += retry.usage?.completion_tokens || 0;
      ({ schema, error } = parseLlmOutput(rawOutput));
      const latency = Number(process.hrtime.bigint() - started) / 1e9;

      if (schema) {
        return {
          schema,
          latency,
          tokensPerSec: latency > 0 ? completionTokens / latency : 0,
          isValid: true,
          errorReason: null,
          rawOutput
        };
      }

      return {
        schema: null,
        latency,
        tokensPerSec: latency > 0 ? completionTokens / latency : 0,
        isValid: false,
        errorReason: error,
        rawOutput
      };
    } catch (err) {
      const latency = Number(process.hrtime.bigint() - started) / 1e9;
      const msg = String(err?.message || err);
      const isRate =
        err?.status === 429 ||
        /rate.?limit/i.test(msg) ||
        /RateLimitError/i.test(msg);

      if (isRate) {
        console.warn(`[ai] LLM rate-limited: ${msg.slice(0, 200)}`);
        return {
          schema: null,
          latency,
          tokensPerSec: 0,
          isValid: false,
          errorReason: `RATE_LIMIT:${msg}`,
          rawOutput
        };
      }

      console.error(`[ai] normalize_message failed: ${msg.slice(0, 300)}`);
      return {
        schema: null,
        latency,
        tokensPerSec: 0,
        isValid: false,
        errorReason: `${err?.name || 'Error'}: ${msg}`,
        rawOutput
      };
    }
  }
}

function createEmbeddingClient() {
  const cfg = getConfig();
  return new OpenAI({
    baseURL: cfg.embeddingBaseUrl,
    apiKey: cfg.embeddingApiKey,
    maxRetries: 0
  });
}

async function generateEmbedding(text, modelName) {
  const cfg = getConfig();
  const model = modelName || cfg.embeddingModel;
  const client = createEmbeddingClient();
  let lastErr;
  for (let attempt = 0; attempt < cfg.llmMaxRetries; attempt++) {
    try {
      const response = await client.embeddings.create({
        model,
        input: text
      });
      return response.data[0].embedding;
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === cfg.llmMaxRetries - 1) break;
      const backoff =
        Math.min(20000, 400 * 2 ** attempt) + Math.floor(Math.random() * 300);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

module.exports = {
  LLMClient,
  generateEmbedding,
  createEmbeddingClient,
  parseLlmOutput,
  cleanJsonResponse,
  repairTruncatedJson,
  stripThinkBlocks
};
