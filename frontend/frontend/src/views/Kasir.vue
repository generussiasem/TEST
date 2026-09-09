<script setup>
import { ref, computed, onMounted, nextTick } from "vue";
import { api } from "../api.js";

const products = ref([]);
const wallets = ref([]);
const cart = ref([]); // { product, qty }
const barcodeInput = ref("");
const search = ref("");
const walletId = ref(null);
const error = ref("");
const okMsg = ref("");
const scanRef = ref(null);
const submitting = ref(false);

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
  const [p, w] = await Promise.all([api.get("/api/products"), api.get("/api/wallets")]);
  products.value = p;
  wallets.value = w.filter((x) => x.type !== "distributor_ppob");
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
  error.value = "";
  okMsg.value = "";
  submitting.value = true;
  try {
    await api.post("/api/transactions", {
      type: "sale",
      category: "Penjualan Warung",
      wallet_id: walletId.value,
      items: cart.value.map((l) => ({ product_id: l.product.id, qty: l.qty })),
    });
    okMsg.value = `Transaksi berhasil dicatat — total ${rupiah(total.value)}.`;
    cart.value = [];
    await load(); // refresh stok
  } catch (err) {
    error.value = err.message;
  } finally {
    submitting.value = false;
  }
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
              <span>{{ p.name }} <span class="muted" style="font-size: 12px">{{ p.code ? `#${p.code}` : "" }}</span></span>
              <span class="num">{{ rupiah(p.sell_price) }}</span>
            </div>
          </div>
        </div>

        <div class="field">
          <label>Bayar dari akun</label>
          <select v-model.number="walletId">
            <option v-for="w in wallets" :key="w.id" :value="w.id">{{ w.name }}</option>
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
  </div>
</template>
