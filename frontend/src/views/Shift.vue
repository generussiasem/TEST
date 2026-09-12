<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";
import { isAdmin } from "../store.js";

const wallets = ref([]);
const current = ref(null); // shift yang sedang berjalan (kalau ada)
const history = ref([]);
const detail = ref(null); // detail shift yang sedang dilihat di riwayat

const openForm = ref({ wallet_id: "", opening_balance: 0, opening_note: "" });
const closeForm = ref({ closing_balance: 0, closing_note: "" });
const closeResult = ref(null);

const error = ref("");
const loading = ref(false);
const saving = ref(false);

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [w, cur, hist] = await Promise.all([
      api.get("/api/wallets"),
      api.get("/api/shifts/current"),
      api.get("/api/shifts"),
    ]);
    wallets.value = w;
    current.value = cur;
    history.value = hist;
    if (!openForm.value.wallet_id && w.length) openForm.value.wallet_id = w[0].id;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function bukaShift() {
  error.value = "";
  if (!openForm.value.wallet_id) {
    error.value = "Pilih akun kas dulu.";
    return;
  }
  saving.value = true;
  try {
    await api.post("/api/shifts/open", openForm.value);
    openForm.value.opening_balance = 0;
    openForm.value.opening_note = "";
    closeResult.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}

async function tutupShift() {
  error.value = "";
  if (closeForm.value.closing_balance === "" || closeForm.value.closing_balance === null) {
    error.value = "Isi hasil hitung kas fisik dulu.";
    return;
  }
  if (!confirm("Tutup shift sekarang? Setelah ditutup, shift ini tidak bisa dibuka lagi.")) return;
  saving.value = true;
  try {
    const result = await api.post(`/api/shifts/${current.value.id}/close`, closeForm.value);
    closeResult.value = { ...result, wallet_name: current.value.wallet_name, opening_balance: current.value.opening_balance };
    closeForm.value = { closing_balance: 0, closing_note: "" };
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}

async function lihatDetail(s) {
  error.value = "";
  try {
    detail.value = await api.get(`/api/shifts/${s.id}`);
  } catch (err) {
    error.value = err.message;
  }
}

const typeLabel = { sale: "Penjualan", purchase: "Pembelian Stok", expense: "Biaya", mutation: "Mutasi Akun" };

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Tutup Shift / Kas Opname</h1>
        <p>Buka shift saat mulai kerja, tutup dan cocokkan kas fisik saat selesai</p>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>

    <!-- Belum ada shift terbuka: form buka shift -->
    <div v-if="!loading && !current" class="card">
      <h3 style="margin-bottom: 12px">Buka Shift Baru</h3>
      <p class="muted" style="font-size: 13px; margin-bottom: 12px">
        Hitung dulu uang fisik di laci kas, lalu masukkan sebagai saldo awal di bawah ini.
      </p>
      <form @submit.prevent="bukaShift">
        <div class="form-row">
          <div class="field">
            <label>Akun Kas</label>
            <select v-model.number="openForm.wallet_id" required>
              <option v-for="w in wallets" :key="w.id" :value="w.id">{{ w.name }}</option>
            </select>
          </div>
          <div class="field"><label>Saldo Awal (hasil hitung fisik)</label><input v-model.number="openForm.opening_balance" type="number" min="0" required /></div>
        </div>
        <div class="field"><label>Catatan</label><input v-model="openForm.opening_note" placeholder="opsional" /></div>
        <button class="btn" type="submit" :disabled="saving">{{ saving ? "Membuka…" : "Buka Shift" }}</button>
      </form>
    </div>

    <!-- Shift sedang berjalan: rekap sementara + form tutup -->
    <div v-if="current" class="grid cols-2" style="align-items: start">
      <div class="card">
        <h3 style="margin-bottom: 4px">Shift Berjalan <span class="badge pending" style="margin-left: 6px">terbuka</span></h3>
        <p class="muted" style="font-size: 13px; margin-bottom: 12px">
          {{ current.wallet_name }} — dibuka {{ new Date(current.opened_at).toLocaleString("id-ID") }}
        </p>
        <table>
          <tbody>
            <tr><td class="muted">Saldo Awal</td><td class="num">{{ rupiah(current.opening_balance) }}</td></tr>
            <tr><td class="muted">Total Penjualan Tunai</td><td class="num" style="color: var(--till-deep)">+{{ rupiah(current.total_penjualan) }}</td></tr>
            <tr><td class="muted">Total Pembelian Stok</td><td class="num" style="color: var(--red)">-{{ rupiah(current.total_pembelian) }}</td></tr>
            <tr><td class="muted">Total Pengeluaran</td><td class="num" style="color: var(--red)">-{{ rupiah(current.total_pengeluaran) }}</td></tr>
            <tr><td class="muted">Mutasi Masuk</td><td class="num" style="color: var(--till-deep)">+{{ rupiah(current.mutasi_masuk) }}</td></tr>
            <tr><td class="muted">Mutasi Keluar</td><td class="num" style="color: var(--red)">-{{ rupiah(current.mutasi_keluar) }}</td></tr>
            <tr style="border-top: 1px solid var(--line)"><td><strong>Saldo Seharusnya Sekarang</strong></td><td class="num"><strong>{{ rupiah(current.expected_balance) }}</strong></td></tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h3 style="margin-bottom: 12px">Tutup Shift</h3>
        <p class="muted" style="font-size: 13px; margin-bottom: 12px">
          Hitung ulang uang fisik di laci kas sekarang, lalu masukkan hasilnya di bawah untuk dibandingkan dengan saldo seharusnya.
        </p>
        <form @submit.prevent="tutupShift">
          <div class="field"><label>Saldo Akhir (hasil hitung fisik)</label><input v-model.number="closeForm.closing_balance" type="number" min="0" required /></div>
          <div class="field"><label>Catatan</label><input v-model="closeForm.closing_note" placeholder="opsional, mis. alasan selisih" /></div>
          <button class="btn" type="submit" :disabled="saving">{{ saving ? "Menutup…" : "Tutup Shift & Hitung Selisih" }}</button>
        </form>
      </div>
    </div>

    <!-- Hasil tutup shift barusan -->
    <div v-if="closeResult" class="card" style="margin-top: 18px">
      <h3 style="margin-bottom: 12px">Hasil Penutupan Shift</h3>
      <div class="grid cols-3">
        <div class="card stat">
          <div class="label">Saldo Seharusnya</div>
          <div class="value">{{ rupiah(closeResult.expected_balance) }}</div>
        </div>
        <div class="card stat">
          <div class="label">Saldo Fisik (Dihitung)</div>
          <div class="value">{{ rupiah(closeResult.expected_balance + closeResult.difference) }}</div>
        </div>
        <div class="card stat">
          <div class="label">Selisih</div>
          <div class="value" :style="{ color: closeResult.difference === 0 ? 'var(--till-deep)' : (closeResult.difference > 0 ? 'var(--till-deep)' : 'var(--red)') }">
            {{ closeResult.difference > 0 ? "Lebih " : closeResult.difference < 0 ? "Kurang " : "" }}{{ rupiah(Math.abs(closeResult.difference)) }}
          </div>
        </div>
      </div>
    </div>

    <!-- Riwayat shift -->
    <div class="card" style="margin-top: 22px">
      <h3 style="margin-bottom: 12px">Riwayat Shift{{ isAdmin() ? " (Semua Kasir)" : "" }}</h3>
      <table>
        <thead>
          <tr>
            <th>Dibuka</th>
            <th v-if="isAdmin()">Kasir</th>
            <th>Akun</th>
            <th>Saldo Awal</th>
            <th>Saldo Akhir</th>
            <th>Selisih</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in history" :key="s.id">
            <td class="muted" style="font-size: 12.5px">{{ new Date(s.opened_at).toLocaleString("id-ID") }}</td>
            <td v-if="isAdmin()">{{ s.employee_name }}</td>
            <td>{{ s.wallet_name }}</td>
            <td class="num">{{ rupiah(s.opening_balance) }}</td>
            <td class="num">{{ s.status === "closed" ? rupiah(s.closing_balance) : "—" }}</td>
            <td class="num" :style="{ color: s.difference > 0 ? 'var(--till-deep)' : s.difference < 0 ? 'var(--red)' : 'inherit' }">
              {{ s.status === "closed" ? rupiah(s.difference) : "—" }}
            </td>
            <td><span class="badge" :class="s.status === 'open' ? 'pending' : 'sukses'">{{ s.status === "open" ? "terbuka" : "selesai" }}</span></td>
            <td><button class="btn ghost" style="padding: 4px 10px" @click="lihatDetail(s)">Lihat</button></td>
          </tr>
          <tr v-if="!history.length">
            <td :colspan="isAdmin() ? 8 : 7" class="muted">Belum ada riwayat shift.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Detail shift terpilih -->
    <div v-if="detail" class="card" style="margin-top: 18px">
      <div class="page-head" style="margin-bottom: 12px">
        <div>
          <h3>Detail Shift — {{ detail.employee_name }}</h3>
          <p class="muted" style="font-size: 13px">
            {{ detail.wallet_name }} · dibuka {{ new Date(detail.opened_at).toLocaleString("id-ID") }}
            <template v-if="detail.closed_at"> · ditutup {{ new Date(detail.closed_at).toLocaleString("id-ID") }}</template>
          </p>
        </div>
        <button class="btn ghost" @click="detail = null">Tutup</button>
      </div>
      <div class="grid cols-4" style="margin-bottom: 16px">
        <div class="card stat"><div class="label">Saldo Awal</div><div class="value">{{ rupiah(detail.opening_balance) }}</div></div>
        <div class="card stat"><div class="label">Saldo Seharusnya</div><div class="value">{{ rupiah(detail.expected_balance) }}</div></div>
        <div class="card stat"><div class="label">Saldo Fisik</div><div class="value">{{ detail.status === "closed" ? rupiah(detail.closing_balance) : "—" }}</div></div>
        <div class="card stat">
          <div class="label">Selisih</div>
          <div class="value" :style="{ color: detail.difference > 0 ? 'var(--till-deep)' : detail.difference < 0 ? 'var(--red)' : 'inherit' }">
            {{ detail.status === "closed" ? rupiah(detail.difference) : "—" }}
          </div>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Tanggal</th>
            <th>Jenis</th>
            <th>Kategori</th>
            <th>Nominal</th>
            <th>Catatan</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in detail.transactions" :key="t.id">
            <td class="muted" style="font-size: 12.5px">{{ new Date(t.date).toLocaleString("id-ID") }}</td>
            <td>{{ typeLabel[t.type] || t.type }}</td>
            <td>{{ t.category || "—" }}</td>
            <td class="num">{{ rupiah(t.amount) }}</td>
            <td class="muted">{{ t.note || "—" }}</td>
          </tr>
          <tr v-if="!detail.transactions.length">
            <td colspan="5" class="muted">Tidak ada transaksi pada shift ini.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
