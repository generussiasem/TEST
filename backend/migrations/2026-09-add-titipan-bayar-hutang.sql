-- Migrasi: pembayaran hutang tercatat ke dompet + saldo TITIPAN pelanggan
--
-- WAJIB dijalankan SEBELUM kode baru di-deploy (kode baru langsung memakai
-- kolom-kolom ini; kalau belum ada, transaksi kasir akan error).
-- Jalankan lewat Dashboard Cloudflare -> D1 -> kasir-ppob-db -> Console,
-- atau: npx wrangler d1 execute kasir-ppob-db --remote --file=migrations/2026-09-add-titipan-bayar-hutang.sql
--
-- Aman diulang: kalau kolom sudah ada akan error "duplicate column name" —
-- abaikan saja, data tidak berubah. Tidak ada data lama yang diubah.

-- Saldo titipan per pelanggan (kembalian yang dititipkan, dst)
ALTER TABLE contacts ADD COLUMN deposit INTEGER NOT NULL DEFAULT 0;

-- Bagian penjualan yang dibayar pakai titipan (tidak menambah dompet)
ALTER TABLE transactions ADD COLUMN deposit_used INTEGER NOT NULL DEFAULT 0;

-- Catatan hutang/titipan tertaut ke dompet & transaksi (tanpa FOREIGN KEY,
-- sengaja, supaya cron pembersihan transaksi > 1 tahun tidak kena error FK)
ALTER TABLE debts ADD COLUMN wallet_id INTEGER;
ALTER TABLE debts ADD COLUMN transaction_id INTEGER;

-- Rincian titipan di snapshot Pertumbuhan Modal
ALTER TABLE modal_snapshots ADD COLUMN titipan INTEGER NOT NULL DEFAULT 0;
