import { auth, logout } from "./store.js";
import router from "./router.js";

// Dev: dikosongkan, biar dipakai proxy Vite (lihat vite.config.js) ke wrangler dev.
// Produksi: isi VITE_API_BASE saat build kalau frontend & backend di-deploy terpisah,
// mis. VITE_API_BASE=https://kasir-ppob.username.workers.dev
const API_BASE = import.meta.env.VITE_API_BASE || "";

async function request(path, { method = "GET", body, auth: needsAuth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (needsAuth && auth.token) headers["Authorization"] = `Bearer ${auth.token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    logout();
    router.push("/login");
    throw new Error("Sesi berakhir, silakan login lagi.");
  }

  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    // respons non-JSON (jarang terjadi di endpoint kita)
  }

  if (!res.ok) {
    throw new Error(data?.error || `Gagal memproses permintaan (${res.status})`);
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body, opts = {}) => request(path, { method: "POST", body, ...opts }),
  put: (path, body) => request(path, { method: "PUT", body }),
};
