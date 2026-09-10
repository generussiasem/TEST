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

// Cari stanza <message> di buffer yang BENAR datang dari targetBareJid.
// Ini untuk menghindari kasus "Message Carbons" (XEP-0280): server Jabber
// menyalin balik pesan yang KITA kirim sendiri ke resource kita sendiri,
// yang kalau tidak difilter akan salah dikira "balasan" (isinya = perintah
// kita sendiri, mis. "S50.0852...1256.R#TX...", identik dengan yang dikirim).
function extractReplyFrom(buffer, targetBareJid) {
  const regex = /<message\b([^>]*)>([\s\S]*?)<\/message>/g;
  let m;
  while ((m = regex.exec(buffer))) {
    const attrs = m[1];
    const inner = m[2];
    const fromMatch = attrs.match(/from=["']([^"']+)["']/);
    if (!fromMatch) continue;
    const fromBare = fromMatch[1].split("/")[0];
    if (fromBare.toLowerCase() !== targetBareJid.toLowerCase()) continue; // bukan dari OkeConnect — kemungkinan carbon-copy diri sendiri, abaikan
    const bodyMatch = inner.match(/<body[^>]*>([\s\S]*?)<\/body>/);
    return bodyMatch ? bodyMatch[1] : inner;
  }
  return null;
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

    // 2. Upgrade koneksi ke TLS (didukung TCP Socket API Cloudflare Workers).
    // PENTING: lock writer/reader lama WAJIB dilepas SEBELUM memanggil startTls(),
    // bukan sesudahnya — urutan terbalik inilah yang tadinya menyebabkan error
    // "This WritableStream is currently locked to a writer".
    writer.releaseLock();
    reader.releaseLock();
    const tlsSocket = socket.startTls();
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
    // Resource unik per koneksi — kalau dihardcode sama terus (mis. selalu
    // "kasir-worker"), dua percobaan yang tumpang tindih (retry manual, cron,
    // atau sisa koneksi yang belum bersih ditutup) akan saling tendang dengan
    // error "Replaced by new connection" dari server XMPP.
    const resourceId = "kasir-worker-" + Math.random().toString(36).slice(2, 8);
    await send(
      `<iq type="set" id="bind1"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind">` +
        `<resource>${resourceId}</resource></bind></iq>`
    );
    await readUntil(reader, (buf) => buf.includes("bind1"));

    // 4b. Buka sesi (beberapa server XMPP lama/ejabberd masih mengharuskan ini)
    // dan umumkan status online lewat <presence/> — TANPA ini, beberapa bot
    // Jabber (termasuk kemungkinan OkeConnect) diam saja dan tidak membalas
    // pesan dari JID yang belum "online", walau pesan diterima secara teknis.
    await send(
      `<iq type="set" id="sess1"><session xmlns="urn:ietf:params:xml:ns:xmpp-session"/></iq>`
    );
    try {
      await readUntil(reader, (buf) => buf.includes("sess1"), 5000);
    } catch (_) {
      // Server modern (RFC 6120) sudah tidak mewajibkan session, boleh diabaikan.
    }
    await send(`<presence/>`);

    // 4c. Matikan Message Carbons (XEP-0280) kalau server mendukungnya — supaya
    // server tidak mengirim balik salinan pesan kita sendiri ke resource ini,
    // yang tadinya salah dikira "balasan" dari OkeConnect.
    await send(
      `<iq type="set" id="carboff1"><disable xmlns="urn:xmpp:carbons:2"/></iq>`
    );
    try {
      await readUntil(reader, (buf) => buf.includes("carboff1"), 3000);
    } catch (_) {
      // Server tidak dukung Carbons — tidak masalah, filter "from" di bawah tetap jaga-jaga.
    }

    // 5. Kirim perintah transaksi sebagai stanza <message>
    const msgId = "trx-" + Date.now();
    await send(
      `<message id="${msgId}" to="${xmlEscape(to)}" type="chat">` +
        `<body>${xmlEscape(body)}</body></message>`
    );

    // 6. Tunggu balasan <message> yang BENAR datang dari OkeConnect (bukan
    // echo/carbon-copy dari pesan kita sendiri)
    const targetBareJid = to.split("/")[0];
    const reply = await readUntil(
      reader,
      (buf) => extractReplyFrom(buf, targetBareJid) !== null,
      20000
    );
    const replyBody = extractReplyFrom(reply, targetBareJid);
    return replyBody !== null ? replyBody : reply;
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
