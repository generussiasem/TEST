-- Migrasi: status Relay Jabber (program yang selalu online di HP/PC)
-- Jalankan SEBELUM deploy kode baru (Console D1 atau wrangler d1 execute ... --file=...).
-- Aman diulang (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
