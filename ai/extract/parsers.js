/**
 * Deterministic parsers. The LLM copies text; these functions turn it into numbers.
 * Everything here is pure (no I/O) so it can be unit-tested on real messages.
 */

/* ------------------------------------------------------------------ cleaning */

function cleanText(input) {
  let t = String(input ?? '').normalize('NFKC');
  t = t.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '');
  t = t.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)); // Arabic-Indic digits
  t = t.replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0)); // Persian digits
  t = t.replace(/\u00d7/g, 'x'); // multiplication sign
  t = t.replace(/[*_~`]+/g, ''); // WhatsApp bold/italic/strike markers
  t = t.replace(/(\d)\.(?=[A-Za-z\u0600-\u06ff])/g, '$1 '); // "13.Crore" -> "13 Crore"
  t = t.replace(/[ \t\u00a0]+/g, ' ');
  return t.trim();
}

const PHONE_RE = /(?:\+?92|0)\s*3\d{2}[\s-]?\d{7}|\b\d{10,}\b/g;
function stripPhones(s) {
  return String(s || '').replace(PHONE_RE, ' ');
}

/* --------------------------------------------------------------------- price */

// Human typos included: lack/lach/lackh (lakh), croe/croree (crore), etc.
const UNIT_SRC =
  'arab|arb|crores?|croree?|croe|cror|crs?|cr|karor|karore|kror|' +
  'lakhs?|lacs?|lak|laks|laakh|lac|lackh?|lach|' +
  'hazar|hazaar|hzr|thousand|k|million|mn|' +
  '\\u06a9\\u0631\\u0648\\u0691|\\u0644\\u0627\\u06a9\\u06be?|\\u06c1\\u0632\\u0627\\u0631|\\u0627\\u0631\\u0628';
const NO_LETTER_AFTER = '(?![A-Za-z\\u0600-\\u06ff])';
const AMOUNT_UNIT_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_SRC})${NO_LETTER_AFTER}`, 'gi');
const RANGE_RE = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(${UNIT_SRC})?\\s*(?:to|se|tak|-|\\u2013|\\u2014)\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNIT_SRC})${NO_LETTER_AFTER}`,
  'i'
);

function unitMultiplier(unit) {
  const u = String(unit).toLowerCase();
  if (/^(arab|arb|\u0627\u0631\u0628)$/.test(u)) return 1e9;
  if (/^(crores?|croree?|croe|cror|crs?|cr|karor|karore|kror|\u06a9\u0631\u0648\u0691)$/.test(u)) return 1e7;
  if (/^(lakhs?|lacs?|lak|laks|laakh|lac|lackh?|lach|\u0644\u0627\u06a9\u06be?)$/.test(u)) return 1e5;
  if (/^(hazar|hazaar|hzr|thousand|k|\u06c1\u0632\u0627\u0631)$/.test(u)) return 1e3;
  if (/^(million|mn)$/.test(u)) return 1e6;
  return null;
}

const BARE_MULT = { CRORE: 1e7, LAKH: 1e5, THOUSAND: 1e3, RUPEES: 1 };

function detectBasis(text) {
  const t = String(text || '');
  if (/(per|\/|p\.?)\s*(sq\.?\s*)?(yd|yard|yrd|gaz)s?\b/i.test(t)) return 'PER_SQ_YD';
  if (/(per|\/)\s*(sq\.?\s*)?(ft|feet|foot|sft)\b/i.test(t)) return 'PER_SQ_FT';
  if (/(per|\/)\s*floor/i.test(t)) return 'PER_FLOOR';
  if (/(per\s*month|\/\s*month|monthly|\bpm\b|mahana|\u0645\u0627\u06c1\u0627\u0646\u06c1)/i.test(t)) return 'PER_MONTH';
  return null;
}

/**
 * @param {string} priceText   verbatim price phrase from the message
 * @param {object} opts        { purpose, bareUnit (LLM guess), basis (LLM basis) }
 * @returns {{value:number|null,min:number|null,max:number|null,basis:string,inferred:boolean,warnings:string[]}}
 */
function parsePrice(priceText, opts = {}) {
  const warnings = [];
  const out = { value: null, min: null, max: null, basis: 'TOTAL', inferred: false, warnings };
  const raw = cleanText(priceText);
  if (!raw) return out;

  if (/(on\s*call|call\s*for|demand\s*\?+|negotiable\s*only)/i.test(raw) && !/\d/.test(raw)) {
    out.basis = 'ON_CALL';
    return out;
  }

  const detected = detectBasis(raw);
  const llmBasis = opts.basis && opts.basis !== 'UNKNOWN' ? opts.basis : null;
  out.basis = detected || llmBasis || (String(opts.purpose).toUpperCase() === 'RENT' ? 'PER_MONTH' : 'TOTAL');

  const t = stripPhones(raw.replace(/,/g, ''));
  const atHit = t.match(/@\s*(\d+(?:\.\d+)?)\s*(crores?|croe|crs?|cr|lakhs?|lacs?|lac)?/i);
  if (atHit && out.value == null) {
    const n = parseFloat(atHit[1]);
    const unit = atHit[2];
    const mult = unit ? unitMultiplier(unit) : (n < 20 ? 1e7 : n < 10000 ? 1e5 : 1);
    if (Number.isFinite(n) && n > 0 && mult) {
      out.value = n * mult;
      out.min = out.max = out.value;
      out.inferred = !unit;
      warnings.push('at_prefix_price');
      return finish(out, opts);
    }
  }

  // 1) Range with a unit: "80 to 85 lakh", "1 crore to 1.2 crore", "80-85 lac"
  const r = t.match(RANGE_RE);
  if (r) {
    const unit = r[4] || r[2];
    const mult = unitMultiplier(unit);
    const m1 = r[2] ? unitMultiplier(r[2]) : mult;
    if (mult && m1) {
      const a = parseFloat(r[1]) * m1;
      const b = parseFloat(r[3]) * mult;
      out.min = Math.min(a, b);
      out.max = Math.max(a, b);
      out.value = out.min;
      return finish(out, opts);
    }
  }

  // 2) Compound units, descending magnitude, adjacent: "1 crore 90 lakh", "2 lac 50 thousand"
  const matches = [...t.matchAll(AMOUNT_UNIT_RE)];
  if (matches.length) {
    let total = 0;
    let lastMag = Infinity;
    let prevEnd = null;
    let lastMatchEnd = 0;
    for (const m of matches) {
      const mag = unitMultiplier(m[2]);
      if (!mag) continue;
      if (prevEnd !== null) {
        const gap = t.slice(prevEnd, m.index);
        if (!/^[\s,&+]*(?:and|aur)?[\s,&+]*$/i.test(gap)) break; // not adjacent -> different figure
      }
      if (mag >= lastMag) break; // "1 Crore 90 Lakh (1.9 Cr)" - stop at the repeat
      total += parseFloat(m[1]) * mag;
      lastMag = mag;
      prevEnd = m.index + m[0].length;
      lastMatchEnd = prevEnd;
    }
    if (total > 0) {
      // "1 crore 15" -> 1 crore 15 lakh ; "2 lakh 50" -> 2 lakh 50 thousand
      const tail = t.slice(lastMatchEnd).match(/^\s*(\d{1,2})(?![\d.]*\s*[A-Za-z%x])(?!\d)/);
      if (tail && (lastMag === 1e7 || lastMag === 1e5)) {
        total += parseInt(tail[1], 10) * (lastMag === 1e7 ? 1e5 : 1e3);
        out.inferred = true;
        warnings.push('trailing_bare_number_as_next_unit');
      }
      out.value = total;
      out.min = total;
      out.max = total;
      return finish(out, opts);
    }
  }

  // 3) Bare number(s): "145", "Dem 12", "Rs 150,000", "4.50"
  const nums = [...t.matchAll(/\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0]));
  if (nums.length) {
    const n = nums[0];
    if (n >= 10000) {
      out.value = n;
    } else if (opts.bareUnit && BARE_MULT[opts.bareUnit]) {
      out.value = n * BARE_MULT[opts.bareUnit];
      out.inferred = true;
      warnings.push('unit_inferred_from_context');
    } else {
      warnings.push('bare_number_no_unit');
      return out;
    }
    out.min = out.max = out.value;
  }
  return finish(out, opts);
}

function finish(out, opts) {
  if (out.value == null) return out;
  const purpose = String(opts.purpose || '').toUpperCase();
  if (out.basis === 'TOTAL' && purpose === 'SALE' && out.value < 500000) out.warnings.push('suspect_low_sale_price');
  if (out.basis === 'PER_MONTH' && out.value > 5e6) out.warnings.push('suspect_high_rent');
  if (out.min == null) out.min = out.value;
  if (out.max == null) out.max = out.value;
  return out;
}

/* ---------------------------------------------------------------------- size */

const SIZE_UNIT_SRC =
  'sq\\.?\\s*(?:yards?|yds?|yrds?)|sqyds?|sqyrds?|square\\s*yards?|yards?|yrds?|yds?|gaz|\\u06af\\u0632|' +
  'sq\\.?\\s*(?:ft|feet|foot)|sqft|sqfeet|square\\s*(?:feet|foot|ft)|sft|' +
  'sq\\.?\\s*m(?:eters?|etres?)?|sqm|' +
  'marlas?|\\u0645\\u0631\\u0644\\u06c1|kanals?|knl|\\u06a9\\u0646\\u0627\\u0644|acres?|\\u0627\\u06cc\\u06a9\\u0691';
const NUM_SRC = '\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?';
const SIZE_RE = new RegExp(
  `(?<![\\d.])(${NUM_SRC})(?:\\s*(?:\\+|&|and)\\s*(${NUM_SRC}))?\\s*(${SIZE_UNIT_SRC})(?![A-Za-z\\u0600-\\u06ff])`,
  'i'
);

const SQFT_PER = { SQ_FT: 1, SQ_YD: 9, SQ_M: 10.7639, MARLA: 225, KANAL: 4500, ACRE: 43560 };

function classifySizeUnit(u) {
  const s = String(u).toLowerCase().replace(/\s+/g, '');
  if (/(ft|feet|foot|sft)/.test(s)) return 'SQ_FT';
  if (/(yard|yd|yrd|gaz)|\u06af\u0632/.test(s)) return 'SQ_YD';
  if (/^(sq\.?m|sqm|sq\.?met)/.test(s)) return 'SQ_M';
  if (/(marla)|\u0645\u0631\u0644\u06c1/.test(s)) return 'MARLA';
  if (/(kanal|knl)|\u06a9\u0646\u0627\u0644/.test(s)) return 'KANAL';
  if (/(acre)|\u0627\u06cc\u06a9\u0691/.test(s)) return 'ACRE';
  return 'UNKNOWN';
}

const num = (s) => parseFloat(String(s).replace(/,/g, ''));

/**
 * @param {string} sizeText  verbatim size phrase (falls back to llm.value/unit, then dimensions)
 * @param {object} opts      { value, unit (LLM), dimensionsText }
 */
function parseSize(sizeText, opts = {}) {
  const warnings = [];
  const res = { value: null, unit: null, sqft: null, extra_value: null, extra_sqft: null, source: null, warnings };
  const text = cleanText(sizeText);

  const m = text && text.match(SIZE_RE);
  if (m) {
    const unit = classifySizeUnit(m[3]);
    if (unit !== 'UNKNOWN') {
      res.value = num(m[1]);
      res.unit = unit;
      res.sqft = round2(res.value * SQFT_PER[unit]);
      if (m[2]) {
        res.extra_value = num(m[2]);
        res.extra_sqft = round2(res.extra_value * SQFT_PER[unit]);
      }
      res.source = 'text';
      if (opts.value != null && Math.abs(Number(opts.value) - res.value) > 0.01) warnings.push('llm_size_mismatch');
    }
  }

  if (res.value == null && opts.value != null && opts.unit && SQFT_PER[opts.unit]) {
    res.value = Number(opts.value);
    res.unit = opts.unit;
    res.sqft = round2(res.value * SQFT_PER[opts.unit]);
    res.source = 'llm';
  }

  if (res.value == null && opts.dimensionsText) {
    const d = cleanText(opts.dimensionsText).match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
    if (d) {
      const a = parseFloat(d[1]);
      const b = parseFloat(d[2]);
      if (a >= 10 && b >= 10 && a <= 500 && b <= 500) {
        res.value = round2(a * b);
        res.unit = 'SQ_FT';
        res.sqft = res.value;
        res.source = 'dims';
        warnings.push('derived_from_dimensions');
      }
    }
  }

  if (res.sqft != null && (res.sqft < 100 || res.sqft > 5e7)) {
    warnings.push('suspect_size');
    res.value = res.unit = res.sqft = null;
    res.source = null;
  }
  return res;
}

const round2 = (n) => Math.round(n * 100) / 100;

/* --------------------------------------------------------------------- phase */

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const PHASE_RE = /\b(?:phase|ph)\.?\s*[-#:]?\s*(\d{1,2}|[ivx]{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;

/** Parse a phase ONLY from text that literally contains one. Never from place names. */
function parsePhase(phaseText) {
  const t = cleanText(phaseText);
  if (!t) return { phase: null, extension: false };
  const m = t.match(PHASE_RE);
  if (!m) return { phase: null, extension: false };
  const raw = m[1].toLowerCase();
  const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : ROMAN[raw] ?? WORDS[raw] ?? null;
  return { phase: n && n >= 1 && n <= 12 ? n : null, extension: /\bext(?:ension|n|\.)?\b/i.test(t) };
}

module.exports = { cleanText, stripPhones, parsePrice, parseSize, parsePhase, detectBasis, SQFT_PER };
