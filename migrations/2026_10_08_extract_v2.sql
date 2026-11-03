-- Extract v2 migration. Idempotent: safe to run more than once.
-- Run:  psql "$DATABASE_URL" -f migrations/2026_10_08_extract_v2.sql
-- Take a pg_dump first. The renormalize script also makes its own table backup.

BEGIN;

-- ---- listing semantics -------------------------------------------------------
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS listing_kind   text;        -- OFFER | REQUIREMENT
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS city_source    text;        -- explicit | default | fallback

-- ---- structured location (filled by code, never by the geocoder) -------------
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS society_key    text;        -- dha | dha-city | bahria-town | ...
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS phase          smallint;    -- only when written in the message
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS location_text  text;        -- "Rahat Commercial" as written
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS street_text    text;
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS locality_ids   integer[];   -- next step: gazetteer ids
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS location_ambiguous boolean DEFAULT false;

-- ---- numeric columns that search can filter in SQL ---------------------------
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS price_min      double precision;
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS price_max      double precision;
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS price_basis    text;        -- TOTAL | PER_MONTH | PER_SQ_YD | PER_FLOOR | ...
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS price_inferred boolean DEFAULT false;
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS size_sqft      double precision;

-- ---- debugging / quality -----------------------------------------------------
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS needs_review   boolean DEFAULT false;
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS extract_version smallint;   -- 2 = extract v2
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS extract_trace  jsonb;       -- model, warnings, raw LLM listing

-- ---- per-chat default city ---------------------------------------------------
ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS default_city text;
-- ASSUMPTION: all current chats are Karachi groups. Change per chat if one is not.
UPDATE whatsapp_chats SET default_city = 'Karachi' WHERE default_city IS NULL;

-- ---- indexes (partial: search only reads property rows) ----------------------
CREATE INDEX IF NOT EXISTS idx_nm_society_phase ON normalized_messages (society_key, phase)  WHERE is_property IS TRUE;
CREATE INDEX IF NOT EXISTS idx_nm_price_range   ON normalized_messages (price_min, price_max) WHERE is_property IS TRUE;
CREATE INDEX IF NOT EXISTS idx_nm_size_sqft     ON normalized_messages (size_sqft)            WHERE is_property IS TRUE;
CREATE INDEX IF NOT EXISTS idx_nm_locality_ids  ON normalized_messages USING gin (locality_ids);
CREATE INDEX IF NOT EXISTS idx_nm_needs_review  ON normalized_messages (needs_review)         WHERE needs_review IS TRUE;
CREATE INDEX IF NOT EXISTS idx_nm_extract_ver   ON normalized_messages (extract_version);

COMMIT;
