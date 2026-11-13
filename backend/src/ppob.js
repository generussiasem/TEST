import { sendJabberCommand } from "./jabber.js";
import { getOpenShiftId } from "./debt.js";
import { rencanaPakaiTitipan, stmtsPakaiTitipan } from "./debt.js";

// ---------------------------------------------------------------------------
// KATALOG PAKET (situs luar yang ditanam lewat iframe di menu "Katalog Paket").
// Alamatnya diatur admin; hanya http/https yang diterima (menolak javascript:,
// data:, dsb. karena nilainya dipakai sebagai src iframe & href tautan).
export const KATALOG_PAKET_URL_DEFAULT = "https://kodebayar.web.id/";

/** Kembalikan URL yang sudah dinormalisasi, atau null kalau kosong (= pakai default). Melempar error kalau tidak valid. */
export function normalisasiUrlKatalog(input) {
  const teks = String(input ?? "").trim();
  if (!teks) return null;
  let u;
  try {
    u = new URL(teks);
  } catch {
    throw new Error('Alamat tidak valid. Tulis lengkap dengan "https://", mis. https://kodebayar.web.id/');
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("Alamat harus diawali http:// atau https://.");
  }
  return u.href;
}

// ---------------------------------------------------------------------------
// TOKEN PLN PORTALPULSA — formatnya BEDA dari produk lain:
//   kode<spasi>idpelanggan<spasi>NoHP<spasi>PIN     mis. "PLN100 04341314134 085313000066 ****"
// (produk portalpulsa lain: "kode<spasi>tujuan<spasi>PIN"). Produk dikenali dari
// AWALAN kode (default "PLN"; diatur admin di Pengaturan karena bisa berubah).
// No. HP: diketik di kolom tujuan ("IDPEL NOHP") atau, kalau hanya ID pelanggan
// yang diketik, memakai No. HP bawaan dari Pengaturan (nomor toko).
const KUNCI_PLN_AWALAN = "portalpulsa_pln_prefixes";
const KUNCI_PLN_HP_BAWAAN = "portalpulsa_pln_default_hp";
export const AWALAN_TOKEN_PLN_DEFAULT = ["PLN"];

export function normalisasiPengaturanTokenPln({ prefixes, defaultHp } = {}) {
  let awalan = AWALAN_TOKEN_PLN_DEFAULT;
  if (prefixes !== undefined && prefixes !== null) {
    const arr = Array.isArray(prefixes) ? prefixes : String(prefixes).split(/[,\s]+/);
    awalan = [...new Set(arr.map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
    for (const a of awalan) {
      if (!/^[A-Z0-9_.-]{1,20}$/.test(a)) throw new Error(`Awalan kode "${a}" tidak valid (huruf/angka, maksimal 20 karakter).`);
    }
  }
  let hp = "";
  if (defaultHp !== undefined && defaultHp !== null && String(defaultHp).trim() !== "") {
    hp = String(defaultHp).replace(/[\s-]/g, "").replace(/^\+/, "");
    if (!/^\d{8,15}$/.test(hp)) throw new Error("No. HP bawaan harus berupa angka 8–15 digit.");
  }
  return { prefixes: awalan, defaultHp: hp };
}

export async function getPengaturanTokenPln(env) {
  const hasil = { prefixes: [...AWALAN_TOKEN_PLN_DEFAULT], defaultHp: "" };
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM app_state WHERE key IN (?, ?)")
      .bind(KUNCI_PLN_AWALAN, KUNCI_PLN_HP_BAWAAN)
      .all();
    for (const r of results) {
      if (r.key === KUNCI_PLN_AWALAN) {
        try {
          const arr = JSON.parse(r.value);
          if (Array.isArray(arr)) hasil.prefixes = arr.map((x) => String(x).trim().toUpperCase()).filter(Boolean);
        } catch (_) {}
      }
      if (r.key === KUNCI_PLN_HP_BAWAAN && /^\d{8,15}$/.test(String(r.value || ""))) hasil.defaultHp = String(r.value);
    }
  } catch (err) {
    console.error("Gagal baca pengaturan token PLN portalpulsa:", err.message);
  }
  return hasil;
}

export async function setPengaturanTokenPln(env, input) {
  const p = normalisasiPengaturanTokenPln(input);
  const upsert = `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`;
  await env.DB.batch([
    env.DB.prepare(upsert).bind(KUNCI_PLN_AWALAN, JSON.stringify(p.prefixes)),
    p.defaultHp
      ? env.DB.prepare(upsert).bind(KUNCI_PLN_HP_BAWAAN, p.defaultHp)
      : env.DB.prepare("DELETE FROM app_state WHERE key = ?").bind(KUNCI_PLN_HP_BAWAAN),
  ]);
  return p;
}

/** Apakah kode produk portalpulsa ini token PLN (berawalan salah satu awalan di pengaturan)? */
export function isTokenPlnPortalpulsa(productCode, pengaturan) {
  const kode = String(productCode || "").trim().toUpperCase();
  return !!kode && pengaturan.prefixes.some((a) => kode.startsWith(a));
}

/** Pisahkan tujuan menjadi { idpel, hp }. Tujuan: "IDPEL" (HP dari bawaan) atau
 * "IDPEL NOHP". Melempar error yang jelas SEBELUM ada yang dikirim ke provider. */
export function tentukanTargetTokenPln(target, pengaturan) {
  const bagian = String(target ?? "").trim().split(/\s+/).filter(Boolean);
  if (bagian.length === 0 || bagian.length > 2) {
    throw new Error('Token PLN portalpulsa: isi tujuan dengan ID pelanggan saja, atau "IDPEL NOHP" (dipisah spasi).');
  }
  const idpel = bagian[0];
  if (!/^\d{5,20}$/.test(idpel)) throw new Error("Token PLN portalpulsa: ID pelanggan harus berupa angka (5–20 digit).");
  const hpMentah = bagian[1] ?? pengaturan.defaultHp;
  if (!hpMentah) {
    throw new Error('Token PLN portalpulsa butuh No. HP: ketik "IDPEL NOHP" di kolom tujuan, atau isi No. HP bawaan di Pengaturan.');
  }
  const hp = String(hpMentah).replace(/^\+/, "");
  if (!/^\d{8,15}$/.test(hp)) throw new Error("Token PLN portalpulsa: No. HP harus berupa angka 8–15 digit.");
  return { idpel, hp };
}

// ---------------------------------------------------------------------------
// HARGA JUAL STANDAR = HPP × (1 + persen laba), dibulatkan KE ATAS ke kelipatan
// pembulatan (default Rp1.000). Persen dihitung dari HPP (markup), bukan dari
// harga jual. Persen, pembulatan, dan daftar kategori yang dikecualikan diatur
// admin di Pengaturan (tabel app_state).
//
// Semua produk PPOB OkeConnect IKUT persentase (tanpa "kunci harga"), kecuali:
//  - kategori pascabayar/tagihan (default TAGIHAN & AIR PDAM, bisa diubah admin),
//  - produk portalpulsa (modal baru diketahui dari balasan transaksi),
//  - produk tanpa kode (barang warung).
// Produk yang ikut: harga jualnya SELALU harga standar — dikoreksi tiap sinkron,
// saat modal berubah, saat edit di halaman Produk, dan saat persentase disimpan
// (dengan pratinjau & konfirmasi). Kalau persen BELUM diatur (null), fitur mati:
// produk baru untung Rp0 dan harga jual lama tidak disentuh.
// Harga yang diketik kasir di kotak konfirmasi transaksi TIDAK mengubah ini —
// itu hanya berlaku untuk transaksi itu.
const KUNCI_MARGIN_PERSEN = "margin_percent";
const KUNCI_MARGIN_PEMBULATAN = "margin_rounding";
const KUNCI_MARGIN_KECUALI = "margin_excluded_categories";
export const PEMBULATAN_HARGA_DEFAULT = 1000;
export const KATEGORI_DIKECUALIKAN_DEFAULT = ["TAGIHAN", "AIR PDAM"]; // = kategori pascabayar (POSTPAID_CATEGORIES)

function normKategori(k) {
  return String(k ?? "").trim().toUpperCase();
}

export function hitungHargaStandar(cost, percent, rounding = PEMBULATAN_HARGA_DEFAULT) {
  const c = Number(cost);
  const p = Number(percent);
  const r = Math.max(1, Math.floor(Number(rounding)) || PEMBULATAN_HARGA_DEFAULT);
  if (!(c > 0) || !Number.isFinite(p) || p < 0) return Math.max(0, c || 0);
  // dibulatkan 6 desimal dulu supaya sisa floating point (mis. 11000.000000000002)
  // tidak membuat ceil() melompat ke kelipatan berikutnya.
  const mentah = Math.round(((c * (100 + p)) / 100) * 1e6) / 1e6;
  return Math.ceil(mentah / r) * r;
}

/** Apakah produk ini ikut persentase? (lihat penjelasan di atas) */
export function ikutPersentase(product, pengaturan) {
  if (!product || !product.code) return false; // barang warung (tanpa kode)
  if (product.provider && product.provider !== "okeconnect") return false; // portalpulsa
  return !pengaturan.excludedCategories.includes(normKategori(product.category));
}

/** Validasi + normalisasi input pengaturan (dipakai simpan DAN pratinjau). */
export function normalisasiPengaturanHarga({ percent, rounding, excludedCategories } = {}) {
  let persen = null;
  if (percent !== null && percent !== undefined && percent !== "") {
    persen = Number(percent);
    if (!Number.isFinite(persen) || persen < 0 || persen > 1000) {
      throw new Error("Persentase laba harus angka antara 0 dan 1000.");
    }
    if (Math.abs(persen * 1000 - Math.round(persen * 1000)) > 1e-6) {
      throw new Error("Persentase laba maksimal 3 angka di belakang koma.");
    }
    persen = Math.round(persen * 1000) / 1000;
  }
  const pembulatan = rounding === undefined || rounding === null || rounding === "" ? PEMBULATAN_HARGA_DEFAULT : Number(rounding);
  if (!Number.isInteger(pembulatan) || pembulatan < 1 || pembulatan > 100000) {
    throw new Error("Pembulatan harus bilangan bulat antara 1 dan 100000.");
  }
  let kategori = KATEGORI_DIKECUALIKAN_DEFAULT;
  if (excludedCategories !== undefined && excludedCategories !== null) {
    const arr = Array.isArray(excludedCategories) ? excludedCategories : String(excludedCategories).split(/[,\n]/);
    kategori = [...new Set(arr.map(normKategori).filter(Boolean))];
  }
  return { percent: persen, rounding: pembulatan, excludedCategories: kategori };
}

export async function getPengaturanHarga(env) {
  const hasil = { percent: null, rounding: PEMBULATAN_HARGA_DEFAULT, excludedCategories: [...KATEGORI_DIKECUALIKAN_DEFAULT] };
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM app_state WHERE key IN (?, ?, ?)")
      .bind(KUNCI_MARGIN_PERSEN, KUNCI_MARGIN_PEMBULATAN, KUNCI_MARGIN_KECUALI)
      .all();
    for (const r of results) {
      if (r.key === KUNCI_MARGIN_PERSEN && r.value !== null && r.value !== "") {
        const n = Number(r.value);
        if (Number.isFinite(n) && n >= 0) hasil.percent = n;
      }
      if (r.key === KUNCI_MARGIN_PEMBULATAN) {
        const n = Math.floor(Number(r.value));
        if (n >= 1) hasil.rounding = n;
      }
      if (r.key === KUNCI_MARGIN_KECUALI) {
        try {
          const arr = JSON.parse(r.value);
          if (Array.isArray(arr)) hasil.excludedCategories = [...new Set(arr.map(normKategori).filter(Boolean))];
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error("Gagal baca pengaturan harga standar:", err.message);
  }
  return hasil;
}

export async function setPengaturanHarga(env, input) {
  const p = normalisasiPengaturanHarga(input);
  const upsert = `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`;
  await env.DB.batch([
    p.percent === null
      ? env.DB.prepare("DELETE FROM app_state WHERE key = ?").bind(KUNCI_MARGIN_PERSEN)
      : env.DB.prepare(upsert).bind(KUNCI_MARGIN_PERSEN, String(p.percent)),
    env.DB.prepare(upsert).bind(KUNCI_MARGIN_PEMBULATAN, String(p.rounding)),
    env.DB.prepare(upsert).bind(KUNCI_MARGIN_KECUALI, JSON.stringify(p.excludedCategories)),
  ]);
  return p;
}

/** Pratinjau (tanpa menulis apa pun): berapa produk OkeConnect aktif yang harganya
 * akan berubah kalau pengaturan ini diterapkan. `pengaturan` sudah dinormalisasi. */
export async function pratinjauHargaStandar(env, pengaturan) {
  const kosong = { total: 0, jumlah: 0, naik: 0, turun: 0, contoh: [] };
  if (pengaturan.percent == null) return kosong;
  const { results } = await env.DB.prepare(
    "SELECT code, name, category, cost_price, sell_price FROM products WHERE provider = 'okeconnect' AND code IS NOT NULL AND active = 1 AND cost_price > 0"
  ).all();
  const hasil = { ...kosong };
  const beda = [];
  for (const p of results) {
    if (!ikutPersentase({ ...p, provider: "okeconnect" }, pengaturan)) continue;
    hasil.total++;
    const baru = hitungHargaStandar(p.cost_price, pengaturan.percent, pengaturan.rounding);
    const lama = Number(p.sell_price);
    if (baru === lama) continue;
    hasil.jumlah++;
    if (baru > lama) hasil.naik++;
    else hasil.turun++;
    beda.push({ code: p.code, name: p.name, cost: Number(p.cost_price), lama, baru, selisih: baru - lama });
  }
  beda.sort((a, b) => Math.abs(b.selisih) - Math.abs(a.selisih));
  hasil.contoh = beda.slice(0, 8);
  return hasil;
}

/** Terapkan harga standar ke SEMUA produk OkeConnect aktif yang ikut persentase,
 * dalam satu UPDATE (hemat panggilan D1). Hitungannya integer murni:
 * ceil(cost × (100000+persen×1000) / (100000×pembulatan)) × pembulatan — sama
 * dengan hitungHargaStandar() untuk modal bilangan bulat. */
export async function terapkanHargaStandarSemua(env, pengaturan) {
  if (pengaturan.percent == null) return { diubah: 0 };
  const pm = Math.round(pengaturan.percent * 1000);
  const r = pengaturan.rounding;
  if (!Number.isInteger(pm) || !Number.isInteger(r) || r < 1) throw new Error("Pengaturan harga tidak valid.");
  const B = 100000 * r;
  const rumus = `((CAST(cost_price AS INTEGER) * (100000 + ${pm}) + ${B} - 1) / ${B}) * ${r}`;
  const kategori = pengaturan.excludedCategories;
  const filterKategori = kategori.length ? `AND UPPER(TRIM(COALESCE(category, ''))) NOT IN (${kategori.map(() => "?").join(",")})` : "";
  const res = await env.DB.prepare(
    `UPDATE products SET sell_price = ${rumus}
     WHERE provider = 'okeconnect' AND code IS NOT NULL AND active = 1 AND cost_price > 0
       ${filterKategori}
       AND sell_price != ${rumus}`
  )
    .bind(...kategori)
    .run();
  return { diubah: res.meta?.changes ?? 0 };
}

/** Edit/tambah produk MANUAL di halaman Produk: produk yang ikut persentase
 * SELALU diberi harga standar dari modalnya (isian harga jual diabaikan). Produk
 * lain (pascabayar, portalpulsa, warung) memakai harga jual yang diisi admin. */
export function tentukanHargaEditManual({ existing, costBaru, sellBaru }, pengaturan) {
  const sell = Number(sellBaru);
  if (pengaturan.percent == null || !existing) return { sell, diterapkan: false };
  const cost = Number(costBaru);
  if (!(cost > 0) || !ikutPersentase(existing, pengaturan)) return { sell, diterapkan: false };
  const std = hitungHargaStandar(cost, pengaturan.percent, pengaturan.rounding);
  return { sell: std, diterapkan: std !== sell };
}

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
      // Token PLN: "kode idpelanggan NoHP PIN" (lihat tentukanTargetTokenPln).
      buildTokenPlnBody(productCode, idpel, hp, pin) {
        return `${productCode} ${idpel} ${hp} ${pin}`;
      },
      // Pascabayar portalpulsa BELUM didukung (formatnya belum diketahui). Sengaja
      // throw eksplisit daripada diam-diam mengirim perintah yang salah format.
      // (Token PLN PRABAYAR sudah didukung lewat buildTokenPlnBody di atas.)
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
// Batas saldo minimal dompet distributor (per provider) agar transaksi PPOB boleh jalan.
export const MIN_SALDO_DISTRIBUTOR = 50000;

export async function placePpobOrder(env, { productCode, target, paidMethod = "tunai", contactId = null, batchId = null, telegramChatId = "", newProductProvider = null }) {
  // Kalau pemanggil eksplisit bilang "ini portalpulsa" (3 jalur khusus
  // portalpulsa: tab web, tombol bot, form Mini App), pencarian produknya
  // WAJIB ikut difilter provider juga. Tanpa ini, kode yang KEBETULAN sudah
  // ada di katalog OkeConnect (hasil sinkron) bakal "menang" duluan dan
  // newProductProvider diabaikan total — order jadi kekirim ke JID/PIN
  // OkeConnect walau user eksplisit pilih portalpulsa.
  let product;
  if (newProductProvider) {
    product = await env.DB.prepare("SELECT * FROM products WHERE code = ? AND provider = ?")
      .bind(productCode, newProductProvider)
      .first();
  } else {
    // Jaring pengaman: tidak ada caller TERKONFIRMASI yang sampai ke sini
    // tanpa newProductProvider (semua sudah diaudit & diperbaiki supaya
    // selalu kirim provider), tapi kalau suatu saat ada kode baru yang lupa
    // — JANGAN diam-diam .first() ambil baris pertama yang ketemu. Kalau
    // ternyata ada >1 produk dgn kode yg sama di provider berbeda, lebih
    // aman gagal tegas drpd salah kirim order ke provider yg salah.
    const { results } = await env.DB.prepare("SELECT * FROM products WHERE code = ?").bind(productCode).all();
    if (results.length > 1) {
      throw new Error(
        `Kode "${productCode}" ada di lebih dari satu provider (${results.map((p) => p.provider).join(", ")}) — ` +
          `tidak bisa ditentukan otomatis. Pilih produk lewat katalog/menu, bukan ketik kode polos.`
      );
    }
    product = results[0] || null;
  }
  if (!product) {
    // portalpulsa tidak punya katalog/price-list (lihat getProviderConfig) —
    // kasir mengetik kode manual, jadi produk baru diprovisi otomatis di sini
    // (cost_price/sell_price mulai dari 0, disesuaikan tiap transaksi lewat
    // kotak konfirmasi — lihat usesDynamicCost). Provider lain (OkeConnect)
    // TETAP wajib sudah ada di katalog hasil sinkron, supaya salah ketik kode
    // tidak diam-diam membuat "produk" baru yang sebenarnya cuma typo.
    if (newProductProvider === "portalpulsa") {
      // code sekarang unik PER-PROVIDER (UNIQUE(code, provider), lihat migrasi
      // 2026-09-30-products-code-unique-per-provider.sql) — kode yang sama
      // SAH dipakai provider lain (mis. kode OkeConnect "I10" dan kode
      // portalpulsa "I10" adalah dua produk yang berbeda, kebetulan sama
      // penulisannya). Tidak perlu lagi dicek/ditolak di sini.
      await env.DB.prepare(
        `INSERT INTO products (code, name, category, provider, cost_price, sell_price, active)
         VALUES (?, ?, NULL, 'portalpulsa', 0, 0, 1)`
      )
        .bind(productCode, productCode)
        .run();
      // AND provider = 'portalpulsa' WAJIB di sini — kalau tidak, dan ada
      // produk OkeConnect dgn kode yg sama, .first() bisa salah ambil baris
      // OkeConnect-nya alih-alih produk portalpulsa yg baru saja dibuat.
      product = await env.DB.prepare("SELECT * FROM products WHERE code = ? AND provider = 'portalpulsa'").bind(productCode).first();
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

  // BLOKIR transaksi kalau saldo dompet distributor provider ini kurang dari
  // MIN_SALDO_DISTRIBUTOR (Rp 50.000), atau dompetnya belum ada. Dicek SEBELUM
  // order disimpan & SEBELUM perintah dikirim ke provider. Angka yang dipakai
  // adalah wallets.balance (BUKAN cek langsung ke provider) — diperbarui lewat
  // tombol "Cek Saldo", deposit, dan tiap transaksi. Kalau saldo di sini sudah
  // basi, tekan Cek Saldo dulu untuk menyamakan dengan saldo asli provider.
  if (!wallet) {
    throw new Error(`Belum ada dompet distributor utk provider "${cfg.provider}" — transaksi tidak bisa diproses. Buat dulu dompet tipe Distributor PPOB di Pengaturan.`);
  }
  if (wallet.balance < MIN_SALDO_DISTRIBUTOR) {
    throw new Error(
      `Transaksi ditolak: saldo "${wallet.name}" Rp ${wallet.balance.toLocaleString("id-ID")} kurang dari batas minimal Rp ${MIN_SALDO_DISTRIBUTOR.toLocaleString("id-ID")}. Isi saldo dulu, lalu klik "Cek Saldo" untuk memperbarui.`
    );
  }
  const warning = null;

  const refId = "TX" + Date.now();

  // OkeConnect: pulsa/kuota/token prabayar pakai R#{ID} biasa, tagihan
  // pascabayar (listrik, PDAM, BPJS) pakai R#{ID}A (suffix "A") — CATATAN:
  // asumsi berdasarkan pola kategori, BELUM dikonfirmasi CS OkeConnect,
  // wajib dites dulu dengan transaksi kecil.
  // Token PLN portalpulsa punya format sendiri ("kode idpel NoHP PIN"): dicek &
  // dirakit SEBELUM menyimpan/mengirim apa pun, jadi kalau No. HP belum ada,
  // errornya jelas dan tidak ada perintah salah format yang terkirim.
  let body;
  let pln;
  let targetTersimpan = target;
  if (isPostpaid(product)) {
    body = cfg.buildPascaBayarBody(productCode, target, cfg.pin, refId);
  } else if (cfg.provider === "portalpulsa" && isTokenPlnPortalpulsa(productCode, (pln = await getPengaturanTokenPln(env)))) {
    const { idpel, hp } = tentukanTargetTokenPln(target, pln);
    body = cfg.buildTokenPlnBody(productCode, idpel, hp, cfg.pin);
    targetTersimpan = idpel; // struk/laporan menampilkan ID pelanggan sebagai tujuan
  } else {
    body = cfg.buildPrabayarBody(productCode, target, cfg.pin, refId);
  }

  // telegramChatId diisi kalau order ini dibuat dari Mini App (chat karyawan
  // sendiri) — supaya kalau balasan provider telat dan baru selesai lewat
  // cron, karyawan tetap dapat notifikasi balik ke Telegram-nya, bukan harus
  // ingat cek manual (lihat recheckOrder di index.js).
  await env.DB.prepare(
    `INSERT INTO ppob_orders (ref_id, telegram_chat_id, product_code, target, cost_price, sell_price, wallet_id, status, paid_method, contact_id, batch_id, provider, request_body)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
  )
    .bind(refId, String(telegramChatId || ""), productCode, targetTersimpan, product.cost_price, product.sell_price, wallet ? wallet.id : null, paidMethod, contactId, batchId, cfg.provider, body)
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

  // Harga jual di kotak konfirmasi HANYA berlaku untuk transaksi ini (masuk
  // laporan & struk) — harga standar produk tidak diubah. Pengecualian: produk
  // yang tidak ikut persentase (portalpulsa, pascabayar, dan kategori yang
  // dikecualikan admin — lihat ikutPersentase) tetap menyimpan harga terakhir
  // sebagai isian awal transaksi berikutnya, seperti sebelumnya.
  if (usesDynamicCost(product) || !ikutPersentase(product, await getPengaturanHarga(env))) {
    await env.DB.prepare("UPDATE products SET sell_price = ? WHERE id = ?").bind(sellPrice, product.id).run();
  }

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
 * Produk yang dinonaktifkan MANUAL (products.manually_disabled = 1, lewat
 * tombol "Nonaktifkan") tidak diaktifkan lagi oleh sinkron; harganya tetap
 * diperbarui. Hasil sinkron juga melaporkan failed/errors (batch yang gagal
 * ditulis) dan naikJadiRugi (modal naik melewati harga jual).
 *
 * HARGA JUAL: kalau admin sudah mengatur persentase laba standar (Pengaturan),
 * SEMUA produk yang ikut persentase (bukan pascabayar/portalpulsa/warung — lihat
 * ikutPersentase) selalu diberi harga standar = HPP × (1 + persen), dibulatkan ke
 * atas (hitungHargaStandar): produk baru, modal berubah, maupun harga yang
 * menyimpang. Kalau persen belum diatur: produk baru untung Rp0 dan harga lama
 * tidak disentuh. */
export async function syncPpobPrices(env, opts = {}) {
  // opts.force = true -> lewati pengaman "daftar harga menyusut drastis" (lihat
  // guard di bawah). Dipakai kalau admin memang yakin provider menghapus banyak
  // produk sekaligus.
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
    "SELECT id, code, name, category, product_group, cost_price, sell_price, active, manually_disabled FROM products WHERE provider = 'okeconnect' AND code IS NOT NULL"
  ).all();
  for (const row of existingRows) existingMap.set(row.code, row);

  // Persentase laba standar (null = belum diatur → harga jual lama tidak disentuh).
  const hargaStd = await getPengaturanHarga(env);

  const runStartedAt = new Date().toISOString();
  const stmt = env.DB.prepare(
    `INSERT INTO products (code, name, category, product_group, cost_price, sell_price, active, deactivated_at, last_synced_at, provider)
     VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, 'okeconnect')
     ON CONFLICT(code, provider) DO UPDATE SET
       name = excluded.name,
       category = excluded.category,
       product_group = excluded.product_group,
       cost_price = excluded.cost_price,
       sell_price = CASE WHEN excluded.sell_price < 0 THEN products.sell_price ELSE excluded.sell_price END,
       active = CASE WHEN products.manually_disabled = 1 THEN products.active ELSE 1 END,
       deactivated_at = CASE WHEN products.manually_disabled = 1 THEN products.deactivated_at ELSE NULL END,
       last_synced_at = excluded.last_synced_at`
  );

  const batchItems = [];
  const seenActiveCodes = new Set();
  const blockedCodes = new Set(); // kode yang kena kata kunci PADA RUN INI — dipakai buat hapus permanen di bawah
  let skipped = 0;
  let blocked = 0;
  let unchanged = 0;
  let naikJadiRugi = 0; // modal NAIK dan harga jual akhirnya tetap di bawah modal (hanya mungkin kalau persen belum diatur)
  let modalNaik = 0;
  let modalTurun = 0;
  let hargaDisesuaikan = 0; // harga jual dikoreksi ke harga standar (modal berubah ATAU harga sebelumnya menyimpang)
  let produkBaru = 0;

  for (const item of list) {
    const code = item.kode || item.code || item.product_code;
    const name = item.keterangan || item.produk || item.nama || item.name;
    const category = item.kategori || item.category || null;
    const productGroup = item.produk || null;
    const cost = Number(item.harga || item.price || 0);
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

    // Harga jual (lihat hitungHargaStandar & ikutPersentase):
    //  - produk yang ikut persentase: SELALU harga standar (HPP × (1 + persen)),
    //    jadi harga yang menyimpang ikut dikoreksi tiap sinkron, bukan cuma saat
    //    modal berubah. Hanya yang berbeda yang ditulis (hemat kuota D1).
    //  - tagihan/pascabayar & produk lain yang tidak ikut: sell_price tidak
    //    disentuh (sell = -1 → lihat ON CONFLICT); produk baru = modal.
    //  - persen belum diatur: perilaku lama (produk baru = modal, lama tak disentuh).
    const ikut = ikutPersentase({ code, provider: "okeconnect", category }, hargaStd);
    const kena = hargaStd.percent != null && cost > 0 && ikut;
    const costBerubah = !!existing && Number(existing.cost_price) !== cost;
    let sell = -1;
    if (!existing) {
      sell = kena ? hitungHargaStandar(cost, hargaStd.percent, hargaStd.rounding) : cost;
      produkBaru++;
    } else if (kena) {
      const std = hitungHargaStandar(cost, hargaStd.percent, hargaStd.rounding);
      if (std !== Number(existing.sell_price)) {
        sell = std;
        hargaDisesuaikan++;
      }
    }
    if (existing && costBerubah) {
      if (cost > Number(existing.cost_price)) modalNaik++;
      else modalTurun++;
      const hargaAkhir = sell >= 0 ? sell : Number(existing.sell_price);
      if (ikut && cost > Number(existing.cost_price) && hargaAkhir < cost) naikJadiRugi++;
    }
    const changed =
      !existing ||
      sell >= 0 ||
      (existing.active !== 1 && !existing.manually_disabled) ||
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

  // PENGAMAN: kalau sumber membalas kosong / jauh lebih sedikit dari produk
  // aktif yang sudah ada (mis. balasan error berstatus 200 seperti {} atau
  // {"status":"error"}), JANGAN lanjut — kalau lanjut, semua produk yang
  // "tidak muncul" akan dinonaktifkan massal, lalu ditulis ulang massal saat
  // sinkron berikutnya (boros kuota tulis D1). Produk yang kena kata kunci
  // blokir tidak dihitung karena memang sengaja tidak ikut.
  const existingActiveCount = existingRows.filter((r) => r.active === 1 && !blockedCodes.has(r.code)).length;
  if (!opts.force) {
    if (list.length === 0 || seenActiveCodes.size === 0) {
      return {
        ok: false,
        needsForce: list.length > 0,
        error: "Daftar harga dari sumber kosong — sinkron dibatalkan supaya produk yang ada tidak dinonaktifkan semua. Cek PRICE_LIST_URL / balasan server OkeConnect.",
      };
    }
    if (existingActiveCount >= 20 && seenActiveCodes.size < existingActiveCount * 0.5) {
      return {
        ok: false,
        needsForce: true,
        error: `[butuh-konfirmasi] Daftar harga dari sumber cuma ${seenActiveCodes.size} produk aktif, padahal di database ada ${existingActiveCount}. Sinkron dibatalkan karena bisa menonaktifkan banyak produk sekaligus. Kalau memang benar provider menghapus produk sebanyak itu, ulangi dengan sinkron paksa.`,
      };
    }
  }

  // D1 membatasi 100 bound parameter PER STATEMENT (batas ini berlaku untuk
  // tiap statement di dalam batch(), bukan total satu batch — lihat dokumentasi
  // D1 Limits). Statement INSERT ini 7 parameter per baris, jadi 50 baris per
  // batch aman. Batch lebih besar = lebih sedikit panggilan D1 per sinkron
  // (penting untuk batas query per invocation Worker).
  const BATCH_SIZE = 50;
  let count = 0;
  let failed = 0;
  let belumDiproses = 0;
  const errors = [];
  for (let i = 0; i < batchItems.length; i += BATCH_SIZE) {
    const chunk = batchItems.slice(i, i + BATCH_SIZE);
    try {
      await env.DB.batch(chunk);
      count += chunk.length;
    } catch (err) {
      failed += chunk.length;
      errors.push(`batch mulai index ${i}: ${err.message}`);
      // Kena batas jumlah panggilan per invocation Worker: batch sisanya pasti
      // gagal juga, jadi berhenti. Baris yang belum ditulis tetap berbeda dari
      // database, jadi sinkron berikutnya melanjutkan otomatis.
      if (/too many (api requests|subrequests)/i.test(err.message)) {
        belumDiproses = Math.max(0, batchItems.length - (i + chunk.length));
        break;
      }
    }
  }
  const lastError = errors.length ? errors[errors.length - 1] : null;

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
    failed,
    belumDiproses,
    errors: errors.slice(0, 5),
    naikJadiRugi,
    modalNaik,
    modalTurun,
    hargaDisesuaikan,
    produkBaru,
    hargaStandarAktif: hargaStd.percent != null,
    persenLaba: hargaStd.percent,
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
//
// Balasan ASLI portalpulsa untuk "S PIN" (dites langsung 2026-11):
//   "Sisa saldo Anda saat ini:  Rp 83.177 # Ayo transaksi terus biar dapet bonus mingguan"
// Ada teks "Anda saat ini:" di antara kata "saldo" dan angkanya, jadi pola lama
// ("Saldo" langsung diikuti angka) gagal. Pola sekarang: kata "saldo", lalu teks
// tanpa angka (maks 40 karakter, boleh memuat "Anda saat ini:", "Rp", dsb.), lalu
// angka pertama. Angka format Indonesia: titik = pemisah ribuan, koma = desimal.
export function parseBalanceReply(reply) {
  if (typeof reply !== "string") return null;
  // Pesan penolakan seperti "Saldo Anda tidak mencukupi untuk transaksi 5.000" memuat
  // angka yang BUKAN saldo — jangan dibaca (lebih aman gagal daripada menimpa saldo salah).
  if (/tidak\s+(?:cukup|mencukupi)|\bkurang\b/i.test(reply)) return null;
  const match = reply.match(/saldo[^\d\-]{0,40}?(-?\d[\d.,]*)/i);
  if (!match) return null;
  // buang titik ribuan, koma jadi desimal; titik/koma di ujung (akhir kalimat) dibuang
  const mentah = match[1].replace(/[.,]+$/, "").replace(/\./g, "").replace(",", ".");
  const n = Number(mentah);
  return Number.isFinite(n) ? n : null;
}

// Balasan cek saldo yang sudah final: kata "saldo" diikuti angka (sama dengan
// parseBalanceReply). Dipakai agar sesi Jabber berhenti begitu angka saldo masuk.
const POLA_BALASAN_SALDO = /saldo[^\d\-]{0,40}?-?\d/i;

// Saringan feed untuk cek saldo otomatis: ack perintah "'S <pin>' Telah kami
// terima..." dan balasan "Sisa saldo Anda saat ini: ..." tidak perlu masuk Telegram.
const SARING_FEED_CEK_SALDO = (teks) => /^\s*'?S\s/i.test(teks) || /^\s*Sisa saldo\b/i.test(teks);

export async function checkDistributorBalance(env, provider = "okeconnect", opts = {}) {
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
    finalReplyPattern: POLA_BALASAN_SALDO,
    skipFeedIf: opts.senyap ? SARING_FEED_CEK_SALDO : null,
  });

  const balance = parseBalanceReply(reply);
  if (balance === null) {
    // Sertakan cuplikan balasan di pesan error supaya langsung kelihatan di layar
    // apa yang diterima (sebelumnya cuma ada di field raw_reply yang tidak ditampilkan UI).
    const cuplikan = String(reply ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    return { ok: false, error: `Tidak bisa membaca angka saldo dari balasan. Balasan yang diterima: "${cuplikan || "(kosong)"}"`, raw_reply: reply };
  }

  // portalpulsa: kalau saldo asli naik PERSIS sebesar nominal transfer sebuah
  // deposit yang masih menunggu (balasan "SUKSES" susulannya belum sampai),
  // deposit itu dianggap sukses & mutasi dompet langsung dicatat otomatis.
  let depositInfo = null;
  if (cfg.provider === "portalpulsa") {
    depositInfo = await rekonsiliasiDepositDariSaldo(env, { wallet, saldoAsli: balance });
  } else if (cfg.provider === "okeconnect") {
    // OkeConnect tidak punya alur deposit di aplikasi ini, jadi satu-satunya
    // tanda deposit adalah saldo asli naik >= MIN_DEPOSIT_OTOMATIS.
    depositInfo = await rekonsiliasiDepositOkeconnect(env, { wallet, saldoAsli: balance });
  }

  // Kalau deposit terkonfirmasi, saldo sudah ditimpa ke angka asli di dalam
  // selesaikanDepositSusulan — tidak perlu ditimpa dua kali.
  if (!depositInfo || !depositInfo.dikonfirmasi) {
    await env.DB.prepare("UPDATE wallets SET balance = ? WHERE id = ?").bind(balance, wallet.id).run();
  }

  return {
    ok: true,
    wallet_id: wallet.id,
    wallet_name: wallet.name,
    balance_before: wallet.balance,
    balance_after: balance,
    raw_reply: reply,
    deposit: depositInfo,
  };
}

/**
 * Cek saldo portalpulsa OTOMATIS selama ada deposit `pending` — supaya deposit
 * yang balasan SUKSES-nya telat (1–2 jam) tetap terkonfirmasi tanpa menunggu
 * tombol Cek Saldo ditekan. Dipanggil dari cron (tiap 5 menit), tapi sendiri
 * dibatasi:
 *  - hanya jalan kalau ada deposit pending berumur >= umurMinimalMenit (memberi
 *    waktu transfer) dan < 13 jam (batas kedaluwarsa);
 *  - paling sering sekali per jedaMenit (dicatat di app_state);
 *  - senyap ke Telegram (lihat SARING_FEED_CEK_SALDO).
 * Balasan yang ternyata "Deposit … SUKSES/DIBATALKAN" (pesan susulan yang
 * kebetulan tertangkap sesi ini) tetap diproses lewat selesaikanDepositSusulan.
 * `deps.cek` hanya untuk pengujian.
 * @returns {Promise<{dijalankan:boolean, alasan?:string, pesan?:string, dikonfirmasi?:boolean}>}
 */
export async function cekSaldoOtomatisDepositPending(env, { jedaMenit = 10, umurMinimalMenit = 5, deps = {} } = {}) {
  const cek = deps.cek || checkDistributorBalance;
  const adaPending = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM portalpulsa_deposits
     WHERE status = 'pending' AND created_at <= datetime('now', ?) AND created_at > datetime('now', '-13 hours')`
  )
    .bind(`-${Number(umurMinimalMenit)} minutes`)
    .first();
  if (!adaPending || !adaPending.n) return { dijalankan: false, alasan: "tidak ada deposit pending yang perlu dicek" };

  const baruSaja = await env.DB.prepare("SELECT 1 AS x FROM app_state WHERE key = ? AND value > datetime('now', ?)")
    .bind(KUNCI_AUTO_CEK_SALDO, `-${Number(jedaMenit)} minutes`)
    .first();
  if (baruSaja) return { dijalankan: false, alasan: "belum waktunya (baru dicek)" };
  // Catat waktu SEBELUM mengirim, supaya kalau gagal/lambat cron berikutnya tidak menghujani Jabber.
  await env.DB.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, datetime('now'), datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = datetime('now'), updated_at = datetime('now')`
  )
    .bind(KUNCI_AUTO_CEK_SALDO)
    .run();

  const hasil = await cek(env, "portalpulsa", { senyap: true });
  const keluaran = { dijalankan: true, ok: !!hasil.ok, dikonfirmasi: false };

  if (hasil.ok && hasil.deposit?.dikonfirmasi) {
    keluaran.dikonfirmasi = true;
    keluaran.pesan = hasil.deposit.pesan;
  }
  // Pesan susulan yang tertangkap sebagai "balasan": proses juga (aman diulang —
  // selesaikanDepositSusulan hanya menerima deposit yang masih pending).
  const susulan = parseDepositSusulan(String(hasil.raw_reply || ""));
  if (susulan) {
    const r = await selesaikanDepositSusulan(env, {
      nominal: susulan.nominal,
      status: susulan.status,
      saldoAkhir: susulan.saldoAkhir,
      alasan: susulan.alasan,
      rawText: hasil.raw_reply,
    });
    if (r && r.status === "sukses") {
      keluaran.dikonfirmasi = true;
      keluaran.pesan = `Deposit #${r.depositId} SUKSES — mutasi dompet tercatat otomatis.`;
    }
  }
  return keluaran;
}

/**
 * Cocokkan kenaikan saldo asli portalpulsa dengan deposit yang belum
 * terkonfirmasi. selisih = saldoAsli - wallets.balance (database). Dianggap
 * deposit hanya kalau selisih SAMA PERSIS dengan nominal_transfer (nominal +
 * kode unik) tepat satu deposit — selisih lain (penyimpangan biasa) tidak
 * ditebak-tebak. Deposit yang sudah ditandai gagal/kedaluwarsa dalam 3 hari
 * terakhir (tanpa mutasi) juga dicocokkan, karena bisa jadi transfernya
 * sampai walau balasan providernya tidak pernah datang.
 *
 * @returns {Promise<{dikonfirmasi:boolean, pesan:string, depositId?:number}|null>}
 */
export async function rekonsiliasiDepositDariSaldo(env, { wallet, saldoAsli }) {
  const selisih = saldoAsli - wallet.balance;
  if (selisih <= 0) return null;

  const { results } = await env.DB.prepare(
    `SELECT * FROM portalpulsa_deposits
     WHERE nominal_transfer = ? AND transaction_id IS NULL
       AND (status = 'pending' OR (status = 'gagal' AND created_at >= datetime('now', '-3 days')))
     ORDER BY id DESC`
  )
    .bind(selisih)
    .all();

  if (results.length === 0) {
    return { dikonfirmasi: false, pesan: `Saldo naik Rp ${selisih.toLocaleString("id-ID")}, belum cocok dengan deposit mana pun (saldo hanya disinkronkan).` };
  }
  if (results.length > 1) {
    return { dikonfirmasi: false, pesan: `Saldo naik Rp ${selisih.toLocaleString("id-ID")} cocok dengan ${results.length} deposit sekaligus — tidak dicatat otomatis, catat manual lewat Mutasi.` };
  }

  const deposit = results[0];
  if (deposit.status === "gagal") {
    // Buka lagi supaya selesaikanDepositSusulan (hanya menerima 'pending') bisa mencatatnya.
    await env.DB.prepare("UPDATE portalpulsa_deposits SET status = 'pending' WHERE id = ?").bind(deposit.id).run();
  }
  const r = await selesaikanDepositSusulan(env, {
    nominal: deposit.nominal_transfer,
    status: "sukses",
    saldoAkhir: saldoAsli,
    alasan: null,
    rawText: `[Sistem] Dikonfirmasi lewat Cek Saldo: saldo portalpulsa naik Rp ${selisih.toLocaleString("id-ID")} (sama dengan nominal transfer).`,
  });
  if (!r) return { dikonfirmasi: false, pesan: "Deposit cocok tapi gagal dicatat." };
  return {
    dikonfirmasi: true,
    depositId: r.depositId,
    pesan: `Deposit Rp ${selisih.toLocaleString("id-ID")} terkonfirmasi SUKSES dan mutasi dompet sudah tercatat otomatis.`,
  };
}


// ---------------------------------------------------------------------------
// DEPOSIT OKECONNECT OTOMATIS (dari kenaikan saldo di tombol Cek Saldo)
//
// OkeConnect tidak punya perintah deposit lewat aplikasi ini, jadi aplikasi
// tidak tahu kapan Anda deposit. Tandanya cuma: saldo asli naik. Aturannya:
//   - selisih = saldo asli - wallets.balance (database)
//   - selisih >= MIN_DEPOSIT_OTOMATIS (Rp 50.000) -> dianggap deposit, mutasi
//     langsung dicatat dari dompet sumber default (BRI, bisa diganti di
//     Pengaturan) ke dompet Saldo Distributor OkeConnect
//   - selisih lebih kecil -> hanya sinkron saldo (biasanya selisih modal)
// RISIKO: koreksi/refund dari provider yang besar akan terbaca sebagai
// deposit. Karena itu hasilnya mengembalikan transactionId supaya UI bisa
// menawarkan tombol "Bukan deposit" (batalkanDepositOtomatis).
// ---------------------------------------------------------------------------
export const MIN_DEPOSIT_OTOMATIS = 50000;
const KATEGORI_DEPOSIT_OKECONNECT = "Deposit OkeConnect";
const KUNCI_DOMPET_DEPOSIT_OKECONNECT = "deposit_wallet_okeconnect";
const KUNCI_AUTO_CEK_SALDO = "portalpulsa_auto_cek_saldo_at"; // throttle cek saldo otomatis deposit pending

/** Dompet sumber default deposit OkeConnect: yang dipilih di Pengaturan, kalau
 * belum dipilih jatuh ke dompet (bukan distributor) yang namanya mengandung "BRI". */
export async function getDompetDepositOkeconnect(env) {
  const row = await env.DB.prepare("SELECT value FROM app_state WHERE key = ?").bind(KUNCI_DOMPET_DEPOSIT_OKECONNECT).first();
  if (row && row.value) {
    const w = await env.DB.prepare("SELECT * FROM wallets WHERE id = ? AND type != 'distributor_ppob'").bind(Number(row.value)).first();
    if (w) return w;
  }
  return await env.DB.prepare("SELECT * FROM wallets WHERE type != 'distributor_ppob' AND UPPER(name) LIKE '%BRI%' ORDER BY id LIMIT 1").first();
}

export async function setDompetDepositOkeconnect(env, walletId) {
  const w = await env.DB.prepare("SELECT id FROM wallets WHERE id = ? AND type != 'distributor_ppob'").bind(Number(walletId)).first();
  if (!w) throw new Error("Dompet tidak ditemukan (dompet distributor tidak bisa jadi sumber deposit).");
  await env.DB.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  )
    .bind(KUNCI_DOMPET_DEPOSIT_OKECONNECT, String(w.id))
    .run();
}

export async function rekonsiliasiDepositOkeconnect(env, { wallet, saldoAsli }) {
  const selisih = saldoAsli - wallet.balance;
  const fmt = (n) => "Rp " + n.toLocaleString("id-ID");
  if (selisih < MIN_DEPOSIT_OTOMATIS) return null;

  const sumber = await getDompetDepositOkeconnect(env);
  if (!sumber) {
    return {
      dikonfirmasi: false,
      pesan: `Saldo naik ${fmt(selisih)} (kemungkinan deposit), tapi dompet sumber default belum ada — mutasi TIDAK dicatat. Pilih dompet sumber deposit OkeConnect di Pengaturan.`,
    };
  }

  const note = `Deposit OkeConnect (dikonfirmasi lewat Cek Saldo: saldo naik ${fmt(selisih)})`;
  const tx = await env.DB.prepare(
    `INSERT INTO transactions (type, category, wallet_id, to_wallet_id, amount, cost_total, note)
     VALUES ('mutation', ?, ?, ?, ?, 0, ?)`
  )
    .bind(KATEGORI_DEPOSIT_OKECONNECT, sumber.id, wallet.id, selisih, note)
    .run();
  const transactionId = tx.meta.last_row_id;

  await env.DB.batch([
    env.DB.prepare("UPDATE wallets SET balance = balance - ? WHERE id = ?").bind(selisih, sumber.id),
    // Saldo distributor ditimpa angka asli dari provider (bukan += selisih).
    env.DB.prepare("UPDATE wallets SET balance = ? WHERE id = ?").bind(saldoAsli, wallet.id),
  ]);

  return {
    dikonfirmasi: true,
    transactionId,
    nominal: selisih,
    sumberNama: sumber.name,
    pesan: `Saldo naik ${fmt(selisih)}, dicatat sebagai deposit dari ${sumber.name}. Jika ini koreksi provider, tekan "Bukan deposit".`,
  };
}

/** Batalkan mutasi deposit otomatis (tombol "Bukan deposit"): kembalikan saldo
 * dompet sumber & hapus mutasinya. Saldo distributor TIDAK disentuh — angkanya
 * sudah saldo asli dari provider. Hanya berlaku utk mutasi kategori deposit
 * OkeConnect yang dibuat otomatis lewat Cek Saldo. */
export async function batalkanDepositOtomatis(env, transactionId) {
  const tx = await env.DB.prepare(
    "SELECT * FROM transactions WHERE id = ? AND type = 'mutation' AND category = ? AND note LIKE '%dikonfirmasi lewat Cek Saldo%'"
  )
    .bind(Number(transactionId), KATEGORI_DEPOSIT_OKECONNECT)
    .first();
  if (!tx) throw new Error("Mutasi deposit tidak ditemukan (mungkin sudah dibatalkan).");
  await env.DB.batch([
    env.DB.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?").bind(tx.amount, tx.wallet_id),
    env.DB.prepare("DELETE FROM transactions WHERE id = ?").bind(tx.id),
  ]);
  return { ok: true, amount: tx.amount, wallet_id: tx.wallet_id };
}
