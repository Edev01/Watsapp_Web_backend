#!/usr/bin/env python3
from pathlib import Path

p = Path('/home/omer/whatsapp-worker/src/sessionManager.js')
text = p.read_text()
bak = Path('/home/omer/whatsapp-worker/src/sessionManager.js.bak.contacts')
if not bak.exists():
    bak.write_text(text)

helper = r'''
function resolveSenderPhone(msg, monitoredJid, fromMe) {
  if (fromMe) return null;
  const key = msg?.key || {};
  // Group: participant JID; DM: chat JID
  const candidates = [
    key.participantPn,
    key.participantAlt,
    key.participant,
    msg.participant,
    monitoredJid && !String(monitoredJid).endsWith('@g.us') ? monitoredJid : null
  ];
  for (const jid of candidates) {
    const classic = preferClassicJid(jid);
    const bare = jidBare(classic || jid);
    if (!bare || !/^\d{10,15}$/.test(bare)) continue;
    // Pakistan mobile normalization: 92XXXXXXXXXX -> 03XXXXXXXXX
    let digits = bare;
    if (digits.startsWith('92') && digits.length >= 12) digits = '0' + digits.slice(2);
    if (/^3\d{9}$/.test(digits)) digits = '0' + digits;
    if (/^03\d{9}$/.test(digits)) return digits;
    // Non-PK international: keep with country code
    if (bare.length >= 10 && bare.length <= 15) return bare;
  }
  return null;
}

'''

if 'function resolveSenderPhone' not in text:
    anchor = 'function isPhoneLikeName(str) {'
    if anchor not in text:
        raise SystemExit('anchor missing')
    text = text.replace(anchor, helper + anchor, 1)

old = """      const sender = fromMe
        ? 'Me'
        : msg.pushName || displayName || monitoredJid.split('@')[0];

      if (displayName && !isPhoneLikeName(displayName)) {
        monitoredContacts.push({ id: monitoredJid, name: displayName, avatar: null });
      }

      if (!byChat.has(monitoredJid)) byChat.set(monitoredJid, []);
      byChat.get(monitoredJid).push({
        messageId: String(msgKey),
        keyId: String(msgKey),
        sender,
        timestamp: String(ts),
        message: String(text).trim(),
        fromMe,
        from_me: fromMe,
        messageEpoch: epochSecFinal
      });"""

new = """      const sender = fromMe
        ? 'Me'
        : msg.pushName || displayName || monitoredJid.split('@')[0];
      const senderPhone = resolveSenderPhone(msg, monitoredJid, fromMe);

      if (displayName && !isPhoneLikeName(displayName)) {
        monitoredContacts.push({ id: monitoredJid, name: displayName, avatar: null });
      }

      if (!byChat.has(monitoredJid)) byChat.set(monitoredJid, []);
      byChat.get(monitoredJid).push({
        messageId: String(msgKey),
        keyId: String(msgKey),
        sender,
        senderPhone,
        sender_phone: senderPhone,
        senderJid: msg?.key?.participant || (!String(monitoredJid).endsWith('@g.us') ? monitoredJid : null) || null,
        timestamp: String(ts),
        message: String(text).trim(),
        fromMe,
        from_me: fromMe,
        messageEpoch: epochSecFinal
      });"""

if old not in text:
    raise SystemExit('message push block not found')
text = text.replace(old, new, 1)
p.write_text(text)
print('PATCHED_OK')
