-- Migrasi: tabel riwayat deposit portalpulsa (perintah "D BANK NOMINAL PIN"
-- dan balasannya). Jalankan SEKALI SAJA. Aman diulang — "CREATE TABLE IF NOT
-- EXISTS" tidak mengubah apa-apa kalau tabel sudah ada.
CREATE TABLE IF NOT EXISTS portalpulsa_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank TEXT NOT NULL,
  nominal INTEGER NOT NULL,        -- nominal yang DIMINTA (tanpa kode unik)
  raw_reply TEXT,                  -- balasan instruksi transfer dari portalpulsa (nominal+kode unik ada di sini)
  employee_id INTEGER REFERENCES employees(id), -- siapa yang kirim (NULL kalau via Telegram tanpa employee terhubung)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
