-- =========================================================================
-- GOVERDHAN ENERGY & PETROCHEMICALS PVT. LTD. - REFINECALC ENTERPRISE SCHEMA
-- PostgreSQL / Neon Database Schema with Dedicated Tables, Indexes & Security
-- =========================================================================

-- 1. Key-Value Storage for Master Collections (Catalog, Routes, Transporters, Settings, Cycles)
CREATE TABLE IF NOT EXISTS app_kv_store (
    key VARCHAR(64) PRIMARY KEY,
    value JSONB NOT NULL,
    version INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_by VARCHAR(128)
);

-- 2. Dedicated Users Table with Salted Password Hashes (Replaces Plaintext JSON Array)
CREATE TABLE IF NOT EXISTS app_users (
    id VARCHAR(64) PRIMARY KEY,
    email VARCHAR(128) UNIQUE NOT NULL,
    username VARCHAR(64) UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(128) NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'user', -- 'admin', 'user', 'viewer'
    can_edit_master BOOLEAN DEFAULT FALSE,
    can_quote BOOLEAN DEFAULT TRUE,
    active BOOLEAN DEFAULT TRUE,
    status VARCHAR(32) DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
    request_note TEXT,
    reset_requested BOOLEAN DEFAULT FALSE,
    reset_token VARCHAR(128),
    reset_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_app_users_status ON app_users(status);

-- 3. Dedicated User Sessions Table (Stateful Server-Side Auth Sessions)
CREATE TABLE IF NOT EXISTS app_sessions (
    token VARCHAR(128) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_app_sessions_token_expires ON app_sessions(token, expires_at);

-- 4. Dedicated Customer Quotes Table (Append-Only / Atomic Row Persistence)
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

CREATE INDEX IF NOT EXISTS idx_app_quotes_fy_seq ON app_quotes(financial_year, seq_num);
CREATE INDEX IF NOT EXISTS idx_app_quotes_created_at ON app_quotes(created_at DESC);

-- 5. Dedicated Audit & Activity Logs Table (Append-Only Immutable History)
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

CREATE INDEX IF NOT EXISTS idx_app_quote_logs_created_at ON app_quote_logs(created_at DESC);

-- 6. Atomic Financial Year Sequence Table (Prevents Duplicate Quote Numbers)
CREATE TABLE IF NOT EXISTS app_quote_sequences (
    financial_year VARCHAR(16) PRIMARY KEY,
    last_seq INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 7. Automated Backups & System Audit Table
CREATE TABLE IF NOT EXISTS app_backups (
    id SERIAL PRIMARY KEY,
    backup_type VARCHAR(64) NOT NULL,
    reason TEXT,
    snapshot_data JSONB NOT NULL,
    created_by VARCHAR(128),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
