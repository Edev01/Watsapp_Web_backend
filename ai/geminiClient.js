/**
 * Gemini normalize client with looping key + model watchdog.
 * - 429 / quota → rotate API key (round-robin, wraps forever)
 * - 502 / 5xx / model errors → rotate model (round-robin, wraps forever)
 */

const { getConfig } = require('./config');
const { SYSTEM_PROMPT } = require('./normalizePrompt');
const { parseLlmOutput } = require('./llmClient');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsvList(raw) {
  return String(raw || '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadGeminiKeys() {
  const fromList = parseCsvList(process.env.GEMINI_API_KEYS || '');
  if (fromList.length) return fromList;
  const numbered = [];
  for (let i = 1; i <= 16; i += 1) {
    const k = process.env[`GEMINI_API_KEY_${i}`] || process.env[`GEMINI_KEY_${i}`];
    if (k && String(k).trim()) numbered.push(String(k).trim());
  }
  if (numbered.length) return numbered;
  const single = process.env.GEMINI_API_KEY || '';
  return single.trim() ? [single.trim()] : [];
}

function loadGeminiModels() {
  const fromEnv = parseCsvList(process.env.GEMINI_MODELS || '');
  if (fromEnv.length) return fromEnv;
  return [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
    'gemini-2.5-flash'
  ];
}

class GeminiWatchdog {
  constructor(keys, models) {
    this.keys = keys.length ? keys : [];
    this.models = models.length ? models : ['gemini-2.0-flash'];
    this.keyIndex = 0;
    this.modelIndex = 0;
    this.stats = { keyRotations: 0, modelRotations: 0, calls: 0, failures: 0 };
  }

  get configured() {
    return this.keys.length > 0;
  }

  current() {
    return {
      key: this.keys[this.keyIndex % this.keys.length],
      model: this.models[this.modelIndex % this.models.length],
      keyIndex: this.keyIndex % this.keys.length,
      modelIndex: this.modelIndex % this.models.length
    };
  }

  /** Advance key; wraps so previously-used keys come back. */
  rotateKey(reason = '') {
    if (this.keys.length <= 1) {
      this.keyIndex = 0;
    } else {
      this.keyIndex = (this.keyIndex + 1) % this.keys.length;
    }
    this.stats.keyRotations += 1;
    const cur = this.current();
    console.warn(
      `[ai:gemini] key rotate (#${this.stats.keyRotations}) → key[${cur.keyIndex}]` +
        (reason ? ` (${String(reason).slice(0, 80)})` : '')
    );
    return cur;
  }

  /** Advance model; wraps so previously-used models come back. */
  rotateModel(reason = '') {
    if (this.models.length <= 1) {
      this.modelIndex = 0;
    } else {
      this.modelIndex = (this.modelIndex + 1) % this.models.length;
    }
    this.stats.modelRotations += 1;
    const cur = this.current();
    console.warn(
      `[ai:gemini] model rotate (#${this.stats.modelRotations}) → ${cur.model}` +
        (reason ? ` (${String(reason).slice(0, 80)})` : '')
    );
    return cur;
  }
}

let sharedWatchdog = null;

function getGeminiWatchdog() {
  if (!sharedWatchdog) {
    sharedWatchdog = new GeminiWatchdog(loadGeminiKeys(), loadGeminiModels());
    if (sharedWatchdog.configured) {
      console.info(
        `[ai:gemini] watchdog ready: ${sharedWatchdog.keys.length} key(s), ` +
          `${sharedWatchdog.models.length} model(s)`
      );
    }
  }
  return sharedWatchdog;
}

/** Test helper / config reload */
function resetGeminiWatchdog() {
  sharedWatchdog = null;
}

function classifyGeminiError(status, bodyText, errMessage) {
  const msg = `${bodyText || ''} ${errMessage || ''}`.toLowerCase();
  const code = Number(status) || 0;
  if (
    code === 429 ||
    /quota|rate.?limit|resource.?exhausted|too many requests/i.test(msg)
  ) {
    return 'quota';
  }
  if (
    code === 502 ||
    code === 503 ||
    code === 500 ||
    code === 504 ||
    /bad gateway|unavailable|internal|deadline|overloaded|model.*(not found|not supported)/i.test(
      msg
    )
  ) {
    return 'model';
  }
  if (code === 400 && /model|not found|not supported/i.test(msg)) {
    return 'model';
  }
  if (code === 401 || code === 403 || /api.?key|permission|invalid.*key/i.test(msg)) {
    return 'quota'; // treat bad/exhausted key like rotate-key
  }
  return 'other';
}

async function geminiGenerateContent({ key, model, systemPrompt, userText, jsonMode = true }) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096
    }
  };
  if (jsonMode) {
    body.generationConfig.responseMimeType = 'application/json';
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* raw */
  }

  if (!res.ok) {
    const err = new Error(
      `Gemini HTTP ${res.status}: ${(text || '').slice(0, 400)}`
    );
    err.status = res.status;
    err.bodyText = text;
    throw err;
  }

  const parts = json?.candidates?.[0]?.content?.parts || [];
  const rawOutput = parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();

  if (!rawOutput) {
    const block = json?.candidates?.[0]?.finishReason || json?.promptFeedback?.blockReason;
    const err = new Error(`Gemini empty response (${block || 'no text'})`);
    err.status = 502;
    err.bodyText = text.slice(0, 400);
    throw err;
  }

  return rawOutput;
}

class GeminiClient {
  constructor() {
    this.watchdog = getGeminiWatchdog();
  }

  isConfigured() {
    return this.watchdog.configured;
  }

  async normalizeMessage(rawText, sender = null) {
    if (!this.isConfigured()) {
      return {
        schema: null,
        latency: 0,
        isValid: false,
        errorReason: 'GEMINI_NOT_CONFIGURED',
        rawOutput: '',
        modelUsed: null
      };
    }

    const cfg = getConfig();
    const clipped = String(rawText || '').slice(0, 8000);
    const userContent =
      `Sender: ${sender || 'Unknown'}\nMessage: ${clipped}\n\n` +
      'Extra location rules for this message:\n' +
      '- Roman Urdu "mein/mai/main" often means "in", NOT a place named Main.\n' +
      '- area = society/town (DHA, Korangi, Clifton). vicinity = phase/block/street.\n' +
      '- Never set area or vicinity to only "main", "mein", or "main dha" without a real phase/street.\n' +
      '- Prefer "Korangi" + "Street 5" over inventing "Main".';

    const started = process.hrtime.bigint();
    const keysN = Math.max(1, this.watchdog.keys.length);
    const modelsN = Math.max(1, this.watchdog.models.length);
    // Full loops over key×model space (wraps), not one-shot discard
    const maxAttempts = Math.max(keysN * modelsN * 2, cfg.llmMaxRetries || 6);
    let lastError = null;
    let rawOutput = '';
    let jsonMode = true;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const { key, model, keyIndex, modelIndex } = this.watchdog.current();
      this.watchdog.stats.calls += 1;
      try {
        rawOutput = await geminiGenerateContent({
          key,
          model,
          systemPrompt: SYSTEM_PROMPT,
          userText: userContent,
          jsonMode
        });

        const { schema, error } = parseLlmOutput(rawOutput);
        if (schema) {
          const latency = Number(process.hrtime.bigint() - started) / 1e9;
          return {
            schema,
            latency,
            isValid: true,
            errorReason: null,
            rawOutput,
            modelUsed: model,
            provider: 'gemini',
            keyIndex,
            modelIndex
          };
        }

        lastError = error || 'parse failed';
        // Invalid JSON from model → try next model in the loop
        this.watchdog.rotateModel(`parse: ${lastError}`);
        await sleep(200 + Math.floor(Math.random() * 200));
      } catch (err) {
        this.watchdog.stats.failures += 1;
        lastError = String(err?.message || err);
        const kind = classifyGeminiError(err?.status, err?.bodyText, lastError);

        if (
          jsonMode &&
          /responseMimeType|mime|json.?mode|not supported/i.test(lastError)
        ) {
          jsonMode = false;
          console.warn('[ai:gemini] responseMimeType unsupported — retrying without JSON mode');
          continue;
        }

        if (kind === 'quota') {
          this.watchdog.rotateKey(lastError);
          await sleep(400 + Math.floor(Math.random() * 400));
          continue;
        }
        if (kind === 'model') {
          this.watchdog.rotateModel(lastError);
          await sleep(300 + Math.floor(Math.random() * 300));
          continue;
        }
        // other: rotate both lightly and keep looping
        this.watchdog.rotateKey(lastError);
        this.watchdog.rotateModel(lastError);
        await sleep(250);
      }
    }

    const latency = Number(process.hrtime.bigint() - started) / 1e9;
    return {
      schema: null,
      latency,
      isValid: false,
      errorReason: `GEMINI_EXHAUSTED:${String(lastError || 'unknown').slice(0, 200)}`,
      rawOutput,
      modelUsed: this.watchdog.current().model,
      provider: 'gemini'
    };
  }
}

module.exports = {
  GeminiClient,
  GeminiWatchdog,
  getGeminiWatchdog,
  resetGeminiWatchdog,
  loadGeminiKeys,
  loadGeminiModels
};
