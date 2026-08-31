const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

const MIGRATION_LOCK_KEY = 839274651;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withMigrationLock(client, fn) {
  const maxWaitMs = 120000;
  const started = Date.now();

  while (Date.now() - started < maxWaitMs) {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [
      MIGRATION_LOCK_KEY
    ]);
    if (rows[0]?.acquired) {
      try {
        return await fn();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      }
    }
    await sleep(1500 + Math.floor(Math.random() * 1000));
  }

  throw new Error('Timed out waiting for database migration lock');
}

async function runMigrationSteps(client) {
  const steps = [
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) DEFAULT 'user',
      is_first_login BOOLEAN DEFAULT TRUE,
      name VARCHAR(255),
      phone_number VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(50)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS bound_whatsapp_jid TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS bound_whatsapp_phone VARCHAR(32)`,
    `INSERT INTO users (id, email, password_hash, role, name)
     VALUES (1, 'default_admin@whatsapp.com', '$2a$10$defaultadminhash123456789', 'admin', 'Default Admin')
     ON CONFLICT (id) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS qr_codes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE DEFAULT 1,
      url TEXT NOT NULL,
      source VARCHAR(255) DEFAULT 'whatsapp',
      page_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `ALTER TABLE qr_codes ADD COLUMN IF NOT EXISTS page_url TEXT`,
    `ALTER TABLE qr_codes ADD COLUMN IF NOT EXISTS user_id INTEGER`,
    `CREATE TABLE IF NOT EXISTS whatsapp_chats (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE DEFAULT 1,
      jid VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      avatar TEXT,
      is_monitored BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT unique_user_chat UNIQUE (user_id, jid)
    )`,
    `ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS user_id INTEGER`,
    `ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS monitored_at TIMESTAMPTZ`,
    `ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS last_scraped_at TIMESTAMPTZ`,
    `UPDATE whatsapp_chats
     SET monitored_at = COALESCE(monitored_at, created_at, NOW())
     WHERE is_monitored = TRUE AND monitored_at IS NULL`,
    `ALTER TABLE whatsapp_chats DROP CONSTRAINT IF EXISTS whatsapp_chats_jid_key`,
    `ALTER TABLE whatsapp_chats DROP CONSTRAINT IF EXISTS unique_user_chat`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'unique_user_chat'
       ) THEN
         ALTER TABLE whatsapp_chats ADD CONSTRAINT unique_user_chat UNIQUE (user_id, jid);
       END IF;
     END $$`,
    `CREATE INDEX IF NOT EXISTS idx_whatsapp_chats_user_monitored ON whatsapp_chats (user_id, is_monitored)`,
    `CREATE INDEX IF NOT EXISTS idx_whatsapp_chats_user_name ON whatsapp_chats (user_id, name)`,
    `CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE DEFAULT 1,
      chat_jid VARCHAR(255) NOT NULL,
      sender VARCHAR(255),
      timestamp VARCHAR(255),
      message TEXT,
      from_me BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT unique_user_message UNIQUE (user_id, chat_jid, sender, timestamp, message)
    )`,
    `ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS user_id INTEGER`,
    `ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS from_me BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE whatsapp_messages DROP CONSTRAINT IF EXISTS unique_message`,
    `ALTER TABLE whatsapp_messages DROP CONSTRAINT IF EXISTS unique_user_message`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'unique_user_message'
       ) THEN
         ALTER TABLE whatsapp_messages
           ADD CONSTRAINT unique_user_message UNIQUE (user_id, chat_jid, sender, timestamp, message);
       END IF;
     END $$`,
    `ALTER TABLE qr_codes DROP CONSTRAINT IF EXISTS qr_codes_user_id_fkey`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'qr_codes_user_id_fkey'
       ) THEN
         ALTER TABLE qr_codes
           ADD CONSTRAINT qr_codes_user_id_fkey
           FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
       END IF;
     END $$`,
    `ALTER TABLE whatsapp_chats DROP CONSTRAINT IF EXISTS whatsapp_chats_user_id_fkey`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_chats_user_id_fkey'
       ) THEN
         ALTER TABLE whatsapp_chats
           ADD CONSTRAINT whatsapp_chats_user_id_fkey
           FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
       END IF;
     END $$`,
    `ALTER TABLE whatsapp_messages DROP CONSTRAINT IF EXISTS whatsapp_messages_user_id_fkey`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_messages_user_id_fkey'
       ) THEN
         ALTER TABLE whatsapp_messages
           ADD CONSTRAINT whatsapp_messages_user_id_fkey
           FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
       END IF;
     END $$`,
    `CREATE TABLE IF NOT EXISTS whatsapp_link_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(50) DEFAULT 'waiting',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `ALTER TABLE whatsapp_link_sessions ADD COLUMN IF NOT EXISTS whatsapp_jid TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_link_sessions_updated ON whatsapp_link_sessions (updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_link_sessions_wa_jid ON whatsapp_link_sessions (whatsapp_jid)`,
    `CREATE TABLE IF NOT EXISTS normalize_jobs (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(32) NOT NULL DEFAULT 'idle',
      model_used VARCHAR(64) DEFAULT 'qwen2.5:7b',
      embed BOOLEAN DEFAULT TRUE,
      batch_size INTEGER DEFAULT 50,
      processed_this_run INTEGER DEFAULT 0,
      started_at TIMESTAMP,
      finished_at TIMESTAMP,
      last_error TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_normalize_jobs_status ON normalize_jobs (status)`
  ];

  for (const sql of steps) {
    await client.query(sql);
  }
}

// Initialize database tables (single-flight via advisory lock on Render/multi-instance)
const initializeDb = async () => {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await pool.connect();
    try {
      await withMigrationLock(client, async () => {
        await runMigrationSteps(client);
      });
      console.log('Database initialized successfully (migration lock acquired).');
      return;
    } catch (err) {
      const isDeadlock =
        err.code === '40P01' ||
        /deadlock detected/i.test(String(err.message || ''));
      if (isDeadlock && attempt < maxAttempts) {
        const delay = 800 * attempt + Math.floor(Math.random() * 700);
        console.warn(
          `Migration deadlock on attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms...`
        );
        await sleep(delay);
        continue;
      }
      console.error('Error initializing database table:', err.message);
      throw err;
    } finally {
      client.release();
    }
  }
};

/** Lightweight re-check for scrape columns (no heavy DDL). */
async function ensureScrapeColumns(client) {
  const dbClient = client || (await pool.connect());
  try {
    await dbClient.query(`
      ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS monitored_at TIMESTAMPTZ;
      ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS last_scraped_at TIMESTAMPTZ;
    `);
  } finally {
    if (!client) dbClient.release();
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  initializeDb,
  ensureScrapeColumns: () => ensureScrapeColumns(),
  pool
};
