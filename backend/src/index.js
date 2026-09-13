import { Hono } from "hono";
import { cors } from "hono/cors";
import { sendJabberCommand } from "./jabber.js";
import { sendTelegramMessage } from "./telegram.js";
import { placePpobOrder, recordPpobSale, cekTagihan, detectPpobStatus, syncPpobPrices, getProviderConfig, finalizePpobOrder } from "./ppob.js";
import { hashPassword, verifyPassword, createToken, requireAuth, requireAdmin } from "./auth.js";
import { getEmployeeByChatId, handleLinkCommand, sendMainMenu, handleAdminCallback, handleAdminSessionMessage } from "./bot-admin.js";

const app = new Hono();

// Backend (Worker) dan frontend (Cloudflare Pages) sengaja jadi dua domain
// berbeda, jadi browser butuh izin CORS eksplisit sebelum mau memanggil /api/*.
// Login pakai Bearer token di header (bukan cookie), jadi origin "*" di sini aman
// tidak perlu credentials: true. Kalau mau lebih ketat, ganti "*" dengan URL
// frontend Pages Anda persis, mis. "https://kasir-ppob-frontend.pages.dev".
app.use(
  "/api/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Semua /api/* wajib login, KECUALI /api/auth/login sendiri.
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/auth/login" || c.req.path === "/api/setup") return next();
  return requireAuth(c, next);
});

// Setup admin pertama — hanya jalan kalau BELUM ada karyawan sama sekali di database.
// Setelah admin pertama dibuat, endpoint ini otomatis menolak (pakai /api/employees
// yang perlu login admin untuk menambah karyawan berikutnya).
app.post("/api/setup", async (c) => {
  const existing = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM employees").first();
  if (existing.n > 0) {
    return c.json({ ok: false, error: "Setup sudah pernah dilakukan" }, 403);
  }
  const { name, username, password } = await c.req.json();
  const password_hash = await hashPassword(password);
  await c.env.DB.prepare(
    "INSERT INTO employees (name, username, password_hash, role) VALUES (?, ?, ?, 'admin')"
  )
    .bind(name, username, password_hash)
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// AUTH — login karyawan/admin, dipakai dashboard web
// ---------------------------------------------------------------------------

app.post("/api/auth/login", async (c) => {
  const { username, password } = await c.req.json();
  const employee = await c.env.DB.prepare(
    "SELECT * FROM employees WHERE username = ? AND active = 1"
  )
    .bind(username)
    .first();
  if (!employee || !(await verifyPassword(password, employee.password_hash))) {
    return c.json({ ok: false, error: "Username atau password salah" }, 401);
  }
  const token = await createToken(c.env, { employeeId: employee.id, role: employee.role, name: employee.name });
  return c.json({ ok: true, token, employee: { id: employee.id, name: employee.name, role: employee.role } });
});

app.get("/api/auth/me", async (c) => c.json(c.get("employee")));

// ---------------------------------------------------------------------------
// PENGATURAN TOKO & KARYAWAN (khusus admin)
// ---------------------------------------------------------------------------

app.get("/api/store-settings", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM store_settings WHERE id = 1").first();
  return c.json(row);
});

app.put("/api/store-settings", requireAdmin, async (c) => {
  const { store_name, address, logo_url } = await c.req.json();
  await c.env.DB.prepare(
    "UPDATE store_settings SET store_name = ?, address = ?, logo_url = ? WHERE id = 1"
  )
    .bind(store_name, address || null, logo_url || null)
    .run();
  return c.json({ ok: true });
});

app.get("/api/employees", requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, username, role, active, telegram_id, created_at FROM employees ORDER BY id"
  ).all();
  return c.json(results);
});

app.post("/api/employees", requireAdmin, async (c) => {
  const { name, username, password, role = "kasir" } = await c.req.json();
  const password_hash = await hashPassword(password);
  await c.env.DB.prepare(
    "INSERT INTO employees (name, username, password_hash, role) VALUES (?, ?, ?, ?)"
  )
    .bind(name, username, password_hash, role)
    .run();
  return c.json({ ok: true });
});

app.put("/api/employees/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const { name, role, active, password } = await c.req.json();
  if (password) {
    const password_hash = await hashPassword(password);
    await c.env.DB.prepare(
      "UPDATE employees SET name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?"
    )
      .bind(name, role, active ? 1 : 0, password_hash, id)
      .run();
  } else {
    await c.env.DB.prepare("UPDATE employees SET name = ?, role = ?, active = ? WHERE id = ?")
      .bind(name, role, active ? 1 : 0, id)
      .run();
  }
  return c.json({ ok: true });
});

app.delete("/api/employees/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const employee = c.get("employee");
  if (String(employee.employeeId) === String(id)) {
    return c.json({ ok: false, error: "Tidak bisa menghapus akun Anda sendiri yang sedang login." }, 400);
  }
  const target = await c.env.DB.prepare("SELECT role FROM employees WHERE id = ?").bind(id).first();
  if (target && target.role === "admin") {
    const admins = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM employees WHERE role = 'admin' AND active = 1").first();
    if (admins.n <= 1) {
      return c.json({ ok: false, error: "Tidak bisa menghapus admin terakhir." }, 400);
    }
  }
  await c.env.DB.prepare("DELETE FROM employees WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// Bikin kode sekali-pakai (10 menit) supaya karyawan bisa "menghubungkan"
// akun Telegram-nya sendiri lewat bot admin/kasir: kirim "/hubung KODE" ke
// bot. Setelah terhubung, telegram_id tersimpan di employees dan dipakai
// bot-admin.js buat identifikasi siapa yang sedang chat.
function randomLinkCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digit
}

app.post("/api/employees/:id/telegram-link-code", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const employee = await c.env.DB.prepare("SELECT id FROM employees WHERE id = ?").bind(id).first();
  if (!employee) return c.json({ ok: false, error: "Karyawan tidak ditemukan" }, 404);
  const code = randomLinkCode();
  await c.env.DB.prepare(
    "UPDATE employees SET link_code = ?, link_code_expires = datetime('now', '+10 minutes') WHERE id = ?"
  )
    .bind(code, id)
    .run();
  return c.json({ ok: true, code, expiresInMinutes: 10 });
});

app.post("/api/employees/:id/telegram-unlink", requireAdmin, async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("UPDATE employees SET telegram_id = NULL, link_code = NULL, link_code_expires = NULL WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API KASIR (dipakai frontend Vue Anda, sama pola dengan Kasir Warung lama)
// ---------------------------------------------------------------------------

app.get("/api/wallets", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM wallets ORDER BY id").all();
  return c.json(results);
});

app.post("/api/wallets", async (c) => {
  const { name, type = "umum", balance = 0, provider = null } = await c.req.json();
  await c.env.DB.prepare("INSERT INTO wallets (name, type, balance, provider) VALUES (?, ?, ?, ?)")
    .bind(name, type, balance, type === "distributor_ppob" ? provider || "okeconnect" : null)
    .run();
  return c.json({ ok: true });
});

app.put("/api/wallets/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const { name, type, balance, provider } = await c.req.json();
  await c.env.DB.prepare("UPDATE wallets SET name = ?, type = ?, balance = ?, provider = ? WHERE id = ?")
    .bind(name, type, balance, type === "distributor_ppob" ? provider || "okeconnect" : null, id)
    .run();
  return c.json({ ok: true });
});

app.delete("/api/wallets/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const used = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM transactions WHERE wallet_id = ?").bind(id).first();
  if (used.n > 0) {
    return c.json({ ok: false, error: `Tidak bisa hapus — dompet ini masih dipakai di ${used.n} transaksi.` }, 400);
  }
  await c.env.DB.prepare("DELETE FROM wallets WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// Kompatibel mundur: tanpa parameter apa pun, tetap balas array polos semua
// produk (dipakai Kasir/Katalog/Ppob yang sudah ada). Kalau type=ppob dikirim,
// balas objek berpaginasi { items, total, page, pageSize } — dipakai tab
// "Produk PPOB" yang baru, karena daftarnya bisa ribuan baris.
app.get("/api/products", async (c) => {
  const type = c.req.query("type"); // "fisik" | "ppob" (opsional)
  const q = (c.req.query("q") || "").trim();
  const activeOnly = c.req.query("active") === "1";

  const where = [];
  const params = [];
  if (type === "fisik") where.push("code IS NULL");
  if (type === "ppob") where.push("code IS NOT NULL");
  if (activeOnly) where.push("active = 1");
  if (q) {
    where.push("(name LIKE ? OR code LIKE ? OR barcode LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  if (type === "ppob") {
    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "50", 10) || 50));
    const offset = (page - 1) * pageSize;

    const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM products ${whereSql}`)
      .bind(...params)
      .first();
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM products ${whereSql} ORDER BY active DESC, sell_price ASC LIMIT ? OFFSET ?`
    )
      .bind(...params, pageSize, offset)
      .all();
    return c.json({ items: results, total: totalRow.n, page, pageSize });
  }

  const { results } = await c.env.DB.prepare(`SELECT * FROM products ${whereSql} ORDER BY id`)
    .bind(...params)
    .all();
  return c.json(results);
});

app.get("/api/products/barcode/:code", async (c) => {
  const product = await c.env.DB.prepare("SELECT * FROM products WHERE barcode = ?")
    .bind(c.req.param("code"))
    .first();
  return product ? c.json(product) : c.json({ error: "Produk tidak ditemukan" }, 404);
});

app.post("/api/products", async (c) => {
  const { code, barcode, name, category, cost_price = 0, sell_price = 0, stock = 0, provider = "okeconnect" } = await c.req.json();
  await c.env.DB.prepare(
    `INSERT INTO products (code, barcode, name, category, cost_price, sell_price, stock, provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(code || null, barcode || null, name, category || null, cost_price, sell_price, stock, provider || "okeconnect")
    .run();
  return c.json({ ok: true });
});

app.put("/api/products/:id", async (c) => {
  const id = c.req.param("id");
  const { name, category, cost_price, sell_price, stock, barcode, provider } = await c.req.json();
  await c.env.DB.prepare(
    `UPDATE products SET name = ?, category = ?, cost_price = ?, sell_price = ?, stock = ?, barcode = ?, provider = COALESCE(?, provider)
     WHERE id = ?`
  )
    .bind(name, category || null, cost_price, sell_price, stock, barcode || null, provider || null, id)
    .run();
  return c.json({ ok: true });
});

app.delete("/api/products/:id", async (c) => {
  const id = c.req.param("id");
  const used = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM transaction_items WHERE product_id = ?").bind(id).first();
  if (used.n > 0) {
    return c.json({ ok: false, error: `Tidak bisa hapus — produk ini sudah tercatat di ${used.n} transaksi. Nonaktifkan saja lewat tombol "Nonaktifkan" kalau sudah tidak dijual.` }, 400);
  }
  await c.env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// Nonaktifkan/aktifkan manual produk PPOB (di luar sinkron otomatis) — mis.
// kalau ingin sembunyikan satu produk tanpa menunggu hilang dari OkeConnect.
app.put("/api/products/:id/active", async (c) => {
  const id = c.req.param("id");
  const { active } = await c.req.json();
  await c.env.DB.prepare(
    "UPDATE products SET active = ?, deactivated_at = ? WHERE id = ?"
  )
    .bind(active ? 1 : 0, active ? null : new Date().toISOString(), id)
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// KONTAK (pelanggan & supplier)
// ---------------------------------------------------------------------------

app.get("/api/contacts", async (c) => {
  const type = c.req.query("type"); // opsional: pelanggan | supplier
  const { results } = type
    ? await c.env.DB.prepare("SELECT * FROM contacts WHERE type = ? ORDER BY name").bind(type).all()
    : await c.env.DB.prepare("SELECT * FROM contacts ORDER BY name").all();
  return c.json(results);
});

app.post("/api/contacts", async (c) => {
  const { name, phone, type = "pelanggan" } = await c.req.json();
  await c.env.DB.prepare("INSERT INTO contacts (name, phone, type) VALUES (?, ?, ?)")
    .bind(name, phone || null, type)
    .run();
  return c.json({ ok: true });
});

app.put("/api/contacts/:id", async (c) => {
  const id = c.req.param("id");
  const { name, phone, type } = await c.req.json();
  await c.env.DB.prepare("UPDATE contacts SET name = ?, phone = ?, type = ? WHERE id = ?")
    .bind(name, phone || null, type, id)
    .run();
  return c.json({ ok: true });
});

app.delete("/api/contacts/:id", async (c) => {
  const id = c.req.param("id");
  const contact = await c.env.DB.prepare("SELECT total_debt FROM contacts WHERE id = ?").bind(id).first();
  if (contact && contact.total_debt) {
    return c.json({ ok: false, error: "Tidak bisa hapus — kontak ini masih punya sisa hutang/piutang. Selesaikan dulu di menu Hutang Piutang." }, 400);
  }
  await c.env.DB.prepare("DELETE FROM contacts WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ID pelanggan fleksibel per kontak (No. BPJS, ID PLN, No. PDAM, dst) — tidak
// dibatasi jenis tertentu, dipakai supaya kasir tinggal pilih dari daftar
// tersimpan alih-alih ketik ulang tiap kali pelanggan yang sama bayar lagi.
app.get("/api/contacts/:id/ids", async (c) => {
  const contactId = c.req.param("id");
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM contact_ids WHERE contact_id = ? ORDER BY category, id"
  )
    .bind(contactId)
    .all();
  return c.json(results);
});

app.post("/api/contacts/:id/ids", async (c) => {
  const contactId = c.req.param("id");
  const { category, id_number, note } = await c.req.json();
  if (!category || !id_number) {
    return c.json({ ok: false, error: "category dan id_number wajib diisi" }, 400);
  }
  await c.env.DB.prepare(
    "INSERT INTO contact_ids (contact_id, category, id_number, note) VALUES (?, ?, ?, ?)"
  )
    .bind(contactId, category, id_number, note || null)
    .run();
  return c.json({ ok: true });
});

app.put("/api/contact-ids/:id", async (c) => {
  const id = c.req.param("id");
  const { category, id_number, note } = await c.req.json();
  await c.env.DB.prepare("UPDATE contact_ids SET category = ?, id_number = ?, note = ? WHERE id = ?")
    .bind(category, id_number, note || null, id)
    .run();
  return c.json({ ok: true });
});

app.delete("/api/contact-ids/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM contact_ids WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// Cari ID pelanggan tersimpan lintas kontak, dipakai di halaman PPOB/Tagihan
// supaya kasir bisa cari langsung dari nomor ID-nya (bukan cuma dari nama
// kontak) — mis. ketik no. meteran PLN, langsung ketemu siapa pemiliknya.
app.get("/api/contact-ids", async (c) => {
  const q = (c.req.query("q") || "").trim();
  const category = c.req.query("category");
  const where = [];
  const params = [];
  if (q) {
    where.push("(ci.id_number LIKE ? OR c.name LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (category) {
    where.push("ci.category = ?");
    params.push(category);
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const { results } = await c.env.DB.prepare(
    `SELECT ci.*, c.name AS contact_name, c.phone AS contact_phone
     FROM contact_ids ci JOIN contacts c ON c.id = ci.contact_id
     ${whereSql} ORDER BY ci.category, c.name LIMIT 50`
  )
    .bind(...params)
    .all();
  return c.json(results);
});

// Sinkronkan daftar harga PPOB dari OkeConnect ke tabel products.
// URL-nya simpan sebagai secret PRICE_LIST_URL, contoh:
//   https://okeconnect.com/harga/json?id=xxxxxxxxxxxxxxxx
// CATATAN: nama field di JSON OkeConnect belum saya pastikan persis (kode/code,
// nama/name, harga/price bisa beda-beda) — endpoint ini mencoba beberapa nama
// field umum. Kalau setelah sync tabel products kosong/aneh, cek dulu:
//   curl "<PRICE_LIST_URL>" | head
// lalu sesuaikan pemetaan field di bawah.
app.post("/api/products/sync", async (c) => {
  const result = await syncPpobPrices(c.env);
  return c.json(result, result.ok ? 200 : (result.error?.includes("PRICE_LIST_URL") ? 400 : 502));
});

// Kata kunci yang diblokir dari sinkronisasi PPOB OkeConnect — lihat
// syncPpobPrices di ppob.js untuk cara pencocokannya (case-insensitive,
// substring, ke kode+nama+kategori produk sumber).
app.get("/api/ppob-blocked-keywords", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM ppob_blocked_keywords ORDER BY keyword").all();
  return c.json(results);
});

app.post("/api/ppob-blocked-keywords", async (c) => {
  const { keyword } = await c.req.json();
  const trimmed = (keyword || "").trim();
  if (!trimmed) return c.json({ ok: false, error: "Kata kunci tidak boleh kosong" }, 400);
  try {
    await c.env.DB.prepare("INSERT INTO ppob_blocked_keywords (keyword) VALUES (?)").bind(trimmed).run();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: err.message.includes("UNIQUE") ? "Kata kunci ini sudah ada" : err.message }, 400);
  }
});

app.delete("/api/ppob-blocked-keywords/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM ppob_blocked_keywords WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

app.get("/api/transactions", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM transactions ORDER BY date DESC LIMIT 200"
  ).all();
  return c.json(results);
});

app.get("/api/transactions/:id", async (c) => {
  const id = c.req.param("id");
  const transaction = await c.env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(id).first();
  const { results: items } = await c.env.DB.prepare(
    `SELECT ti.*, p.name AS product_name FROM transaction_items ti
     LEFT JOIN products p ON p.id = ti.product_id WHERE ti.transaction_id = ?`
  )
    .bind(id)
    .all();
  return c.json({ ...transaction, items });
});

// Catat transaksi baru. Untuk penjualan barang fisik (misal hasil scan barcode),
// sertakan "items": [{ product_id, qty }] — sistem hitung total & modal otomatis,
// lalu kurangi stok. Untuk expense, "items" boleh dikosongkan. Untuk mutation
// (pindah saldo antar akun, mis. setor tunai Kas -> Bank), isi "wallet_id"
// (akun asal) DAN "to_wallet_id" (akun tujuan), "items" tidak dipakai.
app.post("/api/transactions", async (c) => {
  const employee = c.get("employee");
  const {
    type, // sale | purchase | expense | mutation
    category,
    wallet_id,
    to_wallet_id, // khusus type='mutation': akun tujuan
    note,
    contact_id,
    items = [], // [{ product_id, qty }]
    amount, // dipakai kalau tidak ada items (mis. expense manual / mutasi)
    paid_method = "tunai", // "tunai" (isi wallet_id) | "utang" (wajib contact_id, wallet_id diabaikan)
  } = await c.req.json();

  if (paid_method === "utang" && !contact_id) {
    return c.json({ ok: false, error: "Pembayaran Utang wajib pilih kontak" }, 400);
  }

  // Mutasi antar akun: tidak ada items/stok/laba, cuma pindah saldo dari satu
  // akun ke akun lain (mis. setor tunai dari Kas ke Bank).
  if (type === "mutation") {
    if (!wallet_id || !to_wallet_id) {
      return c.json({ ok: false, error: "Mutasi wajib memilih akun asal dan akun tujuan" }, 400);
    }
    if (wallet_id === to_wallet_id) {
      return c.json({ ok: false, error: "Akun asal dan akun tujuan tidak boleh sama" }, 400);
    }
    const mutasiTotal = amount || 0;
    if (mutasiTotal <= 0) {
      return c.json({ ok: false, error: "Nominal mutasi harus lebih dari 0" }, 400);
    }

    const shift = employee
      ? await c.env.DB.prepare("SELECT id FROM shifts WHERE employee_id = ? AND status = 'open'")
          .bind(employee.employeeId)
          .first()
      : null;

    const insertResult = await c.env.DB.prepare(
      `INSERT INTO transactions (type, category, wallet_id, to_wallet_id, amount, cost_total, note, contact_id, employee_id, shift_id)
       VALUES ('mutation', ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    )
      .bind(
        category || null,
        wallet_id,
        to_wallet_id,
        mutasiTotal,
        note || null,
        contact_id || null,
        employee ? employee.employeeId : null,
        shift ? shift.id : null
      )
      .run();
    const transactionId = insertResult.meta.last_row_id;

    await c.env.DB.prepare("UPDATE wallets SET balance = balance - ? WHERE id = ?").bind(mutasiTotal, wallet_id).run();
    await c.env.DB.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?").bind(mutasiTotal, to_wallet_id).run();

    return c.json({ ok: true, transactionId, total: mutasiTotal, costTotal: 0 });
  }

  let total = 0;
  let costTotal = 0;
  const resolvedItems = [];

  for (const it of items) {
    const product = await c.env.DB.prepare("SELECT * FROM products WHERE id = ?")
      .bind(it.product_id)
      .first();
    if (!product) continue;
    const qty = it.qty || 1;
    total += product.sell_price * qty;
    costTotal += product.cost_price * qty;
    resolvedItems.push({ product, qty });
  }

  if (!items.length) total = amount || 0;

  // Bayar Utang: uang belum masuk kas sama sekali, jadi wallet_id dikosongkan
  // (stok tetap berkurang & laporan laba tetap kehitung seperti biasa).
  const effectiveWalletId = paid_method === "utang" ? null : wallet_id;

  // Tempelkan shift_id kasir yang sedang login (kalau ada shift yang masih
  // terbuka), supaya transaksi ini ikut kehitung di Laporan Shift-nya nanti.
  const openShift = employee
    ? await c.env.DB.prepare("SELECT id FROM shifts WHERE employee_id = ? AND status = 'open'")
        .bind(employee.employeeId)
        .first()
    : null;

  const insertResult = await c.env.DB.prepare(
    `INSERT INTO transactions (type, category, wallet_id, amount, cost_total, note, contact_id, employee_id, shift_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      type,
      category || null,
      effectiveWalletId || null,
      total,
      costTotal,
      note || null,
      contact_id || null,
      employee ? employee.employeeId : null,
      openShift ? openShift.id : null
    )
    .run();
  const transactionId = insertResult.meta.last_row_id;

  for (const { product, qty } of resolvedItems) {
    await c.env.DB.prepare(
      `INSERT INTO transaction_items (transaction_id, product_id, qty, cost_price, sell_price)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(transactionId, product.id, qty, product.cost_price, product.sell_price)
      .run();

    if (type === "sale") {
      await c.env.DB.prepare("UPDATE products SET stock = stock - ? WHERE id = ?")
        .bind(qty, product.id)
        .run();
    } else if (type === "purchase") {
      await c.env.DB.prepare("UPDATE products SET stock = stock + ? WHERE id = ?")
        .bind(qty, product.id)
        .run();
    }
  }

  if (effectiveWalletId) {
    const delta = type === "sale" ? total : -total; // penjualan nambah kas, pembelian/expense ngurangin
    await c.env.DB.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?")
      .bind(delta, effectiveWalletId)
      .run();
  }

  // Bayar Utang (cuma berlaku utk penjualan): otomatis catat sbg piutang,
  // tanpa perlu kasir isi manual dobel di menu Hutang Piutang.
  if (paid_method === "utang" && type === "sale" && contact_id) {
    await c.env.DB.prepare(
      `INSERT INTO debts (contact_id, type, amount, note) VALUES (?, 'piutang', ?, ?)`
    )
      .bind(contact_id, total, note || `Transaksi kasir #${transactionId}`)
      .run();
    await c.env.DB.prepare("UPDATE contacts SET total_debt = total_debt + ? WHERE id = ?")
      .bind(total, contact_id)
      .run();
  }

  return c.json({ ok: true, transactionId, total, costTotal });
});

// Edit transaksi (cuma field ringan: kategori, catatan, kontak — TIDAK mengubah
// nominal/jenis/dompet, karena itu butuh hitung ulang stok+saldo yang rawan
// salah kalau dilakukan lewat form edit sederhana. Untuk salah nominal/dompet,
// hapus transaksinya lalu catat ulang yang benar.)
app.put("/api/transactions/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(id).first();
  if (!existing) return c.json({ ok: false, error: "Transaksi tidak ditemukan" }, 404);
  const { category, note, contact_id } = await c.req.json();
  await c.env.DB.prepare("UPDATE transactions SET category = ?, note = ?, contact_id = ? WHERE id = ?")
    .bind(category || null, note || null, contact_id || null, id)
    .run();
  return c.json({ ok: true });
});

// Hapus transaksi — otomatis balikkan efek saldo dompet & stok produk yang
// sempat berubah karena transaksi ini, supaya laporan tetap akurat.
app.delete("/api/transactions/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const t = await c.env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(id).first();
  if (!t) return c.json({ ok: false, error: "Transaksi tidak ditemukan" }, 404);

  if (t.type === "mutation") {
    // Balikkan mutasi: kembalikan saldo akun asal, tarik lagi dari akun tujuan.
    if (t.wallet_id) {
      await c.env.DB.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?").bind(t.amount, t.wallet_id).run();
    }
    if (t.to_wallet_id) {
      await c.env.DB.prepare("UPDATE wallets SET balance = balance - ? WHERE id = ?").bind(t.amount, t.to_wallet_id).run();
    }
  } else if (t.wallet_id) {
    const delta = t.type === "sale" ? t.amount : -t.amount; // balikkan: kebalikan dari efek saat dibuat
    await c.env.DB.prepare("UPDATE wallets SET balance = balance - ? WHERE id = ?")
      .bind(delta, t.wallet_id)
      .run();
  }

  const { results: items } = await c.env.DB.prepare(
    "SELECT * FROM transaction_items WHERE transaction_id = ?"
  )
    .bind(id)
    .all();
  for (const it of items) {
    if (t.type === "sale") {
      await c.env.DB.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").bind(it.qty, it.product_id).run();
    } else if (t.type === "purchase") {
      await c.env.DB.prepare("UPDATE products SET stock = stock - ? WHERE id = ?").bind(it.qty, it.product_id).run();
    }
  }
  await c.env.DB.prepare("DELETE FROM transaction_items WHERE transaction_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM transactions WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// HUTANG PIUTANG (pelanggan & supplier)
// ---------------------------------------------------------------------------

app.get("/api/debts", async (c) => {
  const contactId = c.req.query("contact_id");
  const { results } = contactId
    ? await c.env.DB.prepare("SELECT * FROM debts WHERE contact_id = ? ORDER BY date DESC")
        .bind(contactId)
        .all()
    : await c.env.DB.prepare(
        `SELECT d.*, c.name AS contact_name FROM debts d
         JOIN contacts c ON c.id = d.contact_id ORDER BY d.date DESC LIMIT 200`
      ).all();
  return c.json(results);
});

// type: "utang" (kita berhutang ke supplier) | "piutang" (pelanggan hutang ke kita) | "cicilan" (pembayaran, mengurangi)
app.post("/api/debts", async (c) => {
  const { contact_id, type, amount, note } = await c.req.json();
  await c.env.DB.prepare("INSERT INTO debts (contact_id, type, amount, note) VALUES (?, ?, ?, ?)")
    .bind(contact_id, type, amount, note || null)
    .run();

  const delta = type === "cicilan" ? -amount : amount;
  await c.env.DB.prepare("UPDATE contacts SET total_debt = total_debt + ? WHERE id = ?")
    .bind(delta, contact_id)
    .run();

  return c.json({ ok: true });
});

// Edit catatan hutang/piutang — otomatis balikkan efek lama ke total_debt
// kontak, lalu terapkan efek baru (mis. salah ketik nominal/jenis).
app.put("/api/debts/:id", async (c) => {
  const id = c.req.param("id");
  const old = await c.env.DB.prepare("SELECT * FROM debts WHERE id = ?").bind(id).first();
  if (!old) return c.json({ ok: false, error: "Data tidak ditemukan" }, 404);
  const { type, amount, note } = await c.req.json();

  const oldDelta = old.type === "cicilan" ? -old.amount : old.amount;
  await c.env.DB.prepare("UPDATE contacts SET total_debt = total_debt - ? WHERE id = ?")
    .bind(oldDelta, old.contact_id)
    .run();
  const newDelta = type === "cicilan" ? -amount : amount;
  await c.env.DB.prepare("UPDATE contacts SET total_debt = total_debt + ? WHERE id = ?")
    .bind(newDelta, old.contact_id)
    .run();

  await c.env.DB.prepare("UPDATE debts SET type = ?, amount = ?, note = ? WHERE id = ?")
    .bind(type, amount, note || null, id)
    .run();
  return c.json({ ok: true });
});

// Hapus catatan hutang/piutang — otomatis balikkan efeknya ke total_debt kontak.
app.delete("/api/debts/:id", async (c) => {
  const id = c.req.param("id");
  const d = await c.env.DB.prepare("SELECT * FROM debts WHERE id = ?").bind(id).first();
  if (!d) return c.json({ ok: false, error: "Data tidak ditemukan" }, 404);
  const delta = d.type === "cicilan" ? -d.amount : d.amount;
  await c.env.DB.prepare("UPDATE contacts SET total_debt = total_debt - ? WHERE id = ?")
    .bind(delta, d.contact_id)
    .run();
  await c.env.DB.prepare("DELETE FROM debts WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// LAPORAN KEUANGAN
// ---------------------------------------------------------------------------

// Arus kas per akun/dompet dalam rentang tanggal. Mutasi antar akun dihitung
// dua sisi: "keluar" di akun asal, "masuk" di akun tujuan (bukan cuma
// sale/purchase/expense seperti sebelumnya).
app.get("/api/reports/cashflow", async (c) => {
  const start = c.req.query("start") || "1970-01-01";
  const end = c.req.query("end") || "2999-12-31";
  const { results } = await c.env.DB.prepare(
    `SELECT w.id AS wallet_id, w.name AS wallet_name,
            COALESCE(SUM(CASE
              WHEN t.wallet_id = w.id AND t.type = 'sale' THEN t.amount
              WHEN t.to_wallet_id = w.id AND t.type = 'mutation' THEN t.amount
              ELSE 0 END), 0) AS masuk,
            COALESCE(SUM(CASE
              WHEN t.wallet_id = w.id AND t.type IN ('purchase','expense','mutation') THEN t.amount
              ELSE 0 END), 0) AS keluar
     FROM wallets w
     LEFT JOIN transactions t
       ON (t.wallet_id = w.id OR t.to_wallet_id = w.id) AND date(t.date) BETWEEN date(?) AND date(?)
     GROUP BY w.id
     HAVING masuk > 0 OR keluar > 0`
  )
    .bind(start, end)
    .all();
  return c.json(results);
});

// Laba kotor (penjualan - modal) & laba bersih (laba kotor - biaya operasional/expense)
app.get("/api/reports/profit", async (c) => {
  const start = c.req.query("start") || "1970-01-01";
  const end = c.req.query("end") || "2999-12-31";

  const sales = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(amount),0) AS omzet, COALESCE(SUM(cost_total),0) AS modal
     FROM transactions WHERE type = 'sale' AND date(date) BETWEEN date(?) AND date(?)`
  )
    .bind(start, end)
    .first();

  const expenses = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
     WHERE type = 'expense' AND date(date) BETWEEN date(?) AND date(?)`
  )
    .bind(start, end)
    .first();

  const grossProfit = sales.omzet - sales.modal;
  const netProfit = grossProfit - expenses.total;

  return c.json({
    omzet: sales.omzet,
    modal: sales.modal,
    laba_kotor: grossProfit,
    biaya_operasional: expenses.total,
    laba_bersih: netProfit,
  });
});

// ---------------------------------------------------------------------------
// SHIFT KASIR (Buka/Tutup Shift, Rekap/Laporan Shift, Kas Opname)
// ---------------------------------------------------------------------------
// Satu shift = satu periode kerja kasir pada satu akun kas fisik tertentu.
// Saldo awal diisi manual (hasil hitung fisik laci kas saat buka), lalu semua
// transaksi yang tercatat selama shift berjalan (penjualan, pembelian,
// biaya, mutasi masuk/keluar) ditandai dengan shift_id yang sama. Saat tutup
// shift, sistem hitung "saldo seharusnya" dari saldo awal + pergerakan itu,
// lalu dibandingkan dengan saldo fisik hasil hitung ulang kasir (selisih =
// lebih/kurang, biasa disebut "kas opname").

async function computeShiftBreakdown(db, shift) {
  const row = await db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN type = 'sale' AND wallet_id = ? THEN amount ELSE 0 END), 0) AS total_penjualan,
        COALESCE(SUM(CASE WHEN type = 'purchase' AND wallet_id = ? THEN amount ELSE 0 END), 0) AS total_pembelian,
        COALESCE(SUM(CASE WHEN type = 'expense' AND wallet_id = ? THEN amount ELSE 0 END), 0) AS total_pengeluaran,
        COALESCE(SUM(CASE WHEN type = 'mutation' AND wallet_id = ? THEN amount ELSE 0 END), 0) AS mutasi_keluar,
        COALESCE(SUM(CASE WHEN type = 'mutation' AND to_wallet_id = ? THEN amount ELSE 0 END), 0) AS mutasi_masuk,
        COUNT(*) AS jumlah_transaksi
       FROM transactions WHERE shift_id = ?`
    )
    .bind(shift.wallet_id, shift.wallet_id, shift.wallet_id, shift.wallet_id, shift.wallet_id, shift.id)
    .first();
  const net_movement =
    row.total_penjualan - row.total_pembelian - row.total_pengeluaran - row.mutasi_keluar + row.mutasi_masuk;
  return { ...row, net_movement };
}

// Riwayat shift. Kasir biasa cuma lihat shift miliknya sendiri; admin lihat semua.
app.get("/api/shifts", async (c) => {
  const employee = c.get("employee");
  const status = c.req.query("status");
  let query = `SELECT s.*, e.name AS employee_name, w.name AS wallet_name FROM shifts s
    JOIN employees e ON e.id = s.employee_id JOIN wallets w ON w.id = s.wallet_id WHERE 1=1`;
  const binds = [];
  if (employee.role !== "admin") {
    query += " AND s.employee_id = ?";
    binds.push(employee.employeeId);
  }
  if (status) {
    query += " AND s.status = ?";
    binds.push(status);
  }
  query += " ORDER BY s.opened_at DESC LIMIT 100";
  const { results } = await c.env.DB.prepare(query)
    .bind(...binds)
    .all();
  return c.json(results);
});

// Shift yang sedang berjalan milik kasir yang login (kalau ada), lengkap
// dengan rekap sementara — dipakai halaman Shift buat preview sebelum tutup.
app.get("/api/shifts/current", async (c) => {
  const employee = c.get("employee");
  const shift = await c.env.DB.prepare(
    `SELECT s.*, w.name AS wallet_name FROM shifts s JOIN wallets w ON w.id = s.wallet_id
     WHERE s.employee_id = ? AND s.status = 'open'`
  )
    .bind(employee.employeeId)
    .first();
  if (!shift) return c.json(null);
  const breakdown = await computeShiftBreakdown(c.env.DB, shift);
  return c.json({ ...shift, ...breakdown, expected_balance: shift.opening_balance + breakdown.net_movement });
});

// Detail satu shift (dipakai buat lihat/cetak Laporan Shift yang sudah ditutup).
app.get("/api/shifts/:id", async (c) => {
  const employee = c.get("employee");
  const id = c.req.param("id");
  const shift = await c.env.DB.prepare(
    `SELECT s.*, e.name AS employee_name, w.name AS wallet_name FROM shifts s
     JOIN employees e ON e.id = s.employee_id JOIN wallets w ON w.id = s.wallet_id WHERE s.id = ?`
  )
    .bind(id)
    .first();
  if (!shift) return c.json({ ok: false, error: "Shift tidak ditemukan" }, 404);
  if (employee.role !== "admin" && shift.employee_id !== employee.employeeId) {
    return c.json({ ok: false, error: "Bukan shift Anda" }, 403);
  }
  const breakdown = await computeShiftBreakdown(c.env.DB, shift);
  const { results: transactionsList } = await c.env.DB.prepare(
    "SELECT * FROM transactions WHERE shift_id = ? ORDER BY date"
  )
    .bind(id)
    .all();
  return c.json({ ...shift, ...breakdown, transactions: transactionsList });
});

// Buka shift baru. Satu kasir hanya boleh punya 1 shift terbuka pada satu waktu.
app.post("/api/shifts/open", async (c) => {
  const employee = c.get("employee");
  const existing = await c.env.DB.prepare(
    "SELECT id FROM shifts WHERE employee_id = ? AND status = 'open'"
  )
    .bind(employee.employeeId)
    .first();
  if (existing) {
    return c.json({ ok: false, error: "Anda masih punya shift yang belum ditutup. Tutup dulu sebelum buka baru." }, 400);
  }
  const { wallet_id, opening_balance, opening_note } = await c.req.json();
  if (!wallet_id) return c.json({ ok: false, error: "Pilih akun kas yang mau di-opname dulu" }, 400);

  const result = await c.env.DB.prepare(
    `INSERT INTO shifts (employee_id, wallet_id, opening_balance, opening_note) VALUES (?, ?, ?, ?)`
  )
    .bind(employee.employeeId, wallet_id, opening_balance || 0, opening_note || null)
    .run();
  return c.json({ ok: true, shiftId: result.meta.last_row_id });
});

// Tutup shift: input saldo fisik hasil hitung ulang (closing_balance), sistem
// bandingkan dengan saldo seharusnya (opening_balance + pergerakan transaksi
// selama shift) buat dapat selisih (lebih/kurang kas).
app.post("/api/shifts/:id/close", async (c) => {
  const employee = c.get("employee");
  const id = c.req.param("id");
  const shift = await c.env.DB.prepare("SELECT * FROM shifts WHERE id = ?").bind(id).first();
  if (!shift) return c.json({ ok: false, error: "Shift tidak ditemukan" }, 404);
  if (shift.status !== "open") return c.json({ ok: false, error: "Shift ini sudah ditutup" }, 400);
  if (employee.role !== "admin" && shift.employee_id !== employee.employeeId) {
    return c.json({ ok: false, error: "Bukan shift Anda" }, 403);
  }

  const { closing_balance, closing_note } = await c.req.json();
  if (closing_balance === undefined || closing_balance === null) {
    return c.json({ ok: false, error: "Isi hasil hitung kas fisik dulu" }, 400);
  }

  const breakdown = await computeShiftBreakdown(c.env.DB, shift);
  const expected = shift.opening_balance + breakdown.net_movement;
  const difference = closing_balance - expected;

  await c.env.DB.prepare(
    `UPDATE shifts SET status = 'closed', closing_balance = ?, expected_balance = ?, difference = ?,
       closing_note = ?, closed_at = datetime('now') WHERE id = ?`
  )
    .bind(closing_balance, expected, difference, closing_note || null, id)
    .run();

  return c.json({ ok: true, expected_balance: expected, difference, ...breakdown });
});

app.get("/api/ppob-orders", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM ppob_orders ORDER BY created_at DESC LIMIT 200"
  ).all();
  return c.json(results);
});

// Koreksi manual satu order PPOB (mis. status ternyata salah tercatat, seperti
// kasus balasan transaksi lain yang nyasar). Kalau status DIUBAH KELUAR dari
// "sukses", otomatis balikkan transaksi/pemasukan & saldo dompet yang sempat
// tercatat untuk order ini — supaya tidak perlu jalankan SQL manual lagi.
app.put("/api/ppob-orders/:refId", requireAdmin, async (c) => {
  const refId = c.req.param("refId");
  const order = await c.env.DB.prepare("SELECT * FROM ppob_orders WHERE ref_id = ?").bind(refId).first();
  if (!order) return c.json({ ok: false, error: "Order tidak ditemukan" }, 404);
  const { status, raw_reply, target } = await c.req.json();

  if (order.status === "sukses" && status !== "sukses") {
    const { results: txs } = await c.env.DB.prepare("SELECT * FROM transactions WHERE note LIKE ?")
      .bind(`%${refId}%`)
      .all();
    for (const t of txs) {
      if (t.wallet_id) {
        await c.env.DB.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?")
          .bind(t.cost_total, t.wallet_id)
          .run();
      }
      await c.env.DB.prepare("DELETE FROM transactions WHERE id = ?").bind(t.id).run();
    }
  }

  await c.env.DB.prepare(
    "UPDATE ppob_orders SET status = ?, raw_reply = ?, target = ?, updated_at = datetime('now') WHERE ref_id = ?"
  )
    .bind(status || order.status, raw_reply ?? order.raw_reply, target || order.target, refId)
    .run();

  return c.json({ ok: true });
});

// Tombol manual "Cek Ulang Status" di menu detail transaksi — kirim CEK.R#
// ke OkeConnect kapan saja, tidak terikat jadwal cron otomatis.
app.post("/api/ppob-orders/:refId/cek-ulang", async (c) => {
  const refId = c.req.param("refId");
  const order = await c.env.DB.prepare("SELECT * FROM ppob_orders WHERE ref_id = ?").bind(refId).first();
  if (!order) return c.json({ ok: false, error: "Order tidak ditemukan" }, 404);
  try {
    const { status, reply } = await recheckOrder(c.env, order, { autoRecord: false });
    return c.json({ ok: true, status, reply, needsConfirm: status === "sukses" });
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 502);
  }
});

// Hapus order PPOB — otomatis balikkan transaksi & saldo terkait kalau order
// ini sempat tercatat "sukses" (menghindari saldo/pemasukan palsu tertinggal).
app.delete("/api/ppob-orders/:refId", requireAdmin, async (c) => {
  const refId = c.req.param("refId");
  const order = await c.env.DB.prepare("SELECT * FROM ppob_orders WHERE ref_id = ?").bind(refId).first();
  if (!order) return c.json({ ok: false, error: "Order tidak ditemukan" }, 404);

  const { results: txs } = await c.env.DB.prepare("SELECT * FROM transactions WHERE note LIKE ?")
    .bind(`%${refId}%`)
    .all();
  for (const t of txs) {
    if (t.wallet_id) {
      await c.env.DB.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?")
        .bind(t.cost_total, t.wallet_id)
        .run();
    }
    await c.env.DB.prepare("DELETE FROM transactions WHERE id = ?").bind(t.id).run();
  }

  await c.env.DB.prepare("DELETE FROM ppob_orders WHERE ref_id = ?").bind(refId).run();
  return c.json({ ok: true });
});

// Order PPOB langsung dari halaman kasir web (pola sama dengan /beli di Telegram,
// tapi lewat sini biar bisa dipanggil dari UI kasir, misal setelah scan barcode/pilih produk).
app.post("/api/ppob/order", async (c) => {
  const { productCode, target, paidMethod, contactId, batchId } = await c.req.json();
  if (!productCode || !target) {
    return c.json({ ok: false, error: "productCode dan target wajib diisi" }, 400);
  }
  try {
    const result = await placePpobOrder(c.env, { productCode, target, paidMethod, contactId, batchId });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 400);
  }
});

// Cek tagihan/nama pelanggan (PDAM, listrik, BPJS) SEBELUM bayar — tidak
// memotong saldo, tidak dicatat sebagai order, cuma menampilkan balasan
// mentah dari OkeConnect (berisi nominal tagihan asli & nama pelanggan)
// supaya kasir bisa konfirmasi dulu ke pelanggan sebelum benar-benar bayar.
app.post("/api/ppob/cek", async (c) => {
  const { productCode, target } = await c.req.json();
  if (!productCode || !target) {
    return c.json({ ok: false, error: "productCode dan target wajib diisi" }, 400);
  }
  try {
    const result = await cekTagihan(c.env, { productCode, target });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 400);
  }
});

// Konfirmasi harga jual final SETELAH order PPOB sukses (berlaku utk semua
// kategori — pulsa/kuota/token prabayar MAUPUN tagihan/PDAM pascabayar,
// menggantikan endpoint /catat yang lama yang cuma utk pascabayar). Baru di
// sini transaksi benar-benar dicatat & saldo distributor dipotong — supaya
// kasir sempat mengoreksi harga jual (dan utk pascabayar, mengisi nominal
// tagihan asli) sebelum permanen tercatat ke laporan.
app.post("/api/ppob-orders/:refId/konfirmasi", async (c) => {
  const refId = c.req.param("refId");
  const { sellPrice, costTotal, tokenCode, paidMethod, contactId } = await c.req.json();
  try {
    const result = await finalizePpobOrder(c.env, { refId, sellPrice, costTotal, tokenCode, paidMethod, contactId });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 400);
  }
});

// ---------------------------------------------------------------------------
// WEBHOOK TELEGRAM — bot jualan PPOB (publik) + bot admin/kasir (khusus
// karyawan yang sudah terhubung, lihat bot-admin.js)
//
// Perintah publik (siapa saja boleh pakai):
//   /beli KODE NOMOR                 -> order pulsa/paket kode KODE ke nomor itu
//   /cek REF123                      -> cek status order
//   /saldo                           -> lihat saldo akun distributor
//   /cari kata-kunci                 -> cari kode produk
//
// Perintah admin/kasir (wajib terhubung dulu lewat halaman Karyawan di web):
//   /hubung KODE                     -> hubungkan chat ini ke akun karyawan
//   /menu atau /start                -> buka menu tombol (Hutang, Konfirmasi PPOB, dst)
//
// Format ke OkeConnect mengikuti: {KODE}.{NO_HP}.{PIN}.R#{ID}
// (lihat catatan CS OkeConnect Anda). Sesuaikan bila format berbeda per produk.
// ---------------------------------------------------------------------------

app.post("/telegram/webhook", async (c) => {
  // Validasi header rahasia supaya endpoint tidak bisa dipanggil sembarangan
  const secret = c.req.header("x-telegram-bot-api-secret-token");
  if (secret !== c.env.TELEGRAM_SECRET) return c.text("forbidden", 403);

  const update = await c.req.json();
  const env = c.env;

  // Tombol menu bot admin/kasir (Hutang Piutang, Konfirmasi Harga PPOB, dst)
  // — beda jalur dari pesan teks biasa di bawah.
  if (update.callback_query) {
    await handleAdminCallback(env, update.callback_query);
    return c.text("ok");
  }

  const message = update.message;
  if (!message || !message.text) return c.text("ok");

  const chatId = String(message.chat.id);
  const text = message.text.trim();

  // Hubungkan akun karyawan ke bot: "/hubung KODE" (kode dibuat di halaman
  // Karyawan pada web, tombol "Hubungkan Bot Telegram"). Dicek duluan,
  // terlepas chat ini sudah terhubung sebagai siapa sebelumnya.
  if (text.startsWith("/hubung")) {
    const reply = await handleLinkCommand(env, chatId, text);
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply);
    return c.text("ok");
  }

  const employee = await getEmployeeByChatId(env, chatId);

  // Menu khusus karyawan/admin yang sudah terhubung — Hutang Piutang &
  // konfirmasi harga jual PPOB lewat tombol, terpisah dari command lama.
  if (employee) {
    if (text === "/start" || text === "/menu") {
      await sendMainMenu(env, chatId, employee);
      return c.text("ok");
    }
    // Kalau sedang di tengah alur (mis. bot lagi nunggu nominal pembayaran
    // hutang atau harga jual baru), tangkap di sini duluan.
    const handled = await handleAdminSessionMessage(env, chatId, text);
    if (handled) return c.text("ok");
  }

  if (text.startsWith("/beli")) {
    const parts = text.split(/\s+/);
    const productCode = parts[1];
    const target = parts[2];
    if (!productCode || !target) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Format: /beli KODE NOMOR");
      return c.text("ok");
    }

    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Order diterima ✅, sedang diproses...");

    try {
      const { refId, status, reply } = await placePpobOrder(env, { productCode, target });
      const pesan =
        status === "pending"
          ? `Order ${refId} masih diproses server (belum ada balasan cepat). Saya kabari lagi begitu ada update.`
          : `Balasan server untuk ${refId} (${status}):\n${reply}`;
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, pesan);

      // Simpan chat_id supaya cron bisa notifikasi balik kalau statusnya masih "pending"
      if (status === "pending") {
        await env.DB.prepare("UPDATE ppob_orders SET telegram_chat_id = ? WHERE ref_id = ?")
          .bind(chatId, refId)
          .run();
      }
    } catch (err) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Gagal: ${err.message}`);
    }
    return c.text("ok");
  }

  if (text.startsWith("/cari")) {
    const keyword = text.replace(/^\/cari\s*/i, "").trim();
    if (!keyword) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Format: /cari kata-kunci\nContoh: /cari telkomsel 5000");
      return c.text("ok");
    }
    const { results } = await env.DB.prepare(
      "SELECT code, name, sell_price FROM products WHERE name LIKE ? OR code LIKE ? ORDER BY name LIMIT 10"
    )
      .bind(`%${keyword}%`, `%${keyword}%`)
      .all();

    if (!results.length) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Tidak ketemu. Coba kata kunci lain, atau pastikan daftar harga sudah di-sync (/api/products/sync).");
    } else {
      const lines = results.map((p) => `*${p.code}* — ${p.name} (Rp${p.sell_price.toLocaleString("id-ID")})`);
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, lines.join("\n"));
    }
    return c.text("ok");
  }

  if (text.startsWith("/cek")) {
    const refId = text.split(/\s+/)[1];
    const order = await env.DB.prepare("SELECT * FROM ppob_orders WHERE ref_id = ?")
      .bind(refId)
      .first();
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      order ? `Status ${refId}: ${order.status}\n${order.raw_reply || ""}` : "Ref ID tidak ditemukan."
    );
    return c.text("ok");
  }

  if (text.startsWith("/saldo")) {
    const wallets = await env.DB.prepare(
      "SELECT name, balance FROM wallets WHERE type = 'distributor_ppob'"
    ).all();
    const lines = wallets.results.map((w) => `${w.name}: Rp${w.balance.toLocaleString("id-ID")}`);
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      lines.length ? lines.join("\n") : "Belum ada akun saldo distributor."
    );
    return c.text("ok");
  }

  await sendTelegramMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    "Perintah: /beli KODE NOMOR, /cari kata-kunci, /cek REF_ID, /saldo"
  );
  return c.text("ok");
});

// ---------------------------------------------------------------------------
// CRON — cek ulang order yang masih "pending" lebih dari beberapa menit
// (menghindari kebutuhan koneksi Jabber yang nyala 24 jam terus-menerus)
// ---------------------------------------------------------------------------

// Cek ulang SATU order ke OkeConnect (via CEK.R#) dan update status/raw_reply.
// Dipakai baik oleh cron (otomatis, sekali saja per order) maupun endpoint
// manual (tombol "Cek Ulang Status"). autoRecord=true (jalur cron, kasir TIDAK
// di depan layar) akan langsung catat transaksi pakai harga default begitu
// ketahuan sukses. autoRecord=false (tombol manual, kasir SEDANG di depan
// layar) TIDAK auto-catat — biarkan kasir muncul kotak konfirmasi harga dulu
// (sama seperti order yang baru saja dibuat), baru dicatat lewat /konfirmasi.
async function recheckOrder(env, order, { autoRecord } = {}) {
  const cfg = getProviderConfig(env, order.provider);

  // Digiflazz pascabayar ("bayar.KODE.NOMOR.PIN") TIDAK punya trx id sama
  // sekali — tidak ada cara aman untuk "cek status ulang" tanpa berisiko
  // mengirim ulang command "bayar." itu sendiri dan berpotensi dobel-bayar.
  // Jadi order jenis ini SENGAJA TIDAK di-recheck otomatis di sini — kalau
  // balasannya sempat gagal/putus di tengah jalan, harus dicek manual lewat
  // CS Digiflazz atau riwayat "Bayar Tagihan" di member area mereka.
  if (cfg.provider === "digiflazz" && order.request_body && /^bayar\./i.test(order.request_body)) {
    throw new Error(
      "Order pascabayar Digiflazz tidak bisa dicek ulang otomatis (tidak ada trx id, beresiko dobel-bayar kalau dikirim ulang). Cek status pembayaran ini langsung ke CS/member area Digiflazz."
    );
  }

  // OkeConnect: command khusus "CEK.R#{ID}" (TODO: belum dikonfirmasi CS,
  // ada varian berakhiran 'A' untuk ID pelanggan — lihat catatan lama).
  // Digiflazz prabayar: TIDAK ada command "cek status" terpisah — caranya
  // kirim ULANG persis body transaksi asli dengan Trxid yang sama (disimpan
  // di order.request_body saat order dibuat).
  const body = cfg.provider === "digiflazz" && order.request_body ? order.request_body : `CEK.R#${order.ref_id}`;
  const reply = await sendJabberCommand({ jid: cfg.jid, password: cfg.password, to: cfg.target, body });
  const status = detectPpobStatus(reply);

  await env.DB.prepare(
    "UPDATE ppob_orders SET status = ?, raw_reply = ?, updated_at = datetime('now'), auto_checked = 1 WHERE id = ?"
  )
    .bind(status, reply, order.id)
    .run();

  if (status === "sukses" && autoRecord) {
    const product = await env.DB.prepare("SELECT * FROM products WHERE code = ?")
      .bind(order.product_code)
      .first();
    const wallet = order.wallet_id
      ? await env.DB.prepare("SELECT * FROM wallets WHERE id = ?").bind(order.wallet_id).first()
      : null;
    if (product) {
      await recordPpobSale(env, {
        product,
        wallet,
        refId: order.ref_id,
        target: order.target,
        paidMethod: order.paid_method,
        contactId: order.contact_id,
      });
      await env.DB.prepare("UPDATE ppob_orders SET finalized = 1 WHERE id = ?").bind(order.id).run();
    }
  }

  if (status !== "pending" && order.telegram_chat_id) {
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      order.telegram_chat_id,
      `Update ${order.ref_id}: ${status}\n${reply}`
    );
  }

  return { status, reply };
}

// Cron: cek ulang SEKALI SAJA tiap order, 5 menit setelah dibuat — bukan
// diulang tiap 5 menit selamanya. Kalau setelah cek sekali ini masih
// "pending" juga, itu ranah tombol manual "Cek Ulang Status" di menu detail
// transaksi (lihat endpoint /api/ppob-orders/:refId/cek-ulang), bukan cron lagi.
// Kasir dianggap TIDAK di depan layar di jalur ini, jadi auto-catat langsung
// pakai harga default kalau ternyata sukses (autoRecord: true).
async function checkPendingOrders(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM ppob_orders
     WHERE status = 'pending' AND auto_checked = 0 AND created_at <= datetime('now', '-5 minutes')
     LIMIT 20`
  ).all();

  for (const order of results) {
    try {
      await recheckOrder(env, order, { autoRecord: true });
    } catch (err) {
      // Tetap tandai auto_checked supaya tidak dicoba otomatis lagi tiap
      // 5 menit selamanya — kalau gagal, biarkan tombol manual yang urus.
      await env.DB.prepare("UPDATE ppob_orders SET auto_checked = 1 WHERE id = ?").bind(order.id).run();
    }
  }
}

// ---------------------------------------------------------------------------
// CRON — pembersihan riwayat rolling 1 tahun (jalan harian, jadwal terpisah
// dari cek order pending). MURNI hapus riwayat lama — TIDAK membalikkan
// saldo dompet/stok/hutang, karena efeknya sudah lama "menyatu" jadi saldo
// berjalan saat ini; membalikkannya justru akan merusak saldo yang sudah benar.
// ---------------------------------------------------------------------------

async function cleanupOldData(env) {
  const result = { transactions: 0, transaction_items: 0, debts: 0, ppob_orders: 0, products: 0 };

  // 1. Transaksi kas lebih tua dari 1 tahun (+ item-item di dalamnya)
  const oldTx = await env.DB.prepare(
    "SELECT id FROM transactions WHERE date < datetime('now', '-1 year')"
  ).all();
  if (oldTx.results.length) {
    const ids = oldTx.results.map((t) => t.id);
    const placeholders = ids.map(() => "?").join(",");
    const delItems = await env.DB.prepare(
      `DELETE FROM transaction_items WHERE transaction_id IN (${placeholders})`
    )
      .bind(...ids)
      .run();
    const delTx = await env.DB.prepare(
      `DELETE FROM transactions WHERE id IN (${placeholders})`
    )
      .bind(...ids)
      .run();
    result.transaction_items = delItems.meta?.changes ?? 0;
    result.transactions = delTx.meta?.changes ?? 0;
  }

  // 2. Hutang piutang lebih tua dari 1 tahun DAN kontaknya sudah lunas
  //    (total_debt = 0) — yang masih ada sisa hutang TIDAK disentuh berapa
  //    pun umurnya, karena riwayatnya masih relevan untuk penagihan.
  const delDebts = await env.DB.prepare(
    `DELETE FROM debts WHERE date < datetime('now', '-1 year')
       AND contact_id IN (SELECT id FROM contacts WHERE total_debt = 0)`
  ).run();
  result.debts = delDebts.meta?.changes ?? 0;

  // 3. Riwayat order PPOB lebih tua dari 1 tahun
  const delOrders = await env.DB.prepare(
    "DELETE FROM ppob_orders WHERE created_at < datetime('now', '-1 year')"
  ).run();
  result.ppob_orders = delOrders.meta?.changes ?? 0;

  // 4. Hard-delete produk PPOB yang sudah nonaktif (soft-deleted) lebih dari
  //    1 tahun — walau pernah laku terjual (nama di laporan lama boleh kosong).
  const delProducts = await env.DB.prepare(
    `DELETE FROM products WHERE active = 0 AND deactivated_at IS NOT NULL
       AND deactivated_at < datetime('now', '-1 year')`
  ).run();
  result.products = delProducts.meta?.changes ?? 0;

  return result;
}

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    if (event.cron === "0 3 * * *") {
      ctx.waitUntil(cleanupOldData(env));
    } else if (event.cron === "0 23 * * *") {
      ctx.waitUntil(syncPpobPrices(env));
    } else {
      ctx.waitUntil(checkPendingOrders(env));
    }
  },
};
