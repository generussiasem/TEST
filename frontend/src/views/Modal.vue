<script setup>
import { ref, computed, onMounted } from "vue";
import { api } from "../api.js";

const data = ref(null);
const loading = ref(true);
const error = ref("");
const okMsg = ref("");

function rupiah(n) {
  if (n === null || n === undefined) return "—";
  const sign = n < 0 ? "-" : "";
  return sign + "Rp" + Math.abs(Math.round(n)).toLocaleString("id-ID");
}

function persen(n) {
  if (n === null || n === undefined) return "—";
  const sign = n > 0 ? "+" : "";
  return sign + n.toFixed(1) + "%";
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    data.value = await api.get("/api/modal");
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

// Grafik SVG sederhana tanpa library eksternal — garis aset bersih harian
// plus garis putus-putus Modal Awal sebagai pembanding.
const chart = computed(() => {
  const snapshots = data.value?.snapshots || [];
  if (snapshots.length < 2) return null;

  const W = 680;
  const H = 220;
  const PAD = 32;
  const values = snapshots.map((s) => s.aset_bersih);
  const modalAwal = data.value?.modalAwal;
  const allValues = modalAwal !== null && modalAwal !== undefined ? [...values, modalAwal] : values;
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const range = max - min || 1;

  const x = (i) => PAD + (i / (snapshots.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - min) / range) * (H - PAD * 2);

  const points = snapshots.map((s, i) => `${x(i)},${y(s.aset_bersih)}`).join(" ");
  const modalAwalY = modalAwal !== null && modalAwal !== undefined ? y(modalAwal) : null;

  return {
    W,
    H,
    points,
    modalAwalY,
    firstLabel: snapshots[0]?.tanggal,
    lastLabel: snapshots[snapshots.length - 1]?.tanggal,
  };
});

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Pertumbuhan Modal</h1>
        <p>Aset bersih toko (kas + dompet + stok + piutang − hutang), dicatat tiap hari</p>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>
    <div v-if="okMsg" class="ok-box">{{ okMsg }}</div>

    <div v-if="loading" class="muted">Memuat…</div>

    <template v-else-if="data">
      <div class="grid cols-4" style="margin-bottom: 22px">
        <div class="card stat">
          <div class="label">
            Modal Awal
            <span v-if="data.modalAwalTanggal" class="muted" style="font-size: 11px">({{ data.modalAwalTanggal }})</span>
          </div>
          <div class="value">{{ rupiah(data.modalAwal) }}</div>
          <RouterLink to="/pengaturan" class="muted" style="font-size: 11px">Ubah lewat Pengaturan</RouterLink>
        </div>
        <div class="card stat">
          <div class="label">Modal Saat Ini</div>
          <div class="value">{{ rupiah(data.modalSaatIni) }}</div>
        </div>
        <div class="card stat">
          <div class="label">Pertumbuhan</div>
          <div class="value" :style="{ color: data.pertumbuhanNominal >= 0 ? 'var(--till-deep)' : 'var(--red)' }">
            {{ rupiah(data.pertumbuhanNominal) }}
          </div>
        </div>
        <div class="card stat">
          <div class="label">Pertumbuhan (%)</div>
          <div class="value" :style="{ color: data.pertumbuhanPersen >= 0 ? 'var(--till-deep)' : 'var(--red)' }">
            {{ persen(data.pertumbuhanPersen) }}
          </div>
        </div>
      </div>

      <div v-if="data.modalAwal === null" class="card" style="margin-bottom: 22px">
        <p class="muted">
          Modal Awal belum ada — akan otomatis tercatat malam ini jam 00:00 WIB dari hasil hitung aset bersih hari ini.
          Kalau mau langsung diisi sekarang atau mengoreksi nilainya, buka menu <RouterLink to="/pengaturan">Pengaturan Toko</RouterLink>.
        </p>
      </div>

      <div class="card" style="margin-bottom: 22px">
        <h3 style="margin-bottom: 12px">Rincian Aset Saat Ini</h3>
        <table>
          <tbody>
            <tr>
              <td>Kas + Saldo Dompet/Bank</td>
              <td class="num" style="text-align: right">{{ rupiah(data.rincianSaatIni.kasDompet) }}</td>
            </tr>
            <tr>
              <td>Nilai Stok Barang (harga modal)</td>
              <td class="num" style="text-align: right">{{ rupiah(data.rincianSaatIni.nilaiStok) }}</td>
            </tr>
            <tr>
              <td>Piutang Pelanggan</td>
              <td class="num" style="text-align: right; color: var(--till-deep)">+{{ rupiah(data.rincianSaatIni.piutang) }}</td>
            </tr>
            <tr>
              <td>Hutang ke Supplier</td>
              <td class="num" style="text-align: right; color: var(--red)">-{{ rupiah(data.rincianSaatIni.hutang) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h3 style="margin-bottom: 12px">Grafik Harian</h3>
        <div v-if="!chart" class="muted">Grafik muncul setelah ada minimal 2 hari snapshot.</div>
        <template v-else>
          <svg :viewBox="`0 0 ${chart.W} ${chart.H}`" style="width: 100%; height: auto">
            <line v-if="chart.modalAwalY !== null" x1="0" :x2="chart.W" :y1="chart.modalAwalY" :y2="chart.modalAwalY" stroke="var(--ink-soft)" stroke-dasharray="4 4" stroke-width="1" />
            <polyline :points="chart.points" fill="none" stroke="var(--till-deep)" stroke-width="2.5" />
          </svg>
          <div class="muted" style="display: flex; justify-content: space-between; font-size: 12px">
            <span>{{ chart.firstLabel }}</span>
            <span>Garis putus-putus = Modal Awal</span>
            <span>{{ chart.lastLabel }}</span>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>
