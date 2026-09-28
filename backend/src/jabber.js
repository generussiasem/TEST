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

// Ambil SEMUA stanza <message> di buffer yang BENAR datang dari targetBareJid
// DAN benar-benar menjawab ref_id yang kita kirim (expectedRefToken).
// Ini untuk menghindari 2 sumber salah-tangkap:
//   1) "Message Carbons" (XEP-0280): server Jabber menyalin balik pesan KITA
//      sendiri ke resource kita sendiri.
//   2) BALASAN TRANSAKSI LAIN NYASAR: kalau ada permintaan lain yang jalan
//      berdekatan waktu (mis. cron checkPendingOrders memproses order lama
//      sementara kita cek transaksi baru), balasan untuk request LAIN bisa
//      "tertangkap" sebagai balasan kita — padahal isinya sama sekali beda
//      ref_id. OkeConnect SELALU menyertakan ref_id (R#...) yang kita kirim
//      di dalam balasannya, jadi kita wajib cocokkan itu sebelum menerima
//      suatu <message> sebagai jawaban kita.
//
// Mengembalikan array { isError, text } (bisa lebih dari satu pesan) — karena
// OkeConnect kadang kirim BERTAHAP: pesan pertama "akan diproses" (ack), lalu
// pesan kedua menyusul berisi hasil final. Kalau cuma ambil pesan pertama,
// hasil final yang menyusul tidak akan pernah tertangkap.
//
// Selain carbon-copy, ada kemungkinan lain yang tampilannya mirip: server
// Jabber memantulkan balik (bounce) pesan kita sendiri sebagai stanza
// <message type="error">, biasanya kalau JID tujuan tidak valid/tidak bisa
// dihubungi. Isi bounce ini SAMA PERSIS dengan pesan yang kita kirim (echo,
// jadi otomatis mengandung ref_id kita sendiri juga — tetap lolos filter ini),
// dan "from"-nya pun tetap JID tujuan — padahal itu tandanya pesan GAGAL
// terkirim ke OkeConnect, bukan balasan sukses.
// acceptAnyFromTarget: khusus provider yang balasannya SAMA SEKALI TIDAK bisa
// dicocokkan ke transaksi tertentu (tidak ada ref id maupun prefix yang
// diulang di semua kasus — mis. balasan GAGAL portalpulsa "PIN xxx Salah."
// tidak mengutip perintah apapun). Kalau true, balasan dari target yang benar
// tetap diterima walau ref/prefix tidak cocok — RESIKO: kalau ada transaksi
// LAIN ke provider yang sama berjalan bersamaan (dua sesi Worker paralel),
// balasannya bisa "ketuker". Mitigasi jangka pendek: jangan jalankan dua
// transaksi portalpulsa bersamaan. Mitigasi jangka panjang: butuh queue/lock
// per provider di level database (belum diimplementasikan).
function extractAllReplies(buffer, targetBareJid, expectedRefToken, expectedPrefix, acceptAnyFromTarget = false) {
  // expectedRefToken boleh satu string atau daftar token (balasan diterima kalau
  // memuat SALAH SATU). Daftar dipakai untuk perintah cek status berformat
  // "CEK.NOMOR" yang balasannya belum tentu memuat ref order.
  const expectedTokens = [].concat(expectedRefToken || []).filter(Boolean);
  const regex = /<message\b([^>]*)>([\s\S]*?)<\/message>/g;
  const out = [];
  let m;
  while ((m = regex.exec(buffer))) {
    const attrs = m[1];
    const inner = m[2];
    const fromMatch = attrs.match(/from=["']([^"']+)["']/);
    // DIAGNOSTIK SEMENTARA: catat SETIAP stanza <message> yang lewat di buffer,
    // cocok filter atau tidak — supaya kalau macet lagi, wrangler tail bisa
    // menunjukkan apa SEBENARNYA yang diterima dari server (from-nya siapa,
    // isinya apa), bukan cuma "timeout, tidak ada yang cocok". Hapus log ini
    // kalau sudah tidak dibutuhkan lagi.
    console.log(
      "[jabber-debug] stanza <message> masuk — attrs:",
      attrs,
      "| body:",
      (inner.match(/<body[^>]*>([\s\S]*?)<\/body>/) || [])[1] || inner.slice(0, 200)
    );
    if (!fromMatch) continue;
    const fromBare = fromMatch[1].split("/")[0];
    if (fromBare.toLowerCase() !== targetBareJid.toLowerCase()) {
      console.log(
        `[jabber-debug] diabaikan: from="${fromBare}" tidak sama dengan target yang ditunggu "${targetBareJid}"`
      );
      continue; // bukan dari OkeConnect — kemungkinan carbon-copy diri sendiri, abaikan
    }
    const isError = /type=["']error["']/.test(attrs);
    const bodyMatch = inner.match(/<body[^>]*>([\s\S]*?)<\/body>/);
    const text = bodyMatch ? bodyMatch[1] : inner;
    // Beberapa balasan GAGAL langsung (mis. "saldo kurang") dari OkeConnect
    // TIDAK menyertakan ref ID (R#...) sama sekali — cuma "KODE.NOMOR GAGAL...".
    // Ref token tetap dicek DULU (paling akurat), tapi kalau tidak ketemu,
    // terima juga kalau body diawali persis KODE.NOMOR yang barusan kita
    // kirim (expectedPrefix) — jauh lebih spesifik daripada asal terima semua
    // balasan dari target yang sama, jadi resiko "ketuker" transaksi lain yang
    // kebetulan jalan bersamaan tetap kecil.
    const matchesRef = expectedTokens.some((t) => text.includes(t));
    const matchesPrefix = expectedPrefix && text.startsWith(expectedPrefix);
    if (!isError && expectedTokens.length && !matchesRef && !matchesPrefix) {
      if (acceptAnyFromTarget) {
        console.log(
          `[jabber-debug] ref/prefix tidak cocok TAPI acceptAnyFromTarget aktif (provider tanpa ref id) — diterima apa adanya, resiko ketuker kalau ada transaksi lain jalan bersamaan. Isi: ${text.slice(0, 200)}`
        );
      } else {
        console.log(
          `[jabber-debug] diabaikan: body tidak mengandung token "${expectedTokens.join(" / ")}" maupun prefix "${expectedPrefix}" — kemungkinan balasan transaksi lain. Isi: ${text.slice(0, 200)}`
        );
        continue; // balasan ini untuk transaksi/permintaan LAIN — bukan punya kita, abaikan
      }
    }
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
      out.push({ isError: false, text });
    }
  }
  return out;
}

// Kata kunci yang menandakan balasan FINAL (bukan sekadar tanda terima
// "akan diproses"/"sedang diproses"). Kalau balasan yang masuk cuma ack,
// kita TERUS mendengarkan sampai dapat salah satu kata kunci ini atau waktu habis.
// "\btransfer\b" ditambah khusus deposit portalpulsa — balasan finalnya
// "Silakan transfer Rp ... Ke Bank: ..." tidak mengandung sukses/gagal.
const FINAL_REPLY_KEYWORDS = /sukses|berhasil|gagal|\berror\b|ditolak|dibatalkan|invalid|salah pin|\bsalah\b|saldo tidak cukup|\btransfer\b/i;

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
// firstReplyIsFinal: dipakai untuk perintah non-transaksi (mis. "Saldo.PIN")
// yang balasannya TIDAK mengandung kata kunci final seperti "sukses"/"gagal"
// (lihat FINAL_REPLY_KEYWORDS) — kalau tidak diberi jalur ini, fungsi akan
// menunggu penuh sampai timeout tiap kali dipanggil walau balasan yang benar
// sudah masuk dari detik pertama, karena tidak pernah cocok kata kunci apapun.
async function waitForFinalReply(reader, targetBareJid, expectedRefToken, expectedPrefix, timeoutMs = 25000, firstReplyIsFinal = false, acceptAnyFromTarget = false) {
  let buffer = "";
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  const historySeen = []; // semua balasan.text yang lewat sebelum final (buat collectHistory)
  const seenTexts = new Set();
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
    ]);
    if (done) break;
    if (value === undefined) continue;
    buffer += decoder.decode(value, { stream: true });
    const replies = extractAllReplies(buffer, targetBareJid, expectedRefToken, expectedPrefix, acceptAnyFromTarget);
    for (const r of replies) {
      if (!seenTexts.has(r.text)) {
        seenTexts.add(r.text);
        historySeen.push(r.text);
      }
    }
    if (replies.length) {
      latest = replies[replies.length - 1];
      if (latest.isError || firstReplyIsFinal || FINAL_REPLY_KEYWORDS.test(latest.text)) {
        return { ...latest, history: historySeen }; // ini sudah hasil final (atau bounce/error), berhenti sekarang
      }
      // else: baru ack "akan diproses" — lanjut dengar, mungkin ada balasan susulan
    }
  }
  if (latest) return { ...latest, history: historySeen }; // waktu habis, tapi setidaknya ada balasan (walau cuma ack)
  // DIAGNOSTIK SEMENTARA: sertakan cuplikan buffer mentah (300 char terakhir)
  // di pesan error, supaya kelihatan di log/console apakah stream benar-benar
  // kosong (server sama sekali tidak kirim apa-apa) atau ada sesuatu masuk
  // tapi bukan berupa <message> (mis. cuma whitespace keep-alive, atau iq lain).
  console.log("[jabber-debug] TIMEOUT — buffer mentah 300 char terakhir:", buffer.slice(-300) || "(buffer kosong sama sekali)");
  const tokenLabel = [].concat(expectedRefToken || []).join(" / ") || "(tanpa token)";
  throw new Error(`Timeout menunggu balasan XMPP dari ${targetBareJid} untuk ref ${tokenLabel}, tidak ada pesan yang cocok diterima`);
}

/**
 * Kirim satu perintah teks ke Jabber Center OkeConnect dan tunggu balasannya.
 * @param {object} opts
 * @param {string} opts.jid       - JID lengkap Anda, mis. "OK310547@gojabber.com"
 * @param {string} opts.password  - password akun OrderKuota Anda
 * @param {string} opts.to        - tujuan pesan, mis. "okeconnect@gojabber.com"
 * @param {string} opts.body      - isi perintah, mis. "TSEL5.081234.PIN.R#REF123"
 * @param {boolean} [opts.firstReplyIsFinal] - anggap balasan PERTAMA yang cocok
 *   dari target sebagai final, walau tidak mengandung kata kunci "sukses/gagal"
 *   dst. Dipakai untuk perintah non-transaksi seperti cek saldo ("Saldo.PIN"),
 *   supaya tidak menunggu penuh sampai timeout tiap kali dipanggil.
 * @param {string} [opts.refSeparator] - pemisah antar-segmen body dipakai untuk
 *   membangun expectedPrefix fallback (default "."; portalpulsa pakai " " karena
 *   formatnya "kode target pin" tanpa titik).
 * @param {boolean} [opts.acceptAnyFromTarget] - lihat catatan di extractAllReplies;
 *   dipakai untuk provider tanpa ref id sama sekali (portalpulsa).
 */
/**
 * Login & siapkan sesi Jabber siap pakai (buka stream, STARTTLS, SASL auth,
 * bind resource, presence, matikan Carbons). Dipakai bersama oleh
 * sendJabberCommand (kirim command, tunggu balasan) dan listenJabberMessages
 * (TIDAK kirim apa-apa, cuma dengerin pesan masuk — dipakai buat balasan
 * susulan deposit portalpulsa yang datangnya belakangan tanpa dipicu command).
 * Caller WAJIB memanggil `cleanup()` di finally-nya sendiri.
 */
async function loginJabberSession(jid, password) {
  const [localpart, jabberHost] = jid.split("@");
  // secureTransport: "starttls" WAJIB disebut di sini kalau nanti mau panggil
  // socket.startTls() — API TCP Socket Cloudflare menolak startTls() kalau socket
  // dibuat tanpa opsi ini dari awal (persis error yang bikin order selalu pending).
  const socket = connect({ hostname: jabberHost, port: JABBER_PORT }, { secureTransport: "starttls" });
  let writer = socket.writable.getWriter();
  let reader = socket.readable.getReader();
  const send = (xml) => writer.write(new TextEncoder().encode(xml));

  // 1. Buka stream & minta STARTTLS
  await send(
    `<?xml version="1.0"?><stream:stream to="${jabberHost}" xmlns="jabber:client" ` +
      `xmlns:stream="http://etherx.jabber.org/streams" version="1.0">`
  );
  await readUntil(reader, (buf) => buf.includes("<starttls"));
  await send(`<starttls xmlns="urn:ietf:params:xml:ns:xmpp-tls"/>`);
  await readUntil(reader, (buf) => buf.includes("<proceed"));

  // 2. Upgrade koneksi ke TLS. PENTING: lock writer/reader lama WAJIB dilepas
  // SEBELUM memanggil startTls(), bukan sesudahnya.
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
  await send(`<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="PLAIN">${authToken}</auth>`);
  const authReply = await readUntil(reader, (buf) => buf.includes("<success") || buf.includes("<failure"));
  if (authReply.includes("<failure")) {
    throw new Error("Login Jabber gagal — cek JID/password.");
  }

  // 4. Bind resource & buka sesi
  await send(
    `<?xml version="1.0"?><stream:stream to="${jabberHost}" xmlns="jabber:client" ` +
      `xmlns:stream="http://etherx.jabber.org/streams" version="1.0">`
  );
  await readUntil(reader, (buf) => buf.includes("</stream:features>"));
  // Resource unik per koneksi — kalau dihardcode sama terus, dua percobaan yang
  // tumpang tindih (retry manual, cron, atau sisa koneksi yang belum bersih
  // ditutup) akan saling tendang dengan error "Replaced by new connection".
  const resourceId = "kasir-worker-" + Math.random().toString(36).slice(2, 8);
  await send(`<iq type="set" id="bind1"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><resource>${resourceId}</resource></bind></iq>`);
  await readUntil(reader, (buf) => buf.includes("bind1"));

  // 4b. Buka sesi (beberapa server XMPP lama/ejabberd masih mengharuskan ini)
  // dan umumkan status online — TANPA ini, beberapa bot Jabber diam saja.
  await send(`<iq type="set" id="sess1"><session xmlns="urn:ietf:params:xml:ns:xmpp-session"/></iq>`);
  try {
    await readUntil(reader, (buf) => buf.includes("sess1"), 5000);
  } catch (_) {
    // Server modern (RFC 6120) sudah tidak mewajibkan session, boleh diabaikan.
  }
  // PRIORITY 127 (maksimum): supaya balasan diteruskan ke resource sesi ini,
  // bukan ke sesi lain yang kebetulan sama-sama login (klien lain, cron lain).
  await send(`<presence><priority>127</priority></presence>`);

  // 4c. Matikan Message Carbons (XEP-0280) kalau server mendukungnya.
  await send(`<iq type="set" id="carboff1"><disable xmlns="urn:xmpp:carbons:2"/></iq>`);
  try {
    await readUntil(reader, (buf) => buf.includes("carboff1"), 3000);
  } catch (_) {
    // Server tidak dukung Carbons — tidak masalah, filter "from" tetap jaga-jaga.
  }

  const cleanup = async () => {
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
  };
  return { reader, writer, send, cleanup };
}

/**
 * Login ke Jabber lalu DENGERIN PASIF — tidak mengirim command apa pun,
 * cuma menunggu & mengumpulkan pesan yang masuk dari `to` selama `timeoutMs`.
 *
 * Dipakai KHUSUS untuk balasan susulan deposit portalpulsa (SUKSES/DIBATALKAN)
 * yang datang belakangan, TIDAK dipicu oleh command yang baru dikirim — beda
 * dari sendJabberCommand yang menunggu balasan atas command yang BARU dikirim.
 * Re-mengirim ulang command "D BANK NOMINAL PIN" untuk "cek status" BERBAHAYA
 * (bisa kebaca provider sebagai permintaan deposit baru), jadi satu-satunya
 * cara aman adalah menunggu pasif seperti ini secara berkala (lihat
 * checkPendingPortalpulsaDeposits di index.js).
 *
 * @returns {Promise<string[]>} daftar teks pesan yang masuk dari `to` selama sesi ini (bisa kosong)
 */
export async function listenJabberMessages({ jid, password, to, timeoutMs = 20000 }) {
  const session = await loginJabberSession(jid, password);
  const { reader, cleanup } = session;
  const targetBareJid = to.split("/")[0];
  try {
    let buffer = "";
    const decoder = new TextDecoder();
    const deadline = Date.now() + timeoutMs;
    const seen = [];
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
      ]);
      if (done) break;
      if (value === undefined) continue;
      buffer += decoder.decode(value, { stream: true });
      // acceptAnyFromTarget=true, tanpa expectedRefToken/expectedPrefix — kita
      // memang sengaja mau SEMUA pesan dari target, bukan mencocokkan ref
      // tertentu (portalpulsa tidak pernah menyebut ref di balasan deposit).
      seen.push(...extractAllReplies(buffer, targetBareJid, null, null, true).map((r) => r.text));
    }
    // Dedup — extractAllReplies dipanggil berulang atas buffer yang terus
    // bertambah, jadi pesan yang sama bisa muncul lagi di panggilan berikutnya.
    return [...new Set(seen)];
  } finally {
    await cleanup();
  }
}

/**
 * Kirim satu perintah teks ke Jabber Center OkeConnect dan tunggu balasannya.
 * @param {object} opts
 * @param {string} opts.jid       - JID lengkap Anda, mis. "OK310547@gojabber.com"
 * @param {string} opts.password  - password akun OrderKuota Anda
 * @param {string} opts.to        - tujuan pesan, mis. "okeconnect@gojabber.com"
 * @param {string} opts.body      - isi perintah, mis. "TSEL5.081234.PIN.R#REF123"
 * @param {boolean} [opts.firstReplyIsFinal] - anggap balasan PERTAMA yang cocok
 *   dari target sebagai final, walau tidak mengandung kata kunci "sukses/gagal"
 *   dst. Dipakai untuk perintah non-transaksi seperti cek saldo ("Saldo.PIN"),
 *   supaya tidak menunggu penuh sampai timeout tiap kali dipanggil.
 * @param {string} [opts.refSeparator] - pemisah antar-segmen body dipakai untuk
 *   membangun expectedPrefix fallback (default "."; portalpulsa pakai " " karena
 *   formatnya "kode target pin" tanpa titik).
 * @param {boolean} [opts.acceptAnyFromTarget] - lihat catatan di extractAllReplies;
 *   dipakai untuk provider tanpa ref id sama sekali (portalpulsa).
 * @param {boolean} [opts.collectHistory] - kalau true, kembalikan
 *   { text, history } alih-alih string biasa — `history` berisi SEMUA balasan
 *   yang masuk selama sesi ini (termasuk ack tahap-1 sebelum balasan final),
 *   digabung urut. Dipakai untuk deposit portalpulsa, supaya ack "Telah kami
 *   terima..." ikut tersimpan, bukan cuma balasan instruksi transfer di
 *   tahap 2 (lihat kirimDepositPortalpulsa di ppob.js).
 */
export async function sendJabberCommand({
  jid,
  password,
  to,
  body,
  firstReplyIsFinal = false,
  expectTokens = null,
  refSeparator = ".",
  acceptAnyFromTarget = false,
  collectHistory = false,
}) {
  const session = await loginJabberSession(jid, password);
  const { reader, send, cleanup } = session;

  try {
    const msgId = "trx-" + Date.now();
    console.log(`[jabber-debug] mengirim ke "${to}" — body: ${body}`);
    await send(
      `<message id="${msgId}" to="${xmlEscape(to)}" type="chat">` +
        `<body>${xmlEscape(body)}</body></message>`
    );

    // 6. Tunggu balasan <message> yang BENAR datang dari OkeConnect DAN benar-benar
    // final (bukan cuma ack "akan diproses") — bukan echo/carbon-copy dari pesan
    // kita sendiri, bukan stanza error/bounce, DAN benar-benar menjawab ref_id
    // yang barusan kita kirim (bukan balasan transaksi lain yang nyasar).
    const targetBareJid = to.split("/")[0];
    const refTokenMatch = body.match(/R#([A-Za-z0-9]+)/);
    // expectTokens (opsional) menggantikan token R# dari body — dipakai perintah
    // cek status "CEK.NOMOR" yang tidak mengandung R# di body-nya.
    const expectedRefToken = expectTokens && expectTokens.length ? expectTokens : refTokenMatch ? refTokenMatch[1] : null;
    // Fallback kalau balasan tidak menyertakan ref ID (mis. gagal langsung
    // karena saldo kurang) — "KODE.NOMOR" adalah dua segmen pertama body kita
    // sendiri (format semua provider di ppob.js: KODE.NOMOR.PIN[...]), dan
    // OkeConnect selalu mengulang persis "KODE.NOMOR" di awal balasannya.
    const bodySegments = body.split(refSeparator);
    const expectedPrefix = bodySegments.length >= 2 ? `${bodySegments[0]}${refSeparator}${bodySegments[1]}` : null;
    const parsed = await waitForFinalReply(reader, targetBareJid, expectedRefToken, expectedPrefix, 25000, firstReplyIsFinal, acceptAnyFromTarget);
    if (parsed.isError) {
      throw new Error(parsed.text);
    }
    if (collectHistory) {
      // history sudah termasuk parsed.text di dalamnya (lihat waitForFinalReply)
      return { text: parsed.text, history: parsed.history };
    }
    return parsed.text;
  } finally {
    await cleanup();
  }
}
