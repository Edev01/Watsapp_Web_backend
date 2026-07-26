const fs = require('fs');
const path = require('path');

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

  // Regex 1: 27/06/2026, 3:35 pm - Sender: Message (or System message)
  // Replaces narrow non-breaking space \u202f or \u00a0 with normal space
  const regexAndroid = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s*[ap]m)\s*-\s*(.*)$/i;

  // Regex 2: [04/11/2015, 1:31:46 PM] Sender: Message
  const regexIOS = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s*[ap]m)\]\s*(.*)$/i;

  for (let line of lines) {
    // Normalize spaces (e.g. \u202f -> space)
    const normalizedLine = line.replace(/[\u202f\u00a0]/g, ' ');

    let matchAndroid = normalizedLine.match(regexAndroid);
    let matchIOS = normalizedLine.match(regexIOS);

    let match = matchAndroid || matchIOS;

    if (match) {
      if (currentMsg) {
        messages.push(currentMsg);
      }

      const dateStr = match[1];
      const timeStr = match[2];
      const rest = match[3];

      let sender = 'System';
      let messageText = rest;

      // Check if rest contains sender separator ": "
      const colonIdx = rest.indexOf(': ');
      if (colonIdx !== -1) {
        sender = rest.substring(0, colonIdx).trim();
        // Remove ~ prefix if present in sender name (e.g. ~ Waseem Ahmed)
        sender = sender.replace(/^~\s*/, '');
        messageText = rest.substring(colonIdx + 2);
      }

      currentMsg = {
        timestamp: `${dateStr}, ${timeStr}`,
        sender: sender,
        message: messageText
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

  return messages;
}

for (const item of files) {
  const fullPath = path.join(downloadsDir, item.file);
  if (fs.existsSync(fullPath)) {
    const msgs = parseChatFile(fullPath);
    console.log(`Parsed ${item.file}: ${msgs.length} messages found.`);
    if (msgs.length > 0) {
      console.log('  Sample msg 1 sender:', msgs[0].sender, '| timestamp:', msgs[0].timestamp);
      console.log('  Sample msg 1 snippet:', JSON.stringify(msgs[0].message.substring(0, 60)));
    }
  } else {
    console.log(`File not found: ${item.file}`);
  }
}
