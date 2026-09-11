<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";

const settings = ref({ store_name: "", address: "", logo_url: "" });
const wallets = ref([]);
const walletForm = ref({ name: "", type: "umum", balance: 0 });
const error = ref("");
const okMsg = ref("");
const walletMsg = ref("");
const editingWallet = ref(null);

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

async function load() {
  const [s, w] = await Promise.all([api.get("/api/store-settings"), api.get("/api/wallets")]);
  settings.value = s;
  wallets.value = w;
}

async function saveSettings() {
  error.value = "";
  okMsg.value = "";
  try {
    await api.put("/api/store-settings", settings.value);
    okMsg.value = "Pengaturan toko disimpan.";
  } catch (err) {
    error.value = err.message;
  }
}

async function addWallet() {
  error.value = "";
  walletMsg.value = "";
  try {
    await api.post("/api/wallets", walletForm.value);
    walletMsg.value = "Akun ditambahkan.";
    walletForm.value = { name: "", type: "umum", balance: 0 };
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

function startEditWallet(w) {
  editingWallet.value = { ...w };
}

async function saveWalletEdit() {
  error.value = "";
  try {
    await api.put(`/api/wallets/${editingWallet.value.id}`, editingWallet.value);
    editingWallet.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

async function hapusWallet(w) {
  if (!confirm(`Hapus akun "${w.name}"?`)) return;
  error.value = "";
  try {
    await api.delete(`/api/wallets/${w.id}`);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Pengaturan Toko</h1>
        <p>Identitas toko dan daftar akun/dompet kas</p>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>

    <div class="grid cols-2" style="align-items: start">
      <div class="card">
        <h3 style="margin-bottom: 12px">Identitas Toko</h3>
        <div v-if="okMsg" class="ok-box">{{ okMsg }}</div>
        <form @submit.prevent="saveSettings">
          <div class="field"><label>Nama Toko</label><input v-model="settings.store_name" required /></div>
          <div class="field"><label>Alamat</label><input v-model="settings.address" /></div>
          <div class="field"><label>URL Logo</label><input v-model="settings.logo_url" placeholder="https://…" /></div>
          <button class="btn" type="submit">Simpan</button>
        </form>
      </div>

      <div class="card">
        <h3 style="margin-bottom: 12px">Tambah Akun / Dompet</h3>
        <div v-if="walletMsg" class="ok-box">{{ walletMsg }}</div>
        <p class="muted" style="font-size: 13px; margin-bottom: 12px">
          Pakai tipe "Distributor PPOB" untuk akun saldo OkeConnect yang dipotong tiap order pulsa.
        </p>
        <form @submit.prevent="addWallet">
          <div class="field"><label>Nama Akun</label><input v-model="walletForm.name" placeholder="mis. Kas Tunai, Saldo OkeConnect" required /></div>
          <div class="form-row">
            <div class="field">
              <label>Tipe</label>
              <select v-model="walletForm.type">
                <option value="umum">Umum</option>
                <option value="distributor_ppob">Distributor PPOB</option>
              </select>
            </div>
            <div class="field"><label>Saldo Awal</label><input v-model.number="walletForm.balance" type="number" min="0" /></div>
          </div>
          <button class="btn" type="submit">Tambah Akun</button>
        </form>
      </div>
    </div>

    <div class="card" style="margin-top: 22px">
      <h3 style="margin-bottom: 12px">Daftar Akun</h3>
      <table>
        <thead>
          <tr>
            <th>Nama</th>
            <th>Tipe</th>
            <th>Saldo</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="w in wallets" :key="w.id">
            <template v-if="editingWallet && editingWallet.id === w.id">
              <td><input v-model="editingWallet.name" /></td>
              <td>
                <select v-model="editingWallet.type">
                  <option value="umum">Umum</option>
                  <option value="distributor_ppob">Distributor PPOB</option>
                </select>
              </td>
              <td><input v-model.number="editingWallet.balance" type="number" style="width: 110px" /></td>
              <td style="white-space: nowrap">
                <button class="btn" style="padding: 4px 10px" @click="saveWalletEdit">Simpan</button>
                <button class="btn ghost" style="padding: 4px 10px" @click="editingWallet = null">Batal</button>
              </td>
            </template>
            <template v-else>
              <td>{{ w.name }}</td>
              <td>{{ w.type === "distributor_ppob" ? "Distributor PPOB" : "Umum" }}</td>
              <td class="num">{{ rupiah(w.balance) }}</td>
              <td style="white-space: nowrap">
                <button class="btn ghost" style="padding: 4px 10px; margin-right: 6px" @click="startEditWallet(w)">Ubah</button>
                <button class="btn ghost" style="padding: 4px 10px; color: #b3392c" @click="hapusWallet(w)">Hapus</button>
              </td>
            </template>
          </tr>
          <tr v-if="!wallets.length">
            <td colspan="4" class="muted">Belum ada akun.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
