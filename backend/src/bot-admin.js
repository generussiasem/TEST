import { sendTelegramMessage, editTelegramMessage, answerCallbackQuery } from "./telegram.js";
import { finalizePpobOrder, placePpobOrder, usesDynamicCost, parseTagihanListrikDetail, parsePortalpulsaDetail, getProviderConfig, assertCfgComplete } from "./ppob.js";
import { sendJabberCommand } from "./jabber.js";
import { bayarHutang } from "./debt.js";

// ---------------------------------------------------------------------------
// BOT ADMIN/KASIR — menu Telegram bergaya "tombol" (bukan cuma command teks)
// untuk kelola Hutang Piutang & konfirmasi harga jual PPOB sebelum dicatat
// permanen ("cetak struk"-nya versi bot: pesan konfirmasi terakhir). HANYA
// bisa dipakai karyawan yang sudah "menghubungkan" akun Telegram-nya lewat
// kode dari halaman Karyawan di web (lihat handleLinkCommand) — beda dari
// perintah /beli, /cari, /saldo, /cek di index.js yang tetap terbuka untuk
// siapa saja (bot jualan PPOB publik, tidak berubah).
//
// Alur multi-langkah (mis. "kirim nominal pembayaran") disimpan di tabel
// bot_sessions per chat_id, karena Cloudflare Worker stateless antar-request.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 6;
const SESSION_TIMEOUT_MINUTES = 5; // sesi "menunggu input" (nominal bayar/harga) otomatis batal kalau tidak dibalas dalam waktu ini

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

export async function getEmployeeByChatId(env, chatId) {
  return env.DB.prepare("SELECT * FROM employees WHERE telegram_id = ? AND active = 1")
    .bind(String(chatId))
    .first();
}

async function setSession(env, chatId, state, data) {
  await env.DB.prepare(
    `INSERT INTO bot_sessions (chat_id, state, data, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = datetime('now')`
  )
    .bind(String(chatId), state, JSON.stringify(data || {}))
    .run();
}

async function getSession(env, chatId) {
  // Sesi yang sudah lebih tua dari SESSION_TIMEOUT_MINUTES dianggap kedaluwarsa
  // dan dibersihkan otomatis — supaya balasan telat (mis. kasir ditinggal
  // beberapa jam) tidak salah dianggap sebagai nominal pembayaran/harga.
  const row = await env.DB.prepare(
    `SELECT *, (updated_at <= datetime('now', '-${SESSION_TIMEOUT_MINUTES} minutes')) AS is_expired
     FROM bot_sessions WHERE chat_id = ?`
  )
    .bind(String(chatId))
    .first();
  if (!row) return null;
  if (row.is_expired) {
    await clearSession(env, chatId);
    return { state: "expired", data: {} };
  }
  return { state: row.state, data: row.data ? JSON.parse(row.data) : {} };
}

async function clearSession(env, chatId) {
  await env.DB.prepare("DELETE FROM bot_sessions WHERE chat_id = ?").bind(String(chatId)).run();
}

// Kode dibuat dari web (halaman Karyawan, tombol "Hubungkan Bot Telegram"),
// lalu karyawan kirim "/hubung KODE" ke bot supaya chat_id-nya tertaut ke
// akunnya. Kode sekali pakai & kedaluwarsa (lihat POST /api/employees/:id/telegram-link-code).
export async function handleLinkCommand(env, chatId, text) {
  const code = text.replace(/^\/hubung\s*/i, "").trim();
  if (!code) {
    return 'Format: `/hubung KODE`\nAmbil kode dari halaman *Karyawan* di web, tombol "Hubungkan Bot Telegram".';
  }
  const employee = await env.DB.prepare(
    "SELECT * FROM employees WHERE link_code = ? AND link_code_expires > datetime('now')"
  )
    .bind(code)
    .first();
  if (!employee) {
    return "Kode salah atau sudah kedaluwarsa. Buat kode baru dari halaman Karyawan, lalu coba lagi.";
  }
  await env.DB.prepare("UPDATE employees SET telegram_id = ?, link_code = NULL, link_code_expires = NULL WHERE id = ?")
    .bind(String(chatId), employee.id)
    .run();
  return `Berhasil terhubung sebagai *${employee.name}* (${employee.role}). Kirim /menu untuk mulai.`;
}

// Tombol "🧮 Buka Mini App Kasir" cuma muncul kalau secret MINIAPP_URL sudah
// diisi (lihat README — biasanya https://<WORKER_URL>/miniapp). Ini beda dari
// tombol lain di menu ini: bukan callback_data yang ditangani handleAdminCallback,
// tapi tipe "web_app" yang membuka halaman GET /miniapp (lihat miniapp-page.js)
// sebagai Telegram Mini App penuh (bukan cuma pesan tombol biasa) — di situ
// karyawan bisa catat/bayar hutang & transaksi PPOB dengan UI form, bukan
// cuma alur "kirim nominal" lewat chat seperti menu di bawah ini.
function mainMenuKeyboard(env, employee) {
  const rows = [];
  if (env?.MINIAPP_URL) {
    rows.push([{ text: "🧮 Buka Mini App Kasir", web_app: { url: env.MINIAPP_URL } }]);
  }
  rows.push([{ text: "📋 Cek Hutang Pelanggan", callback_data: "h:l:0" }]);
  rows.push([{ text: "🗂️ Katalog PPOB", callback_data: "k:kat" }]);
  rows.push([{ text: "🔎 Transaksi PPOB (cari cepat)", callback_data: "b:cari:0" }]);
  rows.push([{ text: "🧾 Konfirmasi Order PPOB", callback_data: "p:l:0" }]);
  rows.push([{ text: "💳 Saldo Distributor", callback_data: "m:saldo" }]);
  // Deposit menyangkut saldo & rekening — dibatasi role admin, sama seperti
  // di web (Pengaturan) & Mini App. employee bisa undefined di beberapa
  // titik panggil lama (aman: fallback ke tidak ditampilkan).
  if (employee?.role === "admin") {
    rows.push([{ text: "💰 Deposit portalpulsa", callback_data: "dep:start" }]);
  }
  return { inline_keyboard: rows };
}

export async function sendMainMenu(env, chatId, employee) {
  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Halo, *${employee.name}*! 👋\nMau kelola apa hari ini?`, {
    reply_markup: mainMenuKeyboard(env, employee),
  });
}

// ---------------------------------------------------------------------------
// HUTANG PIUTANG
// ---------------------------------------------------------------------------

async function renderHutangList(env, page) {
  const offset = page * PAGE_SIZE;
  const { results } = await env.DB.prepare(
    "SELECT id, name, total_debt, deposit FROM contacts WHERE total_debt > 0 OR deposit > 0 ORDER BY total_debt DESC, deposit DESC LIMIT ? OFFSET ?"
  )
    .bind(PAGE_SIZE + 1, offset)
    .all();
  const hasMore = results.length > PAGE_SIZE;
  const rows = results.slice(0, PAGE_SIZE);

  const keyboard = rows.map((cst) => [{ text: `👤 ${cst.name} — ${cst.total_debt > 0 ? rupiah(cst.total_debt) : `titipan ${rupiah(cst.deposit)}`}`, callback_data: `h:s:${cst.id}` }]);
  const navRow = [];
  if (page > 0) navRow.push({ text: "⬅️ Sebelumnya", callback_data: `h:l:${page - 1}` });
  if (hasMore) navRow.push({ text: "Berikutnya ➡️", callback_data: `h:l:${page + 1}` });
  if (navRow.length) keyboard.push(navRow);
  keyboard.push([{ text: "🏠 Menu Utama", callback_data: "m:main" }]);

  const text = rows.length ? "*Pelanggan dengan hutang/titipan:*" : "Tidak ada pelanggan dengan hutang saat ini. 🎉";
  return { text, reply_markup: { inline_keyboard: keyboard } };
}

async function renderHutangDetail(env, contactId) {
  const contact = await env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(contactId).first();
  if (!contact) {
    return { text: "Kontak tidak ditemukan.", reply_markup: { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "h:l:0" }]] } };
  }
  const { results: riwayat } = await env.DB.prepare("SELECT * FROM debts WHERE contact_id = ? ORDER BY date DESC LIMIT 5")
    .bind(contactId)
    .all();
  const typeLabel = { utang: "Utang", piutang: "Piutang", cicilan: "Bayar", titip: "Titip", pakai_titip: "Pakai titipan", tarik_titip: "Tarik titipan" };
  let text = `*${contact.name}*${contact.phone ? ` (${contact.phone})` : ""}\nSisa Hutang: *${rupiah(contact.total_debt)}*${contact.deposit > 0 ? `\nSaldo Titipan: *${rupiah(contact.deposit)}*` : ""}\n\n_Riwayat terakhir:_\n`;
  text += riwayat.length
    ? riwayat
        .map(
          (d) =>
            `• ${new Date(d.date).toLocaleDateString("id-ID")} — ${typeLabel[d.type] || d.type} ${rupiah(d.amount)}${d.note ? ` (${d.note})` : ""}`
        )
        .join("\n")
    : "_Belum ada riwayat._";

  const keyboard = [
    [{ text: "💵 Catat Pembayaran", callback_data: `h:p:${contactId}` }],
    [{ text: "🔙 Kembali ke Daftar", callback_data: "h:l:0" }],
  ];
  return { text, reply_markup: { inline_keyboard: keyboard } };
}

// ---------------------------------------------------------------------------
// KATALOG PPOB — GRID KATEGORI (ala tampilan OrderKuota: kotak ikon per
// kategori -> kotak provider dalam kategori itu -> daftar harga -> pilih item
// lanjut ke alur target/metode bayar yang SAMA dgn pencarian teks di bawah
// (reuse pilihProdukPpob). Bedanya cuma cara nemuin kode produknya — Telegram
// tidak punya grid visual asli, jadi didekati dgn tombol 2 per baris.
//
// Cuma nampilin produk yg category-nya TERISI (katalog OkeConnect hasil
// sync) — portalpulsa sengaja NUL category-nya (lihat placePpobOrder di
// ppob.js), jadi tidak akan pernah muncul di grid ini; itu tetap lewat jalur
// "cari cepat" -> tombol kode manual.
//
// Ikon per kategori DISALIN dari KATEGORI_ICON di miniapp-page.js — kalau
// salah satu diubah, ubah juga yang satunya biar konsisten.
// ---------------------------------------------------------------------------
const KATALOG_PAGE_SIZE = 8;
const KATEGORI_ICON = [
  [/pulsa/i, "📱"],
  [/kuota|internet|data/i, "📶"],
  [/token|listrik|pln/i, "⚡"],
  [/tagihan|pdam|air|bpjs|tv kabel|multifinance/i, "🧾"],
  [/e-?wallet|saldo|dompet/i, "💳"],
  [/voucher|game|top ?up game/i, "🎮"],
  [/sms|telp/i, "☎️"],
];
function iconUntukKategori(kategori) {
  const found = KATEGORI_ICON.find(([re]) => re.test(kategori || ""));
  return found ? found[1] : "🛒";
}
// Susun array jadi baris isi 2 tombol, biar mirip kesan grid tanpa bikin
// teks tombol kepotong (Telegram tidak muat 4 kolom dgn label kepanjangan).
function baris2(items) {
  const rows = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}

async function renderKatalogKategori(env) {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT category FROM products WHERE active = 1 AND category IS NOT NULL ORDER BY category"
  ).all();
  if (!results.length) {
    return {
      text: "Katalog masih kosong. Sinkron dulu dari dashboard web (tombol \"Sinkron Harga PPOB\").",
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "m:main" }]] },
    };
  }
  const tombol = results.map((r) => ({
    text: `${iconUntukKategori(r.category)} ${r.category}`,
    callback_data: `k:grp:${r.category}`,
  }));
  const keyboard = baris2(tombol);
  keyboard.push([{ text: "🏠 Menu Utama", callback_data: "m:main" }]);
  return { text: "*Katalog PPOB* — pilih kategori:", reply_markup: { inline_keyboard: keyboard } };
}

async function renderKatalogGrup(env, kategori) {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT product_group FROM products WHERE active = 1 AND category = ? AND product_group IS NOT NULL ORDER BY product_group"
  )
    .bind(kategori)
    .all();
  // Cuma 1 grup (atau tidak ada grup sama sekali di kategori ini) -> langsung
  // daftar item, tidak usah nampilin grid provider isi 1 kotak doang.
  if (results.length <= 1) return renderKatalogItem(env, kategori, null, 0);

  const tombol = results.map((r) => ({
    text: `${iconUntukKategori(r.product_group)} ${r.product_group}`,
    callback_data: `k:itg:${kategori}|${r.product_group}|0`,
  }));
  const keyboard = baris2(tombol);
  keyboard.push([{ text: "🔙 Kembali ke Kategori", callback_data: "k:kat" }]);
  return { text: `*${kategori}* — pilih provider:`, reply_markup: { inline_keyboard: keyboard } };
}

async function renderKatalogItem(env, kategori, grup, page) {
  const offset = page * KATALOG_PAGE_SIZE;
  const where = grup ? "category = ? AND product_group = ?" : "category = ?";
  const params = grup ? [kategori, grup] : [kategori];
  const { results } = await env.DB.prepare(
    `SELECT code, name, sell_price FROM products WHERE active = 1 AND ${where} ORDER BY sell_price ASC LIMIT ? OFFSET ?`
  )
    .bind(...params, KATALOG_PAGE_SIZE + 1, offset)
    .all();
  const hasMore = results.length > KATALOG_PAGE_SIZE;
  const rows = results.slice(0, KATALOG_PAGE_SIZE);

  const backCb = grup ? `k:grp:${kategori}` : "k:kat";
  const keyboard = rows.map((p) => [{ text: `${p.name} — ${rupiah(p.sell_price)}`, callback_data: `b:pick:${p.code}` }]);
  const navRow = [];
  const pageArg = grup ? `k:itg:${kategori}|${grup}|` : `k:itk:${kategori}|`;
  if (page > 0) navRow.push({ text: "⬅️ Sebelumnya", callback_data: `${pageArg}${page - 1}` });
  if (hasMore) navRow.push({ text: "Berikutnya ➡️", callback_data: `${pageArg}${page + 1}` });
  if (navRow.length) keyboard.push(navRow);
  keyboard.push([{ text: "🔙 Kembali", callback_data: backCb }]);

  const judul = grup ? `${kategori} — ${grup}` : kategori;
  return {
    text: rows.length ? `*${judul}*` : `Tidak ada produk di *${judul}*.`,
    reply_markup: { inline_keyboard: keyboard },
  };
}

// ---------------------------------------------------------------------------
// KATALOG & TRANSAKSI PPOB LEWAT CHAT (cari produk -> pilih -> nomor tujuan
// -> metode bayar -> kirim ke provider). Beda dari command teks "/beli KODE
// NOMOR" yang sudah ada (masih tetap jalan) — ini versi tombol spy kasir
// tidak perlu hafal kode produk. Kode BARU yang tidak ada di katalog otomatis
// dianggap portalpulsa (lihat newProductProvider di placePpobOrder, ppob.js).
// ---------------------------------------------------------------------------

async function pilihProdukPpob(env, chatId, code, isNew = false) {
  let product = null;
  if (!isNew) {
    product = await env.DB.prepare("SELECT * FROM products WHERE code = ?").bind(code).first();
    if (!product) throw new Error(`Produk "${code}" tidak ditemukan.`);
  }
  await setSession(env, chatId, "awaiting_ppob_target", { productCode: code, isNew });
  return {
    text: isNew
      ? `Kode baru: *${code}* (dianggap produk *portalpulsa* — modal & harga jual diisi manual nanti, saat konfirmasi).\n\nKirim nomor tujuan:`
      : `*${product.name}* (${product.code})\n\nKirim nomor tujuan:`,
    reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "b:cari:0" }]] },
  };
}

// Eksekusi akhir: kirim order ke provider (lewat placePpobOrder, jalur sama
// persis dengan web & command /beli — termasuk peringatan saldo menipis).
async function eksekusiOrderPpob(env, chatId, { productCode, target, paidMethod, contactId, isNew }) {
  await clearSession(env, chatId);
  const result = await placePpobOrder(env, {
    productCode,
    target,
    paidMethod,
    contactId,
    newProductProvider: isNew ? "portalpulsa" : null,
  });
  const menuBtn = { inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "m:main" }]] };
  let text = `Order *${result.refId}* (${result.status}):\n${result.reply}`;
  if (result.warning) text += `\n\n⚠️ ${result.warning}`;
  if (result.status === "sukses") {
    text += `\n\nSelanjutnya, konfirmasi harga jualnya:`;
    return {
      text,
      reply_markup: {
        inline_keyboard: [[{ text: "🧾 Konfirmasi Harga", callback_data: `p:s:${result.refId}` }], [{ text: "🏠 Menu Utama", callback_data: "m:main" }]],
      },
    };
  }
  return { text, reply_markup: menuBtn };
}

// ---------------------------------------------------------------------------
// KONFIRMASI HARGA JUAL PPOB (sebelum dicatat permanen = "cetak struk"-nya bot)
// ---------------------------------------------------------------------------

async function renderPpobList(env, page) {
  const offset = page * PAGE_SIZE;
  const { results } = await env.DB.prepare(
    "SELECT ref_id, product_code, target, sell_price FROM ppob_orders WHERE status = 'sukses' AND finalized = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?"
  )
    .bind(PAGE_SIZE + 1, offset)
    .all();
  const hasMore = results.length > PAGE_SIZE;
  const rows = results.slice(0, PAGE_SIZE);

  const keyboard = rows.map((o) => [{ text: `🧾 ${o.ref_id} — ${o.product_code} (${o.target})`, callback_data: `p:s:${o.ref_id}` }]);
  const navRow = [];
  if (page > 0) navRow.push({ text: "⬅️ Sebelumnya", callback_data: `p:l:${page - 1}` });
  if (hasMore) navRow.push({ text: "Berikutnya ➡️", callback_data: `p:l:${page + 1}` });
  if (navRow.length) keyboard.push(navRow);
  keyboard.push([{ text: "🏠 Menu Utama", callback_data: "m:main" }]);

  const text = rows.length
    ? "*Order PPOB sukses, menunggu konfirmasi harga:*"
    : "Tidak ada order PPOB yang perlu dikonfirmasi. 🎉";
  return { text, reply_markup: { inline_keyboard: keyboard } };
}

async function renderPpobConfirm(env, refId) {
  const order = await env.DB.prepare("SELECT * FROM ppob_orders WHERE ref_id = ?").bind(refId).first();
  if (!order) {
    return { text: "Order tidak ditemukan.", reply_markup: { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "p:l:0" }]] } };
  }
  if (order.finalized) {
    return {
      text: `Order *${refId}* sudah pernah dicatat sebelumnya.`,
      reply_markup: { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "p:l:0" }]] },
    };
  }
  const product = await env.DB.prepare("SELECT * FROM products WHERE code = ?").bind(order.product_code).first();
  const defaultPrice = order.sell_price || product?.sell_price || 0;
  // Modal produk pascabayar (tagihan/PDAM) & portalpulsa BARU DIKETAHUI dari
  // balasan provider tiap transaksi — order.cost_price/product.cost_price
  // TIDAK BOLEH ditampilkan mentah-mentah di sini, itu bukan modal riilnya
  // (lihat parseTagihanListrikDetail/parsePortalpulsaDetail & usesDynamicCost
  // di ppob.js — logika yang SAMA dipakai finalizePpobOrder saat mencatat,
  // jadi apa yang tampil di sini konsisten dengan yang benar-benar tercatat).
  let modalTampil = order.cost_price;
  let modalCatatan = "";
  if (product && usesDynamicCost(product)) {
    const detail = product.provider === "portalpulsa" ? parsePortalpulsaDetail(order.raw_reply) : parseTagihanListrikDetail(order.raw_reply);
    const modalRiil = product.provider === "portalpulsa" ? detail.hpp : detail.modalRiil;
    if (modalRiil != null) {
      modalTampil = modalRiil;
    } else {
      modalTampil = null;
      modalCatatan = "\n⚠️ Modal tidak terdeteksi otomatis dari balasan provider — akan dicoba lagi saat dicatat, tapi cek dulu balasan mentahnya di bawah kalau meleset.";
    }
  }
  const text = `*${order.ref_id}*\n${order.product_code} → ${order.target}\nModal: ${modalTampil != null ? rupiah(modalTampil) : "belum diketahui"}${modalCatatan}\nHarga jual saat ini: *${rupiah(defaultPrice)}*\n\nBalasan provider:\n${order.raw_reply || "-"}`;
  const keyboard = [
    [{ text: `✅ Pakai ${rupiah(defaultPrice)}`, callback_data: `p:ok:${refId}` }],
    [{ text: "✏️ Ubah Harga", callback_data: `p:edit:${refId}` }],
    [{ text: "🔙 Kembali", callback_data: "p:l:0" }],
  ];
  return { text, reply_markup: { inline_keyboard: keyboard } };
}

// Langkah sebelum mencatat order PPOB dari bot: kalau dibayar tunai, kasir
// memilih DOMPET tempat uangnya diterima (lewat tombol). Order yang dibayar
// Utang langsung dicatat (tidak ada uang masuk).
async function lanjutKonfirmasiPpob(env, chatId, { refId, sellPrice, employeeId }) {
  const order = await env.DB.prepare("SELECT * FROM ppob_orders WHERE ref_id = ?").bind(refId).first();
  if (!order) throw new Error("Order tidak ditemukan");
  const menuBtn = { inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "m:main" }]] };
  if (order.paid_method === "utang") {
    await finalizePpobOrder(env, { refId, sellPrice, employeeId });
    await clearSession(env, chatId);
    return { text: `✅ Dicatat dengan harga ${rupiah(sellPrice)} (utang). Struk *${refId}* sudah masuk laporan.`, reply_markup: menuBtn };
  }
  const { results: wallets } = await env.DB.prepare(
    "SELECT id, name FROM wallets WHERE type != 'distributor_ppob' ORDER BY id"
  ).all();
  if (!wallets.length) throw new Error("Belum ada dompet (Tunai/Bank/E-Wallet). Tambahkan dulu lewat halaman Akun di web.");
  await setSession(env, chatId, "awaiting_ppob_wallet", { refId, sellPrice });
  return {
    text: `Harga jual ${rupiah(sellPrice)}. Uang diterima di dompet mana?`,
    reply_markup: {
      inline_keyboard: [
        ...wallets.map((w) => [{ text: `👛 ${w.name}`, callback_data: `p:w:${w.id}` }]),
        [{ text: "❌ Batal", callback_data: `p:s:${refId}` }],
      ],
    },
  };
}

// Eksekusi akhir pembayaran hutang dari bot (logika sama dengan web/mini app: debt.js).
async function selesaikanBayarHutang(env, chatId, employee, { contactId, nominal, walletId, kelebihan }) {
  const r = await bayarHutang(env, {
    contactId,
    amount: nominal,
    walletId,
    kelebihan,
    note: "Dicatat via bot Telegram",
    employeeId: employee.id,
  });
  await clearSession(env, chatId);
  const wallet = await env.DB.prepare("SELECT name FROM wallets WHERE id = ?").bind(walletId).first();
  let text = `✅ Pembayaran ${rupiah(nominal)} dari *${r.contact?.name}* dicatat ke *${wallet?.name || "dompet"}*.`;
  if (r.titipkan) text += `\n💰 ${rupiah(r.lebih)} dititipkan.`;
  if (r.dikembalikan) text += `\n💵 Kembalian ${rupiah(r.dikembalikan)} dikembalikan tunai.`;
  text += `\nSisa hutang: ${rupiah(r.contact?.total_debt)}.`;
  if (r.contact?.deposit > 0) text += ` Saldo titipan: ${rupiah(r.contact.deposit)}.`;
  return { text, reply_markup: { inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "m:main" }]] } };
}

// ---------------------------------------------------------------------------
// ROUTER: tombol ditekan (callback_query)
// ---------------------------------------------------------------------------

export async function handleAdminCallback(env, callbackQuery) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = String(callbackQuery.message.chat.id);
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data || "";

  const employee = await getEmployeeByChatId(env, chatId);
  if (!employee) {
    await answerCallbackQuery(token, callbackQuery.id, "Belum terhubung. Kirim /hubung KODE dulu.");
    return;
  }

  const [ns, action, arg] = data.split(":");
  let payload;
  let alert = "";

  try {
    if (ns === "m" && action === "main") {
      await clearSession(env, chatId);
      payload = { text: `Halo, *${employee.name}*! 👋\nMau kelola apa hari ini?`, reply_markup: mainMenuKeyboard(env, employee) };
    } else if (ns === "m" && action === "saldo") {
      const { results } = await env.DB.prepare("SELECT name, balance FROM wallets WHERE type = 'distributor_ppob'").all();
      const lines = results.map((w) => `${w.name}: ${rupiah(w.balance)}`);
      payload = {
        text: lines.length ? lines.join("\n") : "Belum ada akun saldo distributor.",
        reply_markup: { inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "m:main" }]] },
      };
    } else if (ns === "h" && action === "l") {
      payload = await renderHutangList(env, Number(arg) || 0);
    } else if (ns === "h" && action === "s") {
      payload = await renderHutangDetail(env, Number(arg));
    } else if (ns === "h" && action === "p") {
      const contact = await env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(arg).first();
      if (!contact) {
        payload = { text: "Kontak tidak ditemukan.", reply_markup: { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "h:l:0" }]] } };
      } else {
        await setSession(env, chatId, "awaiting_debt_payment", { contactId: Number(arg) });
        payload = {
          text: `Kirim nominal pembayaran untuk *${contact.name}* (sisa hutang ${rupiah(contact.total_debt)}):`,
          reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: `h:s:${arg}` }]] },
        };
      }
    } else if (ns === "h" && action === "w") {
      // Kasir memilih DOMPET tempat uang pembayaran diterima
      const session = await getSession(env, chatId);
      if (!session || session.state !== "awaiting_debt_wallet") {
        throw new Error("Sesi pembayaran sudah kedaluwarsa. Mulai lagi dari menu Hutang.");
      }
      const { contactId, nominal } = session.data;
      const contact = await env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(contactId).first();
      if (!contact) throw new Error("Kontak tidak ditemukan");
      const sisa = Math.max(Number(contact.total_debt) || 0, 0);
      const lebih = contact.type === "supplier" ? 0 : Math.max(nominal - sisa, 0);
      if (lebih > 0) {
        // Uang diterima melebihi hutang: kasir WAJIB memilih, tidak pernah otomatis.
        await setSession(env, chatId, "awaiting_debt_excess", { contactId, nominal, walletId: Number(arg) });
        payload = {
          text: `Uang diterima ${rupiah(nominal)}, sisa hutang ${rupiah(sisa)}.\nAda kelebihan *${rupiah(lebih)}* — mau diapakan?`,
          reply_markup: {
            inline_keyboard: [
              [{ text: "💵 Kembalikan tunai", callback_data: "h:k:kembalikan" }],
              [{ text: "💰 Titipkan untuk transaksi berikutnya", callback_data: "h:k:titipkan" }],
              [{ text: "❌ Batal", callback_data: `h:s:${contactId}` }],
            ],
          },
        };
      } else {
        payload = await selesaikanBayarHutang(env, chatId, employee, { contactId, nominal, walletId: Number(arg) });
      }
    } else if (ns === "h" && action === "k") {
      const session = await getSession(env, chatId);
      if (!session || session.state !== "awaiting_debt_excess") {
        throw new Error("Sesi pembayaran sudah kedaluwarsa. Mulai lagi dari menu Hutang.");
      }
      const { contactId, nominal, walletId } = session.data;
      payload = await selesaikanBayarHutang(env, chatId, employee, { contactId, nominal, walletId, kelebihan: arg });
    } else if (ns === "p" && action === "l") {
      payload = await renderPpobList(env, Number(arg) || 0);
    } else if (ns === "p" && action === "s") {
      payload = await renderPpobConfirm(env, arg);
    } else if (ns === "p" && action === "ok") {
      const order = await env.DB.prepare("SELECT * FROM ppob_orders WHERE ref_id = ?").bind(arg).first();
      if (!order) throw new Error("Order tidak ditemukan");
      const product = await env.DB.prepare("SELECT * FROM products WHERE code = ?").bind(order.product_code).first();
      const defaultPrice = order.sell_price || product?.sell_price || 0;
      payload = await lanjutKonfirmasiPpob(env, chatId, { refId: arg, sellPrice: defaultPrice, employeeId: employee.id });
    } else if (ns === "p" && action === "w") {
      // Kasir memilih DOMPET tempat uang pembayaran PPOB diterima
      const session = await getSession(env, chatId);
      if (!session || session.state !== "awaiting_ppob_wallet") {
        throw new Error("Sesi konfirmasi sudah kedaluwarsa. Buka lagi dari menu Konfirmasi Order PPOB.");
      }
      const { refId, sellPrice } = session.data;
      await finalizePpobOrder(env, { refId, sellPrice, receiveWalletId: Number(arg), employeeId: employee.id });
      await clearSession(env, chatId);
      const w = await env.DB.prepare("SELECT name FROM wallets WHERE id = ?").bind(Number(arg)).first();
      payload = {
        text: `✅ Dicatat dengan harga ${rupiah(sellPrice)}, uang masuk ke *${w?.name || "dompet"}*. Struk *${refId}* sudah masuk laporan.`,
        reply_markup: { inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "m:main" }]] },
      };
    } else if (ns === "p" && action === "edit") {
      await setSession(env, chatId, "awaiting_ppob_price", { refId: arg });
      payload = {
        text: `Kirim harga jual baru untuk *${arg}* (angka saja, mis. 12000):`,
        reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: `p:s:${arg}` }]] },
      };
    } else if (ns === "k" && action === "kat") {
      payload = await renderKatalogKategori(env);
    } else if (ns === "k" && action === "grp") {
      payload = await renderKatalogGrup(env, arg);
    } else if (ns === "k" && action === "itg") {
      const [kategori, grup, pageStr] = arg.split("|");
      payload = await renderKatalogItem(env, kategori, grup, Number(pageStr) || 0);
    } else if (ns === "k" && action === "itk") {
      const [kategori, pageStr] = arg.split("|");
      payload = await renderKatalogItem(env, kategori, null, Number(pageStr) || 0);
    } else if (ns === "b" && action === "cari") {
      await setSession(env, chatId, "awaiting_ppob_search", {});
      payload = {
        text: 'Ketik kata kunci produk (nama atau kode), mis. `telkomsel 5000` — atau kode portalpulsa langsung kalau kodenya belum ada di katalog.',
        reply_markup: { inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "m:main" }]] },
      };
    } else if (ns === "b" && action === "pick") {
      payload = await pilihProdukPpob(env, chatId, arg);
    } else if (ns === "b" && action === "manualnew") {
      const session = await getSession(env, chatId);
      if (!session || session.state !== "awaiting_ppob_search" || !session.data.query) {
        throw new Error("Sesi pencarian sudah kedaluwarsa/kode belum diketik. Buka lagi menu Transaksi PPOB.");
      }
      payload = await pilihProdukPpob(env, chatId, session.data.query, true);
    } else if (ns === "b" && action === "pay") {
      const session = await getSession(env, chatId);
      if (!session || session.state !== "awaiting_ppob_pay") {
        throw new Error("Sesi order sudah kedaluwarsa. Mulai lagi dari menu Transaksi PPOB.");
      }
      const { productCode, target, isNew } = session.data;
      if (arg === "tunai") {
        payload = await eksekusiOrderPpob(env, chatId, { productCode, target, paidMethod: "tunai", contactId: null, isNew });
      } else {
        await setSession(env, chatId, "awaiting_ppob_contact", { productCode, target, isNew });
        payload = {
          text: "Ketik nama pelanggan (yang berutang transaksi ini):",
          reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "b:cari:0" }]] },
        };
      }
    } else if (ns === "b" && action === "contact") {
      const session = await getSession(env, chatId);
      if (!session || session.state !== "awaiting_ppob_contact_pick") {
        throw new Error("Sesi order sudah kedaluwarsa. Mulai lagi dari menu Transaksi PPOB.");
      }
      const { productCode, target, isNew } = session.data;
      payload = await eksekusiOrderPpob(env, chatId, { productCode, target, paidMethod: "utang", contactId: Number(arg), isNew });
    } else if (ns === "dep" && action === "start") {
      if (employee.role !== "admin") {
        throw new Error("Cuma admin yang boleh kirim deposit portalpulsa.");
      }
      await setSession(env, chatId, "awaiting_deposit_bank", {});
      payload = {
        text: "Ketik nama bank tujuan deposit (mis. BCA):",
        reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "m:main" }]] },
      };
    } else {
      payload = { text: "Perintah tidak dikenal.", reply_markup: mainMenuKeyboard(env, employee) };
    }
  } catch (err) {
    alert = err.message;
    payload = { text: `⚠️ Gagal: ${err.message}`, reply_markup: { inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "m:main" }]] } };
  }

  await answerCallbackQuery(token, callbackQuery.id, alert);
  await editTelegramMessage(token, chatId, messageId, payload.text, { reply_markup: payload.reply_markup });
}

// ---------------------------------------------------------------------------
// ROUTER: pesan teks biasa dari karyawan yang sedang di tengah alur (bot_sessions
// aktif) — mis. sedang diminta kirim nominal pembayaran hutang. Return `false`
// kalau chat ini tidak sedang di tengah alur apa pun (biar index.js lanjut ke
// pengecekan command lama seperti /beli, /cari, dst).
// ---------------------------------------------------------------------------

export async function handleAdminSessionMessage(env, chatId, text) {
  const session = await getSession(env, chatId);
  if (!session) return false;

  const token = env.TELEGRAM_BOT_TOKEN;

  if (session.state === "expired") {
    await sendTelegramMessage(
      token,
      chatId,
      `⏱️ Sesi sebelumnya sudah kedaluwarsa (lebih dari ${SESSION_TIMEOUT_MINUTES} menit tanpa balasan). Kirim /menu untuk mulai lagi.`
    );
    return true;
  }

  const nominal = Number(String(text).replace(/[^\d]/g, ""));

  if (session.state === "awaiting_debt_payment") {
    const { contactId } = session.data;
    if (!nominal || nominal <= 0) {
      await sendTelegramMessage(token, chatId, "Nominal tidak valid. Kirim angka saja, mis. 50000.");
      return true;
    }
    // Langkah berikutnya: pilih DOMPET tempat uang diterima (lewat tombol).
    const { results: wallets } = await env.DB.prepare(
      "SELECT id, name FROM wallets WHERE type != 'distributor_ppob' ORDER BY id"
    ).all();
    if (!wallets.length) {
      await clearSession(env, chatId);
      await sendTelegramMessage(token, chatId, "⚠️ Belum ada dompet (Tunai/Bank/E-Wallet). Tambahkan dulu lewat halaman Akun di web.");
      return true;
    }
    await setSession(env, chatId, "awaiting_debt_wallet", { contactId, nominal });
    await sendTelegramMessage(token, chatId, `Uang ${rupiah(nominal)} diterima di dompet mana?`, {
      reply_markup: {
        inline_keyboard: [
          ...wallets.map((w) => [{ text: `👛 ${w.name}`, callback_data: `h:w:${w.id}` }]),
          [{ text: "❌ Batal", callback_data: `h:s:${contactId}` }],
        ],
      },
    });
    return true;
  }

  if (session.state === "awaiting_deposit_bank") {
    const bank = String(text).trim().toUpperCase();
    if (!bank) {
      await sendTelegramMessage(token, chatId, "Nama bank tidak boleh kosong. Ketik mis. BCA.");
      return true;
    }
    await setSession(env, chatId, "awaiting_deposit_nominal", { bank });
    await sendTelegramMessage(token, chatId, `Bank: ${bank}. Ketik nominal deposit (mis. 500000):`, {
      reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "m:main" }]] },
    });
    return true;
  }

  if (session.state === "awaiting_deposit_nominal") {
    const { bank } = session.data;
    if (!nominal || nominal <= 0) {
      await sendTelegramMessage(token, chatId, "Nominal tidak valid. Ketik angka saja, mis. 500000.");
      return true;
    }
    await clearSession(env, chatId);
    const employee = await getEmployeeByChatId(env, chatId);
    try {
      const cfg = getProviderConfig(env, "portalpulsa");
      assertCfgComplete(cfg);
      const body = `D ${bank} ${nominal} ${cfg.pin}`;
      // Deposit 2 tahap (ack dulu, baru instruksi transfer beneran) — lihat
      // catatan panjang di endpoint web/index.js ttg firstReplyIsFinal & kata
      // kunci "transfer" di FINAL_REPLY_KEYWORDS (jabber.js).
      const reply = await sendJabberCommand({
        jid: cfg.jid,
        password: cfg.password,
        to: cfg.target,
        body,
        refSeparator: cfg.separator,
        acceptAnyFromTarget: true,
      });
      await env.DB.prepare(
        "INSERT INTO portalpulsa_deposits (bank, nominal, raw_reply, employee_id) VALUES (?, ?, ?, ?)"
      )
        .bind(bank, nominal, reply, employee ? employee.employeeId : null)
        .run();
      await sendTelegramMessage(token, chatId, `Balasan portalpulsa:\n${reply}`, { reply_markup: mainMenuKeyboard(env, employee) });
    } catch (err) {
      await sendTelegramMessage(token, chatId, `Gagal kirim deposit: ${err.message}`, { reply_markup: mainMenuKeyboard(env, employee) });
    }
    return true;
  }

  if (session.state === "awaiting_ppob_search") {
    const q = String(text).trim();
    if (!q) {
      await sendTelegramMessage(token, chatId, "Ketik kata kunci dulu (nama atau kode produk).");
      return true;
    }
    const { results } = await env.DB.prepare(
      "SELECT code, name FROM products WHERE active = 1 AND (name LIKE ? OR code LIKE ?) ORDER BY name LIMIT 8"
    )
      .bind(`%${q}%`, `%${q}%`)
      .all();
    await setSession(env, chatId, "awaiting_ppob_search", { query: q });
    const keyboard = results.map((p) => [{ text: `${p.name} (${p.code})`, callback_data: `b:pick:${p.code}` }]);
    keyboard.push([{ text: `🆕 Pakai "${q}" sbg kode baru (portalpulsa)`, callback_data: "b:manualnew" }]);
    keyboard.push([{ text: "🏠 Menu Utama", callback_data: "m:main" }]);
    await sendTelegramMessage(token, chatId, results.length ? `Hasil untuk "${q}":` : `Tidak ada produk cocok utk "${q}" di katalog.`, {
      reply_markup: { inline_keyboard: keyboard },
    });
    return true;
  }

  if (session.state === "awaiting_ppob_target") {
    const { productCode, isNew } = session.data;
    const target = String(text).replace(/[^\d]/g, "");
    if (!target || target.length < 6) {
      await sendTelegramMessage(token, chatId, "Nomor tujuan tidak valid. Kirim angka saja, mis. 081234567890.");
      return true;
    }
    await setSession(env, chatId, "awaiting_ppob_pay", { productCode, target, isNew });
    await sendTelegramMessage(token, chatId, `Tujuan: ${target}. Dibayar bagaimana?`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💵 Tunai", callback_data: "b:pay:tunai" }],
          [{ text: "🧾 Utang", callback_data: "b:pay:utang" }],
          [{ text: "❌ Batal", callback_data: "b:cari:0" }],
        ],
      },
    });
    return true;
  }

  if (session.state === "awaiting_ppob_pay" || session.state === "awaiting_ppob_contact_pick") {
    await sendTelegramMessage(token, chatId, "Silakan pilih lewat tombol di atas, atau kirim /menu untuk batal.");
    return true;
  }

  if (session.state === "awaiting_ppob_contact") {
    const { productCode, target, isNew } = session.data;
    const q = String(text).trim();
    const { results } = await env.DB.prepare("SELECT id, name FROM contacts WHERE type = 'pelanggan' AND name LIKE ? ORDER BY name LIMIT 8")
      .bind(`%${q}%`)
      .all();
    if (!results.length) {
      await sendTelegramMessage(token, chatId, `Tidak ada pelanggan bernama "${q}". Coba nama lain, atau /menu untuk batal.`);
      return true;
    }
    await setSession(env, chatId, "awaiting_ppob_contact_pick", { productCode, target, isNew });
    const keyboard = results.map((cst) => [{ text: `👤 ${cst.name}`, callback_data: `b:contact:${cst.id}` }]);
    keyboard.push([{ text: "❌ Batal", callback_data: "b:cari:0" }]);
    await sendTelegramMessage(token, chatId, "Pilih pelanggan:", { reply_markup: { inline_keyboard: keyboard } });
    return true;
  }

  if (session.state === "awaiting_ppob_wallet") {
    await sendTelegramMessage(token, chatId, "Silakan pilih dompet lewat tombol di atas, atau kirim /menu untuk batal.");
    return true;
  }

  if (session.state === "awaiting_debt_wallet" || session.state === "awaiting_debt_excess") {
    await sendTelegramMessage(token, chatId, "Silakan pilih lewat tombol di atas, atau kirim /menu untuk batal.");
    return true;
  }

  if (session.state === "awaiting_ppob_price") {
    const { refId } = session.data;
    if (!nominal || nominal <= 0) {
      await sendTelegramMessage(token, chatId, "Harga tidak valid. Kirim angka saja, mis. 12000.");
      return true;
    }
    try {
      const emp = await getEmployeeByChatId(env, chatId);
      const p = await lanjutKonfirmasiPpob(env, chatId, { refId, sellPrice: nominal, employeeId: emp?.id });
      await sendTelegramMessage(token, chatId, p.text, { reply_markup: p.reply_markup });
    } catch (err) {
      await clearSession(env, chatId);
      await sendTelegramMessage(token, chatId, `⚠️ Gagal: ${err.message}`);
    }
    return true;
  }

  return false;
}
