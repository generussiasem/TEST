import { Hono } from "hono";
import { cors } from "hono/cors";
import { sendJabberCommand } from "./jabber.js";
import { sendTelegramMessage } from "./telegram.js";
import { placePpobOrder, recordPpobSale, cekTagihan, detectPpobStatus } from "./ppob.js";
import { hashPassword, verifyPassword, createToken, requireAuth, requireAdmin } from "./auth.js";

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
    "SELECT id, name, username, role, active, created_at FROM employees ORDER BY id"
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

// ---------------------------------------------------------------------------
// API KASIR (dipakai frontend Vue Anda, sama pola dengan Kasir Warung lama)
// ---------------------------------------------------------------------------

app.get("/api/wallets", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM wallets ORDER BY id").all();
  return c.json(results);
});

app.post("/api/wallets", async (c) => {
  const { name, type = "umum", balance = 0 } = await c.req.json();
  await c.env.DB.prepare("INSERT INTO wallets (name, type, balance) VALUES (?, ?, ?)")
    .bind(name, type, balance)
    .run();
  return c.json({ ok: true });
});

app.put("/api/wallets/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const { name, type, balance } = await c.req.json();
  await c.env.DB.prepare("UPDATE wallets SET name = ?, type = ?, balance = ? WHERE id = ?")
    .bind(name, type, balance, id)
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
      `SELECT * FROM products ${whereSql} ORDER BY active DESC, name ASC LIMIT ? OFFSET ?`
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
  const { code, barcode, name, category, cost_price = 0, sell_price = 0, stock = 0 } = await c.req.json();
  await c.env.DB.prepare(
    `INSERT INTO products (code, barcode, name, category, cost_price, sell_price, stock)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(code || null, barcode || null, name, category || null, cost_price, sell_price, stock)
    .run();
  return c.json({ ok: true });
});

app.put("/api/products/:id", async (c) => {
  const id = c.req.param("id");
  const { name, category, cost_price, sell_price, stock, barcode } = await c.req.json();
  await c.env.DB.prepare(
    `UPDATE products SET name = ?, category = ?, cost_price = ?, sell_price = ?, stock = ?, barcode = ?
     WHERE id = ?`
  )
    .bind(name, category || null, cost_price, sell_price, stock, barcode || null, id)
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

// Sinkronkan daftar harga PPOB dari OkeConnect ke tabel products.
// URL-nya simpan sebagai secret PRICE_LIST_URL, contoh:
//   https://okeconnect.com/harga/json?id=xxxxxxxxxxxxxxxx
// CATATAN: nama field di JSON OkeConnect belum saya pastikan persis (kode/code,
// nama/name, harga/price bisa beda-beda) — endpoint ini mencoba beberapa nama
// field umum. Kalau setelah sync tabel products kosong/aneh, cek dulu:
//   curl "<PRICE_LIST_URL>" | head
// lalu sesuaikan pemetaan field di bawah.
app.post("/api/products/sync", async (c) => {
  if (!c.env.PRICE_LIST_URL) {
    return c.json({ ok: false, error: "Secret PRICE_LIST_URL belum diisi di Worker Settings → Variables and Secrets" }, 400);
  }

  let list;
  try {
    const res = await fetch(c.env.PRICE_LIST_URL);
    if (!res.ok) {
      return c.json({ ok: false, error: `Gagal ambil daftar harga, server balas status ${res.status}` }, 502);
    }
    const data = await res.json();
    list = Array.isArray(data) ? data : data.data || data.result || [];
  } catch (err) {
    return c.json({ ok: false, error: "Gagal ambil/baca daftar harga: " + err.message }, 502);
  }

  // Markup flat per transaksi di atas harga modal OkeConnect. Sesuaikan sendiri
  // di sini, atau nanti ubah manual per produk lewat halaman "Produk" -> "Ubah".
  const MARKUP = 500;

  // Ditandai di setiap baris yang "terlihat" pada sinkron kali ini — dipakai
  // setelah upsert selesai untuk menandai kode yang TIDAK terlihat lagi
  // (berarti sudah hilang dari daftar OkeConnect) sebagai nonaktif otomatis.
  const runStartedAt = new Date().toISOString();

  const stmt = c.env.DB.prepare(
    `INSERT INTO products (code, name, category, product_group, cost_price, sell_price, active, deactivated_at, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?)
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name,
       category = excluded.category,
       product_group = excluded.product_group,
       cost_price = excluded.cost_price,
       sell_price = excluded.sell_price,
       active = 1,
       deactivated_at = NULL,
       last_synced_at = excluded.last_synced_at`
  );

  const batchItems = [];
  let skipped = 0;
  for (const item of list) {
    const code = item.kode || item.code || item.product_code;
    // Field asli daftar harga OkeConnect: "keterangan" (deskripsi detail) dan
    // "produk" (nama grup produk) — bukan "nama"/"deskripsi" seperti sebelumnya.
    const name = item.keterangan || item.produk || item.nama || item.name;
    const category = item.kategori || item.category || null;
    // "produk" jauh lebih spesifik dari "kategori" — mis. "Telkomsel", "Masa
    // Aktif Axis", "SMS Telepon Indosat" — dipakai buat Katalog PPOB bertingkat.
    const productGroup = item.produk || null;
    // "harga" di JSON OkeConnect adalah harga MODAL (yang Anda bayar ke mereka),
    // bukan harga jual ke pelanggan — sebelumnya salah ditaruh di sell_price.
    const cost = Number(item.harga || item.price || 0);
    const sell = cost + MARKUP;
    if (!code || !name) {
      skipped++;
      continue;
    }
    if (item.status === "0" || item.status === 0) {
      skipped++;
      continue; // produk nonaktif/kosong di OkeConnect — biarkan tertangkap sbg "tidak terlihat" di bawah
    }
    batchItems.push(stmt.bind(code, name, category, productGroup, cost, sell, runStartedAt));
  }

  // Kirim per-batch (bukan satu-satu berurutan) supaya jauh lebih cepat dan
  // tidak kena limit waktu eksekusi Worker untuk daftar harga yang isinya
  // ribuan produk. D1 batasi ukuran satu batch, jadi dipecah per 100 statement.
  const BATCH_SIZE = 100;
  let count = 0;
  let lastError = null;
  for (let i = 0; i < batchItems.length; i += BATCH_SIZE) {
    const chunk = batchItems.slice(i, i + BATCH_SIZE);
    try {
      await c.env.DB.batch(chunk);
      count += chunk.length;
    } catch (err) {
      lastError = `batch mulai index ${i}: ${err.message}`;
    }
  }

  // Kode yang sebelumnya aktif tapi TIDAK terlihat di sinkron kali ini (baik
  // karena hilang total dari sumber, atau statusnya 0) → tandai nonaktif.
  // Soft-delete, bukan DELETE — riwayat transaksi lama & nama produk tetap aman.
  const deactivateRes = await c.env.DB.prepare(
    `UPDATE products SET active = 0, deactivated_at = datetime('now')
     WHERE code IS NOT NULL AND active = 1 AND (last_synced_at IS NULL OR last_synced_at < ?)`
  )
    .bind(runStartedAt)
    .run();

  return c.json({
    ok: true,
    synced: count,
    total: list.length,
    skipped,
    deactivated: deactivateRes.meta?.changes ?? 0,
    lastError,
  });
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
// lalu kurangi stok. Untuk expense/mutation, "items" boleh dikosongkan.
app.post("/api/transactions", async (c) => {
  const employee = c.get("employee");
  const {
    type, // sale | purchase | expense | mutation
    category,
    wallet_id,
    note,
    contact_id,
    items = [], // [{ product_id, qty }]
    amount, // dipakai kalau tidak ada items (mis. expense manual)
  } = await c.req.json();

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

  const insertResult = await c.env.DB.prepare(
    `INSERT INTO transactions (type, category, wallet_id, amount, cost_total, note, contact_id, employee_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(type, category || null, wallet_id || null, total, costTotal, note || null, contact_id || null, employee ? employee.employeeId : null)
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

  if (wallet_id) {
    const delta = type === "sale" ? total : -total; // penjualan nambah kas, pembelian/expense ngurangin
    await c.env.DB.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?")
      .bind(delta, wallet_id)
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

  if (t.wallet_id) {
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

// Arus kas per akun/dompet dalam rentang tanggal
app.get("/api/reports/cashflow", async (c) => {
  const start = c.req.query("start") || "1970-01-01";
  const end = c.req.query("end") || "2999-12-31";
  const { results } = await c.env.DB.prepare(
    `SELECT wallet_id, w.name AS wallet_name,
            SUM(CASE WHEN t.type = 'sale' THEN t.amount ELSE 0 END) AS masuk,
            SUM(CASE WHEN t.type IN ('purchase','expense') THEN t.amount ELSE 0 END) AS keluar
     FROM transactions t LEFT JOIN wallets w ON w.id = t.wallet_id
     WHERE date(t.date) BETWEEN date(?) AND date(?)
     GROUP BY wallet_id`
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
    const { status, reply } = await recheckOrder(c.env, order);
    return c.json({ ok: true, status, reply });
  } catch (err) {
    return c.json({ ok: false, error: "Gagal cek ke OkeConnect: " + err.message }, 502);
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
  const { productCode, target } = await c.req.json();
  if (!productCode || !target) {
    return c.json({ ok: false, error: "productCode dan target wajib diisi" }, 400);
  }
  try {
    const result = await placePpobOrder(c.env, { productCode, target });
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

// Setelah order postpaid (tagihan/PDAM) sukses, kasir input manual nominal
// asli yang diterima dari pelanggan & yang terpotong dari saldo distributor
// (dibaca dari balasan Cek/Bayar OkeConnect) — baru di sini dicatat sebagai
// transaksi & saldo dipotong, supaya laporan keuangan akurat.
app.post("/api/ppob-orders/:refId/catat", async (c) => {
  const refId = c.req.param("refId");
  const { amount, cost_total } = await c.req.json();
  if (amount === undefined || cost_total === undefined) {
    return c.json({ ok: false, error: "amount dan cost_total wajib diisi" }, 400);
  }
  const order = await c.env.DB.prepare("SELECT * FROM ppob_orders WHERE ref_id = ?").bind(refId).first();
  if (!order) return c.json({ ok: false, error: "Order tidak ditemukan" }, 404);
  if (order.status !== "sukses") return c.json({ ok: false, error: "Order belum sukses, tidak bisa dicatat" }, 400);
  if (order.finalized) return c.json({ ok: false, error: "Order ini sudah pernah dicatat" }, 400);

  await c.env.DB.prepare(
    `INSERT INTO transactions (type, category, wallet_id, amount, cost_total, note)
     VALUES ('sale', 'Tagihan/PDAM', ?, ?, ?, ?)`
  )
    .bind(order.wallet_id, amount, cost_total, `${order.product_code} ke ${order.target} (ref ${refId})`)
    .run();

  if (order.wallet_id) {
    await c.env.DB.prepare("UPDATE wallets SET balance = balance - ? WHERE id = ?")
      .bind(cost_total, order.wallet_id)
      .run();
  }

  await c.env.DB.prepare("UPDATE ppob_orders SET finalized = 1 WHERE ref_id = ?").bind(refId).run();

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// WEBHOOK TELEGRAM — bot jualan PPOB
//
// Perintah yang didukung (contoh):
//   /beli TSEL5 081234567890         -> order pulsa/paket kode TSEL5 ke nomor itu
//   /cek REF123                      -> cek status order
//   /saldo                           -> lihat saldo akun distributor
//
// Format ke OkeConnect mengikuti: {KODE}.{NO_HP}.{PIN}.R#{ID}
// (lihat catatan CS OkeConnect Anda). Sesuaikan bila format berbeda per produk.
// ---------------------------------------------------------------------------

app.post("/telegram/webhook", async (c) => {
  // Validasi header rahasia supaya endpoint tidak bisa dipanggil sembarangan
  const secret = c.req.header("x-telegram-bot-api-secret-token");
  if (secret !== c.env.TELEGRAM_SECRET) return c.text("forbidden", 403);

  const update = await c.req.json();
  const message = update.message;
  if (!message || !message.text) return c.text("ok");

  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const env = c.env;

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

// Cek ulang SATU order ke OkeConnect (via CEK.R#) dan update status/raw_reply +
// catat transaksi kalau ternyata sukses. Dipakai baik oleh cron (otomatis,
// sekali saja per order) maupun endpoint manual (tombol "Cek Ulang Status").
async function recheckOrder(env, order) {
  // TODO: sesuaikan format perintah "cek status" sesuai dokumentasi OkeConnect
  // (di screenshot CS Anda ada varian format berakhiran huruf 'A' untuk ID pelanggan —
  // konfirmasi ke OkeConnect apakah itu juga dipakai untuk query status).
  const reply = await sendJabberCommand({
    jid: env.JABBER_JID,
    password: env.JABBER_PASSWORD,
    to: env.JABBER_TARGET || "okeconnect@gojabber.com",
    body: `CEK.R#${order.ref_id}`,
  });
  const status = detectPpobStatus(reply);

  await env.DB.prepare(
    "UPDATE ppob_orders SET status = ?, raw_reply = ?, updated_at = datetime('now'), auto_checked = 1 WHERE id = ?"
  )
    .bind(status, reply, order.id)
    .run();

  if (status === "sukses") {
    const product = await env.DB.prepare("SELECT * FROM products WHERE code = ?")
      .bind(order.product_code)
      .first();
    const wallet = order.wallet_id
      ? await env.DB.prepare("SELECT * FROM wallets WHERE id = ?").bind(order.wallet_id).first()
      : null;
    if (product) {
      await recordPpobSale(env, { product, wallet, refId: order.ref_id, target: order.target });
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
async function checkPendingOrders(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM ppob_orders
     WHERE status = 'pending' AND auto_checked = 0 AND created_at <= datetime('now', '-5 minutes')
     LIMIT 20`
  ).all();

  for (const order of results) {
    try {
      await recheckOrder(env, order);
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
    } else {
      ctx.waitUntil(checkPendingOrders(env));
    }
  },
};
