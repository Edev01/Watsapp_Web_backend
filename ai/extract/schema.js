/**
 * Extraction prompt + JSON schema for the single-call normalizer.
 *
 * The system prompt is the normalizer prompt in ../normalizePrompt.js.
 * EXTRACTION_SCHEMA is that same JSON shape, sent as structured output so the
 * model is not pulled back to the old extract-v2 fields.
 */

const { SYSTEM_PROMPT } = require('../normalizePrompt');

const EXTRACT_VERSION = 2;

const PROPERTY_TYPES = ['PLOT', 'HOUSE', 'BUNGALOW', 'APARTMENT', 'FLAT', 'SHOP', 'COMMERCIAL', 'FARMHOUSE'];
const PROPERTY_SUB_TYPES = [
  'Single Storey', 'Double Storey', 'Triple Storey', 'Studio', '1 Bed', '2 Bed', '3 Bed',
  'Penthouse', 'Lower Portion', 'Upper Portion', 'Residential Plot', 'Commercial Plot',
  'Agricultural Land', 'Industrial Land', 'Office', 'Shop', 'Warehouse', 'Factory', 'Building'
];
const SIZE_UNITS = ['Marla', 'Kanal', 'Sq. Ft.', 'Sq. Yd.', 'Sq. M.'];
const PRICE_BASES = ['TOTAL', 'PER_MONTH', 'PER_SQ_YD', 'PER_SQ_FT', 'PER_FLOOR', 'ON_CALL', 'UNKNOWN'];
const CATEGORIES = ['INQUIRY', 'SUPPORT', 'SALES', 'COMPLAINT', 'GENERAL', 'SPAM'];
const SENTIMENTS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'];

const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });
const nullableEnum = (values) => ({ type: ['string', 'null'], enum: [...values, null] });

const LISTING_SCHEMA = {
  type: 'object',
  properties: {
    purpose: nullableEnum(['SALE', 'RENT']),
    property_type: nullableEnum(PROPERTY_TYPES),
    property_sub_type: nullableEnum(PROPERTY_SUB_TYPES),
    city: nullable('string'),
    area: nullable('string'),
    vicinity: nullable('string'),
    size: nullable('string'),
    size_value: nullable('number'),
    size_unit: nullableEnum(SIZE_UNITS),
    price: nullable('string'),
    price_value: nullable('number'),
    contact_number: nullable('string'),
    summary: { type: 'string' },
    listing_excerpt: { type: 'string' }
  },
  required: ['summary', 'listing_excerpt']
};

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    is_property_listing_or_inquiry: { type: 'boolean' },
    summary: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    intent: { type: 'string' },
    sentiment: { type: 'string', enum: SENTIMENTS },
    purpose: nullableEnum(['SALE', 'RENT']),
    property_type: nullableEnum(PROPERTY_TYPES),
    property_sub_type: nullableEnum(PROPERTY_SUB_TYPES),
    city: nullable('string'),
    area: nullable('string'),
    vicinity: nullable('string'),
    size: nullable('string'),
    size_value: nullable('number'),
    size_unit: nullableEnum(SIZE_UNITS),
    price: nullable('string'),
    price_value: nullable('number'),
    contact_number: nullable('string'),
    listings: { type: 'array', items: LISTING_SCHEMA, maxItems: 15 },
    entities: {
      type: 'object',
      properties: {
        products: { type: 'array', items: { type: 'string' } },
        dates_mentioned: { type: 'array', items: { type: 'string' } },
        action_items: { type: 'array', items: { type: 'string' } },
        names: { type: 'array', items: { type: 'string' } }
      },
      required: ['products', 'dates_mentioned', 'action_items', 'names']
    },
    language: { type: 'string' },
    confidence_score: { type: 'number' }
  },
  required: [
    'is_property_listing_or_inquiry',
    'summary',
    'category',
    'intent',
    'sentiment',
    'listings',
    'entities',
    'language',
    'confidence_score'
  ]
};

/** JSON Schema -> Gemini responseSchema (OpenAPI subset: UPPERCASE types + nullable). */
function toGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' && Array.isArray(v)) {
      const real = v.find((t) => t !== 'null');
      out.type = String(real).toUpperCase();
      if (v.includes('null')) out.nullable = true;
    } else if (k === 'type') {
      out.type = String(v).toUpperCase();
    } else if (k === 'enum') {
      out.enum = v.filter((x) => x !== null);
    } else if (k === 'properties') {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else if (k === 'items') {
      out.items = toGeminiSchema(v);
    } else if (k === 'maxItems') {
      out.maxItems = String(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Messages per OpenAI call. One HTTP request normalizes this many rows. */
const NORMALIZE_AI_BATCH = 50;

/** User message sent with SYSTEM_PROMPT. Keep SYSTEM_PROMPT byte-identical across calls (prompt caching). */
function buildUserMessage(cleanedText, { sender } = {}) {
  const who = sender ? `Sender: ${sender}\n` : '';
  return `${who}Message:\n${cleanedText}`;
}

/**
 * One user message for a batch. Each block carries the whatsapp_messages id
 * the model must copy back so the reply can be saved on the right row.
 */
function buildBatchUserMessage(items) {
  const blocks = items.map((item, index) => {
    const who = item.sender ? `sender: ${item.sender}\n` : '';
    return `[${index + 1}] id=${item.id}\n${who}${item.text}`;
  });
  return [
    'Normalize every message below in one response.',
    'Return one JSON object: {"results":[{"id":<the id= number>, ...fields}]}.',
    'Each results item uses the system schema and must include that same id.',
    'Include every id exactly once.',
    '',
    blocks.join('\n\n')
  ].join('\n');
}

module.exports = {
  EXTRACT_VERSION,
  PROPERTY_TYPES,
  PROPERTY_SUB_TYPES,
  SIZE_UNITS,
  PRICE_BASES,
  CATEGORIES,
  SENTIMENTS,
  SYSTEM_PROMPT,
  EXTRACTION_SCHEMA,
  toGeminiSchema,
  buildUserMessage,
  buildBatchUserMessage,
  NORMALIZE_AI_BATCH
};
