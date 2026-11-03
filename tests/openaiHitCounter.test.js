const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

test('recordOpenAiHit increments counter and stores the time', async () => {
  const calls = [];
  const fakeDb = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return {
        rows: [{ total_hits: 7, last_hit_at: new Date('2026-10-28T09:21:00.000Z') }]
      };
    }
  };
  const orig = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === '../../db' || request.endsWith('/db')) return fakeDb;
    return orig(request, parent, isMain);
  };
  delete require.cache[require.resolve('../ai/extract/openaiHitCounter')];
  try {
    const { recordOpenAiHit } = require('../ai/extract/openaiHitCounter');
    const out = await recordOpenAiHit({
      messageId: 18001,
      userId: 4,
      model: 'gpt-4o-mini',
      ok: true,
      httpStatus: 200,
      attempt: 1
    });
    assert.equal(out.total_hits, 7);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /openai_api_hits/);
    assert.match(calls[0].sql, /openai_api_counter/);
    assert.equal(calls[0].params[0], 18001);
    assert.equal(calls[0].params[1], 4);
    assert.equal(calls[0].params[2], 'gpt-4o-mini');
    assert.equal(calls[0].params[3], true);
    assert.equal(calls[0].params[4], 200);
  } finally {
    Module._load = orig;
    delete require.cache[require.resolve('../ai/extract/openaiHitCounter')];
  }
});
