import { createRouter, createWebHistory } from "vue-router";
import { auth, isAdmin } from "./store.js";

const routes = [
  { path: "/login", name: "login", component: () => import("./views/Login.vue"), meta: { public: true } },
  { path: "/setup", name: "setup", component: () => import("./views/Setup.vue"), meta: { public: true } },
  { path: "/", name: "dashboard", component: () => import("./views/Dashboard.vue") },
  { path: "/kasir", name: "kasir", component: () => import("./views/Kasir.vue") },
  { path: "/produk", name: "produk", component: () => import("./views/Produk.vue") },
  { path: "/ppob", name: "ppob", component: () => import("./views/Ppob.vue") },
  { path: "/tagihan", name: "tagihan", component: () => import("./views/PpobTagihan.vue") },
  { path: "/kontak", name: "kontak", component: () => import("./views/Kontak.vue") },
  { path: "/hutang", name: "hutang", component: () => import("./views/Hutang.vue") },
  { path: "/laporan", name: "laporan", component: () => import("./views/Laporan.vue") },
  {
    path: "/karyawan",
    name: "karyawan",
    component: () => import("./views/Karyawan.vue"),
    meta: { requiresAdmin: true },
  },
  {
    path: "/pengaturan",
    name: "pengaturan",
    component: () => import("./views/Pengaturan.vue"),
    meta: { requiresAdmin: true },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  if (to.meta.public) return true;
  if (!auth.token) return { name: "login" };
  if (to.meta.requiresAdmin && !isAdmin()) return { name: "dashboard" };
  return true;
});

export default router;
