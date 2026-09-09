# Frontend Kasir + PPOB (Vue 3 + Vite)

Dashboard web untuk backend Hono/D1 yang sudah Anda buat (login karyawan, kasir barang
fisik dengan scan barcode, order pulsa/PPOB via Jabber, hutang piutang, dan laporan).

## Menjalankan saat development

Backend (`wrangler dev`) harus jalan dulu di port default `8787`, lalu:

```
npm install
npm run dev
```

Buka `http://localhost:5173`. Request ke `/api/*` otomatis diteruskan ke backend lewat
proxy Vite (lihat `vite.config.js`) — kalau backend Anda jalan di port lain, ubah
`target` di file itu.

Kunjungi `/setup` untuk membuat akun admin pertama (sama seperti langkah `curl
/api/setup` di README backend, tapi lewat form).

## Build untuk produksi

```
npm run build
```

Menghasilkan folder `dist/` (SPA statis). Karena backend Anda adalah Cloudflare Worker
terpisah (bukan Vite dev server), ada dua cara deploy `dist/` ini:

**Opsi A — Cloudflare Pages (paling sederhana)**
Upload folder `dist/` sebagai proyek Cloudflare Pages baru, atau `npx wrangler pages
deploy dist`. Karena frontend dan backend jadi dua domain berbeda, build ulang dengan
env var backend Anda supaya semua request `/api/*` mengarah ke sana, bukan proxy dev:

```
VITE_API_BASE=https://kasir-ppob.<akun-anda>.workers.dev npm run build
```

**Opsi B — satu Worker gabungan (seperti "kasirbuku" pada proyek Anda sebelumnya)**
Tambahkan `[assets]` di `wrangler.toml` backend yang menunjuk ke folder `dist/` ini
(fitur Workers Static Assets), supaya satu Worker melayani API sekaligus frontend tanpa
perlu `VITE_API_BASE` (karena sama-origin).

## Yang masih perlu disesuaikan

- Endpoint backend tidak punya cara publik untuk mengecek "sudah ada admin atau
  belum" — halaman `/setup` menangani ini dengan mencoba submit langsung; kalau
  backend membalas "Setup sudah pernah dilakukan", form otomatis mengarahkan ke
  halaman login.
- Edit saldo akun/dompet secara manual belum ada di backend (`/api/wallets` cuma
  `GET`/`POST`) — halaman Pengaturan hanya bisa menambah akun baru, bukan mengoreksi
  saldo. Kalau perlu, tambahkan `PUT /api/wallets/:id` di backend.
- Tombol "Sinkron Harga PPOB" langsung memanggil `POST /api/products/sync` — pastikan
  `PRICE_LIST_URL` sudah diisi dan pemetaan field di backend sudah sesuai format JSON
  dari CS OkeConnect Anda (lihat catatan di README backend).
