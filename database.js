const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'clipdrop.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create all tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('seller', 'creator', 'admin')),
    first_name TEXT,
    last_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS creators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE REFERENCES users(id),
    handle_tiktok TEXT,
    handle_instagram TEXT,
    followers_tiktok TEXT,
    followers_instagram TEXT,
    niches TEXT,
    formats TEXT,
    rate INTEGER DEFAULT 75,
    turnaround TEXT DEFAULT '5 days',
    portfolio_links TEXT,
    bio TEXT,
    address_line1 TEXT,
    address_line2 TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    country TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'suspended')),
    stripe_account_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sellers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE REFERENCES users(id),
    plan TEXT DEFAULT 'try' CHECK(plan IN ('try', 'growth', 'scale')),
    stripe_customer_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT UNIQUE NOT NULL,
    seller_id INTEGER REFERENCES sellers(id),
    creator_id INTEGER REFERENCES creators(id),
    product_name TEXT NOT NULL,
    product_url TEXT NOT NULL,
    product_desc TEXT,
    product_category TEXT,
    target_audience TEXT,
    ad_style TEXT,
    video_length TEXT DEFAULT '30s',
    reference_links TEXT,
    special_instructions TEXT,
    product_variant TEXT,
    quantity INTEGER DEFAULT 1,
    shipping_speed TEXT DEFAULT 'standard',
    match_type TEXT DEFAULT 'auto',
    amount INTEGER NOT NULL,
    platform_fee INTEGER NOT NULL,
    creator_payout INTEGER NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','shipping','filming','in_review','approved','completed','disputed','refunded')),
    stripe_payment_intent_id TEXT,
    video_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER REFERENCES orders(id),
    creator_id INTEGER REFERENCES creators(id),
    amount INTEGER NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'failed')),
    stripe_transfer_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    paid_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS disputes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER REFERENCES orders(id),
    raised_by INTEGER REFERENCES users(id),
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'open' CHECK(status IN ('open', 'under_review', 'resolved')),
    resolution TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
  );
`);

// Seed an admin user if none exists
const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
if (!adminExists) {
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (email, password, role, first_name, last_name) VALUES (?, ?, ?, ?, ?)')
    .run('admin@clipdrop.co', hash, 'admin', 'Admin', 'User');
  console.log('Admin user created: admin@clipdrop.co / admin123');
}

module.exports = db;
