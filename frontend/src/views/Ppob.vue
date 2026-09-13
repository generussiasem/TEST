<script setup>
import { ref, computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import { api } from "../api.js";

const route = useRoute();

const orders = ref([]);
const products = ref([]);
const contacts = ref([]);
const error = ref("");
const search = ref("");
const openedId = ref(null);
const activeProvider = ref("okeconnect"); // tab aktif: pisahkan transaksi OkeConnect & Digiflazz biar tidak ketuker

// ---- Form tambah ke antrean ----
const formProductCode = ref("");
const formTarget = ref("");
const formPaidMethod = ref("tunai");
const formContactId = ref(null);

// ---- Antrean (keranjang) order, diproses satu-satu ----
const queue = ref([]); // { productCode, name, target, paidMethod, contactId }
const processing = ref(false);
const batchResults = ref([]); // hasil per item setelah "Proses Semua"

// ---- Kotak konfirmasi harga jual (muncul stlh 1 order sukses) ----
const confirmTarget = ref(null); // { refId, product, target, defaultSellPrice, isToken, isPostpaid }
const confirmForm = ref({ sellPrice: 0, costTotal: 0, tokenCode: "", paidMethod: "tunai", contactId: null });
const confirming = ref(false);

// ---- Struk terakhir yang dikonfirmasi ----
const lastReceipt = ref(null);

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

function isPostpaidCategory(cat) {
  return cat === "TAGIHAN" || cat === "AIR PDAM";
}
function looksLikeToken(product) {
  return /token|PLN/i.test(product.category || "") || /token|PLN/i.test(product.product_group || "");
}

function toggleDetail(o) {
  openedId.value = openedId.value === o.id ? null : o.id;
}

const editingStatus = ref(null);
function startEditStatus(o) {
  editingStatus.value = { ref_id: o.ref_id, status: o.status, raw_reply: o.raw_reply || "" };
}
async function saveEditStatus() {
  error.value = "";
  try {
    await api.put(`/api/ppob-orders/${editingStatus.value.ref_id}`, {
      status: editingStatus.value.status,
      raw_reply: editingStatus.value.raw_reply,
    });
    editingStatus.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  }
}
async function hapusOrder(o) {
  if (!confirm(`Hapus order ${o.ref_id}? Kalau order ini sempat tercatat "sukses", transaksi & saldo terkait akan dibalikkan otomatis.`)) return;
  error.value = "";
  try {
    await api.delete(`/api/ppob-orders/${o.ref_id}`);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

const checkingRef = ref(null);
async function cekUlang(o) {
  error.value = "";
  checkingRef.value = o.ref_id;
  try {
    const res = await api.post(`/api/ppob-orders/${o.ref_id}/cek-ulang`, {});
    await load();
    if (res.needsConfirm) openConfirm(orders.value.find((x) => x.ref_id === o.ref_id));
  } catch (err) {
    error.value = err.message;
  } finally {
    checkingRef.value = null;
  }
}

const ppobProducts = computed(() =>
  products.value
    .filter((p) => p.code && p.active !== 0 && (p.provider || "okeconnect") === activeProvider.value)
    .sort((a, b) => (a.sell_price || 0) - (b.sell_price || 0))
);
const filteredOrders = computed(() => orders.value.filter((o) => (o.provider || "okeconnect") === activeProvider.value));
const searchResults = computed(() => {
  if (!search.value.trim()) return [];
  const q = search.value.toLowerCase();
  return ppobProducts.value.filter((p) => p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)).slice(0, 8);
});

async function load() {
  const [o, p, c] = await Promise.all([
    api.get("/api/ppob-orders"),
    api.get("/api/products"),
    api.get("/api/contacts?type=pelanggan"),
  ]);
  orders.value = o;
  products.value = p;
  contacts.value = c;
  if (route.query.code) {
    const match = products.value.find((x) => x.code === route.query.code);
    if (match) {
      activeProvider.value = match.provider || "okeconnect";
      pick(match);
    }
  }
}

function pick(p) {
  formProductCode.value = p.code;
  search.value = `${p.name} (${p.code})`;
}

function tambahAntrean() {
  error.value = "";
  if (!formProductCode.value || !formTarget.value) {
    error.value = "Kode produk dan nomor/ID tujuan wajib diisi.";
    return;
  }
  if (formPaidMethod.value === "utang" && !formContactId.value) {
    error.value = "Pilih kontak dulu untuk pembayaran Utang.";
    return;
  }
  const product = ppobProducts.value.find((p) => p.code === formProductCode.value);
  queue.value.push({
    productCode: formProductCode.value,
    name: product ? product.name : formProductCode.value,
    target: formTarget.value,
    paidMethod: formPaidMethod.value,
    contactId: formContactId.value,
  });
  formTarget.value = "";
  search.value = "";
  formProductCode.value = "";
}

function hapusAntrean(i) {
  queue.value.splice(i, 1);
}

// Diproses SATU-SATU (bukan bareng/paralel) — supaya tidak ada 2 koneksi
// Jabber tumpang tindih sekaligus, yang bisa saling tendang atau balasannya
// ketuker (persis masalah yang pernah kita alami sebelumnya).
async function prosesSemua() {
  if (!queue.value.length) return;
  processing.value = true;
  batchResults.value = [];
  const batchId = "B" + Date.now();
  const items = [...queue.value];
  queue.value = [];

  for (const item of items) {
    try {
      const res = await api.post("/api/ppob/order", {
        productCode: item.productCode,
        target: item.target,
        paidMethod: item.paidMethod,
        contactId: item.contactId,
        batchId,
      });
      batchResults.value.push({ ...item, ...res });
    } catch (err) {
      batchResults.value.push({ ...item, status: "error", reply: err.message });
    }
  }
  processing.value = false;
  await load();

  // Kalau ada yang sukses & belum dikonfirmasi, buka kotak konfirmasi utk
  // item PERTAMA dulu — sisanya tinggal klik dari tabel Riwayat Order.
  const firstNeedsConfirm = batchResults.value.find((r) => r.needsConfirm);
  if (firstNeedsConfirm) {
    const orderRow = orders.value.find((o) => o.ref_id === firstNeedsConfirm.refId);
    if (orderRow) openConfirm(orderRow);
  }
}

function openConfirm(o) {
  const product = products.value.find((p) => p.code === o.product_code) || {
    code: o.product_code,
    category: "",
    product_group: "",
    cost_price: o.cost_price,
  };
  confirmTarget.value = {
    refId: o.ref_id,
    product,
    target: o.target,
    isPostpaid: isPostpaidCategory(product.category),
    isToken: looksLikeToken(product),
  };
  confirmForm.value = {
    sellPrice: o.sell_price || product.sell_price || 0,
    costTotal: o.cost_price || product.cost_price || 0,
    tokenCode: o.token_code || "",
    paidMethod: o.paid_method || "tunai",
    contactId: o.contact_id || null,
  };
  openedId.value = null;
}

async function submitKonfirmasi() {
  if (!confirmTarget.value) return;
  if (confirmForm.value.paidMethod === "utang" && !confirmForm.value.contactId) {
    error.value = "Pilih kontak dulu untuk pembayaran Utang.";
    return;
  }
  error.value = "";
  confirming.value = true;
  try {
    const body = {
      sellPrice: confirmForm.value.sellPrice,
      tokenCode: confirmForm.value.tokenCode || null,
      paidMethod: confirmForm.value.paidMethod,
      contactId: confirmForm.value.paidMethod === "utang" ? confirmForm.value.contactId : null,
    };
    if (confirmTarget.value.isPostpaid) body.costTotal = confirmForm.value.costTotal;

    await api.post(`/api/ppob-orders/${confirmTarget.value.refId}/konfirmasi`, body);

    lastReceipt.value = {
      refId: confirmTarget.value.refId,
      productName: confirmTarget.value.product.name || confirmTarget.value.product.code,
      target: confirmTarget.value.target,
      sellPrice: confirmForm.value.sellPrice,
      tokenCode: confirmForm.value.tokenCode,
      paidMethod: confirmForm.value.paidMethod,
      contactName: confirmForm.value.contactId ? contacts.value.find((x) => x.id === confirmForm.value.contactId)?.name : null,
      date: new Date().toLocaleString("id-ID"),
    };
    confirmTarget.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    confirming.value = false;
  }
}

function cetakStruk() {
  window.print();
}
function bagikanWA() {
  if (!lastReceipt.value) return;
  const r = lastReceipt.value;
  let text = `*Struk PPOB*\n${r.date}\n\n${r.productName}\nTujuan: ${r.target}\n`;
  if (r.tokenCode) text += `Token: ${r.tokenCode}\n`;
  text += `\n*Total: ${rupiah(r.sellPrice)}*`;
  if (r.paidMethod === "utang") text += `\n(Utang atas nama ${r.contactName})`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Pulsa &amp; PPOB</h1>
        <p>Order dikirim ke provider (OkeConnect/Digiflazz) lewat Jabber — bisa antre beberapa produk sekaligus</p>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>

    <!-- Pisahkan transaksi per provider biar tidak ketuker -->
    <div style="display: flex; gap: 8px; margin-bottom: 18px">
      <button type="button" class="btn" :class="{ ghost: activeProvider !== 'okeconnect' }" @click="activeProvider = 'okeconnect'">OkeConnect</button>
      <button type="button" class="btn" :class="{ ghost: activeProvider !== 'digiflazz' }" @click="activeProvider = 'digiflazz'">Digiflazz</button>
    </div>

    <div class="grid cols-2" style="align-items: start; margin-bottom: 22px">
      <div class="card">
        <h3 style="margin-bottom: 12px">Tambah ke Antrean</h3>
        <div class="field" style="position: relative">
          <label>Cari produk</label>
          <input v-model="search" placeholder="mis. telkomsel 5000" />
          <div v-if="searchResults.length" class="card" style="position: absolute; top: 100%; left: 0; right: 0; z-index: 5; padding: 6px; max-height: 220px; overflow: auto">
            <div v-for="p in searchResults" :key="p.id" @click="pick(p)" style="padding: 8px; cursor: pointer; display: flex; justify-content: space-between">
              <span>{{ p.name }} <span class="muted num" style="font-size: 12px">#{{ p.code }}</span></span>
              <span class="num">{{ rupiah(p.sell_price) }}</span>
            </div>
          </div>
        </div>
        <div class="field"><label>Kode produk</label><input v-model="formProductCode" placeholder="mis. TSEL5" /></div>
        <div class="field"><label>Nomor HP / ID Pelanggan tujuan</label><input v-model="formTarget" placeholder="mis. 081234567890" /></div>
        <div class="field">
          <label>Metode Bayar</label>
          <div style="display: flex; gap: 8px">
            <button type="button" class="btn" :class="{ ghost: formPaidMethod !== 'tunai' }" style="flex: 1; justify-content: center" @click="formPaidMethod = 'tunai'">Tunai/Bank</button>
            <button type="button" class="btn" :class="{ ghost: formPaidMethod !== 'utang' }" style="flex: 1; justify-content: center" @click="formPaidMethod = 'utang'">Utang</button>
          </div>
        </div>
        <div v-if="formPaidMethod === 'utang'" class="field">
          <label>Kontak</label>
          <select v-model.number="formContactId">
            <option :value="null" disabled>— pilih pelanggan —</option>
            <option v-for="c in contacts" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>
        <button type="button" class="btn ghost" style="width: 100%; justify-content: center" @click="tambahAntrean">+ Tambah ke Antrean</button>
      </div>

      <div class="card">
        <h3 style="margin-bottom: 10px">Antrean ({{ queue.length }})</h3>
        <div v-if="!queue.length" class="muted" style="padding: 12px 0">Belum ada produk di antrean.</div>
        <div v-for="(item, i) in queue" :key="i" style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px dashed var(--line)">
          <div>
            <div>{{ item.name }}</div>
            <div class="muted num" style="font-size: 12px">{{ item.target }} · {{ item.paidMethod === "utang" ? "Utang" : "Tunai" }}</div>
          </div>
          <button class="btn ghost" style="padding: 2px 8px; color: var(--red)" @click="hapusAntrean(i)">✕</button>
        </div>
        <button
          v-if="queue.length"
          class="btn"
          style="width: 100%; justify-content: center; margin-top: 12px"
          :disabled="processing"
          @click="prosesSemua"
        >
          {{ processing ? "Memproses satu-satu…" : `Proses Semua (${queue.length})` }}
        </button>

        <div v-if="batchResults.length" style="margin-top: 14px; border-top: 1px solid var(--line); padding-top: 10px">
          <p class="muted" style="font-size: 12.5px; margin-bottom: 6px">Hasil batch terakhir:</p>
          <div v-for="(r, i) in batchResults" :key="i" style="display: flex; justify-content: space-between; padding: 4px 0; font-size: 13.5px">
            <span>{{ r.name }} ({{ r.target }})</span>
            <span class="badge" :class="r.status">{{ r.status }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Kotak konfirmasi harga jual -->
    <div v-if="confirmTarget" class="receipt-modal-backdrop no-print" @click.self="confirmTarget = null">
      <div class="card" style="max-width: 420px; width: 100%">
        <h3 style="margin-bottom: 4px">Konfirmasi Transaksi Sukses</h3>
        <p class="muted" style="font-size: 13px; margin-bottom: 14px">{{ confirmTarget.product.name || confirmTarget.product.code }} → {{ confirmTarget.target }}</p>

        <div class="field">
          <label>Modal {{ confirmTarget.isPostpaid ? "(nominal tagihan asli, isi manual)" : "(otomatis dari sistem, pembanding saja)" }}</label>
          <input v-model.number="confirmForm.costTotal" type="number" :readonly="!confirmTarget.isPostpaid" :style="!confirmTarget.isPostpaid ? 'background:var(--paper); color:var(--ink-soft)' : ''" />
        </div>
        <div class="field">
          <label>Harga Jual (bisa disesuaikan)</label>
          <input v-model.number="confirmForm.sellPrice" type="number" />
        </div>
        <div v-if="confirmTarget.isToken" class="field">
          <label>Kode Token (dicoba dibaca otomatis — koreksi kalau salah)</label>
          <input v-model="confirmForm.tokenCode" placeholder="mis. 1234-5678-9012-3456" />
        </div>

        <div class="field">
          <label>Metode Bayar</label>
          <div style="display: flex; gap: 8px">
            <button type="button" class="btn" :class="{ ghost: confirmForm.paidMethod !== 'tunai' }" style="flex: 1; justify-content: center" @click="confirmForm.paidMethod = 'tunai'">Tunai/Bank</button>
            <button type="button" class="btn" :class="{ ghost: confirmForm.paidMethod !== 'utang' }" style="flex: 1; justify-content: center" @click="confirmForm.paidMethod = 'utang'">Utang</button>
          </div>
        </div>
        <div v-if="confirmForm.paidMethod === 'utang'" class="field">
          <label>Kontak</label>
          <select v-model.number="confirmForm.contactId">
            <option :value="null" disabled>— pilih pelanggan —</option>
            <option v-for="c in contacts" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>

        <p class="muted" style="font-size: 12px; margin: 8px 0 14px">
          Setelah disimpan, harga jual ini otomatis jadi harga default produk ini untuk transaksi berikutnya, dan tidak bisa diedit lagi lewat struk yang sama.
        </p>
        <button class="btn" style="width: 100%; justify-content: center; margin-bottom: 8px" :disabled="confirming" @click="submitKonfirmasi">
          {{ confirming ? "Menyimpan…" : "Simpan & Lanjut ke Struk" }}
        </button>
        <button class="btn ghost" style="width: 100%; justify-content: center" @click="confirmTarget = null">Nanti Saja</button>
      </div>
    </div>

    <!-- Struk hasil konfirmasi terakhir -->
    <div v-if="lastReceipt" class="card no-print" style="margin-bottom: 18px">
      <h3 style="margin-bottom: 10px">Transaksi Terakhir: {{ lastReceipt.refId }}</h3>
      <button class="btn ghost" style="margin-right: 8px" @click="cetakStruk">🖨️ Cetak Struk</button>
      <button class="btn ghost" @click="bagikanWA">📤 Bagikan via WhatsApp</button>
    </div>
    <div v-if="lastReceipt" class="receipt-box" style="display: none">
      <div style="text-align: center; margin-bottom: 6px">
        <strong>STRUK PPOB</strong>
        <div>{{ lastReceipt.date }}</div>
      </div>
      <hr />
      <div>{{ lastReceipt.productName }}</div>
      <div>Tujuan: {{ lastReceipt.target }}</div>
      <div v-if="lastReceipt.tokenCode">Token: {{ lastReceipt.tokenCode }}</div>
      <hr />
      <div class="receipt-row"><strong>TOTAL</strong><strong>{{ rupiah(lastReceipt.sellPrice) }}</strong></div>
      <div v-if="lastReceipt.paidMethod === 'utang'" style="margin-top: 6px">Utang a.n. {{ lastReceipt.contactName }}</div>
      <div style="text-align: center; margin-top: 10px">Terima kasih!</div>
    </div>

    <div class="card">
      <h3 style="margin-bottom: 12px">Riwayat Order — {{ activeProvider === "digiflazz" ? "Digiflazz" : "OkeConnect" }}</h3>
      <table>
        <thead>
          <tr>
            <th>Ref</th>
            <th>Produk</th>
            <th>Tujuan</th>
            <th>Status</th>
            <th>Waktu</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="o in filteredOrders" :key="o.id">
            <tr @click="toggleDetail(o)" style="cursor: pointer">
              <td class="num">{{ o.ref_id }}</td>
              <td>{{ o.product_code }}</td>
              <td class="num">{{ o.target }}</td>
              <td>
                <span class="badge" :class="o.status">{{ o.status }}</span>
                <span v-if="o.status === 'sukses' && !o.finalized" class="badge gagal" style="margin-left: 4px">belum dicatat</span>
              </td>
              <td class="muted" style="font-size: 12.5px">{{ new Date(o.created_at).toLocaleString("id-ID") }}</td>
            </tr>
            <tr v-if="openedId === o.id">
              <td colspan="5" style="background: var(--paper); padding: 14px 16px">
                <div class="grid cols-2" style="gap: 6px 24px; font-size: 13.5px">
                  <div><span class="muted">Ref ID</span><br /><span class="num">{{ o.ref_id }}</span></div>
                  <div><span class="muted">Status</span><br /><span class="badge" :class="o.status">{{ o.status }}</span></div>
                  <div><span class="muted">Kode Produk</span><br />{{ o.product_code }}</div>
                  <div><span class="muted">Tujuan (No. HP / ID Pelanggan)</span><br /><span class="num">{{ o.target }}</span></div>
                  <div><span class="muted">Modal (cost_price)</span><br /><span class="num">{{ rupiah(o.cost_price) }}</span></div>
                  <div><span class="muted">Harga Jual (sell_price)</span><br /><span class="num">{{ rupiah(o.sell_price) }}</span></div>
                  <div><span class="muted">Dibuat</span><br />{{ new Date(o.created_at).toLocaleString("id-ID") }}</div>
                  <div><span class="muted">Diperbarui</span><br />{{ new Date(o.updated_at).toLocaleString("id-ID") }}</div>
                  <div><span class="muted">Metode Bayar</span><br />{{ o.paid_method === "utang" ? "Utang" : "Tunai/Bank" }}</div>
                  <div v-if="o.token_code"><span class="muted">Token</span><br /><span class="num">{{ o.token_code }}</span></div>
                  <div v-if="o.status === 'sukses'"><span class="muted">Sudah dicatat sebagai transaksi?</span><br />{{ o.finalized ? "Ya" : "Belum" }}</div>
                </div>
                <div style="margin-top: 10px">
                  <span class="muted" style="font-size: 13px">Balasan mentah dari provider</span>
                  <div class="num" style="white-space: pre-wrap; background: var(--paper-raised); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px; margin-top: 4px; font-size: 13px">{{ o.raw_reply || "(kosong)" }}</div>
                </div>

                <div v-if="editingStatus && editingStatus.ref_id === o.ref_id" style="margin-top: 12px; border-top: 1px solid var(--line); padding-top: 12px">
                  <div class="form-row">
                    <div class="field">
                      <label>Status (koreksi manual)</label>
                      <select v-model="editingStatus.status">
                        <option value="pending">Pending</option>
                        <option value="sukses">Sukses</option>
                        <option value="gagal">Gagal</option>
                      </select>
                    </div>
                  </div>
                  <div class="field"><label>Balasan (opsional)</label><input v-model="editingStatus.raw_reply" /></div>
                  <p class="muted" style="font-size: 12px; margin-bottom: 8px">
                    Kalau status diubah KELUAR dari "Sukses", transaksi &amp; saldo dompet yang sempat tercatat untuk order ini akan otomatis dibalikkan.
                  </p>
                  <button class="btn" style="padding: 4px 10px" @click.stop="saveEditStatus">Simpan Koreksi</button>
                  <button class="btn ghost" style="padding: 4px 10px" @click.stop="editingStatus = null">Batal</button>
                </div>
                <div v-else style="margin-top: 12px">
                  <button
                    v-if="o.status === 'sukses' && !o.finalized"
                    class="btn"
                    style="padding: 4px 10px; margin-right: 6px"
                    @click.stop="openConfirm(o)"
                  >
                    Konfirmasi &amp; Catat
                  </button>
                  <button
                    v-if="o.status === 'pending'"
                    class="btn ghost"
                    style="padding: 4px 10px; margin-right: 6px"
                    :disabled="checkingRef === o.ref_id"
                    @click.stop="cekUlang(o)"
                  >
                    {{ checkingRef === o.ref_id ? "Mengecek…" : "Cek Ulang Status" }}
                  </button>
                  <button class="btn ghost" style="padding: 4px 10px; margin-right: 6px" @click.stop="startEditStatus(o)">Koreksi Status</button>
                  <button class="btn ghost" style="padding: 4px 10px; color: #b3392c" @click.stop="hapusOrder(o)">Hapus Order</button>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="!filteredOrders.length">
            <td colspan="5" class="muted">Belum ada order PPOB untuk provider ini.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
@media print {
  .receipt-box {
    display: block !important;
  }
}
</style>
