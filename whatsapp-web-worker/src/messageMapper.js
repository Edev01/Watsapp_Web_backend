const { shouldSkipMessage } = require('./messageFilter');

/**
 * Map a whatsapp-web.js Message into the backend ingest shape.
 * wa_key_id = message.id.id for fingerprint dedupe with Baileys rows.
 */
function mapMessage(msg) {
  const text = String(msg.body || '').trim();
  if (!text || shouldSkipMessage(text)) return null;

  const id = msg.id?.id || msg.id?._serialized || null;
  if (!id) return null;

  const tsSec = Number(msg.timestamp) || Math.floor(Date.now() / 1000);
  const fromMe = !!msg.fromMe;
  const author =
    msg.author ||
    (fromMe ? null : msg.from) ||
    null;

  return {
    id,
    wa_key_id: id,
    waKeyId: id,
    text,
    body: text,
    timestamp: tsSec,
    fromMe,
    from_me: fromMe,
    author,
    pushName: msg._data?.notifyName || msg.notifyName || null
  };
}

function chatIdFromMessage(msg) {
  // Groups: msg.from is the group jid; DMs: from/to depending on fromMe
  if (msg.fromMe) {
    return msg.to || msg.from;
  }
  return msg.from;
}

module.exports = { mapMessage, chatIdFromMessage };
