<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";
import { auth } from "../store.js";

const profit = ref(null);
const wallets = ref([]);
const transactions = ref([]);
const pendingPpob = ref(0);
const loading = ref(true);
const error = ref("");

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

function todayRange() {
  const d = new Date();
  const day = d.toISOString().slice(0, 10);
  return { start: day, end: day };
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const { start, end } = todayRange();
    const [profitRes, walletRes, txRes, ppobRes] = await Promise.all([
      api.get(`/api/reports/profit?start=${start}&end=${end}`),
      api.get("/api/wallets"),
      api.get("/api/transactions"),
      api.get("/api/ppob-orders"),
    ]);
    profit.value = profitRes;
    wallets.value = walletRes;
    transactions.value = txRes.slice(0, 8);
    pendingPpob.value = ppobRes.filter((o) => o.status === "pending").length;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Selamat datang, {{ auth.employee?.name }}</h1>
        <p>Ringkasan hari ini, {{ new Date().toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long" }) }}</p>
      </div>
      <RouterLink to="/kasir" class="btn">Buka Kasir</RouterLink>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>

    <div v-if="loading" class="muted">Memuat…</div>

    <template v-else>
      <div class="grid cols-4" style="margin-bottom: 22px">
        <div class="card stat">
          <div class="label">Omzet Hari Ini</div>
          <div class="value">{{ rupiah(profit?.omzet) }}</div>
        </div>
        <div class="card stat">
          <div class="label">Laba Kotor</div>
          <div class="value">{{ rupiah(profit?.laba_kotor) }}</div>
        </div>
        <div class="card stat">
          <div class="label">Laba Bersih</div>
          <div class="value">{{ rupiah(profit?.laba_bersih) }}</div>
        </div>
        <div class="card stat">
          <div class="label">Order PPOB Pending</div>
          <div class="value">{{ pendingPpob }}</div>
        </div>
      </div>

      <div class="grid cols-2">
        <div class="card">
          <h3 style="margin-bottom: 12px">Saldo Akun</h3>
          <table>
            <tbody>
              <tr v-for="w in wallets" :key="w.id">
                <td>{{ w.name }}</td>
                <td class="muted" style="font-size: 12px">{{ w.type === "distributor_ppob" ? "Distributor PPOB" : "Umum" }}</td>
                <td class="num" style="text-align: right">{{ rupiah(w.balance) }}</td>
              </tr>
              <tr v-if="!wallets.length">
                <td class="muted">Belum ada akun. Tambahkan lewat Pengaturan.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <h3 style="margin-bottom: 12px">Transaksi Terbaru</h3>
          <table>
            <tbody>
              <tr v-for="t in transactions" :key="t.id">
                <td>
                  <div>{{ t.category || t.type }}</div>
                  <div class="muted" style="font-size: 12px">{{ new Date(t.date).toLocaleString("id-ID") }}</div>
                </td>
                <td class="num" style="text-align: right" :style="{ color: t.type === 'sale' ? 'var(--till-deep)' : 'var(--red)' }">
                  {{ t.type === "sale" ? "+" : "-" }}{{ rupiah(t.amount) }}
                </td>
              </tr>
              <tr v-if="!transactions.length">
                <td class="muted">Belum ada transaksi.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>
