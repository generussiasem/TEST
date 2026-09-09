<script setup>
import { ref, computed, onMounted } from "vue";
import { api } from "../api.js";

const products = ref([]);
const orders = ref([]);

const cekSearch = ref("");
const cekCode = ref("");
const target = ref("");
const cekResult = ref(null);
const cekLoading = ref(false);

const bayarSearch = ref("");
const bayarCode = ref("");
const bayarConfirming = ref(false);
const bayarResult = ref(null);
const bayarLoading = ref(false);

const finalizeAmount = ref(0);
const finalizeCost = ref(0);
const finalizing = ref(false);

const error = ref("");

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

const postpaidProducts = computed(() => products.value.filter((p) => p.category === "TAGIHAN" || p.category === "AIR PDAM"));
const cekOptions = computed(() => {
  const q = cekSearch.value.toLowerCase();
  return postpaidProducts.value
    .filter((p) => p.code?.toUpperCase().startsWith("C"))
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q))
    .slice(0, 8);
});
const bayarOptions = computed(() => {
  const q = bayarSearch.value.toLowerCase();
  return postpaidProducts.value
    .filter((p) => p.code?.toUpperCase().startsWith("B"))
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q))
    .slice(0, 8);
});

// Order postpaid yang sudah sukses tapi belum dicatat manual (finalized = 0) —
// biar kasir tidak lupa menuntaskan pencatatannya.
const belumDicatat = computed(() =>
  orders.value.filter((o) => o.status === "sukses" && !o.finalized && isPostpaidCode(o.product_code))
);

function isPostpaidCode(code) {
  const p = products.value.find((x) => x.code === code);
  return p && (p.category === "TAGIHAN" || p.category === "AIR PDAM");
}

async function load() {
  const [p, o] = await Promise.all([api.get("/api/products"), api.get("/api/ppob-orders")]);
  products.value = p;
  orders.value = o;
}

function pickCek(p) {
  cekCode.value = p.code;
  cekSearch.value = `${p.name} (${p.code})`;
}
function pickBayar(p) {
  bayarCode.value = p.code;
  bayarSearch.value = `${p.name} (${p.code})`;
}

async function doCek() {
  error.value = "";
  cekResult.value = null;
  if (!cekCode.value || !target.value) {
    error.value = "Pilih kode Cek dan isi ID pelanggan/nomor dulu.";
    return;
  }
  cekLoading.value = true;
  try {
    cekResult.value = await api.post("/api/ppob/cek", { productCode: cekCode.value, target: target.value });
  } catch (err) {
    error.value = err.message;
  } finally {
    cekLoading.value = false;
  }
}

function mulaiBayar() {
  bayarConfirming.value = true;
}

async function doBayar() {
  error.value = "";
  bayarResult.value = null;
  if (!bayarCode.value || !target.value) {
    error.value = "Pilih kode Bayar dulu.";
    return;
  }
  bayarLoading.value = true;
  try {
    bayarResult.value = await api.post("/api/ppob/order", { productCode: bayarCode.value, target: target.value });
    bayarConfirming.value = false;
    finalizeAmount.value = 0;
    finalizeCost.value = 0;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    bayarLoading.value = false;
  }
}

async function finalize(refId) {
  error.value = "";
  finalizing.value = true;
  try {
    await api.post(`/api/ppob-orders/${refId}/catat`, {
      amount: finalizeAmount.value,
      cost_total: finalizeCost.value,
    });
    bayarResult.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    finalizing.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Cek &amp; Bayar Tagihan</h1>
        <p>PDAM, listrik pascabayar, BPJS — nominal berbeda tiap pelanggan, wajib dicek dulu sebelum bayar</p>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>

    <div v-if="belumDicatat.length" class="card" style="margin-bottom: 18px; border-color: var(--amber)">
      <h3 style="margin-bottom: 8px">⚠️ Ada {{ belumDicatat.length }} order sukses belum dicatat</h3>
      <p class="muted" style="font-size: 13px; margin-bottom: 10px">
        Order ini sudah berhasil dibayar ke OkeConnect tapi belum masuk laporan keuangan — catat manual di bawah supaya laba tidak hilang.
      </p>
      <table>
        <tbody>
          <tr v-for="o in belumDicatat" :key="o.id">
            <td>{{ o.product_code }}</td>
            <td class="num">{{ o.target }}</td>
            <td class="muted" style="font-size: 12px">{{ o.raw_reply }}</td>
            <td class="num">{{ o.ref_id }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted" style="font-size: 12px; margin-top: 8px">
        Catat lewat form "Bayar" di bawah setelah membuat order baru dengan kode &amp; target yang sama, atau minta saya tambahkan form catat manual per ref kalau sering terjadi.
      </p>
    </div>

    <div class="grid cols-2" style="align-items: start">
      <div class="card">
        <h3 style="margin-bottom: 4px">1. Cek Tagihan</h3>
        <p class="muted" style="font-size: 13px; margin-bottom: 12px">Tidak memotong saldo — cuma menampilkan nominal &amp; nama pelanggan asli.</p>
        <div class="field" style="position: relative">
          <label>Kode Cek</label>
          <input v-model="cekSearch" placeholder="mis. cek PDAM Sidoarjo" />
          <div v-if="cekOptions.length" class="card" style="position: absolute; top: 100%; left: 0; right: 0; z-index: 5; padding: 6px; max-height: 220px; overflow: auto">
            <div v-for="p in cekOptions" :key="p.id" @click="pickCek(p)" style="padding: 8px; cursor: pointer">
              {{ p.name }} <span class="muted num" style="font-size: 12px">#{{ p.code }}</span>
            </div>
          </div>
        </div>
        <div class="field">
          <label>ID Pelanggan / No. Meter</label>
          <input v-model="target" placeholder="mis. 5301234567" />
        </div>
        <button class="btn ghost" :disabled="cekLoading" @click="doCek">{{ cekLoading ? "Mengecek…" : "Cek Tagihan" }}</button>

        <div v-if="cekResult" class="ok-box" style="margin-top: 14px; white-space: pre-wrap">{{ cekResult.reply }}</div>
      </div>

      <div class="card">
        <h3 style="margin-bottom: 4px">2. Bayar</h3>
        <p class="muted" style="font-size: 13px; margin-bottom: 12px">Pastikan nominal di atas sudah dikonfirmasi ke pelanggan sebelum lanjut.</p>
        <div class="field" style="position: relative">
          <label>Kode Bayar</label>
          <input v-model="bayarSearch" placeholder="mis. bayar PDAM Sidoarjo" />
          <div v-if="bayarOptions.length" class="card" style="position: absolute; top: 100%; left: 0; right: 0; z-index: 5; padding: 6px; max-height: 220px; overflow: auto">
            <div v-for="p in bayarOptions" :key="p.id" @click="pickBayar(p)" style="padding: 8px; cursor: pointer">
              {{ p.name }} <span class="muted num" style="font-size: 12px">#{{ p.code }}</span>
            </div>
          </div>
        </div>
        <p class="muted num" style="font-size: 12.5px; margin-bottom: 12px">Target: {{ target || "(isi di form Cek dulu)" }}</p>

        <button v-if="!bayarConfirming" class="btn" :disabled="!bayarCode || !target" @click="mulaiBayar">Lanjut Bayar</button>
        <div v-else class="error-box" style="background: var(--amber-soft); color: #7a5514">
          Yakin sudah cek nominal & konfirmasi ke pelanggan? Ini akan memotong saldo distributor sungguhan.
          <div style="margin-top: 8px; display: flex; gap: 8px">
            <button class="btn danger" :disabled="bayarLoading" @click="doBayar">{{ bayarLoading ? "Memproses…" : "Ya, Bayar Sekarang" }}</button>
            <button class="btn ghost" @click="bayarConfirming = false">Batal</button>
          </div>
        </div>

        <div v-if="bayarResult" class="ok-box" style="margin-top: 14px; white-space: pre-wrap">
          Status: <strong>{{ bayarResult.status }}</strong>{{ bayarResult.reply ? " — " + bayarResult.reply : "" }}
        </div>

        <div v-if="bayarResult && bayarResult.needsManualRecord" class="card" style="margin-top: 14px; background: var(--paper)">
          <h3 style="margin-bottom: 8px; font-size: 15px">Catat sebagai transaksi</h3>
          <div class="form-row">
            <div class="field"><label>Diterima dari pelanggan</label><input v-model.number="finalizeAmount" type="number" min="0" /></div>
            <div class="field"><label>Terpotong dari saldo</label><input v-model.number="finalizeCost" type="number" min="0" /></div>
          </div>
          <button class="btn" :disabled="finalizing" @click="finalize(bayarResult.refId)">{{ finalizing ? "Menyimpan…" : "Simpan Transaksi" }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
