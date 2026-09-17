<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";

const profile = ref(null);
const form = ref({ current_password: "", new_username: "", new_password: "", confirm_password: "" });
const error = ref("");
const okMsg = ref("");
const saving = ref(false);

async function load() {
  profile.value = await api.get("/api/auth/profile");
  form.value.new_username = profile.value.username;
}

async function simpan() {
  error.value = "";
  okMsg.value = "";

  const gantiUsername = form.value.new_username.trim() !== profile.value.username;
  const gantiPassword = !!form.value.new_password;

  if (!gantiUsername && !gantiPassword) {
    error.value = "Tidak ada yang diubah. Ganti username atau isi password baru.";
    return;
  }
  if (gantiPassword && form.value.new_password !== form.value.confirm_password) {
    error.value = "Konfirmasi password baru tidak cocok.";
    return;
  }

  saving.value = true;
  try {
    await api.put("/api/auth/credentials", {
      current_password: form.value.current_password,
      new_username: gantiUsername ? form.value.new_username.trim() : null,
      new_password: gantiPassword ? form.value.new_password : null,
    });
    form.value.current_password = "";
    form.value.new_password = "";
    form.value.confirm_password = "";
    await load();
    okMsg.value = gantiPassword
      ? "Berhasil disimpan. Pakai password baru saat login berikutnya."
      : "Username berhasil diubah. Pakai username baru saat login berikutnya.";
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Akun Saya</h1>
        <p>Ubah username dan password akun Anda sendiri</p>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>
    <div v-if="okMsg" class="ok-box">{{ okMsg }}</div>

    <div class="card" style="max-width: 520px" v-if="profile">
      <div class="muted" style="font-size: 13px; margin-bottom: 14px">
        Login sebagai <strong>{{ profile.name }}</strong>
        (<span style="text-transform: capitalize">{{ profile.role }}</span>)
      </div>

      <form @submit.prevent="simpan">
        <div class="field">
          <label>Password Saat Ini <span class="muted">(wajib)</span></label>
          <input v-model="form.current_password" type="password" required autocomplete="current-password" />
        </div>

        <hr style="border: none; border-top: 1px solid var(--line); margin: 18px 0" />

        <div class="field">
          <label>Username</label>
          <input v-model="form.new_username" autocomplete="username" />
        </div>

        <div class="field">
          <label>Password Baru <span class="muted">(kosongkan kalau tidak diganti)</span></label>
          <input v-model="form.new_password" type="password" minlength="8" autocomplete="new-password" />
        </div>

        <div class="field" v-if="form.new_password">
          <label>Ulangi Password Baru</label>
          <input v-model="form.confirm_password" type="password" required autocomplete="new-password" />
        </div>

        <button class="btn" type="submit" :disabled="saving">{{ saving ? "Menyimpan…" : "Simpan Perubahan" }}</button>
      </form>

      <p class="muted" style="font-size: 12.5px; margin-top: 14px; line-height: 1.5">
        Catatan: sesi yang sudah terlanjur login di perangkat lain masih bisa dipakai sampai kedaluwarsa sendiri
        (maksimal 12 jam), walau password sudah diganti. Kalau password diganti karena dicurigai bocor, minta admin
        mengganti <code>AUTH_SECRET</code> di Worker supaya semua sesi lama langsung hangus.
      </p>
    </div>
  </div>
</template>
