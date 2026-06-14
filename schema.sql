-- Cloudflare D1 Database Schema Initialization

DROP TABLE IF EXISTS users;
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    apiKey TEXT UNIQUE NOT NULL,
    balance REAL DEFAULT 0.0,
    isAdmin INTEGER DEFAULT 0
);

DROP TABLE IF EXISTS apis;
CREATE TABLE apis (
    name TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    url TEXT NOT NULL,
    auth TEXT NOT NULL,
    https TEXT NOT NULL,
    cors TEXT NOT NULL,
    tier TEXT NOT NULL,
    price_per_call REAL NOT NULL,
    is_active INTEGER DEFAULT 1,
    mock_response TEXT
);

DROP TABLE IF EXISTS user_subscriptions;
CREATE TABLE user_subscriptions (
    user_id TEXT NOT NULL,
    api_name TEXT NOT NULL,
    PRIMARY KEY (user_id, api_name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (api_name) REFERENCES apis(name) ON DELETE CASCADE
);

DROP TABLE IF EXISTS payments;
CREATE TABLE payments (
    orderId TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL,
    ref_number TEXT,
    timestamp TEXT NOT NULL
);

DROP TABLE IF EXISTS logs;
CREATE TABLE logs (
    id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    api_name TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    cost REAL NOT NULL,
    timestamp TEXT NOT NULL
);

-- Seed Default Admin & Demo User
INSERT INTO users (id, email, password, apiKey, balance, isAdmin) VALUES 
('admin_user_id', 'admin@agentapis.com', 'admin1234', 'agent_key_admin1234', 1000.0, 1);

INSERT INTO users (id, email, password, apiKey, balance, isAdmin) VALUES 
('demo_user_id', 'developer@gmail.com', 'password123', 'agent_key_demo54321', 100.0, 0);
