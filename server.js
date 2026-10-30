// server.js - Node.js Express server with Dual Persistence (Instant RAM + Neon PostgreSQL), Real-Time SSE & No-Cache Multi-Device Sync
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

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

app.use(express.static(__dirname, { etag: false, lastModified: false, maxAge: 0 }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, maxAge: 0 }));

// Authoritative in-memory store backed by Neon PostgreSQL (ensures 0ms read consistency across all devices on Render)
const memoryStore = {};
let latestServerMs = 0;
let dbReady = false;

// Neon Postgres Connection Pool
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

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
    console.error('Database initialization warning (using in-memory store fallback):', err.message);
  }
}
initDatabase();

// Health check
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'RefineCalc Quote Desk',
  dbReady,
  keysCount: Object.keys(memoryStore).length,
  latestServerMs
}));

// Real-Time Server-Sent Events (SSE) stream so all open devices update within milliseconds of any save
app.get('/api/events', (req, res) => {
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
app.get('/api/storage', async (req, res) => {
  try {
    if (pool) {
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
    }
    res.json({ synced: true, latestMs: Math.round(latestServerMs), data: memoryStore });
  } catch (err) {
    console.error('Error in GET /api/storage:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Unified Multi-Device Storage Sync POST (single key auto-save)
app.post('/api/storage/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { value, stateRev } = req.body;
    const rev = Number(stateRev) || Date.now();
    const metaObj = { stateRev: rev, updatedAt: new Date().toISOString(), lastKey: key };

    // 1. Update in-memory store immediately for 0ms cross-device consistency
    memoryStore[key] = value ?? null;
    memoryStore._meta = metaObj;
    latestServerMs = Math.max(latestServerMs, rev, Date.now());

    // 2. Broadcast immediately to all other connected devices
    broadcastSyncEvent({ key, stateRev: rev });

    // 3. Persist to Neon PostgreSQL
    if (pool) {
      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO app_kv_store (key, value, updated_at)
             VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
            [key, JSON.stringify(value ?? null)]
          );
          await client.query(
            `INSERT INTO app_kv_store (key, value, updated_at)
             VALUES ('_meta', $1::jsonb, CURRENT_TIMESTAMP)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
            [JSON.stringify(metaObj)]
          );
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      } catch (dbErr) {
        console.error('POST /api/storage/:key DB write warning (kept in memoryStore):', dbErr.message);
      }
    }

    res.json({ success: true, key, stateRev: rev });
  } catch (err) {
    console.error('Error in POST /api/storage/:key:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Bulk Multi-Device Storage Sync POST (atomic full-state auto-save / replace)
app.post('/api/storage', async (req, res) => {
  try {
    const { entries, stateRev, replaceAll } = req.body;
    if (!entries || typeof entries !== 'object') {
      return res.status(400).json({ error: 'entries object is required' });
    }
    const rev = Number(stateRev) || Date.now();
    const metaObj = { stateRev: rev, updatedAt: new Date().toISOString(), lastKey: 'bulk' };

    // 1. Update in-memory store immediately
    if (replaceAll) {
      for (const k of Object.keys(memoryStore)) delete memoryStore[k];
    }
    for (const [k, v] of Object.entries(entries)) {
      memoryStore[k] = v ?? null;
    }
    memoryStore._meta = metaObj;
    latestServerMs = Math.max(latestServerMs, rev, Date.now());

    // 2. Broadcast immediately to all other connected devices
    broadcastSyncEvent({ key: 'bulk', stateRev: rev });

    // 3. Persist to Neon PostgreSQL
    if (pool) {
      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          if (replaceAll) {
            await client.query('DELETE FROM app_kv_store');
          }
          for (const [k, v] of Object.entries(entries)) {
            await client.query(
              `INSERT INTO app_kv_store (key, value, updated_at)
               VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
              [k, JSON.stringify(v ?? null)]
            );
          }
          await client.query(
            `INSERT INTO app_kv_store (key, value, updated_at)
             VALUES ('_meta', $1::jsonb, CURRENT_TIMESTAMP)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
            [JSON.stringify(metaObj)]
          );
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      } catch (dbErr) {
        console.error('Bulk POST /api/storage DB write warning (kept in memoryStore):', dbErr.message);
      }
    }

    res.json({ success: true, count: Object.keys(entries).length, stateRev: rev });
  } catch (err) {
    console.error('Error in bulk POST /api/storage:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4. User & Admin Authentication Endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    let users = memoryStore.users;
    if (!Array.isArray(users) && pool) {
      const result = await pool.query("SELECT value FROM app_kv_store WHERE key = 'users'");
      users = result.rows[0]?.value || [];
    }
    const found = (users || []).find(u =>
      u.active !== false &&
      (String(u.username || '').toLowerCase() === String(username || '').trim().toLowerCase() ||
       String(u.email || '').toLowerCase() === String(username || '').trim().toLowerCase()) &&
      String(u.password || '') === String(password || '')
    );
    if (!found) {
      return res.status(401).json({ success: false, error: 'Invalid username or password' });
    }
    const { password: _, ...safeUser } = found;
    res.json({ success: true, user: safeUser });
  } catch (err) {
    console.error('Error in POST /api/auth/login:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RefineCalc Quote Desk backend listening on port ${PORT}`);
});