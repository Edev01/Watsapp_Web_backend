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
const { findOrCreateCanonicalChat, cleanText, isSystemNotificationText } = require('./contactHelper');

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

// Broadcast QR events to the user's room + legacy global listeners
function emitNewQr(userId, payload) {
  const data = { ...payload, userId: Number(userId) || 1 };
  io.to(`user_${data.userId}`).emit('new_qr', data);
  io.to(`user_${data.userId}`).emit('qr_updated', data);
  // Keep global emit for older frontends, but always include userId for filtering
  io.emit('new_qr', data);
  io.emit('qr_updated', data);
}

function emitQrDisappeared(userId, payload = {}) {
  const data = {
    status: 'disappeared',
    message: 'WhatsApp opened / QR disappeared',
    timestamp: new Date().toISOString(),
    ...payload,
    userId: Number(userId) || 1
  };
  io.to(`user_${data.userId}`).emit('qr_disappeared', data);
  io.to(`user_${data.userId}`).emit('qr_cleared', data);
  io.emit('qr_disappeared', data);
  io.emit('qr_cleared', data);
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

async function claimLinkSession(userId) {
  const id = parseInt(userId, 10);
  if (!id || Number.isNaN(id)) return null;

  const userCheck = await db.query('SELECT id, email, name, role FROM users WHERE id = $1', [id]);
  if (userCheck.rows.length === 0) return null;

  // Single-operator WhatsApp: release other waiting claims so the current portal user owns the QR
  await db.query(
    `UPDATE whatsapp_link_sessions SET status = 'released', updated_at = NOW()
     WHERE status = 'waiting' AND user_id <> $1`,
    [id]
  );
  await db.query(
    `UPDATE whatsapp_link_sessions SET status = 'released', updated_at = NOW()
     WHERE user_id = $1 AND status IN ('waiting', 'linked')`,
    [id]
  );

  const inserted = await db.query(
    `INSERT INTO whatsapp_link_sessions (user_id, status)
     VALUES ($1, 'waiting')
     RETURNING id, user_id, status, created_at, updated_at`,
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
 * Auto mode: portal claim / waiting session wins over leftover extension defaults (userId=1).
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
  const session = await getActiveLinkSession();

  if (forceExplicit && explicit) return explicit;

  // Portal claim is source of truth for laptop auto-mapping
  if (session?.user_id) {
    const sid = parseInt(session.user_id, 10);
    // Ignore stale extension default "1" when a real client claimed
    if (!explicit || explicit === 1 || explicit === sid) return sid;
    // Real non-default explicit (e.g. worker) wins
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
          io.to(roomName).emit('link_session_claimed', session);
          console.log(`Auto-claimed link session for user_${userId}`);
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

// Initialize database
db.initializeDb();

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

// 5b. Post QR Status / Cleared (HTTP Fallback for Extension)
app.post('/api/qr/status', async (req, res) => {
  const userId = (await resolveQrUserId(req)) || 1;
  const payload = {
    status: req.body.status || 'disappeared',
    message: req.body.message || 'WhatsApp logged in / QR code cleared',
    timestamp: new Date().toISOString(),
    userId
  };

  try {
    await db.query(
      `UPDATE whatsapp_link_sessions
       SET status = 'linked', updated_at = NOW()
       WHERE user_id = $1 AND status IN ('waiting', 'linked')`,
      [userId]
    );
  } catch (err) {
    console.error('Failed to mark link session linked:', err.message);
  }

  emitQrDisappeared(userId, payload);

  return sendResponse(res, 200, false, payload, 'QR cleared status emitted successfully');
});

// 6. Get Latest QR URL
app.get('/api/qr/latest', async (req, res) => {
  const userId = req.userId || req.query.userId || req.query.user_id || null;

  // Auto-claim when portal fetches QR for a logged-in client
  if (userId) {
    try {
      await claimLinkSession(userId);
    } catch (err) {
      console.error('Auto-claim on latest QR failed:', err.message);
    }
  }

  const resolvedUserId = userId || (await resolveQrUserId(req)) || 1;
  try {
    const result = await db.query(
      'SELECT id, url, source, page_url, user_id, created_at FROM qr_codes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [resolvedUserId]
    );

    if (result.rows.length === 0) {
      return sendResponse(res, 404, true, null, 'No QR URL found');
    }

    return sendResponse(res, 200, false, result.rows[0], 'Latest QR URL retrieved successfully');
  } catch (err) {
    console.error('Get latest QR error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 7. Post Scraped Contacts List (Deduplicated by name & JID with canonical matching)
app.post('/api/scraped-chats/contacts', async (req, res) => {
  const { contacts } = req.body;
  const userId = req.userId || req.body.userId || req.body.user_id || 1;
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
         (SELECT timestamp FROM whatsapp_messages m WHERE m.user_id = c.user_id AND m.chat_jid = c.jid ORDER BY m.id DESC LIMIT 1) as last_scraped_timestamp
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
  const userId = req.userId || req.body.userId || req.body.user_id || 1;
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

    for (const msg of messages) {
      const sender = (msg.sender ?? '').toString().trim();
      const timestamp = (msg.timestamp ?? '').toString().trim();
      const messageText = (msg.message ?? msg.text ?? '').toString();
      const isFromMe = msg.fromMe ?? msg.from_me ?? false;

      if (!timestamp && !messageText) {
        skippedCount++;
        continue;
      }

      try {
        const result = await db.query(
          `INSERT INTO whatsapp_messages (user_id, chat_jid, sender, timestamp, message, from_me) 
           VALUES ($1, $2, $3, $4, $5, $6) 
           ON CONFLICT (user_id, chat_jid, sender, timestamp, message) DO NOTHING
           RETURNING id`,
          [userId, canonicalJid, sender || 'unknown', timestamp || 'unknown', messageText, isFromMe]
        );
        if (result.rowCount > 0) {
          addedCount++;
        } else {
          skippedCount++; // duplicate already in DB
        }
      } catch (insertErr) {
        skippedCount++;
        insertErrors.push(insertErr.message);
        console.error('Message insert error:', insertErr.message);
      }
    }

    // Notify frontend that this user's chat was updated
    io.to(`user_${userId}`).emit('messages_updated', {
      userId,
      chatJid: canonicalJid,
      chatName: resolvedChatName,
      addedCount,
      skippedCount
    });

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
  const { jids } = req.body;
  const userId = req.userId || req.body.userId || req.body.user_id || 1;
  if (!Array.isArray(jids)) {
    return sendResponse(res, 400, true, null, 'jids array is required');
  }
  try {
    // Reset user's chats to FALSE first
    await db.query('UPDATE whatsapp_chats SET is_monitored = FALSE WHERE user_id = $1', [userId]);
    if (jids.length > 0) {
      // Set is_monitored to TRUE for selected JIDs belonging to user
      await db.query(
        'UPDATE whatsapp_chats SET is_monitored = TRUE WHERE user_id = $1 AND jid = ANY($2)',
        [userId, jids]
      );
    }
    return sendResponse(res, 200, false, null, 'Monitored status updated successfully');
  } catch (err) {
    console.error('Update monitored error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 11. Get All Chats (both monitored and unmonitored for user)
app.get('/api/scraped-chats', async (req, res) => {
  const userId = req.userId || req.query.userId || req.query.user_id || 1;
  try {
    const result = await db.query(
      'SELECT jid, name, avatar, is_monitored, user_id, created_at FROM whatsapp_chats WHERE user_id = $1 ORDER BY name ASC',
      [userId]
    );
    return sendResponse(res, 200, false, result.rows, 'All chats retrieved successfully');
  } catch (err) {
    console.error('Get all chats error:', err);
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

// Root Route
app.get('/', (req, res) => {
  return sendResponse(res, 200, false, { service: 'whatsapp-scraper-backend' }, 'API service running');
});

// Start Server
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
