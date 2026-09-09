import { Hono } from "hono";
import { cors } from "hono/cors";
import { sendJabberCommand } from "./jabber.js";
import { sendTelegramMessage } from "./telegram.js";
import { placePpobOrder, recordPpobSale, cekTagihan } from "./ppob.js";
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

app.get("/api/products", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM products ORDER BY id").all();
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

  let count = 0;
  let lastError = null;
  for (const item of list) {
    const code = item.kode || item.code || item.product_code;
    // Field asli daftar harga OkeConnect: "keterangan" (deskripsi detail) dan
    // "produk" (nama grup produk) — bukan "nama"/"deskripsi" seperti sebelumnya.
    const name = item.keterangan || item.produk || item.nama || item.name;
    const category = item.kategori || item.category || null;
    // "harga" di JSON OkeConnect adalah harga MODAL (yang Anda bayar ke mereka),
    // bukan harga jual ke pelanggan — sebelumnya salah ditaruh di sell_price.
    const cost = Number(item.harga || item.price || 0);
    const sell = cost + MARKUP;
    if (!code || !name) continue;
    if (item.status === "0" || item.status === 0) continue; // produk nonaktif/kosong di OkeConnect

    try {
      await c.env.DB.prepare(
        `INSERT INTO products (code, name, category, cost_price, sell_price)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           name = excluded.name,
           category = excluded.category,
           cost_price = excluded.cost_price,
           sell_price = excluded.sell_price`
      )
        .bind(code, name, category, cost, sell)
        .run();
      count++;
    } catch (err) {
      lastError = `${code}: ${err.message}`;
    }
  }

  return c.json({ ok: true, synced: count, total: list.length, lastError });
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

async function checkPendingOrders(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM ppob_orders WHERE status = 'pending' AND created_at < datetime('now', '-3 minutes') LIMIT 20"
  ).all();

  for (const order of results) {
    try {
      // TODO: sesuaikan format perintah "cek status" sesuai dokumentasi OkeConnect
      // (di screenshot CS Anda ada varian format berakhiran huruf 'A' untuk ID pelanggan —
      // konfirmasi ke OkeConnect apakah itu juga dipakai untuk query status).
      const reply = await sendJabberCommand({
        jid: env.JABBER_JID,
        password: env.JABBER_PASSWORD,
        to: "okeconnect@gojabber.com",
        body: `CEK.R#${order.ref_id}`,
      });
      const success = /sukses|berhasil/i.test(reply);
      const failed = /gagal|error/i.test(reply);
      const status = success ? "sukses" : failed ? "gagal" : "pending";

      await env.DB.prepare(
        "UPDATE ppob_orders SET status = ?, raw_reply = ?, updated_at = datetime('now') WHERE id = ?"
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
    } catch (err) {
      // biarkan, dicoba lagi di jadwal cron berikutnya
    }
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkPendingOrders(env));
  },
};
