<script setup>
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api.js";

const router = useRouter();
const name = ref("");
const username = ref("");
const password = ref("");
const error = ref("");
const done = ref(false);
const loading = ref(false);

async function submit() {
  error.value = "";
  loading.value = true;
  try {
    await api.post("/api/setup", { name: name.value, username: username.value, password: password.value }, { auth: false });
    done.value = true;
    setTimeout(() => router.push("/login"), 1800);
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="auth-shell">
    <div class="auth-card">
      <h1>Setup Awal</h1>
      <p class="tag">Buat akun admin pertama untuk toko ini — hanya bisa dilakukan sekali.</p>

      <div v-if="done" class="ok-box">Akun admin dibuat. Mengarahkan ke halaman login…</div>
      <template v-else>
        <div v-if="error" class="error-box">
          {{ error }}
          <span v-if="error.includes('sudah pernah')">
            — <RouterLink to="/login">masuk di sini</RouterLink>.
          </span>
        </div>
        <form @submit.prevent="submit">
          <div class="field">
            <label>Nama Anda</label>
            <input v-model="name" required />
          </div>
          <div class="field">
            <label>Username</label>
            <input v-model="username" required />
          </div>
          <div class="field">
            <label>Password</label>
            <input v-model="password" type="password" minlength="8" required />
          </div>
          <button class="btn" style="width: 100%; justify-content: center" :disabled="loading">
            {{ loading ? "Membuat akun…" : "Buat Akun Admin" }}
          </button>
        </form>
      </template>

      <p class="muted" style="margin-top: 18px; font-size: 13px">
        Sudah punya akun? <RouterLink to="/login">Masuk</RouterLink>
      </p>
    </div>
  </div>
</template>
