import { sendJabberCommand } from "./jabber.js";

// ---------------------------------------------------------------------------
// Konfigurasi per-provider PPOB (jalur Jabber). OkeConnect & Digiflazz jalan
// BERDAMPINGAN — dipilih per-produk lewat kolom products.provider, BUKAN
// pengaturan global. Semua lewat Jabber (bukan REST API Digiflazz) karena
// REST API mewajibkan whitelist IP statis yang tidak tersedia di Cloudflare
// Worker, sedangkan Jabber tidak mensyaratkan itu.
//
// CATATAN JUJUR (belum pernah diuji ke server Digiflazz asli — format diambil
// dari developer.digiflazz.com/jabber/):
// - Prabayar (pulsa/kuota/token): "KODE.NOMOR.PIN R#TRXID" (SPASI sebelum R#,
//   beda dari OkeConnect yang pakai TITIK). Cek status = kirim ULANG persis
//   body yang sama (Trxid sama), bukan command "CEK.R#" seperti OkeConnect.
// - Pascabayar (listrik/PDAM/dll) pakai 2 command TERPISAH, TANPA trx id sama
//   sekali (beda total dari prabayar):
//     cek tagihan  -> "cek.KODE.NOMOR.PIN"   (inquiry, tidak potong saldo)
//     bayar tagihan -> "bayar.KODE.NOMOR.PIN" (baru ini yang benar-benar bayar)
//   Digiflazz mensyaratkan bayar dilakukan di HARI YANG SAMA dengan cek-nya.
//   Karena tidak ada trx id, "cek status" ulang utk transaksi bayar TIDAK
//   didukung otomatis di sini (lihat recheckOrder di index.js) — beresiko
//   dobel-bayar kalau command "bayar." dikirim ulang begitu saja.
export function getProviderConfig(env, provider) {
  if (provider === "digiflazz") {
    return {
      provider: "digiflazz",
      jid: env.DIGIFLAZZ_JABBER_JID,
      password: env.DIGIFLAZZ_JABBER_PASSWORD,
      pin: env.DIGIFLAZZ_JABBER_PIN,
      target: env.DIGIFLAZZ_JABBER_TARGET,
      buildPrabayarBody(productCode, target, pin, refId) {
        return `${productCode}.${target}.${pin} R#${refId}`;
      },
      buildPascaCekBody(productCode, target, pin) {
        return `cek.${productCode}.${target}.${pin}`;
      },
      buildPascaBayarBody(productCode, target, pin) {
        return `bayar.${productCode}.${target}.${pin}`;
      },
    };
  }
  // Default: okeconnect (perilaku lama, tidak berubah — cek maupun bayar
  // pascabayar sama-sama pakai suffix "A" di belakang R#{refId}, BELUM
  // dikonfirmasi CS OkeConnect, lihat catatan lama di bawah).
  return {
    provider: "okeconnect",
    jid: env.JABBER_JID,
    password: env.JABBER_PASSWORD,
    pin: env.JABBER_PIN,
    target: env.JABBER_TARGET || "okeconnect@gojabber.com",
    buildPrabayarBody(productCode, target, pin, refId) {
      return `${productCode}.${target}.${pin}.R#${refId}`;
    },
    buildPascaCekBody(productCode, target, pin, refId) {
      return `${productCode}.${target}.${pin}.R#${refId}A`;
    },
    buildPascaBayarBody(productCode, target, pin, refId) {
      return `${productCode}.${target}.${pin}.R#${refId}A`;
    },
  };
}

// PENTING: cek kegagalan DULU (prioritas), baru sukses — dan waspadai kata
// "berhasil"/"sukses" yang DINEGASIKAN (mis. "tidak berhasil", "belum sukses").
export function detectPpobStatus(reply) {
  const failurePattern = /gagal|ditolak|dibatalkan|invalid|salah pin|saldo tidak cukup|tidak dapat diproses|\berror\b/i;
  const negatedSuccess = /\b(tidak|belum|bukan|gak|ga)\s+(ber)?hasil\b|\b(tidak|belum|bukan|gak|ga)\s+sukses\b/i;
  const successPattern = /\bsukses\b|\bberhasil\b/i;
  if (failurePattern.test(reply) || negatedSuccess.test(reply)) return "gagal";
  if (successPattern.test(reply)) return "sukses";
  return "pending";
}

const POSTPAID_CATEGORIES = ["TAGIHAN", "AIR PDAM"];

function isPostpaid(product) {
  return POSTPAID_CATEGORIES.includes(product.category);
}

// Coba tebak kode token PLN dari balasan mentah OkeConnect — pola umum:
// deret 16-20 digit angka, kadang dipisah strip. BELUM ada contoh balasan
// sukses token PLN asli, jadi ini pola tebakan yang bisa meleset; kasir
// tetap bisa koreksi manual di kotak konfirmasi kalau salah/tidak ketemu.
function extractTokenCode(reply) {
  if (!reply) return null;
  const match = reply.match(/\b(\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}(?:[- ]?\d{0,4})?)\b/);
  return match ? match[1] : null;
}

/** Kirim command "Cek" (cek tagihan/cek nama pelanggan) — TIDAK memotong saldo
 * dan TIDAK memengaruhi laporan keuangan, tapi tetap DISIMPAN ke ppob_orders
 * (status 'cek') supaya balasannya bisa dilihat lagi lain waktu.
 * Catatan Digiflazz: khusus produk Samsat, `target` diisi format
 * "KodePembayaran,NomorIdentitas" (dipisah koma) sesuai dokumentasi mereka. */
export async function cekTagihan(env, { productCode, target }) {
  const product = await env.DB.prepare("SELECT * FROM products WHERE code = ?")
    .bind(productCode)
    .first();
  if (!product) {
    throw new Error(`Kode produk "${productCode}" tidak ditemukan.`);
  }
  const cfg = getProviderConfig(env, product.provider);
  const refId = "CEK" + Date.now();
  // Digiflazz: command "cek." khusus pascabayar, tidak pakai refId sama sekali.
  // OkeConnect: perilaku lama tidak berubah (suffix "A" kalau kategori pascabayar).
  const body = isPostpaid(product)
    ? cfg.buildPascaCekBody(productCode, target, cfg.pin, refId)
    : cfg.buildPrabayarBody(productCode, target, cfg.pin, refId);

  let reply = null;
  try {
    reply = await sendJabberCommand({ jid: cfg.jid, password: cfg.password, to: cfg.target, body });
  } catch (err) {
    console.error("Jabber gagal untuk cek", refId, ":", err.message, err.stack);
    reply = "ERROR: " + err.message;
  }

  await env.DB.prepare(
    `INSERT INTO ppob_orders (ref_id, telegram_chat_id, product_code, target, cost_price, sell_price, wallet_id, status, raw_reply, provider, request_body)
     VALUES (?, '', ?, ?, 0, 0, NULL, 'cek', ?, ?, ?)`
  )
    .bind(refId, productCode, target, reply, cfg.provider, body)
    .run();

  return { refId, reply, product };
}

/**
 * Proses satu order PPOB: simpan ke ppob_orders, kirim ke OkeConnect via Jabber.
 * PENTING (berubah dari sebelumnya): order yang sukses TIDAK LAGI otomatis
 * dicatat sebagai transaksi di sini — kasir harus konfirmasi dulu harga jual
 * final lewat endpoint /api/ppob-orders/:refId/konfirmasi (supaya bisa
 * disesuaikan per transaksi, dan supaya bisa dipilih Tunai/Utang). Order yang
 * baru ketahuan sukses lewat CRON (tanpa kasir di depan layar) tetap otomatis
 * tercatat pakai harga default — itu ditangani terpisah di index.js.
 */
export async function placePpobOrder(env, { productCode, target, paidMethod = "tunai", contactId = null, batchId = null }) {
  const product = await env.DB.prepare("SELECT * FROM products WHERE code = ?")
    .bind(productCode)
    .first();
  if (!product) {
    throw new Error(`Kode produk "${productCode}" tidak ditemukan. Coba /cari dulu.`);
  }
  if (paidMethod === "utang" && !contactId) {
    throw new Error("Pembayaran Utang wajib pilih kontak.");
  }

  const cfg = getProviderConfig(env, product.provider);
  const wallet = await env.DB.prepare(
    "SELECT * FROM wallets WHERE type = 'distributor_ppob' AND provider = ? LIMIT 1"
  )
    .bind(cfg.provider)
    .first();

  const refId = "TX" + Date.now();

  // OkeConnect: pulsa/kuota/token prabayar pakai R#{ID} biasa, tagihan
  // pascabayar (listrik, PDAM, BPJS) pakai R#{ID}A (suffix "A") — CATATAN:
  // asumsi berdasarkan pola kategori, BELUM dikonfirmasi CS OkeConnect,
  // wajib dites dulu dengan transaksi kecil.
  // Digiflazz: pascabayar pakai command "bayar." yang SAMA SEKALI BEDA dari
  // prabayar (bukan cuma suffix) — lihat catatan di getProviderConfig. Ini
  // yang BENAR-BENAR MEMBAYAR tagihan, wajib sudah "Cek Tagihan" (cekTagihan())
  // di HARI YANG SAMA sebelum memanggil ini, sesuai syarat Digiflazz.
  const body = isPostpaid(product)
    ? cfg.buildPascaBayarBody(productCode, target, cfg.pin, refId)
    : cfg.buildPrabayarBody(productCode, target, cfg.pin, refId);

  await env.DB.prepare(
    `INSERT INTO ppob_orders (ref_id, telegram_chat_id, product_code, target, cost_price, sell_price, wallet_id, status, paid_method, contact_id, batch_id, provider, request_body)
     VALUES (?, '', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
  )
    .bind(refId, productCode, target, product.cost_price, product.sell_price, wallet ? wallet.id : null, paidMethod, contactId, batchId, cfg.provider, body)
    .run();

  let status = "pending";
  let reply = null;

  try {
    reply = await sendJabberCommand({ jid: cfg.jid, password: cfg.password, to: cfg.target, body });
    status = detectPpobStatus(reply);
  } catch (err) {
    console.error("Jabber gagal untuk order", refId, ":", err.message, err.stack);
    reply = "ERROR: " + err.message;
    status = "pending"; // nanti ditangkap cron checkPendingOrders
  }

  const tokenCode = status === "sukses" ? extractTokenCode(reply) : null;
  await env.DB.prepare(
    "UPDATE ppob_orders SET status = ?, raw_reply = ?, token_code = ?, updated_at = datetime('now') WHERE ref_id = ?"
  )
    .bind(status, reply, tokenCode, refId)
    .run();

  return {
    refId,
    status,
    reply,
    product,
    tokenCode,
    needsConfirm: status === "sukses", // kasir masih di depan layar, tampilkan kotak konfirmasi harga sebelum dicatat
  };
}

/** Catat penjualan PPOB sebagai transaksi & potong saldo distributor.
 * sellPrice bisa di-override (hasil konfirmasi kasir) — kalau tidak diisi,
 * pakai harga default produk (dipakai jalur cron/otomatis tanpa kasir).
 * costTotal HANYA relevan utk kategori pascabayar (tagihan/PDAM) — nominal
 * tagihan asli beda-beda tiap transaksi, dibaca dari balasan OkeConnect,
 * BUKAN harga tetap seperti pulsa/kuota. Untuk prabayar, costTotal selalu
 * ikut product.cost_price apa adanya (tidak pernah bisa diedit manual). */
export async function recordPpobSale(env, { product, wallet, refId, target, sellPrice, costTotal, paidMethod = "tunai", contactId = null }) {
  const finalSellPrice = sellPrice != null ? sellPrice : product.sell_price;
  const finalCostTotal = isPostpaid(product) && costTotal != null ? costTotal : product.cost_price;

  const walletIdForTx = paidMethod === "utang" ? null : wallet ? wallet.id : null;
  const txResult = await env.DB.prepare(
    `INSERT INTO transactions (type, category, wallet_id, amount, cost_total, note, contact_id)
     VALUES ('sale', 'PPOB', ?, ?, ?, ?, ?)`
  )
    .bind(
      walletIdForTx,
      finalSellPrice,
      finalCostTotal,
      `PPOB ${product.code} ke ${target} (ref ${refId})`,
      paidMethod === "utang" ? contactId : null
    )
    .run();

  // Saldo distributor OkeConnect tetap terpotong sejumlah MODAL, terlepas
  // pelanggan bayar tunai atau ngutang — karena uang ke OkeConnect memang
  // sudah keluar duluan begitu order sukses (ditalangi dulu oleh toko).
  if (wallet) {
    await env.DB.prepare("UPDATE wallets SET balance = balance - ? WHERE id = ?")
      .bind(finalCostTotal, wallet.id)
      .run();
  }

  // Kalau dibayar Utang: yang jadi piutang cuma bagian HARGA JUAL yang belum
  // diterima dari pelanggan (modal sudah keluar duluan seperti di atas).
  if (paidMethod === "utang" && contactId) {
    await env.DB.prepare(
      `INSERT INTO debts (contact_id, type, amount, note) VALUES (?, 'piutang', ?, ?)`
    )
      .bind(contactId, finalSellPrice, `PPOB ${product.code} ke ${target} (ref ${refId})`)
      .run();
    await env.DB.prepare("UPDATE contacts SET total_debt = total_debt + ? WHERE id = ?")
      .bind(finalSellPrice, contactId)
      .run();
  }

  return { transactionId: txResult.meta?.last_row_id, sellPrice: finalSellPrice, costTotal: finalCostTotal };
}

/** Konfirmasi harga jual final SETELAH order PPOB sukses, lalu benar-benar
 * mencatatnya sebagai transaksi (memotong saldo distributor & mengunci harga).
 * Dipakai bersama oleh endpoint web (POST /api/ppob-orders/:refId/konfirmasi)
 * DAN bot Telegram admin/kasir (menu "Konfirmasi Order PPOB") — supaya kedua
 * jalur itu benar-benar satu logika yang sama, bukan diduplikasi & bisa beda
 * perilaku. Lempar Error kalau order tidak valid/sudah final. */
export async function finalizePpobOrder(env, { refId, sellPrice, costTotal, tokenCode, paidMethod, contactId }) {
  if (sellPrice === undefined || sellPrice === null) {
    throw new Error("sellPrice wajib diisi");
  }
  const order = await env.DB.prepare("SELECT * FROM ppob_orders WHERE ref_id = ?").bind(refId).first();
  if (!order) throw new Error("Order tidak ditemukan");
  if (order.status !== "sukses") throw new Error("Order belum sukses, tidak bisa dikonfirmasi");
  if (order.finalized) throw new Error("Order ini sudah pernah dicatat sebelumnya");

  const product = await env.DB.prepare("SELECT * FROM products WHERE code = ?").bind(order.product_code).first();
  if (!product) throw new Error(`Produk ${order.product_code} sudah tidak ada di katalog`);
  const wallet = order.wallet_id
    ? await env.DB.prepare("SELECT * FROM wallets WHERE id = ?").bind(order.wallet_id).first()
    : null;

  const finalPaidMethod = paidMethod || order.paid_method || "tunai";
  const finalContactId = contactId ?? order.contact_id ?? null;
  if (finalPaidMethod === "utang" && !finalContactId) {
    throw new Error("Pembayaran Utang wajib pilih kontak");
  }

  const { transactionId, costTotal: appliedCostTotal } = await recordPpobSale(env, {
    product,
    wallet,
    refId,
    target: order.target,
    sellPrice,
    costTotal,
    paidMethod: finalPaidMethod,
    contactId: finalContactId,
  });

  // Harga jual yang barusan dikonfirmasi jadi default baru produk ini utk
  // transaksi berikutnya.
  await env.DB.prepare("UPDATE products SET sell_price = ? WHERE id = ?").bind(sellPrice, product.id).run();

  await env.DB.prepare(
    "UPDATE ppob_orders SET finalized = 1, sell_price = ?, cost_price = ?, token_code = ?, paid_method = ?, contact_id = ? WHERE ref_id = ?"
  )
    .bind(sellPrice, appliedCostTotal, tokenCode ?? order.token_code, finalPaidMethod, finalContactId, refId)
    .run();

  return { transactionId, sellPrice, costTotal: appliedCostTotal, tokenCode: tokenCode ?? order.token_code };
}

/** Ambil daftar harga terbaru dari OkeConnect dan sinkronkan ke tabel products
 * (upsert + soft-delete otomatis kode yang sudah hilang dari sumber). Dipakai
 * baik oleh endpoint manual (tombol "Sinkron Harga PPOB") maupun cron otomatis
 * tiap 8 jam. HANYA untuk provider OkeConnect — produk provider=digiflazz
 * ditambahkan/diedit manual lewat CRUD /api/products untuk sekarang (lihat
 * catatan di getProviderConfig soal belum jelasnya format balasan "H." Jabber
 * Digiflazz untuk sinkronisasi otomatis).
 *
 * sell_price TIDAK lagi otomatis ditambah markup tetap — defaultnya SAMA
 * dengan cost_price (untung Rp0) supaya harga jual harus ditentukan sendiri
 * (manual per produk lewat halaman Produk), bukan margin pukul-rata yang
 * bisa salah untuk produk mahal/murah. */
export async function syncPpobPrices(env) {
  if (!env.PRICE_LIST_URL) {
    return { ok: false, error: "Secret PRICE_LIST_URL belum diisi di Worker Settings → Variables and Secrets" };
  }

  let list;
  try {
    const res = await fetch(env.PRICE_LIST_URL);
    if (!res.ok) {
      return { ok: false, error: `Gagal ambil daftar harga, server balas status ${res.status}` };
    }
    const data = await res.json();
    list = Array.isArray(data) ? data : data.data || data.result || [];
  } catch (err) {
    return { ok: false, error: "Gagal ambil/baca daftar harga: " + err.message };
  }

  const runStartedAt = new Date().toISOString();

  const stmt = env.DB.prepare(
    `INSERT INTO products (code, name, category, product_group, cost_price, sell_price, active, deactivated_at, last_synced_at, provider)
     VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, 'okeconnect')
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name,
       category = excluded.category,
       product_group = excluded.product_group,
       cost_price = excluded.cost_price,
       active = 1,
       deactivated_at = NULL,
       last_synced_at = excluded.last_synced_at`
  );

  const batchItems = [];
  let skipped = 0;
  for (const item of list) {
    const code = item.kode || item.code || item.product_code;
    const name = item.keterangan || item.produk || item.nama || item.name;
    const category = item.kategori || item.category || null;
    const productGroup = item.produk || null;
    const cost = Number(item.harga || item.price || 0);
    // Tanpa markup default: harga jual awal = harga modal (untung Rp0) saat
    // produk baru pertama kali muncul. Untuk produk yang SUDAH ada (upsert),
    // sell_price sengaja TIDAK ditimpa di sini (lihat ON CONFLICT di atas)
    // supaya harga jual yang sudah diatur manual oleh admin tidak tertindih
    // tiap kali sinkron — hanya cost_price yang ikut update mengikuti sumber.
    const sell = cost;
    if (!code || !name) {
      skipped++;
      continue;
    }
    if (item.status === "0" || item.status === 0) {
      skipped++;
      continue;
    }
    batchItems.push(stmt.bind(code, name, category, productGroup, cost, sell, runStartedAt));
  }

  const BATCH_SIZE = 100;
  let count = 0;
  let lastError = null;
  for (let i = 0; i < batchItems.length; i += BATCH_SIZE) {
    const chunk = batchItems.slice(i, i + BATCH_SIZE);
    try {
      await env.DB.batch(chunk);
      count += chunk.length;
    } catch (err) {
      lastError = `batch mulai index ${i}: ${err.message}`;
    }
  }

  const deactivateRes = await env.DB.prepare(
    `UPDATE products SET active = 0, deactivated_at = datetime('now')
     WHERE code IS NOT NULL AND active = 1 AND (last_synced_at IS NULL OR last_synced_at < ?)`
  )
    .bind(runStartedAt)
    .run();

  return {
    ok: true,
    synced: count,
    total: list.length,
    skipped,
    deactivated: deactivateRes.meta?.changes ?? 0,
    lastError,
  };
}
