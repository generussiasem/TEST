<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { auth, logout, isAdmin, display, setViewMode, isMobileView } from "../store.js";

const router = useRouter();
const menuOpen = ref(false);

// Reaktif terhadap resize kalau mode "auto" (belum ada preferensi manual disimpan)
const windowW = reactive({ v: window.innerWidth });
function onResize() {
  windowW.v = window.innerWidth;
}
onMounted(() => window.addEventListener("resize", onResize));
onUnmounted(() => window.removeEventListener("resize", onResize));

const mobile = computed(() => {
  windowW.v; // dependensi reaktif
  return isMobileView();
});

function doLogout() {
  logout();
  router.push("/login");
}

function chooseMode(mode) {
  setViewMode(mode);
  menuOpen.value = false;
}

const navItems = computed(() => {
  const items = [
    { to: "/", label: "Ringkasan", exact: true },
    { to: "/kasir", label: "Kasir" },
    { to: "/katalog", label: "Katalog PPOB" },
    { to: "/ppob", label: "Pulsa & PPOB" },
    { to: "/tagihan", label: "Cek & Bayar Tagihan" },
    { to: "/produk", label: "Produk & Stok" },
    { to: "/kontak", label: "Pelanggan & Supplier" },
    { to: "/hutang", label: "Hutang Piutang" },
    { to: "/laporan", label: "Laporan" },
  ];
  if (isAdmin()) {
    items.push({ to: "/karyawan", label: "Karyawan" });
    items.push({ to: "/pengaturan", label: "Pengaturan Toko" });
  }
  return items;
});

// Tab utama di bottom bar (mode HP) — sisanya diakses lewat "Menu"
const bottomTabs = [
  { to: "/", label: "Ringkasan", exact: true, icon: "home" },
  { to: "/kasir", label: "Kasir", icon: "cart" },
  { to: "/katalog", label: "Katalog", icon: "grid" },
  { to: "/laporan", label: "Laporan", icon: "chart" },
];
</script>

<template>
  <!-- ===== MODE WEB: sidebar seperti sebelumnya ===== -->
  <div v-if="!mobile" class="shell">
    <aside class="sidebar">
      <div class="brand">
        <strong>Buku Kas</strong>
        <span>Kasir + PPOB</span>
      </div>
      <nav>
        <RouterLink v-for="item in navItems" :key="item.to" :to="item.to" :exact-active-class="item.exact ? 'active' : undefined" :active-class="!item.exact ? 'active' : undefined">{{ item.label }}</RouterLink>
      </nav>
      <div class="who">
        <div>{{ auth.employee?.name }}</div>
        <div class="muted" style="font-size: 11px; text-transform: capitalize">{{ auth.employee?.role }}</div>
        <div style="display: flex; gap: 4px; margin-top: 8px">
          <button :style="{ opacity: display.mode === 'web' ? 1 : 0.55 }" @click="chooseMode('web')">Web</button>
          <button :style="{ opacity: display.mode === 'hp' ? 1 : 0.55 }" @click="chooseMode('hp')">HP</button>
        </div>
        <button @click="doLogout" style="margin-top: 6px">Keluar</button>
      </div>
    </aside>
    <main class="main">
      <slot />
    </main>
  </div>

  <!-- ===== MODE HP: header + bottom tab bar ===== -->
  <div v-else class="mshell">
    <header class="mheader">
      <strong>Buku Kas</strong>
      <button class="mmenu-btn" @click="menuOpen = true" aria-label="Menu">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
      </button>
    </header>

    <main class="mmain">
      <slot />
    </main>

    <nav class="mtabbar">
      <RouterLink v-for="t in bottomTabs" :key="t.to" :to="t.to" :exact-active-class="t.exact ? 'active' : undefined" :active-class="!t.exact ? 'active' : undefined" class="mtab">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path v-if="t.icon === 'home'" d="M3 11.5 12 4l9 7.5" /><path v-if="t.icon === 'home'" d="M5 10v9h14v-9" />
          <circle v-if="t.icon === 'cart'" cx="9" cy="20" r="1" /><circle v-if="t.icon === 'cart'" cx="18" cy="20" r="1" /><path v-if="t.icon === 'cart'" d="M2 3h2l2.4 12.4a2 2 0 0 0 2 1.6h8.7a2 2 0 0 0 2-1.6L21 7H6" />
          <rect v-if="t.icon === 'grid'" x="3" y="3" width="7" height="7" rx="1.5" /><rect v-if="t.icon === 'grid'" x="14" y="3" width="7" height="7" rx="1.5" /><rect v-if="t.icon === 'grid'" x="3" y="14" width="7" height="7" rx="1.5" /><rect v-if="t.icon === 'grid'" x="14" y="14" width="7" height="7" rx="1.5" />
          <path v-if="t.icon === 'chart'" d="M4 20V10M12 20V4M20 20v-7" />
        </svg>
        <span>{{ t.label }}</span>
      </RouterLink>
      <button class="mtab" @click="menuOpen = true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></svg>
        <span>Lainnya</span>
      </button>
    </nav>

    <!-- Panel menu penuh (slide-over) -->
    <div v-if="menuOpen" class="msheet-backdrop" @click.self="menuOpen = false">
      <div class="msheet">
        <div class="who" style="border-top: none; padding-top: 0">
          <div>{{ auth.employee?.name }}</div>
          <div class="muted" style="font-size: 11px; text-transform: capitalize">{{ auth.employee?.role }}</div>
        </div>
        <nav style="margin: 14px 0">
          <RouterLink v-for="item in navItems" :key="item.to" :to="item.to" @click="menuOpen = false" :exact-active-class="item.exact ? 'active' : undefined" :active-class="!item.exact ? 'active' : undefined" style="display: block; padding: 10px 4px; border-bottom: 1px solid var(--line); color: var(--ink)">{{ item.label }}</RouterLink>
        </nav>
        <div class="field">
          <label>Tampilan</label>
          <div style="display: flex; gap: 8px">
            <button class="btn ghost" :style="{ flex: 1, opacity: display.mode === 'web' ? 1 : 0.6 }" @click="chooseMode('web')">Web</button>
            <button class="btn ghost" :style="{ flex: 1, opacity: display.mode === 'hp' ? 1 : 0.6 }" @click="chooseMode('hp')">HP</button>
          </div>
        </div>
        <button class="btn danger" style="width: 100%; margin-top: 14px" @click="doLogout">Keluar</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mshell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.mheader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  background: var(--till-deep);
  color: #eee6d2;
  position: sticky;
  top: 0;
  z-index: 10;
}
.mheader strong {
  font-family: "Fraunces", serif;
  font-size: 17px;
}
.mmenu-btn {
  background: none;
  border: none;
  color: #eee6d2;
  padding: 4px;
}
.mmain {
  flex: 1;
  padding: 16px 14px 90px;
}
.mtabbar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  background: var(--paper-raised);
  border-top: 1px solid var(--line);
  padding: 6px 4px calc(6px + env(safe-area-inset-bottom));
  z-index: 10;
}
.mtab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  background: none;
  border: none;
  color: var(--ink-soft);
  text-decoration: none;
  font-size: 11px;
  padding: 4px 0;
}
.mtab.active {
  color: var(--till);
}
.msheet-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 20;
  display: flex;
  justify-content: flex-end;
}
.msheet {
  width: 82%;
  max-width: 320px;
  background: var(--paper-raised);
  height: 100%;
  padding: 20px 18px;
  overflow-y: auto;
}
</style>
