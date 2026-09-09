import { sendJabberCommand } from "./jabber.js";

/**
 * Proses satu order PPOB: simpan ke ppob_orders, kirim ke OkeConnect via Jabber,
 * lalu kalau sukses catat juga sebagai transaksi penjualan & potong saldo distributor.
 * Dipakai baik dari webhook Telegram (/beli) maupun dari halaman kasir web (/api/ppob/order).
 */
export async function placePpobOrder(env, { productCode, target }) {
  const product = await env.DB.prepare("SELECT * FROM products WHERE code = ?")
    .bind(productCode)
    .first();
  if (!product) {
    throw new Error(`Kode produk "${productCode}" tidak ditemukan. Coba /cari dulu.`);
  }

  const wallet = await env.DB.prepare(
    "SELECT * FROM wallets WHERE type = 'distributor_ppob' LIMIT 1"
  ).first();

  const refId = "TX" + Date.now();
  await env.DB.prepare(
    `INSERT INTO ppob_orders (ref_id, telegram_chat_id, product_code, target, cost_price, sell_price, wallet_id, status)
     VALUES (?, '', ?, ?, ?, ?, ?, 'pending')`
  )
    .bind(refId, productCode, target, product.cost_price, product.sell_price, wallet ? wallet.id : null)
    .run();

  const body = `${productCode}.${target}.${env.JABBER_PIN}.R#${refId}`;
  let status = "pending";
  let reply = null;

  try {
    reply = await sendJabberCommand({
      jid: env.JABBER_JID,
      password: env.JABBER_PASSWORD,
      to: "okeconnect@gojabber.com",
      body,
    });
    if (/sukses|berhasil/i.test(reply)) status = "sukses";
    else if (/gagal|error/i.test(reply)) status = "gagal";
  } catch (err) {
    // Tidak sempat balas cepat — biarkan "pending", nanti ditangkap cron checkPendingOrders
    status = "pending";
  }

  await env.DB.prepare(
    "UPDATE ppob_orders SET status = ?, raw_reply = ?, updated_at = datetime('now') WHERE ref_id = ?"
  )
    .bind(status, reply, refId)
    .run();

  if (status === "sukses") {
    await recordPpobSale(env, { product, wallet, refId, target });
  }

  return { refId, status, reply, product };
}

/**
 * Cek saldo ASLI di server OkeConnect (bukan saldo catatan internal di database kita).
 * Format ini mengikuti konvensi umum provider H2H sejenis: "S.{PIN}".
 * CATATAN: kalau balasannya aneh/tidak dikenali, konfirmasi ke CS OkeConnect apakah
 * format cek saldo mereka persis ini atau ada variasi lain.
 */
export async function checkRealBalance(env) {
  const reply = await sendJabberCommand({
    jid: env.JABBER_JID,
    password: env.JABBER_PASSWORD,
    to: "okeconnect@gojabber.com",
    body: `S.${env.JABBER_PIN}`,
  });
  const match = reply.match(/(?:saldo|sisa saldo)[:=\s]*rp?\.?\s*([\d.,]+)/i);
  const amount = match ? Number(match[1].replace(/[.,]/g, "")) : null;
  return { raw: reply, amount };
}
export async function recordPpobSale(env, { product, wallet, refId, target }) {
  await env.DB.prepare(
    `INSERT INTO transactions (type, category, wallet_id, amount, cost_total, note)
     VALUES ('sale', 'PPOB', ?, ?, ?, ?)`
  )
    .bind(
      wallet ? wallet.id : null,
      product.sell_price,
      product.cost_price,
      `PPOB ${product.code} ke ${target} (ref ${refId})`
    )
    .run();

  if (wallet) {
    await env.DB.prepare("UPDATE wallets SET balance = balance - ? WHERE id = ?")
      .bind(product.cost_price, wallet.id)
      .run();
  }
}
