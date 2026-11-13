<script setup>
// Menu terpisah "Deposit Portalpulsa" (dulu kartu di halaman Pengaturan Toko).
// Isi: saldo distributor + tombol Cek Saldo, form kirim deposit, riwayat deposit.
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { api } from "../api.js";

const wallets = ref([]);
const depositForm = ref({ bank: "", nominal: null, walletId: "" });
const depositMsg = ref("");
const depositError = ref("");
const depositLoading = ref(false);
const depositHistory = ref([]);
const saldoMsg = ref("");
const saldoError = ref("");
const cekSaldoLoading = ref(false);
const memuat = ref(false);
let timer = null;

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

// SUKSES -> hijau, PENDING -> kuning, EXPIRED/GAGAL -> merah (kelas .badge di style.css)
function badgeDeposit(label) {
  if (label === "SUKSES") return "sukses";
  if (label === "PENDING") return "pending";
  return "gagal";
}

const dompetDistributor = computed(() => wallets.value.find((w) => w.type === "distributor_ppob" && w.provider === "portalpulsa"));
const dompetSumber = computed(() => wallets.value.filter((w) => w.type !== "distributor_ppob"));
const jumlahPending = computed(() => depositHistory.value.filter((d) => d.status_label === "PENDING").length);

async function muatDompet() {
  try {
    wallets.value = await api.get("/api/wallets");
  } catch (err) {
    depositError.value = err.message;
  }
}

async function muatRiwayat() {
  memuat.value = true;
  try {
    const res = await api.get("/api/admin/portalpulsa/deposits");
    depositHistory.value = res.deposits;
  } catch {
    // diam-diam gagal — bukan bagian kritis halaman
  } finally {
    memuat.value = false;
  }
}

async function kirimDeposit() {
  depositError.value = "";
  depositMsg.value = "";
  if (!depositForm.value.bank || !depositForm.value.nominal) {
    depositError.value = "Bank dan nominal wajib diisi.";
    return;
  }
  if (!depositForm.value.walletId) {
    depositError.value = "Pilih dulu dompet sumber uang transfer (mis. Kas/Bank).";
    return;
  }
  depositLoading.value = true;
  try {
    const res = await api.post("/api/admin/portalpulsa/deposit", depositForm.value);
    depositMsg.value = res.reply;
    await muatRiwayat();
  } catch (err) {
    depositError.value = err.message;
  } finally {
    depositLoading.value = false;
  }
}

// Sama dengan tombol Cek Saldo di halaman Pulsa & PPOB: kalau saldo naik persis
// sebesar nominal transfer deposit yang masih PENDING, deposit otomatis
// dikonfirmasi dan mutasi dompet dicatat.
async function cekSaldo() {
  saldoMsg.value = "";
  saldoError.value = "";
  cekSaldoLoading.value = true;
  try {
    const res = await api.post("/api/saldo-distributor/portalpulsa/cek", {});
    saldoMsg.value =
      `Saldo ${res.wallet_name || "portalpulsa"} sekarang ${rupiah(res.balance_after)} (sebelumnya ${rupiah(res.balance_before)}).` +
      (res.deposit ? `\n${res.deposit.pesan}` : "");
    await Promise.all([muatDompet(), muatRiwayat()]);
  } catch (err) {
    saldoError.value = err.message;
  } finally {
    cekSaldoLoading.value = false;
  }
}

onMounted(() => {
  muatDompet();
  muatRiwayat();
  // Status deposit bisa berubah sendiri (balasan provider / cek saldo otomatis cron),
  // jadi riwayat disegarkan tiap menit selama halaman ini terbuka.
  timer = setInterval(muatRiwayat, 60000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Deposit Portalpulsa</h1>
        <p>Kirim deposit saldo ke portalpulsa, cek saldo, dan pantau status deposit</p>
      </div>
    </div>

    <div class="grid cols-2" style="align-items: start">
      <div>
        <div class="card" style="margin-bottom: 18px">
          <h3 style="margin-bottom: 12px">Saldo Distributor Portalpulsa</h3>
          <div style="font-size: 26px; font-weight: 600; margin-bottom: 4px" class="num">
            {{ dompetDistributor ? rupiah(dompetDistributor.balance) : "—" }}
          </div>
          <p class="muted" style="font-size: 12.5px; margin-bottom: 12px">
            Saldo di aplikasi. Tekan <b>Cek Saldo</b> untuk menyamakan dengan saldo asli di portalpulsa — kalau saldo naik persis sebesar
            nominal transfer deposit yang PENDING, deposit langsung terkonfirmasi dan mutasi dompet tercatat otomatis.
          </p>
          <div v-if="saldoError" class="error-box">{{ saldoError }}</div>
          <div v-if="saldoMsg" class="ok-box" style="white-space: pre-wrap">{{ saldoMsg }}</div>
          <button class="btn" type="button" :disabled="cekSaldoLoading" @click="cekSaldo">
            {{ cekSaldoLoading ? "Mengecek..." : "Cek Saldo Portalpulsa" }}
          </button>
        </div>

        <div class="card">
          <h3 style="margin-bottom: 12px">Kirim Deposit</h3>
          <p class="muted" style="font-size: 13px; margin-bottom: 12px">
            Kirim perintah Deposit langsung ke portalpulsa (PIN otomatis dari secret PORTALPULSA_PIN).
            Balasannya berupa <b>instruksi transfer manual</b> (nominal + kode unik, bank, no rekening) —
            bukan topup otomatis, tetap transfer manual sesuai instruksi setelah dikirim.
          </p>
          <div v-if="depositError" class="error-box">{{ depositError }}</div>
          <form @submit.prevent="kirimDeposit">
            <div class="field"><label>Bank</label><input v-model="depositForm.bank" placeholder="mis. BCA" required /></div>
            <div class="field"><label>Nominal (Rp)</label><input v-model.number="depositForm.nominal" type="number" min="1" required /></div>
            <div class="field">
              <label>Dompet sumber (uang beneran keluar dari sini)</label>
              <select v-model.number="depositForm.walletId" required>
                <option value="" disabled>Pilih dompet...</option>
                <option v-for="w in dompetSumber" :key="w.id" :value="w.id">{{ w.name }} ({{ rupiah(w.balance) }})</option>
              </select>
            </div>
            <p class="muted" style="font-size: 12px; margin: -4px 0 8px">
              Nominal transfer otomatis dicatat sebagai <b>Mutasi</b> dari dompet sumber ke dompet Saldo Distributor portalpulsa
              (bukan biaya — tidak memengaruhi Laba Rugi) <b>setelah deposit terkonfirmasi</b>.
            </p>
            <button class="btn" type="submit" :disabled="depositLoading">{{ depositLoading ? "Mengirim..." : "Kirim Deposit" }}</button>
          </form>
          <div v-if="depositMsg" class="ok-box" style="white-space: pre-wrap; margin-top: 12px">{{ depositMsg }}</div>
        </div>
      </div>

      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px">
          <h3>Riwayat Deposit</h3>
          <button class="btn ghost" type="button" style="padding: 3px 10px; font-size: 12.5px" :disabled="memuat" @click="muatRiwayat">
            {{ memuat ? "Memuat..." : "Muat ulang" }}
          </button>
        </div>
        <p class="muted" style="font-size: 12.5px; margin-bottom: 12px">
          Status PENDING berubah SUKSES sendiri begitu balasan provider masuk, atau saat saldo asli terdeteksi naik (dicek otomatis
          sekitar tiap 10 menit, atau lewat tombol Cek Saldo). Deposit tanpa konfirmasi lebih dari 13 jam ditandai gagal/kedaluwarsa.
          Halaman ini menyegarkan diri tiap menit.
        </p>
        <div v-if="jumlahPending" class="ok-box" style="margin-bottom: 12px">
          {{ jumlahPending }} deposit masih menunggu — transfer sesuai nominal (termasuk kode unik) bila belum.
        </div>
        <div v-if="!depositHistory.length" class="muted">Belum ada riwayat deposit.</div>
        <!-- Satu kartu per deposit, gaya riwayat deposit di aplikasi portalpulsa:
             Bank / Nominal (yang benar-benar ditransfer, termasuk kode unik) / Status / Update. -->
        <div
          v-for="d in depositHistory"
          :key="d.id"
          style="border: 1px solid #d9d9d9; border-radius: 4px; padding: 4px 12px; margin-bottom: 10px; font-size: 14px"
        >
          <div class="dep-row"><b>Bank</b><span>{{ d.bank }}</span></div>
          <div class="dep-row"><b>Nominal</b><span class="num">{{ rupiah(d.nominal_tampil) }}</span></div>
          <div class="dep-row">
            <b>Status</b>
            <span class="badge" :class="badgeDeposit(d.status_label)">{{ d.status_label }}</span>
          </div>
          <div class="dep-row"><b>Update</b><span class="num">{{ d.waktu_update }}</span></div>
          <details style="padding: 4px 0 8px">
            <summary class="muted" style="font-size: 12px; cursor: pointer">Balasan provider · oleh {{ d.employee_name || "?" }}</summary>
            <div class="muted" style="white-space: pre-wrap; margin-top: 4px; font-size: 12px">{{ d.raw_reply }}</div>
          </details>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dep-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #ececec; }
.dep-row b { font-weight: 600; }
</style>
