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

// Socket.IO real-time event handling
io.on('connection', (socket) => {
  console.log('Client connected to Socket.IO:', socket.id);

  socket.on('join_user_room', (data) => {
    if (data && (data.userId || data.user_id)) {
      const roomName = `user_${data.userId || data.user_id}`;
      socket.join(roomName);
      console.log(`Socket ${socket.id} joined user room: ${roomName}`);
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
    data.userId = userId;
    io.to(`user_${userId}`).emit('new_qr', data);
    io.emit('new_qr', data);
  });

  // 2. Extension emits 'qr_disappeared' -> Backend broadcasts 'qr_disappeared' to Web Portal
  socket.on('qr_disappeared', (data) => {
    console.log('Socket event qr_disappeared received:', data);
    io.emit('qr_disappeared', data || { status: 'disappeared', message: 'WhatsApp opened / QR disappeared' });
  });

  // Legacy support fallback
  socket.on('qr_updated', (data) => io.emit('new_qr', data));
  socket.on('qr_cleared', (data) => io.emit('qr_disappeared', data));

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
  const userId = req.userId || req.body.userId || req.body.user_id || 1;

  if (!url) {
    return sendResponse(res, 400, true, null, 'URL is required');
  }

  try {
    const result = await db.query(
      'INSERT INTO qr_codes (url, source, page_url, user_id) VALUES ($1, $2, $3, $4) RETURNING id, url, source, page_url, user_id, created_at',
      [url, source || 'whatsapp', pageUrl || null, userId]
    );

    const qrData = result.rows[0];
    io.to(`user_${userId}`).emit('qr_updated', qrData);
    io.emit('qr_updated', qrData);

    return sendResponse(res, 201, false, qrData, 'QR URL saved successfully');
  } catch (err) {
    console.error('Post QR error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 5b. Post QR Status / Cleared (HTTP Fallback for Extension)
app.post('/api/qr/status', async (req, res) => {
  const { status, message } = req.body;
  const payload = {
    status: status || 'scanned',
    message: message || 'WhatsApp logged in / QR code cleared',
    timestamp: new Date()
  };

  // Broadcast real-time socket event to all web clients
  io.emit('qr_cleared', payload);

  return sendResponse(res, 200, false, payload, 'QR cleared status emitted successfully');
});

// 6. Get Latest QR URL
app.get('/api/qr/latest', async (req, res) => {
  const userId = req.userId || req.query.userId || req.query.user_id || 1;
  try {
    const result = await db.query(
      'SELECT id, url, source, page_url, user_id, created_at FROM qr_codes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId]
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
  const { chatId, chatName, messages } = req.body;
  const userId = req.userId || req.body.userId || req.body.user_id || 1;
  if ((!chatId && !chatName) || !Array.isArray(messages)) {
    return sendResponse(res, 400, true, null, 'chatId or chatName and messages array are required');
  }
  try {
    // Resolve canonical JID from database for this user
    const canonicalJid = await findOrCreateCanonicalChat(userId, chatId, chatName);
    if (!canonicalJid) {
      return sendResponse(res, 200, false, { addedCount: 0 }, 'Ignored system notification message payload');
    }

    let addedCount = 0;
    for (const msg of messages) {
      const isFromMe = msg.fromMe ?? msg.from_me ?? false;
      try {
        await db.query(
          `INSERT INTO whatsapp_messages (user_id, chat_jid, sender, timestamp, message, from_me) 
           VALUES ($1, $2, $3, $4, $5, $6) 
           ON CONFLICT (user_id, chat_jid, sender, timestamp, message) DO UPDATE SET from_me = EXCLUDED.from_me`,
          [userId, canonicalJid, msg.sender, msg.timestamp, msg.message, isFromMe]
        );
        addedCount++;
      } catch (insertErr) {
        // Handled unique constraint conflicts gracefully
      }
    }
    return sendResponse(res, 201, false, { addedCount, targetJid: canonicalJid, userId }, 'Messages saved successfully');
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
app.get('/api/scraped-chats/messages', async (req, res) => {
  const userId = req.userId || req.query.userId || req.query.user_id || 1;
  const { chatId, jid, name } = req.query;
  const targetId = chatId || jid;

  if (!targetId && !name) {
    return sendResponse(res, 400, true, null, 'chatId, jid, or name query parameter is required');
  }

  try {
    let result;
    if (targetId) {
      result = await db.query(
        `SELECT m.id, m.chat_jid, c.name as chat_name, m.sender, m.timestamp, m.message, m.from_me, m.from_me as "fromMe", m.user_id, m.created_at 
         FROM whatsapp_messages m
         LEFT JOIN whatsapp_chats c ON m.chat_jid = c.jid AND m.user_id = c.user_id
         WHERE m.user_id = $1 AND (m.chat_jid = $2 OR LOWER(c.name) LIKE LOWER($3))
         ORDER BY m.id ASC`,
        [userId, targetId, `%${targetId}%`]
      );
    } else {
      result = await db.query(
        `SELECT m.id, m.chat_jid, c.name as chat_name, m.sender, m.timestamp, m.message, m.from_me, m.from_me as "fromMe", m.user_id, m.created_at 
         FROM whatsapp_messages m
         LEFT JOIN whatsapp_chats c ON m.chat_jid = c.jid AND m.user_id = c.user_id
         WHERE m.user_id = $1 AND LOWER(c.name) LIKE LOWER($2)
         ORDER BY m.id ASC`,
        [userId, `%${name}%`]
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
