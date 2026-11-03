'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, getOptions, SELECT_SQL } = require('../scripts/renormalize_non_karachi');
const extractorPath = require.resolve('../ai/extract/extractor');
const persistPath = require.resolve('../scripts/renormalize_city_persist');
const realExtractor = require(extractorPath);
require(persistPath);

function setup(t, { apiKey = 'test-key', saveRows, extractMessage, callOpenAI, extractError = 'Unexpected model request' } = {}) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'renormalize-city-test-'));
  const previousEnv = Object.fromEntries(['OPENAI_API_KEY', 'OPENAI_MODEL', 'EXTRACT_MODEL'].map(key => [key, process.env[key]]));
  const previousExitCode = process.exitCode;
  const originalExtractor = require.cache[extractorPath].exports;
  const originalPersist = require.cache[persistPath].exports;
  const calls = { extract: 0, api: 0, save: [], logs: [], errors: [] };
  if (apiKey === null) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = apiKey;
  process.env.OPENAI_MODEL = 'gpt-current-configuration';
  delete process.env.EXTRACT_MODEL;
  process.exitCode = 0;
  t.mock.method(console, 'log', (...args) => calls.logs.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => calls.errors.push(args.join(' ')));
  require.cache[extractorPath].exports = {
    ...realExtractor,
    async extractMessage(...args) {
      calls.extract += 1;
      if (extractMessage) return extractMessage(...args);
      throw new Error(extractError);
    },
    async callOpenAI(...args) {
      calls.api += 1;
      if (callOpenAI) return callOpenAI(...args);
      throw new Error('Unexpected OpenAI request');
    }
  };
  require.cache[persistPath].exports = {
    async saveRows(db, job, oldRows, rows, options) {
      calls.save.push({ db, job, oldRows, rows, options });
      if (saveRows) return saveRows(db, job, oldRows, rows, options);
      return { updated: oldRows.length, inserted: 0, ids: oldRows.map(row => row.id) };
    }
  };
  t.after(() => {
    require.cache[extractorPath].exports = originalExtractor;
    require.cache[persistPath].exports = originalPersist;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.exitCode = previousExitCode;
    fs.rmSync(runDir, { recursive: true, force: true });
  });
  return { runDir, calls };
}

function job(id) {
  return {
    id, user_id: 4, chat_jid: 'test@g.us', sender: 'test', sender_phone: null,
    message: `500 yard plot offer ${id}`,
    oldRows: [{
      id: id + 100, whatsapp_message_id: id, listing_index: 0,
      is_property: true, listing_excerpt: `500 yard plot offer ${id}`,
      city: 'Lahore', property_status: 'SOLD'
    }]
  };
}

function write(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

function snapshot(runDir, jobs) {
  const before = { version: 1, userId: 4, model: 'gpt-snapshot-model', jobs, favourites: [], comments: [] };
  write(path.join(runDir, 'before.json'), before);
  return before;
}

function cacheExtraction(runDir, id, extraction) {
  write(path.join(runDir, `${id}.extraction.json`), {
    model: 'gpt-snapshot-model', provider: 'test',
    extraction: extraction || {
      is_property: true, language: 'en',
      listings: [{ listing_excerpt: `500 yard plot offer ${id}`, kind: 'OFFER', property_type: 'PLOT', city: 'Karachi' }]
    }
  });
}

test('resume skips completed IDs and reuses cached extraction with its original model', async (t) => {
  const { runDir, calls } = setup(t);
  const jobs = [job(1), job(2)];
  snapshot(runDir, jobs);
  const completed = { messageId: 1, model: 'openai/gpt-snapshot-model', ids: [101] };
  write(path.join(runDir, '1.done.json'), completed);
  cacheExtraction(runDir, 2);

  const summary = await run({}, { apply: true, runDir });
  assert.equal(summary.ok, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.remaining, 0);
  assert.equal(summary.model, 'openai/gpt-snapshot-model');
  assert.equal(calls.extract, 0);
  assert.equal(calls.api, 0);
  assert.deepEqual(calls.save.map(call => call.job.id), [2]);
  assert.equal(calls.save[0].rows[0].model_used, 'openai/gpt-snapshot-model');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, '1.done.json'))), completed);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, '2.done.json'))).messageId, 2);
  assert.equal(process.exitCode, 0);
  assert.equal(fs.existsSync(path.join(runDir, 'running.pid')), false);
});

test('empty cached extraction retains existing cards without a persistence call', async (t) => {
  const { runDir, calls } = setup(t);
  const before = snapshot(runDir, [job(1)]);
  cacheExtraction(runDir, 1, { is_property: true, listings: [] });
  const summary = await run({}, { apply: true, runDir });
  assert.equal(calls.save.length, 0);
  assert.equal(calls.extract, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.remaining, 1);
  assert.match(summary.failures[0].reason, /existing cards retained/);
  assert.equal(fs.existsSync(path.join(runDir, '1.done.json')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'before.json'))), before);
  assert.equal(process.exitCode, 1);
});

test('preview uses a read-only snapshot with no API key and no output files', async (t) => {
  const { runDir, calls } = setup(t, { apiKey: null });
  const jobs = [job(1), job(2)];
  const queries = [];
  let released = false;
  const client = {
    async query(sql, params) {
      queries.push(sql);
      if (sql === SELECT_SQL) {
        assert.deepEqual(params, [4]);
        return { rows: jobs.map(({ oldRows, ...message }) => message) };
      }
      if (sql.startsWith('SELECT * FROM normalized_messages')) return { rows: jobs.flatMap(item => item.oldRows) };
      if (sql.startsWith('SELECT * FROM property_')) return { rows: [] };
      if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || sql === 'COMMIT') return {};
      throw new Error(`Unexpected preview query: ${sql}`);
    },
    release() { released = true; }
  };
  await run({ pool: { connect: async () => client } }, { apply: false, runDir });
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(queries.at(-1), 'COMMIT');
  assert.ok(released);
  assert.equal(calls.extract, 0);
  assert.equal(calls.api, 0);
  assert.equal(calls.save.length, 0);
  assert.match(calls.logs.join('\n'), /PREVIEW messages=2 cards=2 user=4 model=gpt-current-configuration/);
  assert.deepEqual(fs.readdirSync(runDir), []);
  assert.equal(process.exitCode, 0);
});

test('partial persistence failure continues other jobs and returns a failing exit code', async (t) => {
  const { runDir, calls } = setup(t, {
    async saveRows(_db, currentJob) {
      if (currentJob.id === 1) throw new Error('Card changed since extraction; refusing stale update');
      return { updated: 1, inserted: 0, ids: [102] };
    }
  });
  snapshot(runDir, [job(1), job(2)]);
  cacheExtraction(runDir, 1);
  cacheExtraction(runDir, 2);
  const summary = await run({}, { apply: true, runDir });
  assert.deepEqual(calls.save.map(call => call.job.id), [1, 2]);
  assert.equal(summary.ok, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.remaining, 1);
  assert.equal(process.exitCode, 1);
  assert.equal(fs.existsSync(path.join(runDir, '1.done.json')), false);
  assert.equal(fs.existsSync(path.join(runDir, '2.done.json')), true);
  assert.equal(fs.existsSync(path.join(runDir, 'running.pid')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'))), summary);
});

test('CLI apply requires a resume directory and rejects incomplete or unknown flags', () => {
  assert.deepEqual(getOptions([]), { apply: false, runDir: undefined });
  assert.throws(() => getOptions(['--apply']), /requires --run-dir/);
  assert.throws(() => getOptions(['--run-dir']), /Unknown or incomplete/);
  assert.throws(() => getOptions(['--unknown']), /Unknown or incomplete/);
  assert.deepEqual(getOptions(['--apply', '--run-dir', '/tmp/test-repair']), { apply: true, runDir: '/tmp/test-repair' });
});

test('OpenAI billing exhaustion stops after one attempt and preserves the whole remaining cohort', async (t) => {
  const { runDir, calls } = setup(t, {
    extractError: 'openai 429: Your account has no credits remaining. Please add credits to continue.'
  });
  const before = snapshot(runDir, [job(1), job(2), job(3)]);
  const summary = await run({}, { apply: true, runDir });
  assert.equal(calls.extract, 1);
  assert.equal(calls.save.length, 0);
  assert.equal(summary.ok, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.remaining, 3);
  assert.equal(summary.stopReason, 'openai_quota');
  assert.equal(process.exitCode, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'before.json'))), before);
  assert.ok(fs.readdirSync(runDir).every(file => !file.endsWith('.done.json') && !file.endsWith('.extraction.json')));
  assert.equal(fs.existsSync(path.join(runDir, 'running.pid')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'))), summary);
});

test('reviewed retries isolate instructions and caches while preserving the first extraction', async (t) => {
  const apiRequests = [];
  let rejectReviewedSave = true;
  const { runDir, calls } = setup(t, {
    async extractMessage(input, options) {
      assert.equal(options.model, 'gpt-snapshot-model');
      return options.callModel({ system: 'Base extraction instructions', prompt: input.message, maxTokens: 1200 });
    },
    async callOpenAI(args) {
      apiRequests.push(args);
      return {
        model: args.model, provider: 'openai',
        extraction: {
          is_property: true, language: 'en',
          listings: [{ listing_excerpt: args.prompt, kind: 'OFFER', property_type: 'PLOT', city: null }]
        }
      };
    },
    async saveRows(_db, currentJob) {
      if (currentJob.id === 1 && rejectReviewedSave) {
        rejectReviewedSave = false;
        throw new Error('Temporary persistence failure');
      }
      return { updated: 1, inserted: 0, ids: [currentJob.id + 100] };
    }
  });
  const before = snapshot(runDir, [job(1), job(2)]);
  cacheExtraction(runDir, 1);
  const originalPath = path.join(runDir, '1.extraction.json');
  const originalText = fs.readFileSync(originalPath, 'utf8');
  const instructions = 'The legacy card aggregates offers; only use a city explicitly stated in an offer.';
  write(path.join(runDir, 'reviewed.json'), {
    1: { extractionInstructions: instructions, allowLegacyAggregateSplit: true }
  });

  const first = await run({}, { apply: true, runDir });
  assert.equal(first.remaining, 1);
  assert.equal(first.failed, 1);
  assert.equal(fs.readFileSync(originalPath, 'utf8'), originalText);
  const reviewedPath = path.join(runDir, '1.reviewed.extraction.json');
  const reviewedText = fs.readFileSync(reviewedPath, 'utf8');
  assert.equal(JSON.parse(reviewedText).extraction.listings[0].city, null);
  assert.equal(fs.existsSync(path.join(runDir, '2.reviewed.extraction.json')), false);
  assert.equal(fs.existsSync(path.join(runDir, '2.extraction.json')), true);
  assert.deepEqual(apiRequests, [
    { system: `Base extraction instructions\n\nReview of this message:\n${instructions}`,
      prompt: job(1).message, maxTokens: 1200, model: 'gpt-snapshot-model' },
    { system: 'Base extraction instructions',
      prompt: job(2).message, maxTokens: 1200, model: 'gpt-snapshot-model' }
  ]);
  assert.deepEqual(calls.save.map(call => [call.job.id, call.options]), [
    [1, { allowLegacyAggregateSplit: true }],
    [2, { allowLegacyAggregateSplit: false }]
  ]);

  process.exitCode = 0;
  const resumed = await run({}, { apply: true, runDir });
  assert.equal(resumed.ok, 2);
  assert.equal(resumed.remaining, 0);
  assert.equal(calls.extract, 2);
  assert.equal(calls.api, 2);
  assert.deepEqual(calls.save.at(-1).options, { allowLegacyAggregateSplit: true });
  assert.equal(calls.save.at(-1).rows[0].city, null);
  assert.equal(fs.readFileSync(originalPath, 'utf8'), originalText);
  assert.equal(fs.readFileSync(reviewedPath, 'utf8'), reviewedText);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'before.json'))), before);
  assert.equal(process.exitCode, 0);
});

test('review instructions outside the saved cohort reject before extraction or persistence', async (t) => {
  const { runDir, calls } = setup(t);
  snapshot(runDir, [job(1)]);
  cacheExtraction(runDir, 1);
  write(path.join(runDir, 'reviewed.json'), {
    999: { extractionInstructions: 'Unexpected message', allowLegacyAggregateSplit: true }
  });
  const filesBefore = Object.fromEntries(fs.readdirSync(runDir).map(name =>
    [name, fs.readFileSync(path.join(runDir, name), 'utf8')]));

  await assert.rejects(run({}, { apply: true, runDir }), /Review is outside the saved cohort: 999/);
  assert.equal(calls.extract, 0);
  assert.equal(calls.api, 0);
  assert.equal(calls.save.length, 0);
  const filesAfter = Object.fromEntries(fs.readdirSync(runDir).map(name =>
    [name, fs.readFileSync(path.join(runDir, name), 'utf8')]));
  assert.deepEqual(filesAfter, filesBefore);
  assert.equal(fs.existsSync(path.join(runDir, 'running.pid')), false);
});
