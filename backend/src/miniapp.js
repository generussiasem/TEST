import { Hono } from "hono";
import { verifyTelegramInitData } from "./telegram-miniapp-auth.js";
import { placePpobOrder, cekTagihan, finalizePpobOrder } from "./ppob.js";
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
miniapp.get("/wallets", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, type FROM wallets WHERE type != 'distributor_ppob' ORDER BY id"
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
  const where = ["active = 1", "code IS NOT NULL"];
  const params = [];
  if (q) {
    where.push("(name LIKE ? OR code LIKE ? OR product_group LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT code, name, category, product_group, sell_price FROM products WHERE ${where.join(" AND ")} ORDER BY product_group, sell_price ASC LIMIT 25`
  )
    .bind(...params)
    .all();
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
  const { productCode, target, paidMethod, contactId } = await c.req.json();
  if (!productCode || !target) return c.json({ ok: false, error: "productCode dan target wajib diisi" }, 400);
  const employee = c.get("employee");
  try {
    // telegramChatId = chat karyawan ini sendiri, supaya kalau balasan provider
    // telat (Mini App sudah berhenti polling), cron tetap bisa mengabari balik.
    const result = await placePpobOrder(c.env, { productCode, target, paidMethod, contactId, telegramChatId: employee.telegramId });
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

export default miniapp;
