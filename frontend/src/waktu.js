// Waktu dari database (D1 `datetime('now')`) disimpan dalam UTC dengan format
// "YYYY-MM-DD HH:MM:SS" TANPA keterangan zona. new Date("2026-10-25 12:00:00")
// membacanya sebagai waktu LOKAL browser, jadi jam yang tampil mundur 7 jam
// dari WIB. Semua tampilan waktu lewat helper ini: baca sebagai UTC, tampilkan
// dalam zona Asia/Jakarta (WIB), apa pun zona perangkatnya.
const ZONA = "Asia/Jakarta";

export function parseWaktuDb(s) {
  if (!s) return null;
  let t = String(s);
  if (t.length === 19 && t.charAt(10) === " ") t = t.replace(" ", "T") + "Z";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtWaktu(s) {
  const d = parseWaktuDb(s);
  return d ? d.toLocaleString("id-ID", { timeZone: ZONA }) : "-";
}

export function fmtTgl(s) {
  const d = parseWaktuDb(s);
  return d ? d.toLocaleDateString("id-ID", { timeZone: ZONA }) : "-";
}

// Tanggal "hari ini" menurut WIB, format YYYY-MM-DD (untuk filter laporan).
export function hariIniWib() {
  return new Date().toLocaleDateString("en-CA", { timeZone: ZONA });
}

export function awalBulanWib() {
  return hariIniWib().slice(0, 8) + "01";
}
