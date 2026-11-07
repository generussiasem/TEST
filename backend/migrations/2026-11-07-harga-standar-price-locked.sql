-- Harga jual standar (HPP + persentase laba): kolom penanda "Kunci harga".
-- Produk dengan price_locked = 1 TIDAK ditimpa harga standar saat modalnya berubah.
-- Persentase & pembulatan disimpan di tabel app_state (tidak perlu tabel baru):
-- diatur admin di Pengaturan -> "Harga Jual Standar".
--
-- JALANKAN SEKALI, SEBELUM deploy kode baru (kode baru membaca kolom ini):
--   npx wrangler d1 execute kasir-ppob-db --remote --file=migrations/2026-11-07-harga-standar-price-locked.sql
ALTER TABLE products ADD COLUMN price_locked INTEGER NOT NULL DEFAULT 0;
