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

// Ambil SEMUA stanza <message> di buffer yang BENAR datang dari targetBareJid.
// Ini untuk menghindari kasus "Message Carbons" (XEP-0280): server Jabber
// menyalin balik pesan yang KITA kirim sendiri ke resource kita sendiri,
// yang kalau tidak difilter akan salah dikira "balasan" (isinya = perintah
// kita sendiri, mis. "S50.0852...1256.R#TX...", identik dengan yang dikirim).
//
// Mengembalikan array { isError, text } (bisa lebih dari satu pesan) — karena
// OkeConnect kadang kirim BERTAHAP: pesan pertama "akan diproses" (ack), lalu
// pesan kedua menyusul berisi hasil final. Kalau cuma ambil pesan pertama,
// hasil final yang menyusul tidak akan pernah tertangkap.
//
// Selain carbon-copy, ada kemungkinan lain yang tampilannya mirip: server
// Jabber memantulkan balik (bounce) pesan kita sendiri sebagai stanza
// <message type="error">, biasanya kalau JID tujuan tidak valid/tidak bisa
// dihubungi. Isi bounce ini SAMA PERSIS dengan pesan yang kita kirim (echo),
// dan "from"-nya pun tetap JID tujuan — jadi lolos filter "from" di atas —
// padahal itu tandanya pesan GAGAL terkirim ke OkeConnect, bukan balasan sukses.
function extractAllReplies(buffer, targetBareJid) {
  const regex = /<message\b([^>]*)>([\s\S]*?)<\/message>/g;
  const out = [];
  let m;
  while ((m = regex.exec(buffer))) {
    const attrs = m[1];
    const inner = m[2];
    const fromMatch = attrs.match(/from=["']([^"']+)["']/);
    if (!fromMatch) continue;
    const fromBare = fromMatch[1].split("/")[0];
    if (fromBare.toLowerCase() !== targetBareJid.toLowerCase()) continue; // bukan dari OkeConnect — kemungkinan carbon-copy diri sendiri, abaikan
    const isError = /type=["']error["']/.test(attrs);
    const bodyMatch = inner.match(/<body[^>]*>([\s\S]*?)<\/body>/);
    if (isError) {
      const errCondMatch = inner.match(/<error[^>]*>[\s\S]*?<([a-z0-9-]+)\s+xmlns=["']urn:ietf:params:xml:ns:xmpp-stanzas["']/i);
      out.push({
        isError: true,
        text:
          "Pesan DITOLAK/DIPANTULKAN server (bukan balasan asli OkeConnect)" +
          (errCondMatch ? ` — kondisi: ${errCondMatch[1]}` : "") +
          (bodyMatch ? ` — isi pesan yang dipantulkan: ${bodyMatch[1]}` : ""),
      });
    } else {
      out.push({ isError: false, text: bodyMatch ? bodyMatch[1] : inner });
    }
  }
  return out;
}

// Kata kunci yang menandakan balasan FINAL (bukan sekadar tanda terima
// "akan diproses"/"sedang diproses"). Kalau balasan yang masuk cuma ack,
// kita TERUS mendengarkan sampai dapat salah satu kata kunci ini atau waktu habis.
const FINAL_REPLY_KEYWORDS = /sukses|berhasil|gagal|\berror\b|ditolak|dibatalkan|invalid|salah pin|saldo tidak cukup/i;

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

// Sama seperti readUntil, tapi khusus menunggu balasan transaksi: kalau pesan
// yang masuk baru berupa ack ("akan diproses"), JANGAN berhenti — terus dengar
// sampai ada pesan yang mengandung kata kunci final, atau waktu benar-benar habis.
// Kalau waktu habis dan yang ada cuma ack, tetap kembalikan ack itu (lebih baik
// daripada tidak ada informasi apa pun) sambil biarkan cron checkPendingOrders
// menyusuri hasil aslinya nanti.
async function waitForFinalReply(reader, targetBareJid, timeoutMs = 25000) {
  let buffer = "";
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
    ]);
    if (done) break;
    if (value === undefined) continue;
    buffer += decoder.decode(value, { stream: true });
    const replies = extractAllReplies(buffer, targetBareJid);
    if (replies.length) {
      latest = replies[replies.length - 1];
      if (latest.isError || FINAL_REPLY_KEYWORDS.test(latest.text)) {
        return latest; // ini sudah hasil final (atau bounce/error), berhenti sekarang
      }
      // else: baru ack "akan diproses" — lanjut dengar, mungkin ada balasan susulan
    }
  }
  if (latest) return latest; // waktu habis, tapi setidaknya ada balasan (walau cuma ack)
  throw new Error(`Timeout menunggu balasan XMPP dari ${targetBareJid}, tidak ada pesan apa pun diterima`);
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

    // 6. Tunggu balasan <message> yang BENAR datang dari OkeConnect DAN benar-benar
    // final (bukan cuma ack "akan diproses") — bukan echo/carbon-copy dari pesan
    // kita sendiri, dan bukan stanza error/bounce.
    const targetBareJid = to.split("/")[0];
    const parsed = await waitForFinalReply(reader, targetBareJid, 25000);
    if (parsed.isError) {
      throw new Error(parsed.text);
    }
    return parsed.text;
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
