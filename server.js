// server.js - Hardened Enterprise Backend for Goverdhan Energy & Petrochemicals Quote Desk
// Dual Persistence (In-Memory Cache + Neon PostgreSQL), Server-Side Auth, Atomic Sequences & Real-Time SSE
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const IS_PROD = process.env.NODE_ENV === 'production';

// =========================================================================
// 1. SECURITY HEADERS & REQUEST LIMITS (S-10, S-11, S-15, S-16)
// =========================================================================
app.disable('x-powered-by');

// Strict Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',A
    "default-src 'self' 'unsafe-inline' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self' https:;"
  );
  next();
});

// CORS Configuration - Restricted in production (S-01)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin) || !IS_PROD) {
      return callback(null, true);
    }
    callback(new Error('CORS origin denied'));
  },
  credentials: true
}));

// Body parsing with safe size limit of 5MB (S-10)
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Safe body fallback middleware (S-16)
app.use((req, res, next) => {
  req.body = req.body || {};
  next();
});

// Cache control: Strict no-store on all API endpoints
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// =========================================================================
// 2. STATIC ASSETS - SERVE ONLY FROM public/ (S-03)
// =========================================================================
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Serve root index.html from public/ with strict no-cache headers
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const file = path.join(publicDir, 'index.html');
  if (fs.existsSync(file)) {
    return res.sendFile(file);
  }
  res.status(404).send('Application index.html not found in public directory.');
});

// Serve static assets from public/ ONLY (never serves project root, server.js, or .env)
app.use(express.static(publicDir, {
  etag: false,
  lastModified: false,
  maxAge: 0,
  dotfiles: 'ignore'
}));

// =========================================================================
// 3. DATABASE CONNECTION POOL & HYDRATION (S-04, S-06, S-09, S-14)
// =========================================================================
let pool = null;
let dbReady = false;

if (process.env.DATABASE_URL) {
  const isLocalHost = process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocalHost ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 10
  });

  pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL client pool error:', err.message);
  });
}

// Authoritative In-Memory Cache (backed by PostgreSQL)
const memoryKv = new Map();
let latestKvRev = Date.now();

// Allowed Master Keys Whitelist (S-10, S-11)
const ALLOWED_KV_KEYS = new Set([
  'catalog',
  'routes',
  'transporters',
  'settings',
  'template',
  'cycles',
  'brand_settings',
  'mlMappings'
]);

// Real-Time Server-Sent Events (SSE) Client Registry (S-12)
const sseClients = new Set();

function broadcastSyncEvent(payload, senderSessionId = null) {
  const dataStr = `data: ${JSON.stringify({ type: 'sync', ts: Date.now(), ...payload })}\n\n`;
  for (const client of sseClients) {
    if (senderSessionId && client.sessionId === senderSessionId) {
      continue; // Skip sender to avoid redundant refetches (S-12)
    }
    try {
      client.res.write(dataStr);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Cryptographic Password Hashing (S-02, H-13)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!password || !storedHash) return false;
  try {
    if (storedHash.startsWith('scrypt:')) {
      const parts = storedHash.split(':');
      if (parts.length !== 3) return false;
      const salt = parts[1];
      const originalHash = parts[2];
      const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
      return crypto.timingSafeEqual(Buffer.from(testHash, 'hex'), Buffer.from(originalHash, 'hex'));
    }
    // Backward compatibility for bcrypt hashes if any exist
    try {
      const bcrypt = require('bcryptjs');
      return bcrypt.compareSync(password, storedHash);
    } catch (e) {
      return false;
    }
  } catch (e) {
    return false;
  }
}

// Database Initialization and Schema Verification (S-06)
async function initDatabase() {
  if (!pool) {
    console.warn('DATABASE_URL not set; running in ephemeral memory mode.');
    dbReady = true;
    seedInitialAdminInMemory();
    return;
  }

  try {
    const client = await pool.connect();
    try {
      // 1. Ensure required tables exist
      await client.query(`
        CREATE TABLE IF NOT EXISTS app_kv_store (
          key VARCHAR(64) PRIMARY KEY,
          value JSONB NOT NULL,
          version INT NOT NULL DEFAULT 1,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_by VARCHAR(128)
        );

        CREATE TABLE IF NOT EXISTS app_users (
          id VARCHAR(64) PRIMARY KEY,
          email VARCHAR(128) UNIQUE NOT NULL,
          username VARCHAR(64) UNIQUE,
          password_hash VARCHAR(255) NOT NULL,
          name VARCHAR(128) NOT NULL,
          role VARCHAR(32) NOT NULL DEFAULT 'user',
          can_edit_master BOOLEAN DEFAULT FALSE,
          can_quote BOOLEAN DEFAULT TRUE,
          active BOOLEAN DEFAULT TRUE,
          status VARCHAR(32) DEFAULT 'pending',
          request_note TEXT,
          reset_requested BOOLEAN DEFAULT FALSE,
          reset_token VARCHAR(128),
          reset_expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS app_sessions (
          token VARCHAR(128) PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS app_quotes (
          id VARCHAR(64) PRIMARY KEY,
          quote_number VARCHAR(64) UNIQUE NOT NULL,
          financial_year VARCHAR(16) NOT NULL,
          seq_num INT NOT NULL,
          customer_name VARCHAR(255) NOT NULL,
          customer_address TEXT,
          customer_phone VARCHAR(64),
          product_id VARCHAR(64) NOT NULL,
          product_name VARCHAR(128) NOT NULL,
          delivery_location VARCHAR(128) NOT NULL,
          refinery_id VARCHAR(64),
          refinery_name VARCHAR(128),
          transporter_id VARCHAR(64),
          transporter_name VARCHAR(128),
          quantity DECIMAL(12, 2) NOT NULL,
          unit VARCHAR(16) NOT NULL,
          basic_price DECIMAL(12, 2) NOT NULL,
          discount DECIMAL(12, 2) DEFAULT 0,
          transport_rate DECIMAL(12, 2) DEFAULT 0,
          credit_cost DECIMAL(12, 2) DEFAULT 0,
          margin DECIMAL(12, 2) DEFAULT 0,
          selling_price DECIMAL(12, 2) NOT NULL,
          selling_price_gst DECIMAL(12, 2) NOT NULL,
          order_value DECIMAL(14, 2) NOT NULL,
          quote_data JSONB NOT NULL,
          created_by_user_id VARCHAR(64),
          created_by_email VARCHAR(128),
          created_by_name VARCHAR(128),
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS app_quote_logs (
          id VARCHAR(64) PRIMARY KEY,
          action_type VARCHAR(64) NOT NULL,
          action_desc TEXT NOT NULL,
          quote_id VARCHAR(64),
          quote_number VARCHAR(64),
          customer VARCHAR(255),
          location VARCHAR(128),
          product VARCHAR(128),
          qty VARCHAR(64),
          unit VARCHAR(16),
          refinery VARCHAR(128),
          rate DECIMAL(12, 2),
          rate_gst DECIMAL(12, 2),
          margin DECIMAL(12, 2),
          order_total DECIMAL(14, 2),
          user_id VARCHAR(64),
          user_email VARCHAR(128),
          user_name VARCHAR(128),
          user_role VARCHAR(32),
          ip_address VARCHAR(64),
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS app_quote_sequences (
          financial_year VARCHAR(16) PRIMARY KEY,
          last_seq INT NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 2. Hydrate in-memory KV cache from PostgreSQL
      const kvRes = await client.query('SELECT key, value, version FROM app_kv_store');
      kvRes.rows.forEach(r => {
        memoryKv.set(r.key, { value: r.value, version: r.version });
      });

      // 3. Ensure Master Admin account exists securely (H-02)
      const adminCountRes = await client.query("SELECT COUNT(*) FROM app_users WHERE role = 'admin'");
      if (parseInt(adminCountRes.rows[0].count, 10) === 0) {
        const adminEmail = (process.env.ADMIN_EMAIL || 'dmegepl@gmail.com').toLowerCase().trim();
        const adminPass = process.env.ADMIN_PASSWORD || 'ChangeMeNow2026!';
        const adminName = process.env.ADMIN_NAME || 'Mohsin Khan';
        const pHash = hashPassword(adminPass);
        await client.query(
          `INSERT INTO app_users (id, email, username, password_hash, name, role, can_edit_master, can_quote, active, status)
           VALUES ('u_admin_master', $1, 'dmegepl', $2, $3, 'admin', TRUE, TRUE, TRUE, 'approved')
           ON CONFLICT (email) DO NOTHING`,
          [adminEmail, pHash, adminName]
        );
        console.log(`[AUTH] Seeded initial admin account: ${adminEmail}`);
      }

      dbReady = true;
      console.log(`[DB] Neon PostgreSQL connected & hydrated. KV Keys loaded: ${memoryKv.size}`);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[DB] Critical error initializing database:', err.message);
    // Don't mark dbReady = true on failure so requests receive 503 instead of serving empty state (S-06)
  }
}

// In-Memory Fallback Seed if DATABASE_URL is unset
function seedInitialAdminInMemory() {
  if (!memoryKv.has('_in_memory_users')) {
    const pHash = hashPassword(process.env.ADMIN_PASSWORD || 'ChangeMeNow2026!');
    const users = [{
      id: 'u_admin_master',
      email: (process.env.ADMIN_EMAIL || 'dmegepl@gmail.com').toLowerCase().trim(),
      username: 'dmegepl',
      password_hash: pHash,
      name: process.env.ADMIN_NAME || 'Mohsin Khan',
      role: 'admin',
      can_edit_master: true,
      can_quote: true,
      active: true,
      status: 'approved',
      created_at: new Date().toISOString()
    }];
    memoryKv.set('_in_memory_users', { value: users, version: 1 });
  }
}

// Database Readiness Guard Middleware (S-06)
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (!dbReady) {
    return res.status(503).json({ error: 'Service temporarily unavailable: database is hydrating. Please retry in a few seconds.' });
  }
  next();
});

// =========================================================================
// 4. RATE LIMITING & AUTHENTICATION MIDDLEWARE (S-01, S-08)
// =========================================================================

// Rate limiter for authentication attempts (max 12 attempts per minute per IP)
const authAttempts = new Map();
function rateLimitAuth(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const record = authAttempts.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + 60000;
  }
  record.count++;
  authAttempts.set(ip, record);
  if (record.count > 12) {
    return res.status(429).json({ error: 'Too many authentication attempts. Please wait 1 minute before trying again.' });
  }
  next();
}

// Clean up stale rate limit entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of authAttempts.entries()) {
    if (now > rec.resetAt) authAttempts.delete(ip);
  }
}, 600000);

// Extract session token from Authorization Header or Cookie
function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').map(c => c.trim());
    for (const c of cookies) {
      if (c.startsWith('rc_session=')) {
        return decodeURIComponent(c.substring(11));
      }
    }
  }
  return null;
}

// Authentication Middleware: Validates session and attaches req.user (S-01)
async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }

  try {
    if (pool) {
      const q = `
        SELECT u.id, u.email, u.username, u.name, u.role, u.can_edit_master, u.can_quote, u.active, u.status, s.token
        FROM app_sessions s
        JOIN app_users u ON s.user_id = u.id
        WHERE s.token = $1 AND s.expires_at > CURRENT_TIMESTAMP
      `;
      const result = await pool.query(q, [token]);
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
      }
      const user = result.rows[0];
      if (!user.active || user.status !== 'approved') {
        return res.status(403).json({ error: 'Account access has been deactivated or is awaiting admin approval.' });
      }
      req.user = user;
      req.sessionId = token;
      return next();
    } else {
      // Ephemeral fallback
      const users = memoryKv.get('_in_memory_users')?.value || [];
      const user = users.find(u => u.active && u.status === 'approved');
      if (user) {
        req.user = user;
        req.sessionId = token;
        return next();
      }
      return res.status(401).json({ error: 'Authentication required.' });
    }
  } catch (err) {
    console.error('requireAuth error:', err.message);
    res.status(500).json({ error: 'Internal authentication error.' });
  }
}

// Role Authorization Helpers (S-01)
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied: Admin privileges required.' });
  }
  next();
}

function requireMasterEdit(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && !req.user.can_edit_master)) {
    return res.status(403).json({ error: 'Access denied: Master edit permission required.' });
  }
  next();
}

// =========================================================================
// 5. AUTHENTICATION & USER MANAGEMENT ROUTES (S-01, S-02, S-08, H-03, H-13)
// =========================================================================

// Health check (S-15)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'RefineCalc Quote Desk',
    dbReady,
    timestamp: new Date().toISOString()
  });
});

// Real-Time Server-Sent Events (SSE) Stream - Requires Auth (S-12)
app.get('/api/events', async (req, res) => {
  const token = req.query.token || extractToken(req);
  if (!token) {
    return res.status(401).send('Unauthorized SSE connection');
  }

  let authorized = false;
  let userId = null;
  if (pool) {
    try {
      const q = 'SELECT user_id FROM app_sessions WHERE token = $1 AND expires_at > CURRENT_TIMESTAMP';
      const r = await pool.query(q, [token]);
      if (r.rows.length > 0) {
        authorized = true;
        userId = r.rows[0].user_id;
      }
    } catch (e) {}
  } else {
    authorized = true;
    userId = 'local_user';
  }

  if (!authorized) {
    return res.status(401).send('Invalid SSE session');
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const clientObj = { res, sessionId: token, userId };
  sseClients.add(clientObj);

  res.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now(), rev: latestKvRev })}\n\n`);

  const keepAlive = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch (e) { clearInterval(keepAlive); sseClients.delete(clientObj); }
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(clientObj);
  });
});

// Login Endpoint (S-08)
app.post('/api/auth/login', rateLimitAuth, async (req, res) => {
  const username = String(req.body.username || req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!username || !password) {
    return res.status(400).json({ error: 'Username/Gmail and password are required.' });
  }

  try {
    let user = null;
    if (pool) {
      const q = `
        SELECT id, email, username, password_hash, name, role, can_edit_master, can_quote, active, status
        FROM app_users
        WHERE LOWER(email) = $1 OR LOWER(username) = $1
      `;
      const result = await pool.query(q, [username]);
      user = result.rows[0];
    } else {
      const users = memoryKv.get('_in_memory_users')?.value || [];
      user = users.find(u => u.email.toLowerCase() === username || (u.username && u.username.toLowerCase() === username));
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (user.status === 'pending') {
      return res.status(403).json({ error: 'Your sign-up request is pending Admin approval. Please contact your administrator.' });
    }

    if (!user.active || user.status === 'rejected') {
      return res.status(403).json({ error: 'This account has been deactivated. Please contact your administrator.' });
    }

    const passwordValid = verifyPassword(password, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Generate 256-bit cryptographically secure session token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    if (pool) {
      await pool.query(
        'INSERT INTO app_sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
        [token, user.id, expiresAt]
      );
    }

    // Set secure HTTP-only cookie
    res.cookie('rc_session', token, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    const safeUser = {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      role: user.role,
      can_edit_master: user.can_edit_master,
      can_quote: user.can_quote,
      status: user.status
    };

    res.json({ success: true, token, user: safeUser });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Authentication service error.' });
  }
});

// Self Profile Check
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      username: req.user.username,
      name: req.user.name,
      role: req.user.role,
      can_edit_master: req.user.can_edit_master,
      can_quote: req.user.can_quote,
      status: req.user.status
    }
  });
});

// Logout Endpoint
app.post('/api/auth/logout', async (req, res) => {
  const token = extractToken(req);
  if (token && pool) {
    try {
      await pool.query('DELETE FROM app_sessions WHERE token = $1', [token]);
    } catch (e) {}
  }
  res.clearCookie('rc_session');
  res.json({ success: true });
});

// Sign-Up / Access Request Endpoint (S-08, H-01)
app.post('/api/auth/signup', rateLimitAuth, async (req, res) => {
  const fullName = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '').trim();
  const note = String(req.body.note || '').trim();

  if (!fullName || !email.includes('@') || password.length < 6) {
    return res.status(400).json({ error: 'Full name, valid email, and password of at least 6 characters are required.' });
  }

  try {
    const pHash = hashPassword(password);
    const userId = 'u_' + crypto.randomBytes(8).toString('hex');
    const username = email.split('@')[0];

    if (pool) {
      const existing = await pool.query('SELECT id, status, active FROM app_users WHERE LOWER(email) = $1', [email]);
      if (existing.rows.length > 0) {
        const ext = existing.rows[0];
        if (ext.status === 'pending') {
          return res.status(400).json({ error: 'An access request for this Gmail is already pending Admin approval.' });
        }
        if (ext.status === 'rejected' || !ext.active) {
          // Re-apply for access
          await pool.query(
            `UPDATE app_users
             SET name = $1, password_hash = $2, request_note = $3, status = 'pending', active = FALSE, updated_at = CURRENT_TIMESTAMP
             WHERE id = $4`,
            [fullName, pHash, note, ext.id]
          );
          broadcastSyncEvent({ kind: 'user_signup', email });
          return res.json({ success: true, message: 'Access request resubmitted. Waiting for Admin approval.' });
        }
        return res.status(400).json({ error: 'An account with this email already exists. Please use Sign In.' });
      }

      await pool.query(
        `INSERT INTO app_users (id, email, username, password_hash, name, role, can_edit_master, can_quote, active, status, request_note)
         VALUES ($1, $2, $3, $4, $5, 'user', FALSE, TRUE, FALSE, 'pending', $6)`,
        [userId, email, username, pHash, fullName, note]
      );
    }

    broadcastSyncEvent({ kind: 'user_signup', email });
    res.json({ success: true, message: 'Access request submitted. An administrator will review your account.' });
  } catch (err) {
    console.error('Sign-up error:', err.message);
    res.status(500).json({ error: 'Failed to submit access request.' });
  }
});

// Forgot Password Request (H-01, H-13)
app.post('/api/auth/forgot-password', rateLimitAuth, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const requestedPass = String(req.body.newPassword || '').trim();

  if (!email || requestedPass.length < 6) {
    return res.status(400).json({ error: 'Valid email and a new password (min 6 chars) are required.' });
  }

  try {
    if (pool) {
      const userRes = await pool.query('SELECT id FROM app_users WHERE LOWER(email) = $1', [email]);
      if (userRes.rows.length > 0) {
        const pHash = hashPassword(requestedPass);
        await pool.query(
          `UPDATE app_users
           SET reset_requested = TRUE, reset_token = $1, reset_expires_at = CURRENT_TIMESTAMP + INTERVAL '24 hours', updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [pHash, userRes.rows[0].id]
        );
        broadcastSyncEvent({ kind: 'password_reset_request', email });
      }
    }
    // Always return success to prevent email enumeration
    res.json({ success: true, message: 'Password reset request recorded. Contact your administrator to approve it.' });
  } catch (err) {
    console.error('Forgot-password error:', err.message);
    res.status(500).json({ error: 'Failed to record password reset request.' });
  }
});

// =========================================================================
// 6. ADMIN USER MANAGEMENT ROUTES (S-07, H-10, H-13)
// =========================================================================

// List Users - Admin Only (Passwords NEVER returned)
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (pool) {
      const q = `
        SELECT id, email, username, name, role, can_edit_master, can_quote, active, status, request_note, reset_requested, created_at, updated_at
        FROM app_users
        ORDER BY created_at DESC
      `;
      const result = await pool.query(q);
      res.json({ users: result.rows });
    } else {
      const users = memoryKv.get('_in_memory_users')?.value || [];
      const safe = users.map(({ password_hash, ...u }) => u);
      res.json({ users: safe });
    }
  } catch (err) {
    console.error('Admin list users error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve users list.' });
  }
});

// Approve Pending Sign-Up
app.post('/api/admin/users/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const canEditMaster = req.body.can_edit_master === true || role === 'admin';

  try {
    if (pool) {
      const result = await pool.query(
        `UPDATE app_users
         SET status = 'approved', active = TRUE, role = $1, can_edit_master = $2, can_quote = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 RETURNING id, email, name, role`,
        [role, canEditMaster, id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      broadcastSyncEvent({ kind: 'user_approved', userId: id });
      return res.json({ success: true, user: result.rows[0] });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Approve user error:', err.message);
    res.status(500).json({ error: 'Failed to approve user.' });
  }
});

// Reject / Delete User
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    if (pool) {
      await pool.query('DELETE FROM app_users WHERE id = $1', [id]);
      broadcastSyncEvent({ kind: 'user_deleted', userId: id });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err.message);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

// Approve Password Reset
app.post('/api/admin/users/:id/approve-reset', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    if (pool) {
      const userRes = await pool.query('SELECT reset_token FROM app_users WHERE id = $1 AND reset_requested = TRUE', [id]);
      if (userRes.rows.length === 0 || !userRes.rows[0].reset_token) {
        return res.status(400).json({ error: 'No active password reset request for this user.' });
      }
      await pool.query(
        `UPDATE app_users
         SET password_hash = reset_token, reset_requested = FALSE, reset_token = NULL, reset_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id]
      );
      // Invalidate existing sessions for security
      await pool.query('DELETE FROM app_sessions WHERE user_id = $1', [id]);
      broadcastSyncEvent({ kind: 'password_reset_approved', userId: id });
    }
    res.json({ success: true, message: 'Password reset approved.' });
  } catch (err) {
    console.error('Approve reset error:', err.message);
    res.status(500).json({ error: 'Failed to approve password reset.' });
  }
});

// Admin Invite / Direct Create
app.post('/api/admin/users/invite', requireAuth, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || 'gepl12345').trim();
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const canEditMaster = req.body.can_edit_master === true || role === 'admin';

  if (!name || !email.includes('@') || password.length < 6) {
    return res.status(400).json({ error: 'Name, email, and password (min 6 chars) are required.' });
  }

  try {
    const pHash = hashPassword(password);
    const userId = 'u_' + crypto.randomBytes(8).toString('hex');
    const username = email.split('@')[0];

    if (pool) {
      await pool.query(
        `INSERT INTO app_users (id, email, username, password_hash, name, role, can_edit_master, can_quote, active, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, TRUE, 'approved')
         ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, role = EXCLUDED.role,
             can_edit_master = EXCLUDED.can_edit_master, active = TRUE, status = 'approved', updated_at = CURRENT_TIMESTAMP`,
        [userId, email, username, pHash, name, role, canEditMaster]
      );
      broadcastSyncEvent({ kind: 'user_invited', email });
    }
    res.json({ success: true, message: `User ${email} invited and approved.` });
  } catch (err) {
    console.error('Invite user error:', err.message);
    res.status(500).json({ error: 'Failed to invite user.' });
  }
});

// =========================================================================
// 7. KEY-VALUE MASTER DATA STORAGE (S-01, S-04, S-05, S-10, S-11, S-13)
// =========================================================================

// Status check: returns current versions without downloading entire tables (S-13)
app.get('/api/storage/status', requireAuth, async (req, res) => {
  const versions = {};
  for (const [k, obj] of memoryKv.entries()) {
    if (ALLOWED_KV_KEYS.has(k)) {
      versions[k] = obj.version;
    }
  }
  res.json({ versions, latestRev: latestKvRev });
});

// Full storage retrieval - requires authentication (S-01)
app.get('/api/storage', requireAuth, async (req, res) => {
  try {
    if (pool) {
      const result = await pool.query('SELECT key, value, version FROM app_kv_store');
      const data = {};
      result.rows.forEach(r => {
        if (ALLOWED_KV_KEYS.has(r.key)) {
          data[r.key] = r.value;
          memoryKv.set(r.key, { value: r.value, version: r.version });
        }
      });
      return res.json({ synced: true, latestRev: latestKvRev, data });
    }

    const data = {};
    for (const [k, obj] of memoryKv.entries()) {
      if (ALLOWED_KV_KEYS.has(k)) data[k] = obj.value;
    }
    res.json({ synced: true, latestRev: latestKvRev, data });
  } catch (err) {
    console.error('GET /api/storage error:', err.message);
    res.status(500).json({ error: 'Failed to load master storage.' });
  }
});

// Single Key Read
app.get('/api/storage/:key', requireAuth, async (req, res) => {
  const { key } = req.params;
  if (!ALLOWED_KV_KEYS.has(key)) {
    return res.status(400).json({ error: 'Invalid storage key.' });
  }

  try {
    if (pool) {
      const result = await pool.query('SELECT value, version FROM app_kv_store WHERE key = $1', [key]);
      if (result.rows.length === 0) {
        return res.json({ key, value: null, version: 0 });
      }
      return res.json({ key, value: result.rows[0].value, version: result.rows[0].version });
    }

    const cached = memoryKv.get(key);
    res.json({ key, value: cached ? cached.value : null, version: cached ? cached.version : 0 });
  } catch (err) {
    console.error(`GET /api/storage/${key} error:`, err.message);
    res.status(500).json({ error: 'Failed to retrieve key.' });
  }
});

// Single Key Update - Requires Master Edit permission (S-01, S-04, S-05)
app.post('/api/storage/:key', requireAuth, requireMasterEdit, async (req, res) => {
  const { key } = req.params;
  const { value, expectedVersion } = req.body;

  if (!ALLOWED_KV_KEYS.has(key)) {
    return res.status(400).json({ error: 'Invalid or restricted storage key.' });
  }

  try {
    let nextVersion = 1;
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Check version for optimistic concurrency (S-05)
        const curRes = await client.query('SELECT version FROM app_kv_store WHERE key = $1 FOR UPDATE', [key]);
        if (curRes.rows.length > 0) {
          const curVer = curRes.rows[0].version;
          if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== curVer) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Conflict: Data has been updated by another user. Please reload.', currentVersion: curVer });
          }
          nextVersion = curVer + 1;
        }

        // Write to database FIRST before updating memory (S-04)
        await client.query(
          `INSERT INTO app_kv_store (key, value, version, updated_at, updated_by)
           VALUES ($1, $2::jsonb, $3, CURRENT_TIMESTAMP, $4)
           ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, version = EXCLUDED.version, updated_at = CURRENT_TIMESTAMP, updated_by = EXCLUDED.updated_by`,
          [key, JSON.stringify(value ?? null), nextVersion, req.user.email]
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      nextVersion = (memoryKv.get(key)?.version || 0) + 1;
    }

    // Update memory only after database commit succeeds (S-04)
    memoryKv.set(key, { value, version: nextVersion });
    latestKvRev = Date.now();

    // Broadcast sync event to all other clients, skipping sender (S-12)
    broadcastSyncEvent({ key, version: nextVersion }, req.sessionId);

    res.json({ success: true, key, version: nextVersion });
  } catch (err) {
    console.error(`POST /api/storage/${key} error:`, err.message);
    res.status(500).json({ error: 'Failed to persist change to database.' });
  }
});

// =========================================================================
// 8. ATOMIC QUOTATION SEQUENCES & DEDICATED TABLES (H-07, H-08, H-11)
// =========================================================================

// Current Indian Financial Year string based on server clock (H-07)
function getServerFinancialYear() {
  const d = new Date();
  const year = d.getFullYear();
  const month = d.getMonth() + 1; // 1-12
  const fyStart = month >= 4 ? year : year - 1;
  const startStr = String(fyStart).slice(2);
  const endStr = String(fyStart + 1).slice(2);
  return `${startStr}-${endStr}`; // e.g. "26-27"
}

// Atomic Quote Number Generator (H-07)
app.post('/api/quotes/next-number', requireAuth, async (req, res) => {
  const fy = getServerFinancialYear();
  try {
    let nextSeq = 1;
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query('SELECT last_seq FROM app_quote_sequences WHERE financial_year = $1 FOR UPDATE', [fy]);
        if (r.rows.length === 0) {
          nextSeq = 1;
          await client.query('INSERT INTO app_quote_sequences (financial_year, last_seq) VALUES ($1, 1)', [fy]);
        } else {
          nextSeq = r.rows[0].last_seq + 1;
          await client.query('UPDATE app_quote_sequences SET last_seq = $1, updated_at = CURRENT_TIMESTAMP WHERE financial_year = $2', [nextSeq, fy]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      nextSeq = ((memoryKv.get('_seq_' + fy)?.value || 0) + 1);
      memoryKv.set('_seq_' + fy, { value: nextSeq, version: 1 });
    }

    const formattedQuoteNumber = `GEPL/${fy}/${String(nextSeq).padStart(4, '0')}`;
    res.json({ success: true, quoteNumber: formattedQuoteNumber, financialYear: fy, sequence: nextSeq });
  } catch (err) {
    console.error('Sequence generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate atomic quote sequence.' });
  }
});

// Dedicated Quotes Collection: Get All Quotes (H-08)
app.get('/api/quotes', requireAuth, async (req, res) => {
  try {
    if (pool) {
      const r = await pool.query('SELECT quote_data FROM app_quotes ORDER BY created_at DESC LIMIT 500');
      const list = r.rows.map(row => row.quote_data);
      return res.json({ quotes: list });
    }
    const list = memoryKv.get('_quotes')?.value || [];
    res.json({ quotes: list });
  } catch (err) {
    console.error('GET /api/quotes error:', err.message);
    res.status(500).json({ error: 'Failed to fetch saved quotes.' });
  }
});

// Dedicated Quotes Collection: Save Single Quote (H-08, H-11)
app.post('/api/quotes', requireAuth, async (req, res) => {
  const qObj = req.body.quote;
  if (!qObj || !qObj.id || !qObj.number) {
    return res.status(400).json({ error: 'Valid quote object with id and number is required.' });
  }

  // Ensure author information is stamped from verified server session (H-11)
  qObj.savedByUserId = req.user.id;
  qObj.savedByEmail = req.user.email;
  qObj.savedByName = req.user.name;
  qObj.savedAt = qObj.savedAt || new Date().toISOString();

  try {
    if (pool) {
      const fy = qObj.financialYear || getServerFinancialYear();
      const seq = parseInt(qObj.number.split('/').pop(), 10) || 0;
      await pool.query(
        `INSERT INTO app_quotes (
          id, quote_number, financial_year, seq_num, customer_name, customer_address, customer_phone,
          product_id, product_name, delivery_location, refinery_id, refinery_name,
          transporter_id, transporter_name, quantity, unit, basic_price, discount, transport_rate,
          credit_cost, margin, selling_price, selling_price_gst, order_value, quote_data,
          created_by_user_id, created_by_email, created_by_name
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb, $26, $27, $28
        ) ON CONFLICT (quote_number) DO UPDATE
        SET quote_data = EXCLUDED.quote_data, selling_price = EXCLUDED.selling_price, order_value = EXCLUDED.order_value`,
        [
          qObj.id, qObj.number, fy, seq, qObj.customer || 'Direct Enquiry', qObj.customerAddress || '', qObj.customerPhone || '',
          qObj.product || '', qObj.productName || '', qObj.location || '', qObj.refineryId || '', qObj.refineryName || '',
          qObj.transporterId || '', qObj.transporterName || '', Number(qObj.qty) || 0, qObj.unit || 'MT',
          Number(qObj.basic) || 0, Number(qObj.discount) || 0, Number(qObj.transport) || 0,
          Number(qObj.credit) || 0, Number(qObj.margin) || 0, Number(qObj.rate) || 0, Number(qObj.rateGst) || 0,
          Number(qObj.total) || 0, JSON.stringify(qObj), req.user.id, req.user.email, req.user.name
        ]
      );
    } else {
      let list = memoryKv.get('_quotes')?.value || [];
      const idx = list.findIndex(q => q.id === qObj.id || q.number === qObj.number);
      if (idx >= 0) list[idx] = qObj;
      else list.unshift(qObj);
      memoryKv.set('_quotes', { value: list, version: 1 });
    }

    broadcastSyncEvent({ kind: 'quote_saved', quoteId: qObj.id }, req.sessionId);
    res.json({ success: true, quote: qObj });
  } catch (err) {
    console.error('Save quote error:', err.message);
    res.status(500).json({ error: 'Failed to save quote.' });
  }
});

// Dedicated Quotes Collection: Delete Single Quote
app.delete('/api/quotes/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    if (pool) {
      await pool.query('DELETE FROM app_quotes WHERE id = $1', [id]);
    } else {
      let list = memoryKv.get('_quotes')?.value || [];
      list = list.filter(q => q.id !== id);
      memoryKv.set('_quotes', { value: list, version: 1 });
    }
    broadcastSyncEvent({ kind: 'quote_deleted', quoteId: id }, req.sessionId);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete quote error:', err.message);
    res.status(500).json({ error: 'Failed to delete quote.' });
  }
});

// Dedicated Audit Logs Collection (H-08, H-11)
app.get('/api/quote-logs', requireAuth, async (req, res) => {
  try {
    if (pool) {
      const r = await pool.query('SELECT * FROM app_quote_logs ORDER BY created_at DESC LIMIT 500');
      return res.json({ logs: r.rows });
    }
    const list = memoryKv.get('_quote_logs')?.value || [];
    res.json({ logs: list });
  } catch (err) {
    console.error('GET /api/quote-logs error:', err.message);
    res.status(500).json({ error: 'Failed to fetch activity logs.' });
  }
});

app.post('/api/quote-logs', requireAuth, async (req, res) => {
  const log = req.body.log || {};
  const logId = 'log_' + crypto.randomBytes(8).toString('hex');
  const ip = req.ip || req.connection.remoteAddress || 'unknown';

  try {
    if (pool) {
      await pool.query(
        `INSERT INTO app_quote_logs (
          id, action_type, action_desc, quote_id, quote_number, customer, location, product,
          qty, unit, refinery, rate, rate_gst, margin, order_total, user_id, user_email, user_name, user_role, ip_address
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          logId, log.actionType || 'quote', log.action || 'Quotation Event', log.quoteId || null,
          log.quoteNumber || null, log.customer || '—', log.location || '—', log.product || '—',
          String(log.qty || '—'), log.unit || 'MT', log.refinery || '—', Number(log.rate) || null,
          Number(log.rateGst) || null, Number(log.margin) || 0, Number(log.orderTotal) || null,
          req.user.id, req.user.email, req.user.name, req.user.role, ip
        ]
      );
    } else {
      const list = memoryKv.get('_quote_logs')?.value || [];
      list.unshift({ ...log, id: logId, user_email: req.user.email, user_name: req.user.name, created_at: new Date().toISOString() });
      memoryKv.set('_quote_logs', { value: list.slice(0, 500), version: 1 });
    }
    res.json({ success: true, id: logId });
  } catch (err) {
    console.error('Log event error:', err.message);
    res.status(500).json({ error: 'Failed to record audit log.' });
  }
});

// =========================================================================
// 9. GRACEFUL PROCESS SHUTDOWN & CLEANUP (S-16)
// =========================================================================
function handleShutdown(signal) {
  console.log(`[SHUTDOWN] Received ${signal}. Closing connections cleanly...`);
  if (pool) {
    pool.end().then(() => {
      console.log('[DB] Pool connections terminated.');
      process.exit(0);
    }).catch(() => process.exit(1));
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// Generic 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

// Generic 500 error handler (S-15)
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: IS_PROD ? 'An internal server error occurred.' : err.message });
});

// Server Listen: Wait for initDatabase() before binding (S-06)
const PORT = process.env.PORT || 3000;
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`[SERVER] RefineCalc Enterprise Quote Desk listening on port ${PORT} (Environment: ${process.env.NODE_ENV || 'development'})`);
  });
}).catch((err) => {
  console.error('[SERVER] Fatal startup failure:', err);
  process.exit(1);
});