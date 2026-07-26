const db = require('./db');

async function testConnection() {
  try {
    const chats = await db.query('SELECT COUNT(*) FROM whatsapp_chats');
    const msgs = await db.query('SELECT COUNT(*) FROM whatsapp_messages');
    console.log('Current whatsapp_chats count:', chats.rows[0].count);
    console.log('Current whatsapp_messages count:', msgs.rows[0].count);
    process.exit(0);
  } catch (err) {
    console.error('Database query error:', err.message);
    process.exit(1);
  }
}

testConnection();
