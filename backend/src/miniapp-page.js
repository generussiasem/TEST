// Halaman Telegram Mini App — SENGAJA satu file HTML+CSS+JS polos (bukan
// Vue/build step) supaya tidak perlu proses build/deploy terpisah dari
// dashboard web: cukup di-serve langsung dari Worker yang sama lewat
// GET /miniapp (lihat index.js). Dibuka dari tombol "web_app" di bot
// Telegram (lihat bot-admin.js), BUKAN lewat browser biasa — makanya
// pakai Telegram.WebApp SDK & header X-Telegram-Init-Data ke /api/miniapp/*.

export function renderMiniAppPage() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<title>Kasir Mini App</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 12px 12px 90px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--tg-theme-bg-color, #f2f2f7);
    color: var(--tg-theme-text-color, #000);
  }
  h2 { font-size: 17px; margin: 4px 0 12px; }
  .muted { color: var(--tg-theme-hint-color, #888); font-size: 13px; }
  .tabs { display: flex; gap: 6px; margin-bottom: 14px; position: sticky; top: 0; background: var(--tg-theme-bg-color, #f2f2f7); z-index: 5; padding: 4px 0; }
  .tab {
    flex: 1; text-align: center; padding: 9px 4px; border-radius: 10px; font-size: 14px; font-weight: 600;
    background: var(--tg-theme-secondary-bg-color, #e5e5ea); color: var(--tg-theme-hint-color, #666); cursor: pointer;
  }
  .tab.active { background: var(--tg-theme-button-color, #2481cc); color: var(--tg-theme-button-text-color, #fff); }
  .card {
    background: var(--tg-theme-secondary-bg-color, #fff); border-radius: 12px; padding: 12px; margin-bottom: 10px;
  }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  input, select {
    width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--tg-theme-hint-color, #ccc);
    background: var(--tg-theme-bg-color, #fff); color: var(--tg-theme-text-color, #000); font-size: 15px; margin-bottom: 8px;
  }
  label { font-size: 12px; color: var(--tg-theme-hint-color, #888); display: block; margin-bottom: 3px; }
  .btn {
    display: block; width: 100%; padding: 11px; border: none; border-radius: 10px; font-size: 15px; font-weight: 600;
    background: var(--tg-theme-button-color, #2481cc); color: var(--tg-theme-button-text-color, #fff); cursor: pointer; margin-top: 4px;
  }
  .btn.secondary { background: var(--tg-theme-secondary-bg-color, #e5e5ea); color: var(--tg-theme-text-color, #000); }
  .btn.danger { background: #e53935; }
  .list-item { padding: 10px 4px; border-bottom: 1px solid var(--tg-theme-secondary-bg-color, #eee); cursor: pointer; }
  .list-item:last-child { border-bottom: none; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 8px; background: var(--tg-theme-secondary-bg-color, #eee); }
  .pill-row { display: flex; gap: 6px; margin-bottom: 8px; }
  .pill { flex: 1; text-align: center; padding: 8px; border-radius: 8px; background: var(--tg-theme-secondary-bg-color, #eee); font-size: 13px; cursor: pointer; }
  .pill.active { background: var(--tg-theme-button-color, #2481cc); color: var(--tg-theme-button-text-color, #fff); }
  .error { color: #e53935; font-size: 13px; margin: 6px 0; }
  .success { color: #2e7d32; font-size: 13px; margin: 6px 0; }
  .hidden { display: none !important; }
  .spinner { text-align: center; padding: 20px; color: var(--tg-theme-hint-color, #888); font-size: 13px; }
  .back-link { font-size: 13px; color: var(--tg-theme-link-color, #2481cc); margin-bottom: 10px; display: inline-block; cursor: pointer; }
</style>
</head>
<body>

<div id="app">
  <div class="spinner" id="loadingScreen">Menghubungkan ke Telegram…</div>
</div>

<script>
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const INIT_DATA = tg ? tg.initData : "";
const app = document.getElementById("app");

async function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ "Content-Type": "application/json", "X-Telegram-Init-Data": INIT_DATA }, opts.headers || {});
  const res = await fetch("/api/miniapp" + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || ("Gagal (" + res.status + ")"));
  return data;
}
function rupiah(n) { return "Rp" + Number(n || 0).toLocaleString("id-ID"); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
function alertMsg(msg) { if (tg && tg.showAlert) tg.showAlert(msg); else alert(msg); }
function haptic(kind) { if (tg && tg.HapticFeedback) { if (kind === "err") tg.HapticFeedback.notificationOccurred("error"); else tg.HapticFeedback.notificationOccurred("success"); } }

let ME = null;
let currentTab = "hutang";

async function boot() {
  try {
    ME = await api("/me");
    render();
  } catch (err) {
    app.innerHTML = '<div class="card"><div class="error">' + esc(err.message) + '</div><p class="muted">Pastikan mini app ini dibuka dari tombol bot Telegram toko Anda, bukan dari link biasa.</p></div>';
  }
}

function render() {
  app.innerHTML =
    '<h2>👋 ' + esc(ME.employee.name) + ' — ' + esc(ME.storeName) + '</h2>' +
    '<div class="tabs">' +
      '<div class="tab' + (currentTab === "hutang" ? " active" : "") + '" data-tab="hutang">💳 Hutang</div>' +
      '<div class="tab' + (currentTab === "ppob" ? " active" : "") + '" data-tab="ppob">📱 PPOB</div>' +
    '</div>' +
    '<div id="tabBody"></div>';
  app.querySelectorAll(".tab").forEach((el) => el.addEventListener("click", () => { currentTab = el.dataset.tab; render(); }));
  if (currentTab === "hutang") renderHutangTab(); else renderPpobTab();
}

// ---------------------------------------------------------------------------
// TAB HUTANG PIUTANG
// ---------------------------------------------------------------------------
function renderHutangTab() {
  const body = document.getElementById("tabBody");
  body.innerHTML =
    '<div class="card">' +
      '<label>Cari pelanggan (nama/HP)</label>' +
      '<input id="hutangSearch" placeholder="Ketik nama atau nomor HP..." />' +
      '<div id="hutangList" class="spinner">Memuat...</div>' +
    '</div>' +
    '<button class="btn secondary" id="btnKontakBaru">+ Kontak Baru</button>';

  const searchInput = document.getElementById("hutangSearch");
  let timer;
  searchInput.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => loadContacts(searchInput.value), 300); });
  document.getElementById("btnKontakBaru").addEventListener("click", showNewContactForm);
  loadContacts("");
}

async function loadContacts(q) {
  const listEl = document.getElementById("hutangList");
  listEl.innerHTML = '<div class="spinner">Memuat...</div>';
  try {
    const rows = await api("/contacts?q=" + encodeURIComponent(q || ""));
    if (!rows.length) { listEl.innerHTML = '<p class="muted">Tidak ada kontak' + (q ? " yang cocok" : "") + '.</p>'; return; }
    listEl.innerHTML = rows.map((c) =>
      '<div class="list-item" data-id="' + c.id + '">' +
        '<div class="row"><b>' + esc(c.name) + '</b>' +
        '<span class="badge">' + (c.total_debt > 0 ? rupiah(c.total_debt) : (c.deposit > 0 ? "Titipan " + rupiah(c.deposit) : "Lunas")) + '</span></div>' +
        (c.phone ? '<div class="muted">' + esc(c.phone) + '</div>' : "") +
      '</div>'
    ).join("");
    listEl.querySelectorAll(".list-item").forEach((el) => el.addEventListener("click", () => showContactDetail(el.dataset.id)));
  } catch (err) {
    listEl.innerHTML = '<div class="error">' + esc(err.message) + '</div>';
  }
}

function showNewContactForm() {
  const body = document.getElementById("tabBody");
  body.innerHTML =
    '<span class="back-link" id="backLink">&larr; Kembali</span>' +
    '<div class="card">' +
      '<h2>Kontak Baru</h2>' +
      '<label>Nama</label><input id="newName" placeholder="Nama pelanggan" />' +
      '<label>No. HP (opsional)</label><input id="newPhone" placeholder="08xx" />' +
      '<div id="newContactMsg"></div>' +
      '<button class="btn" id="saveContact">Simpan</button>' +
    '</div>';
  document.getElementById("backLink").addEventListener("click", renderHutangTab);
  document.getElementById("saveContact").addEventListener("click", async () => {
    const name = document.getElementById("newName").value.trim();
    const phone = document.getElementById("newPhone").value.trim();
    const msgEl = document.getElementById("newContactMsg");
    if (!name) { msgEl.innerHTML = '<div class="error">Nama wajib diisi</div>'; return; }
    try {
      const res = await api("/contacts", { method: "POST", body: JSON.stringify({ name, phone }) });
      haptic("ok");
      showContactDetail(res.contact.id);
    } catch (err) {
      msgEl.innerHTML = '<div class="error">' + esc(err.message) + '</div>';
    }
  });
}

async function showContactDetail(contactId) {
  const body = document.getElementById("tabBody");
  body.innerHTML = '<div class="spinner">Memuat...</div>';
  try {
    const data = await api("/contacts/" + contactId + "/debts");
    const c = data.contact;
    const riwayatHtml = data.riwayat.length
      ? data.riwayat.map((d) =>
          '<div class="list-item"><div class="row"><span>' +
          ({ cicilan: "Bayar", utang: "Utang", piutang: "Piutang", titip: "Titip", pakai_titip: "Pakai Titipan", tarik_titip: "Tarik Titipan" }[d.type] || d.type) +
          '</span><b>' + rupiah(d.amount) + '</b></div>' +
          '<div class="muted">' + new Date(d.date).toLocaleDateString("id-ID") + (d.note ? " — " + esc(d.note) : "") + '</div></div>'
        ).join("")
      : '<p class="muted">Belum ada riwayat.</p>';

    body.innerHTML =
      '<span class="back-link" id="backLink">&larr; Kembali</span>' +
      '<div class="card">' +
        '<h2>' + esc(c.name) + '</h2>' +
        (c.phone ? '<p class="muted">' + esc(c.phone) + '</p>' : "") +
        '<div class="row"><span>Sisa Hutang</span><b>' + rupiah(c.total_debt) + '</b></div>' +
        (c.deposit > 0 ? '<div class="row"><span>Saldo Titipan</span><b>' + rupiah(c.deposit) + '</b></div>' : '') +
      '</div>' +
      '<div class="card">' +
        '<button class="btn" id="btnBayar">💵 Bayar / Cicil Hutang</button>' +
        '<button class="btn secondary" id="btnTitip">💰 Titip Uang</button>' +
        '<button class="btn secondary" id="btnCatatBaru">➕ Catat Hutang Baru</button>' +
      '</div>' +
      '<div class="card"><b>Riwayat Terakhir</b>' + riwayatHtml + '</div>';

    document.getElementById("backLink").addEventListener("click", renderHutangTab);
    document.getElementById("btnBayar").addEventListener("click", () => showDebtForm(c, "cicilan"));
    document.getElementById("btnCatatBaru").addEventListener("click", () => showDebtForm(c, "piutang"));
    document.getElementById("btnTitip").addEventListener("click", () => showDebtForm(c, "titip"));
  } catch (err) {
    body.innerHTML = '<div class="error">' + esc(err.message) + '</div>';
  }
}

async function showDebtForm(contact, type) {
  const body = document.getElementById("tabBody");
  const isPay = type === "cicilan";
  const needsWallet = type === "cicilan" || type === "titip";
  const isSupplier = contact.type === "supplier";
  const title = type === "cicilan" ? "Bayar / Cicil Hutang" : type === "titip" ? "Titip Uang" : "Catat Hutang Baru";
  const amountLabel = type === "cicilan" ? "Uang diterima (Rp)" : "Nominal (Rp)";

  let wallets = [];
  if (needsWallet) {
    body.innerHTML = '<div class="spinner">Memuat...</div>';
    try { wallets = await api("/wallets"); } catch (err) { body.innerHTML = '<div class="error">' + esc(err.message) + '</div>'; return; }
  }
  const walletOpts = wallets.map((w) => '<option value="' + w.id + '">' + esc(w.name) + '</option>').join("");
  const sisaHutang = Math.max(Number(contact.total_debt) || 0, 0);

  body.innerHTML =
    '<span class="back-link" id="backLink">&larr; Kembali</span>' +
    '<div class="card">' +
      '<h2>' + title + '</h2>' +
      '<p class="muted">' + esc(contact.name) + ' — sisa hutang saat ini: ' + rupiah(contact.total_debt) + '</p>' +
      '<label>' + amountLabel + '</label><input id="debtAmount" type="number" inputmode="numeric" placeholder="mis. 50000" />' +
      (needsWallet
        ? '<label>Dompet tempat uang diterima</label><select id="debtWallet"><option value="">Pilih dompet...</option>' + walletOpts + '</select>'
        : '') +
      '<div id="excessBox" class="hidden">' +
        '<p class="muted" id="excessText"></p>' +
        '<div class="pill-row">' +
          '<div class="pill" data-kel="kembalikan">Kembalikan tunai</div>' +
          '<div class="pill" data-kel="titipkan">Titipkan</div>' +
        '</div>' +
      '</div>' +
      '<label>Catatan (opsional)</label><input id="debtNote" placeholder="mis. bayar sebagian" />' +
      '<div id="debtMsg"></div>' +
      '<button class="btn' + (type === "piutang" ? " secondary" : "") + '" id="saveDebt">Simpan</button>' +
    '</div>';
  document.getElementById("backLink").addEventListener("click", () => showContactDetail(contact.id));

  // Kelebihan bayar (khusus bayar hutang pelanggan): kasir WAJIB memilih.
  let kelebihan = null;
  let lebih = 0;
  const excessBox = document.getElementById("excessBox");
  const amountEl = document.getElementById("debtAmount");
  function refreshExcess() {
    const uang = Number(amountEl.value) || 0;
    lebih = isPay && !isSupplier ? Math.max(uang - sisaHutang, 0) : 0;
    if (lebih > 0) {
      const untukHutang = uang - lebih;
      document.getElementById("excessText").textContent =
        "Uang diterima " + rupiah(uang) + (untukHutang > 0 ? ", melunasi " + rupiah(untukHutang) : ", pelanggan tidak punya hutang") +
        ". Sisa " + rupiah(lebih) + " mau diapakan?";
      excessBox.classList.remove("hidden");
    } else {
      excessBox.classList.add("hidden");
      kelebihan = null;
      excessBox.querySelectorAll(".pill").forEach((el) => el.classList.remove("active"));
    }
  }
  amountEl.addEventListener("input", refreshExcess);
  excessBox.querySelectorAll(".pill").forEach((el) => el.addEventListener("click", () => {
    kelebihan = el.dataset.kel;
    excessBox.querySelectorAll(".pill").forEach((x) => x.classList.toggle("active", x === el));
  }));

  document.getElementById("saveDebt").addEventListener("click", async () => {
    const amount = Number(amountEl.value);
    const note = document.getElementById("debtNote").value.trim();
    const msgEl = document.getElementById("debtMsg");
    if (!amount || amount <= 0) { msgEl.innerHTML = '<div class="error">Nominal tidak valid</div>'; return; }
    const walletId = needsWallet ? Number(document.getElementById("debtWallet").value) : null;
    if (needsWallet && !walletId) { msgEl.innerHTML = '<div class="error">Pilih dompet dulu</div>'; return; }
    if (lebih > 0 && !kelebihan) { msgEl.innerHTML = '<div class="error">Pilih dulu: kembalikan tunai atau titipkan</div>'; return; }
    try {
      await api("/debts", { method: "POST", body: JSON.stringify({ contactId: contact.id, type, amount, note, walletId, kelebihan }) });
      haptic("ok");
      showContactDetail(contact.id);
    } catch (err) {
      haptic("err");
      msgEl.innerHTML = '<div class="error">' + esc(err.message) + '</div>';
    }
  });
}

// ---------------------------------------------------------------------------
// TAB PPOB
// ---------------------------------------------------------------------------
function renderPpobTab() {
  const body = document.getElementById("tabBody");
  body.innerHTML =
    '<div class="card">' +
      '<label>Cari produk (nama/kode)</label>' +
      '<input id="ppobSearch" placeholder="mis. TSEL5, token, PDAM..." />' +
      '<div id="ppobList" class="spinner">Ketik untuk mencari produk...</div>' +
    '</div>';
  const searchInput = document.getElementById("ppobSearch");
  let timer;
  searchInput.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => loadProducts(searchInput.value), 300); });
  loadProducts("");
}

async function loadProducts(q) {
  const listEl = document.getElementById("ppobList");
  listEl.innerHTML = '<div class="spinner">Memuat...</div>';
  try {
    const rows = await api("/products?q=" + encodeURIComponent(q || ""));
    if (!rows.length) { listEl.innerHTML = '<p class="muted">Tidak ada produk yang cocok.</p>'; return; }
    listEl.innerHTML = rows.map((p) =>
      '<div class="list-item" data-code="' + esc(p.code) + '">' +
        '<div class="row"><b>' + esc(p.name) + '</b><span class="badge">' + rupiah(p.sell_price) + '</span></div>' +
        '<div class="muted">' + esc(p.code) + (p.product_group ? " · " + esc(p.product_group) : "") + '</div>' +
      '</div>'
    ).join("");
    listEl.querySelectorAll(".list-item").forEach((el) => el.addEventListener("click", () => showOrderForm(rows.find((r) => r.code === el.dataset.code))));
  } catch (err) {
    listEl.innerHTML = '<div class="error">' + esc(err.message) + '</div>';
  }
}

function showOrderForm(product) {
  const body = document.getElementById("tabBody");
  body.innerHTML =
    '<span class="back-link" id="backLink">&larr; Kembali</span>' +
    '<div class="card">' +
      '<h2>' + esc(product.name) + '</h2>' +
      '<p class="muted">' + esc(product.code) + ' — harga jual ' + rupiah(product.sell_price) + '</p>' +
      '<label>Nomor / ID Pelanggan Tujuan</label>' +
      '<input id="targetInput" placeholder="mis. 0812xxxxxxxx" />' +
      '<label>Metode Bayar</label>' +
      '<div class="pill-row">' +
        '<div class="pill active" data-method="tunai">Tunai</div>' +
        '<div class="pill" data-method="utang">Utang</div>' +
      '</div>' +
      '<div id="contactPickerWrap" class="hidden">' +
        '<label>Pilih Pelanggan (yang berhutang)</label>' +
        '<input id="orderContactSearch" placeholder="Cari nama pelanggan..." />' +
        '<div id="orderContactList"></div>' +
        '<div id="orderContactSelected" class="muted"></div>' +
      '</div>' +
      '<div id="orderMsg"></div>' +
      '<button class="btn" id="submitOrder">Proses Order</button>' +
    '</div>';

  let paidMethod = "tunai";
  let selectedContactId = null;
  document.getElementById("backLink").addEventListener("click", renderPpobTab);

  body.querySelectorAll(".pill").forEach((el) => el.addEventListener("click", () => {
    paidMethod = el.dataset.method;
    body.querySelectorAll(".pill").forEach((p) => p.classList.toggle("active", p === el));
    document.getElementById("contactPickerWrap").classList.toggle("hidden", paidMethod !== "utang");
  }));

  let ctimer;
  const ocSearch = document.getElementById("orderContactSearch");
  ocSearch.addEventListener("input", () => {
    clearTimeout(ctimer);
    ctimer = setTimeout(async () => {
      const listEl = document.getElementById("orderContactList");
      try {
        const rows = await api("/contacts?q=" + encodeURIComponent(ocSearch.value));
        listEl.innerHTML = rows.map((c) => '<div class="list-item" data-id="' + c.id + '" data-name="' + esc(c.name) + '">' + esc(c.name) + (c.phone ? " (" + esc(c.phone) + ")" : "") + '</div>').join("");
        listEl.querySelectorAll(".list-item").forEach((el) => el.addEventListener("click", () => {
          selectedContactId = el.dataset.id;
          document.getElementById("orderContactSelected").textContent = "Terpilih: " + el.dataset.name;
          listEl.innerHTML = "";
          ocSearch.value = "";
        }));
      } catch (err) { /* diamkan, bukan alur kritis */ }
    }, 300);
  });

  document.getElementById("submitOrder").addEventListener("click", async () => {
    const target = document.getElementById("targetInput").value.trim();
    const msgEl = document.getElementById("orderMsg");
    if (!target) { msgEl.innerHTML = '<div class="error">Nomor/ID tujuan wajib diisi</div>'; return; }
    if (paidMethod === "utang" && !selectedContactId) { msgEl.innerHTML = '<div class="error">Pilih pelanggan dulu untuk pembayaran Utang</div>'; return; }
    msgEl.innerHTML = '<div class="spinner">Mengirim order ke provider...</div>';
    try {
      const result = await api("/ppob/order", { method: "POST", body: JSON.stringify({ productCode: product.code, target, paidMethod, contactId: selectedContactId }) });
      haptic("ok");
      showOrderStatus(result.refId, product);
    } catch (err) {
      haptic("err");
      msgEl.innerHTML = '<div class="error">' + esc(err.message) + '</div>';
    }
  });
}

async function showOrderStatus(refId, product) {
  const body = document.getElementById("tabBody");
  body.innerHTML = '<div class="card"><h2>Order ' + esc(refId) + '</h2><div id="statusBody" class="spinner">Menunggu balasan provider...</div></div>';
  const statusEl = document.getElementById("statusBody");

  let attempts = 0;
  const poll = async () => {
    attempts++;
    try {
      const data = await api("/ppob-orders/" + refId);
      const order = data.order;
      if (order.status === "pending" && attempts < 20) {
        setTimeout(poll, 3000);
        return;
      }
      if (order.status === "sukses" && !order.finalized) {
        renderConfirmForm(order, product);
      } else if (order.finalized) {
        statusEl.innerHTML = '<div class="success">✅ Sudah tercatat sebelumnya (harga ' + rupiah(order.sell_price) + ').</div><button class="btn secondary" id="doneBtn">Selesai</button>';
        document.getElementById("doneBtn").addEventListener("click", renderPpobTab);
      } else if (order.status === "gagal") {
        statusEl.innerHTML = '<div class="error">❌ Order gagal.</div><p class="muted">' + esc(order.raw_reply || "-") + '</p><button class="btn secondary" id="doneBtn">Selesai</button>';
        document.getElementById("doneBtn").addEventListener("click", renderPpobTab);
      } else {
        statusEl.innerHTML = '<p class="muted">Masih menunggu balasan provider, cek lagi nanti lewat menu bot "Konfirmasi Order PPOB" atau dashboard web.</p><button class="btn secondary" id="doneBtn">Selesai</button>';
        document.getElementById("doneBtn").addEventListener("click", renderPpobTab);
      }
    } catch (err) {
      statusEl.innerHTML = '<div class="error">' + esc(err.message) + '</div>';
    }
  };
  poll();
}

async function renderConfirmForm(order, product) {
  const body = document.getElementById("tabBody");
  const defaultPrice = order.sell_price || product.sell_price || 0;
  // Order yang dibayar Utang tidak ada uang masuk; selain itu kasir memilih dompet penerima.
  const perluDompet = order.paid_method !== "utang";
  let wallets = [];
  if (perluDompet) {
    try { wallets = await api("/wallets"); } catch (err) { body.innerHTML = '<div class="error">' + esc(err.message) + '</div>'; return; }
  }
  const walletOpts = wallets.map((w) => '<option value="' + w.id + '">' + esc(w.name) + '</option>').join("");
  body.innerHTML =
    '<div class="card">' +
      '<h2>✅ Order Sukses</h2>' +
      '<p class="muted">' + esc(order.product_code) + ' → ' + esc(order.target) + '</p>' +
      '<p class="muted">Balasan provider: ' + esc(order.raw_reply || "-") + '</p>' +
      '<label>Harga Jual Final (Rp)</label>' +
      '<input id="confirmPrice" type="number" value="' + defaultPrice + '" />' +
      (perluDompet
        ? '<label>Uang diterima di dompet</label><select id="confirmWallet"><option value="">Pilih dompet...</option>' + walletOpts + '</select>'
        : '<p class="muted">Dibayar utang — belum ada uang masuk.</p>') +
      '<div id="confirmMsg"></div>' +
      '<button class="btn" id="confirmBtn">Konfirmasi & Catat</button>' +
    '</div>';
  document.getElementById("confirmBtn").addEventListener("click", async () => {
    const sellPrice = Number(document.getElementById("confirmPrice").value);
    const msgEl = document.getElementById("confirmMsg");
    if (!sellPrice || sellPrice <= 0) { msgEl.innerHTML = '<div class="error">Harga tidak valid</div>'; return; }
    const receiveWalletId = perluDompet ? Number(document.getElementById("confirmWallet").value) : null;
    if (perluDompet && !receiveWalletId) { msgEl.innerHTML = '<div class="error">Pilih dompet tempat uang diterima</div>'; return; }
    try {
      await api("/ppob-orders/" + order.ref_id + "/konfirmasi", { method: "POST", body: JSON.stringify({ sellPrice, receiveWalletId }) });
      haptic("ok");
      const body2 = document.getElementById("tabBody");
      body2.innerHTML = '<div class="card"><div class="success">✅ Dicatat dengan harga ' + rupiah(sellPrice) + '. Sudah masuk laporan web.</div><button class="btn secondary" id="doneBtn">Selesai</button></div>';
      document.getElementById("doneBtn").addEventListener("click", renderPpobTab);
    } catch (err) {
      haptic("err");
      msgEl.innerHTML = '<div class="error">' + esc(err.message) + '</div>';
    }
  });
}

boot();
</script>
</body>
</html>`;
}
