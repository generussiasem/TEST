<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";

const contacts = ref([]);
const filter = ref("");
const form = ref({ name: "", phone: "", type: "pelanggan" });
const error = ref("");
const showAdd = ref(false);
const editing = ref(null);

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

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Pelanggan &amp; Supplier</h1>
        <p>Data kontak yang dipakai untuk mencatat hutang piutang</p>
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
          <tr v-for="c in contacts" :key="c.id">
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
                <button class="btn ghost" style="padding: 4px 10px; margin-right: 6px" @click="startEdit(c)">Ubah</button>
                <button class="btn ghost" style="padding: 4px 10px; color: #b3392c" @click="hapus(c)">Hapus</button>
              </td>
            </template>
          </tr>
          <tr v-if="!contacts.length">
            <td colspan="5" class="muted">Belum ada kontak.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
