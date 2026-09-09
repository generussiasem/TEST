<script setup>
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api.js";
import { login } from "../store.js";

const router = useRouter();
const username = ref("");
const password = ref("");
const error = ref("");
const loading = ref(false);

async function submit() {
  error.value = "";
  loading.value = true;
  try {
    const res = await api.post("/api/auth/login", { username: username.value, password: password.value }, { auth: false });
    login(res.token, res.employee);
    router.push("/");
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
      <h1>Buku Kas</h1>
      <p class="tag">Masuk untuk membuka kasir hari ini</p>
      <div v-if="error" class="error-box">{{ error }}</div>
      <form @submit.prevent="submit">
        <div class="field">
          <label>Username</label>
          <input v-model="username" autocomplete="username" required />
        </div>
        <div class="field">
          <label>Password</label>
          <input v-model="password" type="password" autocomplete="current-password" required />
        </div>
        <button class="btn" style="width: 100%; justify-content: center" :disabled="loading">
          {{ loading ? "Memproses…" : "Masuk" }}
        </button>
      </form>
      <p class="muted" style="margin-top: 18px; font-size: 13px">
        Belum ada akun sama sekali? <RouterLink to="/setup">Setup awal toko</RouterLink>
      </p>
    </div>
  </div>
</template>
