-- Migrasi: URL alat cetak struk eksternal (opsional), mis. layanan Cetak
-- Struk dari OkeConnect (https://namatoko.cetakstr.uk/). Jalankan SEBELUM
-- deploy kode baru. Aman diulang — kalau kolom sudah ada, abaikan error
-- "duplicate column name".
ALTER TABLE store_settings ADD COLUMN cetak_struk_url TEXT;
