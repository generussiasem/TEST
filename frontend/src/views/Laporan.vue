<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";

function firstOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

const start = ref(firstOfMonth());
const end = ref(today());
const profit = ref(null);
const cashflow = ref([]);
const error = ref("");
const loading = ref(false);

const expenseForm = ref({ type: "expense", category: "", amount: 0, wallet_id: "", note: "" });
const wallets = ref([]);
const expenseMsg = ref("");
const transactions = ref([]);
const editing = ref(null);

// Pemasukan lain (jasa/servis non-produk, mis. transfer bank, print, dll) —
// dicatat sbg type='sale' TANPA items, supaya tetap kehitung sbg omzet/laba
// (lihat POST /api/transactions: tanpa items, amount dipakai langsung, cost_total=0).
// useCostWallet: dipakai utk jasa yang modalnya dari dompet lain (mis. jasa
// transfer bank pakai Saldo BCA sendiri) — amount = TOTAL diterima dari
// pelanggan (pokok+fee), costAmount = pokok yang dipakai dari costWalletId.
const otherIncomeForm = ref({
  category: "",
  amount: 0,
  wallet_id: "",
  note: "",
  paidMethod: "tunai",
  contact_id: "",
  useCostWallet: false,
  costWalletId: "",
  costAmount: 0,
});
const contacts = ref([]);
const otherIncomeMsg = ref("");

// Modal (setoran/tarikan pemilik) — TIDAK ikut kehitung sbg omzet/laba
// (lihat /api/reports/profit, cuma jumlahkan type='sale' & 'expense'),
// tapi tetap muncul di Arus Kas per Akun sbg masuk/keluar.
const capitalForm = ref({ direction: "capital_in", category: "Setoran Modal", amount: 0, wallet_id: "", note: "" });
const capitalMsg = ref("");

const typeLabel = { sale: "Penjualan", purchase: "Pembelian Stok", expense: "Biaya", mutation: "Mutasi Akun", capital_in: "Modal Masuk", capital_out: "Modal Keluar" };

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [p, c, t] = await Promise.all([
      api.get(`/api/reports/profit?start=${start.value}&end=${end.value}`),
      api.get(`/api/reports/cashflow?start=${start.value}&end=${end.value}`),
      api.get("/api/transactions"),
    ]);
    profit.value = p;
    cashflow.value = c;
    transactions.value = t;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function startEdit(t) {
  editing.value = { ...t };
}

async function saveEdit() {
  error.value = "";
  try {
    await api.put(`/api/transactions/${editing.value.id}`, {
      category: editing.value.category,
      note: editing.value.note,
      contact_id: editing.value.contact_id,
    });
    editing.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

async function hapusTransaksi(t) {
  if (!confirm(`Hapus transaksi "${typeLabel[t.type] || t.type}" senilai ${rupiah(t.amount)}? Saldo dompet & stok terkait akan dikembalikan otomatis.`)) return;
  error.value = "";
  try {
    await api.delete(`/api/transactions/${t.id}`);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

async function loadWallets() {
  wallets.value = await api.get("/api/wallets");
  if (wallets.value.length) {
    expenseForm.value.wallet_id = wallets.value[0].id;
    otherIncomeForm.value.wallet_id = wallets.value[0].id;
    capitalForm.value.wallet_id = wallets.value[0].id;
  }
}

async function loadContacts() {
  contacts.value = await api.get("/api/contacts?type=pelanggan");
}

async function submitExpense() {
  expenseMsg.value = "";
  error.value = "";
  try {
    await api.post("/api/transactions", expenseForm.value);
    expenseMsg.value = "Biaya operasional dicatat.";
    expenseForm.value.amount = 0;
    expenseForm.value.category = "";
    expenseForm.value.note = "";
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

// Jasa lain / transfer bank / pemasukan non-produk lainnya — type='sale' tanpa
// items. Kalau "Utang" dipilih, wallet_id diabaikan & backend otomatis catat
// piutang ke kontak (sama seperti alur "Bayar Utang" di Kasir/PPOB). Kalau
// "useCostWallet" aktif (mis. jasa transfer bank pakai Saldo BCA sendiri):
// amount = TOTAL diterima dari pelanggan (pokok+fee), costAmount = pokok yang
// dipakai dari costWalletId — backend otomatis kurangi costWalletId itu.
async function submitOtherIncome() {
  otherIncomeMsg.value = "";
  error.value = "";
  if (otherIncomeForm.value.paidMethod === "utang" && !otherIncomeForm.value.contact_id) {
    error.value = "Pembayaran Utang wajib pilih kontak.";
    return;
  }
  if (otherIncomeForm.value.useCostWallet) {
    if (!otherIncomeForm.value.costWalletId) {
      error.value = "Pilih dompet sumber modal.";
      return;
    }
    if (otherIncomeForm.value.costAmount <= 0 || otherIncomeForm.value.costAmount >= otherIncomeForm.value.amount) {
      error.value = "Nominal modal harus lebih dari 0 dan kurang dari total yang diterima.";
      return;
    }
  }
  try {
    await api.post("/api/transactions", {
      type: "sale",
      category: otherIncomeForm.value.category,
      amount: otherIncomeForm.value.amount,
      wallet_id: otherIncomeForm.value.wallet_id,
      note: otherIncomeForm.value.note,
      paid_method: otherIncomeForm.value.paidMethod,
      contact_id: otherIncomeForm.value.paidMethod === "utang" ? otherIncomeForm.value.contact_id : null,
      cost_wallet_id: otherIncomeForm.value.useCostWallet ? otherIncomeForm.value.costWalletId : null,
      cost_total: otherIncomeForm.value.useCostWallet ? otherIncomeForm.value.costAmount : 0,
    });
    otherIncomeMsg.value = "Pemasukan lain dicatat.";
    otherIncomeForm.value.amount = 0;
    otherIncomeForm.value.category = "";
    otherIncomeForm.value.note = "";
    otherIncomeForm.value.contact_id = "";
    otherIncomeForm.value.costAmount = 0;
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

// Modal masuk (setoran pemilik) / modal keluar (prive/tarik modal) — TIDAK
// pakai type='sale' supaya tidak ikut kehitung sbg omzet (lihat catatan di atas).
async function submitCapital() {
  capitalMsg.value = "";
  error.value = "";
  try {
    await api.post("/api/transactions", {
      type: capitalForm.value.direction,
      category: capitalForm.value.category,
      amount: capitalForm.value.amount,
      wallet_id: capitalForm.value.wallet_id,
      note: capitalForm.value.note,
    });
    capitalMsg.value = capitalForm.value.direction === "capital_in" ? "Modal masuk dicatat." : "Modal keluar dicatat.";
    capitalForm.value.amount = 0;
    capitalForm.value.note = "";
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

onMounted(async () => {
  await Promise.all([load(), loadWallets(), loadContacts()]);
});
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Laporan Keuangan</h1>
        <p>Arus kas per akun serta laba kotor dan laba bersih pada rentang tanggal</p>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>

    <div class="card" style="margin-bottom: 18px">
      <div class="form-row" style="align-items: end">
        <div class="field"><label>Dari tanggal</label><input v-model="start" type="date" /></div>
        <div class="field"><label>Sampai tanggal</label><input v-model="end" type="date" /></div>
        <button class="btn" style="height: 37px" @click="load">{{ loading ? "Memuat…" : "Tampilkan" }}</button>
      </div>
    </div>

    <div class="grid cols-3" style="margin-bottom: 22px">
      <div class="card stat">
        <div class="label">Omzet</div>
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
    </div>

    <div class="grid cols-2" style="align-items: start">
      <div class="card">
        <h3 style="margin-bottom: 12px">Arus Kas per Akun</h3>
        <table>
          <thead>
            <tr>
              <th>Akun</th>
              <th>Masuk</th>
              <th>Keluar</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in cashflow" :key="w.wallet_id">
              <td>{{ w.wallet_name || "Tanpa akun" }}</td>
              <td class="num" style="color: var(--till-deep)">{{ rupiah(w.masuk) }}</td>
              <td class="num" style="color: var(--red)">{{ rupiah(w.keluar) }}</td>
            </tr>
            <tr v-if="!cashflow.length">
              <td colspan="3" class="muted">Tidak ada transaksi pada rentang ini.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h3 style="margin-bottom: 12px">Catat Biaya Operasional</h3>
        <div v-if="expenseMsg" class="ok-box">{{ expenseMsg }}</div>
        <form @submit.prevent="submitExpense">
          <div class="field"><label>Kategori</label><input v-model="expenseForm.category" placeholder="mis. Listrik, Sewa, Gaji" required /></div>
          <div class="form-row">
            <div class="field"><label>Nominal</label><input v-model.number="expenseForm.amount" type="number" min="0" required /></div>
            <div class="field">
              <label>Dari akun</label>
              <select v-model.number="expenseForm.wallet_id">
                <option v-for="w in wallets" :key="w.id" :value="w.id">{{ w.name }}</option>
              </select>
            </div>
          </div>
          <div class="field"><label>Catatan</label><input v-model="expenseForm.note" placeholder="opsional" /></div>
          <button class="btn" type="submit">Simpan Biaya</button>
        </form>
      </div>
    </div>

    <div class="grid cols-2" style="align-items: start; margin-top: 22px">
      <div class="card">
        <h3 style="margin-bottom: 12px">Catat Pemasukan Lain (Jasa/Transfer Bank/dll)</h3>
        <p class="muted" style="font-size: 12.5px; margin-bottom: 12px">
          Untuk jasa non-produk (mis. transfer bank, print, laundry) — ikut kehitung sbg omzet & laba, sama seperti penjualan biasa. Kalau modalnya dari dompet lain (mis. Saldo BCA sendiri), centang opsi di bawah.
        </p>
        <div v-if="otherIncomeMsg" class="ok-box">{{ otherIncomeMsg }}</div>
        <form @submit.prevent="submitOtherIncome">
          <div class="field"><label>Kategori</label><input v-model="otherIncomeForm.category" placeholder="mis. Jasa Transfer Bank, Print" required /></div>
          <div class="field"><label>{{ otherIncomeForm.useCostWallet ? "Total Diterima (pokok + fee)" : "Nominal" }}</label><input v-model.number="otherIncomeForm.amount" type="number" min="0" required /></div>
          <div class="field">
            <label style="display: flex; align-items: center; gap: 6px; font-weight: normal">
              <input type="checkbox" v-model="otherIncomeForm.useCostWallet" style="width: auto" />
              Modalnya dari dompet lain? (mis. jasa transfer bank pakai Saldo Bank sendiri)
            </label>
          </div>
          <div class="form-row" v-if="otherIncomeForm.useCostWallet">
            <div class="field">
              <label>Dompet Sumber Modal</label>
              <select v-model.number="otherIncomeForm.costWalletId">
                <option value="" disabled>Pilih dompet</option>
                <option v-for="w in wallets" :key="w.id" :value="w.id">{{ w.name }}</option>
              </select>
            </div>
            <div class="field"><label>Nominal Modal (Pokok)</label><input v-model.number="otherIncomeForm.costAmount" type="number" min="0" required /></div>
          </div>
          <div class="field">
            <label>Metode Bayar</label>
            <div style="display: flex; gap: 8px">
              <button type="button" class="btn" :class="{ ghost: otherIncomeForm.paidMethod !== 'tunai' }" @click="otherIncomeForm.paidMethod = 'tunai'">Tunai/Bank</button>
              <button type="button" class="btn" :class="{ ghost: otherIncomeForm.paidMethod !== 'utang' }" @click="otherIncomeForm.paidMethod = 'utang'">Utang</button>
            </div>
          </div>
          <div class="field" v-if="otherIncomeForm.paidMethod === 'tunai'">
            <label>Ke akun</label>
            <select v-model.number="otherIncomeForm.wallet_id">
              <option v-for="w in wallets" :key="w.id" :value="w.id">{{ w.name }}</option>
            </select>
          </div>
          <div class="field" v-else>
            <label>Kontak (penghutang)</label>
            <select v-model.number="otherIncomeForm.contact_id" required>
              <option value="" disabled>Pilih kontak</option>
              <option v-for="ct in contacts" :key="ct.id" :value="ct.id">{{ ct.name }}</option>
            </select>
          </div>
          <div class="field"><label>Catatan</label><input v-model="otherIncomeForm.note" placeholder="opsional" /></div>
          <button class="btn" type="submit">Simpan Pemasukan</button>
        </form>
      </div>

      <div class="card">
        <h3 style="margin-bottom: 12px">Catat Modal (Setoran/Tarikan Pemilik)</h3>
        <p class="muted" style="font-size: 12.5px; margin-bottom: 12px">
          Uang pemilik masuk/keluar dari kas toko — TIDAK ikut kehitung sbg omzet/laba, cuma muncul di Arus Kas.
        </p>
        <div v-if="capitalMsg" class="ok-box">{{ capitalMsg }}</div>
        <form @submit.prevent="submitCapital">
          <div class="field">
            <label>Jenis</label>
            <div style="display: flex; gap: 8px">
              <button type="button" class="btn" :class="{ ghost: capitalForm.direction !== 'capital_in' }" @click="capitalForm.direction = 'capital_in'">Modal Masuk</button>
              <button type="button" class="btn" :class="{ ghost: capitalForm.direction !== 'capital_out' }" @click="capitalForm.direction = 'capital_out'">Modal Keluar</button>
            </div>
          </div>
          <div class="field"><label>Kategori</label><input v-model="capitalForm.category" placeholder="mis. Setoran Modal, Prive" required /></div>
          <div class="form-row">
            <div class="field"><label>Nominal</label><input v-model.number="capitalForm.amount" type="number" min="0" required /></div>
            <div class="field">
              <label>{{ capitalForm.direction === "capital_in" ? "Ke akun" : "Dari akun" }}</label>
              <select v-model.number="capitalForm.wallet_id">
                <option v-for="w in wallets" :key="w.id" :value="w.id">{{ w.name }}</option>
              </select>
            </div>
          </div>
          <div class="field"><label>Catatan</label><input v-model="capitalForm.note" placeholder="opsional" /></div>
          <button class="btn" type="submit">Simpan Modal</button>
        </form>
      </div>
    </div>

    <div class="card" style="margin-top: 22px">
      <h3 style="margin-bottom: 12px">Riwayat Transaksi (200 terbaru)</h3>
      <table>
        <thead>
          <tr>
            <th>Tanggal</th>
            <th>Jenis</th>
            <th>Kategori</th>
            <th>Nominal</th>
            <th>Catatan</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in transactions" :key="t.id">
            <template v-if="editing && editing.id === t.id">
              <td class="muted" style="font-size: 12.5px">{{ new Date(t.date).toLocaleString("id-ID") }}</td>
              <td>{{ typeLabel[t.type] || t.type }}</td>
              <td><input v-model="editing.category" style="width: 120px" /></td>
              <td class="num">{{ rupiah(t.amount) }}</td>
              <td><input v-model="editing.note" style="width: 140px" /></td>
              <td style="white-space: nowrap">
                <button class="btn" style="padding: 4px 10px" @click="saveEdit">Simpan</button>
                <button class="btn ghost" style="padding: 4px 10px" @click="editing = null">Batal</button>
              </td>
            </template>
            <template v-else>
              <td class="muted" style="font-size: 12.5px">{{ new Date(t.date).toLocaleString("id-ID") }}</td>
              <td>{{ typeLabel[t.type] || t.type }}</td>
              <td>{{ t.category || "—" }}</td>
              <td class="num" :style="{ color: t.type === 'sale' || t.type === 'capital_in' ? 'var(--till-deep)' : 'var(--red)' }">{{ rupiah(t.amount) }}</td>
              <td class="muted">{{ t.note || "—" }}</td>
              <td style="white-space: nowrap">
                <button class="btn ghost" style="padding: 4px 10px; margin-right: 6px" @click="startEdit(t)">Ubah</button>
                <button class="btn ghost" style="padding: 4px 10px; color: #b3392c" @click="hapusTransaksi(t)">Hapus</button>
              </td>
            </template>
          </tr>
          <tr v-if="!transactions.length">
            <td colspan="6" class="muted">Belum ada transaksi.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
