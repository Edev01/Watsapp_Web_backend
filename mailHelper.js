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

module.exports = {
  getSmtpConfig,
  sendComplaintEmail,
};
