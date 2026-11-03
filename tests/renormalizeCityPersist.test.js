'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchRows, saveRows } = require('../scripts/renormalize_city_persist');

const clone = (value) => structuredClone(value);
const card = (id, excerpt, extra = {}) => ({
  id, whatsapp_message_id: 50, is_property: true, listing_index: id - 1,
  listing_excerpt: excerpt, city: 'Lahore', model_used: 'previous',
  property_status: 'AVAILABLE', created_at: new Date('2026-10-01T12:00:00Z'),
  ...extra
});
const extracted = (excerpt, extra = {}) => ({
  whatsapp_message_id: 50, is_property: true, listing_index: 0,
  listing_excerpt: excerpt, city: 'Karachi', model_used: 'openai/test',
  ...extra
});

// Transactional state model: UPDATE/INSERT changes commit together or roll back.
function fakeDb(rows, { failWrite = 0, favourites = [], comments = [] } = {}) {
  const state = { rows: clone(rows), favourites: clone(favourites), comments: clone(comments), queries: [], released: false };
  let working;
  let writes = 0;
  const client = {
    release() { state.released = true; },
    async query(sql, params = []) {
      state.queries.push(sql);
      if (sql === 'BEGIN') { working = clone(state.rows); return {}; }
      if (sql === 'COMMIT') { state.rows = working; working = null; return {}; }
      if (sql === 'ROLLBACK') { working = null; return {}; }
      if (sql.startsWith('SELECT *')) {
        assert.match(sql, /FOR UPDATE$/);
        return { rows: clone(working.filter((row) => row.whatsapp_message_id === params[0])) };
      }
      if (sql.startsWith('SELECT (SELECT COUNT(*)')) {
        assert.ok(working, 'References must be checked inside the transaction');
        assert.match(sql, /property_favourites WHERE property_id = \$1/);
        assert.match(sql, /property_comments WHERE property_id = \$1/);
        return { rows: [{
          favourites: state.favourites.filter(row => row.property_id === params[0]).length,
          comments: state.comments.filter(row => row.property_id === params[0]).length
        }] };
      }
      writes += 1;
      if (writes === failWrite) throw Object.assign(new Error('unique fingerprint conflict'), { code: '23505' });
      if (sql.startsWith('UPDATE')) {
        const match = sql.match(/^UPDATE normalized_messages SET (.+) WHERE id = \$(\d+) AND whatsapp_message_id = \$(\d+) RETURNING id$/);
        assert.ok(match, sql);
        const row = working.find((item) => item.id === params[Number(match[2]) - 1]
          && item.whatsapp_message_id === params[Number(match[3]) - 1]);
        if (!row) return { rowCount: 0, rows: [] };
        for (const assignment of match[1].split(', ')) {
          const field = assignment.match(/^"([a-z_]+)" = \$(\d+)(?:::jsonb)?$/);
          assert.ok(field, assignment);
          row[field[1]] = clone(params[Number(field[2]) - 1]);
        }
        return { rowCount: 1, rows: [{ id: row.id }] };
      }
      if (sql.startsWith('INSERT')) {
        assert.doesNotMatch(sql, /ON CONFLICT/);
        const columns = sql.match(/^INSERT INTO normalized_messages \((.+)\) VALUES/)[1]
          .split(', ').map((name) => name.replaceAll('"', ''));
        const row = Object.fromEntries(columns.map((column, index) => [column, clone(params[index])]));
        row.id = Math.max(...working.map((item) => item.id)) + 1;
        working.push(row);
        return { rowCount: 1, rows: [{ id: row.id }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  return { state, pool: { connect: async () => client } };
}

test('matches reordered listings by normalized excerpt and preserves card identity', async () => {
  const before = [
    card(1, '*500 yard plot* in DHA', { listing_index: 8, property_status: 'SOLD', geo_lat: 24.8 }),
    card(2, '1000 yard bungalow', { listing_index: 3, property_status: 'HOLD', created_at: new Date('2026-10-02T12:00:00Z') })
  ];
  const next = [extracted('1000 yard bungalow', { price_value: 100 }), extracted('500 yard plot in DHA', { price_value: 50 })];
  const db = fakeDb(before);
  const saved = await saveRows(db, { id: 50 }, before, next);
  assert.deepEqual(saved, { updated: 2, inserted: 0, ids: [1, 2] });
  assert.deepEqual(db.state.rows.map((row) => [row.id, row.listing_index, row.property_status, row.price_value]),
    [[1, 8, 'SOLD', 50], [2, 3, 'HOLD', 100]]);
  assert.deepEqual(db.state.rows.map((row) => row.created_at), before.map((row) => row.created_at));
  assert.equal(db.state.rows[0].geo_lat, 24.8);
  assert.ok(db.state.rows.every((row) => row.model_used === 'openai/test'));
  assert.ok(db.state.released);
  assert.ok(db.state.queries.every((sql) => !/DELETE|property_favourites|property_comments/.test(sql)));
});

test('singleton can change excerpt while protected metadata stays unchanged', async () => {
  const before = [card(1, 'legacy truncated text', { listing_index: 12, property_status: 'SOLD' })];
  const next = [extracted('full corrected offer', { id: 900, listing_index: 9, property_status: 'AVAILABLE', created_at: new Date() })];
  const db = fakeDb(before);
  await saveRows(db, { id: 50 }, before, next);
  assert.equal(db.state.rows[0].id, 1);
  assert.equal(db.state.rows[0].listing_index, 12);
  assert.equal(db.state.rows[0].property_status, 'SOLD');
  assert.deepEqual(db.state.rows[0].created_at, before[0].created_at);
});

test('fingerprints can identify multiple listings when their excerpt formatting changes', () => {
  const old = [card(1, 'old A', { content_fingerprint: 'u4|a|sale' }), card(2, 'old B', { content_fingerprint: 'u4|b|sale' })];
  const next = [extracted('new B', { content_fingerprint: 'u4|b|sale' }), extracted('new A', { content_fingerprint: 'u4|a|sale' })];
  assert.deepEqual(matchRows(old, next).matches.map(({ oldRow, newRow }) => [oldRow.id, newRow.listing_excerpt]),
    [[1, 'new A'], [2, 'new B']]);
});

test('confidently matched cards allow additional listings with unused indexes', async () => {
  const before = [card(1, 'known listing A', { listing_index: 0 }), card(2, 'known listing B', { listing_index: 2 })];
  const next = [extracted('extra listing'), extracted('known listing B'), extracted('known listing A')];
  const db = fakeDb(before);
  const result = await saveRows(db, { id: 50 }, before, next);
  assert.equal(result.inserted, 1);
  assert.deepEqual(db.state.rows.map((row) => [row.id, row.listing_index]), [[1, 0], [2, 2], [3, 1]]);
  assert.equal(db.state.rows[2].model_used, 'openai/test');
});

test('single-card expansion requires its exact normalized excerpt', () => {
  const before = [card(1, 'original full offer', { content_fingerprint: 'same' })];
  assert.throws(() => matchRows(before, [extracted('rewritten offer', { content_fingerprint: 'same' }), extracted('extra')]), /missing extraction match/);
  assert.equal(matchRows(before, [extracted('original full offer'), extracted('extra')]).additions.length, 1);
});

test('missing, duplicate, and empty model listings never replace existing cards', async () => {
  const before = [card(1, 'offer A'), card(2, 'offer B')];
  const cases = [[], [extracted('offer A')], [extracted('offer A'), extracted('offer A')],
    [{ whatsapp_message_id: 50, is_property: false }]];
  for (const next of cases) {
    const db = fakeDb(before);
    await assert.rejects(saveRows(db, { id: 50 }, before, next), /empty extraction|missing extraction match|usable property cards/);
    assert.deepEqual(db.state.rows, before);
    assert.equal(db.state.queries.length, 0);
  }
});

test('two old cards cannot both claim one new listing', () => {
  assert.throws(() => matchRows([card(1, 'same offer'), card(2, 'same offer')],
    [extracted('same offer'), extracted('different offer')]), /Ambiguous/);
});

test('concurrent edits and new sibling cards reject stale snapshots', async () => {
  const before = [card(1, 'offer A')];
  const concurrentStates = [[card(1, 'offer A', { property_status: 'SOLD' })],
    [card(1, 'offer A'), card(2, 'offer B')]];
  for (const current of concurrentStates) {
    const db = fakeDb(current);
    await assert.rejects(saveRows(db, { id: 50 }, before, [extracted('offer A')]), /changed since extraction/);
    assert.deepEqual(db.state.rows, current);
    assert.ok(db.state.queries.includes('ROLLBACK'));
    assert.ok(db.state.released);
  }
});

test('snapshot comparison accepts serialized Dates and different object key order', async () => {
  const before = [card(1, 'offer A', { entities: { z: 1, a: { y: 2, b: 3 } } })];
  const current = [card(1, 'offer A', { entities: { a: { b: 3, y: 2 }, z: 1 } })];
  const db = fakeDb(current);
  await saveRows(db, { id: 50 }, JSON.parse(JSON.stringify(before)), [extracted('offer A')]);
  assert.equal(db.state.rows[0].city, 'Karachi');
});

test('a unique conflict after an earlier update rolls back the entire message', async () => {
  const before = [card(1, 'offer A'), card(2, 'offer B')];
  const db = fakeDb(before, { failWrite: 2 });
  await assert.rejects(saveRows(db, { id: 50 }, before,
    [extracted('offer A'), extracted('offer B')]), /unique fingerprint conflict/);
  assert.deepEqual(db.state.rows, before);
  assert.ok(db.state.queries.includes('ROLLBACK'));
  assert.ok(!db.state.queries.includes('COMMIT'));
});

test('a failed extra-card insert also rolls back updated existing cards', async () => {
  const before = [card(1, 'offer A')];
  const db = fakeDb(before, { failWrite: 2 });
  await assert.rejects(saveRows(db, { id: 50 }, before,
    [extracted('offer A'), extracted('new offer')]), /unique fingerprint conflict/);
  assert.deepEqual(db.state.rows, before);
});

test('wrong-message rows and nontransactional adapters fail before writing', async () => {
  const before = [card(1, 'offer A')];
  const db = fakeDb(before);
  await assert.rejects(saveRows(db, { id: 51 }, before, [extracted('offer A')]), /different WhatsApp message/);
  await assert.rejects(saveRows({ query() { throw new Error('must not run'); } }, { id: 50 }, before,
    [extracted('offer A')]), /transactional database connection/);
  assert.equal(db.state.queries.length, 0);
});

test('reviewed legacy aggregate splits preserve its ID and insert remaining offers after a reference check', async () => {
  for (const status of ['AVAILABLE', null]) {
    const before = [card(1, null, { property_status: status, listing_index: 4 })];
    const next = [extracted('first plot offer'), extracted('second plot offer'), extracted('third plot offer')];
    const db = fakeDb(before, { favourites: [{ property_id: 99 }], comments: [{ property_id: 99 }] });
    const result = await saveRows(db, { id: 50 }, before, next, { allowLegacyAggregateSplit: true });
    assert.deepEqual(result, { updated: 1, inserted: 2, ids: [1, 2, 3] });
    assert.equal(db.state.rows[0].listing_excerpt, 'first plot offer');
    assert.equal(db.state.rows[0].listing_index, 4);
    assert.equal(db.state.rows[0].property_status, status);
    assert.deepEqual(db.state.rows[0].created_at, before[0].created_at);
    assert.deepEqual(db.state.rows.slice(1).map(row => row.listing_excerpt), ['second plot offer', 'third plot offer']);
    const referenceCheck = db.state.queries.findIndex(sql => sql.startsWith('SELECT (SELECT COUNT(*)'));
    const firstWrite = db.state.queries.findIndex(sql => sql.startsWith('UPDATE'));
    assert.ok(referenceCheck > 0 && referenceCheck < firstWrite);
    assert.equal(db.state.queries.at(-1), 'COMMIT');
  }
});

test('legacy aggregate splitting requires an explicit true option', async () => {
  const before = [card(1, null)];
  const next = [extracted('first plot offer'), extracted('second plot offer')];
  for (const options of [undefined, {}, { allowLegacyAggregateSplit: false }, { allowLegacyAggregateSplit: 'true' }]) {
    const db = fakeDb(before);
    await assert.rejects(saveRows(db, { id: 50 }, before, next, options), /Ambiguous or missing extraction match/);
    assert.deepEqual(db.state.rows, before);
    assert.equal(db.state.queries.length, 0);
  }
});

test('legacy aggregate splitting refuses favourites or comments belonging to any user', async () => {
  const before = [card(1, null)];
  const next = [extracted('first plot offer'), extracted('second plot offer')];
  for (const references of [
    { favourites: [{ property_id: 1, user_id: 7 }] },
    { comments: [{ property_id: 1, user_id: 4, comment: 'private note' }] }
  ]) {
    const db = fakeDb(before, references);
    await assert.rejects(saveRows(db, { id: 50 }, before, next, { allowLegacyAggregateSplit: true }), /has favourites or comments/);
    assert.deepEqual(db.state.rows, before);
    assert.deepEqual(db.state.favourites, references.favourites || []);
    assert.deepEqual(db.state.comments, references.comments || []);
    assert.ok(!db.state.queries.some(sql => /^(UPDATE|INSERT)/.test(sql)));
    assert.equal(db.state.queries.at(-1), 'ROLLBACK');
  }
});

test('legacy aggregate option cannot overwrite explicit status or an unrelated listing excerpt', () => {
  const next = [extracted('first plot offer'), extracted('second plot offer')];
  for (const status of ['SOLD', 'HOLD', 'RESERVED']) {
    assert.throws(() => matchRows([card(1, null, { property_status: status })], next,
      { allowLegacyAggregateSplit: true }), /non-default property status/);
  }
  for (const excerpt of ['previous offer', '*']) {
    assert.throws(() => matchRows([card(1, excerpt)], next,
      { allowLegacyAggregateSplit: true }), /no listing excerpt/);
  }
});

test('reviewed aggregate header matches its unique offer even when that offer is not first', async () => {
  const header = '*APARTMENTS FOR SALE* in DHA Phase Six Bukhari Commercial';
  const before = [card(1, header)];
  const next = [
    extracted('Second floor apartment demand 4 crore'),
    extracted('Apartments for sale in DHA Phase Six Bukhari Commercial first floor demand 3 crore'),
    extracted('Third floor apartment demand 5 crore')
  ];
  const db = fakeDb(before);
  const result = await saveRows(db, { id: 50 }, before, next, { allowLegacyAggregateSplit: true });
  assert.deepEqual(result, { updated: 1, inserted: 2, ids: [1, 2, 3] });
  assert.equal(db.state.rows[0].listing_excerpt, next[1].listing_excerpt);
  assert.deepEqual(db.state.rows.slice(1).map(row => row.listing_excerpt), [next[0].listing_excerpt, next[2].listing_excerpt]);
  assert.ok(db.state.queries.some(sql => sql.startsWith('SELECT (SELECT COUNT(*)')));
});

test('aggregate header matching rejects short headers, missing prefixes, and ambiguous prefixes', () => {
  const header = 'Apartments for sale in DHA Phase Six Bukhari Commercial';
  for (const [oldExcerpt, excerpts] of [
    ['Short header', ['Short header first offer', 'Different offer']],
    [header, ['Unrelated first offer', 'Unrelated second offer']],
    [header, [`${header} first floor`, `${header} second floor`]]
  ]) {
    assert.throws(() => matchRows([card(1, oldExcerpt)], excerpts.map(excerpt => extracted(excerpt)),
      { allowLegacyAggregateSplit: true }), /unique matching header of at least 40 characters/);
  }
});

test('a uniquely matched aggregate header still cannot split an annotated card', async () => {
  const header = 'Apartments for sale in DHA Phase Six Bukhari Commercial';
  const before = [card(1, header)];
  const next = [extracted(`${header} first floor`), extracted('Second floor apartment')];
  const db = fakeDb(before, { comments: [{ property_id: 1, comment: 'saved note' }] });
  await assert.rejects(saveRows(db, { id: 50 }, before, next,
    { allowLegacyAggregateSplit: true }), /has favourites or comments/);
  assert.deepEqual(db.state.rows, before);
  assert.equal(db.state.queries.at(-1), 'ROLLBACK');
});

test('legacy aggregate splitting still rejects a concurrently changed card', async () => {
  const before = [card(1, null)];
  const current = [card(1, null, { property_status: 'SOLD' })];
  const db = fakeDb(current);
  await assert.rejects(saveRows(db, { id: 50 }, before,
    [extracted('first plot offer'), extracted('second plot offer')], { allowLegacyAggregateSplit: true }), /changed since extraction/);
  assert.deepEqual(db.state.rows, current);
  assert.ok(!db.state.queries.some(sql => /^(UPDATE|INSERT)/.test(sql)));
  assert.equal(db.state.queries.at(-1), 'ROLLBACK');
});
