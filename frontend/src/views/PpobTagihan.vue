<script setup>
import { ref, computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import { api } from "../api.js";

const route = useRoute();

const products = ref([]);
const orders = ref([]);
const contacts = ref([]);

const cekSearch = ref("");
const cekCode = ref("");
const target = ref("");
const cekResult = ref(null);
const cekLoading = ref(false);

const bayarSearch = ref("");
const bayarCode = ref("");
const bayarConfirming = ref(false);
const bayarLoading = ref(false);
const bayarPaidMethod = ref("tunai");
const bayarContactId = ref(null);

// Cari ID pelanggan tersimpan (BPJS/PLN/PDAM dll) lintas kontak
const idSearch = ref("");
const idResults = ref([]);
let idSearchTimer = null;

const error = ref("");
const activeProvider = ref("okeconnect"); // tab aktif: pisahkan transaksi OkeConnect & Digiflazz biar tidak ketuker

// Kotak konfirmasi harga jual (dipakai bersama utk semua order sukses postpaid)
const confirmTarget = ref(null);
const confirmForm = ref({ sellPrice: 0, costTotal: 0, paidMethod: "tunai", contactId: null });
const confirming = ref(false);
const lastReceipt = ref(null);

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

const postpaidProducts = computed(() =>
  products.value
    .filter(
      (p) => (p.category === "TAGIHAN" || p.category === "AIR PDAM") && p.active !== 0 && (p.provider || "okeconnect") === activeProvider.value
    )
    .sort((a, b) => (a.sell_price || 0) - (b.sell_price || 0))
);
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

// Order postpaid yang sudah sukses tapi belum dikonfirmasi (finalized = 0) —
// biar kasir tidak lupa menuntaskan pencatatannya.
const belumDicatat = computed(() =>
  orders.value.filter((o) => o.status === "sukses" && !o.finalized && isPostpaidCode(o.product_code) && (o.provider || "okeconnect") === activeProvider.value)
);

const riwayatTagihan = computed(() =>
  orders.value
    .filter((o) => isPostpaidCode(o.product_code) && (o.provider || "okeconnect") === activeProvider.value)
    .sort((a, b) => b.id - a.id)
);

const openedId = ref(null);
function toggleDetail(o) {
  openedId.value = openedId.value === o.id ? null : o.id;
}

const editingStatus = ref(null);
function startEditStatus(o) {
  editingStatus.value = { ref_id: o.ref_id, status: o.status, raw_reply: o.raw_reply || "" };
}
async function saveEditStatus() {
  error.value = "";
  try {
    await api.put(`/api/ppob-orders/${editingStatus.value.ref_id}`, {
      status: editingStatus.value.status,
      raw_reply: editingStatus.value.raw_reply,
    });
    editingStatus.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  }
}
async function hapusOrder(o) {
  if (!confirm(`Hapus order ${o.ref_id}? Kalau order ini sempat tercatat "sukses", transaksi & saldo terkait akan dibalikkan otomatis.`)) return;
  error.value = "";
  try {
    await api.delete(`/api/ppob-orders/${o.ref_id}`);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

const checkingRef = ref(null);
async function cekUlang(o) {
  error.value = "";
  checkingRef.value = o.ref_id;
  try {
    const res = await api.post(`/api/ppob-orders/${o.ref_id}/cek-ulang`, {});
    await load();
    if (res.needsConfirm) openConfirm(orders.value.find((x) => x.ref_id === o.ref_id));
  } catch (err) {
    error.value = err.message;
  } finally {
    checkingRef.value = null;
  }
}

function isPostpaidCode(code) {
  const p = products.value.find((x) => x.code === code);
  return p && (p.category === "TAGIHAN" || p.category === "AIR PDAM");
}

async function load() {
  const [p, o, c] = await Promise.all([
    api.get("/api/products"),
    api.get("/api/ppob-orders"),
    api.get("/api/contacts?type=pelanggan"),
  ]);
  products.value = p;
  orders.value = o;
  contacts.value = c;
  if (route.query.code) {
    const match = products.value.find((x) => x.code === route.query.code);
    if (match) {
      activeProvider.value = match.provider || "okeconnect";
      pickCek(match);
    }
  }
}

function pickCek(p) {
  cekCode.value = p.code;
  cekSearch.value = `${p.name} (${p.code})`;
}
function pickBayar(p) {
  bayarCode.value = p.code;
  bayarSearch.value = `${p.name} (${p.code})`;
}

// Cari ID pelanggan tersimpan (No. BPJS/PLN/PDAM dll) lintas kontak — biar
// kasir tinggal pilih, tidak perlu ketik ulang tiap pelanggan langganan bayar.
function searchSavedIds() {
  clearTimeout(idSearchTimer);
  if (!idSearch.value.trim()) {
    idResults.value = [];
    return;
  }
  idSearchTimer = setTimeout(async () => {
    idResults.value = await api.get(`/api/contact-ids?q=${encodeURIComponent(idSearch.value.trim())}`);
  }, 300);
}
function pickSavedId(idRow) {
  target.value = idRow.id_number;
  idSearch.value = "";
  idResults.value = [];
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
  if (bayarPaidMethod.value === "utang" && !bayarContactId.value) {
    error.value = "Pilih kontak dulu untuk pembayaran Utang.";
    return;
  }
  bayarLoading.value = true;
  try {
    const res = await api.post("/api/ppob/order", {
      productCode: bayarCode.value,
      target: target.value,
      paidMethod: bayarPaidMethod.value,
      contactId: bayarContactId.value,
    });
    bayarConfirming.value = false;
    await load();
    if (res.needsConfirm) {
      const orderRow = orders.value.find((o) => o.ref_id === res.refId);
      if (orderRow) openConfirm(orderRow);
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    bayarLoading.value = false;
  }
}

function openConfirm(o) {
  confirmTarget.value = { refId: o.ref_id, productCode: o.product_code, target: o.target };
  confirmForm.value = {
    sellPrice: o.sell_price || 0,
    costTotal: o.cost_price || 0,
    paidMethod: o.paid_method || "tunai",
    contactId: o.contact_id || null,
  };
  openedId.value = null;
}

async function submitKonfirmasi() {
  if (!confirmTarget.value) return;
  if (confirmForm.value.paidMethod === "utang" && !confirmForm.value.contactId) {
    error.value = "Pilih kontak dulu untuk pembayaran Utang.";
    return;
  }
  error.value = "";
  confirming.value = true;
  try {
    await api.post(`/api/ppob-orders/${confirmTarget.value.refId}/konfirmasi`, {
      sellPrice: confirmForm.value.sellPrice,
      costTotal: confirmForm.value.costTotal,
      paidMethod: confirmForm.value.paidMethod,
      contactId: confirmForm.value.paidMethod === "utang" ? confirmForm.value.contactId : null,
    });
    lastReceipt.value = {
      refId: confirmTarget.value.refId,
      productCode: confirmTarget.value.productCode,
      target: confirmTarget.value.target,
      sellPrice: confirmForm.value.sellPrice,
      paidMethod: confirmForm.value.paidMethod,
      contactName: confirmForm.value.contactId ? contacts.value.find((x) => x.id === confirmForm.value.contactId)?.name : null,
      date: new Date().toLocaleString("id-ID"),
    };
    confirmTarget.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    confirming.value = false;
  }
}

function cetakStruk() {
  window.print();
}
function bagikanWA() {
  if (!lastReceipt.value) return;
  const r = lastReceipt.value;
  let text = `*Struk Tagihan*\n${r.date}\n\n${r.productCode}\nTarget: ${r.target}\n\n*Total: ${rupiah(r.sellPrice)}*`;
  if (r.paidMethod === "utang") text += `\n(Utang atas nama ${r.contactName})`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
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

    <!-- Pisahkan transaksi per provider biar tidak ketuker -->
    <div style="display: flex; gap: 8px; margin-bottom: 18px">
      <button type="button" class="btn" :class="{ ghost: activeProvider !== 'okeconnect' }" @click="activeProvider = 'okeconnect'">OkeConnect</button>
      <button type="button" class="btn" :class="{ ghost: activeProvider !== 'digiflazz' }" @click="activeProvider = 'digiflazz'">Digiflazz</button>
    </div>

    <div v-if="belumDicatat.length" class="card" style="margin-bottom: 18px; border-color: var(--amber)">
      <h3 style="margin-bottom: 8px">⚠️ Ada {{ belumDicatat.length }} order sukses belum dikonfirmasi</h3>
      <p class="muted" style="font-size: 13px; margin-bottom: 10px">
        Order ini sudah berhasil dibayar ke provider tapi belum masuk laporan keuangan.
      </p>
      <div v-for="o in belumDicatat" :key="o.id" style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px dashed var(--line)">
        <div>{{ o.product_code }} — <span class="num">{{ o.target }}</span> <span class="muted num" style="font-size: 12px">({{ o.ref_id }})</span></div>
        <button class="btn ghost" style="padding: 4px 10px" @click="openConfirm(o)">Konfirmasi &amp; Catat</button>
      </div>
    </div>

    <div class="card" style="margin-bottom: 18px">
      <div class="field" style="position: relative; max-width: 360px">
        <label>Cari ID pelanggan tersimpan (nama atau nomor)</label>
        <input v-model="idSearch" @input="searchSavedIds" placeholder="mis. Budi, atau nomor meteran" />
        <div v-if="idResults.length" class="card" style="position: absolute; top: 100%; left: 0; right: 0; z-index: 5; padding: 6px; max-height: 220px; overflow: auto">
          <div v-for="r in idResults" :key="r.id" @click="pickSavedId(r)" style="padding: 8px; cursor: pointer">
            <div>{{ r.contact_name }} — {{ r.category }}</div>
            <div class="muted num" style="font-size: 12px">{{ r.id_number }}</div>
          </div>
        </div>
      </div>
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

        <div class="field">
          <label>Metode Bayar</label>
          <div style="display: flex; gap: 8px">
            <button type="button" class="btn" :class="{ ghost: bayarPaidMethod !== 'tunai' }" style="flex: 1; justify-content: center" @click="bayarPaidMethod = 'tunai'">Tunai/Bank</button>
            <button type="button" class="btn" :class="{ ghost: bayarPaidMethod !== 'utang' }" style="flex: 1; justify-content: center" @click="bayarPaidMethod = 'utang'">Utang</button>
          </div>
        </div>
        <div v-if="bayarPaidMethod === 'utang'" class="field">
          <label>Kontak</label>
          <select v-model.number="bayarContactId">
            <option :value="null" disabled>— pilih pelanggan —</option>
            <option v-for="c in contacts" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>

        <button v-if="!bayarConfirming" class="btn" :disabled="!bayarCode || !target" @click="mulaiBayar">Lanjut Bayar</button>
        <div v-else class="error-box" style="background: var(--amber-soft); color: #7a5514">
          Yakin sudah cek nominal & konfirmasi ke pelanggan? Ini akan memotong saldo distributor sungguhan.
          <div style="margin-top: 8px; display: flex; gap: 8px">
            <button class="btn danger" :disabled="bayarLoading" @click="doBayar">{{ bayarLoading ? "Memproses…" : "Ya, Bayar Sekarang" }}</button>
            <button class="btn ghost" @click="bayarConfirming = false">Batal</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Kotak konfirmasi harga jual (nominal tagihan asli + fee) -->
    <div v-if="confirmTarget" class="receipt-modal-backdrop no-print" @click.self="confirmTarget = null">
      <div class="card" style="max-width: 420px; width: 100%">
        <h3 style="margin-bottom: 4px">Konfirmasi Pembayaran Tagihan</h3>
        <p class="muted" style="font-size: 13px; margin-bottom: 14px">{{ confirmTarget.productCode }} → {{ confirmTarget.target }}</p>

        <div class="field"><label>Modal (nominal tagihan asli yang terpotong dari saldo)</label><input v-model.number="confirmForm.costTotal" type="number" /></div>
        <div class="field"><label>Harga Jual (diterima dari pelanggan, termasuk fee)</label><input v-model.number="confirmForm.sellPrice" type="number" /></div>

        <div class="field">
          <label>Metode Bayar</label>
          <div style="display: flex; gap: 8px">
            <button type="button" class="btn" :class="{ ghost: confirmForm.paidMethod !== 'tunai' }" style="flex: 1; justify-content: center" @click="confirmForm.paidMethod = 'tunai'">Tunai/Bank</button>
            <button type="button" class="btn" :class="{ ghost: confirmForm.paidMethod !== 'utang' }" style="flex: 1; justify-content: center" @click="confirmForm.paidMethod = 'utang'">Utang</button>
          </div>
        </div>
        <div v-if="confirmForm.paidMethod === 'utang'" class="field">
          <label>Kontak</label>
          <select v-model.number="confirmForm.contactId">
            <option :value="null" disabled>— pilih pelanggan —</option>
            <option v-for="c in contacts" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>

        <button class="btn" style="width: 100%; justify-content: center; margin-bottom: 8px; margin-top: 8px" :disabled="confirming" @click="submitKonfirmasi">
          {{ confirming ? "Menyimpan…" : "Simpan & Lanjut ke Struk" }}
        </button>
        <button class="btn ghost" style="width: 100%; justify-content: center" @click="confirmTarget = null">Nanti Saja</button>
      </div>
    </div>

    <!-- Struk hasil konfirmasi terakhir -->
    <div v-if="lastReceipt" class="card no-print" style="margin: 18px 0">
      <h3 style="margin-bottom: 10px">Transaksi Terakhir: {{ lastReceipt.refId }}</h3>
      <button class="btn ghost" style="margin-right: 8px" @click="cetakStruk">🖨️ Cetak Struk</button>
      <button class="btn ghost" @click="bagikanWA">📤 Bagikan via WhatsApp</button>
    </div>
    <div v-if="lastReceipt" class="receipt-box" style="display: none">
      <div style="text-align: center; margin-bottom: 6px">
        <strong>STRUK TAGIHAN</strong>
        <div>{{ lastReceipt.date }}</div>
      </div>
      <hr />
      <div>{{ lastReceipt.productCode }}</div>
      <div>Target: {{ lastReceipt.target }}</div>
      <hr />
      <div class="receipt-row"><strong>TOTAL</strong><strong>{{ rupiah(lastReceipt.sellPrice) }}</strong></div>
      <div v-if="lastReceipt.paidMethod === 'utang'" style="margin-top: 6px">Utang a.n. {{ lastReceipt.contactName }}</div>
      <div style="text-align: center; margin-top: 10px">Terima kasih!</div>
    </div>

    <div class="card" style="margin-top: 22px">
      <h3 style="margin-bottom: 12px">Riwayat Cek &amp; Bayar Tagihan — {{ activeProvider === "digiflazz" ? "Digiflazz" : "OkeConnect" }}</h3>
      <table>
        <thead>
          <tr>
            <th>Ref</th>
            <th>Kode</th>
            <th>Target</th>
            <th>Status</th>
            <th>Waktu</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="o in riwayatTagihan" :key="o.id">
            <tr @click="toggleDetail(o)" style="cursor: pointer">
              <td class="num">{{ o.ref_id }}</td>
              <td>{{ o.product_code }}</td>
              <td class="num">{{ o.target }}</td>
              <td>
                <span class="badge" :class="o.status">{{ o.status }}</span>
                <span v-if="o.status === 'sukses' && !o.finalized" class="badge gagal" style="margin-left: 4px">belum dicatat</span>
              </td>
              <td class="muted" style="font-size: 12.5px">{{ new Date(o.created_at).toLocaleString("id-ID") }}</td>
            </tr>
            <tr v-if="openedId === o.id">
              <td colspan="5" style="background: var(--paper); padding: 14px 16px">
                <div class="grid cols-2" style="gap: 6px 24px; font-size: 13.5px">
                  <div><span class="muted">Ref ID</span><br /><span class="num">{{ o.ref_id }}</span></div>
                  <div><span class="muted">Status</span><br /><span class="badge" :class="o.status">{{ o.status }}</span></div>
                  <div><span class="muted">Kode</span><br />{{ o.product_code }}</div>
                  <div><span class="muted">Target (ID Pelanggan/No. Meter)</span><br /><span class="num">{{ o.target }}</span></div>
                  <div><span class="muted">Dibuat</span><br />{{ new Date(o.created_at).toLocaleString("id-ID") }}</div>
                  <div><span class="muted">Diperbarui</span><br />{{ new Date(o.updated_at).toLocaleString("id-ID") }}</div>
                  <div><span class="muted">Metode Bayar</span><br />{{ o.paid_method === "utang" ? "Utang" : "Tunai/Bank" }}</div>
                  <div v-if="o.status === 'sukses'"><span class="muted">Sudah dicatat sebagai transaksi?</span><br />{{ o.finalized ? "Ya" : "Belum" }}</div>
                </div>
                <div style="margin-top: 10px">
                  <span class="muted" style="font-size: 13px">Balasan mentah dari provider</span>
                  <div class="num" style="white-space: pre-wrap; background: var(--paper-raised); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px; margin-top: 4px; font-size: 13px">{{ o.raw_reply || "(kosong)" }}</div>
                </div>

                <div v-if="editingStatus && editingStatus.ref_id === o.ref_id" style="margin-top: 12px; border-top: 1px solid var(--line); padding-top: 12px">
                  <div class="form-row">
                    <div class="field">
                      <label>Status (koreksi manual)</label>
                      <select v-model="editingStatus.status">
                        <option value="pending">Pending</option>
                        <option value="sukses">Sukses</option>
                        <option value="gagal">Gagal</option>
                        <option value="cek">Cek (bukan transaksi)</option>
                      </select>
                    </div>
                  </div>
                  <div class="field"><label>Balasan (opsional, boleh dikosongkan)</label><input v-model="editingStatus.raw_reply" /></div>
                  <p class="muted" style="font-size: 12px; margin-bottom: 8px">
                    Kalau status diubah KELUAR dari "Sukses", transaksi &amp; saldo dompet yang sempat tercatat untuk order ini akan otomatis dibalikkan.
                  </p>
                  <button class="btn" style="padding: 4px 10px" @click.stop="saveEditStatus">Simpan Koreksi</button>
                  <button class="btn ghost" style="padding: 4px 10px" @click.stop="editingStatus = null">Batal</button>
                </div>
                <div v-else style="margin-top: 12px">
                  <button
                    v-if="o.status === 'sukses' && !o.finalized"
                    class="btn"
                    style="padding: 4px 10px; margin-right: 6px"
                    @click.stop="openConfirm(o)"
                  >
                    Konfirmasi &amp; Catat
                  </button>
                  <button
                    v-if="o.status === 'pending'"
                    class="btn ghost"
                    style="padding: 4px 10px; margin-right: 6px"
                    :disabled="checkingRef === o.ref_id"
                    @click.stop="cekUlang(o)"
                  >
                    {{ checkingRef === o.ref_id ? "Mengecek…" : "Cek Ulang Status" }}
                  </button>
                  <button class="btn ghost" style="padding: 4px 10px; margin-right: 6px" @click.stop="startEditStatus(o)">Koreksi Status</button>
                  <button class="btn ghost" style="padding: 4px 10px; color: #b3392c" @click.stop="hapusOrder(o)">Hapus Order</button>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="!riwayatTagihan.length">
            <td colspan="5" class="muted">Belum ada riwayat cek/bayar tagihan.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
@media print {
  .receipt-box {
    display: block !important;
  }
}
</style>
