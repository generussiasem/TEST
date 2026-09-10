import { sendJabberCommand } from "./jabber.js";

// Kategori yang dianggap "tagihan pascabayar" — nominalnya beda-beda per
// pelanggan/bulan, BUKAN harga tetap seperti pulsa. Untuk kategori ini:
//   - ref ID wajib pakai suffix "A" (format dari OkeConnect)
//   - order TIDAK otomatis dicatat sebagai transaksi (karena sell_price di
//     tabel products untuk kategori ini cuma fee, bukan total tagihan asli).
//     Kasir harus konfirmasi manual nominal aslinya lewat endpoint
//     /api/ppob-orders/:ref_id/catat setelah baca balasan OkeConnect.
const POSTPAID_CATEGORIES = ["TAGIHAN", "AIR PDAM"];

function isPostpaid(product) {
  return POSTPAID_CATEGORIES.includes(product.category);
}

/** Kirim command "Cek" (cek tagihan/cek nama pelanggan) — TIDAK memotong saldo
 * dan TIDAK memengaruhi laporan keuangan, tapi tetap DISIMPAN ke ppob_orders
 * (status 'cek') supaya balasannya bisa dilihat lagi lain waktu, mis. lewat
 * D1 Console atau halaman riwayat PPOB. */
export async function cekTagihan(env, { productCode, target }) {
  const product = await env.DB.prepare("SELECT * FROM products WHERE code = ?")
    .bind(productCode)
    .first();
  if (!product) {
    throw new Error(`Kode produk "${productCode}" tidak ditemukan.`);
  }
  const refId = "CEK" + Date.now();
  const suffix = isPostpaid(product) ? "A" : "";
  const body = `${productCode}.${target}.${env.JABBER_PIN}.R#${refId}${suffix}`;

  let reply = null;
  try {
    reply = await sendJabberCommand({
      jid: env.JABBER_JID,
      password: env.JABBER_PASSWORD,
      to: env.JABBER_TARGET || "okeconnect@gojabber.com",
      body,
    });
  } catch (err) {
    console.error("Jabber gagal untuk cek", refId, ":", err.message, err.stack);
    reply = "ERROR: " + err.message;
  }

  // cost_price/sell_price sengaja 0 dan wallet_id NULL — ini cuma pengecekan,
  // bukan transaksi, jadi tidak boleh ikut kehitung di laporan mana pun.
  await env.DB.prepare(
    `INSERT INTO ppob_orders (ref_id, telegram_chat_id, product_code, target, cost_price, sell_price, wallet_id, status, raw_reply)
     VALUES (?, '', ?, ?, 0, 0, NULL, 'cek', ?)`
  )
    .bind(refId, productCode, target, reply)
    .run();

  return { refId, reply, product };
}

/**
 * Proses satu order PPOB: simpan ke ppob_orders, kirim ke OkeConnect via Jabber,
 * lalu kalau sukses catat juga sebagai transaksi penjualan & potong saldo distributor
 * — KECUALI untuk kategori postpaid (tagihan/PDAM), yang harus dikonfirmasi manual
 * dulu lewat /api/ppob-orders/:ref_id/catat karena nominalnya tidak tetap.
 * Dipakai baik dari webhook Telegram (/beli) maupun dari halaman kasir web (/api/ppob/order).
 */
export async function placePpobOrder(env, { productCode, target }) {
  const product = await env.DB.prepare("SELECT * FROM products WHERE code = ?")
    .bind(productCode)
    .first();
  if (!product) {
    throw new Error(`Kode produk "${productCode}" tidak ditemukan. Coba /cari dulu.`);
  }

  const wallet = await env.DB.prepare(
    "SELECT * FROM wallets WHERE type = 'distributor_ppob' LIMIT 1"
  ).first();

  const refId = "TX" + Date.now();
  await env.DB.prepare(
    `INSERT INTO ppob_orders (ref_id, telegram_chat_id, product_code, target, cost_price, sell_price, wallet_id, status)
     VALUES (?, '', ?, ?, ?, ?, ?, 'pending')`
  )
    .bind(refId, productCode, target, product.cost_price, product.sell_price, wallet ? wallet.id : null)
    .run();

  // OkeConnect punya 2 format ref ID: pulsa/kuota/token prabayar pakai
  // R#{ID} biasa, sedangkan tagihan pascabayar (listrik, PDAM, BPJS) pakai
  // R#{ID}A (ada suffix "A"). CATATAN: ini asumsi berdasarkan pola kategori,
  // BELUM dikonfirmasi CS OkeConnect — wajib dites dulu dengan transaksi kecil.
  const suffix = isPostpaid(product) ? "A" : "";
  const body = `${productCode}.${target}.${env.JABBER_PIN}.R#${refId}${suffix}`;
  let status = "pending";
  let reply = null;

  try {
    reply = await sendJabberCommand({
      jid: env.JABBER_JID,
      password: env.JABBER_PASSWORD,
      to: env.JABBER_TARGET || "okeconnect@gojabber.com",
      body,
    });
    if (/sukses|berhasil/i.test(reply)) status = "sukses";
    else if (/gagal|error/i.test(reply)) status = "gagal";
  } catch (err) {
    // Sebelumnya error ini "ditelan" begitu saja jadi tidak kelihatan di mana pun.
    // Sekarang dicatat ke console (muncul di Observability -> Logs, buka Events
    // pada invocation POST /api/ppob/order) DAN disimpan ke raw_reply supaya
    // kelihatan juga langsung di tabel ppob_orders / halaman PPOB.
    console.error("Jabber gagal untuk order", refId, ":", err.message, err.stack);
    reply = "ERROR: " + err.message;
    status = "pending"; // nanti ditangkap cron checkPendingOrders
  }

  await env.DB.prepare(
    "UPDATE ppob_orders SET status = ?, raw_reply = ?, updated_at = datetime('now') WHERE ref_id = ?"
  )
    .bind(status, reply, refId)
    .run();

  if (status === "sukses" && !isPostpaid(product)) {
    await recordPpobSale(env, { product, wallet, refId, target });
  }

  return { refId, status, reply, product, needsManualRecord: status === "sukses" && isPostpaid(product) };
}

/** Catat penjualan PPOB yang sukses sebagai transaksi & potong saldo distributor. */
export async function recordPpobSale(env, { product, wallet, refId, target }) {
  await env.DB.prepare(
    `INSERT INTO transactions (type, category, wallet_id, amount, cost_total, note)
     VALUES ('sale', 'PPOB', ?, ?, ?, ?)`
  )
    .bind(
      wallet ? wallet.id : null,
      product.sell_price,
      product.cost_price,
      `PPOB ${product.code} ke ${target} (ref ${refId})`
    )
    .run();

  if (wallet) {
    await env.DB.prepare("UPDATE wallets SET balance = balance - ? WHERE id = ?")
      .bind(product.cost_price, wallet.id)
      .run();
  }
}
