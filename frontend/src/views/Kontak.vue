<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";

const contacts = ref([]);
const filter = ref("");
const form = ref({ name: "", phone: "", type: "pelanggan" });
const error = ref("");
const showAdd = ref(false);
const editing = ref(null);

// ID pelanggan fleksibel (BPJS, PLN, PDAM, dst) per kontak
const openedIdsFor = ref(null);
const idsByContact = ref({}); // { [contactId]: [...] }
const newIdForm = ref({ category: "", id_number: "", note: "" });

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

async function load() {
  const path = filter.value ? `/api/contacts?type=${filter.value}` : "/api/contacts";
  contacts.value = await api.get(path);
}

async function submitAdd() {
  error.value = "";
  try {
    await api.post("/api/contacts", form.value);
    form.value = { name: "", phone: "", type: "pelanggan" };
    showAdd.value = false;
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

function startEdit(c) {
  editing.value = { ...c };
}

async function saveEdit() {
  error.value = "";
  try {
    await api.put(`/api/contacts/${editing.value.id}`, {
      name: editing.value.name,
      phone: editing.value.phone,
      type: editing.value.type,
    });
    editing.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

async function hapus(c) {
  if (!confirm(`Hapus kontak "${c.name}"?`)) return;
  error.value = "";
  try {
    await api.delete(`/api/contacts/${c.id}`);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

async function toggleIds(c) {
  if (openedIdsFor.value === c.id) {
    openedIdsFor.value = null;
    return;
  }
  openedIdsFor.value = c.id;
  newIdForm.value = { category: "", id_number: "", note: "" };
  if (!idsByContact.value[c.id]) {
    idsByContact.value[c.id] = await api.get(`/api/contacts/${c.id}/ids`);
  }
}

async function addId(c) {
  if (!newIdForm.value.category.trim() || !newIdForm.value.id_number.trim()) {
    error.value = "Kategori dan nomor ID wajib diisi.";
    return;
  }
  error.value = "";
  try {
    await api.post(`/api/contacts/${c.id}/ids`, newIdForm.value);
    newIdForm.value = { category: "", id_number: "", note: "" };
    idsByContact.value[c.id] = await api.get(`/api/contacts/${c.id}/ids`);
  } catch (err) {
    error.value = err.message;
  }
}

async function hapusId(c, idRow) {
  if (!confirm(`Hapus ID ${idRow.category}: ${idRow.id_number}?`)) return;
  error.value = "";
  try {
    await api.delete(`/api/contact-ids/${idRow.id}`);
    idsByContact.value[c.id] = await api.get(`/api/contacts/${c.id}/ids`);
  } catch (err) {
    error.value = err.message;
  }
}

function formatWaNumber(phone) {
  if (!phone) return "";
  const digits = phone.replace(/[^\d]/g, "");
  return digits.startsWith("0") ? "62" + digits.slice(1) : digits;
}

async function bagikanTagihan(c) {
  error.value = "";
  try {
    const riwayat = await api.get(`/api/debts?contact_id=${c.id}`);
    const typeLabel = { utang: "Utang", piutang: "Piutang", cicilan: "Bayar" };
    let text = `*Tagihan ${c.name}*\n\n`;
    if (riwayat.length) {
      for (const d of riwayat.slice(0, 10)) {
        text += `${new Date(d.date).toLocaleDateString("id-ID")} — ${typeLabel[d.type] || d.type} ${rupiah(d.amount)}${d.note ? ` (${d.note})` : ""}\n`;
      }
      text += "\n";
    }
    text += `*Sisa Tagihan: ${rupiah(c.total_debt)}*`;
    const waNumber = formatWaNumber(c.phone);
    window.open(`https://wa.me/${waNumber}?text=${encodeURIComponent(text)}`, "_blank");
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
        <h1>Pelanggan &amp; Supplier</h1>
        <p>Data kontak, hutang piutang, dan ID pelanggan (BPJS, PLN, PDAM, dll)</p>
      </div>
      <button class="btn" @click="showAdd = !showAdd">{{ showAdd ? "Batal" : "+ Kontak Baru" }}</button>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>

    <div v-if="showAdd" class="card" style="margin-bottom: 18px">
      <form @submit.prevent="submitAdd" class="form-row" style="align-items: end">
        <div class="field"><label>Nama</label><input v-model="form.name" required /></div>
        <div class="field"><label>No. HP</label><input v-model="form.phone" /></div>
        <div class="field">
          <label>Tipe</label>
          <select v-model="form.type">
            <option value="pelanggan">Pelanggan</option>
            <option value="supplier">Supplier</option>
          </select>
        </div>
        <button class="btn" type="submit" style="height: 37px">Simpan</button>
      </form>
    </div>

    <div class="card">
      <div class="form-row" style="margin-bottom: 8px">
        <select v-model="filter" @change="load" style="max-width: 200px">
          <option value="">Semua tipe</option>
          <option value="pelanggan">Pelanggan</option>
          <option value="supplier">Supplier</option>
        </select>
      </div>
      <table>
        <thead>
          <tr>
            <th>Nama</th>
            <th>No. HP</th>
            <th>Tipe</th>
            <th>Saldo Hutang/Piutang</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="c in contacts" :key="c.id">
            <tr>
              <template v-if="editing && editing.id === c.id">
                <td><input v-model="editing.name" /></td>
                <td><input v-model="editing.phone" style="width: 130px" /></td>
                <td>
                  <select v-model="editing.type">
                    <option value="pelanggan">Pelanggan</option>
                    <option value="supplier">Supplier</option>
                  </select>
                </td>
                <td class="num">{{ rupiah(c.total_debt) }}</td>
                <td style="white-space: nowrap">
                  <button class="btn" style="padding: 4px 10px" @click="saveEdit">Simpan</button>
                  <button class="btn ghost" style="padding: 4px 10px" @click="editing = null">Batal</button>
                </td>
              </template>
              <template v-else>
                <td>{{ c.name }}</td>
                <td class="num">{{ c.phone || "—" }}</td>
                <td style="text-transform: capitalize">{{ c.type }}</td>
                <td class="num" :style="{ color: c.total_debt > 0 ? 'var(--red)' : 'inherit' }">{{ rupiah(c.total_debt) }}</td>
                <td style="white-space: nowrap">
                  <button v-if="c.total_debt" class="btn ghost" style="padding: 4px 10px; margin-right: 6px" @click="bagikanTagihan(c)">
                    📤 Bagikan Tagihan
                  </button>
                  <button class="btn ghost" style="padding: 4px 10px; margin-right: 6px" @click="toggleIds(c)">
                    {{ openedIdsFor === c.id ? "Tutup ID" : "Kelola ID" }}
                  </button>
                  <button class="btn ghost" style="padding: 4px 10px; margin-right: 6px" @click="startEdit(c)">Ubah</button>
                  <button class="btn ghost" style="padding: 4px 10px; color: #b3392c" @click="hapus(c)">Hapus</button>
                </td>
              </template>
            </tr>
            <tr v-if="openedIdsFor === c.id">
              <td colspan="5" style="background: var(--paper-raised)">
                <div style="padding: 10px 4px">
                  <p class="muted" style="font-size: 12.5px; margin-bottom: 8px">
                    ID pelanggan tersimpan (No. BPJS, ID PLN, No. PDAM, dll) — bebas nambah kategori apa saja.
                  </p>
                  <table style="margin-bottom: 10px">
                    <thead>
                      <tr><th>Kategori</th><th>Nomor ID</th><th>Catatan</th><th></th></tr>
                    </thead>
                    <tbody>
                      <tr v-for="idRow in idsByContact[c.id] || []" :key="idRow.id">
                        <td>{{ idRow.category }}</td>
                        <td class="num">{{ idRow.id_number }}</td>
                        <td class="muted">{{ idRow.note || "—" }}</td>
                        <td><button class="btn ghost" style="padding: 2px 8px; color: #b3392c" @click="hapusId(c, idRow)">Hapus</button></td>
                      </tr>
                      <tr v-if="!(idsByContact[c.id] || []).length">
                        <td colspan="4" class="muted">Belum ada ID tersimpan.</td>
                      </tr>
                    </tbody>
                  </table>
                  <div class="form-row" style="align-items: end">
                    <div class="field"><label>Kategori</label><input v-model="newIdForm.category" placeholder="mis. PLN, BPJS, PDAM" style="width: 130px" /></div>
                    <div class="field"><label>Nomor ID</label><input v-model="newIdForm.id_number" style="width: 160px" /></div>
                    <div class="field"><label>Catatan (opsional)</label><input v-model="newIdForm.note" style="width: 160px" /></div>
                    <button class="btn" style="height: 37px" @click="addId(c)">+ Tambah</button>
                  </div>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="!contacts.length">
            <td colspan="5" class="muted">Belum ada kontak.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
