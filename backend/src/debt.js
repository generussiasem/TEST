// ---------------------------------------------------------------------------
// HUTANG, PEMBAYARAN HUTANG & TITIPAN PELANGGAN
//
// Satu-satunya tempat logika ini hidup, dipakai bersama oleh web (index.js),
// Mini App (miniapp.js), dan bot Telegram (bot-admin.js) supaya perilakunya
// tidak bisa beda antar jalur.
//
// Dua saldo per kontak (tabel contacts):
//   total_debt : sisa hutang/piutang (pelanggan berhutang ke toko, atau toko
//                berutang ke supplier)
//   deposit    : saldo TITIPAN pelanggan (uang pelanggan yang sudah masuk kas
//                toko tapi belum dipakai belanja — mis. kembalian yang
//                dititipkan). Ini KEWAJIBAN toko ke pelanggan.
//
// Jenis catatan di tabel debts (kolom type):
//   utang / piutang  -> total_debt +
//   cicilan          -> total_debt -   (pembayaran hutang)
//   titip            -> deposit +      (uang dititipkan)
//   pakai_titip      -> deposit -      (titipan dipakai belanja)
//   tarik_titip      -> deposit -      (titipan diambil tunai)
//
// Setiap pembayaran/titipan yang melibatkan uang nyata membuat transaksi di
// tabel transactions (type 'debt_in' = uang masuk ke dompet, 'debt_out' = uang
// keluar dari dompet) sehingga saldo dompet, arus kas, dan laporan shift
// ikut benar. Transaksi tipe ini BUKAN penjualan: tidak masuk omzet/laba.
// ---------------------------------------------------------------------------

export class DebtError extends Error {}

export const DEBT_TYPES = ["utang", "piutang", "cicilan", "titip", "pakai_titip", "tarik_titip"];

/** Efek satu catatan debts ke saldo kontak. */
export function debtEffect(type, amount) {
  const a = Number(amount) || 0;
  switch (type) {
    case "utang":
    case "piutang":
      return { debt: a, deposit: 0 };
    case "cicilan":
      return { debt: -a, deposit: 0 };
    case "titip":
      return { debt: 0, deposit: a };
    case "pakai_titip":
    case "tarik_titip":
      return { debt: 0, deposit: -a };
    default:
      return { debt: 0, deposit: 0 };
  }
}

function rp(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

function toInt(n) {
  return Math.round(Number(n) || 0);
}

async function getOpenShiftId(env, employeeId) {
  if (!employeeId) return null;
  const s = await env.DB.prepare("SELECT id FROM shifts WHERE employee_id = ? AND status = 'open'")
    .bind(employeeId)
    .first();
  return s ? s.id : null;
}

async function getPayWallet(env, walletId) {
  if (!walletId) throw new DebtError("Pilih dompet dulu (tempat uang pembayaran diterima/dikeluarkan).");
  const wallet = await env.DB.prepare("SELECT * FROM wallets WHERE id = ?").bind(walletId).first();
  if (!wallet) throw new DebtError("Dompet tidak ditemukan.");
  if (wallet.type === "distributor_ppob") {
    throw new DebtError("Dompet saldo distributor PPOB tidak bisa dipakai untuk pembayaran hutang. Pilih Tunai/Bank/E-Wallet.");
  }
  return wallet;
}

/**
 * Bayar hutang. `amount` = UANG YANG DITERIMA dari pelanggan (atau yang dibayar
 * ke supplier). Sistem membaginya:
 *   - bagian yang melunasi hutang  -> dicatat sebagai 'cicilan'
 *   - kelebihan (hanya pelanggan)  -> kasir WAJIB memilih:
 *       kelebihan = 'kembalikan' : dikembalikan tunai (dompet cuma bertambah
 *                                  sebesar yang melunasi hutang)
 *       kelebihan = 'titipkan'   : masuk titipan pelanggan (dompet bertambah
 *                                  penuh, deposit bertambah sebesar kelebihan)
 * Kalau ada kelebihan tapi `kelebihan` kosong, dilempar DebtError (kode
 * KELEBIHAN) — sengaja tidak pernah otomatis memilihkan.
 */
export async function bayarHutang(env, { contactId, amount, walletId, kelebihan, note, employeeId }) {
  const uang = toInt(amount);
  if (!contactId) throw new DebtError("Pilih kontak dulu.");
  if (uang <= 0) throw new DebtError("Nominal harus lebih dari 0.");

  const contact = await env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(contactId).first();
  if (!contact) throw new DebtError("Kontak tidak ditemukan.");
  const wallet = await getPayWallet(env, walletId);

  const isSupplier = contact.type === "supplier";
  const sisaHutang = Math.max(toInt(contact.total_debt), 0);

  let untukHutang;
  let lebih = 0;
  if (isSupplier) {
    if (uang > sisaHutang) {
      throw new DebtError(`Melebihi sisa utang ke supplier (${rp(sisaHutang)}).`);
    }
    untukHutang = uang;
  } else {
    untukHutang = Math.min(uang, sisaHutang);
    lebih = uang - untukHutang;
    if (lebih > 0) {
      if (kelebihan !== "kembalikan" && kelebihan !== "titipkan") {
        const err = new DebtError(
          `Uang diterima ${rp(uang)} melebihi sisa hutang ${rp(sisaHutang)} (lebih ${rp(lebih)}). Pilih: kembalikan tunai atau titipkan.`
        );
        err.code = "KELEBIHAN";
        err.lebih = lebih;
        err.sisaHutang = sisaHutang;
        throw err;
      }
      if (untukHutang === 0 && kelebihan === "kembalikan") {
        throw new DebtError("Pelanggan ini tidak punya hutang, jadi tidak ada yang perlu dibayar.");
      }
    }
  }

  const titipkan = lebih > 0 && kelebihan === "titipkan";
  // Uang yang benar-benar menetap di dompet.
  const masukDompet = isSupplier ? untukHutang : titipkan ? uang : untukHutang;

  const shiftId = await getOpenShiftId(env, employeeId);
  const noteParts = [];
  if (note) noteParts.push(note);
  if (lebih > 0 && !titipkan) noteParts.push(`kembalian ${rp(lebih)} dikembalikan tunai`);
  const noteFinal = noteParts.join(" — ") || null;

  const txType = isSupplier ? "debt_out" : "debt_in";
  const txCategory = isSupplier ? "Bayar Utang Supplier" : titipkan && untukHutang === 0 ? "Titipan" : "Bayar Hutang";
  const txNote = [
    `${isSupplier ? "Bayar utang ke" : "Terima pembayaran dari"} ${contact.name}`,
    untukHutang > 0 ? `melunasi ${rp(untukHutang)}` : null,
    titipkan ? `dititipkan ${rp(lebih)}` : null,
    lebih > 0 && !titipkan ? `kembalian ${rp(lebih)} dikembalikan` : null,
  ]
    .filter(Boolean)
    .join(", ");

  const tx = await env.DB.prepare(
    `INSERT INTO transactions (type, category, wallet_id, amount, cost_total, note, contact_id, employee_id, shift_id)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`
  )
    .bind(txType, txCategory, wallet.id, masukDompet, txNote, contact.id, employeeId || null, shiftId)
    .run();
  const transactionId = tx.meta.last_row_id;

  const stmts = [
    env.DB.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?").bind(
      isSupplier ? -masukDompet : masukDompet,
      wallet.id
    ),
  ];
  if (untukHutang > 0) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO debts (contact_id, type, amount, note, wallet_id, transaction_id) VALUES (?, 'cicilan', ?, ?, ?, ?)"
      ).bind(contact.id, untukHutang, noteFinal, wallet.id, transactionId),
      env.DB.prepare("UPDATE contacts SET total_debt = total_debt - ? WHERE id = ?").bind(untukHutang, contact.id)
    );
  }
  if (titipkan) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO debts (contact_id, type, amount, note, wallet_id, transaction_id) VALUES (?, 'titip', ?, ?, ?, ?)"
      ).bind(contact.id, lebih, "Kelebihan pembayaran hutang dititipkan", wallet.id, transactionId),
      env.DB.prepare("UPDATE contacts SET deposit = deposit + ? WHERE id = ?").bind(lebih, contact.id)
    );
  }
  await env.DB.batch(stmts);

  const after = await env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(contact.id).first();
  return { transactionId, untukHutang, lebih, titipkan, dikembalikan: lebih > 0 && !titipkan ? lebih : 0, masukDompet, contact: after };
}

/** Pelanggan menitipkan uang tanpa ada hutang (mis. titip untuk belanja nanti). */
export async function titipUang(env, { contactId, amount, walletId, note, employeeId }) {
  const uang = toInt(amount);
  if (uang <= 0) throw new DebtError("Nominal harus lebih dari 0.");
  const contact = await env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(contactId).first();
  if (!contact) throw new DebtError("Kontak tidak ditemukan.");
  if (contact.type === "supplier") throw new DebtError("Titipan hanya untuk pelanggan.");
  const wallet = await getPayWallet(env, walletId);
  const shiftId = await getOpenShiftId(env, employeeId);

  const tx = await env.DB.prepare(
    `INSERT INTO transactions (type, category, wallet_id, amount, cost_total, note, contact_id, employee_id, shift_id)
     VALUES ('debt_in', 'Titipan', ?, ?, 0, ?, ?, ?, ?)`
  )
    .bind(wallet.id, uang, `Titipan dari ${contact.name}${note ? ` — ${note}` : ""}`, contact.id, employeeId || null, shiftId)
    .run();
  const transactionId = tx.meta.last_row_id;

  await env.DB.batch([
    env.DB.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?").bind(uang, wallet.id),
    env.DB.prepare(
      "INSERT INTO debts (contact_id, type, amount, note, wallet_id, transaction_id) VALUES (?, 'titip', ?, ?, ?, ?)"
    ).bind(contact.id, uang, note || "Titipan pelanggan", wallet.id, transactionId),
    env.DB.prepare("UPDATE contacts SET deposit = deposit + ? WHERE id = ?").bind(uang, contact.id),
  ]);
  return { transactionId, contact: await env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(contact.id).first() };
}

/** Pelanggan mengambil titipannya kembali dalam bentuk tunai. */
export async function tarikTitipan(env, { contactId, amount, walletId, note, employeeId }) {
  const uang = toInt(amount);
  if (uang <= 0) throw new DebtError("Nominal harus lebih dari 0.");
  const contact = await env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(contactId).first();
  if (!contact) throw new DebtError("Kontak tidak ditemukan.");
  if (uang > toInt(contact.deposit)) {
    throw new DebtError(`Titipan hanya tersisa ${rp(contact.deposit)}.`);
  }
  const wallet = await getPayWallet(env, walletId);
  if (toInt(wallet.balance) < uang) {
    throw new DebtError(`Saldo dompet ${wallet.name} (${rp(wallet.balance)}) tidak cukup untuk mengembalikan ${rp(uang)}.`);
  }
  const shiftId = await getOpenShiftId(env, employeeId);

  const tx = await env.DB.prepare(
    `INSERT INTO transactions (type, category, wallet_id, amount, cost_total, note, contact_id, employee_id, shift_id)
     VALUES ('debt_out', 'Tarik Titipan', ?, ?, 0, ?, ?, ?, ?)`
  )
    .bind(wallet.id, uang, `Titipan ${contact.name} diambil tunai${note ? ` — ${note}` : ""}`, contact.id, employeeId || null, shiftId)
    .run();
  const transactionId = tx.meta.last_row_id;

  await env.DB.batch([
    env.DB.prepare("UPDATE wallets SET balance = balance - ? WHERE id = ?").bind(uang, wallet.id),
    env.DB.prepare(
      "INSERT INTO debts (contact_id, type, amount, note, wallet_id, transaction_id) VALUES (?, 'tarik_titip', ?, ?, ?, ?)"
    ).bind(contact.id, uang, note || "Titipan diambil tunai", wallet.id, transactionId),
    env.DB.prepare("UPDATE contacts SET deposit = deposit - ? WHERE id = ?").bind(uang, contact.id),
  ]);
  return { transactionId, contact: await env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(contact.id).first() };
}

/**
 * Catat piutang/utang manual (tanpa uang bergerak). Untuk 'cicilan', 'titip',
 * dst. TIDAK boleh lewat sini — pakai bayarHutang/titipUang/tarikTitipan
 * supaya dompet ikut tercatat.
 */
export async function catatHutangManual(env, { contactId, type, amount, note }) {
  const jumlah = toInt(amount);
  if (!contactId || jumlah <= 0) throw new DebtError("contactId dan amount (angka > 0) wajib diisi.");
  if (type !== "utang" && type !== "piutang") {
    throw new DebtError('Untuk pembayaran hutang gunakan form "Bayar Hutang" (wajib pilih dompet).');
  }
  const eff = debtEffect(type, jumlah);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO debts (contact_id, type, amount, note) VALUES (?, ?, ?, ?)").bind(
      contactId,
      type,
      jumlah,
      note || null
    ),
    env.DB.prepare("UPDATE contacts SET total_debt = total_debt + ? WHERE id = ?").bind(eff.debt, contactId),
  ]);
  return env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(contactId).first();
}

/**
 * Bayar sebagian/seluruh penjualan pakai titipan. Dihitung dari `total`
 * (harga jual). Mengembalikan rencana pemakaian; TIDAK menulis ke database
 * (penulisan dilakukan pemanggil setelah transaksinya punya id, lewat
 * catatPakaiTitipan).
 *   sisaMethod: 'tunai' | 'utang' — cara membayar sisa kalau titipan kurang.
 */
export async function rencanaPakaiTitipan(env, { contactId, total, sisaMethod }) {
  if (!contactId) throw new DebtError("Pembayaran pakai titipan wajib pilih pelanggan.");
  const contact = await env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(contactId).first();
  if (!contact) throw new DebtError("Pelanggan tidak ditemukan.");
  const saldo = Math.max(toInt(contact.deposit), 0);
  if (saldo <= 0) throw new DebtError(`${contact.name} tidak punya saldo titipan.`);
  const pakai = Math.min(saldo, toInt(total));
  const sisa = toInt(total) - pakai;
  return {
    contact,
    pakai,
    sisa,
    sisaMethod: sisa > 0 ? (sisaMethod === "utang" ? "utang" : "tunai") : null,
  };
}

/** Pernyataan-pernyataan D1 untuk memotong titipan (dipakai dalam batch pemanggil). */
export function stmtsPakaiTitipan(env, { contactId, pakai, transactionId, note }) {
  return [
    env.DB.prepare("UPDATE contacts SET deposit = deposit - ? WHERE id = ?").bind(pakai, contactId),
    env.DB.prepare(
      "INSERT INTO debts (contact_id, type, amount, note, transaction_id) VALUES (?, 'pakai_titip', ?, ?, ?)"
    ).bind(contactId, pakai, note || `Titipan dipakai (transaksi #${transactionId})`, transactionId),
  ];
}

/**
 * Balikkan efek semua catatan debts yang tertaut ke satu transaksi
 * (transaction_id), lalu hapus catatannya. Dipakai saat transaksi dihapus.
 */
export async function balikkanCatatanTertaut(env, transactionId) {
  const { results } = await env.DB.prepare("SELECT * FROM debts WHERE transaction_id = ?").bind(transactionId).all();
  if (!results.length) return 0;
  const stmts = [];
  for (const d of results) {
    const eff = debtEffect(d.type, d.amount);
    stmts.push(
      env.DB.prepare("UPDATE contacts SET total_debt = total_debt - ?, deposit = deposit - ? WHERE id = ?").bind(
        eff.debt,
        eff.deposit,
        d.contact_id
      )
    );
  }
  stmts.push(env.DB.prepare("DELETE FROM debts WHERE transaction_id = ?").bind(transactionId));
  await env.DB.batch(stmts);
  return results.length;
}
