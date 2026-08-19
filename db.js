const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // For Supabase connection issues (sometimes SSL is required or preferred)
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Initialize database tables
const initializeDb = async () => {
  const queryText = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) DEFAULT 'user',
      is_first_login BOOLEAN DEFAULT TRUE,
      name VARCHAR(255),
      phone_number VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(50);
    -- Permanently bound WhatsApp (first successful scan) — cannot switch numbers later
    ALTER TABLE users ADD COLUMN IF NOT EXISTS bound_whatsapp_jid TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS bound_whatsapp_phone VARCHAR(32);

    INSERT INTO users (id, email, password_hash, role, name)
    VALUES (1, 'default_admin@whatsapp.com', '$2a$10$defaultadminhash123456789', 'admin', 'Default Admin')
    ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS qr_codes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE DEFAULT 1,
      url TEXT NOT NULL,
      source VARCHAR(255) DEFAULT 'whatsapp',
      page_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE qr_codes ADD COLUMN IF NOT EXISTS page_url TEXT;
    ALTER TABLE qr_codes ADD COLUMN IF NOT EXISTS user_id INTEGER;

    CREATE TABLE IF NOT EXISTS whatsapp_chats (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE DEFAULT 1,
      jid VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      avatar TEXT,
      is_monitored BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT unique_user_chat UNIQUE (user_id, jid)
    );

    ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS user_id INTEGER;
    ALTER TABLE whatsapp_chats DROP CONSTRAINT IF EXISTS whatsapp_chats_jid_key;
    ALTER TABLE whatsapp_chats DROP CONSTRAINT IF EXISTS unique_user_chat;
    ALTER TABLE whatsapp_chats ADD CONSTRAINT unique_user_chat UNIQUE (user_id, jid);

    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE DEFAULT 1,
      chat_jid VARCHAR(255) NOT NULL,
      sender VARCHAR(255),
      timestamp VARCHAR(255),
      message TEXT,
      from_me BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT unique_user_message UNIQUE (user_id, chat_jid, sender, timestamp, message)
    );

    ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS user_id INTEGER;
    ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS from_me BOOLEAN DEFAULT FALSE;
    ALTER TABLE whatsapp_messages DROP CONSTRAINT IF EXISTS unique_message;
    ALTER TABLE whatsapp_messages DROP CONSTRAINT IF EXISTS unique_user_message;
    ALTER TABLE whatsapp_messages ADD CONSTRAINT unique_user_message UNIQUE (user_id, chat_jid, sender, timestamp, message);

    -- Recreate user_id FKs with ON DELETE CASCADE so users can be removed safely
    ALTER TABLE qr_codes DROP CONSTRAINT IF EXISTS qr_codes_user_id_fkey;
    ALTER TABLE qr_codes
      ADD CONSTRAINT qr_codes_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

    ALTER TABLE whatsapp_chats DROP CONSTRAINT IF EXISTS whatsapp_chats_user_id_fkey;
    ALTER TABLE whatsapp_chats
      ADD CONSTRAINT whatsapp_chats_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

    ALTER TABLE whatsapp_messages DROP CONSTRAINT IF EXISTS whatsapp_messages_user_id_fkey;
    ALTER TABLE whatsapp_messages
      ADD CONSTRAINT whatsapp_messages_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

    -- Active portal user waiting to link / currently linked on the operator WhatsApp
    CREATE TABLE IF NOT EXISTS whatsapp_link_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(50) DEFAULT 'waiting',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE whatsapp_link_sessions ADD COLUMN IF NOT EXISTS whatsapp_jid TEXT;

    CREATE INDEX IF NOT EXISTS idx_link_sessions_updated ON whatsapp_link_sessions (updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_link_sessions_wa_jid ON whatsapp_link_sessions (whatsapp_jid);
  `;
  try {
    const client = await pool.connect();
    await client.query(queryText);
    client.release();
    console.log('Database initialized successfully (users table checked/created, CASCADE FKs applied).');
  } catch (err) {
    console.error('Error initializing database table:', err.message);
  }
};

module.exports = {
  query: (text, params) => pool.query(text, params),
  initializeDb,
  pool
};
