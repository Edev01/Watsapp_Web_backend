/** Classify extract/LLM errors for stats and stop emails (no secrets). */

function classifyExtractError(err) {
  const msg = String(err?.message || err || '');
  const out = { provider: null, status: null, is429: false, isQuota: false, short: msg.slice(0, 240) };

  const gem = msg.match(/^gemini\s+(\d+)/i);
  const tog = msg.match(/^together\s+(\d+)/i);
  const oai = msg.match(/^openai\s+(\d+)/i);
  if (gem) {
    out.provider = 'gemini';
    out.status = parseInt(gem[1], 10);
  } else if (tog) {
    out.provider = 'together';
    out.status = parseInt(tog[1], 10);
  } else if (oai) {
    out.provider = 'openai';
    out.status = parseInt(oai[1], 10);
  }

  out.is429 = out.status === 429 || /\b429\b/.test(msg);
  out.is402 = out.status === 402 || /credit limit exceeded/i.test(msg);
  out.isQuota =
    out.is429 ||
    out.is402 ||
    /quota|exceeded your current quota|rate limit|credit limit exceeded/i.test(msg);
  return out;
}

function bumpRateLimitStats(stats, err) {
  const c = classifyExtractError(err);
  if (c.provider === 'gemini') {
    if (c.is429 || (c.isQuota && !c.is402)) stats.rateLimit.gemini429 += 1;
    else stats.rateLimit.geminiOther += 1;
  } else if (c.provider === 'together') {
    if (c.is429) stats.rateLimit.together429 += 1;
    else if (c.is402 || /credit limit exceeded/i.test(c.short)) stats.rateLimit.together402 += 1;
    else if (c.isQuota) stats.rateLimit.together429 += 1;
    else stats.rateLimit.togetherOther += 1;
  } else if (c.is429 || c.isQuota) {
    stats.rateLimit.unknown429 += 1;
  }
  return c;
}

module.exports = { classifyExtractError, bumpRateLimitStats };
