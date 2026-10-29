// server.js - Node.js Express server with Neon PostgreSQL integration & Multi-PC Sync
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname)); // Serves index.html directly

// Neon Postgres Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Auto-initialize tables on startup so Render deployments never fail with missing relation errors
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_kv_store (
        key VARCHAR(64) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS refineries (
        id SERIAL PRIMARY KEY,
        code VARCHAR(30) UNIQUE NOT NULL,
        name VARCHAR(150) NOT NULL,
        city VARCHAR(100) NOT NULL,
        state VARCHAR(100) NOT NULL,
        latitude DECIMAL(9, 6) NOT NULL,
        longitude DECIMAL(9, 6) NOT NULL,
        loading_capacity VARCHAR(100),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS transporters (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        base_city VARCHAR(100) NOT NULL,
        rate_per_mt_per_km DECIMAL(6, 2) NOT NULL,
        min_freight DECIMAL(10, 2) DEFAULT 0,
        fleet_details VARCHAR(255),
        contact_phone VARCHAR(50),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS price_lists (
        id SERIAL PRIMARY KEY,
        cycle_start DATE NOT NULL,
        cycle_end DATE NOT NULL,
        product_name VARCHAR(100) NOT NULL,
        refinery_code VARCHAR(30),
        basic_price DECIMAL(10, 2) NOT NULL,
        discount DECIMAL(10, 2) DEFAULT 0,
        net_price DECIMAL(10, 2) GENERATED ALWAYS AS (basic_price - discount) STORED,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Version counter per key -> lets clients detect changes and avoid overwriting each other
    await pool.query(`ALTER TABLE app_kv_store ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1`);
    console.log('Neon PostgreSQL tables verified and ready.');
  } catch (err) {
    console.error('Database initialization warning:', err.message);
  }
}
initDatabase();

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'RefineCalc Pro' }));

// 1. Unified Multi-PC Storage Sync GET (returns data + version of every key)
app.get('/api/storage', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const result = await pool.query('SELECT key, value, version FROM app_kv_store');
    const data = {};
    const versions = {};
    result.rows.forEach(r => { data[r.key] = r.value; versions[r.key] = r.version; });
    res.json({ synced: true, data, versions });
  } catch (err) {
    console.error('Error in GET /api/storage:', err);
    res.status(500).json({ error: err.message });
  }
});

// 1b. Lightweight change-check used by every PC every few seconds (no payload, just versions)
app.get('/api/storage-versions', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const result = await pool.query('SELECT key, version FROM app_kv_store');
    const versions = {};
    result.rows.forEach(r => { versions[r.key] = r.version; });
    res.json({ versions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Unified Multi-PC Storage Sync POST with conflict detection.
//    Client sends baseVersion = the version it last saw (0 = key did not exist).
//    If someone else saved in between, we answer 409 with the latest data instead of overwriting it.
app.post('/api/storage/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { value, baseVersion } = req.body;
    const json = JSON.stringify(value);

    if (baseVersion === undefined || baseVersion === null) {
      // Old clients: plain overwrite
      const r = await pool.query(
        `INSERT INTO app_kv_store (key, value, version, updated_at)
         VALUES ($1, $2::jsonb, 1, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, version = app_kv_store.version + 1, updated_at = CURRENT_TIMESTAMP
         RETURNING version`,
        [key, json]
      );
      return res.json({ success: true, key, version: r.rows[0].version });
    }

    let r;
    if (Number(baseVersion) === 0) {
      r = await pool.query(
        `INSERT INTO app_kv_store (key, value, version, updated_at)
         VALUES ($1, $2::jsonb, 1, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO NOTHING
         RETURNING version`,
        [key, json]
      );
    } else {
      r = await pool.query(
        `UPDATE app_kv_store
            SET value = $2::jsonb, version = version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE key = $1 AND version = $3
          RETURNING version`,
        [key, json, Number(baseVersion)]
      );
    }

    if (r.rowCount === 1) {
      return res.json({ success: true, key, version: r.rows[0].version });
    }

    // Someone else saved first -> hand back the latest copy
    const cur = await pool.query('SELECT value, version FROM app_kv_store WHERE key = $1', [key]);
    return res.status(409).json({
      conflict: true,
      key,
      version: cur.rows[0]?.version || 0,
      value: cur.rows[0]?.value ?? null
    });
  } catch (err) {
    console.error('Error in POST /api/storage:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Legacy / Relational Fetch Masters & Active 15-day Price List
app.get('/api/masters', async (req, res) => {
  try {
    const refineries = await pool.query('SELECT * FROM refineries WHERE is_active = true ORDER BY name ASC');
    const transporters = await pool.query('SELECT * FROM transporters WHERE is_active = true ORDER BY name ASC');
    const prices = await pool.query('SELECT * FROM price_lists ORDER BY cycle_start DESC');
    res.json({
      refineries: refineries.rows,
      transporters: transporters.rows,
      prices: prices.rows
    });
  } catch (err) {
    console.error('Error fetching masters:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4. Batch Upload 15-day Price List
app.post('/api/pricelist/batch', async (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'items array is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      await client.query(
        `INSERT INTO price_lists 
          (cycle_start, cycle_end, product_name, refinery_code, basic_price, discount) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [item.cycle_start, item.cycle_end, item.product_name, item.refinery_code, item.basic_price, item.discount]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, count: items.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Batch price upload failed:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RefineCalc backend listening on port ${PORT}`);
});
