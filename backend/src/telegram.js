export async function sendTelegramMessage(token, chatId, text, options = {}) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", ...options }),
  });
}

// Edit teks & tombol dari pesan bot yang sudah terkirim — dipakai supaya
// navigasi menu (mis. buka detail hutang, lalu kembali ke daftar) tidak
// numpuk pesan baru terus-terusan, cukup 1 pesan yang berubah-ubah isinya.
export async function editTelegramMessage(token, chatId, messageId, text, options = {}) {
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown", ...options }),
  });
}

// Wajib dipanggil tiap kali terima callback_query (tombol ditekan), kalau
// tidak Telegram akan terus menampilkan ikon "loading" di tombol tsb di HP user.
export async function answerCallbackQuery(token, callbackQueryId, text = "") {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  });
}
