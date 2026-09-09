<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";

const employees = ref([]);
const form = ref({ name: "", username: "", password: "", role: "kasir" });
const error = ref("");
const showAdd = ref(false);
const editing = ref(null);
const newPassword = ref("");

async function load() {
  employees.value = await api.get("/api/employees");
}

async function submitAdd() {
  error.value = "";
  try {
    await api.post("/api/employees", form.value);
    form.value = { name: "", username: "", password: "", role: "kasir" };
    showAdd.value = false;
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

function startEdit(e) {
  editing.value = { ...e };
  newPassword.value = "";
}

async function saveEdit() {
  error.value = "";
  try {
    const body = { name: editing.value.name, role: editing.value.role, active: !!editing.value.active };
    if (newPassword.value) body.password = newPassword.value;
    await api.put(`/api/employees/${editing.value.id}`, body);
    editing.value = null;
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
        <h1>Karyawan</h1>
        <p>Kelola akun kasir dan admin yang bisa login ke dashboard ini</p>
      </div>
      <button class="btn" @click="showAdd = !showAdd">{{ showAdd ? "Batal" : "+ Karyawan Baru" }}</button>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>

    <div v-if="showAdd" class="card" style="margin-bottom: 18px">
      <form @submit.prevent="submitAdd">
        <div class="form-row">
          <div class="field"><label>Nama</label><input v-model="form.name" required /></div>
          <div class="field"><label>Username</label><input v-model="form.username" required /></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Password</label><input v-model="form.password" type="password" minlength="8" required /></div>
          <div class="field">
            <label>Peran</label>
            <select v-model="form.role">
              <option value="kasir">Kasir</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        </div>
        <button class="btn" type="submit">Simpan</button>
      </form>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Nama</th>
            <th>Username</th>
            <th>Peran</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in employees" :key="e.id">
            <template v-if="editing && editing.id === e.id">
              <td><input v-model="editing.name" /></td>
              <td class="muted">{{ e.username }}</td>
              <td>
                <select v-model="editing.role">
                  <option value="kasir">Kasir</option>
                  <option value="admin">Admin</option>
                </select>
              </td>
              <td>
                <select v-model="editing.active">
                  <option :value="1">Aktif</option>
                  <option :value="0">Nonaktif</option>
                </select>
              </td>
              <td style="white-space: nowrap">
                <input v-model="newPassword" type="password" placeholder="Password baru (opsional)" style="width: 160px; margin-right: 6px" />
                <button class="btn" style="padding: 4px 10px" @click="saveEdit">Simpan</button>
                <button class="btn ghost" style="padding: 4px 10px" @click="editing = null">Batal</button>
              </td>
            </template>
            <template v-else>
              <td>{{ e.name }}</td>
              <td class="num">{{ e.username }}</td>
              <td style="text-transform: capitalize">{{ e.role }}</td>
              <td><span class="badge" :class="e.active ? 'sukses' : 'gagal'">{{ e.active ? "Aktif" : "Nonaktif" }}</span></td>
              <td><button class="btn ghost" style="padding: 4px 10px" @click="startEdit(e)">Ubah</button></td>
            </template>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
