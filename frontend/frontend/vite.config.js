import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Saat development, request ke /api, /telegram tidak dipakai dari sini
// diteruskan ke Worker backend lokal (wrangler dev, default port 8787).
// Ganti target kalau port/URL backend Anda beda.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
