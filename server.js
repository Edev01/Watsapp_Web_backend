const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const db = require('./db');
const { sendResponse } = require('./responseHelper');
const { authenticateToken, isAdmin } = require('./middleware');
const { filterAndSortProperties } = require('./propertyHelper');
const { extractUserId } = require('./userMiddleware');
const { findOrCreateCanonicalChat, cleanText, isSystemNotificationText, isCommonJunkMessage } = require('./contactHelper');
const {
  DEFAULT_MODEL: NORMALIZE_MODEL,
  getNormalizeCounts,
  getNormalizeJob,
  queueNormalizeJob,
  markNormalizeJobError,
  notifyNormalizeBot,
  buildStatusPayload
} = require('./normalizeHelper');

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
app.use(express.json());
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
    await db.query(
      `UPDATE whatsapp_link_sessions SET updated_at = NOW() WHERE id = $1`,
      [existing.rows[0].id]
    );
    return {
      ...existing.rows[0],
      updated_at: new Date().toISOString(),
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
    // Keep session alive / waiting while QR is being shown
    await db.query(
      `UPDATE whatsapp_link_sessions
       SET status = 'waiting', updated_at = NOW()
       WHERE user_id = $1 AND status IN ('waiting', 'linked')`,
      [userId]
    );

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
    const result = await db.query(
      `SELECT s.id, s.user_id, s.status, s.created_at, s.updated_at, u.email, u.name
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
  try {
    await db.query(
      `UPDATE whatsapp_link_sessions SET status = 'released', updated_at = NOW() WHERE status IN ('waiting', 'linked')`
    );
    io.emit('link_session_released', { status: 'released' });
    return sendResponse(res, 200, false, { status: 'released' }, 'Link session released');
  } catch (err) {
    console.error('QR release error:', err);
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
          url: null
        },
        'WhatsApp already connected — QR not shown'
      );
    }

    const result = await db.query(
      `SELECT id, url, source, page_url, user_id, created_at
       FROM qr_codes
       WHERE user_id = $1
         AND created_at > NOW() - INTERVAL '2 minutes'
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
    const link = await getUserLinkSession(userId);
    const userBound = await db.query(
      'SELECT bound_whatsapp_jid, bound_whatsapp_phone, email, name FROM users WHERE id = $1',
      [userId]
    );
    const boundJid = userBound.rows[0]?.bound_whatsapp_jid || link?.whatsapp_jid || null;
    const boundPhone =
      userBound.rows[0]?.bound_whatsapp_phone || formatBoundPhone(boundJid);
    const linked = link?.status === 'linked';

    return sendResponse(
      res,
      200,
      false,
      {
        userId: Number(userId),
        // true => show "WhatsApp Connected", hide QR
        linked,
        status: link?.status || (boundJid ? 'waiting' : 'none'),
        // live session jid (if currently linked)
        whatsappJid: linked ? link?.whatsapp_jid || boundJid : null,
        // permanent first-scan bind (never changes)
        boundWhatsappJid: boundJid,
        boundPhone: boundPhone || null,
        canLinkOtherNumbers: !boundJid,
        message: linked
          ? `WhatsApp connected${boundPhone ? ` (${boundPhone})` : ''}`
          : boundJid
            ? `Waiting to link bound WhatsApp${boundPhone ? ` ${boundPhone}` : ''}`
            : 'No WhatsApp linked yet — scan QR to bind the first number'
      },
      linked ? 'WhatsApp connected' : 'WhatsApp not connected'
    );
  } catch (err) {
    console.error('Get connection status error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

function resolveTenantUserId(req, fallback = null) {
  const force = String(req.headers['x-force-user-id'] || '') === '1';
  const headerId = req.headers['x-user-id'];
  if (force && headerId != null && !isNaN(parseInt(headerId, 10))) {
    return parseInt(headerId, 10);
  }
  const raw =
    req.userId ||
    req.body?.userId ||
    req.body?.user_id ||
    req.query?.userId ||
    req.query?.user_id ||
    headerId ||
    fallback;
  if (raw == null || String(raw).trim() === '' || isNaN(parseInt(raw, 10))) return fallback;
  return parseInt(raw, 10);
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
  const userId = resolveTenantUserId(req, 1);
  const rawType = String(req.query.type || req.query.filter || 'all').toLowerCase();
  const type = ['monitored', 'chats', 'all'].includes(rawType) ? rawType : 'all';
  const search = String(req.query.search || req.query.q || '').trim();

  const pageSize = Math.min(
    Math.max(
      parseInt(req.query.pageSize || req.query.page_size || req.query.limit, 10) || 50,
      1
    ),
    500
  );

  const hasExplicitOffset =
    req.query.offset != null && String(req.query.offset).trim() !== '';
  const hasExplicitPage =
    req.query.page != null && String(req.query.page).trim() !== '';

  let page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  let offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  let limit = pageSize;

  if (hasExplicitOffset && !hasExplicitPage) {
    offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    if (req.query.limit != null) {
      limit = Math.min(Math.max(parseInt(req.query.limit, 10) || pageSize, 1), 500);
    }
    page = Math.floor(offset / limit) + 1;
  } else {
    page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    offset = (page - 1) * pageSize;
    limit = pageSize;
  }

  return { userId, type, limit, offset, page, pageSize: limit, search };
}

function buildPaginationMeta({ page, pageSize, limit, offset, total, rowCount }) {
  const totalPages = Math.max(Math.ceil(total / limit), total > 0 ? 1 : 0);
  const safePage = Math.min(Math.max(page, 1), totalPages || 1);
  return {
    page: safePage,
    pageSize: limit,
    limit,
    offset,
    total,
    totalPages,
    count: rowCount,
    hasNext: offset + rowCount < total,
    hasPrev: offset > 0,
    nextPage: offset + rowCount < total ? safePage + 1 : null,
    prevPage: safePage > 1 ? safePage - 1 : null
  };
}

function buildChatListSql({ userId, type, limit, offset, search }) {
  const params = [userId];
  let where = 'WHERE user_id = $1';

  if (type === 'monitored') {
    where += ' AND is_monitored = TRUE';
  } else if (type === 'chats') {
    where += ' AND is_monitored = FALSE';
  }

  if (search) {
    params.push(`%${search}%`);
    where += ` AND (LOWER(COALESCE(name, '')) LIKE LOWER($${params.length}) OR LOWER(jid) LIKE LOWER($${params.length}))`;
  }

  params.push(limit, offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const sql = `
    SELECT jid, name, avatar, is_monitored, user_id, created_at, monitored_at, last_scraped_at
    FROM whatsapp_chats
    ${where}
    ORDER BY name ASC NULLS LAST, jid ASC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

  const countSql = `SELECT COUNT(*)::int AS total FROM whatsapp_chats ${where}`;

  return { sql, countSql, params, countParams: params.slice(0, -2) };
}

// 7. Post Scraped Contacts List (Deduplicated by name & JID with canonical matching)
app.post('/api/scraped-chats/contacts', async (req, res) => {
  const { contacts } = req.body;
  const userId = resolveTenantUserId(req, 1);
  if (!Array.isArray(contacts)) {
    return sendResponse(res, 400, true, null, 'Contacts array is required');
  }
  try {
    for (const contact of contacts) {
      if (!contact.name && !contact.id) continue;
      await findOrCreateCanonicalChat(userId, contact.id, contact.name, contact.avatar);
    }
    return sendResponse(res, 200, false, null, 'Contacts updated successfully');
  } catch (err) {
    console.error('Contacts update error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 8. Get Monitored Chats list (Includes last_scraped_timestamp for incremental sync)
app.get('/api/scraped-chats/monitored', async (req, res) => {
  const userId = req.userId || req.query.userId || req.query.user_id || 1;
  try {
    const result = await db.query(
      `SELECT c.jid, c.name, c.avatar, c.is_monitored, c.user_id, c.created_at,
         c.monitored_at,
         c.last_scraped_at
       FROM whatsapp_chats c 
       WHERE c.user_id = $1 AND c.is_monitored = TRUE 
       ORDER BY c.name ASC`,
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
  const userId = resolveTenantUserId(req, 1);
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

    for (const msg of messages) {
      const sender = (msg.sender ?? '').toString().trim();
      const timestamp = (msg.timestamp ?? '').toString().trim();
      const messageText = (msg.message ?? msg.text ?? '').toString();
      const rawEpoch = msg.messageEpoch ?? msg.message_epoch ?? msg.ts_epoch;
      const messageEpoch =
        rawEpoch != null && !Number.isNaN(Number(rawEpoch)) ? Number(rawEpoch) : null;
      // Right-side WhatsApp bubbles = from me; left-side = not me
      const rawFromMe = msg.fromMe ?? msg.from_me ?? false;
      const isFromMe =
        rawFromMe === true ||
        rawFromMe === 1 ||
        String(rawFromMe).toLowerCase() === 'true';

      if (!timestamp && !messageText) {
        skippedCount++;
        continue;
      }

      // Skip common fillers (ok/hi/thanks/emoji-only/system notices)
      if (isCommonJunkMessage(messageText)) {
        skippedCount++;
        continue;
      }

      try {
        const result = await db.query(
          `INSERT INTO whatsapp_messages (user_id, chat_jid, sender, timestamp, message, from_me) 
           VALUES ($1, $2, $3, $4, $5, $6) 
           ON CONFLICT (user_id, chat_jid, sender, timestamp, message)
           DO UPDATE SET from_me = EXCLUDED.from_me
           RETURNING id, (xmax = 0) AS inserted`,
          [userId, canonicalJid, sender || 'unknown', timestamp || 'unknown', messageText, isFromMe]
        );
        if (result.rowCount > 0) {
          if (result.rows[0]?.inserted) {
            addedCount++;
            if (messageEpoch != null) {
              maxMessageEpoch =
                maxMessageEpoch == null
                  ? messageEpoch
                  : Math.max(maxMessageEpoch, messageEpoch);
            }
          } else skippedCount++; // existed; from_me may have been corrected
        } else {
          skippedCount++;
        }
      } catch (insertErr) {
        skippedCount++;
        insertErrors.push(insertErr.message);
        console.error('Message insert error:', insertErr.message);
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
      skippedCount
    });

    // Auto-queue AI normalization for this tenant (no PC / manual step).
    // Render Background Worker (auto_pipeline) or AI_BOT_URL picks it up.
    if (addedCount > 0) {
      queueNormalizeJob(userId, { embed: true }).then(({ job, alreadyActive }) => {
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
      { addedCount, skippedCount, targetJid: canonicalJid, userId, insertErrors: insertErrors.slice(0, 3) },
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
  const userId = req.userId || body.userId || body.user_id || 1;

  // Accept jids[], or a single jid / chatId / id
  const rawJids = Array.isArray(body.jids)
    ? body.jids
    : [body.jid, body.chatId, body.chat_id, body.id].filter((v) => v != null && String(v).trim() !== '');
  const jids = rawJids.map((j) => String(j).trim()).filter(Boolean);

  if (jids.length === 0) {
    return sendResponse(res, 400, true, null, 'jid/chatId or jids array is required');
  }

  try {
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
         RETURNING jid, name, is_monitored, monitored_at`,
        [userId, jids]
      );
      updated = result.rowCount;
      updatedRows = result.rows;
    } else if (mode === 'remove') {
      // Unmonitor: only the given chat IDs are removed from monitored list
      const result = await db.query(
        'UPDATE whatsapp_chats SET is_monitored = FALSE WHERE user_id = $1 AND jid = ANY($2) RETURNING jid, name, is_monitored',
        [userId, jids]
      );
      updated = result.rowCount;
      updatedRows = result.rows;
    } else {
      const result = await db.query(
        `UPDATE whatsapp_chats
         SET is_monitored = TRUE,
             monitored_at = CASE WHEN is_monitored = FALSE THEN NOW() ELSE monitored_at END
         WHERE user_id = $1 AND jid = ANY($2)
         RETURNING jid, name, is_monitored, monitored_at`,
        [userId, jids]
      );
      updated = result.rowCount;
      updatedRows = result.rows;
    }

    const monitoredRows = await db.query(
      'SELECT jid, name, is_monitored FROM whatsapp_chats WHERE user_id = $1 AND is_monitored = TRUE ORDER BY name ASC',
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

// 11. Get chats (type=monitored|chats|all, pagination: page & pageSize)
app.get('/api/scraped-chats', async (req, res) => {
  const { userId, type, limit, offset, page, pageSize, search } = parseChatListQuery(req);
  try {
    const { sql, countSql, params, countParams } = buildChatListSql({
      userId,
      type,
      limit,
      offset,
      search
    });
    const [result, countResult] = await Promise.all([
      db.query(sql, params),
      db.query(countSql, countParams)
    ]);
    const total = countResult.rows[0]?.total ?? result.rowCount;
    const pagination = buildPaginationMeta({
      page,
      pageSize,
      limit,
      offset,
      total,
      rowCount: result.rows.length
    });
    return sendResponse(
      res,
      200,
      false,
      {
        chats: result.rows,
        type,
        search: search || null,
        pagination,
        // legacy fields
        total,
        limit,
        offset,
        hasMore: pagination.hasNext
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
  const userId = resolveTenantUserId(req, 1);
  try {
    const result = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE is_monitored = TRUE)::int AS monitored,
         COUNT(*) FILTER (WHERE is_monitored = FALSE)::int AS unmonitored
       FROM whatsapp_chats
       WHERE user_id = $1`,
      [userId]
    );
    return sendResponse(res, 200, false, result.rows[0], 'Chat stats retrieved');
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
  const userId = req.userId || req.query.userId || req.query.user_id || 1;
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
  const userId = req.userId || req.query.userId || req.query.user_id || 1;
  const { chatId, jid, name, limit, offset } = req.query;
  const targetId = chatId || jid;
  const pageLimit = Math.min(parseInt(limit, 10) || 5000, 10000);
  const pageOffset = Math.max(parseInt(offset, 10) || 0, 0);

  try {
    let result;
    if (targetId) {
      result = await db.query(
        `SELECT m.id, m.chat_jid, c.name as chat_name, m.sender, m.timestamp, m.message, m.from_me, m.from_me as "fromMe", m.user_id, m.created_at 
         FROM whatsapp_messages m
         LEFT JOIN whatsapp_chats c ON m.chat_jid = c.jid AND m.user_id = c.user_id
         WHERE m.user_id = $1 AND (m.chat_jid = $2 OR LOWER(COALESCE(c.name, '')) LIKE LOWER($3))
         ORDER BY m.id ASC
         LIMIT $4 OFFSET $5`,
        [userId, targetId, `%${targetId}%`, pageLimit, pageOffset]
      );
    } else if (name) {
      result = await db.query(
        `SELECT m.id, m.chat_jid, c.name as chat_name, m.sender, m.timestamp, m.message, m.from_me, m.from_me as "fromMe", m.user_id, m.created_at 
         FROM whatsapp_messages m
         LEFT JOIN whatsapp_chats c ON m.chat_jid = c.jid AND m.user_id = c.user_id
         WHERE m.user_id = $1 AND LOWER(COALESCE(c.name, '')) LIKE LOWER($2)
         ORDER BY m.id ASC
         LIMIT $3 OFFSET $4`,
        [userId, `%${name}%`, pageLimit, pageOffset]
      );
    } else {
      // No chat filter: return this user's messages only (fixes frontend 400)
      result = await db.query(
        `SELECT m.id, m.chat_jid, c.name as chat_name, m.sender, m.timestamp, m.message, m.from_me, m.from_me as "fromMe", m.user_id, m.created_at 
         FROM whatsapp_messages m
         LEFT JOIN whatsapp_chats c ON m.chat_jid = c.jid AND m.user_id = c.user_id
         WHERE m.user_id = $1
         ORDER BY m.id ASC
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
const handlePropertyFilter = async (req, res) => {
  try {
    const rawFilters = req.body?.filters || req.body || {};
    const queryFilters = req.query || {};

    const filters = {
      purpose: rawFilters.purpose || queryFilters.purpose || '',
      city: rawFilters.city || queryFilters.city || '',
      location: rawFilters.location || queryFilters.location || rawFilters.vicinity || queryFilters.vicinity || rawFilters.area || queryFilters.area || '',
      propertyType: rawFilters.propertyType || queryFilters.propertyType || rawFilters.property_type || queryFilters.property_type || '',
      propertySubType: rawFilters.propertySubType || queryFilters.propertySubType || rawFilters.property_sub_type || queryFilters.property_sub_type || '',
      sortBy: rawFilters.sortBy || queryFilters.sortBy || rawFilters.sort_by || queryFilters.sort_by || 'Newest First',
      priceMin: rawFilters.priceMin ?? queryFilters.priceMin ?? '',
      priceMax: rawFilters.priceMax ?? queryFilters.priceMax ?? '',
      areaUnit: rawFilters.areaUnit || queryFilters.areaUnit || rawFilters.area_unit || queryFilters.area_unit || 'Marla',
      areaMin: rawFilters.areaMin ?? queryFilters.areaMin ?? '',
      areaMax: rawFilters.areaMax ?? queryFilters.areaMax ?? ''
    };

    const userId = req.userId || rawFilters.userId || rawFilters.user_id || queryFilters.userId || queryFilters.user_id || 1;

    let queryText = `
      SELECT n.*, m.message as raw_message, m.timestamp as message_timestamp, m.from_me, m.user_id, c.name as chat_name
      FROM normalized_messages n
      LEFT JOIN whatsapp_messages m ON n.whatsapp_message_id = m.id
      LEFT JOIN whatsapp_chats c ON n.chat_jid = c.jid AND m.user_id = c.user_id
      WHERE m.user_id = $1 AND (n.is_property = true OR n.purpose IS NOT NULL OR n.property_type IS NOT NULL)
    `;
    const params = [userId];
    const whereClauses = [];

    if (filters.purpose && String(filters.purpose).trim() !== '') {
      const p = String(filters.purpose).trim().toLowerCase();
      params.push(`%${p}%`);
      const idx = `$${params.length}`;
      if (p === 'buy' || p === 'sale' || p === 'sell') {
        whereClauses.push(`(LOWER(n.purpose) IN ('buy', 'sale', 'sell') OR LOWER(m.message) LIKE ${idx} OR LOWER(n.summary) LIKE ${idx})`);
      } else if (p === 'rent') {
        whereClauses.push(`(LOWER(n.purpose) = 'rent' OR LOWER(m.message) LIKE ${idx} OR LOWER(n.summary) LIKE ${idx})`);
      } else {
        whereClauses.push(`(LOWER(n.purpose) LIKE ${idx} OR LOWER(m.message) LIKE ${idx} OR LOWER(n.summary) LIKE ${idx})`);
      }
    }

    if (filters.city && String(filters.city).trim() !== '') {
      params.push(`%${String(filters.city).trim().toLowerCase()}%`);
      const idx = `$${params.length}`;
      whereClauses.push(`(LOWER(n.city) LIKE ${idx} OR LOWER(n.vicinity) LIKE ${idx} OR LOWER(n.area) LIKE ${idx} OR LOWER(m.message) LIKE ${idx})`);
    }

    if (filters.location && String(filters.location).trim() !== '') {
      params.push(`%${String(filters.location).trim().toLowerCase()}%`);
      const idx = `$${params.length}`;
      whereClauses.push(`(LOWER(n.vicinity) LIKE ${idx} OR LOWER(n.area) LIKE ${idx} OR LOWER(n.summary) LIKE ${idx} OR LOWER(m.message) LIKE ${idx})`);
    }

    if (filters.propertyType && String(filters.propertyType).trim() !== '') {
      params.push(`%${String(filters.propertyType).trim().toLowerCase()}%`);
      const idx = `$${params.length}`;
      whereClauses.push(`(LOWER(n.property_type) LIKE ${idx} OR LOWER(n.summary) LIKE ${idx} OR LOWER(m.message) LIKE ${idx})`);
    }

    if (filters.propertySubType && String(filters.propertySubType).trim() !== '') {
      params.push(`%${String(filters.propertySubType).trim().toLowerCase()}%`);
      const idx = `$${params.length}`;
      whereClauses.push(`(LOWER(n.property_type) LIKE ${idx} OR LOWER(n.summary) LIKE ${idx} OR LOWER(m.message) LIKE ${idx})`);
    }

    if (whereClauses.length > 0) {
      queryText += ' AND ' + whereClauses.join(' AND ');
    }

    queryText += ' ORDER BY n.id DESC';

    const dbResult = await db.query(queryText, params);
    const properties = filterAndSortProperties(dbResult.rows, filters);

    return sendResponse(res, 200, false, {
      total: properties.length,
      filters: filters,
      properties: properties
    }, 'Properties retrieved successfully');
  } catch (err) {
    console.error('Property filter error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
};

app.post('/api/properties/filter', handlePropertyFilter);
app.get('/api/properties/filter', handlePropertyFilter);
app.post('/api/properties', handlePropertyFilter);
app.get('/api/properties', handlePropertyFilter);

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

// Root Route
app.get('/', (req, res) => {
  return sendResponse(res, 200, false, { service: 'whatsapp-scraper-backend' }, 'API service running');
});

// Start Server (await DB migration so monitored_at exists before traffic)
(async () => {
  try {
    await db.initializeDb();
  } catch (err) {
    console.error('Database init failed on startup:', err.message);
  }
  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
})();
