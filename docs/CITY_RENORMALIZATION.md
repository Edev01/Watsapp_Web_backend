# Non-Karachi city re-normalization

Task recovered from Cursor on 2026-10-13: re-extract Danish's 73 property
messages with non-Karachi cities using OpenAI, and identify the configured API.

The live server uses `gpt-4o-mini` at the OpenAI Chat Completions endpoint
`https://api.openai.com/v1/chat/completions`. This batch explicitly uses OpenAI;
the live worker's existing Gemini → OpenAI → Together fallback order is unchanged.

## Current result

Completed on 2026-10-13 after API credits were replenished: **73/73 messages
succeeded, zero failures or remaining messages**. The original cohort contained
52 Lahore, 16 Islamabad, and 5 Rawalpindi cards, all belonging to Danish (user 4).
The server preflight confirmed that each selected message had exactly one card
with a populated non-Karachi city.

Re-extraction with `gpt-4o-mini` produced **122 property listings**, including
49 additional listings split from multi-property messages. All 73 original IDs,
listing indexes, statuses and creation dates were preserved. The 1,751 existing
cards outside the selected cohort were verified unchanged by row fingerprints.

Final city fields: **97 unstated, 7 Lahore, 18 Rawalpindi**. The 67 original cards
whose old city was unsupported now have a null city. Explicit Lahore/Rawalpindi
locations, including the abbreviation Rwp, were retained. Locality fields remain
available when the message does not state a city.

Nine first-pass failures were reviewed against their source messages and retried
with scoped extraction instructions. Legacy aggregate splits required explicit
review, an available status and no favourites/comments. A final local evidence
check cleared nine inferred Karachi city fields; all other extracted fields were
preserved. An additional OpenAI audit was rejected by automatic approval review
over sharing message contents for an additional purpose; no such audit was sent.

On the server, the private directory
`/home/omer/whatsapp_scrapper_backend/logs/city-repair-20261013/` contains:

- `before.json`: original messages, normalized rows, and favourite/comment references.
- `summary.json`: attempted messages, failures, and remaining count.
- `unchanged-verification.json`: comparison of all original cards with the database after the failed run.
- `outside-before.json` and `verification.json`: excluded-card fingerprints and the successful final checks.
- `reviewed.json`: source-based notes for the nine retried messages.
- `city-local-evidence-before.json` and `city-local-evidence-review.json`: backup and audit trail for the nine unsupported city guesses cleared locally.
- Per-message extraction and completion files as successful work occurs.

The execution log is `/tmp/renorm-city.log`.

## Resumption command (completed run skips every message)

Run from the backend directory on the server:

```sh
node scripts/renormalize_non_karachi.js --apply --run-dir logs/city-repair-20261013
```

Reuse the same run directory. Completed message IDs are skipped even when their
correct city remains Lahore or Rawalpindi. Cached successful extractions avoid
repeating API calls. API credit failures stop the batch at the first failed
message; any unfinished work results in a nonzero exit status.

The script snapshots before writes and updates existing card IDs transactionally,
preserving statuses, creation dates, favourites and comments. It refuses empty
extractions, ambiguous multi-listing matches, stale snapshots and uniqueness
conflicts instead of deleting or silently discarding cards. Such failures need
inspection before resuming. A crash between database commit and checkpoint write
also requires reconciling that message against its saved extraction.

Validation: `node --test tests/` — 70 tests passed, including 28 tests for the
one-off batch, identity preservation, rollback, resumption, exhausted credits,
scoped review retries and legacy aggregate splitting.
