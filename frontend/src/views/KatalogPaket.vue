<script setup>
// Menu "Katalog Paket": menanam situs paket pihak lain (alamat diatur admin di
// Pengaturan Toko) lewat iframe. Pola sama dengan Cetak Struk Tagihan.
import { ref, onMounted } from "vue";
import { api } from "../api.js";
import { isAdmin } from "../store.js";

const url = ref(null); // null = belum dimuat
const loaded = ref(false);

onMounted(async () => {
  try {
    const r = await api.get("/api/katalog-paket-url");
    url.value = r.url;
  } catch (_) {
    url.value = "";
  }
});
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Katalog Paket</h1>
        <p>Daftar paket data per provider dari situs luar — dibuka di dalam aplikasi</p>
      </div>
      <a v-if="url" :href="url" target="_blank" rel="noopener noreferrer" class="btn ghost">Buka di tab baru ↗</a>
    </div>

    <div v-if="url === null" class="card"><p class="muted">Memuat…</p></div>

    <div v-else-if="!url" class="card">
      <p class="muted">
        Alamat katalog paket belum bisa dimuat.
        <template v-if="isAdmin()">Buka <RouterLink to="/pengaturan">Pengaturan Toko</RouterLink> untuk mengisinya.</template>
      </p>
    </div>

    <div v-else>
      <p class="muted" style="font-size: 12.5px; margin-bottom: 6px">
        Situs ini milik pihak lain, bukan bagian dari aplikasi kasir — tidak terhubung otomatis dengan order di sini.
        Kalau kotak di bawah kosong atau menolak tampil, situsnya memblokir tampilan tertanam; pakai tombol
        <strong>"Buka di tab baru"</strong> di atas.
        <template v-if="isAdmin()">Alamat bisa diubah di <RouterLink to="/pengaturan">Pengaturan Toko</RouterLink>.</template>
      </p>
      <!-- sandbox: situs luar tidak boleh mengalihkan halaman aplikasi (tanpa allow-top-navigation). -->
      <iframe
        :src="url"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
        loading="lazy"
        style="width: 100%; height: 78vh; border: 1px solid var(--line); border-radius: 10px; background: #fff"
        title="Katalog Paket"
        @load="loaded = true"
      ></iframe>
    </div>
  </div>
</template>
