<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";

const wallets = ref([]);
const mutations = ref([]);
const form = ref({ wallet_id: "", to_wallet_id: "", amount: 0, note: "" });
const error = ref("");
const okMsg = ref("");
const saving = ref(false);

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

function walletName(id) {
  return wallets.value.find((w) => w.id === id)?.name || "—";
}

async function load() {
  const [w, t] = await Promise.all([api.get("/api/wallets"), api.get("/api/transactions")]);
  wallets.value = w;
  mutations.value = t.filter((tr) => tr.type === "mutation");
  if (!form.value.wallet_id && w.length) form.value.wallet_id = w[0].id;
  if (!form.value.to_wallet_id && w.length > 1) form.value.to_wallet_id = w[1].id;
}

async function submit() {
  error.value = "";
  okMsg.value = "";
  if (form.value.wallet_id === form.value.to_wallet_id) {
    error.value = "Akun asal dan akun tujuan tidak boleh sama.";
    return;
  }
  if (!form.value.amount || form.value.amount <= 0) {
    error.value = "Isi nominal mutasi dulu.";
    return;
  }
  saving.value = true;
  try {
    await api.post("/api/transactions", { ...form.value, type: "mutation" });
    okMsg.value = `Berhasil pindahkan ${rupiah(form.value.amount)} dari ${walletName(form.value.wallet_id)} ke ${walletName(form.value.to_wallet_id)}.`;
    form.value.amount = 0;
    form.value.note = "";
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}

async function hapus(t) {
  if (!confirm(`Batalkan mutasi ${rupiah(t.amount)} ini? Saldo kedua akun akan dikembalikan otomatis.`)) return;
  error.value = "";
  try {
    await api.delete(`/api/transactions/${t.id}`);
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
        <h1>Mutasi Akun</h1>
        <p>Pindahkan saldo antar akun/dompet, misalnya setor tunai dari Kas ke Bank</p>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>
    <div v-if="okMsg" class="ok-box">{{ okMsg }}</div>

    <div class="grid cols-2" style="align-items: start">
      <div class="card">
        <h3 style="margin-bottom: 12px">Catat Mutasi</h3>
        <form @submit.prevent="submit">
          <div class="form-row">
            <div class="field">
              <label>Dari akun</label>
              <select v-model.number="form.wallet_id" required>
                <option v-for="w in wallets" :key="w.id" :value="w.id">{{ w.name }} ({{ rupiah(w.balance) }})</option>
              </select>
            </div>
            <div class="field">
              <label>Ke akun</label>
              <select v-model.number="form.to_wallet_id" required>
                <option v-for="w in wallets" :key="w.id" :value="w.id">{{ w.name }} ({{ rupiah(w.balance) }})</option>
              </select>
            </div>
          </div>
          <div class="field"><label>Nominal</label><input v-model.number="form.amount" type="number" min="1" required /></div>
          <div class="field"><label>Catatan</label><input v-model="form.note" placeholder="mis. Setor ke bank hari ini" /></div>
          <button class="btn" type="submit" :disabled="saving">{{ saving ? "Menyimpan…" : "Pindahkan Saldo" }}</button>
        </form>
      </div>

      <div class="card">
        <h3 style="margin-bottom: 12px">Saldo Akun Saat Ini</h3>
        <table>
          <thead>
            <tr>
              <th>Akun</th>
              <th>Saldo</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in wallets" :key="w.id">
              <td>{{ w.name }}</td>
              <td class="num">{{ rupiah(w.balance) }}</td>
            </tr>
            <tr v-if="!wallets.length">
              <td colspan="2" class="muted">Belum ada akun. Tambahkan dulu di Pengaturan Toko.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-top: 22px">
      <h3 style="margin-bottom: 12px">Riwayat Mutasi</h3>
      <table>
        <thead>
          <tr>
            <th>Tanggal</th>
            <th>Dari</th>
            <th>Ke</th>
            <th>Nominal</th>
            <th>Catatan</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in mutations" :key="t.id">
            <td class="muted" style="font-size: 12.5px">{{ new Date(t.date).toLocaleString("id-ID") }}</td>
            <td>{{ walletName(t.wallet_id) }}</td>
            <td>{{ walletName(t.to_wallet_id) }}</td>
            <td class="num">{{ rupiah(t.amount) }}</td>
            <td class="muted">{{ t.note || "—" }}</td>
            <td style="white-space: nowrap">
              <button class="btn ghost" style="padding: 4px 10px; color: #b3392c" @click="hapus(t)">Batalkan</button>
            </td>
          </tr>
          <tr v-if="!mutations.length">
            <td colspan="6" class="muted">Belum ada mutasi antar akun.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
