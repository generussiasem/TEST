// ---------------------------------------------------------------------------
// Fitur "Pertumbuhan Modal": modal dihitung sebagai ASET BERSIH PENUH toko —
//   kas + saldo dompet/bank  (semua isi tabel wallets, termasuk saldo
//                             distributor PPOB — itu tetap uang milik toko,
//                             cuma "dititip" di distributor)
// + nilai stok barang         (stock * cost_price produk fisik yang aktif —
//                             pakai harga MODAL, bukan harga jual, supaya
//                             tidak mengembungkan aset dengan margin belum
//                             terealisasi)
// + piutang                   (total_debt kontak bertipe 'pelanggan')
// - hutang                    (total_debt kontak bertipe 'supplier')
//
// "Modal Awal" adalah titik nol pembanding: diambil OTOMATIS dari hasil
// hitungan aset bersih pada hari pertama fitur ini aktif (snapshot harian
// pertama yang berhasil dibuat), lalu bisa diedit manual kapan saja lewat
// halaman Pengaturan kalau perlu dikoreksi. Tidak ada backfill riwayat lama
// — snapshot mulai dihitung maju sejak hari pertama cron ini jalan.
// ---------------------------------------------------------------------------

export async function hitungAsetBersih(env) {
  const [walletRow, stokRow, piutangRow, hutangRow] = await Promise.all([
    env.DB.prepare("SELECT COALESCE(SUM(balance), 0) AS total FROM wallets").first(),
    env.DB.prepare("SELECT COALESCE(SUM(stock * cost_price), 0) AS total FROM products WHERE active = 1").first(),
    env.DB.prepare("SELECT COALESCE(SUM(total_debt), 0) AS total FROM contacts WHERE type = 'pelanggan'").first(),
    env.DB.prepare("SELECT COALESCE(SUM(total_debt), 0) AS total FROM contacts WHERE type = 'supplier'").first(),
  ]);

  const kasDompet = walletRow.total;
  const nilaiStok = stokRow.total;
  const piutang = piutangRow.total;
  const hutang = hutangRow.total;
  const asetBersih = kasDompet + nilaiStok + piutang - hutang;

  return { kasDompet, nilaiStok, piutang, hutang, asetBersih };
}

// Dipanggil oleh cron harian (lihat scheduled() di index.js). Mencatat 1 baris
// snapshot untuk "hari ini", dan kalau ini snapshot PERTAMA yang pernah ada
// (modal_awal belum diisi sama sekali), otomatis jadikan sebagai Modal Awal.
export async function catatSnapshotModalHarian(env) {
  const tanggal = new Date().toISOString().slice(0, 10);
  const { kasDompet, nilaiStok, piutang, hutang, asetBersih } = await hitungAsetBersih(env);

  await env.DB.prepare(
    `INSERT INTO modal_snapshots (tanggal, kas_dompet, nilai_stok, piutang, hutang, aset_bersih)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tanggal) DO UPDATE SET
       kas_dompet = excluded.kas_dompet,
       nilai_stok = excluded.nilai_stok,
       piutang = excluded.piutang,
       hutang = excluded.hutang,
       aset_bersih = excluded.aset_bersih`
  )
    .bind(tanggal, kasDompet, nilaiStok, piutang, hutang, asetBersih)
    .run();

  const settings = await env.DB.prepare("SELECT modal_awal FROM store_settings WHERE id = 1").first();
  if (settings && settings.modal_awal === null) {
    await env.DB.prepare("UPDATE store_settings SET modal_awal = ?, modal_awal_tanggal = ? WHERE id = 1")
      .bind(asetBersih, tanggal)
      .run();
  }
}
