<script setup>
import { ref, computed, onMounted } from "vue";
import { api } from "../api.js";

const products = ref([]);
const search = ref("");
const error = ref("");
const okMsg = ref("");
const editing = ref(null); // product object being edited, or null
const showAdd = ref(false);
const syncing = ref(false);

const blank = () => ({ code: "", barcode: "", name: "", category: "", cost_price: 0, sell_price: 0, stock: 0 });
const form = ref(blank());

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

const filtered = computed(() => {
  if (!search.value.trim()) return products.value;
  const q = search.value.toLowerCase();
  return products.value.filter((p) => p.name.toLowerCase().includes(q) || (p.code || "").includes(q) || (p.barcode || "").includes(q));
});

async function load() {
  products.value = await api.get("/api/products");
}

async function submitAdd() {
  error.value = "";
  try {
    await api.post("/api/products", form.value);
    form.value = blank();
    showAdd.value = false;
    okMsg.value = "Produk ditambahkan.";
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

function startEdit(p) {
  editing.value = { ...p };
}

async function saveEdit() {
  error.value = "";
  try {
    await api.put(`/api/products/${editing.value.id}`, editing.value);
    editing.value = null;
    okMsg.value = "Produk diperbarui.";
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

async function syncPrices() {
  error.value = "";
  okMsg.value = "";
  syncing.value = true;
  try {
    const res = await api.post("/api/products/sync", {});
    okMsg.value = `Sinkron selesai — ${res.synced} produk PPOB diperbarui.`;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    syncing.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Produk &amp; Stok</h1>
        <p>Barang fisik warung dan kode produk PPOB dalam satu daftar</p>
      </div>
      <div style="display: flex; gap: 8px">
        <button class="btn ghost" :disabled="syncing" @click="syncPrices">{{ syncing ? "Sinkron…" : "Sinkron Harga PPOB" }}</button>
        <button class="btn" @click="showAdd = !showAdd">{{ showAdd ? "Batal" : "+ Produk Baru" }}</button>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>
    <div v-if="okMsg" class="ok-box">{{ okMsg }}</div>

    <div v-if="showAdd" class="card" style="margin-bottom: 18px">
      <h3 style="margin-bottom: 12px">Tambah Produk</h3>
      <form @submit.prevent="submitAdd">
        <div class="form-row">
          <div class="field"><label>Nama</label><input v-model="form.name" required /></div>
          <div class="field"><label>Kategori</label><input v-model="form.category" placeholder="mis. Sembako / Pulsa Telkomsel" /></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Kode PPOB (opsional)</label><input v-model="form.code" placeholder="mis. TSEL5" /></div>
          <div class="field"><label>Barcode fisik (opsional)</label><input v-model="form.barcode" /></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Harga Modal</label><input v-model.number="form.cost_price" type="number" min="0" /></div>
          <div class="field"><label>Harga Jual</label><input v-model.number="form.sell_price" type="number" min="0" /></div>
          <div class="field"><label>Stok</label><input v-model.number="form.stock" type="number" min="0" /></div>
        </div>
        <button class="btn" type="submit">Simpan Produk</button>
      </form>
    </div>

    <div class="card">
      <div class="field" style="max-width: 320px">
        <input v-model="search" placeholder="Cari nama, kode, atau barcode…" />
      </div>
      <table>
        <thead>
          <tr>
            <th>Nama</th>
            <th>Kode / Barcode</th>
            <th>Modal</th>
            <th>Jual</th>
            <th>Stok</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in filtered" :key="p.id">
            <template v-if="editing && editing.id === p.id">
              <td><input v-model="editing.name" /></td>
              <td><input v-model="editing.barcode" style="width: 110px" /></td>
              <td><input v-model.number="editing.cost_price" type="number" style="width: 90px" /></td>
              <td><input v-model.number="editing.sell_price" type="number" style="width: 90px" /></td>
              <td><input v-model.number="editing.stock" type="number" style="width: 70px" /></td>
              <td style="white-space: nowrap">
                <button class="btn" style="padding: 4px 10px" @click="saveEdit">Simpan</button>
                <button class="btn ghost" style="padding: 4px 10px" @click="editing = null">Batal</button>
              </td>
            </template>
            <template v-else>
              <td>
                {{ p.name }}
                <div class="muted" style="font-size: 12px">{{ p.category }}</div>
              </td>
              <td class="muted num" style="font-size: 12.5px">{{ p.code || p.barcode || "—" }}</td>
              <td class="num">{{ rupiah(p.cost_price) }}</td>
              <td class="num">{{ rupiah(p.sell_price) }}</td>
              <td class="num" :style="{ color: p.stock <= 3 && !p.code ? 'var(--red)' : 'inherit' }">{{ p.code ? "—" : p.stock }}</td>
              <td><button class="btn ghost" style="padding: 4px 10px" @click="startEdit(p)">Ubah</button></td>
            </template>
          </tr>
          <tr v-if="!filtered.length">
            <td colspan="6" class="muted">Belum ada produk.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
