-- ========================================================
-- REFINECALC PRO - NEON POSTGRESQL SCHEMA & SEED DATA
-- ========================================================

-- 1. Refineries Master
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
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Transporters Master
CREATE TABLE IF NOT EXISTS transporters (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    base_city VARCHAR(100) NOT NULL,
    rate_per_mt_per_km DECIMAL(6, 2) NOT NULL,
    min_freight DECIMAL(10, 2) DEFAULT 0,
    fleet_details VARCHAR(255),
    contact_phone VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. 15-Day Revision Price Lists
CREATE TABLE IF NOT EXISTS price_lists (
    id SERIAL PRIMARY KEY,
    cycle_start DATE NOT NULL,
    cycle_end DATE NOT NULL,
    product_name VARCHAR(100) NOT NULL,
    refinery_code VARCHAR(30) REFERENCES refineries(code) ON DELETE CASCADE,
    basic_price DECIMAL(10, 2) NOT NULL,
    discount DECIMAL(10, 2) DEFAULT 0,
    net_price DECIMAL(10, 2) GENERATED ALWAYS AS (basic_price - discount) STORED,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Customer Quotes Audit Log
CREATE TABLE IF NOT EXISTS quote_logs (
    id SERIAL PRIMARY KEY,
    product_name VARCHAR(100) NOT NULL,
    destination_city VARCHAR(100) NOT NULL,
    quantity_mt DECIMAL(10, 2) NOT NULL,
    chosen_refinery_code VARCHAR(30),
    chosen_transporter_id INT,
    distance_km DECIMAL(8, 2),
    basic_price DECIMAL(10, 2),
    discount DECIMAL(10, 2),
    net_price DECIMAL(10, 2),
    transport_cost DECIMAL(10, 2),
    margin DECIMAL(10, 2),
    customer_price DECIMAL(10, 2),
    total_order_val DECIMAL(12, 2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- SEED REFINERIES
INSERT INTO refineries (code, name, city, state, latitude, longitude, loading_capacity) VALUES
('IOCL_KOYALI', 'IOCL Gujarat Refinery (Koyali)', 'Vadodara', 'Gujarat', 22.3736, 73.1256, '1,500 MT/day'),
('BPCL_MUMBAI', 'BPCL Mumbai Refinery (Mahul)', 'Mumbai', 'Maharashtra', 19.0069, 72.8876, '1,200 MT/day'),
('IOCL_MATHURA', 'IOCL Mathura Refinery', 'Mathura', 'Uttar Pradesh', 27.5029, 77.6740, '1,000 MT/day'),
('IOCL_PANIPAT', 'IOCL Panipat Refinery', 'Panipat', 'Haryana', 29.3909, 76.9635, '2,000 MT/day'),
('HMEL_BATHINDA', 'HPCL-Mittal Energy (GGSR)', 'Bathinda', 'Punjab', 30.2110, 74.9455, '1,400 MT/day'),
('HPCL_VIZAG', 'HPCL Visakh Refinery', 'Visakhapatnam', 'Andhra Pradesh', 17.6868, 83.2185, '1,100 MT/day')
ON CONFLICT (code) DO NOTHING;

-- SEED TRANSPORTERS
INSERT INTO transporters (name, base_city, rate_per_mt_per_km, min_freight, fleet_details, contact_phone) VALUES
('QuickTrans Logistics', 'Vadodara / Gujarat', 2.40, 3500, '25-35 MT Insulated Tankers', '+91 98250 11223'),
('Apex Fleet Carriers', 'Mumbai / West Coast', 2.25, 4000, 'Multi-axle Bitumen Tankers', '+91 98200 44556'),
('Northern Highway Lines', 'Panipat / Mathura', 2.10, 3000, 'High-temp Fuel Oil Carriers', '+91 98110 77889'),
('Central Roadways Corp', 'Nagpur / Central India', 2.30, 3200, 'Heavy Haul Tankers', '+91 98900 33445'),
('Southern Bulk Movers', 'Vizag / Chennai', 2.35, 3800, 'Bulk Liquid Tankers', '+91 98480 66778')
ON CONFLICT DO NOTHING;
