<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";

const settings = ref({ store_name: "", address: "", logo_url: "", cetak_struk_url: "" });
const wallets = ref([]);
const walletForm = ref({ name: "", type: "umum", balance: 0, provider: "okeconnect" });
const error = ref("");
const okMsg = ref("");
const walletMsg = ref("");
const editingWallet = ref(null);
const modal = ref(null);
const modalAwalForm = ref(0);
const modalMsg = ref("");
const depositForm = ref({ bank: "", nominal: null, walletId: "" });
const depositMsg = ref("");
const depositError = ref("");
const depositLoading = ref(false);
const depositHistory = ref([]);

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

// SUKSES -> hijau, PENDING -> kuning, EXPIRED/GAGAL -> merah (kelas .badge di style.css)
function badgeDeposit(label) {
  if (label === "SUKSES") return "sukses";
  if (label === "PENDING") return "pending";
  return "gagal";
}

async function load() {
  const [s, w, m] = await Promise.all([api.get("/api/store-settings"), api.get("/api/wallets"), api.get("/api/modal")]);
  settings.value = s;
  wallets.value = w;
  modal.value = m;
  modalAwalForm.value = m.modalAwal ?? 0;
}

async function simpanModalAwal() {
  error.value = "";
  modalMsg.value = "";
  try {
    await api.put("/api/modal-awal", { modal_awal: Number(modalAwalForm.value) });
    modalMsg.value = "Modal Awal disimpan.";
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

async function loadDepositHistory() {
  try {
    const res = await api.get("/api/admin/portalpulsa/deposits");
    depositHistory.value = res.deposits;
  } catch {
    // diam-diam gagal — bukan bagian kritis halaman
  }
}

async function kirimDepositPortalpulsa() {
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
    await loadDepositHistory();
  } catch (err) {
    depositError.value = err.message;
  } finally {
    depositLoading.value = false;
  }
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
    walletForm.value = { name: "", type: "umum", balance: 0, provider: "okeconnect" };
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

onMounted(() => {
  load();
  loadDepositHistory();
});
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
          <div class="field">
            <label>URL Cetak Struk Eksternal (opsional)</label>
            <input v-model="settings.cetak_struk_url" placeholder="https://namatoko.cetakstr.uk/" />
            <p class="muted" style="font-size: 12.5px; margin-top: 4px">
              Alat cetak struk tagihan dari OkeConnect. Kosongkan kalau tidak dipakai — menu "Cetak Struk Tagihan" akan tersembunyi.
            </p>
          </div>
          <button class="btn" type="submit">Simpan</button>
        </form>
      </div>

      <div class="card">
        <h3 style="margin-bottom: 12px">Modal Awal</h3>
        <div v-if="modalMsg" class="ok-box">{{ modalMsg }}</div>
        <p class="muted" style="font-size: 13px; margin-bottom: 12px">
          Titik nol pembanding untuk halaman <RouterLink to="/modal">Pertumbuhan Modal</RouterLink>. Diisi otomatis dari
          hasil hitung aset bersih hari pertama fitur ini aktif<span v-if="modal?.modalAwalTanggal"> ({{ modal.modalAwalTanggal }})</span>
          — ubah di sini kalau perlu dikoreksi.
        </p>
        <form @submit.prevent="simpanModalAwal">
          <div class="field"><label>Nilai Modal Awal (Rp)</label><input v-model.number="modalAwalForm" type="number" /></div>
          <button class="btn" type="submit">Simpan</button>
        </form>
      </div>

      <div class="card">
        <h3 style="margin-bottom: 12px">Deposit Saldo portalpulsa</h3>
        <p class="muted" style="font-size: 13px; margin-bottom: 12px">
          Kirim perintah Deposit langsung ke portalpulsa (PIN otomatis dari secret PORTALPULSA_PIN).
          Balasannya berupa <b>instruksi transfer manual</b> (nominal + kode unik, bank, no rekening) —
          bukan topup otomatis, tetap transfer manual sesuai instruksi setelah dikirim.
        </p>
        <div v-if="depositError" class="error-box">{{ depositError }}</div>
        <form @submit.prevent="kirimDepositPortalpulsa">
          <div class="field"><label>Bank</label><input v-model="depositForm.bank" placeholder="mis. BCA" required /></div>
          <div class="field"><label>Nominal (Rp)</label><input v-model.number="depositForm.nominal" type="number" min="1" required /></div>
          <div class="field">
            <label>Dompet sumber (uang beneran keluar dari sini)</label>
            <select v-model.number="depositForm.walletId" required>
              <option value="" disabled>Pilih dompet...</option>
              <option v-for="w in wallets.filter((w) => w.type !== 'distributor_ppob')" :key="w.id" :value="w.id">
                {{ w.name }} ({{ rupiah(w.balance) }})
              </option>
            </select>
          </div>
          <p class="muted" style="font-size: 12px; margin: -4px 0 8px">
            Nominal ini otomatis dicatat sebagai <b>Mutasi</b> dari dompet sumber ke dompet Saldo Distributor portalpulsa (bukan biaya — tidak memengaruhi Laba Rugi).
          </p>
          <button class="btn" type="submit" :disabled="depositLoading">{{ depositLoading ? "Mengirim..." : "Kirim Deposit" }}</button>
        </form>
        <div v-if="depositMsg" class="ok-box" style="white-space: pre-wrap; margin-top: 12px">{{ depositMsg }}</div>

        <div v-if="depositHistory.length" style="margin-top: 16px">
          <h4 style="font-size: 14px; margin-bottom: 8px">Riwayat Deposit</h4>
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
              <td>
                {{ w.type === "distributor_ppob" ? "Distributor PPOB" : "Umum" }}
                <span v-if="w.type === 'distributor_ppob'" class="muted" style="font-size: 12px"> ({{ w.provider === "portalpulsa" ? "portalpulsa" : "OkeConnect" }}) </span>
              </td>
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

<style scoped>
.dep-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #ececec; }
.dep-row b { font-weight: 600; }
</style>
