# PropSync / WhatsApp Scraper — Technical Review Brief

**Audience:** External reviewer (Claude) auditing scrape → normalize → search quality.  
**Repos:** `/Users/mac/whatsapp_scrapper_backend` (API + AI pipeline). Frontend is separate: **PropSync** (`/Users/mac/PropSync`, Vercel).  
**Prod:** Contabo VPS `194.233.90.150` — Node API (PM2 `whatsapp-backend`), Baileys worker (`whatsapp-worker`), Postgres, Cloudflare quick tunnel for HTTPS to the FE.

---

## 1. What the product does

PropSync turns WhatsApp realtor group chats into searchable property cards.

1. User links WhatsApp (QR) via a Baileys **worker**.
2. Worker scrapes monitored chats → backend stores raw messages.
3. Background **normalize** pipeline turns messages into structured listings.
4. Dashboard **search** filters those listings (purpose, city, location/phase, type, price, area).

Multi-tenant: every message/listing is scoped to `user_id` (e.g. Danish = user 4).

---

## 2. System components

| Component | Role | Location |
|-----------|------|----------|
| Express API + Socket.IO | Auth, QR claim, scrape ingest, search, normalize status | `server.js` |
| Baileys worker | WhatsApp session, QR, scrape loop | External process; `WORKER_BASE_URL` + `WORKER_API_KEY` |
| Postgres | Source of truth | `db.js` / `DATABASE_URL` |
| In-process AI pipeline | Claim → cascade normalize → place tags | `ai/pipelineWorker.js`, `ai/normalizer.js` |
| PropSync FE | Dashboard search UI | Separate Vite/React app |

**Core tables**

- `whatsapp_chats` — chats, `is_monitored`, monitor letter
- `whatsapp_messages` — raw bodies, timestamps, `seq_in_chat`
- `normalized_messages` — structured listings (`is_property`, purpose, area, vicinity, size*, price*, `place_tags`, fingerprints, listing splits)
- `normalize_jobs` / `normalize_claims` — per-user job + per-message lease
- `place_regions` — cached parent→children hierarchy (seeded from JSON)
- `whatsapp_scrape_health` — worker heartbeat (stale ~90s → FE shows scrape broken)

---

## 3. Scraping flow

```
FE QR claim → API notifyWorker(start)
  → Worker Baileys session
  → Worker POST /api/scraped-chats/messages (x-user-id / worker headers)
  → findOrCreateCanonicalChat
  → INSERT whatsapp_messages (dedupe fingerprint + unique constraint)
  → seqHelper assigns monitor_letter + seq_in_chat
  → queueNormalizeJob + wakePipeline(userId)
```

**Important behaviors**

- Only **monitored** chats are intended for ongoing scrape/normalize product use.
- Ingest dedupe: content fingerprint vs recent bodies + DB uniqueness on `(user_id, chat_jid, sender, timestamp, message)`.
- Same body with a **new timestamp** can still insert (fingerprint layer mitigates but is not perfect).
- Scrape health heartbeat: if worker stops posting, portal shows linked-but-not-scraping.

**Key files:** `server.js` (ingest), `contactHelper.js`, `seqHelper.js`, `contentFingerprint.js`.

---

## 4. Normalization flow

### 4.1 Queue

- Per-user `normalize_jobs` (`queued` → `running` → `completed`/`failed`).
- Per-message `normalize_claims` with stale lease (`CLAIM_STALE_SECONDS`).
- Worker: `ai/pipelineWorker.js` — wake on ingest or poll `PIPELINE_POLL_MS`.
- Boot starts pipeline unless `AI_PIPELINE=off`.

### 4.2 Cascade (saved as `model_used = 'cascade'`)

Implemented in `ai/normalizer.js` → `cascadeNormalizeText`:

| Stage | Module | Behavior |
|-------|--------|----------|
| 1. Gemini | `ai/geminiClient.js` | Primary extract if API keys set; rotate keys on 429, models on 5xx |
| 2. Qwen (Together) | `ai/llmClient.js` | **Fill gaps only** (`cascadeMerge.fillGapsOnly`) |
| 3. Local NER | `ai/localNer.js` | Regex/gazetteer fill for purpose, type, size, price, places |
| 4. Geocode refine | `ai/geocodeClient.js` | Photon + Nominatim; score vs message; should not blind-overwrite strong fields |
| 5. DHA phase enrich | `ai/placeRegions.enrichSchemaWithLocalDhaPhase` | Force correct phase for known commercials (e.g. Rahat → Phase 6) |

**Multi-offer split:** `ai/listingSplitter.js` splits one WhatsApp blob into chunks (blank lines / size markers) → multiple `normalized_messages` rows (`listing_index`, `listing_excerpt`).

**Place resolve (async after save):** `ai/placeResolver.js`

- Builds `place_tags` from area/vicinity/city via local gazetteer.
- Optionally Google lat/lng if `GOOGLE_MAPS_API_KEY` (search path never calls Maps).
- Seeds `place_regions` from `ai/placeRegions.js` + `data/dhaKarachiRegions.json`.

**Canonical place text:** `pakistanLocalities.js` (typo fix, khayaban expand, DB-learned names).

### 4.3 Fields that matter for search quality

- `purpose` (SALE/RENT), `property_type`, `property_sub_type`
- `city`, `area`, `vicinity` — often polluted by OSM (“کراچی ڈویژن”) or wrong phase
- `size`, `size_value`, `size_unit` — area filters depend on these
- `price`, `price_value` — price filters parse from these + raw message
- `place_tags[]` — used heavily in location SQL
- `content_fingerprint` / listing fingerprints — dedupe at save and search
- `is_property` — search only returns `is_property IS TRUE`

---

## 5. Search flow

### 5.1 Endpoints

- `POST/GET /api/properties/filter` (and `/api/properties`)
- `POST/GET /api/dashboard-search` (+ `/ml-api/...` aliases for FE)
- `GET /api/places/suggest` — location autocomplete with inventory counts

All share `runPropertySearch` in `server.js`.

### 5.2 SQL layer (`buildPropertySearchWhere`)

Filters in SQL:

- `user_id`, `is_property = true`
- purpose, city, property type/subtype, status
- **location** via `smartLocationSearch.js` + `placeRegions.classifyLocationQuery`

Location modes:

- **Parent** (e.g. “Phase 5”, “DHA”, “Malir”): expand to children from `dhaKarachiRegions.json` / seed. For DHA phase parents, `phaseNumber` is cleared so child-only listings still match.
- **Exact** locality: tighter terms (Bukhari, Rahat, …).
- Match blob: area, vicinity, city, summary, excerpt, `place_tags`, raw message.

**Not in SQL:** `priceMin`/`priceMax`, `areaMin`/`areaMax`.

### 5.3 JS post-processing (`propertyHelper.filterAndSortProperties`)

1. Parse price → PKR (`parsePriceInPKR`).
2. Parse area → target unit (`parseAreaInUnit`; internal Marla pivot: 1 Marla = 25 Sq Yd = 225 Sq Ft). Prefer `size_value`+`size_unit` when present.
3. Drop noise cards (`isListingNoise`).
4. Apply price/area ranges (exact when min=max, small epsilon).
5. Same-body dedupe (`bodyDedupeKey` / fingerprint / near-containment).
6. Sort (newest / price / relevance keep).

### 5.4 Pagination design (fragility)

- Oversample from SQL (`need * 20`, caps ~8k–25k) → JS filter/dedupe → `slice(offset, limit)`.
- When price/area filters present, reported `totalMatched` uses post-filter pool size (not raw SQL COUNT).
- Deep offsets can still underfill pages if the oversample window is junk/dups.

### 5.5 FE (PropSync)

- One-screen dashboard: filters + results on `/dashboard` (no navigate-away to `/results`).
- Area unit default **Sq. Ft.**; sends `areaMin`/`areaMax`/`areaUnit` on advanced search.
- Live API: `VITE_SCRAPPER_URL` → Cloudflare tunnel hostname (changes if quick tunnel restarts).

---

## 6. Local DHA gazetteer (critical for location quality)

File: `data/dhaKarachiRegions.json`

- Parent keys: `dha`, `phase-1` … `phase-9`, `khayaban`, plus code seed for Malir/Airport/Clifton.
- Children = commercial belts / khayabans used for **search expand** and **place_tags**.
- Intended ground truth examples:
  - **Phase 6:** Rahat, Bukhari, Ittehad, Shahbaz, Nishat, Sehar commercials
  - **Phase 5:** Badar, Tauheed, Zamzama, Khadda, …

**Bug class we hit in prod:** Rahat Commercial tagged as Phase 5 because:

1. Gazetteer historically listed `rahat` under wrong phases / missing under Phase 6.
2. LLM/OSM geocode invented `phase-5` into `area`/`vicinity`.
3. `place_regions` seed used to **merge** children (stale wrong children stuck in DB). Now seed **replaces** children.

Mitigations in code (may not be deployed to Contabo yet):

- Corrected JSON mapping
- `enrichSchemaWithLocalDhaPhase` after geocode
- `PRIMARY_LOCALITY_PHASE` map for unambiguous commercials
- City scrub: `کراچی ڈویژن` / “Karachi Division” → `Karachi`
- Script: `scripts/fix_dha_phase_tags.js` to re-tag existing rows

---

## 7. Known issue themes (for the reviewer)

Use these as review targets — they match real production pain:

### A. Location / phase wrongness

- Geocode + LLM invent phases not present in the WhatsApp text.
- Gazetteer ambiguity (same street name across phases).
- Parent expand for “Phase 5” pulling Phase-6 commercials if children lists are wrong or DB seed is stale.
- City field polluted with admin divisions (Urdu/OSM).
- Search relevance: Bahria vs DHA phase guards; street/phase text guards on raw message.

### B. Area / size quality

- Many cards show **Area N/A** when size is written as `850 & 300 sqfeet`, `500 yards`, bare numbers, etc.
- Area range filter is **JS-only** after oversample — easy to miss matches or show wrong totals historically.
- Unit confusion: Marla vs Sq Ft vs Sq Yd; FE wants Sq Ft; NER converts Marla→Sq Ft (×225).
- `size_value`/`size_unit` must be selected in SQL for filters to see structured sizes (added in recent code).

### C. Deduping vs recall

- Aggressive same-body dedupe can collapse near-identical offers (good for UX, bad if distinct inventories share templates).
- Ingest uniqueness allows same text at different times → normalize may create near-dup listings until search dedupe.

### D. Pipeline / ops

- Contabo SSH/SCP often stalls; deploys can leave truncated `server.js` (syntax crash) or old code live while health still 200.
- Cloudflare **quick tunnel** hostname changes on restart → FE env must update.
- Normalize status UI may disagree with reality if it counts by `NORMALIZE_MODEL` string while rows save as `model_used='cascade'`.
- Embeddings path may skip (`localhost` Ollama) or filter wrong `model_used`.
- `/api/normalize/trigger` historically may not wake pipeline the same way ingest does (poll-dependent).
- Gemini often unconfigured → cascade falls to Qwen/NER only (`llmConfigured: false` seen on health).

### E. Search UX / API contract

- Empty browse = user’s listings (paginated); location search expands phases.
- FE one-screen search vs old `/results` redirect.
- Advanced search area range + exact min=max must round-trip FE → dashboard-search → JS filter.

---

## 8. End-to-end dataflow (one diagram)

```
WhatsApp groups
    │ Baileys worker
    ▼
whatsapp_messages  ──wake──► normalize_jobs / normalize_claims
    │                              │
    │                              ▼
    │                    Gemini → Qwen → NER → Geocode → DHA enrich
    │                              │
    │                              ▼
    │                    normalized_messages (+ listing splits)
    │                              │
    │                              ▼
    │                    place_tags / place_regions (async)
    │                              │
    └──────────── search ◄─────────┘
                 SQL location/purpose/type
                 + JS price/area/noise/dedupe
                 + PropSync cards
```

---

## 9. Key files cheat-sheet

| Path | Why it matters |
|------|----------------|
| `server.js` | Ingest, search WHERE, oversample, dashboard-search shape |
| `propertyHelper.js` | Price/area parse, range filter, dedupe, noise |
| `smartLocationSearch.js` | Location query → SQL fragments + scoring |
| `ai/normalizer.js` | Cascade + save |
| `ai/localNer.js` | Deterministic extract (size/price/place) |
| `ai/geocodeClient.js` | OSM/Photon refine (phase invention risk) |
| `ai/placeRegions.js` | Hierarchy, tags, phase enrich |
| `ai/placeResolver.js` | Persist tags; reseed place_regions |
| `ai/listingSplitter.js` | Multi-offer cards |
| `data/dhaKarachiRegions.json` | Ground-truth-ish DHA map |
| `contentFingerprint.js` | Ingest + listing dedupe keys |
| `normalizeHelper.js` | Job queue / status counts |
| `ai/pipelineWorker.js` | Background drain |

---

## 10. Env flags that change behavior

- `AI_PIPELINE=local|off` — in-process worker
- `GEMINI_API_KEYS` / `GEMINI_MODELS` — stage 1
- `LLM_BASE_URL` / `LLM_API_KEY` / `NORMALIZE_MODEL` — Qwen
- `GEOCODE_ENABLED` — Photon/Nominatim
- `PLACE_RESOLVE_ENABLED` — place_tags job
- `GOOGLE_MAPS_API_KEY` — optional lat/lng only (not search expand)
- `WORKER_BASE_URL` / `WORKER_API_KEY` — Baileys control
- `CLAIM_STALE_SECONDS`, `JOB_STALE_SECONDS`, `PIPELINE_POLL_MS`, `NORMALIZE_CONCURRENCY`

---

## 11. Suggested review questions for Claude

1. Should price/area filters move into SQL (generated columns / normalized numeric fields) instead of JS oversample?
2. How should we prevent geocode/LLM from writing a phase that is **not** in the message when a commercial name uniquely implies a phase?
3. Is parent→children expansion the right search model, or should we search `place_tags` + explicit phase only?
4. What’s the right dedupe policy: fingerprint at ingest vs listing content vs same-body at search?
5. How do we make normalize status / pending counts trustworthy with `model_used='cascade'`?
6. Multi-offer split: when does splitting hurt (false splits) vs help?
7. Deployment: how to avoid truncated uploads and gazetteer/DB seed drift on Contabo?
8. Size extraction: robust patterns for `850 & 300 sqfeet`, `500 yards`, unit-less numbers + `size_unit` column.

---

## 12. Recent fixes (local; verify Contabo before assuming live)

- One-screen FE search; Sq Ft default; area range payload always sends unit.
- Area parse uses `size_value`/`size_unit`; exact min=max; SQL selects those columns.
- DHA gazetteer correction + phase enrich + city scrub + size `&` / `sqfeet` NER.
- Place seed replace (not merge) children.
- Same-body listing dedupe + trash purge scripts (ops).

**As of last check:** Contabo API was healthy, but some of the above DHA/area fixes had **not** finished uploading due to flaky SCP — treat prod behavior as possibly older than this brief.

---

## 13. How to reproduce quality bugs

1. Search **Phase 5** vs **Rahat Commercial** — watch for Phase-6 commercials wrongly under Phase 5.
2. Open a card whose WhatsApp text has no phase but UI shows `rahat, phase-5`.
3. Advanced search area min=max (e.g. 500 Sq Yd) — compare count vs visible cards.
4. Message with `*850 & 300* sqfeet` — check whether `size_value` is null.
5. Empty dashboard browse vs location search — pagination totals and dup cards.

---

*End of brief. Point the reviewer at this file + the repo root; ask for architecture risks, correctness bugs, and a prioritized fix plan.*
