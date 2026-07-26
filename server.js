const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const db = require('./db');
const { sendResponse } = require('./responseHelper');
const { authenticateToken, isAdmin } = require('./middleware');

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

// Socket.IO real-time event handling
io.on('connection', (socket) => {
  console.log('Client connected to Socket.IO:', socket.id);

  // 1. Extension emits 'new_qr' -> Backend broadcasts 'new_qr' to Web Portal
  socket.on('new_qr', async (data) => {
    console.log('Socket event new_qr received:', data);
    try {
      if (data && data.url) {
        await db.query(
          'INSERT INTO qr_codes (url, source, page_url) VALUES ($1, $2, $3)',
          [data.url, data.source || 'whatsapp', data.pageUrl || null]
        );
      }
    } catch (err) {
      console.error('Error saving socket new_qr to DB:', err.message);
    }
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

  if (!url) {
    return sendResponse(res, 400, true, null, 'URL is required');
  }

  try {
    const result = await db.query(
      'INSERT INTO qr_codes (url, source, page_url) VALUES ($1, $2, $3) RETURNING id, url, source, page_url, created_at',
      [url, source || 'whatsapp', pageUrl || null]
    );

    const qrData = result.rows[0];
    // Broadcast real-time socket event to all web clients
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
  try {
    const result = await db.query(
      'SELECT id, url, source, page_url, created_at FROM qr_codes ORDER BY created_at DESC LIMIT 1'
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

// 7. Post Scraped Contacts List (Deduplicated by name & JID)
app.post('/api/scraped-chats/contacts', async (req, res) => {
  const { contacts } = req.body;
  if (!Array.isArray(contacts)) {
    return sendResponse(res, 400, true, null, 'Contacts array is required');
  }
  try {
    for (const contact of contacts) {
      const cleanName = (contact.name || '').trim();
      if (!cleanName) continue;

      // Check if contact already exists by JID or name
      const existing = await db.query(
        `SELECT id, jid, name FROM whatsapp_chats 
         WHERE jid = $1 OR LOWER(TRIM(name)) = LOWER(TRIM($2)) LIMIT 1`,
        [contact.id, cleanName]
      );

      if (existing.rows.length > 0) {
        const existingRow = existing.rows[0];
        const oldJid = existingRow.jid;
        const newJid = contact.id;

        // If old JID was a fallback (e.g. name@c.us) and new JID is a phone number (@c.us with digits), update JID in chats & messages
        if (oldJid !== newJid && /^\d+@c\.us$/.test(newJid)) {
          await db.query(`UPDATE whatsapp_chats SET jid = $1, avatar = COALESCE($2, avatar) WHERE id = $3`, [newJid, contact.avatar || null, existingRow.id]);
          await db.query(`UPDATE whatsapp_messages SET chat_jid = $1 WHERE chat_jid = $2`, [newJid, oldJid]);
        } else {
          await db.query(`UPDATE whatsapp_chats SET avatar = COALESCE($1, avatar) WHERE id = $2`, [contact.avatar || null, existingRow.id]);
        }
      } else {
        await db.query(
          `INSERT INTO whatsapp_chats (jid, name, avatar) VALUES ($1, $2, $3)`,
          [contact.id, cleanName, contact.avatar || null]
        );
      }
    }
    return sendResponse(res, 200, false, null, 'Contacts updated successfully');
  } catch (err) {
    console.error('Contacts update error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 8. Get Monitored Chats list (Includes last_scraped_timestamp for incremental sync)
app.get('/api/scraped-chats/monitored', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.jid, c.name, c.avatar, c.is_monitored, c.created_at,
         (SELECT timestamp FROM whatsapp_messages m WHERE m.chat_jid = c.jid ORDER BY m.id DESC LIMIT 1) as last_scraped_timestamp
       FROM whatsapp_chats c 
       WHERE c.is_monitored = TRUE 
       ORDER BY c.name ASC`
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
  if ((!chatId && !chatName) || !Array.isArray(messages)) {
    return sendResponse(res, 400, true, null, 'chatId or chatName and messages array are required');
  }
  try {
    // Resolve canonical JID from database
    let targetJid = chatId;
    if (chatName || chatId) {
      const match = await db.query(
        `SELECT jid FROM whatsapp_chats 
         WHERE jid = $1 OR LOWER(TRIM(name)) = LOWER(TRIM($2)) LIMIT 1`,
        [chatId || '', (chatName || '').trim()]
      );
      if (match.rows.length > 0) {
        targetJid = match.rows[0].jid;
      }
    }

    let addedCount = 0;
    for (const msg of messages) {
      try {
        await db.query(
          `INSERT INTO whatsapp_messages (chat_jid, sender, timestamp, message) 
           VALUES ($1, $2, $3, $4) 
           ON CONFLICT (chat_jid, sender, timestamp, message) DO NOTHING`,
          [targetJid, msg.sender, msg.timestamp, msg.message]
        );
        addedCount++;
      } catch (insertErr) {
        // Handled unique constraint conflicts gracefully
      }
    }
    return sendResponse(res, 201, false, { addedCount, targetJid }, 'Messages saved successfully');
  } catch (err) {
    console.error('Post messages error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 10. Toggle Monitored Status for Chats
app.post('/api/scraped-chats/monitor', async (req, res) => {
  const { jids } = req.body;
  if (!Array.isArray(jids)) {
    return sendResponse(res, 400, true, null, 'jids array is required');
  }
  try {
    // Reset all to FALSE first
    await db.query('UPDATE whatsapp_chats SET is_monitored = FALSE');
    if (jids.length > 0) {
      // Set is_monitored to TRUE for selected JIDs
      await db.query(
        'UPDATE whatsapp_chats SET is_monitored = TRUE WHERE jid = ANY($1)',
        [jids]
      );
    }
    return sendResponse(res, 200, false, null, 'Monitored status updated successfully');
  } catch (err) {
    console.error('Update monitored error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 11. Get All Chats (both monitored and unmonitored)
app.get('/api/scraped-chats', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT jid, name, avatar, is_monitored, created_at FROM whatsapp_chats ORDER BY name ASC'
    );
    return sendResponse(res, 200, false, result.rows, 'All chats retrieved successfully');
  } catch (err) {
    console.error('Get all chats error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 12. Get Messages for a Specific Chat
app.get('/api/scraped-chats/messages', async (req, res) => {
  const { chatId } = req.query;
  if (!chatId) {
    return sendResponse(res, 400, true, null, 'chatId query parameter is required');
  }
  try {
    const result = await db.query(
      'SELECT id, chat_jid, sender, timestamp, message, created_at FROM whatsapp_messages WHERE chat_jid = $1 ORDER BY timestamp ASC',
      [chatId]
    );
    return sendResponse(res, 200, false, result.rows, 'Messages retrieved successfully');
  } catch (err) {
    console.error('Get messages error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
});

// 13. ML Dataset Endpoint (Fetch all scraped realtor messages with chat names & pagination)
app.get('/api/ml/dataset', async (req, res) => {
  const { limit = 1000, offset = 0, chatId } = req.query;
  try {
    let queryText = `
      SELECT m.id, m.chat_jid, c.name as chat_name, m.sender, m.timestamp, m.message, m.created_at
      FROM whatsapp_messages m
      LEFT JOIN whatsapp_chats c ON m.chat_jid = c.jid
    `;
    const params = [];

    if (chatId) {
      params.push(chatId);
      queryText += ` WHERE m.chat_jid = $${params.length}`;
    }

    params.push(parseInt(limit, 10));
    queryText += ` ORDER BY m.id ASC LIMIT $${params.length}`;

    params.push(parseInt(offset, 10));
    queryText += ` OFFSET $${params.length}`;

    const result = await db.query(queryText, params);

    let countQuery = 'SELECT COUNT(*) FROM whatsapp_messages';
    const countParams = [];
    if (chatId) {
      countParams.push(chatId);
      countQuery += ' WHERE chat_jid = $1';
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

// Root Route
app.get('/', (req, res) => {
  return sendResponse(res, 200, false, { service: 'whatsapp-scraper-backend' }, 'API service running');
});

// Start Server
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
