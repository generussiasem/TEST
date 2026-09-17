// ---------------------------------------------------------------------------
// Wrapper tipis di atas Telegram Bot API. PENTING: semua fungsi di sini
// memakai parse_mode "Markdown" secara default supaya *bold* di teks menu
// tetap tampil rapi — TAPI banyak teks yang disisipkan berasal dari data
// bebas (nama/catatan kontak, balasan mentah provider PPOB) yang bisa saja
// mengandung karakter spesial Markdown (* _ [ `). Kalau itu terjadi, Telegram
// menolak SELURUH pesan dengan error "can't parse entities" — dan sebelumnya
// error itu tidak pernah dicek, jadi pesan gagal terkirim/ter-edit TANPA
// pemberitahuan apa pun (menu terlihat macet). Sekarang setiap panggilan:
//   1) selalu mengecek `ok` dari response Telegram,
//   2) kalau gagal justru karena parse_mode (bukan sebab lain), otomatis
//      kirim ulang SEKALI tanpa parse_mode (teks apa adanya, tanpa bold)
//      supaya pesan tetap sampai ke kasir daripada hilang begitu saja,
//   3) selalu log ke console.error kalau tetap gagal, supaya kelihatan di
//      `wrangler tail` saat debug produksi.
// ---------------------------------------------------------------------------

async function callTelegramApi(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status} (balasan bukan JSON)` }));

  if (!data.ok && body.parse_mode && /can't parse entities|can't find end of/i.test(data.description || "")) {
    // Retry sekali tanpa parse_mode — teks tampil apa adanya (tanpa bold)
    // tapi setidaknya benar-benar terkirim, bukan diam-diam hilang.
    const { parse_mode, ...bodyPlain } = body;
    const retryRes = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyPlain),
    });
    const retryData = await retryRes.json().catch(() => ({ ok: false, description: `HTTP ${retryRes.status}` }));
    if (!retryData.ok) {
      console.error(`Telegram ${method} gagal (setelah retry tanpa parse_mode):`, retryData.description);
    }
    return retryData;
  }

  if (!data.ok) {
    console.error(`Telegram ${method} gagal:`, data.description);
  }
  return data;
}

export async function sendTelegramMessage(token, chatId, text, options = {}) {
  return callTelegramApi(token, "sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", ...options });
}

// Edit teks & tombol dari pesan bot yang sudah terkirim — dipakai supaya
// navigasi menu (mis. buka detail hutang, lalu kembali ke daftar) tidak
// numpuk pesan baru terus-terusan, cukup 1 pesan yang berubah-ubah isinya.
export async function editTelegramMessage(token, chatId, messageId, text, options = {}) {
  return callTelegramApi(token, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown", ...options });
}

// Wajib dipanggil tiap kali terima callback_query (tombol ditekan), kalau
// tidak Telegram akan terus menampilkan ikon "loading" di tombol tsb di HP user.
export async function answerCallbackQuery(token, callbackQueryId, text = "") {
  return callTelegramApi(token, "answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: false });
}
