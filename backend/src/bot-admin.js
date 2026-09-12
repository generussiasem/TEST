import { sendTelegramMessage, editTelegramMessage, answerCallbackQuery } from "./telegram.js";
import { finalizePpobOrder } from "./ppob.js";

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

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📋 Cek Hutang Pelanggan", callback_data: "h:l:0" }],
      [{ text: "🧾 Konfirmasi Order PPOB", callback_data: "p:l:0" }],
      [{ text: "💳 Saldo Distributor", callback_data: "m:saldo" }],
    ],
  };
}

export async function sendMainMenu(env, chatId, employee) {
  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Halo, *${employee.name}*! 👋\nMau kelola apa hari ini?`, {
    reply_markup: mainMenuKeyboard(),
  });
}

// ---------------------------------------------------------------------------
// HUTANG PIUTANG
// ---------------------------------------------------------------------------

async function renderHutangList(env, page) {
  const offset = page * PAGE_SIZE;
  const { results } = await env.DB.prepare(
    "SELECT id, name, total_debt FROM contacts WHERE total_debt > 0 ORDER BY total_debt DESC LIMIT ? OFFSET ?"
  )
    .bind(PAGE_SIZE + 1, offset)
    .all();
  const hasMore = results.length > PAGE_SIZE;
  const rows = results.slice(0, PAGE_SIZE);

  const keyboard = rows.map((cst) => [{ text: `👤 ${cst.name} — ${rupiah(cst.total_debt)}`, callback_data: `h:s:${cst.id}` }]);
  const navRow = [];
  if (page > 0) navRow.push({ text: "⬅️ Sebelumnya", callback_data: `h:l:${page - 1}` });
  if (hasMore) navRow.push({ text: "Berikutnya ➡️", callback_data: `h:l:${page + 1}` });
  if (navRow.length) keyboard.push(navRow);
  keyboard.push([{ text: "🏠 Menu Utama", callback_data: "m:main" }]);

  const text = rows.length ? "*Pelanggan dengan hutang:*" : "Tidak ada pelanggan dengan hutang saat ini. 🎉";
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
  const typeLabel = { utang: "Utang", piutang: "Piutang", cicilan: "Bayar" };
  let text = `*${contact.name}*${contact.phone ? ` (${contact.phone})` : ""}\nSisa Hutang: *${rupiah(contact.total_debt)}*\n\n_Riwayat terakhir:_\n`;
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
  const text = `*${order.ref_id}*\n${order.product_code} → ${order.target}\nModal: ${rupiah(order.cost_price)}\nHarga jual saat ini: *${rupiah(defaultPrice)}*\n\nBalasan provider:\n${order.raw_reply || "-"}`;
  const keyboard = [
    [{ text: `✅ Pakai ${rupiah(defaultPrice)}`, callback_data: `p:ok:${refId}` }],
    [{ text: "✏️ Ubah Harga", callback_data: `p:edit:${refId}` }],
    [{ text: "🔙 Kembali", callback_data: "p:l:0" }],
  ];
  return { text, reply_markup: { inline_keyboard: keyboard } };
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
      payload = { text: `Halo, *${employee.name}*! 👋\nMau kelola apa hari ini?`, reply_markup: mainMenuKeyboard() };
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
    } else if (ns === "p" && action === "l") {
      payload = await renderPpobList(env, Number(arg) || 0);
    } else if (ns === "p" && action === "s") {
      payload = await renderPpobConfirm(env, arg);
    } else if (ns === "p" && action === "ok") {
      const order = await env.DB.prepare("SELECT * FROM ppob_orders WHERE ref_id = ?").bind(arg).first();
      if (!order) throw new Error("Order tidak ditemukan");
      const product = await env.DB.prepare("SELECT * FROM products WHERE code = ?").bind(order.product_code).first();
      const defaultPrice = order.sell_price || product?.sell_price || 0;
      await finalizePpobOrder(env, { refId: arg, sellPrice: defaultPrice });
      payload = {
        text: `✅ Dicatat dengan harga ${rupiah(defaultPrice)}. Struk *${arg}* sudah masuk laporan.`,
        reply_markup: { inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "m:main" }]] },
      };
    } else if (ns === "p" && action === "edit") {
      await setSession(env, chatId, "awaiting_ppob_price", { refId: arg });
      payload = {
        text: `Kirim harga jual baru untuk *${arg}* (angka saja, mis. 12000):`,
        reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: `p:s:${arg}` }]] },
      };
    } else {
      payload = { text: "Perintah tidak dikenal.", reply_markup: mainMenuKeyboard() };
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
    await env.DB.prepare("INSERT INTO debts (contact_id, type, amount, note) VALUES (?, 'cicilan', ?, ?)")
      .bind(contactId, nominal, "Dicatat via bot Telegram")
      .run();
    await env.DB.prepare("UPDATE contacts SET total_debt = total_debt - ? WHERE id = ?").bind(nominal, contactId).run();
    await clearSession(env, chatId);
    const contact = await env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(contactId).first();
    await sendTelegramMessage(
      token,
      chatId,
      `✅ Pembayaran ${rupiah(nominal)} dari *${contact?.name}* dicatat. Sisa hutang: ${rupiah(contact?.total_debt)}.`,
      { reply_markup: { inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "m:main" }]] } }
    );
    return true;
  }

  if (session.state === "awaiting_ppob_price") {
    const { refId } = session.data;
    if (!nominal || nominal <= 0) {
      await sendTelegramMessage(token, chatId, "Harga tidak valid. Kirim angka saja, mis. 12000.");
      return true;
    }
    await clearSession(env, chatId);
    try {
      await finalizePpobOrder(env, { refId, sellPrice: nominal });
      await sendTelegramMessage(token, chatId, `✅ Dicatat dengan harga ${rupiah(nominal)}. Struk *${refId}* sudah masuk laporan.`, {
        reply_markup: { inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "m:main" }]] },
      });
    } catch (err) {
      await sendTelegramMessage(token, chatId, `⚠️ Gagal: ${err.message}`);
    }
    return true;
  }

  return false;
}
