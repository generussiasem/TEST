-- SEBELUM: code TEXT UNIQUE (satu kode cuma boleh 1 produk di SELURUH tabel,
-- lintas provider). SESUDAH: UNIQUE(code, provider) — kode yang sama boleh
-- dipakai provider yang beda. Ini perlu karena kode produk DITENTUKAN
-- distributor (OkeConnect / portalpulsa) — bukan sesuatu yang bisa kita ubah
-- sepihak kalau kebetulan ada tabrakan kode antar provider.
--
-- SQLite tidak bisa ALTER TABLE ... DROP CONSTRAINT, jadi tabel dibuat ulang:
-- 1) matikan penegakan FOREIGN KEY sementara (transaction_items.product_id
--    menunjuk products.id — kalau tidak dimatikan dulu, DROP TABLE products
--    di bawah akan gagal "FOREIGN KEY constraint failed")
-- 2) buat products_new dgn constraint baru
-- 3) salin SEMUA kolom & baris apa adanya, termasuk id (supaya referensi FK
--    dari transaction_items.product_id tetap valid setelah tabel diganti)
-- 4) hapus tabel lama, ganti nama yang baru
-- 5) buat ulang index yang sebelumnya menempel di tabel lama
-- 6) nyalakan lagi penegakan FOREIGN KEY
--
-- CADANGKAN DULU sebelum menjalankan ini kalau bisa:
--   npx wrangler d1 export kasir-ppob-db --remote --output=backup-sebelum-migrasi-code.sql
-- Jalankan SEKALI.

PRAGMA foreign_keys = OFF;

CREATE TABLE products_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  product_group TEXT,
  cost_price INTEGER NOT NULL DEFAULT 0,
  sell_price INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  deactivated_at TEXT,
  last_synced_at TEXT,
  provider TEXT NOT NULL DEFAULT 'okeconnect',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(code, provider)
);

INSERT INTO products_new
  (id, code, barcode, name, category, product_group, cost_price, sell_price,
   stock, active, deactivated_at, last_synced_at, provider, created_at)
SELECT
  id, code, barcode, name, category, product_group, cost_price, sell_price,
  stock, active, deactivated_at, last_synced_at, provider, created_at
FROM products;

DROP TABLE products;
ALTER TABLE products_new RENAME TO products;

CREATE INDEX IF NOT EXISTS idx_products_code ON products(code);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_group ON products(product_group);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_products_provider ON products(provider);

PRAGMA foreign_keys = ON;
