const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const db = require('./db');
const { sendResponse } = require('./responseHelper');
const { authenticateToken, isAdmin } = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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

    return sendResponse(res, 201, false, result.rows[0], 'QR URL saved successfully');
  } catch (err) {
    console.error('Post QR error:', err);
    return sendResponse(res, 500, true, null, err.message || 'Server error');
  }
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

// Root Route
app.get('/', (req, res) => {
  return sendResponse(res, 200, false, { service: 'whatsapp-scraper-backend' }, 'API service running');
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
