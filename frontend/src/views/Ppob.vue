<script setup>
import { ref, computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import { api } from "../api.js";

const route = useRoute();

const orders = ref([]);
const products = ref([]);
const productCode = ref("");
const target = ref("");
const error = ref("");
const result = ref(null);
const submitting = ref(false);
const search = ref("");
const openedId = ref(null);

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

function toggleDetail(o) {
  openedId.value = openedId.value === o.id ? null : o.id;
}

const ppobProducts = computed(() => products.value.filter((p) => p.code));
const searchResults = computed(() => {
  if (!search.value.trim()) return [];
  const q = search.value.toLowerCase();
  return ppobProducts.value.filter((p) => p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)).slice(0, 8);
});

async function load() {
  const [o, p] = await Promise.all([api.get("/api/ppob-orders"), api.get("/api/products")]);
  orders.value = o;
  products.value = p;
  if (route.query.code) {
    const match = products.value.find((x) => x.code === route.query.code);
    if (match) pick(match);
  }
}

function pick(p) {
  productCode.value = p.code;
  search.value = `${p.name} (${p.code})`;
}

async function submitOrder() {
  error.value = "";
  result.value = null;
  if (!productCode.value || !target.value) {
    error.value = "Kode produk dan nomor/ID tujuan wajib diisi.";
    return;
  }
  submitting.value = true;
  try {
    const res = await api.post("/api/ppob/order", { productCode: productCode.value, target: target.value });
    result.value = res;
    target.value = "";
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    submitting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Pulsa &amp; PPOB</h1>
        <p>Order dikirim ke OkeConnect lewat Jabber — status diperbarui otomatis tiap beberapa menit</p>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>
    <div v-if="result" class="ok-box">
      Order {{ result.refId }} — status: <strong>{{ result.status }}</strong>
      <span v-if="result.reply"> · balasan: {{ result.reply }}</span>
    </div>

    <div class="grid cols-2" style="align-items: start; margin-bottom: 22px">
      <div class="card">
        <h3 style="margin-bottom: 12px">Order Baru</h3>
        <form @submit.prevent="submitOrder">
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
          <div class="field">
            <label>Kode produk</label>
            <input v-model="productCode" placeholder="mis. TSEL5" required />
          </div>
          <div class="field">
            <label>Nomor HP / ID Pelanggan tujuan</label>
            <input v-model="target" placeholder="mis. 081234567890" required />
          </div>
          <button class="btn" :disabled="submitting">{{ submitting ? "Mengirim…" : "Kirim Order" }}</button>
        </form>
      </div>

      <div class="card">
        <h3 style="margin-bottom: 8px">Cara kerja</h3>
        <p class="muted" style="font-size: 13.5px">
          Order dikirim sebagai pesan Jabber ke OkeConnect. Jika ada balasan cepat, statusnya langsung
          "sukses" atau "gagal". Jika tidak, order tetap "pending" dan dicek ulang otomatis oleh cron
          setiap 5 menit sampai ada kepastian.
        </p>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-bottom: 12px">Riwayat Order</h3>
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
          <template v-for="o in orders" :key="o.id">
            <tr @click="toggleDetail(o)" style="cursor: pointer">
              <td class="num">{{ o.ref_id }}</td>
              <td>{{ o.product_code }}</td>
              <td class="num">{{ o.target }}</td>
              <td><span class="badge" :class="o.status">{{ o.status }}</span></td>
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
                  <div v-if="o.status === 'sukses'"><span class="muted">Sudah dicatat sebagai transaksi?</span><br />{{ o.finalized ? "Ya" : "Belum" }}</div>
                </div>
                <div style="margin-top: 10px">
                  <span class="muted" style="font-size: 13px">Balasan mentah dari OkeConnect</span>
                  <div class="num" style="white-space: pre-wrap; background: var(--paper-raised); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px; margin-top: 4px; font-size: 13px">{{ o.raw_reply || "(kosong)" }}</div>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="!orders.length">
            <td colspan="5" class="muted">Belum ada order PPOB.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
