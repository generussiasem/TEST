-- Migrasi: perluas portalpulsa_deposits untuk alur 3-tahap yang baru
-- ketahuan dari contoh balasan asli:
--   1) "Telah kami terima... Silakan tunggu reply selanjutnya"  (ack, diabaikan)
--   2) "Silakan transfer Rp 50.094 Ke Bank: ..."                (instruksi — nominal
--      SUDAH beda dari yang diketik, ada kode unik tambahan di belakang)
--   3) "Deposit 50.094 SUKSES ... Saldo sekarang Rp 57.536"     ATAU
--      "Request Deposit 50090 DIBATALKAN karena hangus (lebih dari 12jam)"
--      -- ini datang BELAKANGAN, terpisah, kadang berjam-jam kemudian, setelah
--      admin beneran transfer manual. TIDAK bisa langsung didapat saat kirim
--      command "D BANK NOMINAL PIN" (itu cuma sampai balasan tahap 2).
--
-- Karena itu pencatatan mutasi dompet TIDAK BOLEH lagi terjadi optimis begitu
-- balasan tahap 2 diterima (uangnya belum tentu ditransfer) — harus nunggu
-- balasan tahap 3 baru dicatat, dicek berkala lewat cron (lihat
-- checkPendingPortalpulsaDeposits di index.js).
--
-- Jalankan SEKALI SAJA. Aman diulang berkat pengecekan pragma_table_info di
-- bawah (SQLite tidak punya "ADD COLUMN IF NOT EXISTS" bawaan).

ALTER TABLE portalpulsa_deposits ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
-- 'pending'  : sudah kirim command, baru dapat balasan tahap 2 (instruksi transfer), belum ada mutasi dompet
-- 'sukses'   : balasan tahap 3 SUKSES sudah masuk, mutasi dompet SUDAH dicatat
-- 'gagal'    : balasan tahap 3 DIBATALKAN/gagal, ATAU lewat batas waktu tanpa balasan sama sekali — TIDAK ada mutasi

ALTER TABLE portalpulsa_deposits ADD COLUMN nominal_transfer INTEGER;
-- Nominal ASLI yang harus (atau sudah) ditransfer admin, dari balasan tahap 2
-- (beda dari kolom `nominal` yang cuma nominal yang DIKETIK, tanpa kode unik).
-- Dipakai buat mencocokkan balasan tahap 3 mana milik deposit mana (provider
-- menyebut nominal ini, bukan nominal yang diketik, di balasan SUKSES/GAGAL).

ALTER TABLE portalpulsa_deposits ADD COLUMN wallet_id INTEGER REFERENCES wallets(id);
-- Dompet sumber yang DIRENCANAKAN dipotong (dipilih admin saat kirim
-- deposit) — disimpan di sini dulu, BUKAN langsung dipotong, karena
-- pemotongan beneran baru terjadi setelah status jadi 'sukses'.

ALTER TABLE portalpulsa_deposits ADD COLUMN distributor_wallet_id INTEGER REFERENCES wallets(id);
-- Dompet distributor portalpulsa tujuan mutasi — disimpan di sini juga
-- (bukan cuma di-lookup ulang saat cron jalan) supaya kalau suatu saat ada
-- lebih dari satu dompet distributor portalpulsa, tidak salah sasaran.

ALTER TABLE portalpulsa_deposits ADD COLUMN transaction_id INTEGER;
-- SENGAJA TANPA FOREIGN KEY ke transactions (sama seperti debts.transaction_id di
-- schema.sql): cron cleanupOldData menghapus transaksi > 1 tahun, dan kalau kolom
-- ini pakai REFERENCES, DELETE-nya gagal "FOREIGN KEY constraint failed" begitu
-- ada deposit lama yang tertaut — seluruh pembersihan harian ikut berhenti.
-- ID baris transactions (type='mutation') yang tercatat begitu status jadi
-- 'sukses' — dipakai kalau nanti perlu membalikkan (mis. deposit ini
-- ternyata salah/dihapus manual).
