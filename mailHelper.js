const nodemailer = require('nodemailer');
require('dotenv').config();

const getSmtpConfig = () => {
  const host = process.env.SMTP_HOST || '';
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER || process.env.SMTP_FROM || '';
  const pass = process.env.SMTP_PASS || '';
  const from = process.env.SMTP_FROM || user;
  const to = process.env.SMTP_TO || from || user;

  return {
    host,
    port,
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
    user,
    pass,
    from,
    to,
    configured: Boolean(host && user && pass && from && to),
  };
};

/**
 * Notify admin mailbox about a new complaint.
 * From and To are the same admin SMTP address; Reply-To is the complainant's email.
 */
async function sendComplaintEmail({ name, email, phone, message, complaintId }) {
  const cfg = getSmtpConfig();
  if (!cfg.configured) {
    console.warn('SMTP not configured — complaint saved but email skipped');
    return { sent: false, reason: 'SMTP not configured' };
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
  });

  const phoneLine = phone ? phone : '(not provided)';
  const textBody = [
    'New PropSync complaint',
    '',
    `Complaint ID: ${complaintId || 'n/a'}`,
    `Name: ${name}`,
    `Email: ${email}`,
    `Phone: ${phoneLine}`,
    '',
    'Message:',
    message,
    '',
    'Reply to this email to respond directly to the user.',
  ].join('\n');

  const htmlBody = `
    <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#0f172a">
      <h2 style="margin:0 0 12px">New PropSync complaint</h2>
      <p style="margin:0 0 8px"><strong>Complaint ID:</strong> ${complaintId || 'n/a'}</p>
      <p style="margin:0 0 8px"><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p style="margin:0 0 8px"><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p style="margin:0 0 8px"><strong>Phone:</strong> ${escapeHtml(phoneLine)}</p>
      <p style="margin:16px 0 8px"><strong>Message:</strong></p>
      <pre style="white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin:0">${escapeHtml(message)}</pre>
      <p style="margin:16px 0 0;color:#64748b;font-size:13px">Reply to this email to respond directly to the user.</p>
    </div>
  `;

  await transporter.sendMail({
    from: cfg.from,
    to: cfg.to,
    replyTo: email,
    subject: `PropSync complaint from ${name}`,
    text: textBody,
    html: htmlBody,
  });

  return { sent: true };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Alert when renormalize.js finishes or stops (quota, errors, crash).
 */
async function sendRenormalizeStopEmail(summary) {
  const cfg = getSmtpConfig();
  if (!cfg.configured) {
    console.warn('[mail] SMTP not configured — renormalize stop alert skipped');
    return { sent: false, reason: 'SMTP not configured' };
  }

  const s = summary || {};
  const subject = `[PropSync] Normalization stopped — ${s.stopReason || 'finished'}`;
  const lines = [
    'PropSync extract v2 renormalize run ended',
    '',
    `Stop reason: ${s.stopReason || 'unknown'}`,
    `Mode: ${s.dryRun ? 'DRY RUN (no DB writes)' : 'LIVE'}`,
    `User id: ${s.userId ?? 'n/a'}`,
    `Provider (primary): ${s.extractProvider || 'n/a'}`,
    `Fallback: ${s.extractFallback || 'none'}`,
    '',
    'Progress:',
    `  Messages loaded: ${s.total ?? 0}`,
    `  Succeeded: ${s.done ?? 0}`,
    `  Errors: ${s.errors ?? 0}`,
    `  Property listings: ${s.property ?? 0}`,
    '',
    'HTTP 429 / quota / billing signals (from error messages):',
    `  Gemini 429/quota: ${s.rateLimit?.gemini429 ?? 0}`,
    `  Together 429/rate: ${s.rateLimit?.together429 ?? 0}`,
    `  Together 402/credits: ${s.rateLimit?.together402 ?? 0}`,
    '',
    'Other API errors:',
    `  Gemini (non-429): ${s.rateLimit?.geminiOther ?? 0}`,
    `  Together (non-429): ${s.rateLimit?.togetherOther ?? 0}`,
    '',
    s.rateLimitNote || '',
    '',
    'Reports:',
    `  ${s.reportPath || 'n/a'}`,
    s.failedPath ? `  ${s.failedPath}` : '',
    '',
    s.sampleErrors?.length ? 'Sample errors:\n' + s.sampleErrors.map((e) => `  - ${e}`).join('\n') : '',
    '',
    `Finished at: ${s.finishedAt || new Date().toISOString()}`,
  ].filter(Boolean);

  const textBody = lines.join('\n');
  const htmlBody = `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.45">${escapeHtml(textBody)}</pre>`;

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  await transporter.sendMail({
    from: cfg.from,
    to: cfg.to,
    subject,
    text: textBody,
    html: htmlBody,
  });

  return { sent: true };
}

async function sendMail({ to, subject, text, html, bccAdmin = true }) {
  const cfg = getSmtpConfig();
  if (!cfg.configured) {
    console.warn('[mail] SMTP not configured — skipped:', subject);
    return { sent: false, reason: 'SMTP not configured' };
  }
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  const bcc = [];
  if (bccAdmin && cfg.to && String(to).toLowerCase() !== String(cfg.to).toLowerCase()) {
    bcc.push(cfg.to);
  }
  await transporter.sendMail({
    from: cfg.from,
    to,
    bcc: bcc.length ? bcc : undefined,
    subject,
    text,
    html: html || `<pre style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5">${escapeHtml(text)}</pre>`,
  });
  return { sent: true };
}

async function sendBillingEmail({ to, kind, amountPkr = 7000, periodEnd = null }) {
  const amount = `PKR ${Number(amountPkr).toLocaleString('en-PK')}`;
  const end = periodEnd
    ? new Date(periodEnd).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  const copy = {
    paid: {
      subject: 'PropSync payment received — PKR 7,000',
      text:
        `We received your monthly PropSync payment of ${amount}.\n` +
        (end ? `Your current paid period runs until ${end} (plus a 10-day grace window).\n` : '') +
        '\nThank you for using PropSync.',
    },
    failed: {
      subject: 'PropSync payment failed',
      text:
        `We could not collect this month's PropSync payment of ${amount}.\n` +
        'Please pay from your dashboard within 10 days of this billing cycle or access will pause at login (paywall only).',
    },
    locked: {
      subject: 'PropSync access paused — payment needed',
      text:
        'Your PropSync account can still sign in, but search, WhatsApp, and chats stay locked until this month is paid (PKR 7,000).',
    },
    complimentary: {
      subject: 'PropSync access is complimentary',
      text: 'An administrator marked your PropSync account as complimentary. You can use the system without monthly payment.',
    },
    canceled: {
      subject: 'PropSync subscription canceled',
      text: 'Your PropSync subscription was canceled. Sign in and pay PKR 7,000 / month to restore access.',
    },
  };
  const msg = copy[kind];
  if (!msg || !to) return { sent: false, reason: 'missing' };
  return sendMail({ to, subject: msg.subject, text: msg.text });
}

module.exports = {
  getSmtpConfig,
  sendComplaintEmail,
  sendRenormalizeStopEmail,
  sendMail,
  sendBillingEmail,
};
