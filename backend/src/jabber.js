// Klien XMPP (Jabber) minimal untuk Cloudflare Workers.
// Dipakai dengan pola "connect -> login -> kirim 1 pesan -> tunggu balasan -> tutup",
// bukan koneksi yang menyala terus. Ini cukup untuk perintah transaksi PPOB yang
// biasanya dibalas cepat oleh server OkeConnect.
//
// CATATAN JUJUR: ini parser XML yang disederhanakan (regex-based), bukan parser XML
// penuh. Cukup untuk stanza <message> teks biasa seperti balasan OkeConnect, tapi
// perlu diuji langsung terhadap server mereka dan disesuaikan bila formatnya beda.

import { connect } from "cloudflare:sockets";

const JABBER_PORT = 5222;

function xmlEscape(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function readUntil(reader, predicate, timeoutMs = 15000) {
  let buffer = "";
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
    ]);
    if (done) break;
    if (value === undefined) continue; // timeout tick, loop lagi sampai deadline
    buffer += decoder.decode(value, { stream: true });
    if (predicate(buffer)) return buffer;
  }
  throw new Error("Timeout menunggu balasan XMPP: " + buffer.slice(-300));
}

/**
 * Kirim satu perintah teks ke Jabber Center OkeConnect dan tunggu balasannya.
 * @param {object} opts
 * @param {string} opts.jid       - JID lengkap Anda, mis. "OK310547@gojabber.com"
 * @param {string} opts.password  - password akun OrderKuota Anda
 * @param {string} opts.to        - tujuan pesan, mis. "okeconnect@gojabber.com"
 * @param {string} opts.body      - isi perintah, mis. "TSEL5.081234.PIN.R#REF123"
 */
export async function sendJabberCommand({ jid, password, to, body }) {
  const [localpart, jabberHost] = jid.split("@");
  // Login ke server tempat akun Jabber Anda sendiri terdaftar (mis. jabbim.com),
  // BUKAN ke server tujuan pesan (okeconnect@gojabber.com) — dua server ini beda,
  // pesan dikirim lintas-server (federasi XMPP) via stanza <message> biasa.
  // secureTransport: "starttls" WAJIB disebut di sini kalau nanti mau panggil
  // socket.startTls() — API TCP Socket Cloudflare menolak startTls() kalau socket
  // dibuat tanpa opsi ini dari awal (persis error yang bikin order selalu pending).
  const socket = connect({ hostname: jabberHost, port: JABBER_PORT }, { secureTransport: "starttls" });
  let writer = socket.writable.getWriter();
  let reader = socket.readable.getReader();

  const send = (xml) => writer.write(new TextEncoder().encode(xml));

  try {
    // 1. Buka stream & minta STARTTLS
    await send(
      `<?xml version="1.0"?><stream:stream to="${jabberHost}" xmlns="jabber:client" ` +
        `xmlns:stream="http://etherx.jabber.org/streams" version="1.0">`
    );
    await readUntil(reader, (buf) => buf.includes("<starttls"));
    await send(`<starttls xmlns="urn:ietf:params:xml:ns:xmpp-tls"/>`);
    await readUntil(reader, (buf) => buf.includes("<proceed"));

    // 2. Upgrade koneksi ke TLS (didukung TCP Socket API Cloudflare Workers)
    const tlsSocket = socket.startTls();
    writer.releaseLock();
    reader.releaseLock();
    writer = tlsSocket.writable.getWriter();
    reader = tlsSocket.readable.getReader();

    // 3. Buka ulang stream di atas TLS, lalu SASL PLAIN auth
    await send(
      `<?xml version="1.0"?><stream:stream to="${jabberHost}" xmlns="jabber:client" ` +
        `xmlns:stream="http://etherx.jabber.org/streams" version="1.0">`
    );
    await readUntil(reader, (buf) => buf.includes("<mechanisms"));
    const authToken = btoa(`\u0000${localpart}\u0000${password}`);
    await send(
      `<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="PLAIN">${authToken}</auth>`
    );
    const authReply = await readUntil(
      reader,
      (buf) => buf.includes("<success") || buf.includes("<failure")
    );
    if (authReply.includes("<failure")) {
      throw new Error("Login Jabber gagal — cek JID/password.");
    }

    // 4. Bind resource & buka sesi
    await send(
      `<?xml version="1.0"?><stream:stream to="${jabberHost}" xmlns="jabber:client" ` +
        `xmlns:stream="http://etherx.jabber.org/streams" version="1.0">`
    );
    await readUntil(reader, (buf) => buf.includes("</stream:features>"));
    await send(
      `<iq type="set" id="bind1"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind">` +
        `<resource>kasir-worker</resource></bind></iq>`
    );
    await readUntil(reader, (buf) => buf.includes('id="bind1"'));

    // 5. Kirim perintah transaksi sebagai stanza <message>
    const msgId = "trx-" + Date.now();
    await send(
      `<message id="${msgId}" to="${xmlEscape(to)}" type="chat">` +
        `<body>${xmlEscape(body)}</body></message>`
    );

    // 6. Tunggu balasan <message> apa pun dari lawan bicara
    const reply = await readUntil(
      reader,
      (buf) => buf.includes("<message") && buf.includes("</message>"),
      20000
    );
    const match = reply.match(/<body[^>]*>([\s\S]*?)<\/body>/);
    return match ? match[1] : reply;
  } finally {
    try {
      await send("</stream:stream>");
    } catch (_) {}
    try {
      writer.releaseLock();
    } catch (_) {}
    try {
      reader.releaseLock();
    } catch (_) {}
    try {
      await socket.close();
    } catch (_) {}
  }
}
