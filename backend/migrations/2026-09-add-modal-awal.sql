-- Migrasi: fitur "Modal Awal" & "Pertumbuhan Modal"
-- Jalankan SEKALI SAJA. Aman diulang: kalau kolom/tabel sudah ada, akan
-- error "duplicate column name" / sejenisnya — abaikan saja, tidak mengubah
-- data yang sudah ada.

ALTER TABLE store_settings ADD COLUMN modal_awal INTEGER;
ALTER TABLE store_settings ADD COLUMN modal_awal_tanggal TEXT; -- tanggal snapshot pertama dipakai sbg titik nol

-- Snapshot harian aset bersih (kas+dompet, nilai stok, piutang, hutang).
-- Diisi otomatis oleh cron tiap hari (lihat catatSnapshotModalHarian di
-- modal.js) — tidak backfill data lama, mulai dihitung maju sejak fitur ini
-- aktif sesuai permintaan.
CREATE TABLE IF NOT EXISTS modal_snapshots (
  tanggal TEXT PRIMARY KEY, -- format YYYY-MM-DD
  kas_dompet INTEGER NOT NULL DEFAULT 0,
  nilai_stok INTEGER NOT NULL DEFAULT 0,
  piutang INTEGER NOT NULL DEFAULT 0,
  hutang INTEGER NOT NULL DEFAULT 0,
  aset_bersih INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
