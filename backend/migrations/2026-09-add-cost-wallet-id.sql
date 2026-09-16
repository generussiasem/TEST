-- Migrasi: tambah kolom cost_wallet_id ke tabel transactions
-- Dipakai utk type='sale' TANPA items yang modalnya dari dompet lain
-- (mis. jasa transfer bank pakai Saldo BCA sendiri) — dompet ini yg
-- dikurangi sebesar cost_total, BUKAN dompet tujuan (wallet_id).
-- Jalankan SEKALI SAJA. Aman diulang: kalau kolom sudah ada, akan error
-- "duplicate column name" dan tidak mengubah apa-apa lagi (abaikan error itu).

ALTER TABLE transactions ADD COLUMN cost_wallet_id INTEGER REFERENCES wallets(id);
