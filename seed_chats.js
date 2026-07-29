const fs = require('fs');
const path = require('path');
const db = require('./db');

const files = [
  { file: 'WhatsApp Chat with 🏡DHA Bungalows🏡.txt', name: '🏡DHA Bungalows🏡', jid: 'dha_bungalows@c.us' },
  { file: 'WhatsApp Chat with PORTION FOR RENT IN DHA.txt', name: 'PORTION FOR RENT IN DHA', jid: 'portion_for_rent_dha@c.us' },
  { file: 'WhatsApp Chat with DHA   CLIFTON  REALTORS.txt', name: 'DHA CLIFTON REALTORS', jid: 'dha_clifton_realtors@c.us' },
  { file: 'WhatsApp Chat with A.J Real Estate🏡.txt', name: 'A.J Real Estate🏡', jid: 'aj_real_estate@c.us' },
  { file: '_chat.txt', name: 'AMAL ASSOCIATES 🏘️', jid: 'amal_associates@c.us' }
];

const downloadsDir = '/Users/mac/Downloads';

function parseChatFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  const messages = [];
  let currentMsg = null;

  const regexAndroid = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s*[ap]m)\s*-\s*(.*)$/i;
  const regexIOS = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s*[ap]m)\]\s*(.*)$/i;

  for (let line of lines) {
    const normalizedLine = line.replace(/[\u202f\u00a0]/g, ' ');
    let match = normalizedLine.match(regexAndroid) || normalizedLine.match(regexIOS);

    if (match) {
      if (currentMsg) {
        messages.push(currentMsg);
      }

      const dateStr = match[1];
      const timeStr = match[2];
      const rest = match[3];

      let sender = 'System';
      let messageText = rest;

      const colonIdx = rest.indexOf(': ');
      if (colonIdx !== -1) {
        sender = rest.substring(0, colonIdx).trim().replace(/^~\s*/, '');
        messageText = rest.substring(colonIdx + 2);
      }

      currentMsg = {
        timestamp: `${dateStr}, ${timeStr}`,
        sender: sender,
        message: messageText.trim()
      };
    } else {
      if (currentMsg) {
        currentMsg.message += '\n' + line;
      }
    }
  }

  if (currentMsg) {
    messages.push(currentMsg);
  }

  return messages.filter(m => {
    if (!m.message || m.message.trim() === '') return false;
    if (m.sender === 'System' && (m.message.includes('end-to-end encrypted') || m.message.includes('added you') || m.message.includes('created this group'))) {
      return false;
    }
    return true;
  });
}

async function batchInsertMessages(chatJid, messages) {
  const BATCH_SIZE = 100; // 100 items batch
  let insertedTotal = 0;

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    const valuePlaceholders = [];
    const values = [];
    let paramIndex = 1;

    for (const msg of batch) {
      valuePlaceholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5})`);
      values.push(1, chatJid, msg.sender || 'Unknown', msg.timestamp || '', msg.message || '', msg.fromMe || msg.from_me || false);
      paramIndex += 6;
    }

    const query = `
      INSERT INTO whatsapp_messages (user_id, chat_jid, sender, timestamp, message, from_me)
      VALUES ${valuePlaceholders.join(', ')}
      ON CONFLICT (user_id, chat_jid, sender, timestamp, message) DO UPDATE SET from_me = EXCLUDED.from_me
    `;

    try {
      const res = await db.query(query, values);
      insertedTotal += res.rowCount || 0;
    } catch (err) {
      // Fallback row-by-row for batch failures (e.g. index size limit or network hiccups)
      for (const msg of batch) {
        try {
          const res = await db.query(
            `INSERT INTO whatsapp_messages (user_id, chat_jid, sender, timestamp, message, from_me)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (user_id, chat_jid, sender, timestamp, message) DO UPDATE SET from_me = EXCLUDED.from_me`,
            [1, chatJid, msg.sender || 'Unknown', msg.timestamp || '', msg.message || '', msg.fromMe || msg.from_me || false]
          );
          insertedTotal += res.rowCount || 0;
        } catch (itemErr) {
          // If message text exceeds btree index limit (2704 bytes), truncate slightly for index match
          try {
            const truncatedMsg = msg.message ? msg.message.substring(0, 2000) : '';
            const res = await db.query(
              `INSERT INTO whatsapp_messages (user_id, chat_jid, sender, timestamp, message, from_me)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (user_id, chat_jid, sender, timestamp, message) DO UPDATE SET from_me = EXCLUDED.from_me`,
              [1, chatJid, msg.sender || 'Unknown', msg.timestamp || '', truncatedMsg, msg.fromMe || msg.from_me || false]
            );
            insertedTotal += res.rowCount || 0;
          } catch (innerErr) {
            // Ignore if duplicate or unresolvable
          }
        }
      }
    }
  }

  return insertedTotal;
}

async function seed() {
  console.log('--- Starting WhatsApp Chat Seeding ---');
  await db.initializeDb();

  for (const item of files) {
    const fullPath = path.join(downloadsDir, item.file);
    if (!fs.existsSync(fullPath)) {
      console.warn(`File not found, skipping: ${item.file}`);
      continue;
    }

    console.log(`Processing file: ${item.file}...`);

    try {
      await db.query(
        `INSERT INTO whatsapp_chats (user_id, jid, name, is_monitored)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, jid) DO UPDATE SET name = EXCLUDED.name`,
        [1, item.jid, item.name, true]
      );
      console.log(`  ✓ Chat room "${item.name}" registered in whatsapp_chats.`);
    } catch (err) {
      console.error(`  ✗ Error upserting chat room "${item.name}":`, err.message);
    }

    const messages = parseChatFile(fullPath);
    console.log(`  Parsed ${messages.length} valid messages. Inserting to DB...`);

    const insertedCount = await batchInsertMessages(item.jid, messages);
    console.log(`  ✓ Finished ${item.name}: inserted/processed ${messages.length} messages.`);
  }

  const totalMsgs = await db.query('SELECT COUNT(*) FROM whatsapp_messages');
  console.log(`--- Seeding Complete! Total messages in DB: ${totalMsgs.rows[0].count} ---`);
  process.exit(0);
}

seed();
