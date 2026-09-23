<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";

const url = ref(null); // null = belum dimuat, "" = tidak diset
const loaded = ref(false);

onMounted(async () => {
  const s = await api.get("/api/store-settings");
  url.value = s.cetak_struk_url || "";
});
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Cetak Struk Tagihan</h1>
        <p>Alat bantu cetak struk PLN/BPJS/tagihan lain dari OkeConnect — isi manual, terpisah dari data transaksi di aplikasi ini</p>
      </div>
      <a v-if="url" :href="url" target="_blank" rel="noopener" class="btn ghost">Buka di tab baru ↗</a>
    </div>

    <div v-if="url === null" class="card"><p class="muted">Memuat…</p></div>

    <div v-else-if="!url" class="card">
      <p class="muted">
        URL alat cetak struk belum diisi. Buka menu
        <RouterLink to="/pengaturan">Pengaturan Toko</RouterLink>
        untuk mengisinya (kolom "URL Cetak Struk Eksternal").
      </p>
    </div>

    <div v-else>
      <p class="muted" style="font-size: 12.5px; margin-bottom: 6px">
        Halaman ini milik OkeConnect, bukan bagian dari aplikasi kasir ini — isinya diisi manual dan tidak
        terhubung otomatis dengan transaksi di sini. Kalau tidak muncul di bawah, situsnya mungkin sedang
        memblokir tampilan tertanam; pakai tombol "Buka di tab baru" di atas sebagai gantinya.
      </p>
      <p class="muted" style="font-size: 12.5px; margin-bottom: 10px; color: #b3392c">
        ⚠️ Untuk <strong>mencetak atau menyimpan sebagai PDF</strong>, jangan lakukan dari tampilan di bawah
        ini — hasilnya sering kosong/blank karena batasan browser terhadap konten tertanam seperti ini.
        Klik <strong>"Buka di tab baru ↗"</strong> di atas dulu, baru cetak/simpan PDF dari tab tersebut.
      </p>
      <iframe
        :src="url"
        style="width: 100%; height: 75vh; border: 1px solid var(--line); border-radius: 10px; background: #fff"
        title="Cetak Struk Eksternal"
        @load="loaded = true"
      ></iframe>
    </div>
  </div>
</template>
