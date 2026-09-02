const db = require('./db');

/**
 * Strips invisible control characters (BIDI marks, zero-width spaces, etc.)
 */
function cleanText(text) {
  if (!text) return '';
  return String(text).replace(/[\u200B-\u200D\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').trim();
}

function normalizeForMatch(text) {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COMMON_EXACT = new Set([
  'ok', 'okay', 'okk', 'okkk', 'k', 'kk', 'kkk', 'oke', 'okey',
  'yes', 'no', 'yeah', 'yep', 'yup', 'nope', 'na', 'nah', 'yea',
  'done', 'ok done', 'okay done',
  'sure', 'alright', 'all right', 'right', 'fine',
  'please', 'plz', 'pls', 'please confirm',
  'hi', 'hello', 'hey', 'hy', 'hii', 'hiii', 'helloo', 'helo',
  'bye', 'goodbye', 'good night', 'goodnight', 'gn', 'good morning', 'gm',
  'good evening', 'good afternoon',
  'assalamualaikum', 'assalam o alaikum', 'asalamualaikum', 'salam',
  'walaikum assalam', 'wa alaikum assalam', 'ws', 'aoa', 'aoa wr wb',
  'jazakallah', 'jazakallah khair', 'allah hafiz',
  'ji', 'jee', 'haan', 'han', 'ha', 'theek', 'theek hai', 'thik', 'thik hai',
  'acha', 'achha', 'accha', 'sahi', 'sahi hai', 'bilkul',
  'bhai', 'bro', 'sir', 'mam', 'madam', 'ji bhai',
  'hmm', 'hm', 'hmmm', 'lol', 'haha', 'hahaha', 'hehe', 'hehehe',
  'nice', 'cool', 'great', 'perfect', 'awesome', 'wow',
  'thanks', 'thank you', 'thankyou', 'thx', 'ty', 'tysm', 'thanks bro',
  'ok thanks', 'ok thank you', 'okay thanks',
  'seen', 'check', 'checking', 'wait', 'waiting', 'ok wait', 'hold on',
  'yes please', 'ok please',
  'null', 'undefined', 'test', 'testing'
]);

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
      cleaned.includes('this message was deleted') ||
      cleaned.includes('you deleted this message') ||
      /^\d{1,2}:\d{2}$/.test(cleaned) ||
      /\.(json|txt|pdf|png|jpg|docx)$/i.test(cleaned)) {
    return true;
  }
  return false;
}

function isEmojiOnly(text) {
  const t = cleanText(text);
  if (!t) return true;
  if (/\p{L}|\p{N}/u.test(t)) return false;
  return true;
}

/**
 * Common filler chats that should not be stored / normalized.
 */
function isCommonJunkMessage(text) {
  const raw = cleanText(text);
  if (!raw) return true;
  if (isSystemNotificationText(raw)) return true;
  if (isEmojiOnly(raw)) return true;

  const norm = normalizeForMatch(raw);
  if (!norm) return true;
  if (norm.length <= 2 && !/\d/.test(norm) && !COMMON_EXACT.has(norm)) return true;
  if (COMMON_EXACT.has(norm)) return true;
  if (/^(.)\1{2,}$/u.test(norm.replace(/\s/g, ''))) return true;
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

function digitsOnly(str) {
  return String(str || '').replace(/\D/g, '');
}

/** True when title is basically a phone number / bare JID (not a real display name). */
function isPhoneLikeName(str) {
  const cleaned = cleanText(str);
  if (!cleaned) return true;

  const digits = digitsOnly(cleaned);
  const compact = cleaned.replace(/\s/g, '');

  if (digits.length >= 10 && digits.length <= 15) {
    const nonDigitChars = compact.replace(/\d/g, '').replace(/[+()-]/g, '');
    if (nonDigitChars.length <= 2) return true;
  }

  if (/^92\d{10}$/.test(digits) || /^03\d{9}$/.test(digits)) return true;
  if (/^\d{10,20}(@|$)/.test(cleaned)) return true;

  return false;
}

function jidLocalPart(jid) {
  return cleanText(jid).split('@')[0] || '';
}

/** Prefer human-readable titles over phone-number placeholders. */
function pickBetterChatName(existing, incoming, jid = '') {
  const current = cleanText(existing);
  const next = cleanText(incoming);
  const jidPart = jidLocalPart(jid);

  if (!next || isSystemNotificationText(next)) return current || jidPart || null;
  if (!current) return next;

  const currentPhone = isPhoneLikeName(current);
  const nextPhone = isPhoneLikeName(next);

  if (currentPhone && !nextPhone) return next;
  if (!currentPhone && nextPhone) return current;

  if (current === jidPart && next && next !== jidPart) return next;
  if (next === jidPart && current && current !== jidPart) return current;

  return next.length > current.length ? next : current;
}

async function updateChatNameIfBetter(userId, jid, rawName, avatar = null) {
  if (!jid) return;
  const incoming = cleanText(rawName);
  if (!incoming || isSystemNotificationText(incoming) || isPhoneLikeName(incoming)) {
    if (avatar) {
      await db.query(
        `UPDATE whatsapp_chats SET avatar = COALESCE($3, avatar) WHERE user_id = $1 AND jid = $2`,
        [userId, jid, avatar]
      );
    }
    return;
  }

  const row = await db.query(
    `SELECT id, name FROM whatsapp_chats WHERE user_id = $1 AND jid = $2 LIMIT 1`,
    [userId, jid]
  );
  if (!row.rows[0]) return;

  const better = pickBetterChatName(row.rows[0].name, incoming, jid);
  if (better && better !== row.rows[0].name) {
    await db.query(`UPDATE whatsapp_chats SET name = $2, avatar = COALESCE($3, avatar) WHERE id = $1`, [
      row.rows[0].id,
      better,
      avatar
    ]);
  } else if (avatar) {
    await db.query(`UPDATE whatsapp_chats SET avatar = COALESCE($2, avatar) WHERE id = $1`, [
      row.rows[0].id,
      avatar
    ]);
  }
}

/**
 * Finds existing canonical chat or creates a clean chat entry.
 * Prevents creating duplicate recipient chat rooms when new messages arrive.
 */
async function findOrCreateCanonicalChat(userId, rawJid, rawName, avatar = null) {
  const cleanedName = cleanText(rawName);
  const usableName =
    cleanedName && !isPhoneLikeName(cleanedName) && !isSystemNotificationText(cleanedName)
      ? cleanedName
      : '';
  const cleanedJid = cleanText(rawJid);

  // Only reject when BOTH identifiers look like system/junk text
  const nameIsJunk = !cleanedName || isSystemNotificationText(cleanedName);
  const jidIsJunk = !cleanedJid || isSystemNotificationText(cleanedJid) || cleanedJid === '@c.us' || cleanedJid === '@lid';
  if (nameIsJunk && jidIsJunk) {
    return null;
  }

  // Normalize phone JID (e.g. 03372071203@c.us -> 923372071203@c.us)
  const phoneDigits = normalizePhoneDigits(cleanedJid) || normalizePhoneDigits(cleanedName);
  let canonicalJid = cleanedJid;
  if (phoneDigits && phoneDigits.length >= 10 && phoneDigits.length <= 15) {
    // Keep @lid JIDs as-is when WhatsApp provides them; only normalize @c.us / bare phones
    if (!cleanedJid.includes('@lid')) {
      canonicalJid = `${phoneDigits}@c.us`;
    }
  }

  // Fallback slug JID from name when no usable JID was provided
  if (!canonicalJid || canonicalJid === '@c.us' || jidIsJunk) {
    const slug = (cleanedName || 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
    canonicalJid = `${slug || 'unknown'}@c.us`;
  }

  // 1. Try matching by user_id and canonical JID
  const matchByJid = await db.query(
    `SELECT id, jid, name FROM whatsapp_chats WHERE user_id = $1 AND jid = $2 LIMIT 1`,
    [userId, canonicalJid]
  );
  if (matchByJid.rows.length > 0) {
    const existing = matchByJid.rows[0];
    await updateChatNameIfBetter(userId, existing.jid, usableName || cleanedName, avatar);
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
        await updateChatNameIfBetter(userId, canonicalJid, usableName || cleanedName, avatar);
        return canonicalJid;
      }
      await updateChatNameIfBetter(userId, existing.jid, usableName || cleanedName, avatar);
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
      await updateChatNameIfBetter(userId, existing.jid, usableName || cleanedName, avatar);
      return existing.jid;
    }
  }

  const initialName = usableName || jidLocalPart(canonicalJid);

  // 4. No existing match -> Insert new clean chat room
  const insertRes = await db.query(
    `INSERT INTO whatsapp_chats (user_id, jid, name, avatar) 
     VALUES ($1, $2, $3, $4) 
     ON CONFLICT (user_id, jid) DO UPDATE SET
       name = CASE
         WHEN whatsapp_chats.name IS NULL OR whatsapp_chats.name = '' THEN EXCLUDED.name
         ELSE whatsapp_chats.name
       END,
       avatar = COALESCE(EXCLUDED.avatar, whatsapp_chats.avatar)
     RETURNING jid, name`,
    [userId, canonicalJid, initialName, avatar]
  );

  await updateChatNameIfBetter(userId, insertRes.rows[0].jid, usableName || cleanedName, avatar);
  return insertRes.rows[0].jid;
}

module.exports = {
  cleanText,
  isSystemNotificationText,
  isCommonJunkMessage,
  normalizePhoneDigits,
  isPhoneLikeName,
  pickBetterChatName,
  findOrCreateCanonicalChat
};
