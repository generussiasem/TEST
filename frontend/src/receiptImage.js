// ---------------------------------------------------------------------------
// Membuat gambar struk (PNG) dari data transaksi, lalu bisa dibagikan lewat
// aplikasi apa pun (WhatsApp, dsb) via Web Share API, atau diunduh sebagai
// fallback di browser/perangkat yang belum mendukungnya.
//
// Dipakai bersama oleh Kasir.vue, Ppob.vue, dan PpobTagihan.vue — supaya
// tampilan strukdi ketiga tempat itu konsisten satu style.
// ---------------------------------------------------------------------------

// 384px adalah standar baku lebar cetak printer thermal 58mm (area cetak
// sebenarnya ~48mm dari lebar kertas 58mm, pada resolusi 203dpi/8 dot per mm).
// Hampir semua aplikasi/driver printer thermal 58mm (RawBT, printer Bluetooth
// kasir, dst) mengenali lebar ini secara langsung — gambar dibuat PERSIS
// 384px, tanpa supersampling, supaya ukurannya cocok apa adanya.
const LEBAR = 384;
const PAD = 18;

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Gambar struk ke canvas lalu kembalikan sebagai Blob PNG.
 *
 * @param {Object} data
 * @param {string} data.storeName
 * @param {string} [data.address]
 * @param {string} data.date - sudah diformat, mis. "22/09/2026 14.05"
 * @param {string} [data.judul] - default "STRUK BELANJA"
 * @param {{label: string, qty?: number, amount: number}[]} data.items
 * @param {number} data.total
 * @param {string[]} [data.catatan] - baris tambahan setelah total (mis. info utang/titipan)
 * @param {string} [data.footer] - default "Terima kasih!"
 * @returns {Promise<Blob>}
 */
export function buatStrukPNG(data) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const w = LEBAR;
  const pad = PAD;
  const contentW = w - pad * 2;

  // --- Pass 1: hitung dulu tinggi total (font harus di-set sebelum measureText) ---
  const measure = document.createElement("canvas").getContext("2d");
  let y = pad;
  const lineH = 15;
  const gap = 4;

  measure.font = `bold ${16}px "Courier New", monospace`;
  y += lineH * 1.3; // nama toko

  measure.font = `${12}px "Courier New", monospace`;
  const alamatLines = data.address ? wrapText(measure, data.address, contentW) : [];
  y += alamatLines.length * lineH + (data.address ? gap : 0);
  y += lineH; // tanggal
  y += gap * 2;
  y += 1; // garis
  y += gap * 2;

  measure.font = `bold ${13}px "Courier New", monospace`;
  y += lineH * 1.4; // judul

  measure.font = `${12.5}px "Courier New", monospace`;
  const itemLineInfo = data.items.map((it) => {
    const label = it.qty ? `${it.label} x${it.qty}` : it.label;
    const lines = wrapText(measure, label, contentW - 90);
    return { lines, amount: it.amount };
  });
  for (const it of itemLineInfo) y += Math.max(1, it.lines.length) * lineH;
  y += gap * 2;
  y += 1;
  y += gap * 2;

  measure.font = `bold ${14}px "Courier New", monospace`;
  y += lineH * 1.3; // total

  measure.font = `${12}px "Courier New", monospace`;
  const catatanLines = (data.catatan || []).flatMap((c) => wrapText(measure, c, contentW));
  if (catatanLines.length) y += gap;
  y += catatanLines.length * lineH;

  y += gap * 3;
  y += 1;
  y += gap * 2;
  measure.font = `${12.5}px "Courier New", monospace`;
  y += lineH * 1.2; // footer
  y += pad;

  // --- Pass 2: gambar sungguhan di canvas ukuran pas ---
  canvas.width = w;
  canvas.height = Math.ceil(y);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#1a1a1a";
  ctx.textBaseline = "top";

  const center = (text, cy, font) => {
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.fillText(text, w / 2, cy);
    ctx.textAlign = "left";
  };
  const hr = (cy) => {
    ctx.strokeStyle = "#1a1a1a";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(pad, cy);
    ctx.lineTo(w - pad, cy);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const rowKanan = (text, cy, font) => {
    ctx.font = font;
    ctx.textAlign = "right";
    ctx.fillText(text, w - pad, cy);
    ctx.textAlign = "left";
  };

  y = pad;
  center(data.storeName || "Toko", y, `bold ${16}px "Courier New", monospace`);
  y += lineH * 1.3;

  ctx.font = `${12}px "Courier New", monospace`;
  if (data.address) {
    for (const l of alamatLines) {
      center(l, y, ctx.font);
      y += lineH;
    }
    y += gap;
  }
  center(data.date, y, ctx.font);
  y += lineH + gap * 2;
  hr(y);
  y += gap * 2;

  center(data.judul || "STRUK BELANJA", y, `bold ${13}px "Courier New", monospace`);
  y += lineH * 1.4;

  ctx.font = `${12.5}px "Courier New", monospace`;
  for (const it of itemLineInfo) {
    const startY = y;
    for (const l of it.lines) {
      ctx.fillText(l, pad, y);
      y += lineH;
    }
    rowKanan(rupiah(it.amount), startY, ctx.font);
    y = Math.max(y, startY + lineH);
  }
  y += gap * 2;
  hr(y);
  y += gap * 2;

  ctx.font = `bold ${14}px "Courier New", monospace`;
  ctx.fillText("TOTAL", pad, y);
  rowKanan(rupiah(data.total), y, ctx.font);
  y += lineH * 1.3;

  if (catatanLines.length) {
    y += gap;
    ctx.font = `${12}px "Courier New", monospace`;
    for (const l of catatanLines) {
      ctx.fillText(l, pad, y);
      y += lineH;
    }
  }

  y += gap * 3;
  hr(y);
  y += gap * 2;
  center(data.footer || "Terima kasih!", y, `${12.5}px "Courier New", monospace`);

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png", 1));
}

/**
 * Unduh blob sebagai file — SELALU lewat unduhan langsung, tidak lewat menu
 * bagikan. Dipakai saat pengguna memang mau "tinggal download", bukan
 * memilih ke aplikasi mana harus dikirim.
 */
export function unduhGambar(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Bagikan blob gambar lewat Web Share API (kalau perangkat/browser mendukung
 * share file — kebanyakan HP Android/iOS modern). Kalau tidak didukung,
 * otomatis diunduh sebagai file PNG sebagai jalan keluar.
 * Mengembalikan "shared" | "downloaded" | "cancelled".
 */

// ---------------------------------------------------------------------------
// STRUK KHUSUS TOKEN LISTRIK PLN PRABAYAR
//
// Meniru struk resmi (ID PLGN, PRODUK, NAMA, TARIF DAYA, JUMLAH DAYA, HARGA,
// Serial Number) ditambah NAMA TOKO & ALAMAT di bagian atas — dua hal yang
// tidak ada di struk bawaan provider/pihak ketiga. Nama pelanggan, tarif,
// dan KWH diambil dari balasan asli OkeConnect (raw_reply), bukan diketik
// manual, supaya tidak salah ketik.
// ---------------------------------------------------------------------------

/**
 * Ambil NAMA/TARIF/DAYA/KWH & kode token dari balasan asli OkeConnect.
 * Contoh balasan yang dikenali:
 *   "...SUKSES. SN: 6504-3671-8820-3316-2161/MUCHAMAR EFENDI/R1M/900VA/67.30 KWH. Saldo..."
 * Kalau formatnya beda (provider lain / balasan tidak lengkap), bagian yang
 * tidak ketemu dikembalikan sebagai null — struk tetap dibuat tanpa baris itu,
 * bukan error.
 */
export function parseStrukTokenPLN(rawReply) {
  const text = String(rawReply || "");
  const hasil = { denom: null, token: null, nama: null, tarif: null, daya: null, kwh: null };

  // "SN: TOKEN/NAMA/TARIF/DAYA/KWH KWH" — bagian setelah token adalah info
  // pelanggan dari PLN, dipisah garis miring.
  const snMatch = text.match(/SN\s*:?\s*([\d-]{10,})\s*\/\s*([^/]+?)\s*\/\s*([A-Za-z0-9]+)\s*\/\s*([A-Za-z0-9.]+)\s*\/\s*([\d.,]+)\s*KWH/i);
  if (snMatch) {
    hasil.token = snMatch[1];
    hasil.nama = snMatch[2].trim();
    hasil.tarif = snMatch[3].trim();
    hasil.daya = snMatch[4].trim();
    hasil.kwh = snMatch[5].trim();
  } else {
    // Fallback: token saja tanpa rincian tambahan (mis. balasan provider lain)
    const tokenOnly = text.match(/SN\s*:?\s*([\d-]{10,})/i);
    if (tokenOnly) hasil.token = tokenOnly[1];
  }

  // Nominal token (harga pokok/denom), disebutkan sebelum kode produk, mis.
  // "Token PLN 100.000 PLNB100.45052088627" -> "100.000"
  const denomMatch = text.match(/Token PLN\s+([\d.,]+)\s+\S+\.\S+/i);
  if (denomMatch) hasil.denom = denomMatch[1];

  return hasil;
}

/**
 * @param {Object} d
 * @param {string} d.storeName
 * @param {string} [d.address]
 * @param {string} d.date
 * @param {string} d.idPlgn - nomor meter/ID pelanggan (target order)
 * @param {string} d.produkNama - mis. "H2H Token PLN"
 * @param {string} [d.denom] - nominal token, mis. "100.000" (tanpa "Rp")
 * @param {string} [d.nama] - nama pelanggan dari PLN (hasil parseStrukTokenPLN)
 * @param {string} [d.tarif] - mis. "R1M"
 * @param {string} [d.daya] - mis. "900VA"
 * @param {string} [d.kwh] - mis. "67.30"
 * @param {number} d.harga - total dibayar pelanggan (termasuk admin)
 * @param {string} d.sn - kode token / serial number
 * @param {string[]} [d.catatan] - baris tambahan (mis. info utang/titipan)
 * @returns {Promise<Blob>}
 */
export function buatStrukTokenPLN(d) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const w = LEBAR;
  const pad = PAD;
  const contentW = w - pad * 2;
  const lineH = 15;
  const gap = 4;
  const monoBold = (px) => `bold ${px}px "Courier New", monospace`;
  const mono = (px) => `${px}px "Courier New", monospace`;

  const rincian = [];
  rincian.push(["ID PLGN", d.idPlgn]);
  if (d.nama) rincian.push(["NAMA", d.nama]);
  if (d.tarif || d.daya) rincian.push(["TARIF DAYA", [d.tarif, d.daya].filter(Boolean).join(" - ")]);
  if (d.kwh) rincian.push(["JUMLAH DAYA", `${d.kwh} KWH`]);

  const measure = document.createElement("canvas").getContext("2d");
  const wrapAt = (text, font, maxW) => {
    measure.font = font;
    return wrapText(measure, text, maxW);
  };

  // --- Pass 1: hitung tinggi ---
  let y = pad;
  y += lineH * 1.3; // nama toko
  measure.font = mono(12);
  const alamatLines = d.address ? wrapText(measure, d.address, contentW) : [];
  y += alamatLines.length * lineH + (d.address ? gap : 0);
  y += lineH + gap * 2; // tanggal
  y += 1 + gap * 2; // garis

  measure.font = monoBold(12.5);
  const judulLines = wrapText(measure, "STRUK PEMBELIAN TOKEN LISTRIK PRABAYAR", contentW);
  y += judulLines.length * lineH * 1.15 + gap * 2;
  y += 1 + gap * 2; // garis

  measure.font = mono(12);
  y += lineH * 1.1; // "PRODUK"
  const produkLines = wrapText(measure, d.produkNama, contentW);
  y += produkLines.length * lineH;
  if (d.denom) y += lineH; // baris nominal
  y += gap;

  for (const [label] of rincian) {
    measure.font = mono(12);
    const valLines = wrapAt(String(rincian.find((r) => r[0] === label)[1]), mono(12), contentW - 10);
    y += Math.max(1, valLines.length) * lineH + gap * 0.3;
  }
  y += gap;
  y += 1 + gap * 2; // garis

  y += lineH * 1.3; // HARGA (bold)
  y += gap * 2;

  measure.font = mono(11.5);
  y += lineH; // "** Serial Number **"
  measure.font = monoBold(13.5);
  const snLines = wrapText(measure, d.sn || "-", contentW);
  y += snLines.length * lineH * 1.2 + gap;

  measure.font = mono(12);
  const catatanLines = (d.catatan || []).flatMap((c) => wrapText(measure, c, contentW));
  if (catatanLines.length) y += gap;
  y += catatanLines.length * lineH;

  y += gap * 3 + 1 + gap * 2;
  y += lineH * 1.2; // footer
  y += pad;

  // --- Pass 2: gambar ---
  canvas.width = w;
  canvas.height = Math.ceil(y);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#1a1a1a";
  ctx.textBaseline = "top";

  const center = (text, cy, font) => {
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.fillText(text, w / 2, cy);
    ctx.textAlign = "left";
  };
  const hr = (cy) => {
    ctx.strokeStyle = "#1a1a1a";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(pad, cy);
    ctx.lineTo(w - pad, cy);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  y = pad;
  center(d.storeName || "Toko", y, monoBold(16));
  y += lineH * 1.3;

  if (d.address) {
    ctx.font = mono(12);
    for (const l of alamatLines) {
      center(l, y, ctx.font);
      y += lineH;
    }
    y += gap;
  }
  center(d.date, y, mono(12));
  y += lineH + gap * 2;
  hr(y);
  y += gap * 2;

  ctx.font = monoBold(12.5);
  for (const l of judulLines) {
    center(l, y, ctx.font);
    y += lineH * 1.15;
  }
  y += gap;
  hr(y);
  y += gap * 2;

  ctx.font = mono(12);
  ctx.fillText("PRODUK", pad, y);
  y += lineH * 1.1;
  for (const l of produkLines) {
    ctx.fillText(l, pad, y);
    y += lineH;
  }
  if (d.denom) {
    ctx.fillText(d.denom, pad, y);
    y += lineH;
  }
  y += gap;

  for (const [label, value] of rincian) {
    ctx.fillText(label, pad, y);
    const valLines = wrapText(ctx, String(value), contentW - 10);
    for (const vl of valLines) {
      ctx.fillText(vl, pad, y + lineH);
      y += lineH;
    }
    y += gap * 0.3;
  }
  y += gap;
  hr(y);
  y += gap * 2;

  ctx.font = monoBold(14);
  ctx.fillText("HARGA", pad, y);
  ctx.textAlign = "right";
  ctx.fillText(rupiah(d.harga), w - pad, y);
  ctx.textAlign = "left";
  y += lineH * 1.3 + gap * 2;

  center("** Serial Number **", y, mono(11.5));
  y += lineH;
  ctx.font = monoBold(13.5);
  for (const l of snLines) {
    center(l, y, ctx.font);
    y += lineH * 1.2;
  }
  y += gap;

  if (catatanLines.length) {
    y += gap;
    ctx.font = mono(12);
    for (const l of catatanLines) {
      ctx.fillText(l, pad, y);
      y += lineH;
    }
  }

  y += gap * 3;
  hr(y);
  y += gap * 2;
  center("Terima kasih!", y, mono(12.5));

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png", 1));
}


// ---------------------------------------------------------------------------
// STRUK KHUSUS TAGIHAN LISTRIK PLN PASCABAYAR
//
// Meniru struk resmi (ID PLGN, NAMA, TARIF DAYA, BULAN, PERIODE, STAND MTR,
// TAGIHAN, ADMIN BANK, ADMIN LOKET, TOTAL BAYAR, Serial Number) ditambah NAMA
// TOKO & ALAMAT di bagian atas. Sebagian besar data diambil dari balasan asli
// OkeConnect (raw_reply), bukan diketik manual.
// ---------------------------------------------------------------------------

/**
 * Ambil rincian tagihan dari balasan asli OkeConnect untuk pembayaran
 * listrik pascabayar. Contoh balasan yang dikenali:
 *   "...SUKSES. SN: DAHURI/TAG:35214/ADMIN:4500/TTAG:39714/TARIF:R1/DAYA:900/
 *    JMLBLN:1/PERIODE:202609/MET:51986-52019/REFF:2OPT210ZEF760A46B5230EC...
 *    Saldo..."
 * Parsing ditulis generik (pisah per "/", lalu per "KEY:VALUE") supaya tetap
 * jalan walau urutan field berubah — field yang tidak ketemu dikembalikan
 * null, struk tetap dibuat tanpa baris itu, bukan error.
 */
export function parseStrukTagihanListrik(rawReply) {
  const text = String(rawReply || "");
  const hasil = {
    nama: null,
    tagihan: null,
    adminBank: null,
    totalTagihan: null,
    tarif: null,
    daya: null,
    jmlBulan: null,
    periode: null,
    standMeter: null,
    reff: null,
  };
  const blokMatch = text.match(/SN\s*:?\s*([^.]+?)\.\s*Saldo/i) || text.match(/SN\s*:?\s*([^.]+?)\.?\s*$/i);
  if (!blokMatch) return hasil;

  const parts = blokMatch[1].split("/").map((p) => p.trim());
  if (parts.length && !parts[0].includes(":")) hasil.nama = parts.shift();

  const KEY_MAP = {
    TAG: "tagihan",
    ADMIN: "adminBank",
    TTAG: "totalTagihan",
    TARIF: "tarif",
    DAYA: "daya",
    JMLBLN: "jmlBulan",
    PERIODE: "periode",
    MET: "standMeter",
    REFF: "reff",
  };
  for (const part of parts) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const key = KEY_MAP[part.slice(0, i).trim().toUpperCase()];
    if (key) hasil[key] = part.slice(i + 1).trim();
  }
  return hasil;
}

/**
 * @param {Object} d
 * @param {string} d.storeName
 * @param {string} [d.address]
 * @param {string} d.date
 * @param {string} d.idPlgn - nomor ID pelanggan (target order)
 * @param {string} [d.nama] - nama pelanggan dari PLN
 * @param {string} [d.tarif] mis. "R1"
 * @param {string} [d.daya] mis. "900"
 * @param {string} [d.jmlBulan] mis. "1"
 * @param {string} [d.periode] mis. "202609"
 * @param {string} [d.standMeter] mis. "51986-52019"
 * @param {number} [d.tagihan] - nilai tagihan sebelum biaya admin
 * @param {number} [d.adminBank] - biaya admin dari PLN/bank
 * @param {number} [d.adminLoket] - margin toko (selisih yang kita ambil)
 * @param {number} d.totalBayar - total yang dibayar pelanggan (= harga jual)
 * @param {string} [d.reff] - nomor referensi/serial dari PLN
 * @param {string[]} [d.catatan]
 * @returns {Promise<Blob>}
 */
export function buatStrukTagihanListrik(d) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const w = LEBAR;
  const pad = PAD;
  const contentW = w - pad * 2;
  const lineH = 15;
  const gap = 4;
  const monoBold = (px) => `bold ${px}px "Courier New", monospace`;
  const mono = (px) => `${px}px "Courier New", monospace`;

  const rincian = [];
  rincian.push(["ID PLGN", d.idPlgn]);
  if (d.nama) rincian.push(["NAMA", d.nama]);
  if (d.tarif || d.daya) rincian.push(["TARIF DAYA", [d.tarif, d.daya].filter(Boolean).join(" - ")]);
  if (d.jmlBulan) rincian.push(["BULAN", d.jmlBulan]);
  if (d.periode) rincian.push(["PERIODE", d.periode]);
  if (d.standMeter) rincian.push(["STAND MTR", d.standMeter]);

  const biaya = [];
  if (d.tagihan != null) biaya.push(["TAGIHAN", d.tagihan]);
  if (d.adminBank != null) biaya.push(["ADMIN BANK", d.adminBank]);
  if (d.adminLoket != null && d.adminLoket > 0) biaya.push(["ADMIN LOKET", d.adminLoket]);

  const measure = document.createElement("canvas").getContext("2d");
  const wrapAt = (text, font, maxW) => {
    measure.font = font;
    return wrapText(measure, text, maxW);
  };

  // --- Pass 1: hitung tinggi ---
  let y = pad;
  y += lineH * 1.3; // nama toko
  measure.font = mono(12);
  const alamatLines = d.address ? wrapText(measure, d.address, contentW) : [];
  y += alamatLines.length * lineH + (d.address ? gap : 0);
  y += lineH + gap * 2; // tanggal
  y += 1 + gap * 2; // garis

  measure.font = monoBold(12.5);
  const judulLines = wrapText(measure, "STRUK PEMBAYARAN LISTRIK", contentW);
  y += judulLines.length * lineH * 1.15 + gap * 2;
  y += 1 + gap * 2; // garis

  for (const [label, value] of rincian) {
    const valLines = wrapAt(String(value), mono(12), contentW - 10);
    y += Math.max(1, valLines.length) * lineH + gap * 0.3;
  }
  y += gap;
  y += 1 + gap * 2; // garis

  measure.font = mono(12.5);
  y += biaya.length * lineH;
  if (biaya.length) y += gap;

  y += lineH * 1.3 + gap * 2; // TOTAL BAYAR (bold)

  measure.font = mono(11.5);
  y += lineH; // "** Serial Number **"
  measure.font = monoBold(13);
  const reffLines = wrapText(measure, d.reff || "-", contentW);
  y += reffLines.length * lineH * 1.2 + gap;

  measure.font = mono(12);
  const catatanLines = (d.catatan || []).flatMap((c) => wrapText(measure, c, contentW));
  if (catatanLines.length) y += gap;
  y += catatanLines.length * lineH;

  measure.font = mono(11);
  const footerLines = wrapText(measure, "PLN menyatakan struk ini sebagai bukti yang sah, mohon disimpan", contentW);
  y += gap * 3 + 1 + gap * 2;
  y += footerLines.length * lineH + gap + lineH * 1.2; // footer PLN + "Terima kasih!"
  y += pad;

  // --- Pass 2: gambar ---
  canvas.width = w;
  canvas.height = Math.ceil(y);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#1a1a1a";
  ctx.textBaseline = "top";

  const center = (text, cy, font) => {
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.fillText(text, w / 2, cy);
    ctx.textAlign = "left";
  };
  const hr = (cy) => {
    ctx.strokeStyle = "#1a1a1a";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(pad, cy);
    ctx.lineTo(w - pad, cy);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  y = pad;
  center(d.storeName || "Toko", y, monoBold(16));
  y += lineH * 1.3;

  if (d.address) {
    ctx.font = mono(12);
    for (const l of alamatLines) {
      center(l, y, ctx.font);
      y += lineH;
    }
    y += gap;
  }
  center(d.date, y, mono(12));
  y += lineH + gap * 2;
  hr(y);
  y += gap * 2;

  ctx.font = monoBold(12.5);
  for (const l of judulLines) {
    center(l, y, ctx.font);
    y += lineH * 1.15;
  }
  y += gap;
  hr(y);
  y += gap * 2;

  for (const [label, value] of rincian) {
    ctx.font = mono(12);
    ctx.fillText(label, pad, y);
    const valLines = wrapText(ctx, String(value), contentW - 10);
    for (const vl of valLines) {
      ctx.fillText(vl, pad, y + lineH);
      y += lineH;
    }
    y += gap * 0.3;
  }
  y += gap;
  hr(y);
  y += gap * 2;

  ctx.font = mono(12.5);
  for (const [label, value] of biaya) {
    ctx.fillText(label, pad, y);
    ctx.textAlign = "right";
    ctx.fillText(rupiah(value), w - pad, y);
    ctx.textAlign = "left";
    y += lineH;
  }
  if (biaya.length) y += gap;

  ctx.font = monoBold(14);
  ctx.fillText("TOTAL BAYAR", pad, y);
  ctx.textAlign = "right";
  ctx.fillText(rupiah(d.totalBayar), w - pad, y);
  ctx.textAlign = "left";
  y += lineH * 1.3 + gap * 2;

  center("** Serial Number **", y, mono(11.5));
  y += lineH;
  ctx.font = monoBold(13);
  for (const l of reffLines) {
    center(l, y, ctx.font);
    y += lineH * 1.2;
  }
  y += gap;

  if (catatanLines.length) {
    y += gap;
    ctx.font = mono(12);
    for (const l of catatanLines) {
      ctx.fillText(l, pad, y);
      y += lineH;
    }
  }

  y += gap * 3;
  hr(y);
  y += gap * 2;
  ctx.font = mono(11);
  for (const l of footerLines) {
    center(l, y, ctx.font);
    y += lineH;
  }
  y += gap;
  center("Terima kasih!", y, mono(12.5));

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png", 1));
}

// ---------------------------------------------------------------------------
// STRUK KHUSUS PULSA/PAKET DATA PRABAYAR
//
// Beda dari token PLN (tidak ada TARIF/DAYA/KWH) dan dari tagihan (tidak ada
// rincian TAG/ADMIN/TTAG, karena pulsa harganya flat, bukan dihitung dari
// nominal tagihan yang beda tiap transaksi). Cukup NO HP, PRODUK, HARGA,
// STATUS, dan Serial Number (SN) kalau providernya mengirim.
// ---------------------------------------------------------------------------

/**
 * Ambil Serial Number (SN) dari balasan sukses pulsa/paket data, mis.:
 *   "...Isi Pulsa TELKOMSEL 10.000 SUKSES. SN: 000123456789. Saldo..."
 * Beda provider kadang formatnya beda (angka saja, atau alfanumerik) —
 * makanya pola sengaja longgar (huruf/angka/strip), bukan cuma digit.
 * Kalau tidak ketemu, dikembalikan null — struk tetap dibuat tanpa baris SN.
 */
export function parseStrukPulsa(rawReply) {
  const text = String(rawReply || "");
  const snMatch = text.match(/SN\s*:?\s*([\w-]{6,})/i);
  return { sn: snMatch ? snMatch[1] : null };
}

/**
 * Mesin render bersama utk struk "ringkas gaya OkeConnect": header rata KIRI
 * (nama toko + tanggal, TANPA garis pemisah), judul tebal rata tengah, baris
 * rincian format "LABEL : nilai" dengan titik dua sejajar, lalu Serial
 * Number besar rata tengah (opsional), baris footer rata tengah (masing-
 * masing dibungkus/di-wrap sendiri — bisa satu paragraf atau beberapa baris
 * lepas kayak pemisah "- - -" + teks promo), ditutup catatan tambahan rata
 * kiri (info utang/titipan). Dipakai bersama oleh buatStrukPulsa &
 * buatStrukTopupEwallet supaya stylenya konsisten & gampang ditambah lagi.
 *
 * @param {Object} o
 * @param {string} o.storeName
 * @param {string} [o.address]
 * @param {string} o.date
 * @param {string} o.judul
 * @param {[string, string][]} o.rincian - pasangan [label, nilai_string]
 * @param {string} [o.sn] - serial number, kalau ada
 * @param {string[]} [o.footerLines] - baris-baris footer, masing2 di-wrap & rata tengah sendiri
 * @param {string[]} [o.catatan] - baris tambahan rata kiri di paling bawah
 * @returns {Promise<Blob>}
 */
function strukRingkasOkeconnect(o) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const w = LEBAR;
  const pad = PAD;
  const contentW = w - pad * 2;
  const lineH = 15;
  const gap = 4;
  const monoBold = (px) => `bold ${px}px "Courier New", monospace`;
  const mono = (px) => `${px}px "Courier New", monospace`;
  const rincian = o.rincian;
  const footerLines = o.footerLines || [];

  const measure = document.createElement("canvas").getContext("2d");
  measure.font = mono(12.5);
  const labelColW = Math.max(...rincian.map(([label]) => measure.measureText(label).width)) + 14;
  const wrapAt = (text, font, maxW) => {
    measure.font = font;
    return wrapText(measure, String(text), maxW);
  };

  // --- Pass 1: hitung tinggi ---
  let y = pad;
  y += lineH * 1.15; // nama toko
  measure.font = mono(12);
  const alamatLines = o.address ? wrapText(measure, o.address, contentW) : [];
  y += alamatLines.length * lineH;
  y += lineH + gap * 3; // tanggal

  measure.font = monoBold(14);
  const judulLines = wrapText(measure, o.judul, contentW);
  y += judulLines.length * lineH * 1.2 + gap * 3;

  measure.font = mono(12.5);
  const rincianLines = rincian.map(([, value]) => wrapAt(value, mono(12.5), contentW - labelColW - 10));
  for (const lines of rincianLines) y += Math.max(1, lines.length) * lineH * 1.3;
  y += gap * 3;

  if (o.sn) {
    measure.font = mono(11.5);
    y += lineH * 1.3; // "** Serial Number **"
    measure.font = monoBold(15);
    const snLines = wrapText(measure, o.sn, contentW);
    y += snLines.length * lineH * 1.3 + gap * 3;
  }

  measure.font = mono(11.5);
  const footerWrapped = footerLines.map((f) => wrapText(measure, f, contentW));
  for (const lines of footerWrapped) y += lines.length * lineH * 1.2;

  measure.font = mono(12);
  const catatanLines = (o.catatan || []).flatMap((c) => wrapText(measure, c, contentW));
  if (catatanLines.length) y += gap * 2;
  y += catatanLines.length * lineH;
  y += pad;

  // --- Pass 2: gambar ---
  canvas.width = w;
  canvas.height = Math.ceil(y);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#1a1a1a";
  ctx.textBaseline = "top";

  const center = (text, cy, font) => {
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.fillText(text, w / 2, cy);
    ctx.textAlign = "left";
  };

  y = pad;
  ctx.font = monoBold(14);
  ctx.fillText(o.storeName || "Toko", pad, y);
  y += lineH * 1.15;

  if (o.address) {
    ctx.font = mono(12);
    for (const l of alamatLines) {
      ctx.fillText(l, pad, y);
      y += lineH;
    }
  }
  ctx.font = mono(12);
  ctx.fillText(o.date, pad, y);
  y += lineH + gap * 3;

  ctx.font = monoBold(14);
  for (const l of judulLines) {
    center(l, y, ctx.font);
    y += lineH * 1.2;
  }
  y += gap * 3;

  ctx.font = mono(12.5);
  rincian.forEach(([label], i) => {
    const lines = rincianLines[i];
    const startY = y;
    ctx.fillText(label, pad, y);
    ctx.fillText(":", pad + labelColW - 10, y);
    for (const l of lines) {
      ctx.fillText(l, pad + labelColW + 6, y);
      y += lineH * 1.3;
    }
    y = Math.max(y, startY + lineH * 1.3);
  });
  y += gap * 2;

  if (o.sn) {
    center("** Serial Number **", y, mono(11.5));
    y += lineH * 1.3;
    ctx.font = monoBold(15);
    for (const l of wrapText(ctx, o.sn, contentW)) {
      center(l, y, ctx.font);
      y += lineH * 1.3;
    }
    y += gap * 2;
  }

  ctx.font = mono(11.5);
  footerWrapped.forEach((lines) => {
    for (const l of lines) {
      center(l, y, ctx.font);
      y += lineH * 1.2;
    }
  });

  if (catatanLines.length) {
    y += gap * 2;
    ctx.font = mono(12);
    for (const l of catatanLines) {
      ctx.fillText(l, pad, y);
      y += lineH;
    }
  }

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png", 1));
}

/**
 * Meniru struk resmi provider (contoh nyata: "STRUK PULSA INDOSAT" dari
 * OkeConnect) — judul "STRUK PULSA {PROVIDER}", ditutup catatan pengecekan
 * pulsa (kode UMB beda tiap provider) alih-alih "Terima kasih!".
 *
 * @param {Object} d
 * @param {string} d.storeName
 * @param {string} [d.address]
 * @param {string} d.date
 * @param {string} d.refId - ID TRX (ref_id order)
 * @param {string} d.produkNama - mis. "Indosat 25.000" (kata pertama dipakai sbg nama provider di judul)
 * @param {string} d.noTujuan - nomor tujuan (target order)
 * @param {number} d.harga - harga jual ke pelanggan
 * @param {string} [d.sn] - serial number dari provider, kalau ada
 * @param {string} [d.catatanCek] - baris pengecekan pulsa khas provider, mis.
 *   "SEGERA LAKUKAN PENGECEKAN PULSA PADA *123# / MY IM3". Default generik
 *   kalau tidak diisi (beda provider beda kode UMB cek pulsanya).
 * @param {string[]} [d.catatan] - baris tambahan (mis. info utang/titipan)
 * @returns {Promise<Blob>}
 */
export function buatStrukPulsa(d) {
  const provider = String(d.produkNama || "").trim().split(/\s+/)[0] || "";
  const judul = `STRUK PULSA ${provider}`.trim().toUpperCase();
  // Kode UMB cek pulsa beda tiap provider (persis contoh resmi Indosat: "*123#
  // / MY IM3"). Ini tebakan berdasarkan yang umum dipakai; kalau providernya
  // tidak ada di daftar, pakai pesan generik saja.
  const CEK_PULSA = {
    telkomsel: "*888# / MyTelkomsel",
    simpati: "*888# / MyTelkomsel",
    as: "*888# / MyTelkomsel",
    indosat: "*123# / MY IM3",
    im3: "*123# / MY IM3",
    ooredoo: "*123# / MY IM3",
    xl: "*123# / MyXL",
    axis: "*123# / AXISnet",
    tri: "*111# / Bima+",
    "3": "*111# / Bima+",
    smartfren: "*999# / MySmartfren",
    byu: "aplikasi By.U",
  };
  const kodeCek = CEK_PULSA[provider.toLowerCase()];
  const catatanCek = d.catatanCek || (kodeCek ? `SEGERA LAKUKAN PENGECEKAN PULSA PADA ${kodeCek}` : "SEGERA LAKUKAN PENGECEKAN PULSA/PAKET DI HP TUJUAN");

  return strukRingkasOkeconnect({
    storeName: d.storeName,
    address: d.address,
    date: d.date,
    judul,
    rincian: [
      ["ID TRX", d.refId],
      ["PRODUK", d.produkNama],
      ["NO TUJUAN", d.noTujuan],
      ["HARGA", "Rp " + Number(d.harga || 0).toLocaleString("id-ID")],
    ],
    sn: d.sn,
    footerLines: [catatanCek],
    catatan: d.catatan,
  });
}

// ---------------------------------------------------------------------------
// STRUK TOPUP UANG ELEKTRONIK (ShopeePay/GoPay/DANA/OVO/LinkAja, dst)
//
// Beda dari struk pulsa: ada baris DETAIL (nama pemilik akun e-wallet tujuan,
// diambil dari balasan OkeConnect) dan footer-nya promosi produk lain yang
// tersedia di toko (bukan kode UMB cek pulsa, karena e-wallet tidak punya itu).
// ---------------------------------------------------------------------------

/**
 * Ambil NAMA pemilik & serial code dari balasan sukses topup e-wallet, mis.:
 *   "...SUKSES. SN: MOHAMAD NURUL MUTTAQIEN/200000/MWSH6WFB1Y5IZMNWCX1EJ3DFQWI1Q. Saldo..."
 * Formatnya "NAMA/NOMINAL/KODE" — nominal di tengah sengaja tidak dipakai di
 * struk (itu nominal topup pokok, HARGA yang ditampilkan sudah termasuk
 * admin, diambil dari data transaksi, bukan dari sini). Kalau formatnya
 * cuma "NAMA/KODE" (tanpa nominal) atau cuma kode polos, tetap dikenali.
 */
export function parseStrukTopupEwallet(rawReply) {
  const text = String(rawReply || "");
  let m = text.match(/SN\s*:?\s*([^\/]+?)\s*\/\s*[\d.,]+\s*\/\s*([\w-]+)/i);
  if (m) return { nama: m[1].trim(), sn: m[2] };
  m = text.match(/SN\s*:?\s*([^\/]+?)\s*\/\s*([\w-]{6,})/i);
  if (m) return { nama: m[1].trim(), sn: m[2] };
  m = text.match(/SN\s*:?\s*([\w-]{6,})/i);
  return { nama: null, sn: m ? m[1] : null };
}

/**
 * @param {Object} d
 * @param {string} d.storeName
 * @param {string} [d.address]
 * @param {string} d.date
 * @param {string} d.refId - ID TRX (ref_id order)
 * @param {string} d.produkNama - mis. "Shopee Pay 200.000"
 * @param {string} d.noTujuan - nomor tujuan (target order)
 * @param {string} [d.nama] - nama pemilik akun e-wallet tujuan (hasil parseStrukTopupEwallet)
 * @param {number} d.harga - harga jual ke pelanggan (sudah termasuk admin)
 * @param {string} [d.sn] - serial/kode referensi dari provider, kalau ada
 * @param {string[]} [d.footerPromo] - baris promo produk lain; default daftar e-wallet umum
 * @param {string[]} [d.catatan] - baris tambahan (mis. info utang/titipan)
 * @returns {Promise<Blob>}
 */
export function buatStrukTopupEwallet(d) {
  const rincian = [
    ["ID TRX", d.refId],
    ["PRODUK", d.produkNama],
    ["NO TUJUAN", d.noTujuan],
  ];
  if (d.nama) rincian.push(["DETAIL", d.nama]);
  rincian.push(["HARGA", "Rp " + Number(d.harga || 0).toLocaleString("id-ID")]);

  const footerPromo = d.footerPromo || ["DISINI JUGA TERSEDIA GOPAY", "LINK AJA, DANA, OVO", "BAYAR BLANJA - TRANSFER UANG"];

  return strukRingkasOkeconnect({
    storeName: d.storeName,
    address: d.address,
    date: d.date,
    judul: "TOPUP UANG ELEKTRONIK",
    rincian,
    sn: d.sn,
    footerLines: ["- - - - - - - - - - - - - - - -", ...footerPromo],
    catatan: d.catatan,
  });
}


export async function bagikanAtauUnduhGambar(blob, filename, { title, text } = {}) {
  const file = new File([blob], filename, { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text });
      return "shared";
    } catch (err) {
      if (err && err.name === "AbortError") return "cancelled"; // pengguna batal, bukan error
      // lanjut ke unduh sebagai fallback kalau share gagal karena sebab lain
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return "downloaded";
}
