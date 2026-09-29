-- Migrasi koreksi: hapus FOREIGN KEY portalpulsa_deposits.transaction_id ->
-- transactions(id). Untuk database yang SUDAH menjalankan versi lama migrasi
-- 2026-09-27 (yang memakai REFERENCES). Kalau Anda menjalankan versi migrasi
-- 2026-09-27 yang sudah diperbaiki, file ini tetap aman dijalankan (hasil
-- akhirnya sama, data tidak berubah).
--
-- Kenapa: cron cleanupOldData (index.js) menghapus transaksi > 1 tahun dalam
-- satu perintah DELETE. D1 menegakkan FK, jadi begitu ada mutasi deposit
-- berumur > 1 tahun yang masih ditunjuk baris deposit, DELETE itu gagal
-- "FOREIGN KEY constraint failed" dan pembersihan harian berhenti total
-- (bukan cuma baris itu). SQLite tidak bisa DROP kolom yang ikut FK, jadi
-- tabel dibangun ulang. Semua kolom & datanya disalin apa adanya.
-- Jalankan SEKALI. Tabel kecil (riwayat deposit), aman untuk rebuild.

CREATE TABLE portalpulsa_deposits_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank TEXT NOT NULL,
  nominal INTEGER NOT NULL,
  raw_reply TEXT,
  employee_id INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'pending',
  nominal_transfer INTEGER,
  wallet_id INTEGER REFERENCES wallets(id),
  distributor_wallet_id INTEGER REFERENCES wallets(id),
  transaction_id INTEGER,
  updated_at TEXT
);

INSERT INTO portalpulsa_deposits_new
  (id, bank, nominal, raw_reply, employee_id, created_at, status, nominal_transfer, wallet_id, distributor_wallet_id, transaction_id, updated_at)
SELECT
  id, bank, nominal, raw_reply, employee_id, created_at, status, nominal_transfer, wallet_id, distributor_wallet_id, transaction_id, updated_at
FROM portalpulsa_deposits;

DROP TABLE portalpulsa_deposits;
ALTER TABLE portalpulsa_deposits_new RENAME TO portalpulsa_deposits;
