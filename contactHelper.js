const db = require('./db');

/**
 * Strips invisible control characters (BIDI marks, zero-width spaces, etc.)
 */
function cleanText(text) {
  if (!text) return '';
  return String(text).replace(/[\u200B-\u200D\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').trim();
}

/**
 * Determines if text is a WhatsApp system notification or non-chat metadata string
 */
function isSystemNotificationText(text) {
  const cleaned = cleanText(text).toLowerCase();
  if (!cleaned || cleaned.length < 2) return true;
  if (cleaned.includes('disappearing messages') || 
      cleaned.includes('turned off') || 
      cleaned.includes('turned on') || 
      cleaned.includes('click to change') ||
      cleaned.includes('end-to-end encrypted') ||
      cleaned.includes('added you') ||
      cleaned.includes('created group') ||
      /^\d{1,2}:\d{2}$/.test(cleaned) ||
      /\.(json|txt|pdf|png|jpg|docx)$/i.test(cleaned)) {
    return true;
  }
  return false;
}

/**
 * Extracts and normalizes Pakistani / International phone digits (e.g. 03372071203 -> 923372071203)
 */
function normalizePhoneDigits(str) {
  if (!str) return '';
  const digits = String(str).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('03')) {
    return '92' + digits.substring(1);
  }
  return digits;
}

/**
 * Finds existing canonical chat or creates a clean chat entry.
 * Prevents creating duplicate recipient chat rooms when new messages arrive.
 */
async function findOrCreateCanonicalChat(userId, rawJid, rawName, avatar = null) {
  const cleanedName = cleanText(rawName);
  const cleanedJid = cleanText(rawJid);

  if (isSystemNotificationText(cleanedName) || isSystemNotificationText(cleanedJid)) {
    return null; // Skip system notification strings
  }

  // Normalize phone JID (e.g. 03372071203@c.us -> 923372071203@c.us)
  const phoneDigits = normalizePhoneDigits(cleanedJid) || normalizePhoneDigits(cleanedName);
  let canonicalJid = cleanedJid;
  if (phoneDigits && phoneDigits.length >= 10 && phoneDigits.length <= 13) {
    canonicalJid = `${phoneDigits}@c.us`;
  }

  // 1. Try matching by user_id and canonical JID
  const matchByJid = await db.query(
    `SELECT id, jid, name FROM whatsapp_chats WHERE user_id = $1 AND jid = $2 LIMIT 1`,
    [userId, canonicalJid]
  );
  if (matchByJid.rows.length > 0) {
    const existing = matchByJid.rows[0];
    if (avatar) {
      await db.query(`UPDATE whatsapp_chats SET avatar = COALESCE($1, avatar) WHERE id = $2`, [avatar, existing.id]);
    }
    return existing.jid;
  }

  // 2. Try matching by phone digits if available
  if (phoneDigits) {
    const matchByDigits = await db.query(
      `SELECT id, jid, name FROM whatsapp_chats 
       WHERE user_id = $1 AND (jid LIKE $2 OR regexp_replace(name, '\\D', '', 'g') = $3) LIMIT 1`,
      [userId, `%${phoneDigits}%`, phoneDigits]
    );
    if (matchByDigits.rows.length > 0) {
      const existing = matchByDigits.rows[0];
      if (existing.jid !== canonicalJid && canonicalJid.startsWith('92')) {
        // Upgrade fallback JID to canonical international phone JID
        await db.query(`UPDATE whatsapp_chats SET jid = $1, avatar = COALESCE($2, avatar) WHERE id = $3`, [canonicalJid, avatar, existing.id]);
        await db.query(`UPDATE whatsapp_messages SET chat_jid = $1 WHERE chat_jid = $2 AND user_id = $3`, [canonicalJid, existing.jid, userId]);
        return canonicalJid;
      }
      return existing.jid;
    }
  }

  // 3. Try matching by clean name
  if (cleanedName) {
    const matchByName = await db.query(
      `SELECT id, jid, name FROM whatsapp_chats 
       WHERE user_id = $1 AND LOWER(TRIM(regexp_replace(name, '[\\u200B-\\u200D\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]', '', 'g'))) = LOWER(TRIM($2)) LIMIT 1`,
      [userId, cleanedName]
    );
    if (matchByName.rows.length > 0) {
      const existing = matchByName.rows[0];
      if (avatar) {
        await db.query(`UPDATE whatsapp_chats SET avatar = COALESCE($1, avatar) WHERE id = $2`, [avatar, existing.id]);
      }
      return existing.jid;
    }
  }

  // 4. No existing match -> Insert new clean chat room
  const insertRes = await db.query(
    `INSERT INTO whatsapp_chats (user_id, jid, name, avatar) 
     VALUES ($1, $2, $3, $4) 
     ON CONFLICT (user_id, jid) DO UPDATE SET name = EXCLUDED.name, avatar = COALESCE(EXCLUDED.avatar, whatsapp_chats.avatar)
     RETURNING jid`,
    [userId, canonicalJid, cleanedName || canonicalJid.split('@')[0], avatar]
  );

  return insertRes.rows[0].jid;
}

module.exports = {
  cleanText,
  isSystemNotificationText,
  normalizePhoneDigits,
  findOrCreateCanonicalChat
};
