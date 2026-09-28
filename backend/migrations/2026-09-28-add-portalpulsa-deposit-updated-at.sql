-- Migrasi: kolom updated_at di portalpulsa_deposits — waktu STATUS terakhir
-- berubah (pending -> sukses/gagal/expired), ditampilkan sbg "Update" di
-- riwayat deposit (seperti riwayat deposit di aplikasi portalpulsa).
-- Baris lama (sebelum migrasi ini) dibiarkan NULL — tampilan otomatis pakai
-- created_at sebagai gantinya.
-- Jalankan SEKALI SAJA. Kalau kolom sudah ada akan error "duplicate column
-- name" dan tidak mengubah apa-apa lagi (abaikan error itu).

ALTER TABLE portalpulsa_deposits ADD COLUMN updated_at TEXT;
