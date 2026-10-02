import { sendJabberCommand } from "./jabber.js";
import { getOpenShiftId } from "./debt.js";
import { rencanaPakaiTitipan, stmtsPakaiTitipan } from "./debt.js";

// ---------------------------------------------------------------------------
// Konfigurasi provider PPOB (jalur Jabber). Dua provider didukung: OkeConnect
// (lengkap, punya price list) dan portalpulsa (tanpa price list — modal baru
// diketahui dari balasan tiap transaksi, lihat usesDynamicCost di bawah).
// Dipilih per-produk lewat kolom products.provider.
export function getProviderConfig(env, provider) {
  if (provider === "portalpulsa") {
    return {
      provider: "portalpulsa",
      // Fallback ke JABBER_JID/JABBER_PASSWORD kalau PORTALPULSA_JID/PASSWORD
      // tidak diisi — dipakai kalau JID Jabber yang sama didaftarkan ke semua
      // provider (kasus Anda: ysudarto@jabb.im dipakai di OkeConnect &
      // portalpulsa). Isi PORTALPULSA_JID/PASSWORD eksplisit HANYA kalau nanti
      // mau pakai akun Jabber yang berbeda utk portalpulsa.
      jid: env.PORTALPULSA_JID || env.JABBER_JID,
      password: env.PORTALPULSA_PASSWORD || env.JABBER_PASSWORD,
      pin: env.PORTALPULSA_PIN,
      target: env.PORTALPULSA_TARGET || "trx@im.portalpulsa.com",
      // Format portalpulsa TIDAK pakai ref id sama sekali (beda dari
      // OkeConnect) — pemisahnya spasi, bukan titik. Konsekuensi pencocokan
      // balasan (jabber.js: acceptAnyFromTarget) sudah didiskusikan & diterima.
      separator: " ",
      buildPrabayarBody(productCode, target, pin, _refId) {
        return `${productCode} ${target} ${pin}`;
      },
      // BELUM didukung: format Token PLN portalpulsa butuh field idpelanggan
      // terpisah ("kode idpelanggan NoHP PIN") yang tidak ada tempatnya di
      // alur order saat ini (cuma productCode + target). Sengaja throw
      // eksplisit daripada diam-diam mengirim perintah yang salah format.
      buildPascaCekBody(productCode, target, pin, refId) {
        throw new Error("Cek tagihan pascabayar belum didukung untuk provider portalpulsa (Token PLN butuh field idpelanggan terpisah).");
      },
      buildPascaBayarBody(productCode, target, pin, refId) {
        throw new Error("Transaksi pascabayar belum didukung untuk provider portalpulsa (Token PLN butuh field idpelanggan terpisah).");
      },
    };
  }
  // Perilaku lama tidak berubah — cek maupun bayar pascabayar sama-sama pakai
  // suffix "A" di belakang R#{refId}, BELUM dikonfirmasi CS OkeConnect, lihat
  // catatan lama di bawah.
  return {
    provider: "okeconnect",
    jid: env.JABBER_JID,
    password: env.JABBER_PASSWORD,
    pin: env.JABBER_PIN,
    target: env.JABBER_TARGET || "okeconnect@gojabber.com",
    separator: ".",
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
  const failurePattern = /gagal|ditolak|dibatalkan|invalid|salah pin|\bsalah\b|saldo tidak cukup|tidak dapat diproses|\berror\b/i;
  const negatedSuccess = /\b(tidak|belum|bukan|gak|ga)\s+(ber)?hasil\b|\b(tidak|belum|bukan|gak|ga)\s+sukses\b/i;
  const successPattern = /\bsukses\b|\bberhasil\b/i;
  if (failurePattern.test(reply) || negatedSuccess.test(reply)) return "gagal";
  if (successPattern.test(reply)) return "sukses";
  return "pending";
}

// ---------------------------------------------------------------------------
// Mencocokkan balasan perintah "CEK.NOMOR" dengan SATU order kita.
//
// Contoh balasan OkeConnect (tanpa ref order!):
//   @21/09/2026 - OK310547
//   FIBN7.085741114833 16:36 Sukses SN :04291288217899834259.
// Yaitu header tanggal, lalu satu baris per transaksi: KODE.TUJUAN JAM Status SN.
// Karena tidak ada ref, order dicocokkan lewat KODE produk + TUJUAN + tanggal +
// jam (harus berdekatan dengan waktu order dibuat). Kalau balasan memuat ref
// order (format lain), ref dipakai lebih dulu. Kalau tidak bisa dicocokkan
// dengan yakin (tidak ada baris cocok, atau lebih dari satu baris cocok dengan
// status berbeda), status TIDAK diubah otomatis.
// Jam di balasan diasumsikan WIB (UTC+7); created_at di database berupa UTC.
// ---------------------------------------------------------------------------
const CEK_WINDOW_MENIT = 60;

function waktuWibOrder(order) {
  const m = String(order.created_at || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const wib = new Date(utcMs + 7 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    tanggal: `${wib.getUTCFullYear()}-${pad(wib.getUTCMonth() + 1)}-${pad(wib.getUTCDate())}`,
    menit: wib.getUTCHours() * 60 + wib.getUTCMinutes(),
  };
}

export function cocokkanBalasanCek(order, reply) {
  if (order.provider === "portalpulsa") return cocokkanBalasanCekPortalpulsa(order, reply);
  const lines = String(reply || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // 1) Balasan memuat ref order -> paling akurat
  const refLines = lines.filter((l) => l.includes(order.ref_id));
  if (refLines.length) {
    return { matched: true, by: "ref", status: detectPpobStatus(refLines.join("\n")), line: refLines.join("\n") };
  }

  // 2) Format "KODE.TUJUAN JAM Status ..." dengan header tanggal "@DD/MM/YYYY"
  const waktu = waktuWibOrder(order);
  const digits = (s) => String(s || "").replace(/\D/g, "");
  const kode = String(order.product_code || "").toLowerCase();
  const tujuan = digits(order.target);
  let tanggalSaatIni = null;
  const kandidat = [];
  for (const line of lines) {
    const h = line.match(/^@\s*(\d{2})\/(\d{2})\/(\d{4})/);
    if (h) {
      tanggalSaatIni = `${h[3]}-${h[2]}-${h[1]}`;
      continue;
    }
    const e = line.match(/^([A-Za-z0-9]+)\.(\S+)\s+(\d{1,2})[:.](\d{2})\s+(.*)$/);
    if (!e) continue;
    if (e[1].toLowerCase() !== kode || digits(e[2]) !== tujuan) continue;
    if (tanggalSaatIni && waktu && tanggalSaatIni !== waktu.tanggal) continue;
    const menit = +e[3] * 60 + +e[4];
    const selisih = waktu ? Math.abs(menit - waktu.menit) : 0;
    if (waktu && selisih > CEK_WINDOW_MENIT) continue;
    kandidat.push({ line, selisih, status: detectPpobStatus(e[5]) });
  }

  if (!kandidat.length) {
    return { matched: false, reason: "tidak ada baris dengan kode produk, nomor tujuan, tanggal, dan jam yang cocok" };
  }
  if (new Set(kandidat.map((k) => k.status)).size > 1) {
    return { matched: false, reason: "ada lebih dari satu transaksi cocok dengan status berbeda" };
  }
  kandidat.sort((a, b) => a.selisih - b.selisih);
  return { matched: true, by: "kode+nomor+jam", status: kandidat[0].status, line: kandidat[0].line };
}

// Balasan "STATUS NoHp" portalpulsa, contoh asli (2026-09-25):
//   @2026-09-25
//   260925120354 S5 085225492482 SUKSES SN:04285200000862029402.
//    # Ayo transaksi terus biar dapet bonus mingguan
// Header tanggal formatnya "@YYYY-MM-DD" (BEDA dari OkeConnect yang
// "@DD/MM/YYYY"), dan baris transaksi TIDAK memuat jam sama sekali — cuma
// "{ID_provider} {kode} {NoHP} {STATUS...}" dipisah spasi. Karena tidak ada
// jam, pencocokan HANYA berdasar kode+nomor tujuan (+tanggal header kalau
// ada) — kalau ada >1 transaksi ke nomor+kode yang sama di hari yang sama
// dengan status berbeda, tetap dianggap ambigu (matched:false) sama seperti
// jalur OkeConnect.
function cocokkanBalasanCekPortalpulsa(order, reply) {
  const lines = String(reply || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const digits = (s) => String(s || "").replace(/\D/g, "");
  const kode = String(order.product_code || "").toLowerCase();
  const tujuan = digits(order.target);
  const kandidat = [];
  for (const line of lines) {
    const h = line.match(/^@\s*(\d{4})-(\d{2})-(\d{2})/);
    if (h) continue; // header tanggal — tidak dipakai utk penyaringan (tak ada jam pembanding)
    // Format daftar balasan "STATUS NoHp": "{id_provider} {kode} {nohp} {status...}"
    const e = line.match(/^(\S+)\s+([A-Za-z0-9]+)\s+(\d{6,})\s+(.*)$/);
    if (e && e[2].toLowerCase() === kode && digits(e[3]) === tujuan) {
      kandidat.push({ line, providerRefId: e[1], status: detectPpobStatus(e[4]) });
      continue;
    }
    // Format balasan transaksi SPONTAN (yang datang sendiri lewat relay begitu
    // provider selesai memproses, tanpa didahului perintah STATUS) — TIDAK ada
    // id_provider di depan, cuma "{kode} {nohp} {status...}", mis.
    // "S5 085225492482 SUKSES. SN: ..." atau "S50 0852... Tidak diproses Saldo
    // tidak cukup...". Tanpa jalur ini, balasan telat portalpulsa yang
    // ditangkap relay tidak akan pernah cocok ke order pending-nya.
    const f = line.match(/^([A-Za-z0-9]+)\s+(\d{6,})\s+(.*)$/);
    if (f && f[1].toLowerCase() === kode && digits(f[2]) === tujuan) {
      kandidat.push({ line, providerRefId: null, status: detectPpobStatus(f[3]) });
    }
  }
  if (!kandidat.length) {
    return { matched: false, reason: "tidak ada baris dengan kode produk dan nomor tujuan yang cocok" };
  }
  if (new Set(kandidat.map((k) => k.status)).size > 1) {
    return { matched: false, reason: "ada lebih dari satu transaksi cocok dengan status berbeda" };
  }
  return { matched: true, by: "kode+nomor(portalpulsa)", status: kandidat[0].status, line: kandidat[0].line };
}

const POSTPAID_CATEGORIES = ["TAGIHAN", "AIR PDAM"];

function isPostpaid(product) {
  return POSTPAID_CATEGORIES.includes(product.category);
}

// portalpulsa TIDAK punya price list (lihat getProviderConfig) — HPP-nya cuma
// diketahui dari field "Harga" di balasan SUKSES tiap transaksi, persis
// seperti modal riil tagihan pascabayar OkeConnect yang juga baru diketahui
// dari balasan, bukan dari product.cost_price. Jadi utk kebutuhan "modal
// harus diisi manual/di-parse dari balasan, bukan angka tetap di katalog",
// portalpulsa diperlakukan sama seperti kategori pascabayar — walau perintah
// yang dikirim ke provider tetap format prabayar biasa (lihat isPostpaid()
// yang dipakai KHUSUS utk pemilihan format perintah, terpisah dari ini).
export function usesDynamicCost(product) {
  return isPostpaid(product) || product.provider === "portalpulsa";
}

// ---------------------------------------------------------------------------
// Parsing detail balasan SUKSES bayar tagihan pascabayar (listrik/PDAM) dari
// OkeConnect. Format umum (contoh listrik PLN):
//   ...SN: NAMA/TAG:35214/ADMIN:4500/TTAG:39714/TARIF:R1/DAYA:900/...
//   Saldo 118.693 - 37.064 = 81.629 @23/09 10:06
//
// - TAG   = tagihan pokok (sebelum admin bank/PLN)
// - ADMIN = admin bank/PLN — bagian RESMI dari tagihan yang wajib dibayar
//   pelanggan, BUKAN komisi toko.
// - TTAG  = total tagihan resmi = TAG + ADMIN. Ini batas MINIMAL yang harus
//   ditagih ke pelanggan (belum termasuk "Admin Loket" milik toko sendiri,
//   yang tidak pernah muncul di balasan OkeConnect — itu kebijakan toko).
// - "Saldo A - B = C" -> B adalah MODAL RIIL yang benar-benar terpotong dari
//   saldo distributor untuk transaksi ini. Field product.cost_price TIDAK
//   BOLEH dipakai sebagai modal pascabayar — itu cuma referensi komisi/insentif
//   rata-rata OkeConnect utk kode produk tsb (lihat catatan di recordPpobSale).
//
// Kalau salah satu pola tidak ketemu (format provider berubah, order belum
// sukses, atau balasan bukan tagihan listrik/PDAM), field terkait dikembalikan
// null — SENGAJA bukan 0, supaya kasir/kode pemanggil tidak salah mengira
// modal Rp0. Regex \bTAG: memakai word-boundary supaya tidak ikut nyantol ke
// "TAG" yang jadi bagian dari "TTAG:".
export function parseTagihanListrikDetail(rawReply) {
  const reply = String(rawReply || "");
  const toNumber = (s) => (s == null ? null : parseInt(String(s).replace(/\./g, ""), 10) || 0);

  const tag = reply.match(/\bTAG:([\d.]+)/i);
  const admin = reply.match(/\bADMIN:([\d.]+)/i);
  const ttag = reply.match(/\bTTAG:([\d.]+)/i);
  const saldo = reply.match(/Saldo\s+([\d.]+)\s*-\s*([\d.]+)\s*=\s*([\d.]+)/i);

  return {
    tagihanPokok: tag ? toNumber(tag[1]) : null,
    adminBank: admin ? toNumber(admin[1]) : null,
    totalTagihan: ttag ? toNumber(ttag[1]) : null,
    modalRiil: saldo ? toNumber(saldo[2]) : null,
  };
}

// Parsing balasan SUKSES portalpulsa, contoh asli (2026-09-25):
//   "S5 085225492482 SUKSES. SN: 04285200000862029402.. Harga: Rp 5.395. ID:
//   260925120354. Saldo:Rp 9.273 # Ayo transaksi terus biar dapet bonus mingguan"
// Field dipisah titik, tapi SN kadang diikuti titik dobel ("..") — makanya SN
// diambil sampai whitespace saja (bukan sampai "."), supaya tidak salah potong.
// "hpp" di sini adalah field "Harga" — inilah modal riil transaksi ini (lihat
// usesDynamicCost di atas), BUKAN product.cost_price yang selalu 0 utk
// portalpulsa karena tidak ada price list.
export function parsePortalpulsaDetail(rawReply) {
  const reply = String(rawReply || "");
  const toNumber = (s) => (s == null ? null : parseInt(String(s).replace(/\./g, ""), 10) || 0);
  const sn = reply.match(/\bSN:\s*([A-Za-z0-9]+)/i);
  const harga = reply.match(/\bHarga:\s*Rp\.?\s*([\d.]+)/i);
  const id = reply.match(/\bID:\s*([A-Za-z0-9]+)/i);
  const saldo = reply.match(/\bSaldo:?\s*Rp\.?\s*([\d.]+)/i);
  return {
    sn: sn ? sn[1] : null,
    hpp: harga ? toNumber(harga[1]) : null,
    refIdProvider: id ? id[1] : null,
    saldoAkhir: saldo ? toNumber(saldo[1]) : null,
  };
}

// ---------------------------------------------------------------------------
// DEPOSIT PORTALPULSA — perintah "D BANK NOMINAL PIN", alurnya 3 TAHAP
// (ketahuan dari contoh balasan asli, BUKAN dari dokumentasi resmi):
//   1) "Telah kami terima... Silakan tunggu reply selanjutnya"     (ack, diabaikan)
//   2) "Silakan transfer Rp 50.094 Ke Bank: JATENG..."             (instruksi —
//      nominal DI SINI beda dari yang diketik, ada kode unik tambahan)
//   3) "Deposit 50.094 SUKSES ... Saldo sekarang Rp 57.536"        ATAU
//      "Request Deposit 50090 DIBATALKAN karena hangus (lebih dari 12jam)"
//      — datang BELAKANGAN, terpisah, kadang berjam-jam kemudian, SETELAH
//      admin beneran transfer manual sesuai instruksi tahap 2. TIDAK bisa
//      langsung didapat dari sendJabberCommand (yang berhenti di tahap 2,
//      karena mengandung kata "transfer" yang cocok FINAL_REPLY_KEYWORDS).
//
// Konsekuensinya: pencatatan mutasi dompet TIDAK BOLEH terjadi optimis di
// tahap 2 (uangnya belum tentu ditransfer) — harus nunggu tahap 3 baru
// dicatat. Balasan tahap 3 dicek berkala lewat cron yang DENGERIN PASIF
// (listenJabberMessages), BUKAN dengan mengirim ulang command deposit (itu
// beresiko kebaca provider sebagai permintaan deposit baru).
// ---------------------------------------------------------------------------

/** Parse balasan INSTRUKSI TRANSFER (tahap 2) — ambil nominal ASLI yang harus ditransfer (sudah + kode unik). */
export function parseDepositInstruksi(rawReply) {
  const text = String(rawReply || "");
  const toNumber = (s) => (s == null ? null : parseInt(String(s).replace(/\./g, ""), 10) || 0);
  const m = text.match(/[Tt]ransfer\s+Rp\.?\s*([\d.,]+)/);
  return { nominalTransfer: m ? toNumber(m[1]) : null };
}

/**
 * Parse balasan SUSULAN (tahap 3) — SUKSES atau DIBATALKAN/GAGAL. Dipanggil
 * per pesan hasil listenJabberMessages, dicocokkan ke deposit `pending` mana
 * lewat nominalTransfer yang disebut di teksnya (unik per deposit, beda dari
 * nominal yang diketik admin).
 * @returns {{nominal:number, status:'sukses'|'gagal', saldoAkhir:?number, alasan:?string}|null}
 *   null kalau teksnya tidak cocok pola SUKSES maupun DIBATALKAN/GAGAL sama sekali.
 */
export function parseDepositSusulan(text) {
  const toNumber = (s) => (s == null ? null : parseInt(String(s).replace(/\./g, ""), 10) || 0);
  const sukses = text.match(/Deposit\s+([\d.,]+)\s+SUKSES/i);
  if (sukses) {
    const saldo = text.match(/Saldo sekarang\s+Rp\.?\s*([\d.,]+)/i);
    return { nominal: toNumber(sukses[1]), status: "sukses", saldoAkhir: saldo ? toNumber(saldo[1]) : null, alasan: null };
  }
  const gagal = text.match(/Deposit\s+([\d.,]+)\s+(DIBATALKAN|GAGAL)\s*(?:karena\s*)?([^#]*)/i);
  if (gagal) {
    return { nominal: toNumber(gagal[1]), status: "gagal", saldoAkhir: null, alasan: (gagal[3] || "").trim() || null };
  }
  return null;
}

/**
 * Kirim command deposit "D BANK NOMINAL PIN" & catat sebagai `pending` —
 * TIDAK mencatat mutasi dompet apa pun di sini (lihat catatan 3-tahap di
 * atas). Dipakai bersama oleh endpoint web, mini app, dan bot Telegram,
 * supaya perilakunya konsisten di ketiga jalur itu.
 *
 * @param {Object} p
 * @param {string} p.bank
 * @param {number} p.nominal - nominal yang DIKETIK admin (tanpa kode unik)
 * @param {number} p.walletId - dompet sumber yang DIRENCANAKAN dipotong (baru beneran dipotong setelah status jadi 'sukses')
 * @param {number} [p.employeeId]
 * @returns {Promise<{depositId:number, replyText:string}>}
 */
export async function kirimDepositPortalpulsa(env, { bank, nominal, walletId, employeeId }) {
  const cfg = getProviderConfig(env, "portalpulsa");
  assertCfgComplete(cfg);
  if (!bank) throw new Error("Bank tujuan wajib diisi.");
  if (!nominal || nominal <= 0) throw new Error("Nominal deposit harus lebih dari 0.");
  if (!walletId) throw new Error("Pilih dompet sumber dulu.");

  const distributor = await env.DB.prepare(
    "SELECT * FROM wallets WHERE type = 'distributor_ppob' AND provider = 'portalpulsa' LIMIT 1"
  ).first();
  if (!distributor) throw new Error("Dompet distributor portalpulsa belum ada — buat dulu di menu Dompet.");

  const body = `D ${bank} ${nominal} ${cfg.pin}`;
  const result = await sendJabberCommand({
    jid: cfg.jid,
    password: cfg.password,
    to: cfg.target,
    body,
    acceptAnyFromTarget: true,
    collectHistory: true,
  });
  // result = { text, history } karena collectHistory: true — gabung SEMUA
  // balasan yang masuk (ack tahap-1 + instruksi tahap-2), bukan cuma yang
  // terakhir, supaya jejaknya lengkap kalau perlu ditelusuri manual nanti.
  const rawReplyGabungan = result.history.join("\n---\n");
  const { nominalTransfer } = parseDepositInstruksi(result.text);

  const insert = await env.DB.prepare(
    `INSERT INTO portalpulsa_deposits (bank, nominal, nominal_transfer, raw_reply, employee_id, wallet_id, distributor_wallet_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  )
    .bind(bank, nominal, nominalTransfer, rawReplyGabungan, employeeId || null, walletId, distributor.id)
    .run();

  return { depositId: insert.meta.last_row_id, replyText: result.text, nominalTransfer };
}

/**
 * Cocokkan & selesaikan deposit `pending` berdasarkan balasan susulan (tahap
 * 3) yang baru masuk. Dipanggil dari cron (checkPendingPortalpulsaDeposits di
 * index.js) — bukan dipanggil manual dari endpoint kasir.
 *
 * Balasan dicocokkan ke deposit lewat `nominal_transfer` (unik per deposit,
 * beda dari `nominal` yang diketik) — kalau tidak ketemu deposit pending yang
 * nominal_transfer-nya sama persis, balasan itu DIABAIKAN (bukan error keras;
 * bisa saja balasan buat deposit yang sudah lama/lewat window pencarian).
 */
export async function selesaikanDepositSusulan(env, { nominal, status, saldoAkhir, alasan, rawText }) {
  const deposit = await env.DB.prepare(
    "SELECT * FROM portalpulsa_deposits WHERE status = 'pending' AND nominal_transfer = ? LIMIT 1"
  )
    .bind(nominal)
    .first();
  if (!deposit) return null; // tidak ada yang cocok — biarkan, jangan sok tahu itu punya siapa

  const rawReplyBaru = `${deposit.raw_reply}\n---\n${rawText}`;

  if (status === "gagal") {
    await env.DB.prepare("UPDATE portalpulsa_deposits SET status = 'gagal', raw_reply = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(rawReplyBaru, deposit.id)
      .run();
    return { depositId: deposit.id, status: "gagal", alasan };
  }

  // status === 'sukses' -> BARU SEKARANG catat mutasi dompet, pakai nominal
  // TRANSFER (uang yang beneran keluar dari rekening), bukan nominal yang
  // diketik. Kalau saldoAkhir ketemu di balasan, TIMPA saldo dompet
  // distributor jadi persis itu (lebih akurat daripada tambah-tambahan,
  // otomatis mengoreksi kalau ada drift sebelumnya).
  const shiftId = await getOpenShiftId(env, deposit.employee_id);
  const note = `Deposit portalpulsa via ${deposit.bank} (Rp ${nominal})`;
  const tx = await env.DB.prepare(
    `INSERT INTO transactions (type, category, wallet_id, to_wallet_id, amount, cost_total, note, employee_id, shift_id)
     VALUES ('mutation', 'Deposit portalpulsa', ?, ?, ?, 0, ?, ?, ?)`
  )
    .bind(deposit.wallet_id, deposit.distributor_wallet_id, nominal, note, deposit.employee_id || null, shiftId)
    .run();
  const transactionId = tx.meta.last_row_id;

  await env.DB.batch([
    env.DB.prepare("UPDATE wallets SET balance = balance - ? WHERE id = ?").bind(nominal, deposit.wallet_id),
    saldoAkhir != null
      ? env.DB.prepare("UPDATE wallets SET balance = ? WHERE id = ?").bind(saldoAkhir, deposit.distributor_wallet_id)
      : env.DB.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?").bind(nominal, deposit.distributor_wallet_id),
    env.DB.prepare("UPDATE portalpulsa_deposits SET status = 'sukses', raw_reply = ?, transaction_id = ?, updated_at = datetime('now') WHERE id = ?").bind(
      rawReplyBaru,
      transactionId,
      deposit.id
    ),
  ]);

  return { depositId: deposit.id, status: "sukses", transactionId };
}

/**
 * Bentuk baris riwayat deposit siap tampil (web, Mini App) — SATU tempat
 * supaya label & angkanya sama di semua tampilan:
 *  - nominal_tampil: nominal yang BENAR-BENAR ditransfer (ada kode unik, mis.
 *    Rp 50.094) kalau sudah diketahui dari balasan tahap-2, kalau belum baru
 *    nominal yang diketik.
 *  - status_label: SUKSES / PENDING / EXPIRED / GAGAL. EXPIRED = gagal karena
 *    hangus/kadaluwarsa (balasan provider "DIBATALKAN karena hangus" atau
 *    penanda otomatis kita setelah 13 jam) — dicek cuma di potongan balasan
 *    TERAKHIR, karena instruksi transfer tahap-2 juga menyebut "12jam" dan
 *    tidak boleh salah dikira hangus.
 */
export function formatBarisDeposit(row) {
  const potonganAkhir = String(row.raw_reply || "").split("\n---\n").pop();
  let statusLabel;
  if (row.status === "sukses") statusLabel = "SUKSES";
  else if (row.status === "pending") statusLabel = "PENDING";
  else statusLabel = /hangus|kadaluwarsa|expired|lebih dari 12/i.test(potonganAkhir) ? "EXPIRED" : "GAGAL";
  return {
    id: row.id,
    bank: row.bank,
    nominal: row.nominal,
    nominal_tampil: row.nominal_transfer || row.nominal,
    status: row.status,
    status_label: statusLabel,
    waktu_update: row.waktu_update,
    employee_name: row.employee_name,
    raw_reply: row.raw_reply,
  };
}

/** Fallback: deposit `pending` yang sudah lewat window (13 jam, kasih buffer
 * dari batas resmi 12 jam) TANPA balasan susulan apa pun sama sekali —
 * jaga-jaga kalau provider tidak selalu mengirim notifikasi "hangus". */
export async function tandaiDepositKadaluwarsa(env) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM portalpulsa_deposits WHERE status = 'pending' AND created_at <= datetime('now', '-13 hours')`
  ).all();
  for (const d of results) {
    await env.DB.prepare(
      "UPDATE portalpulsa_deposits SET status = 'gagal', raw_reply = raw_reply || ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind("\n---\n[Sistem] Tidak ada balasan provider dalam 13 jam, ditandai gagal/kadaluwarsa otomatis.", d.id)
      .run();
  }
  return results.length;
}


// deret 16-20 digit angka, kadang dipisah strip. BELUM ada contoh balasan
// sukses token PLN asli, jadi ini pola tebakan yang bisa meleset; kasir
// tetap bisa koreksi manual di kotak konfirmasi kalau salah/tidak ketemu.
export function extractTokenCode(reply) {
  if (!reply) return null;
  const match = reply.match(/\b(\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}(?:[- ]?\d{0,4})?)\b/);
  return match ? match[1] : null;
}

// Cek kelengkapan config SEBELUM kirim apapun ke Jabber — supaya kalau ada
// secret yang belum diisi, errornya jelas dan LANGSUNG ("PIN belum
// dikonfigurasi"), bukan diam-diam mengirim literal string "undefined" ke
// server lalu bingung kenapa selalu gagal/timeout tanpa penjelasan.
export function assertCfgComplete(cfg) {
  const envNames =
    cfg.provider === "portalpulsa"
      ? { jid: "PORTALPULSA_JID (atau JABBER_JID sbg fallback)", password: "PORTALPULSA_PASSWORD (atau JABBER_PASSWORD sbg fallback)", pin: "PORTALPULSA_PIN", target: "PORTALPULSA_TARGET" }
      : { jid: "JABBER_JID", password: "JABBER_PASSWORD", pin: "JABBER_PIN", target: "JABBER_TARGET" };
  const missing = ["jid", "password", "pin", "target"].filter((k) => !cfg[k]);
  if (missing.length) {
    throw new Error(
      `Konfigurasi provider "${cfg.provider}" belum lengkap — secret/var berikut masih kosong: ` +
        missing.map((k) => envNames[k]).join(", ") +
        `. Isi dulu lewat Cloudflare Settings > Variables and Secrets, lalu coba lagi.`
    );
  }
}

/** Kirim command "Cek" (cek tagihan/cek nama pelanggan) — TIDAK memotong saldo
 * dan TIDAK memengaruhi laporan keuangan, tapi tetap DISIMPAN ke ppob_orders
 * (status 'cek') supaya balasannya bisa dilihat lagi lain waktu. */
export async function cekTagihan(env, { productCode, target }) {
  // Fitur ini khusus OkeConnect (portalpulsa belum dukung pascabayar, lihat
  // placePpobOrder) — difilter eksplisit supaya tidak ambigu kalau kode
  // tagihan kebetulan sama dgn kode produk portalpulsa.
  const product = await env.DB.prepare("SELECT * FROM products WHERE code = ? AND provider = 'okeconnect'")
    .bind(productCode)
    .first();
  if (!product) {
    throw new Error(`Kode produk "${productCode}" tidak ditemukan.`);
  }
  const cfg = getProviderConfig(env, product.provider);
  assertCfgComplete(cfg);
  const refId = "CEK" + Date.now();
  // Perilaku lama tidak berubah (suffix "A" kalau kategori pascabayar).
  const body = isPostpaid(product)
    ? cfg.buildPascaCekBody(productCode, target, cfg.pin, refId)
    : cfg.buildPrabayarBody(productCode, target, cfg.pin, refId);

  let reply = null;
  try {
    reply = await sendJabberCommand({
      jid: cfg.jid,
      password: cfg.password,
      to: cfg.target,
      body,
      refSeparator: cfg.separator,
      acceptAnyFromTarget: cfg.provider === "portalpulsa",
    });
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
export async function placePpobOrder(env, { productCode, target, paidMethod = "tunai", contactId = null, batchId = null, telegramChatId = "", newProductProvider = null }) {
  // Kalau pemanggil eksplisit bilang "ini portalpulsa" (3 jalur khusus
  // portalpulsa: tab web, tombol bot, form Mini App), pencarian produknya
  // WAJIB ikut difilter provider juga. Tanpa ini, kode yang KEBETULAN sudah
  // ada di katalog OkeConnect (hasil sinkron) bakal "menang" duluan dan
  // newProductProvider diabaikan total — order jadi kekirim ke JID/PIN
  // OkeConnect walau user eksplisit pilih portalpulsa.
  let product = newProductProvider
    ? await env.DB.prepare("SELECT * FROM products WHERE code = ? AND provider = ?")
        .bind(productCode, newProductProvider)
        .first()
    : await env.DB.prepare("SELECT * FROM products WHERE code = ?").bind(productCode).first();
  if (!product) {
    // portalpulsa tidak punya katalog/price-list (lihat getProviderConfig) —
    // kasir mengetik kode manual, jadi produk baru diprovisi otomatis di sini
    // (cost_price/sell_price mulai dari 0, disesuaikan tiap transaksi lewat
    // kotak konfirmasi — lihat usesDynamicCost). Provider lain (OkeConnect)
    // TETAP wajib sudah ada di katalog hasil sinkron, supaya salah ketik kode
    // tidak diam-diam membuat "produk" baru yang sebenarnya cuma typo.
    if (newProductProvider === "portalpulsa") {
      // products.code UNIQUE utk SELURUH tabel (bukan per-provider) — kalau
      // kode ini kebetulan sudah dipakai produk provider lain (biasanya hasil
      // sinkron katalog OkeConnect), INSERT di bawah akan gagal kena UNIQUE
      // constraint. Dicek dulu di sini supaya errornya jelas & actionable,
      // bukan pesan mentah dari D1.
      const existingBeda = await env.DB.prepare("SELECT provider FROM products WHERE code = ?").bind(productCode).first();
      if (existingBeda) {
        throw new Error(
          `Kode "${productCode}" sudah dipakai produk provider "${existingBeda.provider}" di katalog — tidak bisa dipakai juga untuk portalpulsa (satu kode cuma boleh satu produk). Pakai kode lain yang belum ada, mis. tambah awalan/akhiran pembeda.`
        );
      }
      await env.DB.prepare(
        `INSERT INTO products (code, name, category, provider, cost_price, sell_price, active)
         VALUES (?, ?, NULL, 'portalpulsa', 0, 0, 1)`
      )
        .bind(productCode, productCode)
        .run();
      product = await env.DB.prepare("SELECT * FROM products WHERE code = ?").bind(productCode).first();
    } else {
      throw new Error(`Kode produk "${productCode}" tidak ditemukan. Coba /cari dulu.`);
    }
  }
  if (paidMethod === "utang" && !contactId) {
    throw new Error("Pembayaran Utang wajib pilih kontak.");
  }

  const cfg = getProviderConfig(env, product.provider);
  assertCfgComplete(cfg);
  const wallet = await env.DB.prepare(
    "SELECT * FROM wallets WHERE type = 'distributor_ppob' AND provider = ? LIMIT 1"
  )
    .bind(cfg.provider)
    .first();

  // Peringatan (BUKAN blokir — order tetap dikirim) kalau saldo dompet
  // distributor sudah diketahui menipis. Dicek SEBELUM kirim ke provider,
  // supaya kasir sadar dari awal, bukan kaget setelah transaksi jalan.
  // Untuk produk yang modalnya baru diketahui SETELAH transaksi (portalpulsa,
  // tagihan pascabayar) — lihat usesDynamicCost — perkiraan modal tidak ada,
  // jadi cuma diperingatkan kalau saldo sudah 0/minus (bukan dibandingkan
  // modal, karena modalnya sendiri belum diketahui).
  let warning = null;
  if (!wallet) {
    warning = `Belum ada dompet distributor utk provider "${cfg.provider}" — modal transaksi TIDAK akan terpotong dari mana pun.`;
  } else if (usesDynamicCost(product)) {
    if (wallet.balance <= 0) {
      warning = `Saldo distributor "${wallet.name}" sudah habis/minus (Rp ${wallet.balance.toLocaleString("id-ID")}). Modal transaksi ini belum diketahui pastinya, tapi kemungkinan besar tidak akan tertutup.`;
    }
  } else if (wallet.balance < product.cost_price) {
    warning = `Saldo distributor "${wallet.name}" (Rp ${wallet.balance.toLocaleString("id-ID")}) lebih kecil dari modal produk ini (Rp ${product.cost_price.toLocaleString("id-ID")}) — kemungkinan transaksi akan gagal karena saldo tidak cukup.`;
  }

  const refId = "TX" + Date.now();

  // OkeConnect: pulsa/kuota/token prabayar pakai R#{ID} biasa, tagihan
  // pascabayar (listrik, PDAM, BPJS) pakai R#{ID}A (suffix "A") — CATATAN:
  // asumsi berdasarkan pola kategori, BELUM dikonfirmasi CS OkeConnect,
  // wajib dites dulu dengan transaksi kecil.
  const body = isPostpaid(product)
    ? cfg.buildPascaBayarBody(productCode, target, cfg.pin, refId)
    : cfg.buildPrabayarBody(productCode, target, cfg.pin, refId);

  // telegramChatId diisi kalau order ini dibuat dari Mini App (chat karyawan
  // sendiri) — supaya kalau balasan provider telat dan baru selesai lewat
  // cron, karyawan tetap dapat notifikasi balik ke Telegram-nya, bukan harus
  // ingat cek manual (lihat recheckOrder di index.js).
  await env.DB.prepare(
    `INSERT INTO ppob_orders (ref_id, telegram_chat_id, product_code, target, cost_price, sell_price, wallet_id, status, paid_method, contact_id, batch_id, provider, request_body)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
  )
    .bind(refId, String(telegramChatId || ""), productCode, target, product.cost_price, product.sell_price, wallet ? wallet.id : null, paidMethod, contactId, batchId, cfg.provider, body)
    .run();

  let status = "pending";
  let reply = null;

  try {
    reply = await sendJabberCommand({
      jid: cfg.jid,
      password: cfg.password,
      to: cfg.target,
      body,
      refSeparator: cfg.separator,
      acceptAnyFromTarget: cfg.provider === "portalpulsa",
    });
    status = detectPpobStatus(reply);
  } catch (err) {
    console.error("Jabber gagal untuk order", refId, ":", err.message, err.stack);
    // Perintah SUDAH dikirim ke provider sebelum error ini muncul, jadi order
    // bisa saja tetap diproses. Pesan dibuat jelas supaya kasir tidak kirim ulang.
    reply = /^Timeout menunggu balasan/.test(err.message)
      ? `ORDER TERSIMPAN (pending) — balasan provider belum diterima dalam 25 detik. Perintah sudah terkirim, jadi JANGAN kirim ulang. Klik "Cek Ulang Status" beberapa menit lagi. (${err.message})`
      : "ERROR: " + err.message;
    status = "pending"; // nanti ditangkap cron checkPendingOrders
  }

  const tokenCode = status === "sukses" ? extractTokenCode(reply) : null;
  await env.DB.prepare(
    // AND status = 'pending': kalau Relay Jabber sudah lebih dulu menyimpan hasil
    // final (sukses/gagal) untuk order ini, jangan ditimpa lagi oleh hasil sesi ini.
    "UPDATE ppob_orders SET status = ?, raw_reply = ?, token_code = ?, updated_at = datetime('now') WHERE ref_id = ? AND status = 'pending'"
  )
    .bind(status, reply, tokenCode, refId)
    .run();

  return {
    refId,
    status,
    reply,
    product,
    tokenCode,
    warning,
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
export async function recordPpobSale(env, { product, wallet, refId, target, sellPrice, costTotal, paidMethod = "tunai", contactId = null, sisaMethod = "tunai", receiveWalletId = null, employeeId = null }) {
  const finalSellPrice = sellPrice != null ? sellPrice : product.sell_price;
  const finalCostTotal = usesDynamicCost(product) && costTotal != null ? costTotal : product.cost_price;

  // Bayar pakai titipan pelanggan: bagian yang ditutup titipan tidak menambah
  // apa pun ke dompet (uangnya sudah masuk saat dititipkan). Kalau titipan
  // kurang, sisanya dibayar tunai atau jadi piutang (sisaMethod).
  let plan = null;
  if (paidMethod === "titipan") {
    plan = await rencanaPakaiTitipan(env, { contactId, total: finalSellPrice, sisaMethod });
  }
  const depositUsed = plan ? plan.pakai : 0;
  const piutangBaru = paidMethod === "utang" ? finalSellPrice : plan && plan.sisaMethod === "utang" ? plan.sisa : 0;

  // Uang TUNAI yang benar-benar diterima dari pelanggan (di luar titipan & piutang)
  // — ini yang masuk ke dompet pilihan kasir (Kas/Bank/E-Wallet).
  const kasMasuk = plan
    ? plan.sisa > 0 && plan.sisaMethod === "tunai"
      ? plan.sisa
      : 0
    : paidMethod === "utang"
    ? 0
    : finalSellPrice;
  let receiveWallet = null;
  if (kasMasuk > 0) {
    if (!receiveWalletId) {
      throw new Error("Pilih dompet tempat uang pembayaran diterima (Kas/Bank/E-Wallet).");
    }
    receiveWallet = await env.DB.prepare("SELECT * FROM wallets WHERE id = ?").bind(receiveWalletId).first();
    if (!receiveWallet) throw new Error("Dompet penerima tidak ditemukan.");
    if (receiveWallet.type === "distributor_ppob") {
      throw new Error("Dompet saldo distributor tidak bisa jadi tempat uang pembayaran diterima. Pilih Kas/Bank/E-Wallet.");
    }
  }

  // Pola sama dengan jasa transfer: wallet_id = dompet tempat uang MASUK,
  // cost_wallet_id = dompet sumber modal (saldo distributor). Dengan begitu arus
  // kas, laporan shift, dan penghapusan transaksi otomatis benar.
  // Tempelkan kasir & shift yang sedang berjalan supaya uang PPOB ikut kehitung
  // di Laporan Shift (kas opname).
  const openShift = employeeId
    ? await env.DB.prepare("SELECT id FROM shifts WHERE employee_id = ? AND status = 'open'").bind(employeeId).first()
    : null;
  const txResult = await env.DB.prepare(
    `INSERT INTO transactions (type, category, wallet_id, cost_wallet_id, amount, cost_total, note, contact_id, deposit_used, employee_id, shift_id)
     VALUES ('sale', 'PPOB', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      receiveWallet ? receiveWallet.id : null,
      wallet ? wallet.id : null,
      finalSellPrice,
      finalCostTotal,
      `PPOB ${product.code} ke ${target} (ref ${refId})`,
      paidMethod === "utang" || paidMethod === "titipan" ? contactId : null,
      depositUsed,
      employeeId || null,
      openShift ? openShift.id : null
    )
    .run();

  if (receiveWallet && kasMasuk > 0) {
    await env.DB.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?").bind(kasMasuk, receiveWallet.id).run();
  }

  if (plan && depositUsed > 0) {
    await env.DB.batch(
      stmtsPakaiTitipan(env, {
        contactId,
        pakai: depositUsed,
        transactionId: txResult.meta?.last_row_id,
        note: `Titipan dipakai untuk PPOB ${product.code} ke ${target} (ref ${refId})`,
      })
    );
  }

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
  if (piutangBaru > 0 && contactId) {
    await env.DB.prepare(
      `INSERT INTO debts (contact_id, type, amount, note) VALUES (?, 'piutang', ?, ?)`
    )
      .bind(contactId, piutangBaru, `PPOB ${product.code} ke ${target} (ref ${refId})`)
      .run();
    await env.DB.prepare("UPDATE contacts SET total_debt = total_debt + ? WHERE id = ?")
      .bind(piutangBaru, contactId)
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
export async function finalizePpobOrder(env, { refId, sellPrice, costTotal, tokenCode, paidMethod, contactId, sisaMethod, receiveWalletId, employeeId }) {
  if (sellPrice === undefined || sellPrice === null) {
    throw new Error("sellPrice wajib diisi");
  }
  const order = await env.DB.prepare("SELECT * FROM ppob_orders WHERE ref_id = ?").bind(refId).first();
  if (!order) throw new Error("Order tidak ditemukan");
  if (order.status !== "sukses") throw new Error("Order belum sukses, tidak bisa dikonfirmasi");
  if (order.finalized) throw new Error("Order ini sudah pernah dicatat sebelumnya");

  // order.provider sudah diketahui sejak order dibuat — ikut difilter supaya
  // tidak ambigu (code sekarang unik PER-PROVIDER, bukan lintas provider).
  const product = await env.DB.prepare("SELECT * FROM products WHERE code = ? AND provider = ?")
    .bind(order.product_code, order.provider)
    .first();
  if (!product) throw new Error(`Produk ${order.product_code} (${order.provider}) sudah tidak ada di katalog`);
  const wallet = order.wallet_id
    ? await env.DB.prepare("SELECT * FROM wallets WHERE id = ?").bind(order.wallet_id).first()
    : null;

  const finalPaidMethod = paidMethod || order.paid_method || "tunai";
  const finalContactId = contactId ?? order.contact_id ?? null;
  if ((finalPaidMethod === "utang" || finalPaidMethod === "titipan") && !finalContactId) {
    throw new Error(`Pembayaran ${finalPaidMethod === "utang" ? "Utang" : "Titipan"} wajib pilih kontak`);
  }

  // Kalau caller (mis. jalur cron otomatis tanpa kasir) TIDAK mengirim
  // costTotal eksplisit untuk kategori pascabayar, JANGAN jatuh ke
  // product.cost_price (itu cuma referensi komisi OkeConnect, bukan modal
  // riil — lihat catatan parseTagihanListrikDetail). Coba dulu ambil modal
  // riil dari selisih saldo di raw_reply order ini; product.cost_price cuma
  // dipakai sebagai upaya terakhir kalau balasan tidak bisa diparse sama sekali.
  let effectiveCostTotal = costTotal;
  // portalpulsa: costTotal 0/kosong dari klien (mis. kotak Modal dashboard yang
  // terisi default 0 karena product.cost_price selalu 0) dianggap "tidak
  // diisi" — modal riil diambil dari field "Harga" di raw_reply. Modal 0 tidak
  // pernah valid utk portalpulsa. Angka > 0 yg diketik kasir tetap dihormati.
  if (product.provider === "portalpulsa" && !(effectiveCostTotal > 0)) effectiveCostTotal = null;
  if (effectiveCostTotal == null && usesDynamicCost(product)) {
    if (product.provider === "portalpulsa") {
      const detail = parsePortalpulsaDetail(order.raw_reply);
      if (detail.hpp != null) {
        effectiveCostTotal = detail.hpp;
      } else {
        console.error(
          `finalizePpobOrder ${refId}: gagal parse field "Harga" dari balasan portalpulsa, fallback ke product.cost_price (selalu 0 utk portalpulsa — cek harus isi manual)`
        );
      }
    } else {
      const detail = parseTagihanListrikDetail(order.raw_reply);
      if (detail.modalRiil != null) {
        effectiveCostTotal = detail.modalRiil;
      } else {
        console.error(
          `finalizePpobOrder ${refId}: gagal parse modal riil dari raw_reply, fallback ke product.cost_price (kemungkinan salah utk pascabayar)`
        );
      }
    }
  }

  const { transactionId, costTotal: appliedCostTotal } = await recordPpobSale(env, {
    product,
    wallet,
    refId,
    target: order.target,
    sellPrice,
    costTotal: effectiveCostTotal,
    paidMethod: finalPaidMethod,
    contactId: finalContactId,
    sisaMethod,
    receiveWalletId,
    employeeId,
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
 * (sekali sehari jam 6 pagi WIB).
 *
 * PENTING (dioptimalkan setelah kena limit "rows written" harian D1 free
 * tier): daftar harga OkeConnect isinya ribuan kode produk, dan SEBELUMNYA
 * fungsi ini menulis ULANG semua baris itu tiap kali jalan walau harganya
 * sama persis — itu yang bikin kena limit 100rb baris/hari. Sekarang fungsi
 * ini BANDINGKAN dulu dengan data yang sudah ada, dan CUMA menulis baris yang
 * benar-benar baru/berubah/reaktif — biasanya cuma sebagian kecil dari
 * seluruh daftar tiap kali sinkron.
 *
 * Kata kunci di tabel ppob_blocked_keywords (kelola lewat halaman Produk →
 * tab Produk PPOB → "Kata Kunci Diblokir") membuat produk yang kode/nama/
 * kategorinya cocok TIDAK ikut disinkron sama sekali. Kalau produk itu sudah
 * pernah terdaftar sebelumnya, akan DIHAPUS PERMANEN dari tabel products —
 * KECUALI kalau produk itu sudah pernah dipakai di transaksi manapun
 * (transaction_items), yang mana cuma dinonaktifkan saja (sama seperti
 * tombol "Nonaktifkan" manual) supaya laporan lama tidak jadi bolong/rusak.
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
    list = Array.isArray(data) ? data : data?.data || data?.result || [];
    if (!Array.isArray(list)) {
      return { ok: false, error: "Format JSON dari PRICE_LIST_URL tidak dikenali (bukan array, dan tidak ada field data/result berupa array)" };
    }
  } catch (err) {
    return { ok: false, error: "Gagal ambil/baca daftar harga: " + err.message };
  }

  // Kata kunci yang diblokir (mis. kategori/produk yang tidak mau dijual toko
  // ini) — dicocokkan case-insensitive ke kode, nama, ATAU kategori. Produk
  // yang cocok diperlakukan sama seperti status="0" (dilewati, dan kalau
  // sebelumnya sudah aktif, otomatis dinonaktifkan di bagian bawah).
  // Dibungkus try/catch: kalau tabel ini belum ada (mis. schema.sql lama
  // belum diperbarui ke D1), sinkron tetap jalan tanpa filter blokir alih-alih
  // gagal total dengan 500.
  let blockedKeywords = [];
  try {
    const { results: blockedRows } = await env.DB.prepare("SELECT keyword FROM ppob_blocked_keywords").all();
    blockedKeywords = blockedRows.map((r) => r.keyword.toLowerCase()).filter(Boolean);
  } catch (err) {
    console.error("Gagal baca ppob_blocked_keywords (tabel belum ada?):", err.message);
  }
  function isBlocked(code, name, category) {
    if (!blockedKeywords.length) return false;
    const haystack = `${code} ${name} ${category || ""}`.toLowerCase();
    return blockedKeywords.some((kw) => haystack.includes(kw));
  }

  // Ambil kondisi SEKARANG di database (semua produk OkeConnect, termasuk
  // yang sudah nonaktif) — dipakai buat bandingkan, bukan buat ditulis ulang.
  // "id" ikut diambil supaya nanti bisa dicek riwayat transaksinya sebelum
  // benar-benar dihapus (lihat blockedCodes di bawah).
  const existingMap = new Map();
  const { results: existingRows } = await env.DB.prepare(
    "SELECT id, code, name, category, product_group, cost_price, active FROM products WHERE provider = 'okeconnect'"
  ).all();
  for (const row of existingRows) existingMap.set(row.code, row);

  const runStartedAt = new Date().toISOString();
  const stmt = env.DB.prepare(
    `INSERT INTO products (code, name, category, product_group, cost_price, sell_price, active, deactivated_at, last_synced_at, provider)
     VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, 'okeconnect')
     ON CONFLICT(code, provider) DO UPDATE SET
       name = excluded.name,
       category = excluded.category,
       product_group = excluded.product_group,
       cost_price = excluded.cost_price,
       active = 1,
       deactivated_at = NULL,
       last_synced_at = excluded.last_synced_at`
  );

  const batchItems = [];
  const seenActiveCodes = new Set();
  const blockedCodes = new Set(); // kode yang kena kata kunci PADA RUN INI — dipakai buat hapus permanen di bawah
  let skipped = 0;
  let blocked = 0;
  let unchanged = 0;

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
    if (isBlocked(code, name, category)) {
      blocked++;
      blockedCodes.add(code);
      continue;
    }

    seenActiveCodes.add(code);

    const existing = existingMap.get(code);
    const changed =
      !existing ||
      existing.active !== 1 ||
      existing.name !== name ||
      existing.category !== category ||
      existing.product_group !== productGroup ||
      Number(existing.cost_price) !== cost;

    if (!changed) {
      unchanged++;
      continue;
    }

    batchItems.push(stmt.bind(code, name, category, productGroup, cost, sell, runStartedAt));
  }

  // D1 membatasi TOTAL bound parameter per panggilan batch() ke 100 (bukan
  // per statement). Statement INSERT ini punya 7 parameter per baris, jadi
  // BATCH_SIZE harus <= 14 (14*7=98) agar tidak kena "too many SQL variables".
  const BATCH_SIZE = 14;
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

  // Produk yang kena kata kunci blokir DAN sudah pernah tercatat di database
  // sebelumnya → HAPUS PERMANEN (bukan cuma dinonaktifkan), asalkan belum
  // pernah dipakai di transaksi manapun (transaction_items) — supaya laporan
  // lama tidak jadi rusak/bolong. Kalau sudah pernah dipakai, tetap cuma
  // dinonaktifkan (sama seperti tombol "Nonaktifkan" manual di halaman Produk).
  const existingBlocked = existingRows.filter((r) => blockedCodes.has(r.code));
  let blockedDeleted = 0;
  let blockedKeptInactive = 0;
  if (existingBlocked.length) {
    // D1 membatasi maksimal 100 bound parameter PER QUERY (bukan per batch
    // call) — query ini SEBELUMNYA tidak di-chunk sama sekali, jadi begitu
    // produk yang kena kata kunci blokir > 100 item, langsung gagal dengan
    // "D1_ERROR: too many SQL variables". Sekarang di-chunk per 90 id
    // (dengan margin dari batas 100) sama seperti loop DELETE/UPDATE di bawah.
    const CHECK_CHUNK = 90;
    const usedProductIds = new Set();
    for (let i = 0; i < existingBlocked.length; i += CHECK_CHUNK) {
      const chunkRows = existingBlocked.slice(i, i + CHECK_CHUNK);
      const idPlaceholders = chunkRows.map(() => "?").join(",");
      const { results: usageRows } = await env.DB.prepare(
        `SELECT product_id, COUNT(*) AS n FROM transaction_items WHERE product_id IN (${idPlaceholders}) GROUP BY product_id`
      )
        .bind(...chunkRows.map((r) => r.id))
        .all();
      usageRows.forEach((r) => usedProductIds.add(r.product_id));
    }

    const toDeleteIds = existingBlocked.filter((r) => !usedProductIds.has(r.id)).map((r) => r.id);
    const toKeepInactive = existingBlocked.filter((r) => usedProductIds.has(r.id)).map((r) => r.code);

    const DEL_CHUNK = 100;
    for (let i = 0; i < toDeleteIds.length; i += DEL_CHUNK) {
      const ids = toDeleteIds.slice(i, i + DEL_CHUNK);
      const placeholders = ids.map(() => "?").join(",");
      const res = await env.DB.prepare(`DELETE FROM products WHERE id IN (${placeholders})`)
        .bind(...ids)
        .run();
      blockedDeleted += res.meta?.changes ?? 0;
    }

    for (let i = 0; i < toKeepInactive.length; i += DEL_CHUNK) {
      const codes = toKeepInactive.slice(i, i + DEL_CHUNK);
      const placeholders = codes.map(() => "?").join(",");
      const res = await env.DB.prepare(
        `UPDATE products SET active = 0, deactivated_at = datetime('now') WHERE provider = 'okeconnect' AND code IN (${placeholders})`
      )
        .bind(...codes)
        .run();
      blockedKeptInactive += res.meta?.changes ?? 0;
    }
  }

  // Produk yang sebelumnya aktif tapi TIDAK muncul lagi di daftar terbaru
  // (hilang dari sumber, ATAU muncul dengan status "0") → nonaktifkan seperti
  // biasa. blockedCodes SUDAH ditangani terpisah di atas (hapus/nonaktifkan),
  // jadi tidak diulang lagi di sini.
  const toDeactivate = existingRows
    .filter((r) => r.active === 1 && !seenActiveCodes.has(r.code) && !blockedCodes.has(r.code))
    .map((r) => r.code);
  let deactivated = 0;
  const DEACT_CHUNK = 100;
  for (let i = 0; i < toDeactivate.length; i += DEACT_CHUNK) {
    const codes = toDeactivate.slice(i, i + DEACT_CHUNK);
    const placeholders = codes.map(() => "?").join(",");
    const res = await env.DB.prepare(
      `UPDATE products SET active = 0, deactivated_at = datetime('now') WHERE provider = 'okeconnect' AND code IN (${placeholders})`
    )
      .bind(...codes)
      .run();
    deactivated += res.meta?.changes ?? 0;
  }

  return {
    ok: true,
    synced: count,
    total: list.length,
    unchanged,
    skipped,
    blocked,
    blockedDeleted,
    blockedKeptInactive,
    deactivated,
    lastError,
  };
}

// ---------------------------------------------------------------------------
// Cek saldo asli distributor via perintah "Saldo.PIN" lewat Jabber, lalu TIMPA
// langsung wallets.balance dengan angka itu — BUKAN transaksi mutasi, karena
// ini murni sinkronisasi angka biar sama dengan kenyataan di OkeConnect, tidak
// ada uang yang benar-benar berpindah antar dompet toko. Sengaja tidak lewat
// tabel transactions supaya tidak ikut kehitung di laporan laba/mutasi manapun.
//
// Contoh balasan asli OkeConnect (dites langsung 2026-09):
//   "Yth.laelyponsel (OK310547). Saldo 3.523! Dalam proses 0, Pemakaian hari
//   ini 251.950, Total Transaksi 4."
// Formatnya BELUM tentu selalu persis sama (mis. kalau ada saldo minus, atau
// akun jenis lain) — kalau parseBalanceReply gagal menangkap angka, fungsi ini
// TIDAK menimpa saldo (lebih aman diam daripada menimpa dengan angka salah/0).
// Diperluas supaya cocok baik format OkeConnect ("Saldo 3.523!", tanpa "Rp")
// maupun portalpulsa ("Saldo:Rp 9.273", pakai titik dua + "Rp") — BELUM ada
// contoh balasan ASLI perintah cek saldo "S PIN" portalpulsa (yang ada baru
// contoh field "Saldo" di balasan SUKSES transaksi, formatnya diasumsikan
// sama). Kalau ternyata beda, fungsi ini akan gagal parse (return null) dan
// checkDistributorBalance TIDAK menimpa saldo — aman, tapi perlu disesuaikan
// begitu ada contoh balasan cek saldo portalpulsa yang asli.
export function parseBalanceReply(reply) {
  const match = reply.match(/Saldo:?\s*(?:Rp\.?\s*)?([\d.]+)/i);
  if (!match) return null;
  const n = Number(match[1].replace(/\./g, ""));
  return Number.isFinite(n) ? n : null;
}

export async function checkDistributorBalance(env, provider = "okeconnect") {
  const cfg = getProviderConfig(env, provider);
  assertCfgComplete(cfg);

  const wallet = await env.DB.prepare(
    "SELECT * FROM wallets WHERE type = 'distributor_ppob' AND provider = ? LIMIT 1"
  )
    .bind(cfg.provider)
    .first();
  if (!wallet) {
    return { ok: false, error: `Belum ada dompet type='distributor_ppob' untuk provider "${cfg.provider}".` };
  }

  // Format perintah cek saldo beda per provider: OkeConnect pakai titik
  // ("Saldo.PIN"), portalpulsa pakai spasi ("S PIN") — lihat screenshot format
  // resmi portalpulsa yang dikirim user.
  const body = cfg.provider === "portalpulsa" ? `S ${cfg.pin}` : `Saldo.${cfg.pin}`;
  // firstReplyIsFinal cuma valid utk OkeConnect: balasan "Saldo.PIN"-nya
  // memang satu tahap ("Yth...Saldo 3.523!"). portalpulsa TERNYATA (dibuktikan
  // dari balasan asli: "'S <pin>' Telah kami terima... Silakan tunggu reply
  // selanjutnya") juga 2 tahap sama seperti transaksi & deposit — balasan
  // PERTAMA cuma ack, angka saldo aslinya baru menyusul. Kalau dipaksa
  // firstReplyIsFinal:true, sesi berhenti tepat di ack itu: parseBalanceReply
  // gagal (tidak ada "Saldo:" di teks ack) dan fungsi ini selalu ok:false utk
  // portalpulsa, PLUS balasan susulannya tidak sempat ke-feed ke Telegram
  // karena sesi Worker sudah keburu tutup sebelum balasan itu datang.
  const firstReplyIsFinal = cfg.provider !== "portalpulsa";
  const reply = await sendJabberCommand({
    jid: cfg.jid,
    password: cfg.password,
    to: cfg.target,
    body,
    firstReplyIsFinal,
    refSeparator: cfg.separator,
    acceptAnyFromTarget: cfg.provider === "portalpulsa",
  });

  const balance = parseBalanceReply(reply);
  if (balance === null) {
    return { ok: false, error: "Tidak bisa membaca angka saldo dari balasan.", raw_reply: reply };
  }

  await env.DB.prepare("UPDATE wallets SET balance = ? WHERE id = ?").bind(balance, wallet.id).run();

  return { ok: true, wallet_id: wallet.id, balance_before: wallet.balance, balance_after: balance, raw_reply: reply };
}
