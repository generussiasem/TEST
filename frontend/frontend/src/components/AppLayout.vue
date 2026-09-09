<script setup>
import { useRouter } from "vue-router";
import { auth, logout, isAdmin } from "../store.js";

const router = useRouter();

function doLogout() {
  logout();
  router.push("/login");
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <strong>Buku Kas</strong>
        <span>Kasir + PPOB</span>
      </div>
      <nav>
        <RouterLink to="/" exact-active-class="active">Ringkasan</RouterLink>
        <RouterLink to="/kasir" active-class="active">Kasir</RouterLink>
        <RouterLink to="/ppob" active-class="active">Pulsa &amp; PPOB</RouterLink>
        <RouterLink to="/tagihan" active-class="active">Cek &amp; Bayar Tagihan</RouterLink>
        <RouterLink to="/produk" active-class="active">Produk &amp; Stok</RouterLink>
        <RouterLink to="/kontak" active-class="active">Pelanggan &amp; Supplier</RouterLink>
        <RouterLink to="/hutang" active-class="active">Hutang Piutang</RouterLink>
        <RouterLink to="/laporan" active-class="active">Laporan</RouterLink>
        <RouterLink v-if="isAdmin()" to="/karyawan" active-class="active">Karyawan</RouterLink>
        <RouterLink v-if="isAdmin()" to="/pengaturan" active-class="active">Pengaturan Toko</RouterLink>
      </nav>
      <div class="who">
        <div>{{ auth.employee?.name }}</div>
        <div class="muted" style="font-size: 11px; text-transform: capitalize">{{ auth.employee?.role }}</div>
        <button @click="doLogout">Keluar</button>
      </div>
    </aside>
    <main class="main">
      <slot />
    </main>
  </div>
</template>
