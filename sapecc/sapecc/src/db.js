'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Semua nominal uang disimpan sebagai bilangan bulat Rupiah. Waktu disimpan dalam milidetik (Date.now()).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',          -- user | admin
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  badge TEXT NOT NULL DEFAULT 'new',          -- new | trusted | star
  base_orders INTEGER NOT NULL DEFAULT 0,     -- riwayat pesanan dari data impor/contoh
  resp TEXT NOT NULL DEFAULT '± 30 menit',
  hue INTEGER NOT NULL DEFAULT 220,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0),
  cat TEXT NOT NULL,
  sub TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '📦',
  hue INTEGER NOT NULL DEFAULT 220,
  description TEXT NOT NULL DEFAULT '',
  terms TEXT NOT NULL DEFAULT '',             -- syarat & ketentuan produk
  image TEXT,                                 -- logo produk (/uploads/...)
  keywords TEXT NOT NULL DEFAULT '',
  auto INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT -1,          -- -1 = tanpa batas
  sold INTEGER NOT NULL DEFAULT 0,
  rating REAL NOT NULL DEFAULT 0,
  reviews INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id);
CREATE TABLE IF NOT EXISTS app_icons (
  key TEXT PRIMARY KEY,                       -- "kategori/aplikasi", misalnya game/roblox
  image TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,                         -- order | rekber
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  subtotal INTEGER NOT NULL,
  fee_buyer INTEGER NOT NULL DEFAULT 0,       -- biaya yang dibayar pembeli (layanan / rekber)
  fee_seller INTEGER NOT NULL DEFAULT 0,      -- potongan dari penjual
  total INTEGER NOT NULL,                     -- yang dibayar pembeli (tanpa biaya metode bayar)
  payout INTEGER NOT NULL,                    -- yang diterima penjual
  method TEXT,
  payment_ref TEXT,
  status TEXT NOT NULL,                       -- awaiting_payment | held | shipped | completed | complained | refunded | cancelled
  complaint TEXT,
  resolution TEXT,
  paid_at INTEGER, shipped_at INTEGER, completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_payment ON orders(payment_ref);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER REFERENCES products(id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  game_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL,
  actor TEXT NOT NULL,                        -- buyer | seller | admin | system
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,                   -- dikirim ke payment gateway sebagai order_id
  purpose TEXT NOT NULL,                      -- order | topup
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,                    -- total yang harus dibayar di gateway
  fee INTEGER NOT NULL DEFAULT 0,             -- biaya metode bayar
  credit INTEGER NOT NULL DEFAULT 0,          -- nominal saldo yang ditambahkan (khusus top up)
  method TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,                       -- pending | paid | failed
  redirect_url TEXT,
  raw TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  kind TEXT NOT NULL,                         -- topup | purchase | payout | refund | withdraw | withdraw_reject
  ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  bank TEXT NOT NULL,
  account_no TEXT NOT NULL,
  account_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | paid | rejected
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  order_id INTEGER REFERENCES orders(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (order_id, product_id)
);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  board TEXT NOT NULL,
  cat TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER REFERENCES products(id),
  pinned INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL REFERENCES users(id),
  to_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_id, to_id);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Menambah kolom baru ke database yang dibuat versi lama, tanpa menghapus data.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
  if (!cols.includes('terms')) db.exec("ALTER TABLE products ADD COLUMN terms TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('image')) db.exec('ALTER TABLE products ADD COLUMN image TEXT');
}

// Menjalankan fn di dalam satu transaksi. Bisa dipanggil bertingkat: hanya lapisan terluar yang COMMIT.
const depth = new WeakMap();
function tx(db, fn) {
  const d = depth.get(db) || 0;
  if (d > 0) {
    depth.set(db, d + 1);
    try { return fn(); } finally { depth.set(db, d); }
  }
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

module.exports = { open, tx };
