<script setup>
import { ref, computed, onMounted, nextTick } from "vue";
import { api } from "../api.js";

const products = ref([]);
const wallets = ref([]);
const contacts = ref([]);
const cart = ref([]); // { product, qty }
const barcodeInput = ref("");
const search = ref("");
const walletId = ref(null);
const paidMethod = ref("tunai"); // tunai | utang
const contactId = ref(null);
const error = ref("");
const okMsg = ref("");
const scanRef = ref(null);
const submitting = ref(false);
const lastReceipt = ref(null); // { items, total, cost, paidMethod, contactName, date }

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

const total = computed(() => cart.value.reduce((s, l) => s + l.product.sell_price * l.qty, 0));
const cost = computed(() => cart.value.reduce((s, l) => s + l.product.cost_price * l.qty, 0));

const searchResults = computed(() => {
  if (!search.value.trim()) return [];
  const q = search.value.toLowerCase();
  return products.value
    .filter((p) => p.name.toLowerCase().includes(q) || (p.code || "").toLowerCase().includes(q))
    .slice(0, 8);
});

async function load() {
  // PENTING: type=fisik supaya produk PPOB (pulsa/token/dst) TIDAK ikut
  // muncul di pencarian Kasir — dulu ini bug, Kasir bisa "menjual" produk PPOB
  // yang harusnya cuma lewat menu PPOB tersendiri.
  const [p, w, c] = await Promise.all([
    api.get("/api/products?type=fisik"),
    api.get("/api/wallets"),
    api.get("/api/contacts?type=pelanggan"),
  ]);
  products.value = p;
  wallets.value = w.filter((x) => x.type !== "distributor_ppob");
  contacts.value = c;
  if (wallets.value.length) walletId.value = wallets.value[0].id;
}

function addToCart(product) {
  const existing = cart.value.find((l) => l.product.id === product.id);
  if (existing) existing.qty += 1;
  else cart.value.push({ product, qty: 1 });
  search.value = "";
  nextTick(() => scanRef.value?.focus());
}

async function scanBarcode() {
  error.value = "";
  const code = barcodeInput.value.trim();
  barcodeInput.value = "";
  if (!code) return;
  try {
    const product = await api.get(`/api/products/barcode/${encodeURIComponent(code)}`);
    addToCart(product);
  } catch (err) {
    error.value = `Barcode "${code}" tidak ditemukan.`;
  }
}

function changeQty(line, delta) {
  line.qty += delta;
  if (line.qty <= 0) cart.value = cart.value.filter((l) => l !== line);
}

function removeLine(line) {
  cart.value = cart.value.filter((l) => l !== line);
}

async function checkout() {
  if (!cart.value.length) return;
  if (paidMethod.value === "utang" && !contactId.value) {
    error.value = "Pilih kontak dulu untuk pembayaran Utang.";
    return;
  }
  error.value = "";
  okMsg.value = "";
  submitting.value = true;
  try {
    const snapshot = {
      items: cart.value.map((l) => ({ name: l.product.name, qty: l.qty, sell_price: l.product.sell_price })),
      total: total.value,
      cost: cost.value,
      paidMethod: paidMethod.value,
      contactName: contactId.value ? contacts.value.find((x) => x.id === contactId.value)?.name : null,
      date: new Date().toLocaleString("id-ID"),
    };
    await api.post("/api/transactions", {
      type: "sale",
      category: "Penjualan Warung",
      wallet_id: paidMethod.value === "tunai" ? walletId.value : null,
      contact_id: paidMethod.value === "utang" ? contactId.value : null,
      paid_method: paidMethod.value,
      items: cart.value.map((l) => ({ product_id: l.product.id, qty: l.qty })),
    });
    okMsg.value = `Transaksi berhasil dicatat — total ${rupiah(total.value)}.`;
    lastReceipt.value = snapshot;
    cart.value = [];
    await load(); // refresh stok
  } catch (err) {
    error.value = err.message;
  } finally {
    submitting.value = false;
  }
}

function cetakStruk() {
  window.print();
}

function bagikanWA() {
  if (!lastReceipt.value) return;
  const r = lastReceipt.value;
  let text = `*Struk Belanja*\n${r.date}\n\n`;
  for (const it of r.items) text += `${it.name} x${it.qty} — ${rupiah(it.sell_price * it.qty)}\n`;
  text += `\n*Total: ${rupiah(r.total)}*`;
  if (r.paidMethod === "utang") text += `\n(Utang atas nama ${r.contactName})`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
}

onMounted(async () => {
  await load();
  scanRef.value?.focus();
});
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Kasir</h1>
        <p>Scan barcode atau cari produk untuk memulai transaksi</p>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>
    <div v-if="okMsg" class="ok-box">{{ okMsg }}</div>

    <div class="grid cols-2" style="align-items: start">
      <div class="card">
        <div class="field">
          <label>Scan barcode</label>
          <input ref="scanRef" v-model="barcodeInput" @keyup.enter="scanBarcode" placeholder="Tembak barcode di sini, lalu Enter" />
        </div>
        <div class="field" style="position: relative">
          <label>Atau cari nama/kode produk</label>
          <input v-model="search" placeholder="Ketik nama barang…" />
          <div v-if="searchResults.length" class="card" style="position: absolute; top: 100%; left: 0; right: 0; z-index: 5; padding: 6px; max-height: 240px; overflow: auto">
            <div
              v-for="p in searchResults"
              :key="p.id"
              @click="addToCart(p)"
              style="padding: 8px; cursor: pointer; border-radius: var(--radius); display: flex; justify-content: space-between"
              onmouseover="this.style.background='var(--paper)'"
              onmouseout="this.style.background='transparent'"
            >
              <span>{{ p.name }}</span>
              <span class="num">{{ rupiah(p.sell_price) }}</span>
            </div>
          </div>
        </div>

        <div class="field">
          <label>Metode Bayar</label>
          <div style="display: flex; gap: 8px">
            <button class="btn" :class="{ ghost: paidMethod !== 'tunai' }" style="flex: 1; justify-content: center" @click="paidMethod = 'tunai'">Tunai/Bank</button>
            <button class="btn" :class="{ ghost: paidMethod !== 'utang' }" style="flex: 1; justify-content: center" @click="paidMethod = 'utang'">Utang</button>
          </div>
        </div>

        <div v-if="paidMethod === 'tunai'" class="field">
          <label>Bayar dari akun</label>
          <select v-model.number="walletId">
            <option v-for="w in wallets" :key="w.id" :value="w.id">{{ w.name }}</option>
          </select>
        </div>
        <div v-else class="field">
          <label>Kontak (wajib)</label>
          <select v-model.number="contactId">
            <option :value="null" disabled>— pilih pelanggan —</option>
            <option v-for="c in contacts" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>
      </div>

      <div class="ticket">
        <div style="padding: 16px 18px" class="ticket-tear">
          <h3>Struk</h3>
          <p class="muted" style="font-size: 12px">{{ cart.length }} item</p>
        </div>
        <div style="padding: 10px 18px; max-height: 320px; overflow: auto">
          <div v-if="!cart.length" class="muted" style="padding: 20px 0; text-align: center">Keranjang kosong.</div>
          <div v-for="line in cart" :key="line.product.id" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed var(--line)">
            <div>
              <div>{{ line.product.name }}</div>
              <div class="muted num" style="font-size: 12px">{{ rupiah(line.product.sell_price) }} × {{ line.qty }}</div>
            </div>
            <div style="display: flex; align-items: center; gap: 6px">
              <button class="btn ghost" style="padding: 2px 8px" @click="changeQty(line, -1)">−</button>
              <span class="num">{{ line.qty }}</span>
              <button class="btn ghost" style="padding: 2px 8px" @click="changeQty(line, 1)">+</button>
              <button class="btn ghost" style="padding: 2px 8px; color: var(--red)" @click="removeLine(line)">✕</button>
            </div>
          </div>
        </div>
        <div style="padding: 16px 18px; border-top: 1px dashed var(--line)">
          <div style="display: flex; justify-content: space-between; font-size: 18px; margin-bottom: 4px">
            <strong>Total</strong>
            <strong class="num">{{ rupiah(total) }}</strong>
          </div>
          <div class="muted num" style="font-size: 12px; margin-bottom: 14px">Modal {{ rupiah(cost) }} · Laba {{ rupiah(total - cost) }}</div>
          <button class="btn" style="width: 100%; justify-content: center" :disabled="!cart.length || submitting" @click="checkout">
            {{ submitting ? "Memproses…" : "Selesaikan Transaksi" }}
          </button>
        </div>
      </div>
    </div>

    <!-- Struk hasil transaksi terakhir -->
    <div v-if="lastReceipt" class="card no-print" style="margin-top: 18px">
      <h3 style="margin-bottom: 10px">Transaksi Terakhir</h3>
      <button class="btn ghost" style="margin-right: 8px" @click="cetakStruk">🖨️ Cetak Struk</button>
      <button class="btn ghost" @click="bagikanWA">📤 Bagikan via WhatsApp</button>
    </div>

    <div v-if="lastReceipt" class="receipt-box" style="display: none">
      <div style="text-align: center; margin-bottom: 6px">
        <strong>STRUK BELANJA</strong>
        <div>{{ lastReceipt.date }}</div>
      </div>
      <hr />
      <div v-for="(it, i) in lastReceipt.items" :key="i" class="receipt-row">
        <span>{{ it.name }} x{{ it.qty }}</span>
        <span>{{ rupiah(it.sell_price * it.qty) }}</span>
      </div>
      <hr />
      <div class="receipt-row"><strong>TOTAL</strong><strong>{{ rupiah(lastReceipt.total) }}</strong></div>
      <div v-if="lastReceipt.paidMethod === 'utang'" style="margin-top: 6px">Utang a.n. {{ lastReceipt.contactName }}</div>
      <div style="text-align: center; margin-top: 10px">Terima kasih!</div>
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
