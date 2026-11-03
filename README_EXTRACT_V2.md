# Extract v2 — install & run

Copy these folders into the repo root (`whatsapp_scrapper_backend`), keeping paths:
`ai/extract/`, `scripts/renormalize.js`, `migrations/2026_10_08_extract_v2.sql`, `tests/`.

## 1. Env (.env)
```
EXTRACT_PROVIDER=gemini            # or anthropic
EXTRACT_MODEL=<model id>           # e.g. a Gemini Flash id, or claude-haiku-5-5
GEMINI_API_KEYS=...                # already set on prod
ANTHROPIC_API_KEY=...              # only if provider=anthropic
```

## 2. Order of operations (local first, then Contabo)
1. `node --test tests/`                                   # 26 tests, no network needed
2. `pg_dump` the DB, then `psql "$DATABASE_URL" -f migrations/2026_10_08_extract_v2.sql`
3. Dry run (writes nothing): `node scripts/renormalize.js --user 4 --limit 50`
   Open `renormalize-report-*.jsonl`, compare to the raw messages. Fix prompt/parsers, repeat.
4. Real run: `node scripts/renormalize.js --user 4 --apply`
   - makes `normalized_messages_bak_YYYYMMDD` first
   - resumable: re-run the same command, finished messages are skipped
   - failed ids go to `renormalize-failed-*.txt`
5. Check: `SELECT count(*) FILTER (WHERE price_value IS NULL)::float/count(*) FROM normalized_messages WHERE is_property AND extract_version=2;`
   and `SELECT * FROM normalized_messages WHERE needs_review ORDER BY id DESC LIMIT 50;`

## 3. New messages (so the backlog does not refill with bad rows)
In `ai/normalizer.js` `normalizeOne`, replace the cascade call with:
```js
const { extractMessage, buildRows } = require('./extract/extractor');
const { saveMessageRows } = require('./extract/persist');
const { extraction, model } = await extractMessage(job);
const rows = buildRows(extraction, { messageId: job.id, chatJid: job.chat_jid, sender: job.sender,
  senderPhone: job.sender_phone, messageText: job.message, chatDefaultCity: 'Karachi',
  userId: job.user_id, model });
await saveMessageRows(db, job.id, rows);
```
(Look up `whatsapp_chats.default_city` per chat if you want it per group.)

## Not covered yet
- Search still uses the old text matching until the search rewrite (phase/society columns are filled, not yet used).
- `place_tags` is intentionally left empty on v2 rows (old resolver re-creates the Phase 5/6 leak).
- Never run against a live API/DB from the sandbox: adapters and script are syntax-checked and unit-tested with mocks only.
