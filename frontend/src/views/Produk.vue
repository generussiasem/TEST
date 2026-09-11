<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { api } from "../api.js";

const tab = ref("fisik"); // "fisik" | "ppob"

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

// ---------------------------------------------------------------------------
// TAB: STOK FISIK — barang warung biasa (code kosong), dengan manajemen stok
// ---------------------------------------------------------------------------

const fisikList = ref([]);
const fisikSearch = ref("");
const fisikEditing = ref(null);
const fisikShowAdd = ref(false);
const fisikError = ref("");
const fisikOkMsg = ref("");

const blankFisik = () => ({ code: "", barcode: "", name: "", category: "", cost_price: 0, sell_price: 0, stock: 0 });
const fisikForm = ref(blankFisik());

const fisikFiltered = computed(() => {
  if (!fisikSearch.value.trim()) return fisikList.value;
  const q = fisikSearch.value.toLowerCase();
  return fisikList.value.filter((p) => p.name.toLowerCase().includes(q) || (p.barcode || "").includes(q));
});

async function loadFisik() {
  fisikList.value = await api.get("/api/products?type=fisik");
}

async function submitFisikAdd() {
  fisikError.value = "";
  try {
    await api.post("/api/products", fisikForm.value);
    fisikForm.value = blankFisik();
    fisikShowAdd.value = false;
    fisikOkMsg.value = "Produk ditambahkan.";
    await loadFisik();
  } catch (err) {
    fisikError.value = err.message;
  }
}

function startFisikEdit(p) {
  fisikEditing.value = { ...p };
}

async function saveFisikEdit() {
  fisikError.value = "";
  try {
    await api.put(`/api/products/${fisikEditing.value.id}`, fisikEditing.value);
    fisikEditing.value = null;
    fisikOkMsg.value = "Produk diperbarui.";
    await loadFisik();
  } catch (err) {
    fisikError.value = err.message;
  }
}

async function hapusFisik(p) {
  if (!confirm(`Hapus produk "${p.name}"?`)) return;
  fisikError.value = "";
  try {
    await api.delete(`/api/products/${p.id}`);
    fisikOkMsg.value = "Produk dihapus.";
    await loadFisik();
  } catch (err) {
    fisikError.value = err.message;
  }
}

// ---------------------------------------------------------------------------
// TAB: PRODUK PPOB — daftar dari sinkron OkeConnect, berpaginasi (50/halaman)
// ---------------------------------------------------------------------------

const ppobItems = ref([]);
const ppobTotal = ref(0);
const ppobPage = ref(1);
const ppobPageSize = 50;
const ppobSearch = ref("");
const ppobLoading = ref(false);
const ppobEditing = ref(null);
const ppobError = ref("");
const ppobOkMsg = ref("");
const syncing = ref(false);

const ppobTotalPages = computed(() => Math.max(1, Math.ceil(ppobTotal.value / ppobPageSize)));

async function loadPpob() {
  ppobLoading.value = true;
  ppobError.value = "";
  try {
    const qs = new URLSearchParams({ type: "ppob", page: ppobPage.value, pageSize: ppobPageSize });
    if (ppobSearch.value.trim()) qs.set("q", ppobSearch.value.trim());
    const res = await api.get(`/api/products?${qs.toString()}`);
    ppobItems.value = res.items;
    ppobTotal.value = res.total;
  } catch (err) {
    ppobError.value = err.message;
  } finally {
    ppobLoading.value = false;
  }
}

function gotoPage(p) {
  if (p < 1 || p > ppobTotalPages.value) return;
  ppobPage.value = p;
}

// Cari ulang dari halaman 1 tiap kali kata kunci berubah (biar tidak nyasar
// ke halaman lama yang sudah tidak relevan dengan pencarian baru)
watch(ppobSearch, () => {
  ppobPage.value = 1;
  loadPpob();
});
watch(ppobPage, loadPpob);

function startPpobEdit(p) {
  ppobEditing.value = { ...p };
}

async function savePpobEdit() {
  ppobError.value = "";
  try {
    await api.put(`/api/products/${ppobEditing.value.id}`, ppobEditing.value);
    ppobEditing.value = null;
    ppobOkMsg.value = "Produk diperbarui.";
    await loadPpob();
  } catch (err) {
    ppobError.value = err.message;
  }
}

async function toggleActive(p) {
  ppobError.value = "";
  try {
    await api.put(`/api/products/${p.id}/active`, { active: p.active ? 0 : 1 });
    await loadPpob();
  } catch (err) {
    ppobError.value = err.message;
  }
}

async function hapusPpob(p) {
  if (!confirm(`Hapus permanen produk "${p.name}"?`)) return;
  ppobError.value = "";
  try {
    await api.delete(`/api/products/${p.id}`);
    ppobOkMsg.value = "Produk dihapus.";
    await loadPpob();
  } catch (err) {
    ppobError.value = err.message;
  }
}

async function syncPrices() {
  ppobError.value = "";
  ppobOkMsg.value = "";
  syncing.value = true;
  try {
    const res = await api.post("/api/products/sync", {});
    ppobOkMsg.value =
      `Sinkron selesai — ${res.synced} dari ${res.total} produk diperbarui` +
      (res.deactivated ? `, ${res.deactivated} dinonaktifkan otomatis (sudah tidak ada di sumber)` : "") +
      (res.skipped ? `, ${res.skipped} dilewati karena data tidak lengkap` : "") +
      ".";
    ppobPage.value = 1;
    await loadPpob();
  } catch (err) {
    ppobError.value = err.message;
  } finally {
    syncing.value = false;
  }
}

function switchTab(t) {
  tab.value = t;
  if (t === "ppob" && !ppobItems.value.length) loadPpob();
}

onMounted(async () => {
  await loadFisik();
});
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Produk &amp; Stok</h1>
        <p>Barang fisik warung dan produk PPOB dikelola terpisah</p>
      </div>
    </div>

    <div style="display: flex; gap: 8px; margin-bottom: 16px">
      <button class="btn" :class="{ ghost: tab !== 'fisik' }" @click="switchTab('fisik')">Stok Fisik</button>
      <button class="btn" :class="{ ghost: tab !== 'ppob' }" @click="switchTab('ppob')">Produk PPOB</button>
    </div>

    <!-- ============================== TAB STOK FISIK ============================== -->
    <div v-if="tab === 'fisik'">
      <div v-if="fisikError" class="error-box">{{ fisikError }}</div>
      <div v-if="fisikOkMsg" class="ok-box">{{ fisikOkMsg }}</div>

      <div class="page-head">
        <div></div>
        <button class="btn" @click="fisikShowAdd = !fisikShowAdd">{{ fisikShowAdd ? "Batal" : "+ Produk Baru" }}</button>
      </div>

      <div v-if="fisikShowAdd" class="card" style="margin-bottom: 18px">
        <h3 style="margin-bottom: 12px">Tambah Produk Fisik</h3>
        <form @submit.prevent="submitFisikAdd">
          <div class="form-row">
            <div class="field"><label>Nama</label><input v-model="fisikForm.name" required /></div>
            <div class="field"><label>Kategori</label><input v-model="fisikForm.category" placeholder="mis. Sembako" /></div>
          </div>
          <div class="field"><label>Barcode fisik (opsional)</label><input v-model="fisikForm.barcode" /></div>
          <div class="form-row">
            <div class="field"><label>Harga Modal</label><input v-model.number="fisikForm.cost_price" type="number" min="0" /></div>
            <div class="field"><label>Harga Jual</label><input v-model.number="fisikForm.sell_price" type="number" min="0" /></div>
            <div class="field"><label>Stok</label><input v-model.number="fisikForm.stock" type="number" min="0" /></div>
          </div>
          <button class="btn" type="submit">Simpan Produk</button>
        </form>
      </div>

      <div class="card">
        <div class="field" style="max-width: 320px">
          <input v-model="fisikSearch" placeholder="Cari nama atau barcode…" />
        </div>
        <table>
          <thead>
            <tr>
              <th>Nama</th>
              <th>Barcode</th>
              <th>Modal</th>
              <th>Jual</th>
              <th>Stok</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in fisikFiltered" :key="p.id">
              <template v-if="fisikEditing && fisikEditing.id === p.id">
                <td><input v-model="fisikEditing.name" /></td>
                <td><input v-model="fisikEditing.barcode" style="width: 110px" /></td>
                <td><input v-model.number="fisikEditing.cost_price" type="number" style="width: 90px" /></td>
                <td><input v-model.number="fisikEditing.sell_price" type="number" style="width: 90px" /></td>
                <td><input v-model.number="fisikEditing.stock" type="number" style="width: 70px" /></td>
                <td style="white-space: nowrap">
                  <button class="btn" style="padding: 4px 10px" @click="saveFisikEdit">Simpan</button>
                  <button class="btn ghost" style="padding: 4px 10px" @click="fisikEditing = null">Batal</button>
                </td>
              </template>
              <template v-else>
                <td>
                  {{ p.name }}
                  <div class="muted" style="font-size: 12px">{{ p.category }}</div>
                </td>
                <td class="muted num" style="font-size: 12.5px">{{ p.barcode || "—" }}</td>
                <td class="num">{{ rupiah(p.cost_price) }}</td>
                <td class="num">{{ rupiah(p.sell_price) }}</td>
                <td class="num" :style="{ color: p.stock <= 3 ? 'var(--red)' : 'inherit' }">{{ p.stock }}</td>
                <td style="white-space: nowrap">
                  <button class="btn ghost" style="padding: 4px 10px; margin-right: 6px" @click="startFisikEdit(p)">Ubah</button>
                  <button class="btn ghost" style="padding: 4px 10px; color: #b3392c" @click="hapusFisik(p)">Hapus</button>
                </td>
              </template>
            </tr>
            <tr v-if="!fisikFiltered.length">
              <td colspan="6" class="muted">Belum ada produk fisik.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ============================== TAB PRODUK PPOB ============================== -->
    <div v-if="tab === 'ppob'">
      <div v-if="ppobError" class="error-box">{{ ppobError }}</div>
      <div v-if="ppobOkMsg" class="ok-box">{{ ppobOkMsg }}</div>

      <div class="page-head">
        <div></div>
        <button class="btn ghost" :disabled="syncing" @click="syncPrices">{{ syncing ? "Sinkron…" : "Sinkron Harga PPOB" }}</button>
      </div>

      <div class="card">
        <div class="field" style="max-width: 320px">
          <input v-model="ppobSearch" placeholder="Cari nama atau kode…" />
        </div>

        <p class="muted" style="font-size: 13px; margin-bottom: 8px">
          {{ ppobTotal }} produk total — halaman {{ ppobPage }} dari {{ ppobTotalPages }}
        </p>

        <table>
          <thead>
            <tr>
              <th>Nama</th>
              <th>Kode</th>
              <th>Modal</th>
              <th>Jual</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in ppobItems" :key="p.id" :style="{ opacity: p.active ? 1 : 0.55 }">
              <template v-if="ppobEditing && ppobEditing.id === p.id">
                <td><input v-model="ppobEditing.name" /></td>
                <td class="muted num" style="font-size: 12.5px">{{ p.code }}</td>
                <td><input v-model.number="ppobEditing.cost_price" type="number" style="width: 90px" /></td>
                <td><input v-model.number="ppobEditing.sell_price" type="number" style="width: 90px" /></td>
                <td><span class="badge" :class="p.active ? 'sukses' : 'gagal'">{{ p.active ? "Aktif" : "Nonaktif" }}</span></td>
                <td style="white-space: nowrap">
                  <button class="btn" style="padding: 4px 10px" @click="savePpobEdit">Simpan</button>
                  <button class="btn ghost" style="padding: 4px 10px" @click="ppobEditing = null">Batal</button>
                </td>
              </template>
              <template v-else>
                <td>
                  {{ p.name }}
                  <div class="muted" style="font-size: 12px">{{ p.category }}</div>
                </td>
                <td class="muted num" style="font-size: 12.5px">{{ p.code }}</td>
                <td class="num">{{ rupiah(p.cost_price) }}</td>
                <td class="num">{{ rupiah(p.sell_price) }}</td>
                <td>
                  <span class="badge" :class="p.active ? 'sukses' : 'gagal'">{{ p.active ? "Aktif" : "Nonaktif" }}</span>
                  <div v-if="!p.active && p.deactivated_at" class="muted" style="font-size: 11px">
                    sejak {{ new Date(p.deactivated_at).toLocaleDateString("id-ID") }}
                  </div>
                </td>
                <td style="white-space: nowrap">
                  <button class="btn ghost" style="padding: 4px 10px; margin-right: 6px" @click="startPpobEdit(p)">Ubah</button>
                  <button class="btn ghost" style="padding: 4px 10px; margin-right: 6px" @click="toggleActive(p)">{{ p.active ? "Nonaktifkan" : "Aktifkan" }}</button>
                  <button class="btn ghost" style="padding: 4px 10px; color: #b3392c" @click="hapusPpob(p)">Hapus</button>
                </td>
              </template>
            </tr>
            <tr v-if="!ppobLoading && !ppobItems.length">
              <td colspan="6" class="muted">Tidak ada produk PPOB yang cocok.</td>
            </tr>
            <tr v-if="ppobLoading">
              <td colspan="6" class="muted">Memuat…</td>
            </tr>
          </tbody>
        </table>

        <div style="display: flex; gap: 8px; align-items: center; margin-top: 14px; justify-content: center">
          <button class="btn ghost" style="padding: 4px 10px" :disabled="ppobPage <= 1" @click="gotoPage(ppobPage - 1)">‹ Sebelumnya</button>
          <span class="muted num" style="font-size: 13px">Halaman {{ ppobPage }} / {{ ppobTotalPages }}</span>
          <button class="btn ghost" style="padding: 4px 10px" :disabled="ppobPage >= ppobTotalPages" @click="gotoPage(ppobPage + 1)">Selanjutnya ›</button>
        </div>
      </div>
    </div>
  </div>
</template>
