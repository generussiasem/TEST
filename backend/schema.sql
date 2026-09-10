-- Skema Kasir Warung + PPOB (Cloudflare D1)

CREATE TABLE IF NOT EXISTS store_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), -- selalu 1 baris
  store_name TEXT NOT NULL DEFAULT 'Toko Saya',
  address TEXT,
  logo_url TEXT
);
INSERT OR IGNORE INTO store_settings (id, store_name) VALUES (1, 'Toko Saya');

-- Karyawan/kasir & admin yang login ke dashboard web
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'kasir', -- admin | kasir
  telegram_id TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Akun/dompet: Tunai, Bank, E-Wallet, Saldo Distributor XL, dst
CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'umum', -- umum | distributor_ppob
  balance INTEGER NOT NULL DEFAULT 0, -- dalam rupiah (integer, hindari float)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,        -- kode produk PPOB, mis. "TSEL5" (kosong utk barang warung biasa)
  barcode TEXT UNIQUE,     -- barcode fisik barang warung (kosong utk produk PPOB)
  name TEXT NOT NULL,
  category TEXT,           -- kasar: "PULSA", "TAGIHAN", dst (field "kategori" OkeConnect)
  product_group TEXT,      -- lebih spesifik: "Telkomsel", "Masa Aktif Axis", "SMS Telepon Indosat" (field "produk" OkeConnect)
  cost_price INTEGER NOT NULL DEFAULT 0,
  sell_price INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_code ON products(code);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_group ON products(product_group);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  type TEXT NOT NULL DEFAULT 'pelanggan', -- pelanggan | supplier
  total_debt INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Satu transaksi = satu struk (bisa berisi banyak barang lewat transaction_items)
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL, -- sale | purchase | expense | mutation
  category TEXT,
  wallet_id INTEGER REFERENCES wallets(id),
  amount INTEGER NOT NULL,       -- total nominal transaksi
  cost_total INTEGER NOT NULL DEFAULT 0, -- total modal (buat hitung laba kotor)
  note TEXT,
  contact_id INTEGER REFERENCES contacts(id),
  employee_id INTEGER REFERENCES employees(id), -- kasir yang input
  created_at TEXT DEFAULT (datetime('now'))
);

-- Rincian barang per transaksi (dipakai saat scan barcode banyak item)
CREATE TABLE IF NOT EXISTS transaction_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  product_id INTEGER REFERENCES products(id),
  qty INTEGER NOT NULL DEFAULT 1,
  cost_price INTEGER NOT NULL DEFAULT 0, -- disalin saat transaksi (modal bisa berubah nanti)
  sell_price INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS debts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  date TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL, -- utang | piutang | cicilan
  amount INTEGER NOT NULL,
  note TEXT
);

-- Transaksi PPOB via Jabber (OkeConnect)
CREATE TABLE IF NOT EXISTS ppob_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_id TEXT UNIQUE NOT NULL,       -- ID unik dikirim ke OkeConnect (dipakai di format R#{ID})
  telegram_chat_id TEXT NOT NULL,
  product_code TEXT NOT NULL,        -- {KODE}
  target TEXT NOT NULL,              -- {NO_HP} atau {ID_PLGN}
  cost_price INTEGER NOT NULL DEFAULT 0,
  sell_price INTEGER NOT NULL DEFAULT 0,
  wallet_id INTEGER REFERENCES wallets(id), -- akun "Saldo Distributor" yang dipotong
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sukses | gagal
  raw_reply TEXT,
  finalized INTEGER NOT NULL DEFAULT 0, -- 1 = sudah dicatat manual sebagai transaksi (khusus order postpaid/tagihan)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
