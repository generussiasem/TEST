<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";

const debts = ref([]);
const contacts = ref([]);
const form = ref({ contact_id: "", type: "piutang", amount: 0, note: "" });
const error = ref("");
const showAdd = ref(false);

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

const typeLabel = { utang: "Utang ke Supplier", piutang: "Piutang Pelanggan", cicilan: "Cicilan / Pembayaran" };

async function load() {
  const [d, c] = await Promise.all([api.get("/api/debts"), api.get("/api/contacts")]);
  debts.value = d;
  contacts.value = c;
}

async function submitAdd() {
  error.value = "";
  if (!form.value.contact_id) {
    error.value = "Pilih kontak dulu.";
    return;
  }
  try {
    await api.post("/api/debts", form.value);
    form.value = { contact_id: "", type: "piutang", amount: 0, note: "" };
    showAdd.value = false;
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
        <p>Catat piutang pelanggan, utang ke supplier, dan cicilan pembayarannya</p>
      </div>
      <button class="btn" @click="showAdd = !showAdd">{{ showAdd ? "Batal" : "+ Catat Baru" }}</button>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>

    <div v-if="showAdd" class="card" style="margin-bottom: 18px">
      <form @submit.prevent="submitAdd">
        <div class="form-row">
          <div class="field">
            <label>Kontak</label>
            <select v-model.number="form.contact_id" required>
              <option value="" disabled>Pilih kontak…</option>
              <option v-for="c in contacts" :key="c.id" :value="c.id">{{ c.name }} ({{ c.type }})</option>
            </select>
          </div>
          <div class="field">
            <label>Jenis</label>
            <select v-model="form.type">
              <option value="piutang">Piutang (pelanggan hutang ke kita)</option>
              <option value="utang">Utang (kita hutang ke supplier)</option>
              <option value="cicilan">Cicilan / Pembayaran (mengurangi saldo)</option>
            </select>
          </div>
          <div class="field"><label>Nominal</label><input v-model.number="form.amount" type="number" min="0" required /></div>
        </div>
        <div class="field"><label>Catatan</label><input v-model="form.note" placeholder="opsional" /></div>
        <button class="btn" type="submit">Simpan</button>
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
            <th>Catatan</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in debts" :key="d.id">
            <td class="muted" style="font-size: 12.5px">{{ new Date(d.date).toLocaleDateString("id-ID") }}</td>
            <td>{{ d.contact_name }}</td>
            <td>{{ typeLabel[d.type] || d.type }}</td>
            <td class="num" :style="{ color: d.type === 'cicilan' ? 'var(--till-deep)' : 'var(--red)' }">
              {{ d.type === "cicilan" ? "-" : "+" }}{{ rupiah(d.amount) }}
            </td>
            <td class="muted">{{ d.note || "—" }}</td>
          </tr>
          <tr v-if="!debts.length">
            <td colspan="5" class="muted">Belum ada catatan hutang piutang.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
