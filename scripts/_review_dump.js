#!/usr/bin/env node
/**
 * Read-only dump for REVIEW_DETAILS.md — no writes.
 * Output: JSON to stdout.
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function redactPhone(s) {
  return String(s || '').replace(/(\+?92|0)?3\d{2}[-\s]?\d{7}/g, '03XX-XXXXXXX');
}

function redactRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const k of Object.keys(out)) {
    if (/phone|contact|sender/i.test(k) && typeof out[k] === 'string') {
      out[k] = redactPhone(out[k]);
    }
    if (typeof out[k] === 'string' && /message|summary|excerpt|raw/i.test(k)) {
      out[k] = redactPhone(out[k]);
    }
  }
  return out;
}

async function q(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

async function one(sql, params = []) {
  const rows = await q(sql, params);
  return rows[0] || null;
}

async function main() {
  const out = {
    generated_at: new Date().toISOString(),
    env: {
      NODE_VERSION: process.version,
      AI_PIPELINE: process.env.AI_PIPELINE || null,
      NORMALIZE_CONCURRENCY: process.env.NORMALIZE_CONCURRENCY || null,
      NORMALIZE_PER_USER: process.env.NORMALIZE_PER_USER || null,
      PIPELINE_POLL_MS: process.env.PIPELINE_POLL_MS || null,
      CLAIM_STALE_SECONDS: process.env.CLAIM_STALE_SECONDS || null,
      JOB_STALE_SECONDS: process.env.JOB_STALE_SECONDS || null,
      DEFAULT_MODEL: process.env.DEFAULT_MODEL || null,
      NORMALIZE_MODEL: process.env.NORMALIZE_MODEL || null,
      LLM_BASE_URL: process.env.LLM_BASE_URL || null,
      LLM_API_KEY_SET: Boolean(process.env.LLM_API_KEY),
      GEMINI_API_KEYS_SET: Boolean(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_1),
      GOOGLE_MAPS_API_KEY_SET: Boolean(process.env.GOOGLE_MAPS_API_KEY),
      GEOCODE_ENABLED: process.env.GEOCODE_ENABLED || null,
      PLACE_RESOLVE_ENABLED: process.env.PLACE_RESOLVE_ENABLED || null,
      EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || null,
      WORKER_BASE_URL: process.env.WORKER_BASE_URL || null,
      WORKER_API_KEY_SET: Boolean(process.env.WORKER_API_KEY)
    }
  };

  // Postgres version + extensions
  out.pg_version = (await one('SELECT version() AS v'))?.v || null;
  out.pg_extensions = await q('SELECT extname, extversion FROM pg_extension ORDER BY extname');

  // VPS-ish: from /proc if available
  try {
    const mem = fs.readFileSync('/proc/meminfo', 'utf8');
    const cpu = fs.readFileSync('/proc/cpuinfo', 'utf8');
    out.vps = {
      mem_total: (mem.match(/MemTotal:\s+(\d+)/) || [])[1] || null,
      mem_available: (mem.match(/MemAvailable:\s+(\d+)/) || [])[1] || null,
      cpu_cores: (cpu.match(/^processor\s*:/gm) || []).length
    };
  } catch {
    out.vps = null;
  }

  // DDL via information_schema + pg_indexes
  const tables = [
    'whatsapp_chats',
    'whatsapp_messages',
    'normalized_messages',
    'normalize_jobs',
    'normalize_claims',
    'place_regions',
    'whatsapp_scrape_health'
  ];
  out.schema = {};
  for (const t of tables) {
    const cols = await q(
      `SELECT column_name, data_type, udt_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1
       ORDER BY ordinal_position`,
      [t]
    );
    const indexes = await q(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname`,
      [t]
    );
    // Try pg_get_tabledef alternative: reconstruct approximate CREATE from columns
    let createSql = null;
    try {
      const r = await one(
        `SELECT 'CREATE TABLE ' || quote_ident(c.relname) || E' (\\n' ||
                string_agg('  ' || quote_ident(a.attname) || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
                  || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END, E',\\n' ORDER BY a.attnum)
                || E'\\n);' AS ddl
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         WHERE n.nspname='public' AND c.relname=$1 AND c.relkind='r'
         GROUP BY c.relname`,
        [t]
      );
      createSql = r?.ddl || null;
    } catch (_) {}
    out.schema[t] = { columns: cols, indexes, approximate_create: createSql, exists: cols.length > 0 };
  }

  // Stats
  out.stats = {
    messages: (await one('SELECT COUNT(*)::int AS c FROM whatsapp_messages'))?.c,
    normalized_rows: (await one('SELECT COUNT(*)::int AS c FROM normalized_messages'))?.c,
    is_property: (await one('SELECT COUNT(*)::int AS c FROM normalized_messages WHERE is_property IS TRUE'))?.c,
    per_user_messages: await q(
      `SELECT user_id, COUNT(*)::int AS c FROM whatsapp_messages GROUP BY user_id ORDER BY c DESC`
    ),
    per_user_properties: await q(
      `SELECT m.user_id, COUNT(*)::int AS c
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
       WHERE n.is_property IS TRUE
       GROUP BY m.user_id ORDER BY c DESC`
    ),
    per_model_used: await q(
      `SELECT COALESCE(model_used,'(null)') AS model_used, COUNT(*)::int AS c
       FROM normalized_messages GROUP BY model_used ORDER BY c DESC`
    )
  };

  const propNulls = await one(`
    SELECT
      COUNT(*)::int AS total_prop,
      ROUND(100.0 * COUNT(*) FILTER (WHERE price_value IS NULL) / NULLIF(COUNT(*),0), 2) AS pct_null_price_value,
      ROUND(100.0 * COUNT(*) FILTER (WHERE size_value IS NULL) / NULLIF(COUNT(*),0), 2) AS pct_null_size_value,
      ROUND(100.0 * COUNT(*) FILTER (WHERE area IS NULL OR TRIM(area)='') / NULLIF(COUNT(*),0), 2) AS pct_null_empty_area,
      ROUND(100.0 * COUNT(*) FILTER (WHERE place_tags IS NULL OR cardinality(place_tags)=0) / NULLIF(COUNT(*),0), 2) AS pct_empty_place_tags,
      ROUND(100.0 * COUNT(*) FILTER (WHERE purpose IS NULL OR TRIM(purpose)='') / NULLIF(COUNT(*),0), 2) AS pct_null_purpose,
      ROUND(100.0 * COUNT(*) FILTER (WHERE property_type IS NULL OR TRIM(property_type)='') / NULLIF(COUNT(*),0), 2) AS pct_null_property_type,
      ROUND(100.0 * COUNT(*) FILTER (WHERE geo_lat IS NOT NULL) / NULLIF(COUNT(*),0), 2) AS pct_with_geo_lat
    FROM normalized_messages WHERE is_property IS TRUE`);
  out.stats.property_null_pct = propNulls;

  out.stats.top_area = await q(
    `SELECT COALESCE(NULLIF(TRIM(area),''),'(empty)') AS area, COUNT(*)::int AS c
     FROM normalized_messages WHERE is_property IS TRUE
     GROUP BY 1 ORDER BY c DESC LIMIT 30`
  );
  out.stats.top_vicinity = await q(
    `SELECT COALESCE(NULLIF(TRIM(vicinity),''),'(empty)') AS vicinity, COUNT(*)::int AS c
     FROM normalized_messages WHERE is_property IS TRUE
     GROUP BY 1 ORDER BY c DESC LIMIT 30`
  );
  out.stats.top_city = await q(
    `SELECT COALESCE(NULLIF(TRIM(city),''),'(empty)') AS city, COUNT(*)::int AS c
     FROM normalized_messages WHERE is_property IS TRUE
     GROUP BY 1 ORDER BY c DESC LIMIT 20`
  );

  out.stats.msg_len = await one(`
    SELECT ROUND(AVG(length(message)))::int AS avg_len,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY length(message))::int AS p95_len
    FROM whatsapp_messages WHERE message IS NOT NULL`);

  out.stats.messages_per_day_14d = await q(`
    SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS c
    FROM whatsapp_messages
    WHERE created_at > NOW() - INTERVAL '14 days'
    GROUP BY 1 ORDER BY 1`);

  out.stats.duplicate_fingerprint = await one(`
    SELECT
      COUNT(*)::int AS property_rows,
      COUNT(*) FILTER (WHERE content_fingerprint IS NOT NULL)::int AS with_fp,
      COUNT(*) - COUNT(DISTINCT content_fingerprint) FILTER (WHERE content_fingerprint IS NOT NULL) AS dup_extra_rows
    FROM normalized_messages WHERE is_property IS TRUE`);

  out.stats.top_chats = await q(`
    SELECT c.name, c.jid, COUNT(m.id)::int AS messages, BOOL_OR(c.is_monitored) AS monitored
    FROM whatsapp_chats c
    JOIN whatsapp_messages m ON m.chat_jid = c.jid AND m.user_id = c.user_id
    GROUP BY c.id, c.name, c.jid
    ORDER BY messages DESC LIMIT 10`);

  out.stats.monitored_chats = (await one(
    `SELECT COUNT(*)::int AS c FROM whatsapp_chats WHERE is_monitored IS TRUE`
  ))?.c;

  // Language sample
  const sample = await q(`
    SELECT id, left(message, 400) AS message
    FROM whatsapp_messages
    WHERE message IS NOT NULL AND length(message) > 20
    ORDER BY random() LIMIT 200`);
  let urdu = 0, roman = 0, english = 0, other = 0;
  for (const r of sample) {
    const t = r.message || '';
    if (/[\u0600-\u06FF]/.test(t)) urdu += 1;
    else if (/\b(hai|hain|krna|karachi|plot|ghar|for sale|dha|phase)\b/i.test(t) && !/^[A-Za-z0-9\s.,*'\"\-:/]+$/.test(t.slice(0, 80)))
      roman += 1;
    else if (/^[A-Za-z0-9\s.,*'\"\-:/&()]+$/.test(t.slice(0, 120))) english += 1;
    else roman += 1;
  }
  out.stats.language_sample_200 = { urdu_script: urdu, roman_urdu_ish: roman, english_ish: english, other, n: sample.length };

  // place_regions phase-5 / phase-6
  out.place_regions_phase5 = await one(
    `SELECT parent_key, aliases, children, source, updated_at FROM place_regions WHERE parent_key IN ('phase-5','phase 5') LIMIT 1`
  );
  out.place_regions_phase6 = await one(
    `SELECT parent_key, aliases, children, source, updated_at FROM place_regions WHERE parent_key IN ('phase-6','phase 6') LIMIT 1`
  );
  out.place_regions_all_keys = await q(`SELECT parent_key, cardinality(children) AS n_children, source FROM place_regions ORDER BY parent_key`);

  // A. Price failures
  out.samples_A_price = (await q(`
    SELECT n.id, n.whatsapp_message_id, n.listing_index, n.price, n.price_value, n.size, n.size_value,
           n.area, n.vicinity, n.city, n.purpose, n.property_type, n.model_used, n.is_property,
           left(m.message, 1200) AS raw_message
    FROM normalized_messages n
    JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
    WHERE n.is_property IS TRUE
      AND (
        m.message ~* '(crore|cr\\b|lakh|lac|\\bk\\b|per\\s*sq|sq\\.?\\s*yd).{0,40}(lakh|lac|crore|thousand|k\\b)?'
        OR m.message ~* '\\d+(\\.\\d+)?\\s*(crore|cr|lakh|lac)\\b'
        OR m.message ~* '\\d+(\\.\\d+)?\\s*k\\b'
      )
      AND (
        n.price_value IS NULL
        OR (m.message ~* 'crore' AND m.message ~* 'lakh' AND n.price_value IS NOT NULL AND n.price_value < 50000000)
        OR (m.message ~* '\\d+(\\.\\d+)?\\s*crore' AND n.price_value IS NOT NULL AND n.price_value < 1000000)
      )
    ORDER BY n.id DESC
    LIMIT 40`)).map(redactRow).slice(0, 25);

  // B. Phase leak — properties tagged/looking like phase 6 but also matching phase-5 search signals
  out.samples_B_phase_leak = (await q(`
    SELECT n.id, n.whatsapp_message_id, n.area, n.vicinity, n.city, n.place_tags,
           n.purpose, n.property_type, n.size, n.price,
           left(m.message, 1000) AS raw_message
    FROM normalized_messages n
    JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
    WHERE n.is_property IS TRUE
      AND (
        (COALESCE(n.area,'') || ' ' || COALESCE(n.vicinity,'')) ~* 'phase[- ]*5'
        AND (
          m.message ~* 'phase\\s*6'
          OR (COALESCE(n.area,'') || ' ' || COALESCE(n.vicinity,'')) ~* '(rahat|bukhari|ittehad|shahbaz|nishat)\\s*commercial'
          OR EXISTS (SELECT 1 FROM unnest(COALESCE(n.place_tags,ARRAY[]::text[])) t WHERE lower(t) IN ('phase-6','phase 6','rahat','bukhari','ittehad'))
        )
      )
      OR (
        EXISTS (SELECT 1 FROM unnest(COALESCE(n.place_tags,ARRAY[]::text[])) t WHERE lower(t) IN ('phase-5','phase 5'))
        AND (
          m.message ~* 'phase\\s*6'
          OR m.message ~* 'rahat\\s*commercial'
          OR (COALESCE(n.area,'') || ' ' || COALESCE(n.vicinity,'')) ~* 'rahat'
        )
      )
    ORDER BY n.id DESC
    LIMIT 20`)).map(redactRow).slice(0, 15);

  // C. Size failures
  out.samples_C_size = (await q(`
    SELECT n.id, n.whatsapp_message_id, n.size, n.size_value, n.size_unit, n.area, n.vicinity,
           left(m.message, 900) AS raw_message
    FROM normalized_messages n
    JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
    WHERE n.is_property IS TRUE
      AND (n.size_value IS NULL OR n.size IS NULL OR TRIM(COALESCE(n.size,''))='')
      AND m.message ~* '(\\d+\\s*(&|\\+|and)\\s*\\d+\\s*sq|\\d+(\\.\\d+)?\\s*(yard|yards|yrd|marla|kanal|sq\\.?\\s*ft|sqfeet|sq\\.?\\s*yd))'
    ORDER BY n.id DESC
    LIMIT 20`)).map(redactRow).slice(0, 15);

  // D. Multi-offer
  out.samples_D_multi = await q(`
    SELECT m.id AS message_id, left(m.message, 1500) AS raw_message,
           COUNT(n.id)::int AS listing_count,
           json_agg(json_build_object(
             'id', n.id, 'listing_index', n.listing_index,
             'size', n.size, 'price', n.price, 'area', n.area, 'vicinity', n.vicinity,
             'excerpt', left(COALESCE(n.listing_excerpt,''), 160)
           ) ORDER BY n.listing_index) AS listings
    FROM whatsapp_messages m
    JOIN normalized_messages n ON n.whatsapp_message_id = m.id
    WHERE n.is_property IS TRUE
    GROUP BY m.id, m.message
    HAVING COUNT(n.id) >= 2
    ORDER BY COUNT(n.id) DESC, m.id DESC
    LIMIT 10`);
  out.samples_D_multi = out.samples_D_multi.map((r) => ({
    ...r,
    raw_message: redactPhone(r.raw_message)
  }));

  // E. Good examples
  out.samples_E_good = (await q(`
    SELECT n.id, n.whatsapp_message_id, n.purpose, n.property_type, n.property_sub_type,
           n.city, n.area, n.vicinity, n.size, n.size_value, n.size_unit, n.price, n.price_value,
           n.place_tags, n.model_used, left(m.message, 700) AS raw_message
    FROM normalized_messages n
    JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
    WHERE n.is_property IS TRUE
      AND n.price_value IS NOT NULL AND n.price_value > 100000
      AND n.size_value IS NOT NULL AND n.size_value > 0
      AND n.area IS NOT NULL AND TRIM(n.area) <> ''
      AND n.purpose IS NOT NULL
      AND n.property_type IS NOT NULL
      AND n.place_tags IS NOT NULL AND cardinality(n.place_tags) > 0
    ORDER BY n.id DESC
    LIMIT 10`)).map(redactRow);

  // F. Non-property
  out.samples_F_nonprop = (await q(`
    SELECT n.id, n.is_property, n.purpose, n.property_type, n.summary,
           left(m.message, 600) AS raw_message
    FROM normalized_messages n
    JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
    WHERE n.is_property IS NOT TRUE
       OR (n.is_property IS TRUE AND m.message ~* '(assalam|aoa|hello|good morning|ok|thanks|jazak|follow up|reminder)'
           AND m.message !~* '(for sale|for rent|plot|demand|marla|yard|crore|lakh)')
    ORDER BY n.id DESC
    LIMIT 15`)).map(redactRow).slice(0, 10);

  // Ingest sample
  out.ingest_message_sample = redactRow(
    await one(`SELECT id, user_id, chat_jid, sender, sender_phone, timestamp, created_at,
                      left(message, 500) AS message, seq_in_chat, from_me
               FROM whatsapp_messages ORDER BY id DESC LIMIT 1`)
  );
  out.ingest_chat_samples = await q(`
    SELECT id, user_id, left(name, 80) AS name,
           CASE WHEN jid ~ '@g.us' THEN 'group' ELSE 'direct' END AS kind,
           is_monitored, last_scraped_at
    FROM whatsapp_chats
    ORDER BY is_monitored DESC NULLS LAST, id DESC
    LIMIT 12`);

  // Normalize jobs latency if columns exist
  try {
    out.normalize_jobs_recent = await q(`
      SELECT user_id, status, model_used, processed_this_run, started_at, finished_at, last_error, updated_at
      FROM normalize_jobs ORDER BY updated_at DESC NULLS LAST LIMIT 10`);
  } catch (e) {
    out.normalize_jobs_recent = { error: e.message };
  }

  // File presence of DHA enrich on this host
  try {
    const pr = fs.readFileSync(path.join(__dirname, '../ai/placeRegions.js'), 'utf8');
    out.prod_code_flags = {
      has_enrichSchemaWithLocalDhaPhase: pr.includes('enrichSchemaWithLocalDhaPhase'),
      has_PRIMARY_LOCALITY_PHASE: pr.includes('PRIMARY_LOCALITY_PHASE'),
      dha_json_has_rahat_commercial: fs
        .readFileSync(path.join(__dirname, '../data/dhaKarachiRegions.json'), 'utf8')
        .includes('rahat commercial')
    };
  } catch (e) {
    out.prod_code_flags = { error: e.message };
  }

  console.log(JSON.stringify(out));
  await pool.end();
}

main().catch((e) => {
  console.error(String(e && e.stack || e));
  process.exit(1);
});
