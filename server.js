// server.js - Node.js Express server with Dual Persistence (Instant RAM + Neon PostgreSQL), Real-Time SSE & No-Cache Multi-Device Sync
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind one proxy; this makes req.ip the real visitor address

// [SECURITY] Optional site-wide password. Set SITE_PASSWORD in Render > Environment to turn it on.
// The browser shows its normal username/password box once, then sends the password automatically with every
// page, API call and live-sync connection. Nothing inside the page needs to change. /health stays open for Render.
// SITE_USER is optional: leave it empty to accept any user name and check the password only.
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const SITE_USER = process.env.SITE_USER || '';
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b)); // constant-time compare
const gateFailures = new Map(); // ip -> { n, first, until }
app.use((req, res, next) => {
  if (!SITE_PASSWORD || req.path === '/health') return next();
  const ip = req.ip || 'unknown';
  const rec = gateFailures.get(ip);
  if (rec && rec.until > Date.now()) return res.status(429).send('Too many wrong passwords. Try again in a few minutes.');
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const user = i >= 0 ? decoded.slice(0, i) : decoded;
    const pass = i >= 0 ? decoded.slice(i + 1) : '';
    if (safeEqual(pass, SITE_PASSWORD) && (!SITE_USER || safeEqual(user, SITE_USER))) {
      gateFailures.delete(ip);
      return next();
    }
    const now = Date.now();
    const r = rec && now - rec.first < 15 * 60 * 1000 ? rec : { n: 0, first: now, until: 0 };
    r.n += 1;
    if (r.n >= 10) r.until = now + 15 * 60 * 1000;
    gateFailures.set(ip, r);
  }
  res.set('WWW-Authenticate', 'Basic realm="RefineCalc Quote Desk", charset="UTF-8"');
  return res.status(401).send('Login required');
});

// [SECURITY] Basic browser protections on every response
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// CORS: by default every origin is still allowed (same as before). To lock it down, set CORS_ORIGINS in Render
// to your site address, e.g. https://refinecalc.onrender.com (several addresses separated by commas).
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(corsOrigins.length ? cors({ origin: corsOrigins }) : cors());
app.use(express.json({ limit: process.env.BODY_LIMIT || '15mb' })); // was 50mb

// Prevent browser/proxy caching on all API routes and HTML entrypoints
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Serve root index.html BEFORE public/ with strict no-cache headers so Render never serves stale HTML
app.get(['/', '/index.html', '/refinery_price_calculator.html'], (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  const rootIndex = path.join(__dirname, 'index.html');
  const rootCalc = path.join(__dirname, 'refinery_price_calculator.html');
  const pubIndex = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  if (fs.existsSync(rootCalc)) return res.sendFile(rootCalc);
  if (fs.existsSync(pubIndex)) return res.sendFile(pubIndex);
  next();
});

// [SECURITY] Only the public/ folder is served as plain files. The project root is NOT served any more, so
// server.js, package.json, schema.sql, README.md and the sample CSV can no longer be downloaded by URL.
// (The page itself is still served by the explicit route above.)
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, maxAge: 0 }));

// Authoritative in-memory store backed by Neon PostgreSQL (ensures 0ms read consistency across all devices on Render)
const memoryStore = Object.create(null); // no prototype, so a key such as "__proto__" cannot corrupt it
let latestServerMs = 0;
let dbReady = false;

// Only these storage keys are accepted. They are exactly the keys the page saves.
// To let a future version of the page save another key, add it here or list it in the EXTRA_STORAGE_KEYS variable.
const ALLOWED_KEYS = new Set([
  'catalog', 'routes', 'transporters', 'settings', 'template', 'cycles', 'quotes', 'quoteSeq',
  'users', 'authSettings', 'brand_settings', 'workspaceState', 'quoteLogs', 'mlMappings',
  ...(process.env.EXTRA_STORAGE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean)
]);
const isValidKey = k => typeof k === 'string' && ALLOWED_KEYS.has(k);

// A client clock that is far in the future must not be able to push the sync revision forward for everyone
const MAX_REV_AHEAD_MS = 10 * 60 * 1000;
function safeRev(v) {
  const n = Number(v);
  const now = Date.now();
  if (!Number.isFinite(n) || n <= 0) return now;
  return Math.min(n, now + MAX_REV_AHEAD_MS);
}

// Neon Postgres Connection Pool
// (set DB_SSL_STRICT=true to also verify Neon's certificate; off by default so nothing changes until you test it)
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL_STRICT === 'true' ? true : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000 // do not wait forever while Neon wakes up
    })
  : null;
// Neon closes idle connections; without this handler that event can crash the whole server
if (pool) pool.on('error', err => console.error('Idle database connection error (ignored):', err.message));
process.on('unhandledRejection', err => console.error('Unhandled rejection (ignored):', err && err.message ? err.message : err));

// While the database is still waking up (or unreachable), the API answers 503 instead of an empty store,
// so no browser can mistake "not loaded yet" for "empty" and re-seed over real data.
function requireDb(req, res, next) {
  if (pool && !dbReady) return res.status(503).json({ error: 'Database not ready, please retry', dbReady: false });
  next();
}

// Saves are queued one after another so memory and the database always see the same order
let writeChain = Promise.resolve();
function serialize(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

const UPSERT_SQL = `INSERT INTO app_kv_store (key, value, updated_at)
             VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`;
const UPSERT_META_SQL = `INSERT INTO app_kv_store (key, value, updated_at)
             VALUES ('_meta', $1::jsonb, CURRENT_TIMESTAMP)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`;
// Writes the given [key, value] pairs plus _meta in one transaction. Throws if anything fails.
async function persistToDb(pairs, metaObj) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [k, v] of pairs) {
      await client.query(UPSERT_SQL, [k, JSON.stringify(v)]);
    }
    await client.query(UPSERT_META_SQL, [JSON.stringify(metaObj)]);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

// Non-destructive server-side user list merger so pending sign-ups & password resets are never clobbered by another browser's stale save
function mergeServerUsers(existingUsers, incomingUsers, authSettings) {
  if (!Array.isArray(incomingUsers)) return existingUsers || [];
  if (!Array.isArray(existingUsers) || !existingUsers.length) return incomingUsers;
  const deletedKeys = new Set(((authSettings && authSettings.deletedUserKeys) || []).map(k => String(k).toLowerCase()));
  const getKey = u => String((u && (u.email || u.username || u.id)) || '').trim().toLowerCase();
  const byKey = new Map();

  for (const u of incomingUsers) {
    const k = getKey(u);
    if (!k) continue;
    byKey.set(k, u);
  }
  for (const oldU of existingUsers) {
    const k = getKey(oldU);
    if (!k || deletedKeys.has(k)) continue;
    if (!byKey.has(k)) {
      // Preserve pending sign-up requests or active accounts that a stale client didn't know about yet
      byKey.set(k, oldU);
    } else {
      const inc = byKey.get(k);
      const oldTs = Number(oldU.updatedAtMs) || 0;
      const incTs = Number(inc.updatedAtMs) || 0;
      if (oldTs > incTs) {
        byKey.set(k, oldU);
      } else if (oldU.resetRequested && !inc.resetRequested && oldTs >= incTs) {
        inc.resetRequested = true;
        inc.requestedNewPassword = oldU.requestedNewPassword;
        inc.resetRequestedAt = oldU.resetRequestedAt;
      }
    }
  }
  return Array.from(byKey.values());
}

// Connected Server-Sent Events (SSE) clients for instant multi-device push
const sseClients = new Set();
function broadcastSyncEvent(meta = {}) {
  const payload = `data: ${JSON.stringify({ type: 'sync', ts: Date.now(), ...meta })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Auto-initialize tables and hydrate memoryStore from Neon PostgreSQL on startup
async function initDatabase() {
  if (!pool) {
    console.warn('No DATABASE_URL configured; using in-memory multi-device store.');
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_kv_store (
        key VARCHAR(128) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS app_storage (
        key VARCHAR(128) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const result = await pool.query('SELECT key, value, EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms FROM app_kv_store');
    result.rows.forEach(r => {
      memoryStore[r.key] = r.value;
      const ms = Number(r.updated_ms) || 0;
      if (ms > latestServerMs) latestServerMs = ms;
    });
    // If app_kv_store was empty, check legacy app_storage table
    if (result.rows.length === 0) {
      const legacy = await pool.query('SELECT key, value FROM app_storage');
      for (const r of legacy.rows) {
        memoryStore[r.key] = r.value;
        await pool.query(
          `INSERT INTO app_kv_store (key, value, updated_at)
           VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
          [r.key, JSON.stringify(r.value ?? null)]
        );
      }
    }
    dbReady = true;
    console.log('Neon PostgreSQL hydrated and ready. Keys loaded:', Object.keys(memoryStore).length);
  } catch (err) {
    // The API answers 503 until this succeeds (see requireDb), so keep trying instead of serving an empty store
    console.error('Database initialization failed, retrying in 5 seconds:', err.message);
    setTimeout(initDatabase, 5000);
  }
}
initDatabase();

// Health check (kept short: it is public even when SITE_PASSWORD is set)
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'RefineCalc Quote Desk',
  dbReady
}));

// Real-Time Server-Sent Events (SSE) stream so all open devices update within milliseconds of any save
const MAX_SSE_CLIENTS = 200;
app.get('/api/events', (req, res) => {
  if (sseClients.size >= MAX_SSE_CLIENTS) return res.status(503).json({ error: 'Too many live connections' });
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now(), stateRev: memoryStore._meta?.stateRev || latestServerMs })}\n\n`);
  sseClients.add(res);
  const keepAlive = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch (e) { clearInterval(keepAlive); sseClients.delete(res); }
  }, 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// 1. Unified Multi-Device Storage Sync GET (merges Neon PostgreSQL + instant memoryStore)
app.get('/api/storage', requireDb, async (req, res) => {
  try {
    if (pool) {
      // Runs in the same queue as saves, so an old database read can never overwrite a save that just finished
      await serialize(async () => {
        try {
          const result = await pool.query('SELECT key, value, EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms FROM app_kv_store');
          result.rows.forEach(r => {
            memoryStore[r.key] = r.value;
            const ms = Number(r.updated_ms) || 0;
            if (ms > latestServerMs) latestServerMs = ms;
          });
        } catch (dbErr) {
          console.warn('GET /api/storage DB read warning (serving from memoryStore):', dbErr.message);
        }
      });
    }
    res.json({ synced: true, latestMs: Math.round(latestServerMs), data: memoryStore });
  } catch (err) {
    console.error('Error in GET /api/storage:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 2. Unified Multi-Device Storage Sync POST (single key auto-save)
// The database is written FIRST. Memory and the other devices are only updated after Neon confirms the save.
// If Neon fails, the page gets an error (so it can warn the user and retry) instead of a false "success".
app.post('/api/storage/:key', requireDb, async (req, res) => {
  try {
    const { key } = req.params;
    if (!isValidKey(key)) return res.status(400).json({ error: 'Unknown storage key' });
    const body = req.body || {};
    // A request with no "value" at all used to silently overwrite the key with null; refuse it instead
    if (!Object.prototype.hasOwnProperty.call(body, 'value')) return res.status(400).json({ error: 'value is required' });
    const { value, stateRev } = body;
    const rev = safeRev(stateRev);
    const metaObj = { stateRev: rev, updatedAt: new Date().toISOString(), lastKey: key };

    await serialize(async () => {
      // Non-destructive merge for users, then persist, then update memory
      const finalValue = key === 'users' ? mergeServerUsers(memoryStore.users, value, memoryStore.authSettings) : (value ?? null);
      if (pool) await persistToDb([[key, finalValue]], metaObj);
      memoryStore[key] = finalValue;
      memoryStore._meta = metaObj;
      latestServerMs = Math.max(latestServerMs, rev, Date.now());
    });

    // Broadcast to all connected devices only after the save is safe
    broadcastSyncEvent({ key, stateRev: rev });

    res.json({ success: true, key, stateRev: rev });
  } catch (err) {
    console.error('Error in POST /api/storage/:key:', err.message);
    res.status(500).json({ success: false, error: 'Save failed, please retry' });
  }
});

// 3. Bulk Multi-Device Storage Sync POST (atomic full-state auto-save)
// "replaceAll" (delete everything first) is no longer honoured: it was the one-request way to wipe the database,
// and writing every key in "entries" gives the same result for the data the page actually uses.
app.post('/api/storage', requireDb, async (req, res) => {
  try {
    const { entries, stateRev } = req.body || {};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      return res.status(400).json({ error: 'entries object is required' });
    }
    const keys = Object.keys(entries);
    if (!keys.length || keys.some(k => !isValidKey(k))) {
      return res.status(400).json({ error: 'Unknown storage key' });
    }
    const rev = safeRev(stateRev);
    const metaObj = { stateRev: rev, updatedAt: new Date().toISOString(), lastKey: 'bulk' };

    await serialize(async () => {
      // Preserve pending sign-up requests in users
      const prevUsers = memoryStore.users;
      const prevAuthSettings = entries.authSettings || memoryStore.authSettings;
      const finalPairs = keys.map(k => [k, k === 'users' ? mergeServerUsers(prevUsers, entries[k], prevAuthSettings) : (entries[k] ?? null)]);
      if (pool) await persistToDb(finalPairs, metaObj);
      for (const [k, v] of finalPairs) memoryStore[k] = v;
      memoryStore._meta = metaObj;
      latestServerMs = Math.max(latestServerMs, rev, Date.now());
    });

    broadcastSyncEvent({ key: 'bulk', stateRev: rev });

    res.json({ success: true, count: keys.length, stateRev: rev });
  } catch (err) {
    console.error('Error in bulk POST /api/storage:', err.message);
    res.status(500).json({ success: false, error: 'Save failed, please retry' });
  }
});

// 4. User & Admin Authentication Endpoint
// (The page does not call this yet. It is hardened for when it does: no empty logins, no pending/rejected
// accounts, constant-time password compare, and a lock-out after 10 wrong tries in 15 minutes per address.)
const loginFailures = new Map(); // ip -> { n, first, until }
app.post('/api/auth/login', requireDb, async (req, res) => {
  try {
    const ip = req.ip || 'unknown';
    const rec = loginFailures.get(ip);
    if (rec && rec.until > Date.now()) {
      return res.status(429).json({ success: false, error: 'Too many attempts. Please try again later.' });
    }
    const body = req.body || {};
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    let users = memoryStore.users;
    if (!Array.isArray(users) && pool) {
      const result = await pool.query("SELECT value FROM app_kv_store WHERE key = 'users'");
      users = result.rows[0]?.value || [];
    }
    const found = (!username || !password) ? null : (users || []).find(u =>
      u.active !== false &&
      u.status !== 'pending' && u.status !== 'rejected' &&
      String(u.password || '') !== '' &&
      (String(u.username || '').toLowerCase() === username ||
       String(u.email || '').toLowerCase() === username) &&
      safeEqual(u.password, password)
    );
    if (!found) {
      const now = Date.now();
      const r = rec && now - rec.first < 15 * 60 * 1000 ? rec : { n: 0, first: now, until: 0 };
      r.n += 1;
      if (r.n >= 10) r.until = now + 15 * 60 * 1000;
      loginFailures.set(ip, r);
      return res.status(401).json({ success: false, error: 'Invalid username or password' });
    }
    loginFailures.delete(ip);
    const { password: _, ...safeUser } = found;
    res.json({ success: true, user: safeUser });
  } catch (err) {
    console.error('Error in POST /api/auth/login:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`RefineCalc Quote Desk backend listening on port ${PORT}`);
  if (!SITE_PASSWORD) console.warn('NOTE: SITE_PASSWORD is not set, so the site and its data are open to anyone who knows the address.');
});

// Render sends SIGTERM on every deploy/restart: finish cleanly instead of cutting connections mid-save
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  for (const client of sseClients) { try { client.end(); } catch (e) {} }
  const done = () => process.exit(0);
  server.close(() => { Promise.resolve().then(() => pool && pool.end()).then(done, done); });
  setTimeout(done, 8000).unref();
});
