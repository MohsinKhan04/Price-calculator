const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// Neon PostgreSQL Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) console.error('Error connecting to Neon:', err);
  else console.log('Connected to Neon PostgreSQL successfully at:', res.rows[0].now);
});

// 1. REFINERIES API
app.get('/api/refineries', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM refineries ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/refineries', async (req, res) => {
  try {
    const { name, company, state, district, lat, lng } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO refineries (name, company, state, district, lat, lng)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, company, state, district, lat, lng]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. TRANSPORTERS API
app.get('/api/transporters', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM transporters ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/transporters', async (req, res) => {
  try {
    const { name, base_city, base_lat, base_lng, rate_per_km, min_charge, contact_person, contact_phone } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO transporters (name, base_city, base_lat, base_lng, rate_per_km, min_charge, contact_person, contact_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, base_city, base_lat, base_lng, rate_per_km, min_charge, contact_person, contact_phone]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. PRICE LISTS API
app.get('/api/prices', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM price_lists ORDER BY effective_from DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/prices', async (req, res) => {
  try {
    const { refinery_id, product_name, basic_price, discount, effective_from, effective_to } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO price_lists (refinery_id, product_name, basic_price, discount, effective_from, effective_to)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [refinery_id, product_name, basic_price, discount, effective_from, effective_to]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. QUOTE LOGS API
app.post('/api/quotes', async (req, res) => {
  try {
    const { product_name, destination_name, dest_lat, dest_lng, chosen_refinery_id, chosen_transporter_id, distance_km, basic_price, discount, net_price, transport_cost, margin, customer_price } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO quote_logs (product_name, destination_name, dest_lat, dest_lng, chosen_refinery_id, chosen_transporter_id, distance_km, basic_price, discount, net_price, transport_cost, margin, customer_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [product_name, destination_name, dest_lat, dest_lng, chosen_refinery_id, chosen_transporter_id, distance_km, basic_price, discount, net_price, transport_cost, margin, customer_price]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});