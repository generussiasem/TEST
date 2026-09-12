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
  link_code TEXT,           -- kode sekali-pakai buat "/hubung KODE" di bot admin/kasir
  link_code_expires TEXT,   -- kedaluwarsa link_code (biasanya +10 menit dari dibuat)
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Akun/dompet: Tunai, Bank, E-Wallet, Saldo Distributor XL, dst
CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'umum', -- umum | distributor_ppob
  balance INTEGER NOT NULL DEFAULT 0, -- dalam rupiah (integer, hindari float)
  provider TEXT, -- okeconnect | digiflazz, hanya relevan kalau type='distributor_ppob'
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wallets_provider ON wallets(provider);

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
  active INTEGER NOT NULL DEFAULT 1,      -- 0 = produk PPOB sudah hilang dari daftar harga sumbernya (soft-delete)
  deactivated_at TEXT,                    -- kapan jadi nonaktif, dipakai utk hard-delete otomatis setelah >1 tahun
  last_synced_at TEXT,                    -- ditandai tiap kali sinkron melihat kode ini masih ada di sumber
  provider TEXT NOT NULL DEFAULT 'okeconnect', -- okeconnect | digiflazz — menentukan jalur Jabber mana yang dipakai saat order
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_code ON products(code);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_group ON products(product_group);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_products_provider ON products(provider);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  type TEXT NOT NULL DEFAULT 'pelanggan', -- pelanggan | supplier
  total_debt INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ID pelanggan fleksibel per kategori (No. BPJS, ID PLN, No. Pelanggan PDAM,
-- dst) — tidak dibatasi jenis tertentu, satu kontak boleh punya banyak ID
-- dari kategori yang sama (mis. 2 meteran listrik berbeda).
CREATE TABLE IF NOT EXISTS contact_ids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  category TEXT NOT NULL,  -- bebas: "BPJS", "PLN", "PDAM", "TV Kabel", dst
  id_number TEXT NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contact_ids_contact ON contact_ids(contact_id);

-- Shift kasir (buka/tutup kas, kas opname). Didefinisikan sebelum transactions
-- karena transactions.shift_id mereferensikan tabel ini.
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  wallet_id INTEGER NOT NULL REFERENCES wallets(id), -- akun kas fisik yang di-opname, mis. "Kas Tunai"
  opening_balance INTEGER NOT NULL DEFAULT 0, -- hasil hitung fisik saat buka shift
  opening_note TEXT,
  opened_at TEXT DEFAULT (datetime('now')),
  closing_balance INTEGER,  -- hasil hitung fisik saat tutup shift
  expected_balance INTEGER, -- dihitung sistem: opening_balance + pergerakan transaksi selama shift
  difference INTEGER,       -- closing_balance - expected_balance (positif = lebih, negatif = kurang)
  closing_note TEXT,
  closed_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' -- open | closed
);
CREATE INDEX IF NOT EXISTS idx_shifts_employee ON shifts(employee_id);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);

-- Satu transaksi = satu struk (bisa berisi banyak barang lewat transaction_items)
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL, -- sale | purchase | expense | mutation
  category TEXT,
  wallet_id INTEGER REFERENCES wallets(id),      -- utk mutation: akun ASAL
  to_wallet_id INTEGER REFERENCES wallets(id),   -- cuma diisi kalau type='mutation': akun TUJUAN
  amount INTEGER NOT NULL,       -- total nominal transaksi
  cost_total INTEGER NOT NULL DEFAULT 0, -- total modal (buat hitung laba kotor)
  note TEXT,
  contact_id INTEGER REFERENCES contacts(id),
  employee_id INTEGER REFERENCES employees(id), -- kasir yang input
  shift_id INTEGER REFERENCES shifts(id), -- shift kasir yang sedang berjalan saat transaksi dibuat (kalau ada)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transactions_shift ON transactions(shift_id);

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

-- Transaksi PPOB via Jabber (OkeConnect dan/atau Digiflazz)
CREATE TABLE IF NOT EXISTS ppob_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_id TEXT UNIQUE NOT NULL,       -- ID unik dikirim ke provider (dipakai di format R#{ID})
  telegram_chat_id TEXT NOT NULL,
  product_code TEXT NOT NULL,        -- {KODE}
  target TEXT NOT NULL,              -- {NO_HP} atau {ID_PLGN}
  cost_price INTEGER NOT NULL DEFAULT 0,
  sell_price INTEGER NOT NULL DEFAULT 0,
  wallet_id INTEGER REFERENCES wallets(id), -- akun "Saldo Distributor" yang dipotong
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sukses | gagal
  raw_reply TEXT,
  token_code TEXT,                      -- kode token PLN (diekstrak otomatis atau dikoreksi manual)
  paid_method TEXT NOT NULL DEFAULT 'tunai', -- tunai | utang
  contact_id INTEGER REFERENCES contacts(id), -- wajib diisi kalau paid_method='utang'
  batch_id TEXT,                        -- grup order dari satu kali "Proses Semua" keranjang PPOB, buat gabung 1 struk
  finalized INTEGER NOT NULL DEFAULT 0, -- 1 = SUDAH dicatat sebagai transaksi (harga jual final terkonfirmasi/terkunci), berlaku utk semua kategori (bukan cuma postpaid lagi)
  auto_checked INTEGER NOT NULL DEFAULT 0, -- 1 = sudah dicek otomatis sekali oleh cron (5 menit setelah dibuat); cron tidak akan cek lagi setelah ini, sisanya lewat tombol manual
  provider TEXT NOT NULL DEFAULT 'okeconnect', -- okeconnect | digiflazz — jalur Jabber mana yang dipakai order ini
  request_body TEXT,                    -- body pesan Jabber asli yang dikirim (dipakai Digiflazz utk re-check status dgn Trxid sama)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Status alur bot Telegram admin/kasir per-chat (mis. sedang menunggu
-- nominal pembayaran hutang) — lihat backend/src/bot-admin.js.
CREATE TABLE IF NOT EXISTS bot_sessions (
  chat_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  data TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

