const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const db = require('./db');
const { sendResponse } = require('./responseHelper');
const { authenticateToken, isAdmin } = require('./middleware');
const { filterAndSortProperties, PROPERTY_STATUSES, normalizePropertyStatus, isValidPropertyStatus, expandLocationQuery } = require('./propertyHelper');
const { userMessageFingerprint } = require('./contentFingerprint');
const { setExtraLocalities, correctLocalityTypos, canonicalizePlaceText, normalizePlaceKey, isKhayabanFamilyToken } = require('./pakistanLocalities');
const { parseSmartLocationQuery, buildSmartLocationSql, scoreLocationMatch, textHasPhase, textHasStreet } = require('./smartLocationSearch');
const { classifyLocationQuery, norm: placeNorm } = require('./ai/placeRegions');
const { ensurePlaceRegionsSeeded } = require('./ai/placeResolver');
const { isWeakLocation } = require('./ai/cascadeMerge');
const { extractUserId } = require('./userMiddleware');
const { findOrCreateCanonicalChat, upsertChatsBulk, cleanText, isSystemNotificationText, isCommonJunkMessage } = require('./contactHelper');
const {
  ensureMonitorLetter,
  allocateSeqInChat,
  parseSeqNumber
} = require('./seqHelper');
const {
  DEFAULT_MODEL: NORMALIZE_MODEL,
  getNormalizeCounts,
  getNormalizeJob,
  queueNormalizeJob,
  markNormalizeJobError,
  notifyNormalizeBot,
  buildStatusPayload
} = require('./normalizeHelper');

let startPipelineWorker = () => ({ started: false, reason: 'ai module missing' });
let wakePipeline = () => {};
let getPipelineStats = () => ({
  running: false,
  lastRun: null,
  lastNormalized: 0,
  lastEmbedded: 0,
  totalNormalized: 0,
  totalEmbedded: 0,
  lastError: null
});
let getConfigSafe = () => ({});
try {
  ({ startPipelineWorker, wakePipeline, getPipelineStats } = require('./ai/pipelineWorker'));
  ({ getConfigSafe } = require('./ai/config'));
} catch (err) {
  console.warn('[pipeline] module not loaded:', err.message);
}

let sendComplaintEmail = async () => ({ sent: false, reason: 'mailHelper not installed' });
try {
  sendComplaintEmail = require('./mailHelper').sendComplaintEmail;
} catch (_) {}

const COMPLAINT_STATUSES = ['submitted', 'read', 'reviewing', 'in_progress', 'resolved'];

const http = require('http');
const { Server } = require('socket.io');

const app = express();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(extractUserId);

// Broadcast QR events ONLY to that portal user's room (no global steal across tenants)
function emitNewQr(userId, payload) {
  const uid = Number(userId);
  if (!uid) return;
  const data = { ...payload, userId: uid, user_id: uid };
  io.to(`user_${uid}`).emit('new_qr', data);
  io.to(`user_${uid}`).emit('qr_updated', data);
}

function emitQrDisappeared(userId, payload = {}) {
  const uid = Number(userId);
  if (!uid) return;
  const data = {
    status: 'disappeared',
    message: 'WhatsApp opened / QR disappeared',
    timestamp: new Date().toISOString(),
    ...payload,
    userId: uid,
    user_id: uid
  };
  io.to(`user_${uid}`).emit('qr_disappeared', data);
  io.to(`user_${uid}`).emit('qr_cleared', data);
}

/** Push session start/stop to the Baileys worker ( Contabo / local ). Worker also polls claims. */
async function notifyWorker(userId, action = 'start') {
  const base = String(process.env.WORKER_BASE_URL || '').replace(/\/$/, '');
  const key = process.env.WORKER_API_KEY || '';
  const uid = Number(userId);
  if (!base || !uid) return { skipped: true };

  const path =
    action === 'stop'
      ? `/sessions/${uid}/stop`
      : action === 'fresh-qr'
        ? `/sessions/${uid}/fresh-qr`
        : `/sessions/${uid}/start`;

  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key
      },
      body: action === 'stop' ? JSON.stringify({ logout: false }) : undefined,
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[worker] ${action} user=${uid} failed: ${res.status} ${text.slice(0, 160)}`);
      return { ok: false, status: res.status };
    }
    console.log(`[worker] ${action} user=${uid} ok`);
    return { ok: true };
  } catch (err) {
    console.warn(`[worker] ${action} user=${uid} error:`, err.message);
    return { ok: false, error: err.message };
  }
}

function normalizeWaPhone(jidOrPhone) {
  if (!jidOrPhone) return '';
  const bare = String(jidOrPhone).split('@')[0].split(':')[0];
  return bare.replace(/\D/g, '');
}

function waAccountsMatch(a, b) {
  const pa = normalizeWaPhone(a);
  const pb = normalizeWaPhone(b);
  if (!pa || !pb) return false;
  return pa === pb || pa.endsWith(pb) || pb.endsWith(pa);
}

function formatBoundPhone(phone) {
  const digits = normalizeWaPhone(phone);
  if (!digits) return null;
  if (digits.startsWith('92') && digits.length >= 12) return `0${digits.slice(2)}`;
  return digits;
}

async function getActiveLinkSession() {
  const result = await db.query(
    `SELECT s.id, s.user_id, s.status, s.created_at, s.updated_at, u.email, u.name
     FROM whatsapp_link_sessions s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.status IN ('waiting', 'linked')
       AND s.updated_at > NOW() - INTERVAL '2 hours'
     ORDER BY
       CASE WHEN s.status = 'waiting' THEN 0 ELSE 1 END,
       s.updated_at DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function getUserLinkSession(userId) {
  const id = parseInt(userId, 10);
  if (!id || Number.isNaN(id)) return null;
  const result = await db.query(
    `SELECT s.id, s.user_id, s.status, s.whatsapp_jid, s.created_at, s.updated_at, u.email, u.name
     FROM whatsapp_link_sessions s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.user_id = $1 AND s.status IN ('waiting', 'linked')
       AND s.updated_at > NOW() - INTERVAL '24 hours'
     ORDER BY s.updated_at DESC
     LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

/** WhatsApp link state for portal login / connection-status (no 24h window). */
async function resolveWhatsAppConnectionForUser(userId) {
  const id = parseInt(userId, 10);
  if (!id || Number.isNaN(id)) {
    return {
      whatsappConnected: false,
      linked: false,
      status: 'none',
      whatsappJid: null,
      boundWhatsappJid: null,
      boundPhone: null,
      canLinkOtherNumbers: true,
      message: 'Invalid user'
    };
  }

  const [sessionRes, userRes] = await Promise.all([
    db.query(
      `SELECT id, user_id, status, whatsapp_jid, created_at, updated_at
       FROM whatsapp_link_sessions
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [id]
    ),
    db.query(
      'SELECT bound_whatsapp_jid, bound_whatsapp_phone FROM users WHERE id = $1',
      [id]
    )
  ]);

  const link = sessionRes.rows[0] || null;
  const boundJid = userRes.rows[0]?.bound_whatsapp_jid || null;
  const boundPhone =
    userRes.rows[0]?.bound_whatsapp_phone || formatBoundPhone(boundJid);
  const linked = link?.status === 'linked';
  const status = link?.status || (boundJid ? 'waiting' : 'none');

  const scrape = await getScrapeHealth(id);
  const scraping = Boolean(linked && scrape.scrapeOk);
  const message = !linked
    ? boundJid
      ? `Waiting to link bound WhatsApp${boundPhone ? ` ${boundPhone}` : ''}`
      : 'No WhatsApp linked yet — scan QR to bind the first number'
    : scrape.warning || `WhatsApp connected${boundPhone ? ` (${boundPhone})` : ''}`;

  return {
    whatsappConnected: linked,
    linked,
    status,
    whatsappJid: linked ? link?.whatsapp_jid || boundJid : null,
    boundWhatsappJid: boundJid,
    boundPhone: boundPhone || null,
    canLinkOtherNumbers: !boundJid,
    scraping,
    scrapeOk: scrape.scrapeOk,
    needsRescan: Boolean(linked && !scrape.scrapeOk),
    workerStatus: scrape.workerStatus,
    lastInboundAt: scrape.lastInboundAt,
    lastPostedAt: scrape.lastPostedAt,
    message
  };
}

const WORKER_HEARTBEAT_STALE_MS = 90 * 1000;

async function getScrapeHealth(userId) {
  const id = parseInt(userId, 10);
  const empty = {
    scrapeOk: false,
    workerStatus: 'unknown',
    warning: null,
    lastInboundAt: null,
    lastPostedAt: null,
    lastHeartbeatAt: null
  };
  if (!id) return empty;
  try {
    const res = await db.query(
      `SELECT worker_status, scrape_ok, warning, last_heartbeat_at, last_inbound_at, last_posted_at
       FROM whatsapp_scrape_health WHERE user_id = $1`,
      [id]
    );
    const row = res.rows[0];
    if (!row) {
      return {
        ...empty,
        warning: 'Scraper has not reported in — new messages may not be saving. Scan QR if WhatsApp is not linked.'
      };
    }
    const hb = row.last_heartbeat_at ? Date.parse(row.last_heartbeat_at) : 0;
    const stale = !hb || Date.now() - hb > WORKER_HEARTBEAT_STALE_MS;
    if (stale) {
      return {
        scrapeOk: false,
        workerStatus: 'offline',
        warning:
          'Scraper worker stopped reporting. New WhatsApp messages are not being saved. Keep this tab open or re-link WhatsApp.',
        lastInboundAt: row.last_inbound_at || null,
        lastPostedAt: row.last_posted_at || null,
        lastHeartbeatAt: row.last_heartbeat_at || null
      };
    }
    return {
      scrapeOk: row.scrape_ok === true,
      workerStatus: row.worker_status || 'unknown',
      warning: row.warning || null,
      lastInboundAt: row.last_inbound_at || null,
      lastPostedAt: row.last_posted_at || null,
      lastHeartbeatAt: row.last_heartbeat_at || null
    };
  } catch (err) {
    console.error('getScrapeHealth error:', err.message);
    return empty;
  }
}

function emitScrapeStatus(userId, payload) {
  const uid = Number(userId);
  if (!uid) return;
  io.to(`user_${uid}`).emit('whatsapp_connection_status', payload);
  io.to(`user_${uid}`).emit('scrape_health', payload);
}

async function claimLinkSession(userId) {
  const id = parseInt(userId, 10);
  if (!id || Number.isNaN(id)) return null;

  const userCheck = await db.query('SELECT id, email, name, role FROM users WHERE id = $1', [id]);
  if (userCheck.rows.length === 0) return null;

  // Admins manage clients — they must not occupy a WhatsApp link slot
  if (String(userCheck.rows[0].role).toLowerCase() === 'admin') {
    return null;
  }

  // Multi-tenant: keep this user's existing waiting/linked claim; do not release other clients
  const existing = await db.query(
    `SELECT id, user_id, status, whatsapp_jid, created_at, updated_at
     FROM whatsapp_link_sessions
     WHERE user_id = $1 AND status IN ('waiting', 'linked')
       AND updated_at > NOW() - INTERVAL '24 hours'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [id]
  );

  if (existing.rows[0]) {
    const row = existing.rows[0];
    const ageMs = Date.now() - new Date(row.updated_at).getTime();
    // Portal polls /api/qr/latest every few seconds — don't write every time.
    if (!Number.isFinite(ageMs) || ageMs > 120000) {
      await db.query(
        `UPDATE whatsapp_link_sessions SET updated_at = NOW() WHERE id = $1`,
        [row.id]
      );
      row.updated_at = new Date().toISOString();
    }
    return {
      ...row,
      email: userCheck.rows[0].email,
      name: userCheck.rows[0].name
    };
  }

  const inserted = await db.query(
    `INSERT INTO whatsapp_link_sessions (user_id, status)
     VALUES ($1, 'waiting')
     RETURNING id, user_id, status, whatsapp_jid, created_at, updated_at`,
    [id]
  );

  return {
    ...inserted.rows[0],
    email: userCheck.rows[0].email,
    name: userCheck.rows[0].name
  };
}

/**
 * Resolve which client owns this WhatsApp action.
 * Worker posts always include x-force-user-id + x-user-id and must NEVER be remapped
 * to another portal user's "active claim" (that bug made same-WA scans land on user 1).
 */
async function resolveQrUserId(req) {
  const explicitRaw =
    req.body?.userId ||
    req.body?.user_id ||
    req.query?.userId ||
    req.query?.user_id ||
    req.headers['x-user-id'];
  const explicit =
    explicitRaw != null && String(explicitRaw).trim() !== '' && !isNaN(parseInt(explicitRaw, 10))
      ? parseInt(explicitRaw, 10)
      : null;

  const forceExplicit = String(req.headers['x-force-user-id'] || '') === '1';
  const source = String(req.body?.source || '').toLowerCase();
  const fromWorker =
    forceExplicit ||
    source === 'whatsapp-worker' ||
    String(req.headers['x-wa-worker'] || '') === '1';

  // Worker / forced tenant id is authoritative — allow same WA on many portal users
  if (explicit && fromWorker) return explicit;

  // Any real non-admin explicit id also wins (do not steal onto active claim)
  if (explicit && explicit !== 1) return explicit;

  const session = await getActiveLinkSession();

  // Legacy extension auto-map: only when no usable explicit id
  if (session?.user_id) {
    const sid = parseInt(session.user_id, 10);
    if (!explicit || explicit === 1 || explicit === sid) return sid;
    return explicit;
  }

  if (explicit) return explicit;
  if (req.userId) return parseInt(req.userId, 10);
  return null;
}

// Socket.IO real-time event handling
io.on('connection', (socket) => {
  console.log('Client connected to Socket.IO:', socket.id);

  socket.on('join_user_room', async (data) => {
    if (data && (data.userId || data.user_id)) {
      const userId = data.userId || data.user_id;
      const roomName = `user_${userId}`;
      socket.join(roomName);
      console.log(`Socket ${socket.id} joined user room: ${roomName}`);

      // Auto-claim: portal user opening QR page owns the next WhatsApp link
      try {
        const session = await claimLinkSession(userId);
        if (session) {
          const userBound = await db.query(
            'SELECT bound_whatsapp_jid, bound_whatsapp_phone FROM users WHERE id = $1',
            [userId]
          );
          const boundJid = userBound.rows[0]?.bound_whatsapp_jid || session.whatsapp_jid || null;
          const boundPhone =
            userBound.rows[0]?.bound_whatsapp_phone || formatBoundPhone(boundJid);
          io.to(roomName).emit('link_session_claimed', session);
          io.to(roomName).emit('whatsapp_connection_status', {
            userId: Number(userId),
            status: session.status,
            linked: session.status === 'linked',
            whatsappJid: session.whatsapp_jid || null,
            boundWhatsappJid: boundJid,
            boundPhone
          });
          console.log(`Auto-claimed link session for user_${userId} status=${session.status}`);
          // Wake Baileys worker immediately so QR appears over Socket.IO without waiting for poll
          if (session.status === 'waiting' || session.status === 'linked') {
            notifyWorker(userId, 'start').catch(() => {});
          }
        }
      } catch (err) {
        console.error('Auto-claim on join_user_room failed:', err.message);
      }
    }
  });

  // 1. Extension emits 'new_qr' -> Backend broadcasts 'new_qr' to Web Portal
  socket.on('new_qr', async (data) => {
    console.log('Socket event new_qr received:', data);
    const userId = data?.userId || data?.user_id || 1;
    try {
      if (data && data.url) {
        await db.query(
          'INSERT INTO qr_codes (url, source, page_url, user_id) VALUES ($1, $2, $3, $4)',
          [data.url, data.source || 'whatsapp', data.pageUrl || null, userId]
        );
      }
    } catch (err) {
      console.error('Error saving socket new_qr to DB:', err.message);
    }
    emitNewQr(userId, data || {});
  });

  // 2. Extension emits 'qr_disappeared' -> Backend broadcasts 'qr_disappeared' to Web Portal
  socket.on('qr_disappeared', (data) => {
    console.log('Socket event qr_disappeared received:', data);
    const userId = data?.userId || data?.user_id || 1;
    emitQrDisappeared(userId, data || {});
  });

  // Legacy support fallback
  socket.on('qr_updated', (data) => {
    const userId = data?.userId || data?.user_id || 1;
    emitNewQr(userId, data || {});
  });
  socket.on('qr_cleared', (data) => {
    const userId = data?.userId || data?.user_id || 1;
    emitQrDisappeared(userId, data || {});
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected from Socket.IO:', socket.id);
  });
});

// 1. Admin Sign Up
app.post('/api/auth/admin/signup', async (req, res) => {
  const { email, password, name, phone_number } = req.body;

  if (!email || !password) {
    return sendResponse(res, 400, true, null, 'Email and password are required');
  }

  try {
    // Check if email already exists
    const checkUser = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (checkUser.rows.length > 0) {
      return sendResponse(res, 400, true, null, 'Email already registered');
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Insert admin user
    const result = await db.query(
      'INSERT INTO users (email, password_hash, role, is_first_login, name, phone_number) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, role, name, phone_number',
      [email, passwordHash, 'admin', false, name || null, phone_number || null]
    );

    return sendResponse(res, 201, false, result.rows[0], 'Admin account created successfully');
  } catch (err) {
    console.error('Signup error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 2. Login Endpoint (For both Admins and Users)
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return sendResponse(res, 400, true, null, 'Email and password are required');
  }

  try {
    // Find user by email
    const userResult = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return sendResponse(res, 401, true, null, 'Invalid email or password');
    }

    const user = userResult.rows[0];

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return sendResponse(res, 401, true, null, 'Invalid email or password');
    }

    // Generate JWT Token
    const payload = {
      id: user.id,
      email: user.email,
      role: user.role
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET || 'super_secret_jwt_key_123!', {
      expiresIn: '24h'
    });

    const data = {
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
        phone_number: user.phone_number
      }
    };

    if (user.role === 'user') {
      data.user.is_first_login = user.is_first_login;
    }

    const whatsapp = await resolveWhatsAppConnectionForUser(user.id);
    data.whatsappConnected = whatsapp.whatsappConnected;
    data.whatsapp = whatsapp;

    return sendResponse(res, 200, false, data, 'Login successful');
  } catch (err) {
    console.error('Login error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 3. Create User Endpoint (Admin Only)
app.post('/api/users', authenticateToken, isAdmin, async (req, res) => {
  const { email, password, name, phone_number } = req.body;

  if (!email || !password) {
    return sendResponse(res, 400, true, null, 'Email and password are required');
  }

  try {
    // Check if email already exists
    const checkUser = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (checkUser.rows.length > 0) {
      return sendResponse(res, 400, true, null, 'Email already registered');
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Create user (role defaults to 'user', is_first_login defaults to true)
    const result = await db.query(
      'INSERT INTO users (email, password_hash, role, is_first_login, name, phone_number) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, role, name, phone_number',
      [email, passwordHash, 'user', true, name || null, phone_number || null]
    );

    return sendResponse(res, 201, false, result.rows[0], 'User account created successfully');
  } catch (err) {
    console.error('Create user error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 3b. Delete User Endpoint (Admin Only) — cascades QR/chats/messages via FK ON DELETE CASCADE
app.delete('/api/users/:id', authenticateToken, isAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (!targetId || Number.isNaN(targetId)) {
    return sendResponse(res, 400, true, null, 'Valid user id is required');
  }
  if (targetId === 1) {
    return sendResponse(res, 400, true, null, 'Default admin user (id=1) cannot be deleted');
  }
  if (req.user && Number(req.user.id) === targetId) {
    return sendResponse(res, 400, true, null, 'You cannot delete your own account');
  }

  try {
    const existing = await db.query('SELECT id, email, role FROM users WHERE id = $1', [targetId]);
    if (existing.rows.length === 0) {
      return sendResponse(res, 404, true, null, 'User not found');
    }

    // Extra safety cleanup in case some related tables lack CASCADE yet
    await db.query('DELETE FROM qr_codes WHERE user_id = $1', [targetId]);
    await db.query('DELETE FROM whatsapp_messages WHERE user_id = $1', [targetId]);
    await db.query('DELETE FROM whatsapp_chats WHERE user_id = $1', [targetId]);

    const result = await db.query(
      'DELETE FROM users WHERE id = $1 RETURNING id, email, role, name',
      [targetId]
    );

    return sendResponse(res, 200, false, result.rows[0], 'User and related data deleted successfully');
  } catch (err) {
    console.error('Delete user error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 4. Reset Password Endpoint (Authenticated User)
app.post('/api/auth/reset-password', authenticateToken, async (req, res) => {
  const { newPassword } = req.body;

  if (!newPassword) {
    return sendResponse(res, 400, true, null, 'New password is required');
  }

  try {
    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    // Update password hash and set is_first_login to false
    const result = await db.query(
      'UPDATE users SET password_hash = $1, is_first_login = $2 WHERE id = $3 RETURNING id, email, role',
      [passwordHash, false, req.user.id]
    );

    if (result.rows.length === 0) {
      return sendResponse(res, 404, true, null, 'User not found');
    }

    return sendResponse(res, 200, false, result.rows[0], 'Password updated successfully');
  } catch (err) {
    console.error('Password reset error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 5. Post QR URL
app.post('/api/qr', async (req, res) => {
  const { url, source, pageUrl } = req.body;
  const userId = (await resolveQrUserId(req)) || 1;

  if (!url) {
    return sendResponse(res, 400, true, null, 'URL is required');
  }

  try {
    const result = await db.query(
      'INSERT INTO qr_codes (url, source, page_url, user_id) VALUES ($1, $2, $3, $4) RETURNING id, url, source, page_url, user_id, created_at',
      [url, source || 'whatsapp', pageUrl || null, userId]
    );

    const qrData = result.rows[0];
    // Do NOT update updated_at here — QR posts are automated worker outputs and must not bump human user presence.

    emitNewQr(userId, {
      ...qrData,
      url: qrData.url,
      source: qrData.source,
      pageUrl: qrData.page_url
    });

    return sendResponse(res, 201, false, qrData, 'QR URL saved successfully');
  } catch (err) {
    console.error('Post QR error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 5a. Portal claims the operator WhatsApp link slot for the logged-in client
app.post('/api/qr/claim', async (req, res) => {
  const userId = parseInt(
    req.userId || req.body.userId || req.body.user_id || req.headers['x-user-id'],
    10
  );

  if (!userId || Number.isNaN(userId)) {
    return sendResponse(res, 400, true, null, 'Authenticated userId is required to claim QR session');
  }

  try {
    const session = await claimLinkSession(userId);
    if (!session) {
      return sendResponse(res, 404, true, null, 'User not found');
    }

    io.emit('link_session_claimed', session);
    io.to(`user_${userId}`).emit('link_session_claimed', session);

    if (session.status === 'waiting' || session.status === 'linked') {
      notifyWorker(userId, 'start').catch(() => {});
    }

    return sendResponse(res, 200, false, session, 'QR link session claimed for this user');
  } catch (err) {
    console.error('QR claim error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 5a2. Extensions / worker poll this to know which client user owns WhatsApp right now
app.get('/api/qr/active-session', async (req, res) => {
  try {
    const wanted = req.query.userId || req.query.user_id || req.headers['x-user-id'];
    let session = null;
    if (wanted) {
      const result = await db.query(
        `SELECT s.id, s.user_id, s.status, s.created_at, s.updated_at, u.email, u.name
         FROM whatsapp_link_sessions s
         LEFT JOIN users u ON u.id = s.user_id
         WHERE s.user_id = $1 AND s.status IN ('waiting', 'linked')
           AND s.updated_at > NOW() - INTERVAL '2 hours'
         ORDER BY s.updated_at DESC
         LIMIT 1`,
        [parseInt(wanted, 10)]
      );
      session = result.rows[0] || null;
    } else {
      session = await getActiveLinkSession();
    }
    if (!session) {
      return sendResponse(res, 404, true, null, 'No active QR/link session');
    }
    return sendResponse(res, 200, false, {
      id: session.id,
      userId: session.user_id,
      user_id: session.user_id,
      status: session.status,
      email: session.email,
      name: session.name,
      created_at: session.created_at,
      updated_at: session.updated_at
    }, 'Active link session retrieved');
  } catch (err) {
    console.error('Get active session error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 5a2b. Worker: list all waiting/linked sessions (multi-client)
app.get('/api/qr/sessions', async (req, res) => {
  try {
    const workerSlim = String(req.query.worker || '') === '1';
    const result = await db.query(
      workerSlim
        ? `SELECT s.id, s.user_id, s.status, s.created_at, s.updated_at, u.email, u.name
           FROM whatsapp_link_sessions s
           LEFT JOIN users u ON u.id = s.user_id
           WHERE s.status = 'linked'
              OR (s.status = 'waiting' AND s.updated_at > NOW() - INTERVAL '15 minutes')
           ORDER BY s.updated_at DESC`
        : `SELECT s.id, s.user_id, s.status, s.created_at, s.updated_at, u.email, u.name
           FROM whatsapp_link_sessions s
           LEFT JOIN users u ON u.id = s.user_id
           WHERE s.status IN ('waiting', 'linked')
             AND s.updated_at > NOW() - INTERVAL '24 hours'
           ORDER BY s.updated_at DESC`
    );
    const rows = result.rows.map((s) => ({
      id: s.id,
      userId: s.user_id,
      user_id: s.user_id,
      status: s.status,
      email: s.email,
      name: s.name,
      created_at: s.created_at,
      updated_at: s.updated_at
    }));
    return sendResponse(res, 200, false, rows, 'Link sessions retrieved');
  } catch (err) {
    console.error('Get sessions error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 5a3. Release / clear active session
app.post('/api/qr/release', async (req, res) => {
  const userId = parseInt(
    req.userId || req.body?.userId || req.body?.user_id || req.headers['x-user-id'],
    10
  );
  try {
    if (userId) {
      await db.query(
        `UPDATE whatsapp_link_sessions SET status = 'released', updated_at = NOW() WHERE user_id = $1 AND status = 'waiting'`,
        [userId]
      );
      io.to(`user_${userId}`).emit('link_session_released', { status: 'released', userId });
      notifyWorker(userId, 'stop').catch(() => {});
    } else {
      await db.query(
        `UPDATE whatsapp_link_sessions SET status = 'released', updated_at = NOW() WHERE status = 'waiting'`
      );
      io.emit('link_session_released', { status: 'released' });
    }
    return sendResponse(res, 200, false, { status: 'released', userId: userId || null }, 'Link session released');
  } catch (err) {
    console.error('QR release error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 5a3a. User Auth Logout Endpoint
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (userId) {
      await db.query(
        `UPDATE whatsapp_link_sessions SET status = 'released', updated_at = NOW() WHERE user_id = $1 AND status = 'waiting'`,
        [userId]
      );
      io.to(`user_${userId}`).emit('link_session_released', { status: 'released', userId });
    }
    return sendResponse(res, 200, false, null, 'Logged out successfully');
  } catch (err) {
    console.error('Logout error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 5a3b. Worker: after logout / bad session, put user back to waiting for a fresh QR
app.post('/api/qr/reset-waiting', async (req, res) => {
  const userId = parseInt(
    req.userId || req.body.userId || req.body.user_id || req.headers['x-user-id'],
    10
  );
  if (!userId || Number.isNaN(userId)) {
    return sendResponse(res, 400, true, null, 'userId is required');
  }
  try {
    const pausedCount = await stampMonitoredScrapePause(userId);
    const result = await db.query(
      `UPDATE whatsapp_link_sessions
       SET status = 'waiting', whatsapp_jid = NULL, updated_at = NOW()
       WHERE user_id = $1 AND status IN ('waiting', 'linked')
       RETURNING id, user_id, status, created_at, updated_at`,
      [userId]
    );
    if (!result.rows[0]) {
      const inserted = await db.query(
        `INSERT INTO whatsapp_link_sessions (user_id, status)
         VALUES ($1, 'waiting')
         RETURNING id, user_id, status, created_at, updated_at`,
        [userId]
      );
      return sendResponse(
        res,
        200,
        false,
        { ...inserted.rows[0], pausedMonitoredChats: pausedCount },
        'Link session created as waiting'
      );
    }
    io.to(`user_${userId}`).emit('link_session_waiting', {
      userId,
      status: 'waiting'
    });
    io.to(`user_${userId}`).emit('whatsapp_connection_status', {
      userId: Number(userId),
      status: 'waiting',
      linked: false,
      whatsappConnected: false,
      whatsappJid: null,
      message: 'WhatsApp logged out — scan QR to reconnect'
    });
    return sendResponse(res, 200, false, { ...result.rows[0], pausedMonitoredChats: pausedCount }, 'Link session reset to waiting');
  } catch (err) {
    console.error('QR reset-waiting error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 5b. Worker/extension: WhatsApp linked (or QR cleared)
app.post('/api/qr/status', async (req, res) => {
  const userId = (await resolveQrUserId(req)) || 1;
  const whatsappJid = (
    req.body.whatsappJid ||
    req.body.whatsapp_jid ||
    req.body.waJid ||
    req.body.jid ||
    null
  );
  const phone = normalizeWaPhone(whatsappJid);

  try {
    const userRes = await db.query(
      'SELECT id, bound_whatsapp_jid, bound_whatsapp_phone FROM users WHERE id = $1',
      [userId]
    );
    const user = userRes.rows[0];
    if (!user) {
      return sendResponse(res, 404, true, null, 'User not found');
    }

    // Sticky bind: first successful WhatsApp number is permanent for this portal user
    if (whatsappJid && user.bound_whatsapp_jid) {
      if (!waAccountsMatch(user.bound_whatsapp_jid, whatsappJid)) {
        const boundPhone =
          user.bound_whatsapp_phone || formatBoundPhone(user.bound_whatsapp_jid);
        io.to(`user_${userId}`).emit('whatsapp_bind_mismatch', {
          userId,
          linked: false,
          boundWhatsappJid: user.bound_whatsapp_jid,
          boundPhone,
          attemptedWhatsappJid: whatsappJid,
          message: `This portal user can only link WhatsApp ${boundPhone || user.bound_whatsapp_jid}`
        });
        io.to(`user_${userId}`).emit('whatsapp_connection_status', {
          userId,
          status: 'waiting',
          linked: false,
          boundWhatsappJid: user.bound_whatsapp_jid,
          boundPhone,
          error: 'WHATSAPP_BIND_MISMATCH'
        });
        return sendResponse(
          res,
          409,
          true,
          {
            code: 'WHATSAPP_BIND_MISMATCH',
            boundWhatsappJid: user.bound_whatsapp_jid,
            boundPhone,
            attemptedWhatsappJid: whatsappJid
          },
          `Portal user is permanently bound to WhatsApp ${boundPhone || user.bound_whatsapp_jid}`
        );
      }
    } else if (whatsappJid && !user.bound_whatsapp_jid) {
      await db.query(
        `UPDATE users
         SET bound_whatsapp_jid = $2,
             bound_whatsapp_phone = $3
         WHERE id = $1 AND bound_whatsapp_jid IS NULL`,
        [userId, String(whatsappJid), phone || null]
      );
    }

    await db.query(
      `UPDATE whatsapp_link_sessions
       SET status = 'linked',
           whatsapp_jid = COALESCE($2, whatsapp_jid),
           updated_at = NOW()
       WHERE user_id = $1 AND status IN ('waiting', 'linked')`,
      [userId, whatsappJid]
    );

    const bound = await db.query(
      'SELECT bound_whatsapp_jid, bound_whatsapp_phone FROM users WHERE id = $1',
      [userId]
    );
    const boundJid = bound.rows[0]?.bound_whatsapp_jid || whatsappJid;
    const boundPhone =
      bound.rows[0]?.bound_whatsapp_phone ||
      formatBoundPhone(boundJid);

    const payload = {
      status: req.body.status || 'disappeared',
      message: req.body.message || 'WhatsApp logged in / QR code cleared',
      timestamp: new Date().toISOString(),
      userId,
      whatsappJid: whatsappJid || null,
      boundWhatsappJid: boundJid || null,
      boundPhone: boundPhone || null,
      linked: true
    };

    emitQrDisappeared(userId, payload);
    io.to(`user_${userId}`).emit('whatsapp_connection_status', {
      userId,
      status: 'linked',
      linked: true,
      whatsappJid: whatsappJid || null,
      boundWhatsappJid: boundJid || null,
      boundPhone: boundPhone || null
    });

    return sendResponse(res, 200, false, payload, 'WhatsApp linked for this portal user');
  } catch (err) {
    console.error('Failed to mark link session linked:', err.message);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 6. Get Latest QR URL — only while waiting to link (never while linked)
app.get('/api/qr/latest', async (req, res) => {
  const userId = req.userId || req.query.userId || req.query.user_id || null;

  if (userId) {
    try {
      await claimLinkSession(userId);
    } catch (err) {
      console.error('Auto-claim on latest QR failed:', err.message);
    }
  }

  const resolvedUserId = userId || (await resolveQrUserId(req)) || 1;
  try {
    const link = await getUserLinkSession(resolvedUserId);
    if (link?.status === 'linked') {
      const userBound = await db.query(
        'SELECT bound_whatsapp_jid, bound_whatsapp_phone FROM users WHERE id = $1',
        [resolvedUserId]
      );
      const boundJid = userBound.rows[0]?.bound_whatsapp_jid || link.whatsapp_jid || null;
      const boundPhone =
        userBound.rows[0]?.bound_whatsapp_phone || formatBoundPhone(boundJid);
      const scrape = await getScrapeHealth(resolvedUserId);
      return sendResponse(
        res,
        200,
        false,
        {
          linked: true,
          status: 'linked',
          userId: Number(resolvedUserId),
          user_id: Number(resolvedUserId),
          whatsappJid: link.whatsapp_jid || boundJid,
          boundWhatsappJid: boundJid,
          boundPhone,
          url: null,
          scraping: scrape.scrapeOk,
          scrapeOk: scrape.scrapeOk,
          needsRescan: !scrape.scrapeOk,
          workerStatus: scrape.workerStatus,
          message: scrape.warning || 'WhatsApp already connected — QR not shown'
        },
        scrape.warning || 'WhatsApp already connected — QR not shown'
      );
    }

    const result = await db.query(
      `SELECT id, url, source, page_url, user_id, created_at
       FROM qr_codes
       WHERE user_id = $1
         AND created_at > NOW() - INTERVAL '5 minutes'
       ORDER BY created_at DESC
       LIMIT 1`,
      [resolvedUserId]
    );

    if (result.rows.length === 0) {
      return sendResponse(res, 404, true, {
        linked: false,
        status: link?.status || 'waiting',
        userId: Number(resolvedUserId)
      }, 'No fresh QR URL found');
    }

    return sendResponse(res, 200, false, {
      ...result.rows[0],
      linked: false,
      status: 'waiting'
    }, 'Latest QR URL retrieved successfully');
  } catch (err) {
    console.error('Get latest QR error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 6b. Portal: is WhatsApp logged in for this user?
// GET /api/qr/connection-status?userId=28
app.get('/api/qr/connection-status', async (req, res) => {
  const userId = req.userId || req.query.userId || req.query.user_id || null;
  if (!userId) {
    return sendResponse(res, 400, true, null, 'userId is required');
  }
  try {
    const whatsapp = await resolveWhatsAppConnectionForUser(userId);

    return sendResponse(
      res,
      200,
      false,
      {
        userId: Number(userId),
        ...whatsapp
      },
      whatsapp.message || (whatsapp.linked ? 'WhatsApp connected' : 'WhatsApp not connected')
    );
  } catch (err) {
    console.error('Get connection status error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// Worker heartbeat: phone can look linked while scrape is dead (Bad MAC / no inbound).
app.post('/api/qr/scrape-health', async (req, res) => {
  const userId = resolveTenantUserId(req, null);
  if (!userId) {
    return sendResponse(res, 401, true, null, 'userId is required');
  }
  const body = req.body || {};
  const workerStatus = String(body.status || body.workerStatus || 'unknown').slice(0, 32);
  const scrapeOk = body.scrapeOk === true || body.scrape_ok === true;
  const warning = body.warning ? String(body.warning).slice(0, 500) : null;
  const lastInboundAt = body.lastInboundAt || body.last_inbound_at || null;
  const lastPostedAt = body.lastPostedAt || body.last_posted_at || null;
  try {
    const prev = await db.query(
      'SELECT scrape_ok, warning FROM whatsapp_scrape_health WHERE user_id = $1',
      [userId]
    );
    await db.query(
      `INSERT INTO whatsapp_scrape_health (
         user_id, worker_status, scrape_ok, warning, last_heartbeat_at, last_inbound_at, last_posted_at, updated_at
       ) VALUES ($1, $2, $3, $4, NOW(), $5, $6, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         worker_status = EXCLUDED.worker_status,
         scrape_ok = EXCLUDED.scrape_ok,
         warning = EXCLUDED.warning,
         last_heartbeat_at = NOW(),
         last_inbound_at = COALESCE(EXCLUDED.last_inbound_at, whatsapp_scrape_health.last_inbound_at),
         last_posted_at = COALESCE(EXCLUDED.last_posted_at, whatsapp_scrape_health.last_posted_at),
         updated_at = NOW()`,
      [
        userId,
        workerStatus,
        scrapeOk,
        warning,
        lastInboundAt,
        lastPostedAt
      ]
    );
    const prevOk = prev.rows[0]?.scrape_ok === true;
    const prevWarn = prev.rows[0]?.warning || null;
    if (prevOk !== scrapeOk || prevWarn !== warning) {
      const whatsapp = await resolveWhatsAppConnectionForUser(userId);
      emitScrapeStatus(userId, {
        userId,
        ...whatsapp
      });
    }
    return sendResponse(res, 200, false, { userId, scrapeOk, workerStatus }, 'Scrape health saved');
  } catch (err) {
    console.error('scrape-health error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

function parsePositiveInt(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isWorkerRequest(req) {
  return (
    String(req.headers['x-force-user-id'] || '') === '1' ||
    String(req.headers['x-wa-worker'] || '') === '1'
  );
}

function resolveTenantUserId(req, fallback = null) {
  const headerId = parsePositiveInt(req.headers['x-user-id']);
  const bodyId = parsePositiveInt(req.body?.userId || req.body?.user_id);
  const queryId = parsePositiveInt(req.query?.userId || req.query?.user_id);
  const jwtId = req.authFromJwt
    ? parsePositiveInt(req.userId || req.user?.id || req.user?.userId)
    : null;

  // Worker posts are authoritative (never remap onto another portal user).
  if (isWorkerRequest(req)) {
    return headerId || bodyId || jwtId || fallback;
  }

  // Logged-in portal user: always their own tenant. Query/header cannot
  // sneak in another account's chatrooms.
  if (jwtId) return jwtId;

  return bodyId || queryId || headerId || fallback;
}

/** Stamp last_scraped_at on all monitored chats (WhatsApp logout / session pause). */
async function stampMonitoredScrapePause(userId) {
  const result = await db.query(
    `UPDATE whatsapp_chats
     SET last_scraped_at = GREATEST(COALESCE(last_scraped_at, to_timestamp(0)), NOW())
     WHERE user_id = $1 AND is_monitored = TRUE
     RETURNING jid`,
    [userId]
  );
  return result.rowCount;
}

function parseChatListQuery(req) {
  const userId = resolveTenantUserId(req, null);
  const rawType = String(req.query.type || req.query.filter || 'all').toLowerCase();
  const type = ['monitored', 'chats', 'all'].includes(rawType) ? rawType : 'all';
  const search = String(req.query.search || req.query.q || '').trim();
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 50, 1), 200);
  const offset = (page - 1) * pageSize;
  return { userId, type, search, page, pageSize, offset };
}

function buildChatListSql({ userId, type, search, pageSize, offset }) {
  const params = [userId];
  let where = 'WHERE c.user_id = $1';

  if (type === 'monitored') {
    where += ' AND c.is_monitored = TRUE';
  } else if (type === 'chats') {
    where += ' AND c.is_monitored = FALSE';
  }

  if (search) {
    params.push(`%${search}%`);
    where += ` AND (LOWER(COALESCE(c.name, '')) LIKE LOWER($${params.length}) OR LOWER(c.jid) LIKE LOWER($${params.length}))`;
  }

  const countSql = `SELECT COUNT(*)::int AS total FROM whatsapp_chats c ${where}`;
  const countParams = [...params];

  params.push(pageSize, offset);
  const sql = `
    SELECT c.jid, c.name, c.avatar, c.is_monitored, c.user_id, c.created_at, c.monitored_at, c.last_scraped_at,
           lm.last_message_at,
           lm.last_message_preview
    FROM whatsapp_chats c
    LEFT JOIN LATERAL (
      SELECT m.created_at AS last_message_at,
             LEFT(COALESCE(m.message, ''), 120) AS last_message_preview
      FROM whatsapp_messages m
      WHERE m.user_id = c.user_id AND m.chat_jid = c.jid
      ORDER BY m.created_at DESC NULLS LAST, m.id DESC
      LIMIT 1
    ) lm ON TRUE
    ${where}
    ORDER BY COALESCE(lm.last_message_at, c.last_scraped_at, c.created_at) DESC NULLS LAST,
             c.name ASC NULLS LAST, c.jid ASC
    LIMIT $${params.length - 1} OFFSET $${params.length}`;

  return { sql, params, countSql, countParams };
}

// 7. Post scraped chat rooms (worker dumps full WhatsApp chat list)
app.post('/api/scraped-chats/contacts', async (req, res) => {
  const { contacts } = req.body;
  const userId = resolveTenantUserId(req, null);
  if (!userId) {
    return sendResponse(res, 401, true, null, 'userId is required');
  }
  if (!Array.isArray(contacts)) {
    return sendResponse(res, 400, true, null, 'Contacts array is required');
  }
  try {
    const result = await upsertChatsBulk(userId, contacts);
    return sendResponse(
      res,
      200,
      false,
      { upserted: result.upserted, received: result.received },
      'Contacts updated successfully'
    );
  } catch (err) {
    console.error('Contacts update error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 8. Get Monitored Chats list (Includes last_scraped_timestamp for incremental sync)
app.get('/api/scraped-chats/monitored', async (req, res) => {
  const userId = resolveTenantUserId(req, null);
  if (!userId) {
    return sendResponse(res, 401, true, null, 'Login required');
  }
  try {
    const result = await db.query(
      `SELECT c.jid, c.name, c.avatar, c.is_monitored, c.user_id, c.created_at,
         c.monitored_at,
         c.monitor_letter,
         c.last_scraped_at
       FROM whatsapp_chats c 
       WHERE c.user_id = $1 AND c.is_monitored = TRUE 
       ORDER BY c.monitor_letter ASC NULLS LAST, c.name ASC`,
      [userId]
    );
    return sendResponse(res, 200, false, result.rows, 'Monitored chats retrieved successfully');
  } catch (err) {
    console.error('Get monitored error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 9. Post Scraped Chat Messages (Canonical JID matching to prevent duplicate recipient creation)
app.post('/api/scraped-chats/messages', async (req, res) => {
  const { chatId, chatName, messages, jid, name } = req.body;
  const userId = resolveTenantUserId(req, null);
  if (!userId) {
    return sendResponse(res, 401, true, null, 'userId is required');
  }
  const resolvedChatId = chatId || jid || null;
  const resolvedChatName = chatName || name || null;

  if ((!resolvedChatId && !resolvedChatName) || !Array.isArray(messages)) {
    return sendResponse(res, 400, true, null, 'chatId/jid or chatName/name and messages array are required');
  }

  // Empty payloads are valid no-ops (avoid noisy errors from extension observers)
  if (messages.length === 0) {
    return sendResponse(res, 200, false, { addedCount: 0, skippedCount: 0, userId }, 'No messages to save');
  }

  try {
    // Resolve canonical JID from database for this user
    const canonicalJid = await findOrCreateCanonicalChat(userId, resolvedChatId, resolvedChatName);
    if (!canonicalJid) {
      return sendResponse(res, 200, false, { addedCount: 0, skippedCount: messages.length }, 'Ignored system notification message payload');
    }

    let addedCount = 0;
    let skippedCount = 0;
    const insertErrors = [];
    let maxMessageEpoch = null;
    let seqFrom = null;
    let seqTo = null;
    const toInsert = [];

    for (const msg of messages) {
      const sender = (msg.sender ?? '').toString().trim();
      const timestamp = (msg.timestamp ?? '').toString().trim();
      const messageText = (msg.message ?? msg.text ?? '').toString();
      const rawEpoch = msg.messageEpoch ?? msg.message_epoch ?? msg.ts_epoch;
      const messageEpoch =
        rawEpoch != null && !Number.isNaN(Number(rawEpoch)) ? Number(rawEpoch) : null;
      const rawFromMe = msg.fromMe ?? msg.from_me ?? false;
      const isFromMe =
        rawFromMe === true ||
        rawFromMe === 1 ||
        String(rawFromMe).toLowerCase() === 'true';
      const rawSenderPhone =
        msg.senderPhone ?? msg.sender_phone ?? msg.participantPhone ?? msg.participant_phone ?? null;
      let senderPhone = null;
      if (rawSenderPhone) {
        try {
          const { normalizePkMobile } = require('./ai/listingSplitter');
          senderPhone = normalizePkMobile(rawSenderPhone) || String(rawSenderPhone).trim() || null;
        } catch (_) {
          senderPhone = String(rawSenderPhone).trim() || null;
        }
      }

      if (!timestamp && !messageText) {
        skippedCount++;
        continue;
      }
      if (isCommonJunkMessage(messageText)) {
        skippedCount++;
        continue;
      }
      toInsert.push({
        sender: sender || 'unknown',
        senderPhone,
        timestamp: timestamp || 'unknown',
        messageText,
        isFromMe,
        messageEpoch
      });
    }

    if (toInsert.length) {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT id FROM whatsapp_chats WHERE user_id = $1 AND jid = $2 FOR UPDATE`,
          [userId, canonicalJid]
        );

        // Drop body-identical reposts already stored for this user (any chat).
        const prior = await client.query(
          `SELECT content_fingerprint, message FROM whatsapp_messages
           WHERE user_id = $1
             AND (
               content_fingerprint IS NOT NULL
               OR id > (SELECT COALESCE(MAX(id),0) - 20000 FROM whatsapp_messages WHERE user_id = $1)
             )
           ORDER BY id DESC
           LIMIT 20000`,
          [userId]
        );
        const seenBodies = new Set();
        for (const r of prior.rows) {
          if (r.content_fingerprint) {
            seenBodies.add(r.content_fingerprint);
            continue;
          }
          const fp = userMessageFingerprint(userId, r.message);
          if (fp) seenBodies.add(fp);
        }
        const uniqueRows = [];
        for (const row of toInsert) {
          const fp = userMessageFingerprint(userId, row.messageText);
          if (fp && seenBodies.has(fp)) {
            skippedCount += 1;
            continue;
          }
          if (fp) seenBodies.add(fp);
          uniqueRows.push({ ...row, contentFingerprint: fp || null });
        }

        if (!uniqueRows.length) {
          await client.query('COMMIT');
        } else {
        const params = [];
        const values = [];
        let p = 1;
        for (const row of uniqueRows) {
          values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
          params.push(
            userId,
            canonicalJid,
            row.sender,
            row.timestamp,
            row.messageText,
            row.isFromMe,
            row.contentFingerprint,
            row.senderPhone || null
          );
        }
        // Never put seq_in_chat on the INSERT. A unique seq collision used to
        // ROLLBACK the whole batch, so the worker "posted" but nothing saved.
        const result = await client.query(
          `INSERT INTO whatsapp_messages (user_id, chat_jid, sender, timestamp, message, from_me, content_fingerprint, sender_phone)
           VALUES ${values.join(',')}
           ON CONFLICT (user_id, chat_jid, sender, timestamp, message)
           DO NOTHING
           RETURNING id`,
          params
        );
        addedCount = result.rows.length;
        skippedCount += uniqueRows.length - addedCount;
        await client.query('COMMIT');

        const newIds = result.rows
          .map((r) => parseInt(r.id, 10))
          .filter((n) => Number.isFinite(n));
        if (newIds.length) {
          try {
            await client.query('BEGIN');
            await client.query(
              `SELECT id FROM whatsapp_chats WHERE user_id = $1 AND jid = $2 FOR UPDATE`,
              [userId, canonicalJid]
            );
            // Sticky letter for this monitored chat (a, b, c, …)
            await ensureMonitorLetter(userId, canonicalJid, client);
            for (const id of newIds) {
              const nextSeq = await allocateSeqInChat(client, userId, canonicalJid);
              const numbered = await client.query(
                `UPDATE whatsapp_messages m
                 SET seq_in_chat = $4
                 WHERE m.id = $3 AND m.seq_in_chat IS NULL
                 RETURNING m.seq_in_chat`,
                [userId, canonicalJid, id, nextSeq]
              );
              const seq = numbered.rows[0]?.seq_in_chat;
              if (seq != null) {
                const n = parseSeqNumber(seq);
                const fromN = parseSeqNumber(seqFrom);
                const toN = parseSeqNumber(seqTo);
                if (seqFrom == null || (n != null && fromN != null && n < fromN) || fromN == null) {
                  seqFrom = seq;
                }
                if (seqTo == null || (n != null && toN != null && n > toN) || toN == null) {
                  seqTo = seq;
                }
              }
            }
            await client.query('COMMIT');
          } catch (seqErr) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            console.error(
              `seq_in_chat assign failed (messages kept) user=${userId} jid=${canonicalJid}:`,
              seqErr.message
            );
          }
        }

        for (const row of uniqueRows) {
          if (row.messageEpoch != null) {
            maxMessageEpoch =
              maxMessageEpoch == null
                ? row.messageEpoch
                : Math.max(maxMessageEpoch, row.messageEpoch);
          }
        }
        if (addedCount === 0) maxMessageEpoch = null;
        } // end uniqueRows.length
      } catch (insertErr) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        skippedCount += toInsert.length;
        insertErrors.push(insertErr.message);
        console.error('Message insert error:', insertErr.message);
      } finally {
        client.release();
      }
    }

    if (maxMessageEpoch != null && addedCount > 0) {
      await db.query(
        `UPDATE whatsapp_chats
         SET last_scraped_at = GREATEST(COALESCE(last_scraped_at, to_timestamp(0)), to_timestamp($3))
         WHERE user_id = $1 AND jid = $2`,
        [userId, canonicalJid, maxMessageEpoch]
      );
    }

    // Notify frontend that this user's chat was updated
    io.to(`user_${userId}`).emit('messages_updated', {
      userId,
      chatJid: canonicalJid,
      chatName: resolvedChatName,
      addedCount,
      skippedCount,
      seqFrom,
      seqTo
    });

    // Auto-queue AI normalization for this tenant (no PC / manual step).
    // Render Background Worker (auto_pipeline) or AI_BOT_URL picks it up.
    if (addedCount > 0) {
      queueNormalizeJob(userId, { embed: true }).then(({ job, alreadyActive }) => {
        try {
          wakePipeline(userId);
        } catch (_) {}
        if (alreadyActive) return;
        return notifyNormalizeBot(userId, job).then((botNotify) => {
          if (!botNotify.notified) {
            console.log(
              `[normalize] queued user=${userId} (bot: ${botNotify.reason || 'waiting for worker'})`
            );
          }
        });
      }).catch((e) => console.warn('[normalize] auto-queue failed:', e.message));
    }

    return sendResponse(
      res,
      201,
      false,
      { addedCount, skippedCount, targetJid: canonicalJid, userId, seqFrom, seqTo, insertErrors: insertErrors.slice(0, 3) },
      addedCount > 0 ? 'Messages saved successfully' : 'No new messages (duplicates skipped)'
    );
  } catch (err) {
    console.error('Post messages error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 10. Toggle Monitored Status for Chats
app.post('/api/scraped-chats/monitor', async (req, res) => {
  const body = req.body || {};
  const userId = resolveTenantUserId(req, null);
  if (!userId) {
    return sendResponse(res, 401, true, null, 'Login required to monitor chats');
  }

  // Accept jids[], or a single jid / chatId / id
  const rawJids = Array.isArray(body.jids)
    ? body.jids
    : [body.jid, body.chatId, body.chat_id, body.id].filter((v) => v != null && String(v).trim() !== '');
  const jids = rawJids.map((j) => String(j).trim()).filter(Boolean);

  if (jids.length === 0) {
    return sendResponse(res, 400, true, null, 'jid/chatId or jids array is required');
  }

  try {
    const canonicalJids = [];
    for (const raw of jids) {
      const canonical = await findOrCreateCanonicalChat(userId, raw, null);
      if (canonical) canonicalJids.push(canonical);
    }
    if (canonicalJids.length === 0) {
      return sendResponse(res, 400, true, null, 'No valid chat JIDs to update');
    }

    // Modes:
    // - monitored/is_monitored false OR action remove/unmonitor => turn OFF listed chats only
    // - replace/action=replace (legacy) => wipe all then set listed TRUE
    // - default => turn ON listed chats only (does NOT wipe others)
    const wantsOff =
      body.monitored === false ||
      body.is_monitored === false ||
      body.isMonitored === false ||
      body.action === 'remove' ||
      body.action === 'unmonitor';
    const wantsReplace = body.replace === true || body.action === 'replace';
    const mode = wantsReplace ? 'replace' : wantsOff ? 'remove' : 'add';

    let updated = 0;
    let updatedRows = [];

    if (mode === 'replace') {
      await db.query('UPDATE whatsapp_chats SET is_monitored = FALSE WHERE user_id = $1', [userId]);
      const result = await db.query(
        `UPDATE whatsapp_chats
         SET is_monitored = TRUE, monitored_at = NOW()
         WHERE user_id = $1 AND jid = ANY($2)
         RETURNING jid, name, is_monitored, monitored_at, monitor_letter`,
        [userId, canonicalJids]
      );
      updated = result.rowCount;
      updatedRows = result.rows;
      for (const jid of canonicalJids) {
        await ensureMonitorLetter(userId, jid);
      }
    } else if (mode === 'remove') {
      // Unmonitor: only the given chat IDs are removed from monitored list
      // Keep monitor_letter so historical a-1 / b-2 labels stay stable
      const result = await db.query(
        `UPDATE whatsapp_chats SET is_monitored = FALSE
         WHERE user_id = $1 AND jid = ANY($2)
         RETURNING jid, name, is_monitored, monitor_letter`,
        [userId, canonicalJids]
      );
      updated = result.rowCount;
      updatedRows = result.rows;
    } else {
      const result = await db.query(
        `UPDATE whatsapp_chats
         SET is_monitored = TRUE,
             monitored_at = CASE WHEN is_monitored = FALSE THEN NOW() ELSE monitored_at END,
             last_scraped_at = CASE WHEN is_monitored = FALSE THEN NULL ELSE last_scraped_at END
         WHERE user_id = $1 AND jid = ANY($2)
         RETURNING jid, name, is_monitored, monitored_at, monitor_letter`,
        [userId, canonicalJids]
      );
      updated = result.rowCount;
      updatedRows = result.rows;
      for (const jid of canonicalJids) {
        await ensureMonitorLetter(userId, jid);
      }
    }

    if (mode === 'add' && updated === 0) {
      return sendResponse(
        res,
        404,
        true,
        { jids: canonicalJids },
        'Chat not found for this user — sync WhatsApp chats first, then monitor'
      );
    }

    const monitoredRows = await db.query(
      `SELECT jid, name, is_monitored, monitor_letter, monitored_at
       FROM whatsapp_chats
       WHERE user_id = $1 AND is_monitored = TRUE
       ORDER BY monitor_letter ASC NULLS LAST, name ASC`,
      [userId]
    );

    return sendResponse(
      res,
      200,
      false,
      {
        mode,
        updated,
        jids,
        changed: updatedRows,
        monitored: monitoredRows.rows
      },
      mode === 'remove'
        ? 'Chat(s) removed from monitored list'
        : 'Monitored status updated successfully'
    );
  } catch (err) {
    console.error('Update monitored error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 11. Get chats (type=monitored|chats|all — paginated, supports search)
app.get('/api/scraped-chats', async (req, res) => {
  const { userId, type, search, page, pageSize, offset } = parseChatListQuery(req);
  if (!userId) {
    return sendResponse(res, 401, true, null, 'Login required to list your chatrooms');
  }
  try {
    const { sql, params, countSql, countParams } = buildChatListSql({
      userId,
      type,
      search,
      pageSize,
      offset,
    });
    const [result, countResult] = await Promise.all([
      db.query(sql, params),
      db.query(countSql, countParams),
    ]);
    const total = countResult.rows[0]?.total ?? result.rowCount;
    return sendResponse(
      res,
      200,
      false,
      {
        chats: result.rows,
        type,
        search: search || null,
        total,
        page,
        pageSize,
        hasMore: page * pageSize < total,
      },
      'Chats retrieved successfully'
    );
  } catch (err) {
    console.error('Get all chats error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 11a. Lightweight chat counts for dashboard stats
app.get('/api/scraped-chats/stats', async (req, res) => {
  const userId = resolveTenantUserId(req, null);
  if (!userId) {
    return sendResponse(res, 401, true, null, 'Login required');
  }
  try {
    const result = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE is_monitored = TRUE)::int AS monitored,
         COUNT(*) FILTER (WHERE is_monitored = FALSE)::int AS unmonitored,
         (
           SELECT COUNT(*)::int
           FROM whatsapp_messages m
           INNER JOIN whatsapp_chats c
             ON c.user_id = m.user_id AND c.jid = m.chat_jid
           WHERE m.user_id = $1 AND c.is_monitored = TRUE
         ) AS messages
       FROM whatsapp_chats
       WHERE user_id = $1`,
      [userId]
    );
    const scrape = await getScrapeHealth(userId);
    return sendResponse(res, 200, false, {
      ...result.rows[0],
      scraping: scrape.scrapeOk,
      scrapeOk: scrape.scrapeOk,
      needsRescan: !scrape.scrapeOk,
      workerStatus: scrape.workerStatus,
      message: scrape.warning
    }, scrape.warning || 'Chat stats retrieved');
  } catch (err) {
    console.error('Get chat stats error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 11a2. Worker: stamp scrape pause when WhatsApp session ends
app.post('/api/scraped-chats/pause-scraping', async (req, res) => {
  const userId = resolveTenantUserId(req, null);
  if (!userId) {
    return sendResponse(res, 400, true, null, 'userId is required');
  }
  try {
    const pausedCount = await stampMonitoredScrapePause(userId);
    emitScrapeStatus(userId, {
      userId,
      linked: false,
      whatsappConnected: false,
      scraping: false,
      scrapeOk: false,
      needsRescan: true,
      workerStatus: 'disconnected',
      message: 'WhatsApp disconnected — new messages are not being scraped. Scan QR to reconnect.'
    });
    return sendResponse(
      res,
      200,
      false,
      { userId, pausedMonitoredChats: pausedCount, pausedAt: new Date().toISOString() },
      'Scrape pause stamped on monitored chats'
    );
  } catch (err) {
    console.error('Pause scraping error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 11b. Get All Realtors List (Includes total message counts & identifiers for user)
app.get('/api/realtors', async (req, res) => {
  const userId = resolveTenantUserId(req, null);
  if (!userId) {
    return sendResponse(res, 401, true, null, 'Login required');
  }
  try {
    const result = await db.query(
      `SELECT c.id, c.jid, c.name, c.avatar, c.is_monitored, c.user_id, c.created_at,
              COUNT(m.id) as total_messages
       FROM whatsapp_chats c
       LEFT JOIN whatsapp_messages m ON m.chat_jid = c.jid AND m.user_id = c.user_id
       WHERE c.user_id = $1
       GROUP BY c.id, c.jid, c.name, c.avatar, c.is_monitored, c.user_id, c.created_at
       ORDER BY c.id ASC`,
      [userId]
    );
    return sendResponse(res, 200, false, result.rows, 'Realtors list retrieved successfully');
  } catch (err) {
    console.error('Get realtors error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 12. Get Messages for a Specific Chat / Realtor (Supports chatId, jid, or name query params)
// If no chat filter is provided, returns all messages for the user (multi-tenant safe).
app.get('/api/scraped-chats/messages', async (req, res) => {
  const userId = resolveTenantUserId(req, null);
  if (!userId) {
    return sendResponse(res, 401, true, null, 'Login required');
  }
  const { chatId, jid, name, limit, offset, countOnly, sort, lastTimesOnly } = req.query;
  const targetId = chatId || jid;
  const pageLimit = Math.min(parseInt(limit, 10) || 5000, 10000);
  const pageOffset = Math.max(parseInt(offset, 10) || 0, 0);
  // Newest first by default so monitored chat UI shows today's messages, not Sep-15 history page 1
  const sortAsc = String(sort || '').toLowerCase() === 'asc';
  const orderSql = sortAsc ? 'ORDER BY m.id ASC' : 'ORDER BY m.id DESC';

  try {
    if (lastTimesOnly === '1' || lastTimesOnly === 'true') {
      const result = await db.query(
        `SELECT m.chat_jid,
                MAX(m.timestamp) AS timestamp,
                MAX(m.created_at) AS created_at
         FROM whatsapp_messages m
         INNER JOIN whatsapp_chats c
           ON c.user_id = m.user_id AND c.jid = m.chat_jid
         WHERE m.user_id = $1 AND c.is_monitored = TRUE
         GROUP BY m.chat_jid`,
        [userId]
      );
      return sendResponse(res, 200, false, result.rows, 'Last message times retrieved');
    }

    if (countOnly === '1' || countOnly === 'true') {
      const result = await db.query(
        `SELECT COUNT(*)::int AS count
         FROM whatsapp_messages m
         INNER JOIN whatsapp_chats c
           ON c.user_id = m.user_id AND c.jid = m.chat_jid
         WHERE m.user_id = $1 AND c.is_monitored = TRUE`,
        [userId]
      );
      return sendResponse(res, 200, false, result.rows[0], 'Message count retrieved');
    }

    let result;
    if (targetId) {
      result = await db.query(
        `SELECT m.id, m.chat_jid, c.name as chat_name, m.sender, m.timestamp, m.message, m.from_me, m.from_me as "fromMe", m.user_id, m.created_at, m.seq_in_chat, m.seq_in_chat as "seqInChat" 
         FROM whatsapp_messages m
         LEFT JOIN whatsapp_chats c ON m.chat_jid = c.jid AND m.user_id = c.user_id
         WHERE m.user_id = $1 AND (m.chat_jid = $2 OR LOWER(COALESCE(c.name, '')) LIKE LOWER($3))
         ${orderSql}
         LIMIT $4 OFFSET $5`,
        [userId, targetId, `%${targetId}%`, pageLimit, pageOffset]
      );
    } else if (name) {
      result = await db.query(
        `SELECT m.id, m.chat_jid, c.name as chat_name, m.sender, m.timestamp, m.message, m.from_me, m.from_me as "fromMe", m.user_id, m.created_at, m.seq_in_chat, m.seq_in_chat as "seqInChat" 
         FROM whatsapp_messages m
         LEFT JOIN whatsapp_chats c ON m.chat_jid = c.jid AND m.user_id = c.user_id
         WHERE m.user_id = $1 AND LOWER(COALESCE(c.name, '')) LIKE LOWER($2)
         ${orderSql}
         LIMIT $3 OFFSET $4`,
        [userId, `%${name}%`, pageLimit, pageOffset]
      );
    } else {
      // No chat filter: return this user's messages only (fixes frontend 400)
      result = await db.query(
        `SELECT m.id, m.chat_jid, c.name as chat_name, m.sender, m.timestamp, m.message, m.from_me, m.from_me as "fromMe", m.user_id, m.created_at, m.seq_in_chat, m.seq_in_chat as "seqInChat" 
         FROM whatsapp_messages m
         LEFT JOIN whatsapp_chats c ON m.chat_jid = c.jid AND m.user_id = c.user_id
         WHERE m.user_id = $1
         ${orderSql}
         LIMIT $2 OFFSET $3`,
        [userId, pageLimit, pageOffset]
      );
    }

    return sendResponse(res, 200, false, result.rows, 'Messages retrieved successfully');
  } catch (err) {
    console.error('Get messages error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

/**
 * Delete selected messages and/or selected chats for the authenticated user.
 *
 * POST /api/scraped-chats/delete
 * DELETE /api/scraped-chats/delete
 * Body:
 * {
 *   messageIds?: number[],          // delete these message rows
 *   chatIds?: string[],             // delete chats by jid (+ all their messages)
 *   jids?: string[],                // alias of chatIds
 *   deleteChatMessages?: boolean    // default true when deleting chats
 * }
 */
async function handleDeleteScrapedChats(req, res) {
  const userId = parseInt(
    req.userId || req.body?.userId || req.body?.user_id || req.headers['x-user-id'],
    10
  );
  if (!userId || Number.isNaN(userId)) {
    return sendResponse(res, 400, true, null, 'userId is required');
  }

  const body = req.body || {};
  const messageIds = Array.isArray(body.messageIds)
    ? body.messageIds.map((id) => parseInt(id, 10)).filter((id) => !Number.isNaN(id))
    : Array.isArray(body.message_ids)
      ? body.message_ids.map((id) => parseInt(id, 10)).filter((id) => !Number.isNaN(id))
      : [];

  const chatIds = [
    ...(Array.isArray(body.chatIds) ? body.chatIds : []),
    ...(Array.isArray(body.chat_ids) ? body.chat_ids : []),
    ...(Array.isArray(body.jids) ? body.jids : []),
    ...(body.chatId || body.jid || body.chat_id ? [body.chatId || body.jid || body.chat_id] : [])
  ]
    .map((j) => String(j).trim())
    .filter(Boolean);

  const deleteChatMessages = body.deleteChatMessages !== false && body.delete_chat_messages !== false;

  if (messageIds.length === 0 && chatIds.length === 0) {
    return sendResponse(
      res,
      400,
      true,
      null,
      'Provide messageIds and/or chatIds (jids) to delete'
    );
  }

  try {
    let deletedMessages = 0;
    let deletedChats = 0;

    const childTables = [
      'normalized_messages',
      'model_comparisons',
      'message_embeddings'
    ];

    if (messageIds.length > 0) {
      for (const table of childTables) {
        try {
          await db.query(
            `DELETE FROM ${table}
             WHERE whatsapp_message_id = ANY($1::int[])`,
            [messageIds]
          );
        } catch (_) {
          /* optional table */
        }
      }

      const msgResult = await db.query(
        `DELETE FROM whatsapp_messages
         WHERE user_id = $1 AND id = ANY($2::int[])
         RETURNING id`,
        [userId, messageIds]
      );
      deletedMessages += msgResult.rowCount;
    }

    if (chatIds.length > 0) {
      if (deleteChatMessages) {
        for (const table of childTables) {
          try {
            await db.query(
              `DELETE FROM ${table} child
               USING whatsapp_messages m
               WHERE child.whatsapp_message_id = m.id
                 AND m.user_id = $1
                 AND m.chat_jid = ANY($2::text[])`,
              [userId, chatIds]
            );
          } catch (_) {}
        }

        const chatMsgResult = await db.query(
          `DELETE FROM whatsapp_messages
           WHERE user_id = $1 AND chat_jid = ANY($2::text[])
           RETURNING id`,
          [userId, chatIds]
        );
        deletedMessages += chatMsgResult.rowCount;
      }

      const chatResult = await db.query(
        `DELETE FROM whatsapp_chats
         WHERE user_id = $1 AND jid = ANY($2::text[])
         RETURNING jid, name`,
        [userId, chatIds]
      );
      deletedChats = chatResult.rowCount;
    }

    io.to(`user_${userId}`).emit('chats_deleted', {
      userId,
      deletedMessages,
      deletedChats,
      messageIds,
      chatIds
    });

    return sendResponse(
      res,
      200,
      false,
      {
        deletedMessages,
        deletedChats,
        messageIds,
        chatIds
      },
      'Selected chats/messages deleted successfully'
    );
  } catch (err) {
    console.error('Delete scraped chats/messages error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
}

app.post('/api/scraped-chats/delete', handleDeleteScrapedChats);
app.delete('/api/scraped-chats/delete', handleDeleteScrapedChats);

// 13. ML Dataset Endpoint (Fetch all scraped realtor messages with chat names, search & pagination)
app.get('/api/ml/dataset', async (req, res) => {
  const { limit = 1000, offset = 0, chatId, jid, name } = req.query;
  const targetId = chatId || jid;

  try {
    let queryText = `
      SELECT m.id, m.chat_jid, c.name as chat_name, m.sender, m.timestamp, m.message, m.from_me, m.from_me as "fromMe", m.created_at
      FROM whatsapp_messages m
      LEFT JOIN whatsapp_chats c ON m.chat_jid = c.jid
    `;
    const params = [];
    const whereClauses = [];

    if (targetId) {
      params.push(targetId);
      params.push(`%${targetId}%`);
      whereClauses.push(`(m.chat_jid = $${params.length - 1} OR LOWER(c.name) LIKE LOWER($${params.length}))`);
    } else if (name) {
      params.push(`%${name}%`);
      whereClauses.push(`LOWER(c.name) LIKE LOWER($${params.length})`);
    }

    if (whereClauses.length > 0) {
      queryText += ` WHERE ` + whereClauses.join(' AND ');
    }

    params.push(parseInt(limit, 10));
    queryText += ` ORDER BY m.id ASC LIMIT $${params.length}`;

    params.push(parseInt(offset, 10));
    queryText += ` OFFSET $${params.length}`;

    const result = await db.query(queryText, params);

    let countQuery = `
      SELECT COUNT(*) 
      FROM whatsapp_messages m
      LEFT JOIN whatsapp_chats c ON m.chat_jid = c.jid
    `;
    const countParams = [];
    if (targetId) {
      countParams.push(targetId);
      countParams.push(`%${targetId}%`);
      countQuery += ` WHERE (m.chat_jid = $1 OR LOWER(c.name) LIKE LOWER($2))`;
    } else if (name) {
      countParams.push(`%${name}%`);
      countQuery += ` WHERE LOWER(c.name) LIKE LOWER($1)`;
    }
    const countRes = await db.query(countQuery, countParams);

    return sendResponse(res, 200, false, {
      total: parseInt(countRes.rows[0].count, 10),
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      messages: result.rows
    }, 'ML dataset retrieved successfully');
  } catch (err) {
    console.error('Get ML dataset error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 14. Property Filter Endpoint (Supports POST/GET /api/properties/filter and /api/properties)

/**
 * Shared filter + location WHERE builder used by search AND suggest counts
 * so dropdown hits always equal properties returned for the same query.
 */
function buildPropertySearchWhere(filters, userId) {
  let queryText = `
      FROM normalized_messages n
      INNER JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
      WHERE m.user_id = $1
        AND n.is_property IS TRUE
  `;
  const params = [userId];
  let parsedLocation = null;
  let regionClass = null;

  const purpose = String(filters.purpose || '').trim().toLowerCase();
  if (purpose && purpose !== 'all') {
    if (purpose === 'buy' || purpose === 'sale' || purpose === 'sell') {
      params.push(['buy', 'sale', 'sell']);
      queryText += ` AND LOWER(COALESCE(n.purpose, '')) = ANY($${params.length})`;
    } else if (purpose === 'rent') {
      queryText += ` AND LOWER(COALESCE(n.purpose, '')) = 'rent'`;
    }
  }

  const city = String(filters.city || '').trim();
  if (city && city.toLowerCase() !== 'all cities') {
    params.push(`%${city}%`);
    queryText += ` AND (n.city ILIKE $${params.length} OR n.area ILIKE $${params.length} OR n.vicinity ILIKE $${params.length})`;
  }

  const location = String(filters.location || '').trim();
  if (location) {
    parsedLocation = parseSmartLocationQuery(location);
    regionClass = classifyLocationQuery(location);

    // Parent region (Malir / Airport): expand mustGroups to all children
    if (regionClass.mode === 'parent' && regionClass.terms.length) {
      parsedLocation.mustGroups = [regionClass.terms];
      parsedLocation.regionMode = 'parent';
      parsedLocation.regionTerms = regionClass.terms;
      parsedLocation.placeOnlyGroups = [];
      parsedLocation.searchRegexes = [];
    } else if (regionClass.mode === 'exact' && regionClass.terms.length) {
      // Exact locality: constrain to that place (+ spellings) only
      parsedLocation.mustGroups = [regionClass.terms];
      parsedLocation.regionMode = 'exact';
      parsedLocation.regionTerms = regionClass.terms;
      // Keep phase/street if already parsed; clear bare khayaban OR noise
      if (parsedLocation.phaseNumber == null) {
        parsedLocation.placeOnlyGroups = [];
        parsedLocation.searchRegexes = [];
      }
    }

    // Include place_tags + full message in searchable text (no tiny LEFT for match)
    const searchable =
      parsedLocation.phaseNumber != null
        ? `LOWER(CONCAT_WS(' ', COALESCE(n.area,''), COALESCE(n.vicinity,''), COALESCE(n.city,''), ` +
          `COALESCE(n.summary,''), COALESCE(n.listing_excerpt,''), ` +
          `COALESCE(array_to_string(n.place_tags, ' '), ''), ` +
          `COALESCE(NULLIF(TRIM(n.listing_excerpt), ''), m.message, '')))`
        : `LOWER(CONCAT_WS(' ', COALESCE(n.area,''), COALESCE(n.vicinity,''), COALESCE(n.city,''), ` +
          `COALESCE(n.summary,''), COALESCE(n.listing_excerpt,''), ` +
          `COALESCE(array_to_string(n.place_tags, ' '), ''), ` +
          `COALESCE(m.message, '')))`;

    const built = buildSmartLocationSql(parsedLocation, searchable, params);

    if (built.sql) {
      queryText += built.sql;
    } else {
      const variants = expandLocationQuery(location);
      const patterns = (variants.length ? variants : [location]).map((v) => `%${v}%`);
      params.push(patterns);
      const patternIdx = params.length;
      queryText += ` AND ${searchable} ILIKE ANY($${patternIdx})`;
    }
  }

  const propertyType = String(filters.propertyType || '').trim();
  if (propertyType && propertyType.toLowerCase() !== 'all') {
    params.push(`%${propertyType}%`);
    queryText += ` AND COALESCE(n.property_type, '') ILIKE $${params.length}`;
  }

  const propertySubType = String(filters.propertySubType || '').trim();
  if (propertySubType && !['any', 'standard', ''].includes(propertySubType.toLowerCase())) {
    params.push(`%${propertySubType}%`);
    queryText += ` AND COALESCE(n.property_sub_type, n.property_type, '') ILIKE $${params.length}`;
  }

  if (filters.status && String(filters.status).trim() !== '') {
    const statusList = String(filters.status)
      .split(',')
      .map((s) => normalizePropertyStatus(s))
      .filter(Boolean);
    if (statusList.length) {
      params.push(statusList);
      queryText += ` AND UPPER(COALESCE(n.property_status, 'AVAILABLE')) = ANY($${params.length})`;
    }
  }

  return { queryText, params, parsedLocation, regionClass };
}

/** True if listing belongs to allowed location terms (strict relevancy). */
function listingMatchesRegionTerms(row, terms) {
  if (!terms || !terms.length) return true;
  const tags = Array.isArray(row.place_tags) ? row.place_tags.map(placeNorm) : [];
  const fieldBlob = placeNorm(
    [row.area, row.vicinity, row.city].map((x) => String(x || '')).join(' ')
  );
  const softBlob = placeNorm(
    [row.summary, row.listing_excerpt].map((x) => String(x || '')).join(' ')
  );
  const rawBlob = placeNorm(String(row.raw_message || ''));

  const AMBIGUOUS = new Set([
    'airport',
    'tbz',
    'landhi',
    'peninsula',
    'nishat',
    'jami',
    'qasim',
    'roomi',
    'sehar',
    'corner',
    'creek',
    'iqbal',
    'tariq'
  ]);

  const hasPhrase = (blob, term) => {
    if (!blob || !term) return false;
    if (blob === term) return true;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(blob);
  };

  return terms.some((t) => {
    const term = placeNorm(t);
    if (!term || term.length < 3) return false;

    const inText = hasPhrase(softBlob, term) || hasPhrase(rawBlob, term);
    const inFields = hasPhrase(fieldBlob, term);
    const inTags = tags.includes(term);

    // Prefer real message evidence (Askari-5 Malir Cantt in body, etc.)
    if (inText) {
      const ambiguous =
        AMBIGUOUS.has(term) || (term.split(/\s+/).length === 1 && term.length < 8);
      // Ambiguous single tokens in a long body still need a place-field/tag anchor
      if (ambiguous) return inFields || inTags;
      return true;
    }

    // Structured-only / tag-only without message support = often NER pollution
    return false;
  });
}

function resolveSearchFilters(req) {
  // Flat body fields (query/limit/offset/status) + nested filters{} both supported
  const body = req.body || {};
  const nested = body.filters && typeof body.filters === 'object' ? body.filters : {};
  const rawFilters = { ...body, ...nested };
  const queryFilters = req.query || {};

  const filters = {
    purpose: rawFilters.purpose || queryFilters.purpose || '',
    city: rawFilters.city || queryFilters.city || '',
    location:
      rawFilters.location ||
      queryFilters.location ||
      rawFilters.query ||
      queryFilters.query ||
      rawFilters.vicinity ||
      queryFilters.vicinity ||
      rawFilters.area ||
      queryFilters.area ||
      '',
    propertyType:
      rawFilters.propertyType ||
      queryFilters.propertyType ||
      rawFilters.property_type ||
      queryFilters.property_type ||
      '',
    propertySubType:
      rawFilters.propertySubType ||
      queryFilters.propertySubType ||
      rawFilters.property_sub_type ||
      queryFilters.property_sub_type ||
      '',
    sortBy:
      rawFilters.sortBy ||
      queryFilters.sortBy ||
      rawFilters.sort_by ||
      queryFilters.sort_by ||
      'Newest First',
    priceMin: rawFilters.priceMin ?? queryFilters.priceMin ?? '',
    priceMax: rawFilters.priceMax ?? queryFilters.priceMax ?? '',
    areaUnit:
      rawFilters.areaUnit ||
      queryFilters.areaUnit ||
      rawFilters.area_unit ||
      queryFilters.area_unit ||
      'Marla',
    areaMin: rawFilters.areaMin ?? queryFilters.areaMin ?? '',
    areaMax: rawFilters.areaMax ?? queryFilters.areaMax ?? '',
    status:
      rawFilters.status ||
      rawFilters.propertyStatus ||
      rawFilters.property_status ||
      queryFilters.status ||
      queryFilters.propertyStatus ||
      queryFilters.property_status ||
      ''
  };

  const userId = Number(
    req.userId ||
      rawFilters.userId ||
      rawFilters.user_id ||
      queryFilters.userId ||
      queryFilters.user_id ||
      0
  );

  const requestedLimit = parseInt(rawFilters.limit || queryFilters.limit || '50', 10);
  const requestedOffset = parseInt(rawFilters.offset || queryFilters.offset || '0', 10);
  const locationEarly = String(filters.location || '').trim();
  // Empty browse must honor FE page sizes (200+). Location search can go higher.
  const maxLimit = locationEarly ? 10000 : 500;
  const defaultLimit = locationEarly ? 5000 : 100;
  const limit = Math.min(
    Math.max(Number.isFinite(requestedLimit) ? requestedLimit : defaultLimit, 1),
    maxLimit
  );
  const offset = Math.max(Number.isFinite(requestedOffset) ? requestedOffset : 0, 0);

  const skipCountRaw = rawFilters.skipCount ?? queryFilters.skipCount;
  const skipCount =
    skipCountRaw === true ||
    skipCountRaw === 1 ||
    String(skipCountRaw || '').toLowerCase() === 'true' ||
    String(skipCountRaw || '') === '1';

  return { filters, userId, limit, offset, skipCount, rawFilters, queryFilters };
}

/** Exact match count — same WHERE as property search (no LIMIT). */
async function countPropertySearch(filters, userId) {
  const { queryText, params } = buildPropertySearchWhere(filters, userId);
  const sql = `SELECT COUNT(*)::int AS hits ${queryText}`;
  const result = await db.query(sql, params);
  return result.rows[0]?.hits || 0;
}

const runPropertySearch = async (req) => {
  // Warm place_regions seed once (non-blocking if fails)
  ensurePlaceRegionsSeeded().catch(() => {});

  const { filters, userId, limit, offset, skipCount } = resolveSearchFilters(req);
  if (!userId) {
    const err = new Error('userId is required');
    err.statusCode = 400;
    throw err;
  }

  const { queryText: whereSql, params, parsedLocation, regionClass } = buildPropertySearchWhere(
    filters,
    userId
  );

  // Exact total before limit — skip when FE sends skipCount (pagination / browse)
  let totalMatched = null;
  if (!skipCount) {
    const countResult = await db.query(`SELECT COUNT(*)::int AS hits ${whereSql}`, params);
    totalMatched = countResult.rows[0]?.hits || 0;
  }

  // Oversample so content-dedupe + junk/phase guards can still fill `limit` after offset
  const need = offset + limit;
  const hasLocation = Boolean(String(filters.location || '').trim());
  const locationHeavy = Boolean(
    parsedLocation &&
      (parsedLocation.phaseNumber != null ||
        parsedLocation.streetNumber != null ||
        (parsedLocation.mustGroups || []).length ||
        (parsedLocation.placeOnlyGroups || []).length ||
        parsedLocation.regionMode)
  );
  // Location/region/phase: pull user's full property window so relevant cards aren't truncated
  const fetchLimit = !hasLocation
    ? Math.min(Math.max(need * 20, 20000), 25000)
    : Math.min(Math.max(need * 20, 20000, locationHeavy ? 25000 : 8000), 25000);

  let queryText = `
    SELECT * FROM (
      SELECT n.id, n.whatsapp_message_id, n.chat_jid, n.purpose, n.city, n.area, n.vicinity,
             n.property_type, n.property_sub_type, n.size, n.price,
             COALESCE(NULLIF(TRIM(n.contact_number), ''), NULLIF(TRIM(m.sender_phone), '')) AS contact_number,
             n.summary, n.property_status, n.created_at, n.category, n.intent, n.sentiment,
             n.listing_index, n.listing_excerpt, n.place_tags,
             COALESCE(NULLIF(TRIM(n.listing_excerpt), ''), m.message) AS raw_message,
             m.timestamp AS message_timestamp, m.from_me, m.user_id,
             m.seq_in_chat, m.seq_in_chat AS "seqInChat"
      ${whereSql}
      ORDER BY n.id DESC, n.whatsapp_message_id DESC, COALESCE(n.listing_index, 0) ASC
    ) uniq
    ORDER BY uniq.id DESC LIMIT $${params.length + 1}`;
  const fetchParams = [...params, fetchLimit];

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '45s'");
    const dbResult = await client.query(queryText, fetchParams);
    await client.query('COMMIT');

    let rows = dbResult.rows;

    // 100% relevancy: parent/exact region terms must appear in place fields/tags/message
    if (regionClass && regionClass.terms && regionClass.terms.length && regionClass.mode !== 'none') {
      rows = rows.filter((r) => listingMatchesRegionTerms(r, regionClass.terms));
    }

    if (parsedLocation && parsedLocation.phaseNumber != null) {
      const want = parsedLocation.phaseNumber;
      const qLow = String(parsedLocation.rawQuery || filters.location || '').toLowerCase();
      const queryMentionsBahria = /\bbahria\b/.test(qLow);
      rows = rows.filter((r) => {
        const structured = [r.area, r.vicinity, r.listing_excerpt, r.summary]
          .map((x) => String(x || ''))
          .join(' ');
        // Bare "Phase 8" in this product means DHA — not Bahria Town Phase 8
        if (!queryMentionsBahria) {
          const place = `${r.area || ''} ${r.vicinity || ''} ${r.city || ''}`.toLowerCase();
          if (/\bbahria\b/.test(place) && !/\b(dha|defence|defense)\b/.test(place)) {
            return false;
          }
        }
        if (textHasPhase(structured, want)) return true;
        const raw = String(r.raw_message || '');
        if (!textHasPhase(raw, want)) return false;
        return Boolean(
          String(r.property_type || '').trim() ||
            String(r.size || '').trim() ||
            String(r.price || '').trim()
        );
      });
    }

    if (parsedLocation && parsedLocation.streetNumber != null) {
      const wantStreet = parsedLocation.streetNumber;
      rows = rows.filter((r) =>
        textHasStreet(
          [r.area, r.vicinity, r.listing_excerpt, r.summary, r.raw_message]
            .map((x) => String(x || '').trim())
            .filter(Boolean)
            .join(' | '),
          wantStreet
        )
      );
    }

    // Relevance rank the pool — do NOT slice to limit yet (dedupe needs headroom)
    if (
      parsedLocation &&
      (parsedLocation.phaseNumber != null ||
        parsedLocation.streetNumber != null ||
        (parsedLocation.mustGroups || []).length ||
        (parsedLocation.placeOnlyGroups || []).length ||
        (parsedLocation.searchRegexes || []).length ||
        parsedLocation.regionMode)
    ) {
      rows = rows
        .map((r) => ({ ...r, _score: scoreLocationMatch(r, parsedLocation) }))
        .sort((a, b) => b._score - a._score || b.id - a.id);
    }

    const deduped = filterAndSortProperties(rows, {
      ...filters,
      // Keep newest / relevance order already applied above when location search
      sortBy: parsedLocation ? 'Relevance' : filters.sortBy
    });

    const properties = deduped.slice(offset, offset + limit);

    return {
      filters,
      userId,
      limit,
      offset,
      totalMatched,
      // Unique cards in the fetched/deduped pool (better UX than raw SQL dups)
      uniqueInPool: deduped.length,
      totalReturned: properties.length,
      properties
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
};


const handlePropertyFilter = async (req, res) => {
  try {
    const { filters, properties, totalMatched, totalReturned, limit, offset, uniqueInPool } =
      await runPropertySearch(req);
    const viewerId = resolveAuthUserId(req);
    const withMeta = await attachPrivatePropertyMeta(viewerId, properties);
    const enriched = withMeta.map((p) => ({
      ...p,
      id: p.id,
      listingId: p.id,
      messageId: p.whatsappMessageId || p.whatsapp_message_id || null,
      whatsappMessageId: p.whatsappMessageId || p.whatsapp_message_id || null,
      seqInChat: p.seqInChat ?? p.seq_in_chat ?? null,
      seq_in_chat: p.seqInChat ?? p.seq_in_chat ?? null,
      isFavourite: Boolean(p.isFavourite),
      is_favourite: Boolean(p.isFavourite),
      comments: Array.isArray(p.comments) ? p.comments : []
    }));
    return sendResponse(res, 200, false, {
      total: totalMatched != null ? totalMatched : uniqueInPool != null ? uniqueInPool : enriched.length,
      totalMatched: totalMatched != null ? totalMatched : uniqueInPool != null ? uniqueInPool : enriched.length,
      totalReturned: totalReturned != null ? totalReturned : enriched.length,
      uniqueInPool: uniqueInPool != null ? uniqueInPool : enriched.length,
      limit: limit != null ? limit : enriched.length,
      offset: offset != null ? offset : 0,
      filters,
      properties: enriched
    }, 'Properties retrieved successfully');
  } catch (err) {
    console.error('Property filter error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
};

function toDashboardSearchResult(p) {
  return {
    id: p.id,
    listing_id: p.id,
    message_id: p.whatsappMessageId || p.whatsapp_message_id || null,
    listing_index: p.listingIndex ?? p.listing_index ?? 0,
    seq_in_chat: p.seqInChat ?? p.seq_in_chat ?? null,
    seqInChat: p.seqInChat ?? p.seq_in_chat ?? null,
    raw_message: p.rawMessage || p.raw_message || '',
    summary: p.summary || '',
    city: p.city || '',
    area: p.area || '',
    vicinity: p.vicinity || '',
    property_type: p.propertyType || p.property_type || '',
    property_sub_type: p.propertySubType || p.property_sub_type || null,
    purpose: p.purpose || '',
    size: p.size || '',
    size_value: p.parsedAreaInTargetUnit ?? p.size_value ?? null,
    size_unit: p.targetAreaUnit || p.size_unit || '',
    price: p.price || '',
    price_value: p.parsedPricePKR ?? p.price_value ?? null,
    contact_number: p.contactNumber || p.contact_number || '',
    category: p.category || '',
    intent: p.intent || '',
    sentiment: p.sentiment || '',
    created_at: p.createdAt || p.created_at,
    property_status: p.propertyStatus || p.property_status || 'AVAILABLE',
    similarity_score: p.similarityScore || p.similarity_score || null,
    place_tags: Array.isArray(p.placeTags || p.place_tags) ? (p.placeTags || p.place_tags) : [],
    isFavourite: Boolean(p.isFavourite),
    is_favourite: Boolean(p.isFavourite),
    comments: Array.isArray(p.comments) ? p.comments : []
  };
}

function mapPropertyCommentRow(row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    property_id: row.property_id,
    comment: row.comment,
    createdAt: row.created_at,
    created_at: row.created_at,
    updatedAt: row.updated_at,
    updated_at: row.updated_at
  };
}

/** Load this user's private comments + favourite flags for a page of listing ids. */
async function loadUserPropertyMeta(userId, propertyIds) {
  const ids = [
    ...new Set(
      (propertyIds || [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0)
    )
  ];
  const empty = { commentsByProperty: new Map(), favouriteIds: new Set() };
  if (!userId || !ids.length) return empty;

  const [commentsRes, favRes] = await Promise.all([
    db.query(
      `SELECT id, property_id, comment, created_at, updated_at
       FROM property_comments
       WHERE user_id = $1 AND property_id = ANY($2::int[])
       ORDER BY created_at ASC, id ASC`,
      [userId, ids]
    ),
    db.query(
      `SELECT property_id
       FROM property_favourites
       WHERE user_id = $1 AND property_id = ANY($2::int[])`,
      [userId, ids]
    )
  ]);

  const commentsByProperty = new Map();
  for (const row of commentsRes.rows) {
    const key = Number(row.property_id);
    if (!commentsByProperty.has(key)) commentsByProperty.set(key, []);
    commentsByProperty.get(key).push(mapPropertyCommentRow(row));
  }

  return {
    commentsByProperty,
    favouriteIds: new Set(favRes.rows.map((r) => Number(r.property_id)))
  };
}

async function attachPrivatePropertyMeta(userId, properties) {
  const list = Array.isArray(properties) ? properties : [];
  if (!list.length) return list;
  const meta = await loadUserPropertyMeta(
    userId,
    list.map((p) => p.id)
  );
  return list.map((p) => {
    const id = Number(p.id);
    return {
      ...p,
      isFavourite: meta.favouriteIds.has(id),
      comments: meta.commentsByProperty.get(id) || []
    };
  });
}

async function findNormalizedPropertyById(propertyId) {
  const id = Number(propertyId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const result = await db.query(
    `SELECT n.id, n.whatsapp_message_id, n.chat_jid, n.purpose, n.city, n.area, n.vicinity,
            n.property_type, n.property_sub_type, n.size, n.price,
            COALESCE(NULLIF(TRIM(n.contact_number), ''), NULLIF(TRIM(m.sender_phone), '')) AS contact_number,
            n.summary, n.property_status, n.created_at, n.category, n.intent, n.sentiment,
            n.listing_index, n.listing_excerpt,
            LEFT(COALESCE(NULLIF(TRIM(n.listing_excerpt), ''), m.message), 500) AS raw_message,
            m.timestamp AS message_timestamp, m.from_me, m.user_id,
            m.seq_in_chat, m.seq_in_chat AS "seqInChat"
     FROM normalized_messages n
     INNER JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
     WHERE n.id = $1
     LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

function resolveAuthUserId(req) {
  const id = Number(req.user?.id || req.user?.userId || req.userId);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function resolvePropertyIdFromRequest(req) {
  const raw =
    req.params?.propertyId ??
    req.params?.id ??
    req.body?.propertyId ??
    req.body?.property_id ??
    req.body?.listingId ??
    req.body?.listing_id ??
    req.body?.id ??
    req.query?.propertyId ??
    req.query?.property_id ??
    req.query?.listingId ??
    req.query?.listing_id;
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Same JSON shape the portal expects from FastAPI POST /api/dashboard-search */
const handleDashboardSearch = async (req, res) => {
  try {
    const { properties, totalMatched, totalReturned, limit, offset, uniqueInPool } =
      await runPropertySearch(req);
    const viewerId = resolveAuthUserId(req);
    const withMeta = await attachPrivatePropertyMeta(viewerId, properties);
    const results = withMeta.map(toDashboardSearchResult);
    return res.json({
      success: true,
      // With skipCount: report unique pool size (post-dedupe/junk), not raw SQL hits
      count: totalMatched != null ? totalMatched : uniqueInPool != null ? uniqueInPool : results.length,
      totalMatched: totalMatched != null ? totalMatched : uniqueInPool != null ? uniqueInPool : results.length,
      // Cards actually returned this page (after dedupe)
      totalReturned: totalReturned != null ? totalReturned : results.length,
      limit: limit != null ? limit : results.length,
      offset: offset != null ? offset : 0,
      uniqueInPool: uniqueInPool != null ? uniqueInPool : results.length,
      results
    });
  } catch (err) {
    console.error('Dashboard search error:', err);
    const code = err.statusCode || 500;
    return res.status(code).json({ success: false, error: err.message || 'Server error', results: [] });
  }
};

app.post('/api/properties/filter', handlePropertyFilter);
app.get('/api/properties/filter', handlePropertyFilter);
app.post('/api/properties', handlePropertyFilter);
app.get('/api/properties', handlePropertyFilter);

['/api/dashboard-search', '/ml-api/api/dashboard-search', '/ml-api/dashboard-search'].forEach((path) => {
  app.post(path, handleDashboardSearch);
  app.get(path, handleDashboardSearch);
});

/** Allowed property listing statuses */
app.get('/api/properties/statuses', (req, res) => {
  return sendResponse(
    res,
    200,
    false,
    { statuses: [...PROPERTY_STATUSES], default: 'AVAILABLE' },
    'Property statuses retrieved'
  );
});

/**
 * GET /api/places/suggest?q=khay&purpose=Buy&status=AVAILABLE&city=...
 * Inventory-only autocomplete: places on the user's properties under active
 * filters. Adds parent buckets (Khayaban / DHA) when matching listings exist.
 */
app.get('/api/places/suggest', authenticateToken, async (req, res) => {
  const userId = resolveTenantUserId(req, null);
  if (!userId) {
    return sendResponse(res, 401, true, null, 'Login required');
  }

  const rawQ = String(req.query.q || req.query.query || '').trim();
  if (rawQ.length < 1) {
    return sendResponse(res, 200, false, { suggestions: [] }, 'OK');
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 18, 1), 40);
  const canonQ = canonicalizePlaceText(rawQ);
  const uniqTerms = [...new Set(
    [rawQ, canonQ]
      .map((t) => String(t || '').trim().toLowerCase())
      .filter((t) => t.length >= 1)
  )];

  if (uniqTerms.some((t) => isKhayabanFamilyToken(t))) {
    uniqTerms.push('khayaban');
  }
  const searchTerms = [...new Set(uniqTerms)];

  const queryWantsKhayaban = searchTerms.some((t) => {
    if (isKhayabanFamilyToken(t)) return true;
    if (t.length >= 3 && 'khayaban'.startsWith(t)) return true;
    return false;
  });
  const queryWantsDha = searchTerms.some((t) => {
    if (t.length < 2) return false;
    return ['dha', 'defence', 'defense', 'defance'].some(
      (d) => d === t || (t.length >= 2 && d.startsWith(t))
    );
  });

  const purpose = String(req.query.purpose || '').trim().toLowerCase();
  const city = String(req.query.city || '').trim();
  const propertyType = String(req.query.propertyType || req.query.property_type || '').trim();
  const propertySubType = String(req.query.propertySubType || req.query.property_sub_type || '').trim();
  const statusRaw = String(req.query.status || req.query.propertyStatus || req.query.property_status || '').trim();

  const appendCommonFilters = (params) => {
    let filterSql = '';
    if (purpose && purpose !== 'all') {
      if (purpose === 'buy' || purpose === 'sale' || purpose === 'sell') {
        params.push(['buy', 'sale', 'sell']);
        filterSql += ` AND LOWER(COALESCE(n.purpose, '')) = ANY($${params.length})`;
      } else if (purpose === 'rent') {
        filterSql += ` AND LOWER(COALESCE(n.purpose, '')) = 'rent'`;
      }
    }
    if (city && city.toLowerCase() !== 'all cities') {
      params.push(`%${city}%`);
      filterSql += ` AND (n.city ILIKE $${params.length} OR n.area ILIKE $${params.length} OR n.vicinity ILIKE $${params.length})`;
    }
    if (propertyType && propertyType.toLowerCase() !== 'all') {
      params.push(`%${propertyType}%`);
      filterSql += ` AND COALESCE(n.property_type, '') ILIKE $${params.length}`;
    }
    if (propertySubType && !['any', 'standard', ''].includes(propertySubType.toLowerCase())) {
      params.push(`%${propertySubType}%`);
      filterSql += ` AND COALESCE(n.property_sub_type, n.property_type, '') ILIKE $${params.length}`;
    }
    if (statusRaw) {
      const statusList = statusRaw
        .split(',')
        .map((s) => normalizePropertyStatus(s))
        .filter(Boolean);
      if (statusList.length) {
        params.push(statusList);
        filterSql += ` AND UPPER(COALESCE(n.property_status, 'AVAILABLE')) = ANY($${params.length})`;
      }
    }
    return filterSql;
  };

  try {
    const params = [userId];
    const filterSql = appendCommonFilters(params);

    const likeParts = [];
    for (const term of searchTerms) {
      params.push(`%${term}%`);
      const idx = params.length;
      likeParts.push(
        `(LOWER(COALESCE(n.city,'')) LIKE $${idx} OR LOWER(COALESCE(n.area,'')) LIKE $${idx} OR LOWER(COALESCE(n.vicinity,'')) LIKE $${idx})`
      );
    }
    const placeMatchSql = `(${likeParts.join(' OR ')})`;
    const baseWhere = `
      FROM normalized_messages n
      INNER JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
      WHERE m.user_id = $1 AND n.is_property IS TRUE
      ${filterSql}
    `;

    const sql = `
      SELECT name, kind, hits FROM (
        SELECT LOWER(TRIM(n.city)) AS name, 'city' AS kind, COUNT(*)::int AS hits
        ${baseWhere}
          AND n.city IS NOT NULL AND TRIM(n.city) <> ''
          AND ${placeMatchSql}
        GROUP BY LOWER(TRIM(n.city))
        UNION ALL
        SELECT LOWER(TRIM(n.area)) AS name, 'area' AS kind, COUNT(*)::int AS hits
        ${baseWhere}
          AND n.area IS NOT NULL AND TRIM(n.area) <> ''
          AND ${placeMatchSql}
        GROUP BY LOWER(TRIM(n.area))
        UNION ALL
        SELECT LOWER(TRIM(n.vicinity)) AS name, 'street' AS kind, COUNT(*)::int AS hits
        ${baseWhere}
          AND n.vicinity IS NOT NULL AND TRIM(n.vicinity) <> ''
          AND ${placeMatchSql}
        GROUP BY LOWER(TRIM(n.vicinity))
      ) t
      WHERE LENGTH(name) BETWEEN 2 AND 80
      ORDER BY hits DESC, name ASC
      LIMIT 120
    `;

    const dbResult = await db.query(sql, params);
    const byKey = new Map();

    const addSuggestion = (rawName, kind, hits = 0, { parent = false } = {}) => {
      const cleaned = String(rawName || '').trim();
      if (!cleaned) return;
      if (!parent && isWeakLocation(cleaned)) return;
      const canon = canonicalizePlaceText(cleaned) || cleaned;
      const key = normalizePlaceKey(canon);
      if (!key || key.length < 2) return;

      // Bare khayaban typos are not streets — parent "Khayaban" covers all
      if (
        !parent &&
        isKhayabanFamilyToken(key) &&
        !key.includes(' ') &&
        !/-e-/.test(canon.replace(/\s+/g, '-')) &&
        !/\be\b/i.test(canon)
      ) {
        return;
      }

      const label = parent
        ? (key === 'khayaban' ? 'Khayaban' : key === 'dha' ? 'DHA' : titlePlaceLabel(canon))
        : titlePlaceLabel(canon);

      const existing = byKey.get(key);
      if (existing) {
        existing.hits += Number(hits) || 0;
        if ((Number(hits) || 0) > existing.bestHits) {
          existing.label = label;
          existing.kind = kind || existing.kind;
          existing.bestHits = Number(hits) || 0;
        }
        if (parent) existing.kind = 'group';
        return;
      }
      byKey.set(key, {
        id: key,
        label,
        kind: parent ? 'group' : (kind || 'area'),
        hits: Number(hits) || 0,
        bestHits: Number(hits) || 0,
        parent: !!parent
      });
    };

    for (const row of dbResult.rows) {
      addSuggestion(row.name, row.kind, row.hits);
    }

    if (queryWantsKhayaban || queryWantsDha) {
      // Parent hits MUST equal search totals for the same filters + location label
      const baseFilters = {
        purpose: String(req.query.purpose || ''),
        city: String(req.query.city || ''),
        propertyType: String(req.query.propertyType || req.query.property_type || ''),
        propertySubType: String(req.query.propertySubType || req.query.property_sub_type || ''),
        status: String(req.query.status || req.query.propertyStatus || req.query.property_status || '')
      };

      if (queryWantsKhayaban) {
        try {
          const hits = await countPropertySearch({ ...baseFilters, location: 'Khayaban' }, userId);
          if (hits > 0) addSuggestion('Khayaban', 'group', hits, { parent: true });
        } catch (err) {
          console.warn('khayaban suggest count failed:', err.message);
        }
      }

      if (queryWantsDha || queryWantsKhayaban) {
        try {
          const hits = await countPropertySearch({ ...baseFilters, location: 'DHA' }, userId);
          if (hits > 0) addSuggestion('DHA', 'group', hits, { parent: true });
        } catch (err) {
          console.warn('dha suggest count failed:', err.message);
        }
      }
    }

    const scored = [...byKey.values()].map((s) => {
      const labelLower = s.label.toLowerCase();
      const prefix = searchTerms.some(
        (t) => labelLower.startsWith(t) || normalizePlaceKey(labelLower).startsWith(normalizePlaceKey(t))
      );
      const parentBoost = s.parent ? 5000 : 0;
      return { ...s, score: parentBoost + (prefix ? 1000 : 0) + s.hits };
    });

    scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));

    const suggestions = scored.slice(0, limit).map(({ id, label, kind, hits }) => ({
      id,
      label,
      kind,
      hits
    }));

    return sendResponse(res, 200, false, { suggestions, query: rawQ }, 'Place suggestions');
  } catch (err) {
    console.error('places suggest error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

function titlePlaceLabel(value) {
  const s = String(value || '').trim();
  if (!s) return s;
  // Keep short acronyms (DHA, PECHS)
  if (/^[a-z0-9-]{2,6}$/i.test(s) && !/\s/.test(s) && s.length <= 5) {
    return s.toUpperCase();
  }
  return s
    .split(/(\s+|-)/)
    .map((part) => {
      if (part === '-' || /^\s+$/.test(part)) return part;
      if (/^(e|of|the|and)$/i.test(part)) return part.toLowerCase();
      if (/^(dha|pechs|pwd)$/i.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join('');
}

/**
 * Update property listing status.
 * :propertyId accepts either:
 *   - normalized_messages.id (listing_id / id from search cards)  ← preferred
 *   - whatsapp_messages.id (legacy message id)
 * PATCH/POST/PUT /api/properties/:propertyId/status  body: { status: "SOLD" }
 */
const handleUpdatePropertyStatus = async (req, res) => {
  const propertyId = parseInt(req.params.propertyId, 10);
  if (!propertyId || Number.isNaN(propertyId)) {
    return sendResponse(res, 400, true, null, 'propertyId is required');
  }

  const rawStatus =
    req.body?.status ??
    req.body?.propertyStatus ??
    req.body?.property_status ??
    req.query?.status ??
    req.query?.propertyStatus;

  const status = normalizePropertyStatus(rawStatus);
  if (!status) {
    return sendResponse(
      res,
      400,
      true,
      { allowed: [...PROPERTY_STATUSES] },
      `Invalid status. Allowed: ${PROPERTY_STATUSES.join(', ')}`
    );
  }

  const userId = Number(req.user?.id || req.userId || 1);

  try {
    // Prefer listing/card id (normalized_messages.id); fall back to WhatsApp message id
    let check = await db.query(
      `SELECT n.id, n.property_status, n.summary, n.whatsapp_message_id, m.user_id, m.id AS message_id
       FROM normalized_messages n
       JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
       WHERE n.id = $1
       LIMIT 1`,
      [propertyId]
    );

    if (!check.rows[0]) {
      check = await db.query(
        `SELECT n.id, n.property_status, n.summary, n.whatsapp_message_id, m.user_id, m.id AS message_id
         FROM normalized_messages n
         JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
         WHERE m.id = $1
         ORDER BY n.id DESC
         LIMIT 1`,
        [propertyId]
      );
    }

    if (!check.rows[0]) {
      return sendResponse(res, 404, true, null, 'Property not found');
    }

    const row = check.rows[0];
    if (Number(row.user_id) !== userId && req.user?.role !== 'admin') {
      return sendResponse(res, 403, true, null, 'You can only update your own properties');
    }

    const result = await db.query(
      `UPDATE normalized_messages
       SET property_status = $2
       WHERE id = $1
       RETURNING id, property_status, summary, whatsapp_message_id, chat_jid, purpose, property_type, city, price`,
      [row.id, status]
    );

    return sendResponse(
      res,
      200,
      false,
      {
        messageId: result.rows[0].whatsapp_message_id,
        propertyId: result.rows[0].id,
        listingId: result.rows[0].id,
        previousStatus: (row.property_status || 'AVAILABLE').toUpperCase(),
        status: result.rows[0].property_status,
        property: result.rows[0]
      },
      `Property marked as ${status}`
    );
  } catch (err) {
    console.error('Update property status error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
};

app.patch('/api/properties/:propertyId/status', authenticateToken, handleUpdatePropertyStatus);
app.post('/api/properties/:propertyId/status', authenticateToken, handleUpdatePropertyStatus);
app.put('/api/properties/:propertyId/status', authenticateToken, handleUpdatePropertyStatus);

// ---------------------------------------------------------------------------
// Favourites + private property comments (per-user only)
// ---------------------------------------------------------------------------

/**
 * POST /api/favourites  (toggle)
 * Body: { propertyId | listingId | id }  — normalized_messages.id from search card
 * If already favourited → removes it; otherwise adds it.
 */
app.post('/api/favourites', authenticateToken, async (req, res) => {
  try {
    const userId = resolveAuthUserId(req);
    if (!userId) {
      return sendResponse(res, 401, true, null, 'Login required');
    }
    const propertyId = resolvePropertyIdFromRequest(req);
    if (!propertyId) {
      return sendResponse(res, 400, true, null, 'propertyId is required');
    }

    const property = await findNormalizedPropertyById(propertyId);
    if (!property) {
      return sendResponse(res, 404, true, null, 'Property not found');
    }

    const existing = await db.query(
      `SELECT id, property_id, created_at
       FROM property_favourites
       WHERE user_id = $1 AND property_id = $2
       LIMIT 1`,
      [userId, propertyId]
    );

    let favourited = false;
    let favouriteRow = null;

    if (existing.rows[0]) {
      await db.query(`DELETE FROM property_favourites WHERE id = $1`, [existing.rows[0].id]);
      favourited = false;
    } else {
      const inserted = await db.query(
        `INSERT INTO property_favourites (user_id, property_id)
         VALUES ($1, $2)
         RETURNING id, user_id, property_id, created_at`,
        [userId, propertyId]
      );
      favouriteRow = inserted.rows[0];
      favourited = true;
    }

    const mapped = filterAndSortProperties([property], { sortBy: 'Newest First' })[0];
    const withMeta = await attachPrivatePropertyMeta(userId, [
      mapped || {
        id: property.id,
        whatsappMessageId: property.whatsapp_message_id,
        listingIndex: property.listing_index ?? 0,
        seqInChat: property.seq_in_chat,
        purpose: property.purpose,
        city: property.city,
        area: property.area,
        vicinity: property.vicinity,
        propertyType: property.property_type,
        propertySubType: property.property_sub_type,
        size: property.size,
        price: property.price,
        contactNumber: property.contact_number,
        summary: property.summary,
        propertyStatus: property.property_status,
        rawMessage: property.raw_message,
        createdAt: property.created_at
      }
    ]);
    const card = toDashboardSearchResult({
      ...withMeta[0],
      isFavourite: favourited
    });

    return sendResponse(
      res,
      200,
      false,
      {
        toggled: true,
        isFavourite: favourited,
        is_favourite: favourited,
        action: favourited ? 'added' : 'removed',
        id: favouriteRow?.id || existing.rows[0]?.id || null,
        propertyId,
        property_id: propertyId,
        createdAt: favouriteRow?.created_at || null,
        created_at: favouriteRow?.created_at || null,
        property: card
      },
      favourited ? 'Property added to favourites' : 'Property removed from favourites'
    );
  } catch (err) {
    console.error('Toggle favourite error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

/**
 * GET /api/favourites
 * Returns this user's favourited scraped cards (with private comments).
 */
app.get('/api/favourites', authenticateToken, async (req, res) => {
  try {
    const userId = resolveAuthUserId(req);
    if (!userId) {
      return sendResponse(res, 401, true, null, 'Login required');
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const favs = await db.query(
      `SELECT f.id AS favourite_id, f.property_id, f.created_at AS favourited_at,
              n.id, n.whatsapp_message_id, n.chat_jid, n.purpose, n.city, n.area, n.vicinity,
              n.property_type, n.property_sub_type, n.size, n.price,
              COALESCE(NULLIF(TRIM(n.contact_number), ''), NULLIF(TRIM(m.sender_phone), '')) AS contact_number,
              n.summary, n.property_status, n.created_at, n.category, n.intent, n.sentiment,
              n.listing_index, n.listing_excerpt,
              COALESCE(NULLIF(TRIM(n.listing_excerpt), ''), m.message) AS raw_message,
              m.timestamp AS message_timestamp, m.from_me, m.user_id,
              m.seq_in_chat, m.seq_in_chat AS "seqInChat"
       FROM property_favourites f
       INNER JOIN normalized_messages n ON n.id = f.property_id
       INNER JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
       WHERE f.user_id = $1
       ORDER BY f.created_at DESC, f.id DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM property_favourites WHERE user_id = $1`,
      [userId]
    );

    const withMeta = await attachPrivatePropertyMeta(userId, favs.rows);
    // Keep favourite order; skip junk filter so user still sees what they saved
    const results = withMeta.map((row) => {
      const mapped = filterAndSortProperties([row], { sortBy: 'Newest First' })[0];
      const base = mapped || {
        id: row.id,
        whatsappMessageId: row.whatsapp_message_id,
        listingIndex: row.listing_index ?? 0,
        seqInChat: row.seq_in_chat,
        purpose: row.purpose,
        city: row.city,
        area: row.area,
        vicinity: row.vicinity,
        propertyType: row.property_type,
        propertySubType: row.property_sub_type,
        size: row.size,
        price: row.price,
        contactNumber: row.contact_number,
        summary: row.summary,
        propertyStatus: row.property_status,
        rawMessage: row.raw_message,
        createdAt: row.created_at,
        isFavourite: true,
        comments: row.comments || []
      };
      base.isFavourite = true;
      base.comments = row.comments || [];
      const card = toDashboardSearchResult(base);
      return {
        ...card,
        favouriteId: row.favourite_id,
        favourite_id: row.favourite_id,
        favouritedAt: row.favourited_at,
        favourited_at: row.favourited_at
      };
    });

    return sendResponse(
      res,
      200,
      false,
      {
        total: countRes.rows[0]?.total || 0,
        limit,
        offset,
        favourites: results
      },
      'Favourites retrieved'
    );
  } catch (err) {
    console.error('Get favourites error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

/**
 * DELETE /api/favourites/:propertyId
 */
app.delete('/api/favourites/:propertyId', authenticateToken, async (req, res) => {
  try {
    const userId = resolveAuthUserId(req);
    if (!userId) {
      return sendResponse(res, 401, true, null, 'Login required');
    }
    const propertyId = resolvePropertyIdFromRequest(req);
    if (!propertyId) {
      return sendResponse(res, 400, true, null, 'propertyId is required');
    }

    const deleted = await db.query(
      `DELETE FROM property_favourites
       WHERE user_id = $1 AND property_id = $2
       RETURNING id, property_id`,
      [userId, propertyId]
    );

    if (!deleted.rows[0]) {
      return sendResponse(res, 404, true, null, 'Favourite not found');
    }

    return sendResponse(
      res,
      200,
      false,
      {
        propertyId: deleted.rows[0].property_id,
        property_id: deleted.rows[0].property_id
      },
      'Favourite removed'
    );
  } catch (err) {
    console.error('Delete favourite error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

/**
 * POST /api/properties/:propertyId/comments
 * Body: { comment: "agent quoted 2.1 crore last deal" }
 * Private to the logged-in user only.
 */
app.post('/api/properties/:propertyId/comments', authenticateToken, async (req, res) => {
  try {
    const userId = resolveAuthUserId(req);
    if (!userId) {
      return sendResponse(res, 401, true, null, 'Login required');
    }
    const propertyId = resolvePropertyIdFromRequest(req);
    if (!propertyId) {
      return sendResponse(res, 400, true, null, 'propertyId is required');
    }

    const comment = String(
      req.body?.comment ?? req.body?.text ?? req.body?.note ?? ''
    ).trim();
    if (!comment) {
      return sendResponse(res, 400, true, null, 'comment is required');
    }
    if (comment.length > 5000) {
      return sendResponse(res, 400, true, null, 'comment is too long (max 5000 chars)');
    }

    const property = await findNormalizedPropertyById(propertyId);
    if (!property) {
      return sendResponse(res, 404, true, null, 'Property not found');
    }

    const inserted = await db.query(
      `INSERT INTO property_comments (user_id, property_id, comment)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, property_id, comment, created_at, updated_at`,
      [userId, propertyId, comment]
    );

    return sendResponse(
      res,
      201,
      false,
      mapPropertyCommentRow(inserted.rows[0]),
      'Comment added'
    );
  } catch (err) {
    console.error('Add property comment error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

/**
 * GET /api/properties/:propertyId/comments
 * Own private comments only.
 */
app.get('/api/properties/:propertyId/comments', authenticateToken, async (req, res) => {
  try {
    const userId = resolveAuthUserId(req);
    if (!userId) {
      return sendResponse(res, 401, true, null, 'Login required');
    }
    const propertyId = resolvePropertyIdFromRequest(req);
    if (!propertyId) {
      return sendResponse(res, 400, true, null, 'propertyId is required');
    }

    const result = await db.query(
      `SELECT id, property_id, comment, created_at, updated_at
       FROM property_comments
       WHERE user_id = $1 AND property_id = $2
       ORDER BY created_at ASC, id ASC`,
      [userId, propertyId]
    );

    return sendResponse(
      res,
      200,
      false,
      {
        propertyId,
        property_id: propertyId,
        comments: result.rows.map(mapPropertyCommentRow)
      },
      'Comments retrieved'
    );
  } catch (err) {
    console.error('Get property comments error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// ---------------------------------------------------------------------------
// Normalization (AI) — portal user triggers + polls progress
// ---------------------------------------------------------------------------

/**
 * GET /api/normalize/status
 * Auth required. Returns % done, totals, pending, property/embed counts, job state.
 */
app.get('/api/normalize/status', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user?.id || req.userId);
    if (!userId) {
      return sendResponse(res, 401, true, null, 'Authenticated userId is required');
    }

    const model =
      (typeof req.query.model === 'string' && req.query.model.trim()) || NORMALIZE_MODEL;

    const [counts, job] = await Promise.all([
      getNormalizeCounts(userId, model),
      getNormalizeJob(userId)
    ]);

    return sendResponse(
      res,
      200,
      false,
      buildStatusPayload(userId, counts, job, model),
      'Normalization status retrieved'
    );
  } catch (err) {
    console.error('Normalize status error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

/**
 * POST /api/normalize/trigger
 * Auth required. Queues AI normalization for the logged-in user's scraped messages.
 * Body (optional): { batchSize?: number, embed?: boolean, model?: string }
 */
app.post('/api/normalize/trigger', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user?.id || req.userId);
    if (!userId) {
      return sendResponse(res, 401, true, null, 'Authenticated userId is required');
    }

    const body = req.body || {};
    const model =
      (typeof body.model === 'string' && body.model.trim()) || NORMALIZE_MODEL;
    const embed = body.embed !== false && body.embed !== 'false';
    const batchSize = body.batchSize ?? body.batch_size ?? 50;

    const countsBefore = await getNormalizeCounts(userId, model);
    if (countsBefore.totalMessages === 0) {
      return sendResponse(
        res,
        400,
        true,
        buildStatusPayload(userId, countsBefore, null, model),
        'No scraped messages to normalize for this user'
      );
    }
    if (countsBefore.pendingCount === 0) {
      return sendResponse(
        res,
        200,
        false,
        {
          ...buildStatusPayload(userId, countsBefore, await getNormalizeJob(userId), model),
          triggered: false
        },
        'All messages are already normalized'
      );
    }

    const { job, alreadyActive } = await queueNormalizeJob(userId, {
      model,
      embed,
      batchSize
    });

    let botNotify = { notified: false, reason: null };
    if (!alreadyActive) {
      botNotify = await notifyNormalizeBot(userId, job);
      // Job stays queued for auto_pipeline if bot is offline — only mark failed
      // when the bot explicitly rejected (not network/offline).
      if (
        botNotify.notified === false &&
        botNotify.reason &&
        /HTTP 4\d\d|detail|rejected|secret/i.test(String(botNotify.reason))
      ) {
        await markNormalizeJobError(userId, botNotify.reason);
      }
    }

    const [counts, freshJob] = await Promise.all([
      getNormalizeCounts(userId, model),
      getNormalizeJob(userId)
    ]);

    const payload = {
      ...buildStatusPayload(userId, counts, freshJob || job, model),
      triggered: !alreadyActive,
      alreadyRunning: alreadyActive,
      botNotified: Boolean(botNotify.notified),
      botNote: botNotify.reason || null
    };

    const message = alreadyActive
      ? 'Normalization already in progress for this user'
      : botNotify.notified
        ? 'Normalization started'
        : 'Normalization queued (AI worker will pick it up when available)';

    return sendResponse(res, alreadyActive ? 200 : 202, false, payload, message);
  } catch (err) {
    console.error('Normalize trigger error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// ── Complaints ──────────────────────────────────────────────────────────────

const mapComplaintRow = (row) => ({
  id: row.id,
  userId: row.user_id,
  user_id: row.user_id,
  name: row.name,
  email: row.email,
  phone: row.phone || '',
  message: row.message,
  status: row.status,
  emailSent: Boolean(row.email_sent),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  userAccountEmail: row.user_account_email || null,
  userAccountName: row.user_account_name || null,
});

// POST /api/complaints — logged-in user submits a complaint (saved + emailed)
app.post('/api/complaints', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim();
    const phone = String(req.body?.phone || req.body?.phone_number || '').trim();
    const message = String(req.body?.message || '').trim();

    if (!name || !email || !message) {
      return sendResponse(res, 400, true, null, 'Name, email, and message are required');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendResponse(res, 400, true, null, 'A valid email is required');
    }

    const inserted = await db.query(
      `INSERT INTO complaints (user_id, name, email, phone, message, status, email_sent)
       VALUES ($1, $2, $3, $4, $5, 'submitted', FALSE)
       RETURNING id, user_id, name, email, phone, message, status, email_sent, created_at, updated_at`,
      [userId || null, name, email, phone || null, message]
    );

    const row = inserted.rows[0];
    let emailSent = false;
    let emailNote = null;

    try {
      const mailResult = await sendComplaintEmail({
        name,
        email,
        phone,
        message,
        complaintId: row.id,
      });
      emailSent = Boolean(mailResult?.sent);
      emailNote = mailResult?.reason || null;
      if (emailSent) {
        await db.query(
          `UPDATE complaints SET email_sent = TRUE, updated_at = NOW() WHERE id = $1`,
          [row.id]
        );
        row.email_sent = true;
      }
    } catch (mailErr) {
      console.error('Complaint email failed:', mailErr.message);
      emailNote = mailErr.message || 'Email send failed';
    }

    return sendResponse(
      res,
      201,
      false,
      { ...mapComplaintRow(row), emailNote },
      emailSent
        ? 'Complaint submitted and email sent'
        : 'Complaint submitted (email pending / not configured)'
    );
  } catch (err) {
    console.error('Create complaint error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// GET /api/complaints — user: own complaints; admin: all
app.get('/api/complaints', authenticateToken, async (req, res) => {
  try {
    const isAdminUser = String(req.user?.role || '').toLowerCase() === 'admin';
    const userId = req.user?.id;

    const result = isAdminUser
      ? await db.query(
          `SELECT c.id, c.user_id, c.name, c.email, c.phone, c.message, c.status, c.email_sent,
                  c.created_at, c.updated_at, u.email AS user_account_email, u.name AS user_account_name
           FROM complaints c
           LEFT JOIN users u ON u.id = c.user_id
           ORDER BY c.created_at DESC`
        )
      : await db.query(
          `SELECT c.id, c.user_id, c.name, c.email, c.phone, c.message, c.status, c.email_sent,
                  c.created_at, c.updated_at, u.email AS user_account_email, u.name AS user_account_name
           FROM complaints c
           LEFT JOIN users u ON u.id = c.user_id
           WHERE c.user_id = $1
           ORDER BY c.created_at DESC`,
          [userId]
        );

    return sendResponse(
      res,
      200,
      false,
      result.rows.map(mapComplaintRow),
      'Complaints retrieved'
    );
  } catch (err) {
    console.error('List complaints error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// PATCH /api/complaints/:id/status — admin updates status (visible on user portal)
app.patch('/api/complaints/:id/status', authenticateToken, isAdmin, async (req, res) => {
  try {
    const complaintId = parseInt(req.params.id, 10);
    const status = String(req.body?.status || '').trim().toLowerCase();

    if (!complaintId || Number.isNaN(complaintId)) {
      return sendResponse(res, 400, true, null, 'Valid complaint id is required');
    }
    if (!COMPLAINT_STATUSES.includes(status)) {
      return sendResponse(
        res,
        400,
        true,
        null,
        `Status must be one of: ${COMPLAINT_STATUSES.join(', ')}`
      );
    }

    const result = await db.query(
      `UPDATE complaints
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, user_id, name, email, phone, message, status, email_sent, created_at, updated_at`,
      [status, complaintId]
    );

    if (!result.rows[0]) {
      return sendResponse(res, 404, true, null, 'Complaint not found');
    }

    return sendResponse(res, 200, false, mapComplaintRow(result.rows[0]), 'Complaint status updated');
  } catch (err) {
    console.error('Update complaint status error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// Root Route
app.get('/', (req, res) => {
  return sendResponse(res, 200, false, { service: 'whatsapp-scraper-backend' }, 'API service running');
});

app.get('/health', async (req, res) => {
  let dbStatus = 'ok';
  try {
    await db.query('SELECT 1');
  } catch (err) {
    dbStatus = 'error';
  }

  const pipeline = getPipelineStats();
  const cfg = getConfigSafe();
  const healthy = dbStatus === 'ok';

  return sendResponse(
    res,
    healthy ? 200 : 503,
    !healthy,
    {
      service: 'whatsapp-scraper-backend',
      db: dbStatus,
      ai: {
        pipelineMode: cfg.pipelineMode || process.env.AI_PIPELINE || 'local',
        model: cfg.defaultModel || process.env.DEFAULT_MODEL || null,
        llmConfigured: Boolean(cfg.llmConfigured),
        embeddingBaseUrl: cfg.embeddingBaseUrl || process.env.EMBEDDING_BASE_URL || null
      },
      pipeline: {
        running: pipeline.running,
        lastRun: pipeline.lastRun,
        lastNormalized: pipeline.lastNormalized,
        lastEmbedded: pipeline.lastEmbedded,
        totalNormalized: pipeline.totalNormalized,
        totalEmbedded: pipeline.totalEmbedded,
        lastError: pipeline.lastError,
        currentUserId: pipeline.currentUserId,
        model: pipeline.model,
        concurrency: pipeline.concurrency,
        workerStarted: pipeline.workerStarted,
        shuttingDown: pipeline.shuttingDown,
        pipelineMode: pipeline.pipelineMode
      },
      worker: {
        baseUrl: process.env.WORKER_BASE_URL || null,
        configured: Boolean(process.env.WORKER_BASE_URL && process.env.WORKER_API_KEY)
      }
    },
    healthy ? 'Healthy' : 'Database unavailable'
  );
});

// Start Server (await DB migration so monitored_at exists before traffic)
async function refreshLocalityGazetteer() {
  try {
    const { rows } = await db.query(`
      SELECT DISTINCT LOWER(TRIM(name)) AS name
      FROM (
        SELECT area AS name FROM normalized_messages WHERE area IS NOT NULL AND TRIM(area) <> ''
        UNION ALL
        SELECT vicinity FROM normalized_messages WHERE vicinity IS NOT NULL AND TRIM(vicinity) <> ''
        UNION ALL
        SELECT city FROM normalized_messages WHERE city IS NOT NULL AND TRIM(city) <> ''
      ) t
      WHERE LENGTH(TRIM(name)) BETWEEN 3 AND 60
      LIMIT 8000
    `);
    setExtraLocalities(rows.map((r) => r.name));
    console.log(`[search] locality gazetteer loaded: ${rows.length} names from DB`);
  } catch (err) {
    console.warn('[search] locality gazetteer refresh failed:', err.message);
  }
}

(async () => {
  try {
    await db.initializeDb();
    if (typeof db.migrateSeqLabels === 'function') {
      await db.migrateSeqLabels();
    }
  } catch (err) {
    console.error('Database init failed on startup:', err.message);
  }

  await refreshLocalityGazetteer();
  setInterval(() => {
    refreshLocalityGazetteer().catch(() => {});
  }, 30 * 60 * 1000);

  try {
    const started = startPipelineWorker();
    console.log('[pipeline] start result:', started);
  } catch (err) {
    console.error('[pipeline] Failed to start AI worker:', err.message);
  }

  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });

  const mlCompatPort = parseInt(process.env.ML_COMPAT_PORT || '8000', 10);
  if (mlCompatPort && mlCompatPort !== Number(PORT)) {
    const mlServer = http.createServer(app);
    mlServer.on('error', (err) => {
      console.warn(`[ml-compat] port ${mlCompatPort} not bound:`, err.message);
    });
    mlServer.listen(mlCompatPort, '0.0.0.0', () => {
      console.log(`ML-compat dashboard-search listening on port ${mlCompatPort}`);
    });
  }
})();
