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

    CREATE TABLE IF NOT EXISTS qr_codes (
      id SERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      source VARCHAR(255) DEFAULT 'whatsapp',
      page_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE qr_codes ADD COLUMN IF NOT EXISTS page_url TEXT;

    CREATE TABLE IF NOT EXISTS whatsapp_chats (
      id SERIAL PRIMARY KEY,
      jid VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255),
      avatar TEXT,
      is_monitored BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id SERIAL PRIMARY KEY,
      chat_jid VARCHAR(255) NOT NULL,
      sender VARCHAR(255),
      timestamp VARCHAR(255),
      message TEXT,
      from_me BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT unique_message UNIQUE (chat_jid, sender, timestamp, message)
    );

    ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS from_me BOOLEAN DEFAULT FALSE;
  `;
  try {
    const client = await pool.connect();
    await client.query(queryText);
    client.release();
    console.log('Database initialized successfully (users table checked/created).');
  } catch (err) {
    console.error('Error initializing database table:', err.message);
  }
};

module.exports = {
  query: (text, params) => pool.query(text, params),
  initializeDb,
  pool
};
