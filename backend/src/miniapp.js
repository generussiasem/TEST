import { Hono } from "hono";
import { verifyTelegramInitData } from "./telegram-miniapp-auth.js";
import { placePpobOrder, cekTagihan, finalizePpobOrder, kirimDepositPortalpulsa, formatBarisDeposit } from "./ppob.js";
import { DebtError, bayarHutang, titipUang, catatHutangManual } from "./debt.js";

// ---------------------------------------------------------------------------
// MINI APP TELEGRAM — dipasang di /api/miniapp/* (dipisah dari /api/* biasa
// karena caranya login BEDA: bukan Bearer token hasil /api/auth/login, tapi
// header X-Telegram-Init-Data yang dikirim otomatis oleh Telegram.WebApp saat
// mini app dibuka dari bot. Dipakai bersama halaman statis GET /miniapp
// (lihat miniapp-page.js) yang di-load di dalam Telegram.
//
// Karyawan HARUS sudah terhubung dulu (telegram_id di tabel employees) lewat
// "/hubung KODE" di bot — sama seperti yang dipakai menu tombol bot admin di
// bot-admin.js. Kalau belum terhubung, semua endpoint di sini menolak dengan
// pesan yang jelas supaya karyawan tahu harus /hubung dulu.
//
// Sengaja TIDAK menduplikasi seluruh logika /api/debts atau /api/ppob/* dari
// index.js satu-satu — cuma endpoint yang benar-benar dipakai mini app, dan
// yang menyentuh database (ppob_orders, debts, dst) tetap lewat fungsi yang
// SAMA dari ppob.js (placePpobOrder/cekTagihan/finalizePpobOrder) supaya
// perilakunya konsisten dengan jalur web & bot.
// ---------------------------------------------------------------------------

const miniapp = new Hono();

miniapp.use("*", async (c, next) => {
  const initData = c.req.header("x-telegram-init-data");
  const result = await verifyTelegramInitData(c.env.TELEGRAM_BOT_TOKEN, initData);
  if (!result || !result.user) {
    return c.json(
      { ok: false, error: "Data Telegram tidak valid/kedaluwarsa. Tutup dan buka lagi mini app ini dari bot." },
      401
    );
  }
  const employee = await c.env.DB.prepare("SELECT * FROM employees WHERE telegram_id = ? AND active = 1")
    .bind(String(result.user.id))
    .first();
  if (!employee) {
    return c.json(
      {
        ok: false,
        error: "Akun Telegram ini belum terhubung ke karyawan manapun. Kirim /hubung KODE ke bot dulu (kode dari halaman Karyawan di web), lalu buka mini app ini lagi.",
      },
      403
    );
  }
  c.set("employee", { employeeId: employee.id, role: employee.role, name: employee.name, telegramId: employee.telegram_id });
  await next();
});

// ---------------------------------------------------------------------------
// PROFIL — dipanggil saat mini app pertama kali dibuka, buat sapaan & cek
// bahwa koneksi Telegram <-> karyawan masih valid.
// ---------------------------------------------------------------------------
miniapp.get("/me", async (c) => {
  const store = await c.env.DB.prepare("SELECT store_name FROM store_settings WHERE id = 1").first();
  return c.json({ ok: true, employee: c.get("employee"), storeName: store?.store_name || "Toko" });
});

// ---------------------------------------------------------------------------
// KONTAK & HUTANG PIUTANG
// ---------------------------------------------------------------------------

// Cari kontak (buat pilih siapa yang mau dicatat hutang/dibayar hutangnya).
// Tanpa ?q= -> tampilkan yang hutangnya paling besar dulu (paling relevan
// buat ditagih/dibayar).
miniapp.get("/contacts", async (c) => {
  const q = (c.req.query("q") || "").trim();
  const { results } = q
    ? await c.env.DB.prepare(
        "SELECT id, name, phone, type, total_debt, deposit FROM contacts WHERE name LIKE ? OR phone LIKE ? ORDER BY name LIMIT 20"
      )
        .bind(`%${q}%`, `%${q}%`)
        .all()
    : await c.env.DB.prepare(
        "SELECT id, name, phone, type, total_debt, deposit FROM contacts ORDER BY total_debt DESC, name LIMIT 20"
      ).all();
  return c.json(results);
});

// Detail satu kontak + riwayat hutang terakhir (dipakai sebelum catat/bayar).
miniapp.get("/contacts/:id/debts", async (c) => {
  const id = c.req.param("id");
  const contact = await c.env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first();
  if (!contact) return c.json({ ok: false, error: "Kontak tidak ditemukan" }, 404);
  const { results } = await c.env.DB.prepare("SELECT * FROM debts WHERE contact_id = ? ORDER BY date DESC LIMIT 10")
    .bind(id)
    .all();
  return c.json({ ok: true, contact, riwayat: results });
});

// Kontak baru langsung dari mini app (mis. pelanggan belum pernah dicatat).
miniapp.post("/contacts", async (c) => {
  const { name, phone } = await c.req.json();
  if (!name) return c.json({ ok: false, error: "Nama wajib diisi" }, 400);
  const result = await c.env.DB.prepare("INSERT INTO contacts (name, phone, type) VALUES (?, ?, 'pelanggan')")
    .bind(name, phone || null)
    .run();
  const contact = await c.env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(result.meta.last_row_id).first();
  return c.json({ ok: true, contact });
});

// Dompet tempat uang pembayaran hutang/titipan diterima (dompet saldo
// distributor PPOB sengaja tidak ikut — itu bukan tempat uang pelanggan).
// Kirim ?all=1 untuk dapat SEMUA tipe dompet termasuk distributor_ppob —
// dipakai khusus menu Mutasi Antar Akun, yang (sama seperti di web,
// index.js POST /api/transactions type='mutation') tidak membatasi tipe
// dompet: dompet distributor PPOB boleh jadi asal/tujuan mutasi, mis. buat
// koreksi manual saldo distributor.
miniapp.get("/wallets", async (c) => {
  const includeAll = c.req.query("all") === "1";
  const { results } = await c.env.DB.prepare(
    includeAll
      ? "SELECT id, name, type FROM wallets ORDER BY id"
      : "SELECT id, name, type FROM wallets WHERE type != 'distributor_ppob' ORDER BY id"
  ).all();
  return c.json(results);
});

// Catat hutang baru, bayar hutang, atau titip uang — dibedakan lewat "type":
//   "piutang" -> pelanggan berhutang ke toko (menambah total_debt), tanpa dompet
//   "cicilan" -> BAYAR hutang: wajib walletId; kalau uang diterima melebihi sisa
//                hutang, wajib "kelebihan" = "kembalikan" | "titipkan"
//   "titip"   -> pelanggan menitipkan uang: wajib walletId
// Logikanya sama persis dengan dashboard web (debt.js).
miniapp.post("/debts", async (c) => {
  const { contactId, type, amount, note, walletId, kelebihan } = await c.req.json();
  const employee = c.get("employee");
  const noteFinal = note ? `${note} (via mini app oleh ${employee.name})` : `via mini app oleh ${employee.name}`;
  try {
    let contact;
    if (type === "cicilan") {
      const r = await bayarHutang(c.env, { contactId, amount, walletId, kelebihan, note: noteFinal, employeeId: employee.employeeId });
      contact = r.contact;
    } else if (type === "titip") {
      const r = await titipUang(c.env, { contactId, amount, walletId, note: noteFinal, employeeId: employee.employeeId });
      contact = r.contact;
    } else {
      contact = await catatHutangManual(c.env, { contactId, type, amount, note: noteFinal });
    }
    return c.json({ ok: true, contact });
  } catch (err) {
    if (err instanceof DebtError) return c.json({ ok: false, error: err.message }, 400);
    throw err;
  }
});

// ---------------------------------------------------------------------------
// PRODUK & TRANSAKSI PPOB
// ---------------------------------------------------------------------------

// Cari produk PPOB aktif (pulsa/kuota/token/tagihan) buat dipilih sebelum order.
miniapp.get("/products", async (c) => {
  const q = (c.req.query("q") || "").trim();
  // Dibatasi ke OkeConnect: hasil pencarian ini dipilih di klien cuma lewat
  // kecocokan "code" (lihat miniapp-page.js, rows.find(r => r.code === ...)) —
  // sejak code boleh sama lintas provider, portalpulsa WAJIB tidak ikut di
  // sini supaya pilihan kasir tidak pernah ambigu. portalpulsa sendiri sudah
  // py form manual terpisah ("Kode Manual (portalpulsa)").
  const where = ["active = 1", "code IS NOT NULL", "provider = 'okeconnect'"];
  const params = [];
  if (q) {
    where.push("(name LIKE ? OR code LIKE ? OR product_group LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  // cost_price (HPP/modal) HANYA dikirim ke admin — kasir biasa tidak boleh
  // melihat modal toko (sama seperti aturan di bot & dashboard web).
  const employee = c.get("employee");
  const kolomHpp = employee.role === "admin" ? ", cost_price, provider" : "";
  const { results } = await c.env.DB.prepare(
    `SELECT code, name, category, product_group, sell_price${kolomHpp} FROM products WHERE ${where.join(" AND ")} ORDER BY product_group, sell_price ASC LIMIT 25`
  )
    .bind(...params)
    .all();
  return c.json(results);
});

// Katalog PPOB lengkap (bukan cuma hasil pencarian terbatas 25 seperti
// /products) — dipakai tab "Katalog" buat lihat-lihat semua harga per
// kategori sebelum order, tanpa wajib ketik kata kunci dulu. cost_price
// (HPP/modal) cuma ikut untuk admin — urusan internal toko, kasir biasa
// tidak melihatnya.
miniapp.get("/catalog", async (c) => {
  const employee = c.get("employee");
  const kolomHpp = employee.role === "admin" ? ", cost_price, provider" : "";
  // provider = 'okeconnect' eksplisit (bukan cuma mengandalkan category NULL
  // pada produk portalpulsa) — sama alasannya dgn /products di atas.
  const { results } = await c.env.DB.prepare(
    `SELECT code, name, category, product_group, sell_price${kolomHpp} FROM products
     WHERE active = 1 AND code IS NOT NULL AND provider = 'okeconnect'
     ORDER BY category, product_group, sell_price ASC`
  ).all();
  return c.json(results);
});

// Cek tagihan/nama pelanggan dulu (PDAM/listrik/BPJS) SEBELUM benar-benar bayar
// — sama seperti tombol "Cek" di halaman PPOB web, tidak memotong saldo.
miniapp.post("/ppob/cek", async (c) => {
  const { productCode, target } = await c.req.json();
  if (!productCode || !target) return c.json({ ok: false, error: "productCode dan target wajib diisi" }, 400);
  try {
    const result = await cekTagihan(c.env, { productCode, target });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 400);
  }
});

// Order PPOB baru dari mini app — logikanya SAMA PERSIS dengan /api/ppob/order
// di dashboard web (fungsi placePpobOrder yang sama), cuma jalur masuknya lewat
// Telegram Mini App. paidMethod "utang" wajib sertakan contactId.
miniapp.post("/ppob/order", async (c) => {
  const { productCode, target, paidMethod, contactId, newProductProvider } = await c.req.json();
  if (!productCode || !target) return c.json({ ok: false, error: "productCode dan target wajib diisi" }, 400);
  const employee = c.get("employee");
  try {
    // telegramChatId = chat karyawan ini sendiri, supaya kalau balasan provider
    // telat (Mini App sudah berhenti polling), cron tetap bisa mengabari balik.
    // newProductProvider: dikirim frontend HANYA utk kode baru yg belum ada di
    // katalog (form manual portalpulsa) — diabaikan backend kalau kode sudah
    // dikenal (lihat placePpobOrder di ppob.js).
    const result = await placePpobOrder(c.env, { productCode, target, paidMethod, contactId, telegramChatId: employee.telegramId, newProductProvider });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 400);
  }
});

// Polling status order (dipanggil berulang oleh mini app sampai bukan "pending").
miniapp.get("/ppob-orders/:refId", async (c) => {
  const order = await c.env.DB.prepare("SELECT * FROM ppob_orders WHERE ref_id = ?").bind(c.req.param("refId")).first();
  if (!order) return c.json({ ok: false, error: "Order tidak ditemukan" }, 404);
  return c.json({ ok: true, order });
});

// Konfirmasi harga jual final setelah order sukses — fungsi SAMA dengan yang
// dipakai dashboard web & menu bot ("Konfirmasi Order PPOB"), supaya order
// yang dikonfirmasi lewat mini app langsung sinkron ke laporan web juga.
miniapp.post("/ppob-orders/:refId/konfirmasi", async (c) => {
  const refId = c.req.param("refId");
  const { sellPrice, costTotal, tokenCode, paidMethod, contactId, receiveWalletId } = await c.req.json();
  try {
    const result = await finalizePpobOrder(c.env, { refId, sellPrice, costTotal, tokenCode, paidMethod, contactId, receiveWalletId, employeeId: c.get("employee").employeeId });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 400);
  }
});

// ---------------------------------------------------------------------------
// DEPOSIT SALDO PORTALPULSA — kirim perintah "D BANK NOMINAL PIN" langsung ke
// provider (PIN otomatis dari secret PORTALPULSA_PIN, tidak diketik manual).
// Balasannya instruksi transfer manual (nominal+kode unik, bank, no rekening)
// — BUKAN topup otomatis. Jalur & tabel riwayat SAMA PERSIS dengan endpoint
// web /api/admin/portalpulsa/deposit (index.js) & command Telegram /deposit,
// supaya riwayatnya satu tempat terlepas dari mana dikirimnya. Dibatasi role
// admin (bukan kasir biasa) — konsisten dengan pembatasan di web & bot.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PENCATATAN SALDO: TIDAK LAGI langsung dicatat begitu balasan instruksi
// transfer diterima — lihat catatan panjang di ppob.js bagian "DEPOSIT
// PORTALPULSA". Alurnya 3 tahap (ack -> instruksi -> SUKSES/GAGAL susulan),
// jadi di sini cuma dicatat 'pending'; mutasi dompet baru terjadi lewat cron
// checkPendingPortalpulsaDeposits begitu balasan susulan itu ketangkep.
miniapp.post("/portalpulsa/deposit", async (c) => {
  const employee = c.get("employee");
  if (employee.role !== "admin") {
    return c.json({ ok: false, error: "Cuma admin yang boleh kirim deposit portalpulsa." }, 403);
  }
  const { bank, nominal, walletId } = await c.req.json();
  if (!bank || !nominal) {
    return c.json({ ok: false, error: "bank dan nominal wajib diisi" }, 400);
  }
  if (!walletId) {
    return c.json({ ok: false, error: "Pilih dulu dompet sumber uang transfer (mis. Kas/Bank)." }, 400);
  }
  const sourceWallet = await c.env.DB.prepare("SELECT * FROM wallets WHERE id = ?").bind(walletId).first();
  if (!sourceWallet) return c.json({ ok: false, error: "Dompet sumber tidak ditemukan" }, 404);
  if (sourceWallet.balance < nominal) {
    return c.json(
      { ok: false, error: `Saldo "${sourceWallet.name}" tidak cukup (saldo Rp${sourceWallet.balance.toLocaleString("id-ID")}, butuh Rp${Number(nominal).toLocaleString("id-ID")})` },
      400
    );
  }
  try {
    const result = await kirimDepositPortalpulsa(c.env, { bank, nominal, walletId, employeeId: employee.employeeId });
    return c.json({ ok: true, reply: result.replyText, nominalTransfer: result.nominalTransfer, status: "pending" });
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

miniapp.get("/portalpulsa/deposits", async (c) => {
  const employee = c.get("employee");
  // Sama seperti POST di atas — riwayat deposit menyangkut saldo & rekening,
  // dibatasi admin. Sebelumnya cek ini TIDAK ADA di sini (cuma tombolnya yg
  // disembunyikan di miniapp-page.js), jadi kasir non-admin yang tahu bentuk
  // endpoint-nya tetap bisa memanggilnya langsung dan melihat riwayat deposit.
  if (employee.role !== "admin") {
    return c.json({ ok: false, error: "Cuma admin yang boleh melihat riwayat deposit portalpulsa." }, 403);
  }
  const rows = await c.env.DB.prepare(
    `SELECT d.*, e.name AS employee_name, datetime(COALESCE(d.updated_at, d.created_at), '+7 hours') AS waktu_update
     FROM portalpulsa_deposits d
     LEFT JOIN employees e ON e.id = d.employee_id
     ORDER BY d.id DESC LIMIT 20`
  ).all();
  return c.json(rows.results.map(formatBarisDeposit));
});

// ---------------------------------------------------------------------------
// MUTASI ANTAR AKUN — pindah saldo antar dompet (mis. setor tunai Kas -> Bank).
// Logikanya SAMA PERSIS dengan POST /api/transactions type='mutation' di
// dashboard web (index.js): dompet asal berkurang, dompet tujuan bertambah,
// dicatat sebagai satu baris transactions supaya muncul juga di halaman
// Mutasi Akun & Laporan web. Terbuka untuk semua role (bukan cuma admin),
// sama seperti di web. Dompet dipilih dari GET /wallets yang sudah ada
// (tipe distributor_ppob sengaja tidak ikut, sama seperti hutang/titip).
// ---------------------------------------------------------------------------
miniapp.post("/mutasi", async (c) => {
  const employee = c.get("employee");
  const { walletId, toWalletId, amount, note } = await c.req.json();
  if (!walletId || !toWalletId) {
    return c.json({ ok: false, error: "Akun asal dan akun tujuan wajib dipilih" }, 400);
  }
  if (walletId === toWalletId) {
    return c.json({ ok: false, error: "Akun asal dan akun tujuan tidak boleh sama" }, 400);
  }
  const mutasiTotal = Number(amount) || 0;
  if (mutasiTotal <= 0) {
    return c.json({ ok: false, error: "Nominal mutasi harus lebih dari 0" }, 400);
  }
  const wallet = await c.env.DB.prepare("SELECT * FROM wallets WHERE id = ?").bind(walletId).first();
  if (!wallet) return c.json({ ok: false, error: "Akun asal tidak ditemukan" }, 404);
  if (wallet.balance < mutasiTotal) {
    return c.json(
      { ok: false, error: `Saldo "${wallet.name}" tidak cukup (saldo Rp${wallet.balance.toLocaleString("id-ID")}, butuh Rp${mutasiTotal.toLocaleString("id-ID")})` },
      400
    );
  }
  const toWallet = await c.env.DB.prepare("SELECT * FROM wallets WHERE id = ?").bind(toWalletId).first();
  if (!toWallet) return c.json({ ok: false, error: "Akun tujuan tidak ditemukan" }, 404);

  const noteFinal = note ? `${note} (via mini app oleh ${employee.name})` : `via mini app oleh ${employee.name}`;
  const shift = await c.env.DB.prepare("SELECT id FROM shifts WHERE employee_id = ? AND status = 'open'")
    .bind(employee.employeeId)
    .first();

  const insertResult = await c.env.DB.prepare(
    `INSERT INTO transactions (type, wallet_id, to_wallet_id, amount, cost_total, note, employee_id, shift_id)
     VALUES ('mutation', ?, ?, ?, 0, ?, ?, ?)`
  )
    .bind(walletId, toWalletId, mutasiTotal, noteFinal, employee.employeeId, shift ? shift.id : null)
    .run();
  await c.env.DB.prepare("UPDATE wallets SET balance = balance - ? WHERE id = ?").bind(mutasiTotal, walletId).run();
  await c.env.DB.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?").bind(mutasiTotal, toWalletId).run();

  return c.json({
    ok: true,
    transactionId: insertResult.meta.last_row_id,
    amount: mutasiTotal,
    fromWallet: wallet.name,
    toWallet: toWallet.name,
  });
});

// Riwayat mutasi terakhir (dipakai tab Mutasi mini app, sama data-nya dgn
// halaman web /mutasi tapi dibatasi 20 baris terakhir).
miniapp.get("/mutasi", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.date, t.amount, t.note, t.wallet_id, t.to_wallet_id,
            w1.name AS from_wallet_name, w2.name AS to_wallet_name, e.name AS employee_name
     FROM transactions t
     LEFT JOIN wallets w1 ON w1.id = t.wallet_id
     LEFT JOIN wallets w2 ON w2.id = t.to_wallet_id
     LEFT JOIN employees e ON e.id = t.employee_id
     WHERE t.type = 'mutation'
     ORDER BY t.id DESC LIMIT 20`
  ).all();
  return c.json(results);
});

export default miniapp;
