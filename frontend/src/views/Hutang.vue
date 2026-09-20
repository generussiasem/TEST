<script setup>
import { ref, computed, onMounted } from "vue";
import { api } from "../api.js";

const debts = ref([]);
const contacts = ref([]);
const wallets = ref([]);
const error = ref("");
const okMsg = ref("");
const saving = ref(false);
const editing = ref(null);

// mode form: null | "catat" | "bayar" | "titip"
const mode = ref(null);

const catatForm = ref({ contact_id: "", type: "piutang", amount: 0, note: "" });
const bayarForm = ref({ contact_id: "", amount: 0, wallet_id: "", kelebihan: "", note: "" });
const titipForm = ref({ aksi: "titip", contact_id: "", amount: 0, wallet_id: "", note: "" });

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

const typeLabel = {
  utang: "Utang ke Supplier",
  piutang: "Piutang Pelanggan",
  cicilan: "Pembayaran Hutang",
  titip: "Titipan Masuk",
  pakai_titip: "Titipan Dipakai",
  tarik_titip: "Titipan Diambil Tunai",
};

// Tanda & warna per jenis: merah = menambah hutang, hijau = mengurangi hutang / titipan masuk.
function tanda(d) {
  return d.type === "utang" || d.type === "piutang" || d.type === "titip" ? "+" : "-";
}
function warna(d) {
  return d.type === "utang" || d.type === "piutang" ? "var(--red)" : "var(--till-deep)";
}

// Catatan yang tertaut ke dompet/transaksi: jenis & nominal terkunci.
function isLocked(d) {
  return d.transaction_id != null || ["titip", "pakai_titip", "tarik_titip"].includes(d.type);
}

function walletName(id) {
  return wallets.value.find((w) => w.id === id)?.name || "";
}

async function load() {
  const [d, c, w] = await Promise.all([api.get("/api/debts"), api.get("/api/contacts"), api.get("/api/wallets")]);
  debts.value = d;
  contacts.value = c;
  wallets.value = w.filter((x) => x.type !== "distributor_ppob");
}

function bukaForm(m) {
  error.value = "";
  okMsg.value = "";
  mode.value = mode.value === m ? null : m;
}

// ---------------- Catat hutang baru (manual, tanpa uang bergerak) ----------------
async function submitCatat() {
  error.value = "";
  okMsg.value = "";
  if (!catatForm.value.contact_id) {
    error.value = "Pilih kontak dulu.";
    return;
  }
  saving.value = true;
  try {
    await api.post("/api/debts", catatForm.value);
    catatForm.value = { contact_id: "", type: "piutang", amount: 0, note: "" };
    mode.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}

// ---------------- Bayar hutang ----------------
const bayarContact = computed(() => contacts.value.find((c) => c.id === bayarForm.value.contact_id) || null);
const bayarIsSupplier = computed(() => bayarContact.value?.type === "supplier");
const bayarSisaHutang = computed(() => Math.max(Number(bayarContact.value?.total_debt) || 0, 0));
const bayarUang = computed(() => Number(bayarForm.value.amount) || 0);
const bayarUntukHutang = computed(() => (bayarIsSupplier.value ? bayarUang.value : Math.min(bayarUang.value, bayarSisaHutang.value)));
const bayarLebih = computed(() => (bayarIsSupplier.value ? 0 : Math.max(bayarUang.value - bayarSisaHutang.value, 0)));
const bayarMelebihiSupplier = computed(() => bayarIsSupplier.value && bayarUang.value > bayarSisaHutang.value);
const bayarSiap = computed(() => {
  const f = bayarForm.value;
  if (!f.contact_id || !f.wallet_id || bayarUang.value <= 0) return false;
  if (bayarMelebihiSupplier.value) return false;
  if (bayarLebih.value > 0 && !f.kelebihan) return false; // kasir WAJIB memilih
  if (bayarLebih.value > 0 && bayarUntukHutang.value === 0 && f.kelebihan === 'kembalikan') return false; // tidak ada hutang: tidak ada yang perlu dikembalikan
  return true;
});
// Uang yang benar-benar menetap di dompet.
const bayarMasukDompet = computed(() => {
  if (bayarIsSupplier.value) return bayarUntukHutang.value;
  return bayarForm.value.kelebihan === "titipkan" ? bayarUang.value : bayarUntukHutang.value;
});

function onBayarInput() {
  if (bayarLebih.value <= 0) bayarForm.value.kelebihan = "";
}

async function submitBayar() {
  error.value = "";
  okMsg.value = "";
  saving.value = true;
  try {
    const f = bayarForm.value;
    const r = await api.post("/api/debts/bayar", {
      contact_id: f.contact_id,
      amount: bayarUang.value,
      wallet_id: f.wallet_id,
      kelebihan: bayarLebih.value > 0 ? f.kelebihan : undefined,
      note: f.note || undefined,
    });
    let msg = `Pembayaran ${rupiah(bayarUang.value)} dicatat ke ${walletName(f.wallet_id)}.`;
    if (r.titipkan) msg += ` ${rupiah(r.lebih)} dititipkan.`;
    if (r.dikembalikan) msg += ` Kembalian ${rupiah(r.dikembalikan)} dikembalikan tunai.`;
    okMsg.value = msg;
    bayarForm.value = { contact_id: "", amount: 0, wallet_id: f.wallet_id, kelebihan: "", note: "" };
    mode.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}

// ---------------- Titip uang / ambil titipan ----------------
const titipContact = computed(() => contacts.value.find((c) => c.id === titipForm.value.contact_id) || null);
const titipContacts = computed(() =>
  titipForm.value.aksi === "tarik"
    ? contacts.value.filter((c) => c.type === "pelanggan" && c.deposit > 0)
    : contacts.value.filter((c) => c.type === "pelanggan")
);
const titipSiap = computed(() => {
  const f = titipForm.value;
  if (!f.contact_id || !f.wallet_id || !(Number(f.amount) > 0)) return false;
  if (f.aksi === "tarik" && Number(f.amount) > (titipContact.value?.deposit || 0)) return false;
  return true;
});

async function submitTitip() {
  error.value = "";
  okMsg.value = "";
  saving.value = true;
  try {
    const f = titipForm.value;
    await api.post(f.aksi === "tarik" ? "/api/debts/tarik" : "/api/debts/titip", {
      contact_id: f.contact_id,
      amount: Number(f.amount),
      wallet_id: f.wallet_id,
      note: f.note || undefined,
    });
    okMsg.value = f.aksi === "tarik" ? "Titipan dikembalikan tunai & dicatat." : "Titipan dicatat & masuk ke dompet.";
    titipForm.value = { aksi: f.aksi, contact_id: "", amount: 0, wallet_id: f.wallet_id, note: "" };
    mode.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}

// ---------------- Edit / hapus catatan ----------------
function startEdit(d) {
  editing.value = { ...d };
}

async function saveEdit() {
  error.value = "";
  try {
    await api.put(`/api/debts/${editing.value.id}`, {
      type: editing.value.type,
      amount: editing.value.amount,
      note: editing.value.note,
    });
    editing.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

async function hapus(d) {
  const tertaut = d.transaction_id != null && (d.type === "cicilan" || d.type === "titip" || d.type === "tarik_titip");
  const peringatan = tertaut
    ? ` Pembayaran ini tercatat di dompet, jadi seluruh pembayarannya akan dibatalkan dan saldo dompet dikembalikan.`
    : "";
  if (!confirm(`Hapus catatan "${typeLabel[d.type] || d.type}" untuk ${d.contact_name}?${peringatan}`)) return;
  error.value = "";
  okMsg.value = "";
  try {
    await api.delete(`/api/debts/${d.id}`);
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
        <h1>Hutang Piutang</h1>
        <p>Piutang pelanggan, utang ke supplier, pembayaran hutang, dan titipan pelanggan</p>
      </div>
      <div style="display: flex; gap: 8px; flex-wrap: wrap">
        <button class="btn" @click="bukaForm('bayar')">{{ mode === "bayar" ? "Batal" : "💵 Bayar Hutang" }}</button>
        <button class="btn ghost" @click="bukaForm('titip')">{{ mode === "titip" ? "Batal" : "💰 Titipan" }}</button>
        <button class="btn ghost" @click="bukaForm('catat')">{{ mode === "catat" ? "Batal" : "+ Catat Hutang Baru" }}</button>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>
    <div v-if="okMsg" class="ok-box">{{ okMsg }}</div>

    <!-- BAYAR HUTANG -->
    <div v-if="mode === 'bayar'" class="card" style="margin-bottom: 18px">
      <h3 style="margin-bottom: 12px">Bayar Hutang</h3>
      <form @submit.prevent="submitBayar">
        <div class="form-row">
          <div class="field">
            <label>Kontak</label>
            <select v-model.number="bayarForm.contact_id" required @change="onBayarInput">
              <option value="" disabled>Pilih kontak…</option>
              <option v-for="c in contacts" :key="c.id" :value="c.id">
                {{ c.name }} ({{ c.type }}) — hutang {{ rupiah(c.total_debt) }}{{ c.deposit > 0 ? `, titipan ${rupiah(c.deposit)}` : "" }}
              </option>
            </select>
          </div>
          <div class="field">
            <label>{{ bayarIsSupplier ? "Nominal dibayar ke supplier" : "Uang diterima" }}</label>
            <input v-model.number="bayarForm.amount" type="number" min="1" required @input="onBayarInput" />
          </div>
          <div class="field">
            <label>{{ bayarIsSupplier ? "Dibayar dari dompet" : "Diterima di dompet" }}</label>
            <select v-model.number="bayarForm.wallet_id" required>
              <option value="" disabled>Pilih dompet…</option>
              <option v-for="w in wallets" :key="w.id" :value="w.id">{{ w.name }} ({{ rupiah(w.balance) }})</option>
            </select>
          </div>
        </div>

        <div v-if="bayarContact && bayarUang > 0" class="muted" style="font-size: 13px; margin-bottom: 10px">
          Sisa hutang {{ rupiah(bayarSisaHutang) }} →
          melunasi <strong>{{ rupiah(bayarUntukHutang) }}</strong>
          <template v-if="bayarLebih > 0"> · kelebihan <strong>{{ rupiah(bayarLebih) }}</strong></template>
        </div>

        <div v-if="bayarMelebihiSupplier" class="error-box">Melebihi sisa utang ke supplier ({{ rupiah(bayarSisaHutang) }}).</div>

        <!-- Kelebihan: kasir WAJIB memilih -->
        <div v-if="bayarLebih > 0" class="field" style="margin-bottom: 12px">
          <label>Kelebihan {{ rupiah(bayarLebih) }} — mau diapakan? (wajib dipilih)</label>
          <div style="display: flex; gap: 8px; flex-wrap: wrap">
            <button type="button" class="btn" :class="{ ghost: bayarForm.kelebihan !== 'kembalikan' }" @click="bayarForm.kelebihan = 'kembalikan'">
              Kembalikan tunai
            </button>
            <button type="button" class="btn" :class="{ ghost: bayarForm.kelebihan !== 'titipkan' }" @click="bayarForm.kelebihan = 'titipkan'">
              Titipkan untuk transaksi berikutnya
            </button>
          </div>
          <div v-if="!bayarForm.kelebihan" class="muted" style="font-size: 12.5px; margin-top: 6px">Pilih salah satu dulu sebelum menyimpan.</div>
        </div>

        <div v-if="bayarSiap" class="muted" style="font-size: 13px; margin-bottom: 10px">
          Dompet {{ walletName(bayarForm.wallet_id) }} {{ bayarIsSupplier ? "berkurang" : "bertambah" }} <strong>{{ rupiah(bayarMasukDompet) }}</strong>.
        </div>

        <div class="field"><label>Catatan</label><input v-model="bayarForm.note" placeholder="opsional" /></div>
        <button class="btn" type="submit" :disabled="!bayarSiap || saving">{{ saving ? "Menyimpan…" : "Simpan Pembayaran" }}</button>
      </form>
    </div>

    <!-- TITIPAN -->
    <div v-if="mode === 'titip'" class="card" style="margin-bottom: 18px">
      <h3 style="margin-bottom: 12px">Titipan Pelanggan</h3>
      <div style="display: flex; gap: 8px; margin-bottom: 12px">
        <button type="button" class="btn" :class="{ ghost: titipForm.aksi !== 'titip' }" @click="titipForm.aksi = 'titip'; titipForm.contact_id = ''">Terima titipan</button>
        <button type="button" class="btn" :class="{ ghost: titipForm.aksi !== 'tarik' }" @click="titipForm.aksi = 'tarik'; titipForm.contact_id = ''">Ambil titipan (tunai)</button>
      </div>
      <form @submit.prevent="submitTitip">
        <div class="form-row">
          <div class="field">
            <label>Pelanggan</label>
            <select v-model.number="titipForm.contact_id" required>
              <option value="" disabled>Pilih pelanggan…</option>
              <option v-for="c in titipContacts" :key="c.id" :value="c.id">{{ c.name }} — titipan {{ rupiah(c.deposit) }}</option>
            </select>
          </div>
          <div class="field"><label>Nominal</label><input v-model.number="titipForm.amount" type="number" min="1" required /></div>
          <div class="field">
            <label>{{ titipForm.aksi === "tarik" ? "Dikeluarkan dari dompet" : "Masuk ke dompet" }}</label>
            <select v-model.number="titipForm.wallet_id" required>
              <option value="" disabled>Pilih dompet…</option>
              <option v-for="w in wallets" :key="w.id" :value="w.id">{{ w.name }} ({{ rupiah(w.balance) }})</option>
            </select>
          </div>
        </div>
        <div v-if="titipForm.aksi === 'tarik' && titipContact && Number(titipForm.amount) > titipContact.deposit" class="error-box">
          Titipan hanya tersisa {{ rupiah(titipContact.deposit) }}.
        </div>
        <div class="field"><label>Catatan</label><input v-model="titipForm.note" placeholder="opsional" /></div>
        <button class="btn" type="submit" :disabled="!titipSiap || saving">{{ saving ? "Menyimpan…" : "Simpan" }}</button>
      </form>
    </div>

    <!-- CATAT HUTANG BARU -->
    <div v-if="mode === 'catat'" class="card" style="margin-bottom: 18px">
      <h3 style="margin-bottom: 4px">Catat Hutang Baru</h3>
      <p class="muted" style="font-size: 12.5px; margin-bottom: 12px">Untuk mencatat hutang/utang saja (tidak ada uang yang bergerak). Untuk pembayaran, pakai tombol “Bayar Hutang”.</p>
      <form @submit.prevent="submitCatat">
        <div class="form-row">
          <div class="field">
            <label>Kontak</label>
            <select v-model.number="catatForm.contact_id" required>
              <option value="" disabled>Pilih kontak…</option>
              <option v-for="c in contacts" :key="c.id" :value="c.id">{{ c.name }} ({{ c.type }})</option>
            </select>
          </div>
          <div class="field">
            <label>Jenis</label>
            <select v-model="catatForm.type">
              <option value="piutang">Piutang (pelanggan hutang ke kita)</option>
              <option value="utang">Utang (kita hutang ke supplier)</option>
            </select>
          </div>
          <div class="field"><label>Nominal</label><input v-model.number="catatForm.amount" type="number" min="1" required /></div>
        </div>
        <div class="field"><label>Catatan</label><input v-model="catatForm.note" placeholder="opsional" /></div>
        <button class="btn" type="submit" :disabled="saving">Simpan</button>
      </form>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Tanggal</th>
            <th>Kontak</th>
            <th>Jenis</th>
            <th>Nominal</th>
            <th>Dompet</th>
            <th>Catatan</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in debts" :key="d.id">
            <template v-if="editing && editing.id === d.id">
              <td class="muted" style="font-size: 12.5px">{{ new Date(d.date).toLocaleDateString("id-ID") }}</td>
              <td>{{ d.contact_name }}</td>
              <td>
                <template v-if="isLocked(d)">{{ typeLabel[d.type] || d.type }}</template>
                <select v-else v-model="editing.type">
                  <option value="piutang">Piutang</option>
                  <option value="utang">Utang</option>
                  <option v-if="d.type === 'cicilan'" value="cicilan">Pembayaran (lama)</option>
                </select>
              </td>
              <td>
                <template v-if="isLocked(d)">{{ rupiah(d.amount) }}</template>
                <input v-else v-model.number="editing.amount" type="number" style="width: 100px" />
              </td>
              <td class="muted">{{ walletName(d.wallet_id) || "—" }}</td>
              <td><input v-model="editing.note" style="width: 140px" /></td>
              <td style="white-space: nowrap">
                <button class="btn" style="padding: 4px 10px" @click="saveEdit">Simpan</button>
                <button class="btn ghost" style="padding: 4px 10px" @click="editing = null">Batal</button>
              </td>
            </template>
            <template v-else>
              <td class="muted" style="font-size: 12.5px">{{ new Date(d.date).toLocaleDateString("id-ID") }}</td>
              <td>{{ d.contact_name }}</td>
              <td>{{ typeLabel[d.type] || d.type }}</td>
              <td class="num" :style="{ color: warna(d) }">{{ tanda(d) }}{{ rupiah(d.amount) }}</td>
              <td class="muted">{{ walletName(d.wallet_id) || "—" }}</td>
              <td class="muted">{{ d.note || "—" }}</td>
              <td style="white-space: nowrap">
                <button class="btn ghost" style="padding: 4px 10px; margin-right: 6px" @click="startEdit(d)">Ubah</button>
                <button class="btn ghost" style="padding: 4px 10px; color: #b3392c" @click="hapus(d)">Hapus</button>
              </td>
            </template>
          </tr>
          <tr v-if="!debts.length">
            <td colspan="7" class="muted">Belum ada catatan hutang piutang.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
