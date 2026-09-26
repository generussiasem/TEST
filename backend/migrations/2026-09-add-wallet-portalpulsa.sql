-- Migrasi: tambah dompet distributor_ppob baru utk provider portalpulsa.
-- Skema wallets sudah generic (kolom provider bebas isi apa saja), jadi
-- migrasi ini cuma INSERT satu baris — TIDAK ada perubahan struktur tabel.
-- Jalankan SEKALI SAJA. Aman diulang berkat WHERE NOT EXISTS di bawah
-- (kalau sudah pernah jalan, INSERT ini tidak melakukan apa-apa lagi).
--
-- Saldo awal sengaja 0 — SESUAIKAN manual lewat halaman Dompet setelah
-- migrasi ini jalan (isi sama dengan saldo asli di akun portalpulsa Anda),
-- atau biarkan 0 dan tunggu sinkron otomatis lewat cron checkDistributorBalance
-- tiap 00/06/12/18 UTC (lihat ppob.js) — TAPI cron ini menimpa balance
-- langsung dgn hasil parse balasan "S PIN", jadi kalau formatnya ternyata
-- meleset dari asumsi (lihat catatan parseBalanceReply di ppob.js), lebih
-- aman isi manual dulu sekali di awal.
INSERT INTO wallets (name, type, balance, provider)
SELECT 'Saldo Distributor portalpulsa', 'distributor_ppob', 0, 'portalpulsa'
WHERE NOT EXISTS (
  SELECT 1 FROM wallets WHERE type = 'distributor_ppob' AND provider = 'portalpulsa'
);
